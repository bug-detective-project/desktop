import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewComparison, Snapshot } from '@shared/api.ts';
import { findTicket } from '@shared/kanban.ts';
import { api } from '../api.ts';
import { company } from '../content.ts';
import { Markdown } from '../components/Markdown.tsx';
import { SplitDiff } from '../components/SplitDiff.tsx';
import { parseDiff, visibleFiles } from '../components/diff.ts';
import { Icon } from '../components/icons.tsx';
import { ContentError } from '../components/ContentError.tsx';
import { useTicketContent } from '../components/useTicketContent.ts';
import { ticketTitle } from '../components/ticketTitle.ts';
import { Button, Card, LogView, SectionTitle, StagePill, Tooltip } from '../components/ui.tsx';
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
      {/* VS Code cannot be opened directly on the commit's diff without an extension: the steps show on hover of the button or the icon. */}
      <Tooltip
        className="items-center gap-2"
        panelClassName="right-0 w-96"
        hoverOnly
        content={
          <div data-testid="vscode-steps">
            <p className="mb-1 font-semibold">{t('review.vscodeSteps.title')}</p>
            <ol className="list-decimal space-y-1 pl-5">
              {(['scm', 'graph', 'diff', 'back'] as const).map((step) => (
                <li key={step}>{t(`review.vscodeSteps.${step}`)}</li>
              ))}
            </ol>
          </div>
        }
      >
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
        <span className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-hidden data-testid="vscode-steps-info">
          <Icon name="info" className="size-5" />
        </span>
      </Tooltip>
      {dockerDown && snapshot.dockerState !== 'notInstalled' && <span className="text-xs text-muted-foreground">{t('review.startsDocker')}</span>}
    </div>
  );
}

/** A card whose body collapses under its title; open by default. */
function DropdownCard({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <details open className="group min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-sm" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 p-5 select-none [&::-webkit-details-marker]:hidden">
        <Icon name="chevronDown" className="size-5 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0" />
        <h2 className="text-base font-bold tracking-wider text-foreground uppercase">{title}</h2>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}

/** Whether the approved solution has no visible difference from the reference (with the current whitespace choice). */
function isIdentical(comparison: ReviewComparison, showWhitespace: boolean): boolean {
  return visibleFiles(parseDiff(showWhitespace ? comparison.solutions : comparison.solutionsIgnoringWhitespace)).length === 0;
}

function Comparison({ comparison, showWhitespace }: { comparison: ReviewComparison; showWhitespace: boolean }) {
  const { t } = useTranslation();
  const solutions = showWhitespace ? comparison.solutions : comparison.solutionsIgnoringWhitespace;
  if (!isIdentical(comparison, showWhitespace)) {
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
        <Icon name="checkCircle" className="size-4 text-emerald-700 dark:text-emerald-400" />
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
  const [comparison, setComparison] = useState<ReviewComparison | null>(null);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [busy, setBusy] = useState(false);

  const { content, failed, retry } = useTicketContent(ticket, language);

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
      // The ticket is Done: the next one (if any) waits on the Dashboard.
      toast.info(t(snapshot.queues?.fullstack.next ? 'review.doneNext' : 'review.doneLast'));
      onBack();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-10xl space-y-6 px-6 py-6" data-testid="code-review">
      {/* The actions always sit below the title, whatever its length. */}
      <header className="space-y-4">
        <div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold tracking-wider text-muted-foreground uppercase">{t('review.title')}</span>
            <span className="font-mono font-bold text-primary">{ticketTitle(snapshot, ticketNumber, language).key}</span>
            <StagePill status={ticket.status} />
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{ticketTitle(snapshot, ticketNumber, language).text}</h1>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="review-actions">
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
        {failed && <ContentError onRetry={retry} />}
        {content?.reviewMarkdown && <Markdown testId="review-markdown">{content.reviewMarkdown}</Markdown>}
      </Card>
      <DropdownCard title={t('review.comparison')} testId="review-comparison">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-3xl text-base text-muted-foreground">{t('review.comparisonIntro')}</p>
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
        </div>
        {snapshot.busy === 'openingReview' && snapshot.log.length > 0 && (
          <div className="mb-4">
            <LogView lines={snapshot.log} />
          </div>
        )}
        {comparison && <Comparison comparison={comparison} showWhitespace={showWhitespace} />}
      </DropdownCard>
      {/* An identical solution already shows the same diff (original → your solution) above. */}
      {!(comparison && isIdentical(comparison, showWhitespace)) && (
        <DropdownCard title={t('review.referenceSection')} testId="review-reference">
          <p className="mb-4 text-base text-muted-foreground">{t('review.referenceIntro', { name: company(language).people.senior.name })}</p>
          {content?.referencePatch && (
            <SplitDiff
              diff={content.referencePatch}
              testId="reference-diff"
              labels={{
                left: t('review.original'),
                right: t('review.referenceSolution'),
                onlyLeft: t('review.removedByReference'),
                onlyRight: t('review.addedByReference'),
              }}
            />
          )}
        </DropdownCard>
      )}
    </div>
  );
}
