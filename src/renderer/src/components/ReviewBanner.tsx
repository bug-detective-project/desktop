import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { api } from '../api.ts';
import { useToast } from '../toast-context.ts';
import { Icon } from './icons.tsx';
import { ticketTitle } from './ticketTitle.ts';
import { Button } from './ui.tsx';

/**
 * Shown while a review is checked out in the workspace, and after the player's code came back with
 * something to tell. Talks about tickets only, never about branches.
 */
export function ReviewBanner({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const toast = useToast();
  const language = snapshot.state.settings.language;
  const session = snapshot.state.reviewSession;
  const notice = snapshot.reviewNotice;
  if (session) {
    const closing = snapshot.busy === 'closingReview';
    return (
      <div className="border-b border-primary/30 bg-primary/10" role="status" data-testid="review-banner">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-2 text-sm">
          <span className="flex items-center gap-2 font-medium text-foreground">
            <Icon name="code" className="size-4 text-primary" />
            {t('review.banner', { ticket: ticketTitle(snapshot, session.ticket, language).key })}
          </span>
          <Button
            size="sm"
            variant="primary"
            busy={closing}
            disabled={snapshot.busy !== null && !closing}
            onClick={() => api.closeReview().catch(toast.error)}
            data-testid="back-to-my-code"
          >
            {!closing && <Icon name="rotateCcw" className="size-3.5" />}
            {t('review.backToMyCode')}
          </Button>
        </div>
      </div>
    );
  }
  if (notice) {
    return (
      <div className="border-b border-amber-500/30 bg-amber-500/10" role="status" data-testid="review-notice">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-2 text-sm">
          <span className="flex items-center gap-2 font-medium text-foreground">
            <Icon name="info" className="size-4 text-amber-500" />
            {t(`review.notice.${notice.kind}`, { ticket: ticketTitle(snapshot, notice.ticket, language).key })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void api.dismissReviewNotice()} aria-label={t('common.close')}>
            <Icon name="x" className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }
  return null;
}
