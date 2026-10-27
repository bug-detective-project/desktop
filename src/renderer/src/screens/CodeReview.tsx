import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot, TicketContent } from '@shared/api.ts';
import { findTicket } from '@shared/kanban.ts';
import { api } from '../api.ts';
import { DiffView } from '../components/DiffView.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { Icon } from '../components/icons.tsx';
import { ticketTitle } from '../components/ticketTitle.ts';
import { Button, Card, SectionTitle, StagePill } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

export function CodeReview({ snapshot, ticketNumber, onBack }: { snapshot: Snapshot; ticketNumber: number; onBack: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ticket = findTicket(snapshot.state, ticketNumber)!;
  const language = snapshot.state.settings.language;
  const [content, setContent] = useState<TicketContent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    void api.ticketContent(ticketNumber, language).then((loaded) => {
      if (!ignore) setContent(loaded);
    });
    return () => {
      ignore = true;
    };
  }, [ticketNumber, language, ticket.status]);

  const accept = async () => {
    setBusy(true);
    try {
      await api.acceptReview(ticketNumber);
      onBack();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-6" data-testid="code-review">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold tracking-wider text-muted-foreground uppercase">{t('review.title')}</span>
            <span className="font-mono font-bold text-primary">{ticketTitle(snapshot, ticketNumber, language).key}</span>
            <StagePill status={ticket.status} />
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{ticketTitle(snapshot, ticketNumber, language).text}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack}>
            <Icon name="arrowLeft" />
            {t('review.back')}
          </Button>
          {ticket.status === 'codeReview' && (
            <Button variant="primary" busy={busy} onClick={accept} data-testid="accept-review">
              {!busy && <Icon name="checkCircle" />}
              {t('review.accept')}
            </Button>
          )}
        </div>
      </header>
      <Card>
        <SectionTitle>{t('review.explanation')}</SectionTitle>
        {content?.reviewMarkdown && <Markdown testId="review-markdown">{content.reviewMarkdown}</Markdown>}
      </Card>
      <div className="grid gap-6 2xl:grid-cols-2">
        <Card className="min-w-0">
          <SectionTitle>{t('review.reference')}</SectionTitle>
          <DiffView diff={content?.referencePatch ?? null} testId="reference-diff" />
        </Card>
        <Card className="min-w-0">
          <SectionTitle>{t('review.yours')}</SectionTitle>
          <DiffView diff={content?.playerDiff ?? null} testId="player-diff" emptyText={t('review.noDiff')} />
        </Card>
      </div>
    </div>
  );
}
