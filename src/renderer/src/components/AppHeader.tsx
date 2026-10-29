import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import logo from '../assets/logo.png';
import { api } from '../api.ts';
import { LANGUAGES } from '@shared/types.ts';
import type { Language } from '@shared/types.ts';
import { story } from '../content.ts';
import { useToast } from '../toast-context.ts';
import { Flag } from './Flag.tsx';
import { LANGUAGE_NAMES } from './languages.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

export type View = 'dashboard' | 'board' | 'settings' | 'review';

const NAV: { id: Exclude<View, 'review' | 'settings'>; icon: IconName }[] = [
  { id: 'dashboard', icon: 'mail' },
  { id: 'board', icon: 'board' },
];

/**
 * The persistent app header: brand, navigation (the Dashboard item counts the unread messages), theme, language, the
 * settings (a gear button) and the player. Docker problems show in the banner below it.
 */
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
  // A next assignment waiting on the Dashboard: a red "1" that stays until the player picks it up (it wins over the unread count).
  const pending = snapshot.nextTicket !== null;
  const language = snapshot.state.settings.language;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-10xl items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-8">
          <div className="flex items-center gap-2.5">
            <img src={logo} alt="" className="size-9 shrink-0 rounded-[21%] dark:ring-1 dark:ring-white/15" draggable={false} />
            <div className="flex items-center whitespace-nowrap">
              <span className="text-lg font-bold tracking-tight text-foreground">{t('app.name')}</span>
              <span className="ml-2.5 hidden border-l border-border pl-2.5 text-sm text-muted-foreground 2xl:inline">{company}</span>
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
                  className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-base transition-colors ${
                    active ? 'bg-primary/10 font-semibold text-primary' : 'font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon name={item.icon} />
                  {t(`nav.${item.id}`)}
                  {item.id === 'dashboard' && pending && (
                    <span
                      className="inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-bold text-destructive-foreground"
                      title={t('header.pending')}
                      data-testid="pending-count"
                    >
                      1
                    </span>
                  )}
                  {item.id === 'dashboard' && !pending && unread > 0 && (
                    <span
                      className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground"
                      title={t('header.unread', { count: unread })}
                      data-testid="unread-count"
                    >
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => api.updateSettings({ theme: dark ? 'light' : 'dark' }).catch(toast.error)}
            className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-xs transition-all hover:bg-muted"
            title={t('header.toggleTheme')}
            aria-label={t('header.toggleTheme')}
            data-theme={dark ? 'dark' : 'light'}
            data-testid="theme-toggle"
          >
            {/* Icon only: the sun in the light theme, the moon in the dark one. */}
            <Icon name={dark ? 'moon' : 'sun'} className="size-4 text-muted-foreground" />
          </button>
          <LanguageMenu language={language} />
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className={`inline-flex size-8 items-center justify-center rounded-full border shadow-xs transition-all ${
              view === 'settings' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-muted'
            }`}
            title={t('nav.settings')}
            aria-label={t('nav.settings')}
            aria-current={view === 'settings' ? 'page' : undefined}
            data-testid="nav-settings"
          >
            <Icon name="settings" className="size-4" />
          </button>
          <div className="flex size-8 items-center justify-center rounded-full border border-primary/20 bg-primary/15 text-sm font-semibold text-primary" aria-hidden>
            {t('header.me')}
          </div>
        </div>
      </div>
    </header>
  );
}

/** The language picker: the current flag opens a menu with one flag per language, no labels (names in the tooltips). */
function LanguageMenu({ language }: { language: Language }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Closes on a click outside the menu or on Escape.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const choose = (choice: Language) => {
    setOpen(false);
    if (choice !== language) {
      api.updateSettings({ language: choice }).catch(toast.error);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('header.language', { language: LANGUAGE_NAMES[language] })}
        title={t('header.language', { language: LANGUAGE_NAMES[language] })}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground shadow-xs transition-all hover:bg-muted"
        data-testid="language-menu"
      >
        <span className="flex h-5 items-center">
          <Flag language={language} />
        </span>
        <Icon name="chevronDown" className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('settings.language')}
          className="absolute top-full right-0 z-50 mt-2 flex flex-col gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
          data-testid="language-options"
        >
          {LANGUAGES.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === language}
              aria-label={LANGUAGE_NAMES[item]}
              title={LANGUAGE_NAMES[item]}
              onClick={() => choose(item)}
              className={`flex items-center justify-center rounded-md px-3 py-2 transition-colors hover:bg-muted ${
                item === language ? 'bg-primary/10 ring-1 ring-primary/30' : ''
              }`}
              data-testid={`language-${item}`}
            >
              <Flag language={item} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
