import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import logo from '../assets/logo.png';
import { api } from '../api.ts';
import { story } from '../content.ts';
import { useToast } from '../toast-context.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

export type View = 'dashboard' | 'board' | 'settings' | 'review';

const NAV: { id: Exclude<View, 'review'>; icon: IconName }[] = [
  { id: 'dashboard', icon: 'mail' },
  { id: 'board', icon: 'board' },
  { id: 'settings', icon: 'settings' },
];

function DockerPill({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const state = snapshot.busy === 'startingDocker' ? 'starting' : snapshot.dockerState;
  if (state === null) {
    return null;
  }
  const look = {
    running: { dot: 'bg-emerald-500', text: 'text-foreground' },
    starting: { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-600 dark:text-amber-400' },
    notRunning: { dot: 'bg-destructive', text: 'text-destructive' },
    notInstalled: { dot: 'bg-destructive', text: 'text-destructive' },
  }[state];
  return (
    <div className="hidden items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-sm md:flex" data-testid="docker-pill" data-state={state}>
      <span className={`size-2 rounded-full ${look.dot}`} aria-hidden />
      <span className={`font-medium whitespace-nowrap ${look.text}`}>{t(`header.docker.${state}`)}</span>
    </div>
  );
}

/** The persistent app header: brand, navigation, system health, inbox, theme and the player. */
export function AppHeader({
  snapshot,
  view,
  dark,
  onNavigate,
}: {
  snapshot: Snapshot;
  view: View;
  /** The resolved theme (a "system" setting follows the OS). */
  dark: boolean;
  onNavigate: (view: View) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = story(snapshot.state.settings.language).company.name;
  const unread = snapshot.state.inbox.filter((message) => !message.read).length;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-8">
          <div className="flex items-center gap-2.5">
            <img src={logo} alt="" className="size-9 shrink-0 rounded-[21%] dark:ring-1 dark:ring-white/15" draggable={false} />
            <div className="flex items-center whitespace-nowrap">
              <span className="text-base font-bold tracking-tight text-foreground">{t('app.name')}</span>
              <span className="ml-2.5 hidden border-l border-border pl-2.5 text-sm text-muted-foreground xl:inline">{company}</span>
            </div>
          </div>
          <nav className="flex items-center gap-1" aria-label="Main">
            {NAV.map((item) => {
              const active = view === item.id || (view === 'review' && item.id === 'board');
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  data-testid={`nav-${item.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                    active ? 'bg-primary/10 font-semibold text-primary' : 'font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon name={item.icon} />
                  {t(`nav.${item.id}`)}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => api.updateSettings({ theme: dark ? 'light' : 'dark' }).catch(toast.error)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-xs transition-all hover:bg-muted"
            title={t('header.toggleTheme')}
            data-testid="theme-toggle"
          >
            <Icon name="sunMoon" className="size-4 text-muted-foreground" />
            <span className="hidden xl:inline">
              {t('header.theme')}: <span className="font-semibold text-primary">{t(dark ? 'settings.themes.dark' : 'settings.themes.light')}</span>
            </span>
          </button>
          <DockerPill snapshot={snapshot} />
          <button
            type="button"
            onClick={() => onNavigate('dashboard')}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            title={t('dashboard.inbox')}
          >
            <Icon name="mail" className="size-4 text-muted-foreground" />
            <span className="hidden whitespace-nowrap xl:inline">{t('dashboard.inbox')}</span>
            {unread > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-bold text-primary" data-testid="unread-count">
                {unread}
              </span>
            )}
          </button>
          <div className="flex size-8 items-center justify-center rounded-full border border-primary/20 bg-primary/15 text-sm font-semibold text-primary" aria-hidden>
            {t('header.me')}
          </div>
        </div>
      </div>
    </header>
  );
}
