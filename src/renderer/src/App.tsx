import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { useSnapshot } from './api.ts';
import { AppHeader } from './components/AppHeader.tsx';
import type { View } from './components/AppHeader.tsx';
import { ReviewBanner } from './components/ReviewBanner.tsx';
import { Spinner } from './components/ui.tsx';
import { Board } from './screens/Board.tsx';
import { Checklist, DockerBanner } from './screens/Checklist.tsx';
import { CodeReview } from './screens/CodeReview.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Settings } from './screens/Settings.tsx';
import { TicketPanel } from './screens/TicketPanel.tsx';

/** Applies the language and theme settings; returns whether the dark theme is showing. */
function useThemeAndLanguage(snapshot: Snapshot | null): boolean {
  const { i18n } = useTranslation();
  const language = snapshot?.state.settings.language;
  const theme = snapshot?.state.settings.theme;
  const [dark, setDark] = useState(false);
  useEffect(() => {
    if (language && i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
    document.documentElement.lang = language === 'pt' ? 'pt-BR' : 'en';
  }, [i18n, language]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const isDark = theme === 'dark' || (theme !== 'light' && media.matches);
      document.documentElement.classList.toggle('dark', isDark);
      setDark(isDark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return dark;
}

export function App() {
  const { t } = useTranslation();
  const snapshot = useSnapshot();
  const [view, setView] = useState<View>('dashboard');
  const [openTicket, setOpenTicket] = useState<number | null>(null);
  const [reviewTicket, setReviewTicket] = useState<number | null>(null);
  const [checklistDone, setChecklistDone] = useState(false);
  const dark = useThemeAndLanguage(snapshot);

  // The checklist is skipped when everything already passes and a game is in progress. Once
  // passed, it stays passed for the session (state adjusted during render, not in an effect).
  const allOk = snapshot?.prerequisites?.allOk ?? false;
  if (allOk && !checklistDone && snapshot?.state.tickets.length) {
    setChecklistDone(true);
  }

  if (!snapshot || !snapshot.prerequisites) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted-foreground">
        <Spinner /> {t('common.working')}
      </div>
    );
  }
  if (!checklistDone) {
    return <Checklist snapshot={snapshot} onContinue={() => setChecklistDone(true)} />;
  }

  const openReview = (ticket: number) => {
    setReviewTicket(ticket);
    setOpenTicket(null);
    setView('review');
  };

  return (
    <div className="flex h-full flex-col">
      <AppHeader snapshot={snapshot} view={view} dark={dark} onNavigate={setView} />
      <DockerBanner snapshot={snapshot} />
      <ReviewBanner snapshot={snapshot} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        {view === 'dashboard' && (
          <Dashboard
            snapshot={snapshot}
            onOpenBoard={() => setView('board')}
            onOpenTicket={(ticket) => {
              setView('board');
              setOpenTicket(ticket);
            }}
            onOpenReview={openReview}
          />
        )}
        {view === 'board' && <Board snapshot={snapshot} onOpenTicket={setOpenTicket} />}
        {view === 'settings' && <Settings snapshot={snapshot} />}
        {view === 'review' && reviewTicket !== null && (
          <CodeReview snapshot={snapshot} ticketNumber={reviewTicket} onBack={() => setView('board')} />
        )}
      </main>
      {openTicket !== null && view !== 'review' && (
        <TicketPanel snapshot={snapshot} ticketNumber={openTicket} onClose={() => setOpenTicket(null)} onOpenReview={() => openReview(openTicket)} />
      )}
    </div>
  );
}
