/**
 * The IPC boundary between the renderer and the main process: only the app's own renderer may
 * call, every input is validated, and every error reaches the renderer as a code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {},
  shell: { openExternal: vi.fn() },
}));

const { GameError } = await import('../../src/main/game.ts');
const { DockerUnavailableError } = await import('../../src/main/services/docker.ts');
const { registerIpc } = await import('../../src/main/ipc.ts');
const { dialog } = await import('electron');

const fromApp = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };
const call = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(`bd:${channel}`)!(event, ...args);

let game: Record<string, ReturnType<typeof vi.fn>>;
let openUrl: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

beforeEach(() => {
  handlers.clear();
  game = {
    snapshot: vi.fn(() => ({ ok: 'snapshot' })),
    nextAssignment: vi.fn(async () => {}),
    switchProject: vi.fn(async () => {}),
    appUrl: vi.fn(async () => 'http://127.0.0.1:5173/'),
    applyDevCatalog: vi.fn(async () => {}),
    diagnostics: vi.fn(async () => 'Bug Detective 0.1.0 diagnostics'),
    openLogsFolder: vi.fn(async () => {}),
  };
  openUrl = vi.fn(async (_url: string) => {});
  registerIpc(game as never, null, openUrl);
});

describe('IPC', () => {
  it('answers the app renderer with the value in an envelope', async () => {
    expect(await call('snapshot', fromApp)).toEqual({ ok: true, value: { ok: 'snapshot' } });
  });

  it('titles the native file dialogs in the language of the settings', async () => {
    game.snapshot = vi.fn(() => ({ state: { settings: { language: 'pt' } }, devCatalog: { settings: {} } }));
    const shown: Record<string, unknown>[] = [];
    (dialog as { showSaveDialog?: unknown }).showSaveDialog = vi.fn(async (options: Record<string, unknown>) => {
      shown.push(options);
      return { canceled: true };
    });
    (dialog as { showOpenDialog?: unknown }).showOpenDialog = vi.fn(async (options: Record<string, unknown>) => {
      shown.push(options);
      return { canceled: true, filePaths: [] };
    });
    expect(await call('exportProgress', fromApp)).toEqual({ ok: true, value: { saved: false } });
    expect(await call('inspectSave', fromApp)).toEqual({ ok: true, value: null });
    expect(await call('chooseDevPath', fromApp, 'folder')).toEqual({ ok: true, value: null });
    expect(shown.map((options) => options.title)).toEqual(['Exportar progresso', 'Restaurar progresso', 'Pasta qa do projeto']);
    expect((shown[0].filters as { name: string }[])[0].name).toBe('Save do Bug Detective');
  });

  it('opens the proxy help page and the feedback page, which are on the allowlist', async () => {
    expect(await call('openExternal', fromApp, 'proxyHelp')).toEqual({ ok: true, value: undefined });
    expect(openUrl).toHaveBeenCalledWith('https://github.com/bug-detective-project/desktop#networks-with-a-proxy');
    expect(await call('openExternal', fromApp, 'feedback')).toEqual({ ok: true, value: undefined });
    expect(openUrl).toHaveBeenCalledWith('https://github.com/bug-detective-project/desktop/discussions');
  });

  it('hands out the diagnostics text and opens the logs folder', async () => {
    expect(await call('diagnostics', fromApp)).toEqual({ ok: true, value: 'Bug Detective 0.1.0 diagnostics' });
    expect(await call('openLogsFolder', fromApp)).toEqual({ ok: true, value: undefined });
    expect(game.openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it('refuses a sender that is not the app renderer, without calling the game', async () => {
    expect(await call('nextAssignment', { senderFrame: { url: 'https://evil.example/' } }, 'front')).toEqual({ ok: false, error: { code: 'notAllowed', message: 'Untrusted sender' } });
    expect(await call('nextAssignment', {}, 'front')).toMatchObject({ ok: false, error: { code: 'notAllowed' } });
    expect(game.nextAssignment).not.toHaveBeenCalled();
  });

  it('in development, trusts the dev server origin only', async () => {
    handlers.clear();
    registerIpc(game as never, 'http://localhost:5173', openUrl);
    expect(await call('snapshot', { senderFrame: { url: 'http://localhost:5173/index.html' } })).toMatchObject({ ok: true });
    expect(await call('snapshot', fromApp)).toMatchObject({ ok: false, error: { code: 'notAllowed' } });
  });

  it.each([
    ['an unknown track', 'nextAssignment', ['sideways']],
    ['a path as a project id', 'switchProject', ['../etc']],
    ['a link outside the allowlist', 'openExternal', ['https://evil.example']],
    ['development settings in a wrong format', 'applyDevCatalog', [{ catalog: { github: 'not a repository' } }]],
    ['extra arguments', 'snapshot', ['extra']],
  ])('refuses %s as invalidInput, without calling the game', async (_name, channel, args) => {
    expect(await call(channel, fromApp, ...args)).toMatchObject({ ok: false, error: { code: 'invalidInput' } });
    expect(Object.values(game).every((method) => method.mock.calls.length === 0)).toBe(true);
  });

  it('turns errors into codes: a game error keeps its own, Docker and anything else get theirs', async () => {
    game.nextAssignment.mockRejectedValueOnce(new GameError('ticketNotDone', 'Finish it first'));
    expect(await call('nextAssignment', fromApp, 'front')).toEqual({ ok: false, error: { code: 'ticketNotDone', message: 'Finish it first' } });
    game.nextAssignment.mockRejectedValueOnce(new DockerUnavailableError('Docker is not running'));
    expect(await call('nextAssignment', fromApp, 'front')).toMatchObject({ ok: false, error: { code: 'dockerUnavailable' } });
    game.nextAssignment.mockRejectedValueOnce(new Error('disk full'));
    expect(await call('nextAssignment', fromApp, 'front')).toEqual({ ok: false, error: { code: 'failed', message: 'disk full' } });
  });

  it('opens only the workspace app on the loopback address in the browser', async () => {
    expect(await call('openAppInBrowser', fromApp)).toMatchObject({ ok: true });
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:5173/');
    game.appUrl.mockResolvedValueOnce('http://evil.example:5173/');
    expect(await call('openAppInBrowser', fromApp)).toMatchObject({ ok: false, error: { code: 'notAllowed' } });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
