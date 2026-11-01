import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { TRACK_CHOICES } from '@shared/types.ts';
import type { TrackChoice } from '@shared/types.ts';
import { Icon } from './icons.tsx';
import { Button } from './ui.tsx';

/**
 * "Get next assignment ▾": the player picks the track of the next ticket. Each item shows the
 * track's next ticket and progress; a finished track is disabled, a track without tickets is not
 * shown, and fullstack (offered when both tracks have tickets) says which track comes next.
 */
export function NextAssignmentMenu({
  snapshot,
  disabled,
  onChoose,
  className = '',
  testId,
}: {
  snapshot: Snapshot;
  disabled: boolean;
  onChoose: (track: TrackChoice) => void;
  className?: string;
  testId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const language = snapshot.state.settings.language;

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

  const choose = (track: TrackChoice) => {
    setOpen(false);
    onChoose(track);
  };

  const detail = (choice: TrackChoice): string => {
    const queue = snapshot.queues![choice];
    if (!queue.next) {
      return t('dashboard.trackDone', { done: queue.done, total: queue.total });
    }
    const key = queue.next.title[language].split(':')[0];
    const progress = `${queue.done}/${queue.total}`;
    return choice === 'fullstack'
      ? t('dashboard.trackNextFullstack', { track: t(`dashboard.track.${queue.next.track}`), key, progress })
      : t('dashboard.trackNext', { key, progress });
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <Button
        size="sm"
        variant="primary"
        className="w-full"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
      >
        <Icon name="download" className="size-3.5" />
        {t('dashboard.nextAssignment')}
        <Icon name="chevronDown" className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={t('dashboard.chooseTrack')}
          className="absolute top-full right-0 left-0 z-50 mt-2 flex min-w-64 flex-col gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
          data-testid={`${testId}-tracks`}
        >
          {!snapshot.queues ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('dashboard.downloadProjectFirst')}</p>
          ) : (
            TRACK_CHOICES.filter((choice) => {
              const queues = snapshot.queues!;
              // A track without tickets is not offered; fullstack needs both tracks, and a ticket left.
              return choice === 'fullstack' ? queues.front.total > 0 && queues.back.total > 0 && queues.fullstack.next : queues[choice].total > 0;
            }).map((choice) => {
              const finished = !snapshot.queues![choice].next;
              return (
                <button
                  key={choice}
                  type="button"
                  role="menuitem"
                  disabled={finished}
                  onClick={() => choose(choice)}
                  className="flex flex-col items-start rounded-md px-3 py-2 text-left transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid={`next-assignment-${choice}`}
                >
                  <span className="text-sm font-semibold text-foreground">{t(`dashboard.track.${choice}`)}</span>
                  <span className="text-xs text-muted-foreground">{detail(choice)}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
