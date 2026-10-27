/**
 * Development only: Chrome DevTools on F12 / Ctrl+Shift+I (Cmd+Option+I on macOS) and the React
 * Developer Tools extension (Components and Profiler tabs). Never used by the packaged app.
 */
import { session } from 'electron';
import type { BrowserWindow, Input } from 'electron';

/** The Chrome Web Store id of React Developer Tools. */
const REACT_DEVTOOLS_ID = 'fmkadmapgofadopljbjfkapdkoienihi';

export function isDevToolsShortcut(input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'shift' | 'alt'>): boolean {
  if (input.type !== 'keyDown') {
    return false;
  }
  const key = input.key.toLowerCase();
  return key === 'f12' || (key === 'i' && ((input.control && input.shift) || (input.meta && input.alt)));
}

/**
 * Downloads React Developer Tools once (cached in userData/extensions; needs internet the first
 * time) and loads it. Must run before the window loads the page, so the extension sees React.
 */
export async function loadReactDevTools(): Promise<void> {
  try {
    // Only the download helper: the package's installExtension uses the deprecated session.loadExtension.
    const { downloadChromeExtension } = await import('electron-devtools-installer/dist/downloadChromeExtension.js');
    const folder = await downloadChromeExtension(REACT_DEVTOOLS_ID, { attempts: 2 });
    const { extensions, serviceWorkers } = session.defaultSession;
    const extension =
      extensions.getAllExtensions().find((loaded) => loaded.id === REACT_DEVTOOLS_ID) ??
      (await extensions.loadExtension(folder, { allowFileAccess: true }));
    // The extension's service worker registers the script that lets it see React; start it now,
    // or the first page load happens before the registration.
    await serviceWorkers.startWorkerForScope(extension.url);
  } catch (error) {
    console.warn(`React Developer Tools not loaded (offline?): ${(error as Error).message}`);
  }
}

/** Toggles Chrome DevTools with the usual shortcuts; BUGDETECTIVE_DEVTOOLS=1 opens them on start. */
export function attachDevToolsShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isDevToolsShortcut(input)) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
  });
  if (process.env.BUGDETECTIVE_DEVTOOLS === '1') {
    window.webContents.once('did-finish-load', () => window.webContents.openDevTools({ mode: 'detach' }));
  }
}
