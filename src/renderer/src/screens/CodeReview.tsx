import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewComparison, Snapshot, TicketContent } from '@shared/api.ts';
import { findTicket } from '@shared/kanban.ts';
import { api } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { SplitDiff } from '../components/SplitDiff.tsx';
import { parseDiff, visibleFiles } from '../components/diff.ts';
import { Icon } from '../components/icons.tsx';
import { ticketTitle } from '../components/ticketTitle.ts';
import { Button, Card, LogView, SectionTitle, StagePill } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

/** "Open Review in VS Code": starts Docker Desktop first when it is stopped. */
function OpenReviewButton({ snapshot, ticketNumber }: { snapshot: Snapshot; ticketNumber: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const dockerDown = snapshot.dockerState !== 'running';
  const open = async () => {
    setBusy(true);
    try {
      if (dockerDown) {
        // Waits for the engine (with the Docker banner showing progress); if it does not come up,
        // openReview reports that Docker is not running.
        await api.startDocker();
      }
      await api.openReview(ticketNumber);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };
  const working = busy || snapshot.busy === 'openingReview';
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="primary"
        busy={working}
        disabled={snapshot.dockerState === 'notInstalled' || (snapshot.busy !== null && !working)}
        onClick={open}
        data-testid="open-review-vscode"
      >
        {!working && <Icon name="code" />}
        {t('review.openInVSCode')}
      </Button>
      {dockerDown && snapshot.dockerState !== 'notInstalled' && <span className="text-xs text-muted-foreground">{t('review.startsDocker')}</span>}
    </div>
  );
}

function Comparison({ comparison, showWhitespace }: { comparison: ReviewComparison; showWhitespace: boolean }) {
  const { t } = useTranslation();
  const solutions = showWhitespace ? comparison.solutions : comparison.solutionsIgnoringWhitespace;
  if (visibleFiles(parseDiff(solutions)).length > 0) {
    return (
      <SplitDiff
        diff={solutions}
        testId="comparison"
        labels={{ left: t('review.yourSolution'), right: t('review.referenceSolution'), onlyLeft: t('review.onlyYours'), onlyRight: t('review.onlyReference') }}
      />
    );
  }
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-base font-medium text-foreground" data-testid="identical-message">
        <Icon name="checkCircle" className="size-4 text-emerald-600 dark:text-emerald-400" />
        {t('review.identical')}
      </p>
      <p className="text-base text-muted-foreground">{t('review.baselineIntro')}</p>
      <SplitDiff
        diff={showWhitespace ? comparison.baseline : comparison.baselineIgnoringWhitespace}
        testId="baseline-diff"
        labels={{ left: t('review.original'), right: t('review.yourSolution'), onlyLeft: t('review.removedByYou'), onlyRight: t('review.addedByYou') }}
      />
    </div>
  );
}

export function CodeReview({ snapshot, ticketNumber, onBack }: { snapshot: Snapshot; ticketNumber: number; onBack: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ticket = findTicket(snapshot.state, ticketNumber)!;
  const language = snapshot.state.settings.language;
  const [content, setContent] = useState<TicketContent | null>(null);
  const [comparison, setComparison] = useState<ReviewComparison | null>(null);
  const [showWhitespace, setShowWhitespace] = useState(false);
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

  // Stored with the approved snapshot: available offline and with Docker stopped.
  useEffect(() => {
    let ignore = false;
    void api
      .reviewComparison(ticketNumber)
      .then((loaded) => {
        if (!ignore) setComparison(loaded);
      })
      .catch(toast.error);
    return () => {
      ignore = true;
    };
  }, [ticketNumber, toast.error]);

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
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold tracking-wider text-muted-foreground uppercase">{t('review.title')}</span>
            <span className="font-mono font-bold text-primary">{ticketTitle(snapshot, ticketNumber, language).key}</span>
            <StagePill status={ticket.status} />
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{ticketTitle(snapshot, ticketNumber, language).text}</h1>
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
      <Card className="min-w-0" data-testid="review-comparison">
        <SectionTitle
          aside={
            <div className="flex items-start gap-4">
              <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showWhitespace}
                  onChange={(event) => setShowWhitespace(event.target.checked)}
                  className="accent-primary"
                  data-testid="whitespace-toggle"
                />
                {t('review.showWhitespace')}
              </label>
              <OpenReviewButton snapshot={snapshot} ticketNumber={ticketNumber} />
            </div>
          }
        >
          {t('review.comparison')}
        </SectionTitle>
        <p className="mb-4 text-base text-muted-foreground">{t('review.comparisonIntro')}</p>
        {snapshot.busy === 'openingReview' && snapshot.log.length > 0 && (
          <div className="mb-4">
            <LogView lines={snapshot.log} />
          </div>
        )}
        {comparison && <Comparison comparison={comparison} showWhitespace={showWhitespace} />}
      </Card>
    </div>
  );
}
