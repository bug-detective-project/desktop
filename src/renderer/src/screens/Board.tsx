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
import { Badge } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

const DRAG_TYPE = 'application/x-bugdetective-ticket';

/** Whether the latest finished QA run of the ticket failed (a timeout counts as a failure). */
function lastQaFailed(ticket: TicketState): boolean {
  const last = ticket.attempts.at(-1);
  return ticket.status !== 'inQa' && last !== undefined && last.result.status !== 'passed';
}

function TicketCard({
  ticket,
  title,
  ticketKey,
  active,
  draggable,
  movable,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  ticket: TicketState;
  title: string;
  ticketKey: string;
  /** The ticket the player is working on (In Progress). */
  active: boolean;
  draggable: boolean;
  /** Draggable only so a drop can explain why the card stays (In QA, Code Review): styled as not movable. */
  movable: boolean;
  onOpen: () => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
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
      <p className="font-mono text-sm font-medium text-primary">{ticketKey}</p>
      <p className="mt-1 line-clamp-2 font-medium text-foreground">{title}</p>
      {lastQaFailed(ticket) && (
        <div className="mt-2.5" data-testid="card-qa-failed">
          <Badge tone="danger">{t('qa.badge.failed')}</Badge>
        </div>
      )}
    </div>
  );
}

export function Board({ snapshot, onOpenTicket }: { snapshot: Snapshot; onOpenTicket: (ticket: number) => void }) {
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
      const reason = ticket.status === 'inQa' ? 'notAllowedInQa' : ticket.status === 'codeReview' ? 'notAllowedInReview' : 'notAllowed';
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
    <div className="mx-auto flex h-full max-w-7xl flex-col px-6 py-6" data-testid="board">
      <header className="mb-5">
        <h1 className="text-3xl font-bold tracking-tight">{t('board.title')}</h1>
        <p className="mt-1 text-base text-muted-foreground">{t('board.hint')}</p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-5 items-stretch gap-4">
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
