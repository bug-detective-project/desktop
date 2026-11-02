import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { PLAYER_MOVES, isPlayerMoveAllowed } from '@shared/kanban.ts';
import { COLUMNS } from '@shared/types.ts';
import type { Column, TicketState } from '@shared/types.ts';
import { api } from '../api.ts';
import { ticketTitle } from '../components/ticketTitle.ts';
import { STAGE } from '../components/stage.ts';
import { Badge, Button, Spinner, TrackBadge } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

const DRAG_TYPE = 'application/x-bugdetective-ticket';

/** Whether the latest finished QA run of the ticket failed (a timeout counts as a failure). */
function lastQaFailed(ticket: TicketState): boolean {
  const last = ticket.attempts.at(-1);
  return ticket.status !== 'inQa' && last !== undefined && last.result.status !== 'passed';
}

interface CardAction {
  label: string;
  testId: string;
  busy: boolean;
  onClick: () => void;
}

function TicketCard({
  ticket,
  title,
  ticketKey,
  active,
  testing,
  draggable,
  movable,
  onOpen,
  onDragStart,
  onDragEnd,
  onSolveBug,
  solving,
  action,
}: {
  ticket: TicketState;
  title: string;
  ticketKey: string;
  /** The ticket the player is working on (In Progress). */
  active: boolean;
  /** QA is running on this ticket right now. */
  testing: boolean;
  draggable: boolean;
  /** Draggable only so a drop can explain why the card stays (In QA, Code Review): styled as not movable. */
  movable: boolean;
  onOpen: () => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  /** Development only (BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON): shows "Solve bug" on the card. */
  onSolveBug?: () => void;
  solving: boolean;
  /** The small button on the key's line: "Move" (To Do, In Progress) or "Review" (Code Review). */
  action?: CardAction;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      data-testid={`card-${ticket.ticket}`}
      data-status={ticket.status}
      data-attempts={ticket.attempts.length}
      className={`block rounded-lg border bg-background p-3.5 text-left transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
        active ? 'border-primary/40' : 'border-border'
      } ${movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TrackBadge track={ticket.track} />
          <p className="font-mono text-sm font-medium text-primary">{ticketKey}</p>
        </div>
        {action && (
          // The card opens on click and Enter; the button keeps both to itself.
          <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Button size="xs" busy={action.busy} onClick={action.onClick} data-testid={action.testId}>
              {t(action.label)}
            </Button>
          </span>
        )}
        {testing && (
          <span data-testid="card-qa-running">
            <Badge tone="warn">
              <Spinner className="size-3" />
              {t('board.testing')}
            </Badge>
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 font-medium text-foreground">{title}</p>
      {lastQaFailed(ticket) && (
        <div className="mt-2.5" data-testid="card-qa-failed">
          <Badge tone="danger">{t('qa.badge.failed')}</Badge>
        </div>
      )}
      {onSolveBug && (
        // The card opens on click and Enter; the button keeps both to itself.
        <div className="mt-2.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Button size="xs" busy={solving} onClick={onSolveBug} data-testid="solve-bug">
            {t('board.solveBug')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The subtitle follows the ticket the player is working on (the one not Done yet). With only Done
 * tickets, it points back to the Dashboard for the next assignment, or says every ticket is done.
 */
function boardHint(snapshot: Snapshot): string {
  const { tickets } = snapshot.state;
  const active = tickets.find((ticket) => ticket.status !== 'done');
  if (active?.status === 'todo') {
    return 'board.hintTodo';
  }
  if (active?.status === 'codeReview') {
    return 'board.hintCodeReview';
  }
  if (!active && tickets.length > 0) {
    return snapshot.nextTicket === null ? 'dashboard.allDone' : 'board.hintDone';
  }
  return 'board.hint';
}

export function Board({
  snapshot,
  onOpenTicket,
  onOpenReview,
}: {
  snapshot: Snapshot;
  onOpenTicket: (ticket: number) => void;
  onOpenReview: (ticket: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { state } = snapshot;
  const language = state.settings.language;
  // The ref is set synchronously on dragstart: dragover can fire before React re-renders.
  const draggingRef = useRef<TicketState | null>(null);
  const [dragging, setDragging] = useState<TicketState | null>(null);
  const [over, setOver] = useState<Column | null>(null);

  const canMove = (ticket: TicketState) =>
    ticket.ticket === state.currentTicket && (PLAYER_MOVES[ticket.status]?.length ?? 0) > 0 && snapshot.busy !== 'qa';
  // Cards that QA or the code review will move can still be picked up: dropping them explains what moves them.
  const canDrag = (ticket: TicketState) =>
    canMove(ticket) || (ticket.ticket === state.currentTicket && (ticket.status === 'inQa' || ticket.status === 'codeReview'));

  // In QA pulses only while a QA run is in progress; In Progress always does.
  const moveForward = async (ticket: number, to: Column) => {
    try {
      await api.move(ticket, to);
    } catch (error) {
      toast.error(error);
    }
  };

  // The same moves as dragging: To Do → In Progress, In Progress → In QA; Code Review opens the review.
  const cardAction = (ticket: TicketState): CardAction | undefined => {
    if (ticket.status === 'codeReview' && ticket.ticket === state.currentTicket) {
      return { label: 'board.review', testId: 'review-card', busy: false, onClick: () => onOpenReview(ticket.ticket) };
    }
    const to = ticket.status === 'todo' ? 'inProgress' : ticket.status === 'inProgress' ? 'inQa' : null;
    if (!to || !canMove(ticket)) {
      return undefined;
    }
    return {
      label: 'board.move',
      testId: 'move-card',
      busy: snapshot.busy === (to === 'inProgress' ? 'starting' : 'qa'),
      onClick: () => void moveForward(ticket.ticket, to),
    };
  };

  const solveBug = async (ticket: number) => {
    try {
      await api.solveBug(ticket);
      toast.info(t('board.solvedBug'));
    } catch (error) {
      toast.error(error);
    }
  };

  const pulses = (column: Column) => (column === 'inQa' ? snapshot.busy === 'qa' : STAGE[column].pulse);

  const endDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setOver(null);
  };

  const drop = async (column: Column, ticketNumber: number) => {
    const ticket = draggingRef.current ?? state.tickets.find((item) => item.ticket === ticketNumber) ?? null;
    endDrag();
    if (!ticket || ticket.status === column) {
      return;
    }
    if (!isPlayerMoveAllowed(ticket.status, column) || !canMove(ticket)) {
      const reason =
        ticket.status === 'inQa'
          ? 'notAllowedInQa'
          : ticket.status === 'codeReview'
            ? 'notAllowedInReview'
            : ticket.status === 'inProgress' && column === 'todo'
              ? 'notAllowedBackToTodo'
              : 'notAllowed';
      toast.info(t(`board.${reason}`));
      return;
    }
    try {
      await api.move(ticket.ticket, column);
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-10xl flex-col px-6 py-6" data-testid="board">
      <header className="mb-5">
        <h1 className="text-3xl font-bold tracking-tight">{t('board.title')}</h1>
        <p className="mt-1 text-base text-muted-foreground" data-testid="board-hint">
          {t(boardHint(snapshot))}
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-5 items-stretch gap-4" data-tour="columns">
        {COLUMNS.map((column) => {
          const tickets = state.tickets.filter((ticket) => ticket.status === column);
          const allowed = dragging ? isPlayerMoveAllowed(dragging.status, column) : false;
          const isTicketDrag = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);
          return (
            <section
              key={column}
              data-testid={`column-${column}`}
              onDragOver={(event) => {
                if (isTicketDrag(event)) {
                  // Every column accepts the drop, so a forbidden one can explain why it refuses.
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setOver(column);
                }
              }}
              onDragLeave={() => setOver((current) => (current === column ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                void drop(column, Number(event.dataTransfer.getData(DRAG_TYPE)));
              }}
              aria-label={t(`board.columns.${column}`)}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition ${
                dragging && allowed ? 'border-primary ring-2 ring-primary/30' : 'border-border'
              } ${dragging && !allowed ? 'opacity-60' : ''}`}
            >
              <header className={`flex items-center gap-2 border-b px-4 py-3 ${STAGE[column].pill}`}>
                <span className={`size-1.5 shrink-0 rounded-full ${STAGE[column].dot} ${pulses(column) ? 'animate-pulse' : ''}`} aria-hidden />
                <h2 className="truncate text-xs font-bold tracking-wider uppercase">{t(`board.columns.${column}`)}</h2>
                <span className="ml-auto text-xs font-medium text-muted-foreground tabular-nums" data-testid={`count-${column}`}>
                  {tickets.length}
                </span>
              </header>
              <div className={`flex flex-1 flex-col gap-2.5 overflow-y-auto p-3 transition-colors ${over === column && allowed ? 'bg-primary/5' : ''}`}>
                {tickets.length === 0 && (
                  <p
                    className={`rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground ${
                      column === 'inQa' ? 'border-amber-500/40' : 'border-border'
                    }`}
                    data-testid={`empty-${column}`}
                  >
                    {t(`board.emptyColumn.${column}`)}
                  </p>
                )}
                {tickets.map((ticket) => (
                  <TicketCard
                    key={ticket.ticket}
                    ticket={ticket}
                    title={ticketTitle(snapshot, ticket.ticket, language).text}
                    ticketKey={ticketTitle(snapshot, ticket.ticket, language).key}
                    active={ticket.ticket === state.currentTicket && ticket.status === 'inProgress'}
                    testing={ticket.status === 'inQa' && snapshot.busy === 'qa'}
                    draggable={canDrag(ticket)}
                    movable={canMove(ticket)}
                    onOpen={() => onOpenTicket(ticket.ticket)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, String(ticket.ticket));
                      event.dataTransfer.effectAllowed = 'move';
                      draggingRef.current = ticket;
                      setDragging(ticket);
                    }}
                    onDragEnd={endDrag}
                    onSolveBug={
                      snapshot.devSolveBug && ticket.ticket === state.currentTicket && ticket.status === 'inProgress'
                        ? () => void solveBug(ticket.ticket)
                        : undefined
                    }
                    solving={snapshot.busy === 'solvingBug'}
                    action={cardAction(ticket)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
