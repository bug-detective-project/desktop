import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckResult, DevCatalogView, DiskUsageItem, DockerCleanup, ExternalLink, LocalCatalog, SaveSummary, Snapshot } from '@shared/api.ts';
import { parseMinutes, toMinutes } from '@shared/duration.ts';
import { LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS, THEMES, backupStatus } from '@shared/types.ts';
import type { Language, Theme } from '@shared/types.ts';
import logo from '../assets/logo.png';
import { api } from '../api.ts';
import { Flag } from '../components/Flag.tsx';
import { LANGUAGE_NAMES } from '../components/languages.ts';
import { Icon } from '../components/icons.tsx';
import type { IconName } from '../components/icons.tsx';
import { ticketTitle } from '../components/ticketTitle.ts';
import { Badge, Button, Modal, Notice } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';
import { Segmented } from '../components/Segmented.tsx';

type Tab = 'preferences' | 'environment' | 'backup' | 'about' | 'development';
const TABS: { id: Tab; icon: IconName }[] = [
  { id: 'preferences', icon: 'settings' },
  { id: 'environment', icon: 'server' },
  { id: 'backup', icon: 'hardDrive' },
  { id: 'about', icon: 'info' },
  // Development only: shown when the snapshot carries the development settings.
  { id: 'development', icon: 'code' },
];

const THEME_ICONS: Record<Theme, IconName> = { system: 'laptop', light: 'sun', dark: 'moon' };
const locale = (language: string) => (language === 'pt' ? 'pt-BR' : 'en-US');

const card = 'rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xs md:p-8';
const pane = `space-y-6 ${card}`;

/** Runs an action with its own busy flag; errors become toasts. */
function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/**
 * After a Docker cleanup: a toast when everything went, otherwise a dialog with what Docker could
 * not remove and why (usually a stuck Docker Desktop, which a restart fixes).
 */
function useCleanupResult() {
  const { t } = useTranslation();
  const toast = useToast();
  const [result, setResult] = useState<DockerCleanup | null>(null);
  const show = (cleanup: DockerCleanup, done: (removed: number) => string) => {
    if (cleanup.failed.length === 0) {
      toast.info(done(cleanup.removed));
    } else {
      setResult(cleanup);
    }
  };
  const dialog = result && (
    <Modal title={t('settings.cleanup.partialTitle')} icon={<Icon name="alertTriangle" className="size-5 text-amber-500" />} onClose={() => setResult(null)} data-testid="cleanup-result">
      <p className="text-base leading-relaxed">{t('settings.cleanup.partial', { removed: result.removed, count: result.failed.length })}</p>
      <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border/80 bg-secondary/40 p-3">
        {result.failed.map((item) => (
          <li key={`${item.kind}:${item.name}`} className="min-w-0" data-testid="cleanup-failed">
            <p className="text-sm break-all">
              <span className="font-semibold text-muted-foreground">{t(`settings.cleanup.kinds.${item.kind}`)}: </span>
              <span className="font-mono font-semibold">{item.name}</span>
            </p>
            <p className="text-sm break-words text-muted-foreground">{item.reason}</p>
          </li>
        ))}
      </ul>
      {result.workspaceKept !== undefined && (
        <p className="mt-3 text-base leading-relaxed font-medium" data-testid="cleanup-game">
          {t(result.workspaceKept ? 'settings.cleanup.gameKept' : 'settings.cleanup.gameReset')}
        </p>
      )}
      <p className="mt-3 text-base leading-relaxed text-muted-foreground">{t('settings.cleanup.restartHint')}</p>
      <div className="mt-5 flex justify-end">
        <Button onClick={() => setResult(null)}>{t('common.close')}</Button>
      </div>
    </Modal>
  );
  return { show, dialog };
}

function PaneHeader({ title, help, aside }: { title: string; help: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-bold tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 text-base leading-relaxed text-muted-foreground">{help}</p>
      </div>
      {aside}
    </div>
  );
}

