import { useTranslation } from 'react-i18next';
import type { TicketType } from '@shared/ticketMeta.ts';
import { TONES } from './tones.ts';

const TAG = 'inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wider uppercase';

/**
 * The kind of work a ticket asks for, as a square tag next to the track's, and "Front + back"
 * when the ticket needs changes on both sides. Neither says anything about the cause.
 */
export function TicketTypeBadge({ type, bothSides }: { type: TicketType; bothSides: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {/* The colors of the "Issue type" row of the ticket: a bug in the danger tone, the rest neutral. */}
      <span className={`${TAG} ${TONES[type === 'fix' ? 'danger' : 'neutral']}`} title={t('ticketType.title')} data-testid="ticket-type" data-type={type}>
        {t(`ticketType.${type}`)}
      </span>
      {bothSides && (
        <span
          className={`${TAG} border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300`}
          title={t('ticketType.bothSidesTitle')}
          data-testid="ticket-both-sides"
        >
          {t('ticketType.bothSides')}
        </span>
      )}
    </>
  );
}
