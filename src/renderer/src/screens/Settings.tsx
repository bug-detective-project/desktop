import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SaveSummary, Snapshot } from '@shared/api.ts';
import { LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS, THEMES } from '@shared/types.ts';
import { api } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Badge, Button, Card, LogView, Modal, Notice } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

const LANGUAGE_NAMES = { en: 'English', pt: 'Português (Brasil)' };

/** A settings section: its title and help on the left, its controls on the right. */
function Group({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {help && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function Settings({ snapshot }: { snapshot: Snapshot }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { settings } = snapshot.state;
  const [timeout, setTimeoutValue] = useState(String(settings.qaTimeoutSeconds));
  const [pending, setPending] = useState<{ token: string; summary: SaveSummary } | null>(null);
  const [confirmNewGame, setConfirmNewGame] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };

  const check = (id: string) => snapshot.prerequisites?.checks.find((item) => item.id === id);
  const saveTimeout = () => {
    const value = Number(timeout);
    if (Number.isInteger(value) && value >= MIN_QA_TIMEOUT_SECONDS && value <= MAX_QA_TIMEOUT_SECONDS) {
      void api.updateSettings({ qaTimeoutSeconds: value }).catch(toast.error);
    } else {
      setTimeoutValue(String(settings.qaTimeoutSeconds));
    }
  };

  const field = 'rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none';

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8" data-testid="settings">
      <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>

      <Group title={t('settings.preferences')} help={t('settings.preferencesHelp')}>
        <Card className="divide-y divide-border p-0">
          <label className="flex items-center justify-between gap-4 p-4">
            <span className="text-sm font-medium">{t('settings.language')}</span>
            <select
              className={field}
              value={settings.language}
              onChange={(event) => void api.updateSettings({ language: event.target.value as 'en' | 'pt' })}
              data-testid="language-select"
            >
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {LANGUAGE_NAMES[language]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-4 p-4">
            <span className="text-sm font-medium">{t('settings.theme')}</span>
            <select
              className={field}
              value={settings.theme}
              onChange={(event) => void api.updateSettings({ theme: event.target.value as 'system' })}
              data-testid="theme-select"
            >
              {THEMES.map((theme) => (
                <option key={theme} value={theme}>
                  {t(`settings.themes.${theme}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-4 p-4">
            <span>
              <span className="block text-sm font-medium">{t('settings.qaTimeout')}</span>
              <span className="block text-xs text-muted-foreground">{t('settings.qaTimeoutHelp')}</span>
            </span>
            <input
              type="number"
              min={MIN_QA_TIMEOUT_SECONDS}
              max={MAX_QA_TIMEOUT_SECONDS}
              className={`w-28 font-mono ${field}`}
              value={timeout}
              onChange={(event) => setTimeoutValue(event.target.value)}
              onBlur={saveTimeout}
              data-testid="qa-timeout"
            />
          </label>
        </Card>
      </Group>

      <Group title={t('settings.status')}>
        <Card>
          <dl className="grid grid-cols-[10rem_1fr] items-center gap-y-3 text-sm">
            <dt className="text-muted-foreground">{t('settings.docker')}</dt>
            <dd>
              <Badge tone={snapshot.dockerState === 'running' ? 'ok' : 'danger'}>{t(`header.docker.${snapshot.dockerState ?? 'notRunning'}`)}</Badge>
            </dd>
            <dt className="text-muted-foreground">{t('settings.vscode')}</dt>
            <dd className="flex flex-wrap gap-2">
              <Badge tone={check('vscode')?.status === 'ok' ? 'ok' : 'danger'}>{t(`checklist.status.${check('vscode')?.status ?? 'missing'}`)}</Badge>
              <Badge tone={check('devcontainers')?.status === 'ok' ? 'ok' : 'danger'}>Dev Containers</Badge>
            </dd>
          </dl>
          <Button className="mt-4" size="sm" onClick={() => run('check', async () => void (await api.checkPrerequisites()))} busy={busy === 'check'}>
            {busy !== 'check' && <Icon name="refresh" className="size-3.5" />}
            {t('common.checkAgain')}
          </Button>
        </Card>
      </Group>

      <Group title={t('settings.progress')} help={t('settings.exportHelp')}>
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              busy={busy === 'export' || snapshot.busy === 'exporting'}
              disabled={snapshot.busy !== null}
              onClick={() =>
                run('export', async () => {
                  const result = await api.exportProgress();
                  if (result.saved) toast.info(t('settings.exported', { path: result.path }));
                })
              }
              data-testid="export-progress"
            >
              <Icon name="download" />
              {t('settings.export')}
            </Button>
            <Button
              busy={busy === 'inspect' || snapshot.busy === 'restoring'}
              disabled={snapshot.busy !== null}
              onClick={() => run('inspect', async () => setPending(await api.inspectSave()))}
              data-testid="restore-progress"
            >
              <Icon name="refresh" />
              {t('settings.restore')}
            </Button>
          </div>
          {snapshot.busy === 'restoring' && (
            <div className="mt-3">
              <LogView lines={snapshot.log} />
            </div>
          )}
        </Card>
      </Group>

      <Group title={t('settings.dangerZone')} help={t('settings.newGameHelp')}>
        <Card className="border-destructive/30">
          <Button variant="danger" disabled={snapshot.busy !== null} onClick={() => setConfirmNewGame(true)} data-testid="new-game">
            {t('settings.newGame')}
          </Button>
        </Card>
      </Group>

      <Group title={t('settings.about')}>
        <Card>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('app.name')}</dt>
            <dd className="font-mono text-xs">{snapshot.appVersion}</dd>
            <dt className="text-muted-foreground">{t('settings.versions')}</dt>
            <dd className="font-mono text-xs">
              Electron {snapshot.versions.electron} · Node {snapshot.versions.node} · Chromium {snapshot.versions.chrome}
            </dd>
            <dt className="text-muted-foreground">{t('settings.contentSource')}</dt>
            <dd className="font-mono text-xs break-all">{snapshot.contentSource}</dd>
          </dl>
        </Card>
      </Group>

      {confirmNewGame && (
        <Modal title={t('settings.newGameTitle')} onClose={() => setConfirmNewGame(false)}>
          <Notice>{t('settings.newGameWarning')}</Notice>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setConfirmNewGame(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              data-testid="confirm-new-game"
              onClick={() => {
                setConfirmNewGame(false);
                void run('newGame', async () => {
                  await api.newGame();
                  toast.info(t('settings.newGameDone'));
                });
              }}
            >
              {t('settings.newGameConfirm')}
            </Button>
          </div>
        </Modal>
      )}
      {pending && (
        <Modal title={t('settings.restoreTitle')} onClose={() => setPending(null)}>
          <p className="text-sm">
            {t('settings.restoreSummary', {
              file: pending.summary.fileName,
              date: new Date(pending.summary.createdAt).toLocaleString(i18n.language === 'pt' ? 'pt-BR' : 'en-US'),
              done: pending.summary.ticketsDone,
            })}
          </p>
          {pending.summary.overwritesProgress && (
            <div className="mt-3">
              <Notice data-testid="restore-warning">{t('settings.restoreWarning')}</Notice>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setPending(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const { token } = pending;
                setPending(null);
                void run('restore', async () => {
                  await api.restoreProgress(token);
                  toast.info(t('settings.restored'));
                });
              }}
              data-testid="confirm-restore"
            >
              {t('settings.restoreConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