/** One preference: its title and help on the left, the control on the right. */
function Row({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-8">
      <div className="min-w-0">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="mt-0.5 text-base leading-relaxed text-muted-foreground">{help}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** "2 tickets completed · SD-238 (In Progress)": story terms only, never branches or totals. */
function useProgressText(snapshot: Snapshot): { done: string; current: { key: string; stage: string } | null } {
  const { t, i18n } = useTranslation();
  const { tickets, currentTicket } = snapshot.state;
  if (tickets.length === 0) {
    return { done: t('settings.noTickets'), current: null };
  }
  const done = t('settings.ticketsDone', { count: tickets.filter((ticket) => ticket.status === 'done').length });
  const active = tickets.find((ticket) => ticket.ticket === currentTicket && ticket.status !== 'done');
  const current = active ? { key: ticketTitle(snapshot, active.ticket, i18n.language as Language).key, stage: t(`board.columns.${active.status}`) } : null;
  return { done, current };
}

// ---------------------------------------------------------------------------
// Preferences

function QaTimeout({ seconds }: { seconds: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [text, setText] = useState(toMinutes(seconds));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(seconds);
  // The value can also change from outside (another window, a restore).
  if (seconds !== saved) {
    setSaved(seconds);
    setText(toMinutes(seconds));
    setInvalid(false);
  }

  const inRange = (value: number | null): value is number => value !== null && value >= MIN_QA_TIMEOUT_SECONDS && value <= MAX_QA_TIMEOUT_SECONDS;
  const save = (value: number) => {
    setText(toMinutes(value));
    setInvalid(false);
    if (value !== seconds) {
      void api.updateSettings({ qaTimeoutSeconds: value }).catch(toast.error);
    }
  };
  const commit = () => {
    const value = parseMinutes(text);
    if (inRange(value)) {
      save(value);
    } else {
      setInvalid(true);
    }
  };
  const typed = parseMinutes(text);
  const base = inRange(typed) ? typed : seconds;
  const step = (delta: number) => save(Math.min(MAX_QA_TIMEOUT_SECONDS, Math.max(MIN_QA_TIMEOUT_SECONDS, base + delta)));
  const stepButton = 'rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm font-medium text-foreground tabular-nums transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="flex flex-col items-start gap-1.5 md:items-end">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            // The arrows step whole minutes from the 1-minute minimum; half minutes can still be typed.
            min={MIN_QA_TIMEOUT_SECONDS / 60}
            max={MAX_QA_TIMEOUT_SECONDS / 60}
            step={1}
            aria-invalid={invalid}
            className={`w-20 rounded-lg border bg-background px-3 py-1.5 text-right text-base font-medium text-foreground tabular-nums focus:ring-2 focus:outline-hidden ${invalid ? 'border-destructive focus:ring-destructive/40' : 'border-border focus:ring-ring'}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === 'Enter' && commit()}
            data-testid="qa-timeout"
          />
          <span className="text-base text-muted-foreground">{t('settings.qaTimeoutUnit')}</span>
        </label>
        <div className="flex items-center gap-1.5">
          <button type="button" className={stepButton} onClick={() => step(-60)} disabled={base <= MIN_QA_TIMEOUT_SECONDS} aria-label={t('settings.qaTimeoutLess')}>
            -1m
          </button>
          <button type="button" className={stepButton} onClick={() => step(60)} disabled={base >= MAX_QA_TIMEOUT_SECONDS} aria-label={t('settings.qaTimeoutMore')}>
            +1m
          </button>
        </div>
      </div>
      {invalid && (
        <p className="text-sm font-medium text-destructive" role="alert" data-testid="qa-timeout-error">
          {t('settings.qaTimeoutInvalid')}
        </p>
      )}
    </div>
  );
}

function Preferences({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const { settings } = snapshot.state;
  return (
    <div className={`${card} divide-y divide-border/70 [&>*:not(:first-child)]:pt-7 [&>*:not(:last-child)]:pb-7`} data-testid="settings-pane-preferences">
      <Row title={t('settings.language')} help={t('settings.languageHelp')}>
        <Segmented
          label={t('settings.language')}
          value={settings.language}
          options={LANGUAGES.map((language) => ({ value: language, icon: <Flag language={language} />, text: LANGUAGE_NAMES[language] }))}
          onChange={(language) => void api.updateSettings({ language })}
          testId="language"
        />
      </Row>
      <Row title={t('settings.theme')} help={t('settings.themeHelp')}>
        <Segmented
          label={t('settings.theme')}
          value={settings.theme}
          options={THEMES.map((theme) => ({ value: theme, icon: <Icon name={THEME_ICONS[theme]} className="size-3.5" />, text: t(`settings.themes.${theme}`) }))}
          onChange={(theme) => void api.updateSettings({ theme })}
          testId="theme"
        />
      </Row>
      <Row title={t('settings.qaTimeout')} help={t('settings.qaTimeoutHelp')}>
        <QaTimeout seconds={settings.qaTimeoutSeconds} />
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Developer tools and status

const TOOLS: { id: CheckResult['id']; link: ExternalLink }[] = [
  { id: 'docker', link: 'dockerDesktop' },
  { id: 'vscode', link: 'vscode' },
  { id: 'devcontainers', link: 'devContainers' },
  { id: 'wsl', link: 'wsl' },
];

type Tone = 'ok' | 'warn' | 'danger';

function toolStatus(snapshot: Snapshot, check: CheckResult): { label: string; tone: Tone } {
  if (check.id === 'docker') {
    const state = snapshot.dockerState ?? 'notRunning';
    return {
      running: { label: 'running', tone: 'ok' as const },
      starting: { label: 'starting', tone: 'warn' as const },
      notRunning: { label: 'stopped', tone: 'danger' as const },
      notInstalled: { label: 'notInstalled', tone: 'danger' as const },
    }[state];
  }
  if (check.status === 'ok') {
    return { label: check.id === 'devcontainers' ? 'installed' : 'ready', tone: 'ok' };
  }
  if (check.id === 'devcontainers') {
    return { label: check.reason === 'checkFailed' ? 'checkFailed' : 'missing', tone: 'warn' };
  }
  return { label: 'missing', tone: 'danger' };
}

function formatBytes(bytes: number, language: string): string {
  const [value, unit] = bytes >= 1e9 ? [bytes / 1e9, 'GB'] : bytes >= 1e6 ? [bytes / 1e6, 'MB'] : [bytes / 1e3, 'kB'];
  return `${new Intl.NumberFormat(locale(language), { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function DiskUsage({ snapshot, refresh }: { snapshot: Snapshot; refresh: number }) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<DiskUsageItem[] | null>(null);
  const running = snapshot.dockerState === 'running';
  useEffect(() => {
    if (!running) {
      return;
    }
    let live = true;
    api
      .diskUsage()
      .then((usage) => live && setItems(usage))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [running, refresh]);

  return (
    <div className="space-y-3 rounded-xl border border-border/80 bg-secondary/40 p-4" data-testid="disk-usage">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{t('settings.disk')}</h3>
        <span className="text-sm text-muted-foreground">{t('settings.diskHelp')}</span>
      </div>
      {!running ? (
        <p className="text-base text-muted-foreground">{t('settings.diskNeedsDocker')}</p>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {(['workspaceVolume', 'workspaceImage', 'qaImage', 'qaCache'] as const).map((id) => {
            const item = items?.find((entry) => entry.id === id);
            return (
              <div key={id} className="min-w-0 rounded-lg border border-border/60 bg-card p-3" data-testid={`disk-${id}`}>
                <span className="block truncate text-sm font-semibold text-muted-foreground">{t(`settings.diskItems.${id}.name`)}</span>
                <span className="mt-0.5 block text-lg font-bold text-foreground tabular-nums">
                  {items === null ? t('settings.diskMeasuring') : typeof item?.bytes === 'number' ? formatBytes(item.bytes, i18n.language) : '—'}
                </span>
                <span className="block text-sm text-muted-foreground">{item && item.bytes === null ? t('settings.diskNotCreated') : t(`settings.diskItems.${id}.help`)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Environment({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const { busy, run } = useAction();
  const [refresh, setRefresh] = useState(0);
  const checks = (snapshot.prerequisites?.checks ?? []).filter((check) => check.reason !== 'notNeeded');
  const vscodeFound = checks.some((check) => check.id === 'vscode' && check.status === 'ok');

  const action = (check: CheckResult): ReactNode => {
    const link = TOOLS.find((tool) => tool.id === check.id)!.link;
    if (check.id === 'docker') {
      if (snapshot.dockerState === 'notRunning') {
        return (
          <Button variant="primary" size="sm" busy={snapshot.busy === 'startingDocker'} disabled={snapshot.busy !== null} onClick={() => run('docker', () => api.startDocker())} data-testid="start-docker">
            {t('checklist.docker.start')}
          </Button>
        );
      }
      if (snapshot.dockerState !== 'notInstalled') {
        return null;
      }
    } else if (check.status === 'ok') {
      return null;
    }
    if (check.id === 'devcontainers' && vscodeFound) {
      return (
        <Button size="sm" busy={busy === 'devcontainers'} onClick={() => run('devcontainers', () => api.installDevContainers())} data-testid="install-devcontainers">
          {t('settings.installDevContainers')}
        </Button>
      );
    }
    return (
      <Button size="sm" variant="ghost" onClick={() => void api.openExternal(link)}>
        <Icon name="externalLink" className="size-3.5" />
        {t('common.learnMore')}
      </Button>
    );
  };

  return (
    <div className={pane} data-testid="settings-pane-environment">
      <PaneHeader
        title={t('settings.environment')}
        help={t('settings.environmentHelp')}
        aside={
          <Button
            size="sm"
            busy={busy === 'check'}
            onClick={() =>
              run('check', async () => {
                await api.checkPrerequisites();
                setRefresh((value) => value + 1);
              })
            }
            data-testid="check-again"
          >
            {busy !== 'check' && <Icon name="refresh" className="size-3.5" />}
            {t('common.checkAgain')}
          </Button>
        }
      />
      <div className="divide-y divide-border/70 rounded-xl border border-border">
        {TOOLS.map(({ id }) => {
          const check = checks.find((item) => item.id === id);
          if (!check) {
            return null;
          }
          const status = toolStatus(snapshot, check);
          const problem =
            check.id === 'docker'
              ? snapshot.dockerState && snapshot.dockerState !== 'running' && t(`checklist.docker.${snapshot.dockerState}`)
              : check.status !== 'ok' && t(`checklist.${check.id}.${check.reason ?? 'notFound'}`);
          return (
            <div key={id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between" data-testid={`tool-${id}`} data-status={status.label}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-foreground">{t(`checklist.${id}.title`)}</span>
                  {check.version && <span className="rounded-md border border-border/60 bg-muted px-1.5 py-0.5 font-mono text-sm text-muted-foreground">v{check.version}</span>}
                </div>
                {problem && <p className="mt-1 text-base text-muted-foreground">{problem}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={status.tone}>{t(`settings.toolStatus.${status.label}`)}</Badge>
                {action(check)}
              </div>
            </div>
          );
        })}
      </div>
      <DiskUsage snapshot={snapshot} refresh={refresh} />
      <DockerLeftovers snapshot={snapshot} onCleaned={() => setRefresh((value) => value + 1)} />
    </div>
  );
}

/** "Clean up leftovers": what QA leaves behind and images of older versions. Code and progress stay. */
function DockerLeftovers({ snapshot, onCleaned }: { snapshot: Snapshot; onCleaned: () => void }) {
  const { t } = useTranslation();
  const { busy, run } = useAction();
  const cleanup = useCleanupResult();
  const dockerDown = snapshot.dockerState !== 'running';
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-secondary/40 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="docker-leftovers">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-foreground">{t('settings.cleanup.leftoversTitle')}</h3>
        <p className="mt-0.5 text-base leading-relaxed text-muted-foreground">{dockerDown ? t('settings.cleanup.needsDocker') : t('settings.cleanup.leftoversHelp')}</p>
      </div>
      <Button
        size="sm"
        className="shrink-0 self-start sm:self-center"
        busy={busy === 'leftovers' || snapshot.busy === 'cleaningDocker'}
        disabled={dockerDown || snapshot.busy !== null}
        onClick={() =>
          run('leftovers', async () => {
            cleanup.show(await api.cleanDockerLeftovers(), (count) => t('settings.cleanup.leftoversDone', { count }));
            onCleaned();
          })
        }
        data-testid="clean-leftovers"
      >
        {busy !== 'leftovers' && snapshot.busy !== 'cleaningDocker' && <Icon name="trash" className="size-3.5" />}
        {t('settings.cleanup.leftovers')}
      </Button>
      {cleanup.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress and backup

function ago(at: string, now: number, language: string): string {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  const format = new Intl.RelativeTimeFormat(locale(language), { numeric: 'auto' });
  if (seconds < 60) return format.format(0, 'second');
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.floor(seconds / 3600), 'hour');
  return format.format(-Math.floor(seconds / 86_400), 'day');
}

/** Short age for the tab indicator: "3d", "5h", "<1h". */
function shortAge(at: string, now: number): string {
  const hours = Math.max(0, (now - Date.parse(at)) / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : hours >= 1 ? `${Math.floor(hours)}h` : '<1h';
}

function splitPath(file: string): { name: string; folder: string } {
  const name = file.split(/[\\/]/).pop() ?? file;
  return { name, folder: file.slice(0, file.length - name.length) };
}

function Backup({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { busy, run } = useAction();
  const [pending, setPending] = useState<{ token: string; summary: SaveSummary } | null>(null);
  // Cancelling lets the main process drop the save it keeps for the restore (it can be hundreds of MB).
  const cancelRestore = () => {
    if (pending) {
      void api.discardSave(pending.token).catch(() => {});
    }
    setPending(null);
  };
  const [confirmNewGame, setConfirmNewGame] = useState(false);
  const [confirmRemoveDocker, setConfirmRemoveDocker] = useState(false);
  const cleanup = useCleanupResult();
  const progress = useProgressText(snapshot);
  const progressText = progress.current ? `${progress.done} · ${progress.current.key} (${progress.current.stage})` : progress.done;
  const last = snapshot.state.lastExport;
  const lastFile = last && splitPath(last.path);
  const outdated = backupStatus(snapshot.state) === 'outdated';
  const task = snapshot.busy;
  const locked = task !== null && task !== 'exporting' && task !== 'restoring';
  const dockerDown = snapshot.dockerState !== 'running';

  return (
    <div className="space-y-6" data-testid="settings-pane-backup">
      {locked && (
        <Notice data-testid="settings-locked">
          <p className="font-semibold">{t('settings.locked.title', { task: t(`settings.locked.tasks.${task}`) })}</p>
          <p className="mt-0.5 text-base text-muted-foreground">{t('settings.locked.body')}</p>
        </Notice>
      )}
      <div className={pane}>
        <PaneHeader
          title={t('settings.backup')}
          help={t('settings.backupHelp')}
          aside={
            outdated && (
              <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-sm leading-none font-semibold whitespace-nowrap text-amber-700 dark:text-amber-400" data-testid="backup-outdated">
                <Icon name="alertTriangle" className="size-3 text-amber-500" />
                {t('settings.backupOutdated')}
              </span>
            )
          }
        />
        <dl className="space-y-2.5 rounded-xl border border-border/80 bg-secondary/40 p-4 text-base" data-testid="last-export">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t('settings.lastExport')}</dt>
            <dd className="min-w-0 text-right">
              {last && lastFile ? (
                <>
                  <span className="font-mono text-sm font-semibold text-foreground">{lastFile.name}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {ago(last.at, now, i18n.language)} ({new Date(last.at).toLocaleDateString(locale(i18n.language), { dateStyle: 'medium' })})
                  </span>
                </>
              ) : (
                <span className="font-semibold text-foreground">{t('settings.neverExported')}</span>
              )}
            </dd>
          </div>
          {lastFile && (
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t('settings.exportFolder')}</dt>
              <dd className="min-w-0 font-mono text-sm break-all text-foreground">{lastFile.folder}</dd>
            </div>
          )}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border/60 pt-2.5">
            <dt className="text-muted-foreground">{t('settings.campaign')}</dt>
            <dd className="font-semibold text-foreground" data-testid="campaign-progress">
              {progress.done}
              {progress.current && (
                <>
                  {' · '}
                  <span className="font-medium text-primary">
                    <span className="font-mono">{progress.current.key}</span> ({progress.current.stage})
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>
        {dockerDown && !locked && <p className="text-base text-muted-foreground">{t('settings.needsDocker')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
           
            busy={busy === 'export' || task === 'exporting'}
            disabled={task !== null || dockerDown}
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
          <Button busy={busy === 'inspect'} disabled={task !== null || dockerDown} onClick={() => run('inspect', async () => setPending(await api.inspectSave()))} data-testid="restore-progress">
            <Icon name="rotateCcw" />
            {t('settings.restore')}
          </Button>
        </div>
      </div>

      <div className="relative flex items-start gap-3 overflow-hidden rounded-2xl border border-destructive/30 bg-card p-6 shadow-xs md:p-8">
        <Icon name="alertTriangle" className="mt-0.5 size-4 text-destructive" />
        <div className="min-w-0 space-y-4">
          <div>
            <h2 className="text-lg leading-tight font-bold tracking-tight text-destructive">{t('settings.dangerZone')}</h2>
            <p className="mt-1 text-base leading-relaxed text-muted-foreground">{t('settings.dangerZoneHelp')}</p>
          </div>
          <Button variant="dangerOutline" disabled={task !== null} onClick={() => setConfirmNewGame(true)} data-testid="new-game">
            <Icon name="rotateCcw" />
            {t('settings.newGame')}
          </Button>
          <div className="border-t border-destructive/20 pt-4">
            <h3 className="text-base font-semibold text-foreground">{t('settings.cleanup.everythingTitle')}</h3>
            <p className="mt-0.5 text-base leading-relaxed text-muted-foreground">
              {dockerDown ? t('settings.cleanup.needsDocker') : t('settings.cleanup.everythingHelp')}
            </p>
            <Button
              variant="dangerOutline"
              className="mt-3"
              busy={task === 'removingDocker' || busy === 'removeDocker'}
              disabled={task !== null || busy !== null || dockerDown}
              onClick={() => setConfirmRemoveDocker(true)}
              data-testid="remove-docker"
            >
              {task !== 'removingDocker' && busy !== 'removeDocker' && <Icon name="trash" />}
              {t('settings.cleanup.everything')}
            </Button>
          </div>
        </div>
      </div>

      {confirmRemoveDocker && (
        <Modal
          title={t('settings.cleanup.confirmTitle')}
          icon={<Icon name="trash" className="size-5 text-destructive" />}
          onClose={() => setConfirmRemoveDocker(false)}
          data-testid="remove-docker-dialog"
        >
          <Notice tone="danger">
            <p className="text-base leading-relaxed">{t('settings.cleanup.confirmWarning')}</p>
          </Notice>
          <ul className="mt-4 list-disc space-y-1 pl-5 text-base text-muted-foreground">
            <li>{t('settings.cleanup.confirmContainers')}</li>
            <li>{t('settings.cleanup.confirmVolumes')}</li>
            <li>{t('settings.cleanup.confirmImages')}</li>
          </ul>
          <p className="mt-4 text-base leading-relaxed">{t('settings.cleanup.confirmBackup')}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setConfirmRemoveDocker(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              data-testid="confirm-remove-docker"
              onClick={() => {
                setConfirmRemoveDocker(false);
                void run('removeDocker', async () => {
                  cleanup.show(await api.removeDockerData(), () => t('settings.cleanup.everythingDone'));
                });
              }}
            >
              {t('settings.cleanup.confirm')}
            </Button>
          </div>
        </Modal>
      )}
      {cleanup.dialog}

      {confirmNewGame && (
        <Modal title={t('settings.newGameTitle')} icon={<Icon name="rotateCcw" className="size-5 text-destructive" />} onClose={() => setConfirmNewGame(false)}>
          <Notice>
            <p className="text-base leading-relaxed">{t('settings.newGameWarning')}</p>
          </Notice>
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
        <Modal title={t('settings.restoreTitle')} onClose={cancelRestore} data-testid="restore-dialog">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border border-border/80 bg-secondary/40 p-4 text-base">
            <dt className="text-muted-foreground">{t('settings.restoreFile')}</dt>
            <dd className="font-mono text-sm font-semibold break-all">{pending.summary.fileName}</dd>
            <dt className="text-muted-foreground">{t('settings.restoreCreated')}</dt>
            <dd>{new Date(pending.summary.createdAt).toLocaleString(locale(i18n.language), { dateStyle: 'medium', timeStyle: 'short' })}</dd>
            <dt className="text-muted-foreground">{t('settings.restoreVersion')}</dt>
            <dd>Bug Detective <span className="font-mono text-sm">{pending.summary.appVersion}</span></dd>
            <dt className="text-muted-foreground">{t('settings.restoreProgress')}</dt>
            <dd className="font-semibold">{t('settings.ticketsDone', { count: pending.summary.ticketsDone })}</dd>
          </dl>
          {pending.summary.overwritesProgress && (
            <div className="mt-4 space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-base text-amber-900 dark:text-amber-200" data-testid="restore-warning">
              <p className="flex items-start gap-2 font-medium">
                <Icon name="alertTriangle" className="mt-0.5 size-4 text-amber-500" />
                {t('settings.restoreWarning')}
              </p>
              <p className="pl-6">{t('settings.restoreCurrent', { progress: progressText })}</p>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={cancelRestore} data-testid="cancel-restore">
              {t('common.cancel')}
            </Button>
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
              {t(pending.summary.overwritesProgress ? 'settings.restoreConfirmOverwrite' : 'settings.restoreConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The restore cannot be interrupted, so its progress is a dialog without a close button. */
function Restoring({ log }: { log: string[] }) {
  const { t } = useTranslation();
  return (
    <Modal title={t('settings.restoringTitle')} icon={<Icon name="spinner" className="size-5 text-primary" />} data-testid="restoring">
      <p className="text-base text-muted-foreground">{t('settings.restoringHelp')}</p>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-busy>
        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
      </div>
      <pre className="mt-4 max-h-48 overflow-y-auto rounded-lg border border-border/80 bg-black p-3.5 font-mono text-sm whitespace-pre-wrap text-emerald-400 shadow-inner">
        {log.length > 0 ? log.join('\n') : '»'}
      </pre>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// About

function About({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const parts = [
    { id: 'electron', name: 'Electron', version: snapshot.versions.electron },
    { id: 'node', name: 'Node.js', version: snapshot.versions.node },
    { id: 'chrome', name: 'Chromium', version: snapshot.versions.chrome },
  ] as const;
  return (
    <div className={pane} data-testid="settings-pane-about">
      <div className="flex items-start gap-4">
        <img src={logo} alt="" className="size-12 shrink-0 rounded-[21%] dark:ring-1 dark:ring-white/15" draggable={false} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">{t('app.name')}</h2>
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-sm font-semibold text-primary" data-testid="app-version">
              v{snapshot.appVersion}
            </span>
          </div>
          <p className="mt-1 text-base leading-relaxed text-muted-foreground">{t('settings.aboutTagline')}</p>
        </div>
      </div>
      <div className="space-y-3 rounded-xl border border-border/80 bg-secondary/40 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-base font-semibold text-foreground">{t('settings.runtime')}</span>
          <span className="font-mono text-sm text-muted-foreground">{t('settings.runtimeHost')}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {parts.map((part) => (
            <div key={part.id} className="rounded-lg border border-border/60 bg-card p-3">
              <span className="block text-xs font-bold tracking-wider text-muted-foreground uppercase">{part.name}</span>
              <span className="mt-0.5 block font-mono text-base font-bold text-foreground">v{part.version}</span>
              <span className="text-sm text-muted-foreground">{t(`settings.runtimeParts.${part.id}`)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const textInput =
  'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-hidden disabled:opacity-60';

type SourceKind = 'official' | 'github' | 'file';
type ProjectSource = 'published' | 'ref' | 'folder';
interface ProjectForm {
  kind: ProjectSource;
  ref: string;
  folder: string;
}

/** A project's row as catalog.local.json sets it. */
function projectFormOf(settings: LocalCatalog, id: string): ProjectForm {
  const override = settings.projects?.[id];
  if (override && 'qaDir' in override) return { kind: 'folder', ref: '', folder: override.qaDir };
  if (override) return { kind: 'ref', ref: override.qaRef, folder: '' };
  return { kind: 'published', ref: '', folder: '' };
}

/** The form of the development settings, from catalog.local.json. Projects get a row when they show up (see projectFormOf). */
function formOf(view: DevCatalogView) {
  const { catalog } = view.settings;
  const kind: SourceKind = !catalog ? 'official' : 'github' in catalog ? 'github' : 'file';
  return {
    kind,
    repository: catalog && 'github' in catalog ? catalog.github : '',
    branch: catalog && 'github' in catalog ? (catalog.branch ?? 'main') : 'main',
    file: catalog && 'file' in catalog ? catalog.file : '',
    projects: {} as Record<string, ProjectForm>,
  };
}

/** catalog.local.json from the form; overrides of projects outside the catalog in use stay as they were. */
function settingsOf(view: DevCatalogView, form: ReturnType<typeof formOf>): LocalCatalog {
  const listed = new Set(view.projects.map((item) => item.id));
  const projects: NonNullable<LocalCatalog['projects']> = Object.fromEntries(Object.entries(view.settings.projects ?? {}).filter(([id]) => !listed.has(id)));
  for (const { id } of view.projects) {
    const project = form.projects[id] ?? projectFormOf(view.settings, id);
    if (project.kind === 'ref') projects[id] = { qaRef: project.ref.trim() };
    if (project.kind === 'folder') projects[id] = { qaDir: project.folder.trim() };
  }
  const catalog =
    form.kind === 'github' ? { github: form.repository.trim(), branch: form.branch.trim() || 'main' } : form.kind === 'file' ? { file: form.file.trim() } : undefined;
  return { ...(catalog && { catalog }), ...(Object.keys(projects).length > 0 && { projects }) };
}

/** A path field with "Choose…", which opens the system dialog. */
function PathField({ value, onChange, kind, testId, disabled }: { value: string; onChange: (value: string) => void; kind: 'file' | 'folder'; testId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const choose = async () => {
    try {
      const path = await api.chooseDevPath(kind);
      if (path) onChange(path);
    } catch (error) {
      toast.error(error);
    }
  };
  return (
    <div className="flex w-full items-center gap-2">
      <input className={textInput} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} spellCheck={false} data-testid={testId} />
      <Button size="sm" onClick={() => void choose()} disabled={disabled} data-testid={`${testId}-choose`}>
        {t('settings.dev.choose')}
      </Button>
    </div>
  );
}

function Development({ view }: { view: DevCatalogView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const action = useAction();
  const [form, setForm] = useState(() => formOf(view));
  const locked = view.testFile;
  const apply = (settings: LocalCatalog) =>
    action.run('apply', async () => {
      await api.applyDevCatalog(settings);
      toast.info(t('settings.dev.applied'));
    });
  const setProject = (id: string, change: Partial<ProjectForm>) =>
    setForm((current) => ({ ...current, projects: { ...current.projects, [id]: { ...(current.projects[id] ?? projectFormOf(view.settings, id)), ...change } } }));

  return (
    <div className={`${card} divide-y divide-border/70 [&>*:not(:first-child)]:pt-7 [&>*:not(:last-child)]:pb-7`} data-testid="settings-pane-development">
      <div className="space-y-4">
        <PaneHeader title={t('settings.dev.title')} help={t('settings.dev.help', { file: view.file })} />
        {locked && <Notice data-testid="dev-catalog-test-file">{t('settings.dev.testFile')}</Notice>}
        {view.fallback && <Notice data-testid="dev-catalog-fallback">{t('settings.dev.fallback')}</Notice>}
        {view.error && (
          <Notice tone="danger" data-testid="dev-catalog-error">
            {t('settings.dev.error', { message: view.error })}
          </Notice>
        )}
      </div>

      <div className="space-y-4">
        <Row title={t('settings.dev.source')} help={t('settings.dev.sourceHelp')}>
          <Segmented<SourceKind>
            label={t('settings.dev.source')}
            value={form.kind}
            options={(['official', 'github', 'file'] as const).map((kind) => ({ value: kind, icon: null, text: t(`settings.dev.sources.${kind}`) }))}
            onChange={(kind) => setForm((current) => ({ ...current, kind }))}
            testId="dev-catalog-source"
          />
        </Row>
        {form.kind === 'github' && (
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <label className="space-y-1 text-sm font-medium text-muted-foreground">
              {t('settings.dev.repository')}
              <input className={textInput} value={form.repository} placeholder="owner/catalog" onChange={(event) => setForm((current) => ({ ...current, repository: event.target.value }))} disabled={locked} spellCheck={false} data-testid="dev-catalog-github-repository" />
            </label>
            <label className="space-y-1 text-sm font-medium text-muted-foreground">
              {t('settings.dev.branch')}
              <input className={textInput} value={form.branch} onChange={(event) => setForm((current) => ({ ...current, branch: event.target.value }))} disabled={locked} spellCheck={false} data-testid="dev-catalog-github-branch" />
            </label>
          </div>
        )}
        {form.kind === 'file' && <PathField value={form.file} onChange={(file) => setForm((current) => ({ ...current, file }))} kind="file" testId="dev-catalog-file" disabled={locked} />}
      </div>

      <div className="space-y-5">
        <PaneHeader title={t('settings.dev.projects')} help={t('settings.dev.projectsHelp')} />
        {view.projects.map((project) => {
          const value = form.projects[project.id] ?? projectFormOf(view.settings, project.id);
          return (
            <div key={project.id} className="space-y-3 rounded-xl border border-border/80 bg-secondary/40 p-4" data-testid={`dev-project-${project.id}`}>
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <h3 className="font-mono text-base font-semibold text-foreground">{project.id}</h3>
                  <p className="text-sm break-all text-muted-foreground" data-testid={`dev-project-${project.id}-source`}>
                    {project.source}
                  </p>
                </div>
                <Segmented<ProjectSource>
                  label={project.id}
                  value={value.kind}
                  options={(['published', 'ref', 'folder'] as const).map((kind) => ({ value: kind, icon: null, text: t(`settings.dev.projectSources.${kind}`, { ref: project.qaRef }) }))}
                  onChange={(kind) => setProject(project.id, { kind })}
                  testId={`dev-project-${project.id}`}
                />
              </div>
              {value.kind === 'ref' && (
                <input className={textInput} value={value.ref} placeholder="qa-next" onChange={(event) => setProject(project.id, { ref: event.target.value })} disabled={locked} spellCheck={false} data-testid={`dev-project-${project.id}-ref-name`} />
              )}
              {value.kind === 'folder' && <PathField value={value.folder} onChange={(folder) => setProject(project.id, { folder })} kind="folder" testId={`dev-project-${project.id}-folder-path`} disabled={locked} />}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p className="min-w-0 text-base text-muted-foreground" data-testid="dev-catalog-in-use">
          {t('settings.dev.inUse')} <span className="font-mono text-sm break-all text-foreground">{view.inUse}</span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button onClick={() => void apply({})} disabled={locked || action.busy !== null} data-testid="dev-catalog-reset">
            {t('settings.dev.reset')}
          </Button>
          <Button variant="primary" onClick={() => void apply(settingsOf(view, form))} busy={action.busy === 'apply'} disabled={locked || action.busy !== null} data-testid="dev-catalog-apply">
            {t('settings.dev.apply')}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t('settings.dev.nextTicket')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Settings({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('preferences');
  // Ages ("3 days ago") are measured from when the screen opened.
  const [now] = useState(() => Date.now());
  const last = snapshot.state.lastExport;
  const outdated = backupStatus(snapshot.state) === 'outdated';

  return (
    <div className="mx-auto max-w-5xl px-6 py-8" data-testid="settings">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('settings.title')}</h1>
        <p className="mt-1 text-base text-muted-foreground">{t('settings.subtitle')}</p>
      </div>

      <div className="mb-8 flex w-full flex-wrap items-center gap-2 rounded-2xl border border-border/80 bg-secondary/50 p-1.5 shadow-2xs" role="tablist">
        {TABS.filter(({ id }) => id !== 'development' || snapshot.devCatalog !== null).map(({ id, icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-base whitespace-nowrap transition-colors ${
                active ? 'bg-primary font-semibold text-primary-foreground shadow-xs' : 'font-medium text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              }`}
              data-testid={`settings-tab-${id}`}
            >
              <Icon name={icon} className="size-4" />
              {t(`settings.tabs.${id}`)}
              {id === 'backup' && outdated && (
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-sm leading-none font-semibold ${active ? 'border-transparent bg-amber-400 text-amber-950' : 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}
                  data-testid="backup-age"
                >
                  {last ? shortAge(last.at, now) : '!'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'preferences' && <Preferences snapshot={snapshot} />}
      {tab === 'environment' && <Environment snapshot={snapshot} />}
      {tab === 'backup' && <Backup snapshot={snapshot} now={now} />}
      {tab === 'about' && <About snapshot={snapshot} />}
      {/* Remounts with the settings just applied; a catalog refreshed in the background keeps the edits. */}
      {tab === 'development' && snapshot.devCatalog && <Development key={JSON.stringify(snapshot.devCatalog.settings)} view={snapshot.devCatalog} />}
      {snapshot.busy === 'restoring' && <Restoring log={snapshot.log} />}
    </div>
  );
}
