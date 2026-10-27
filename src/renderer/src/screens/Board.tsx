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
import { Badge, Spinner } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

const DRAG_TYPE = 'application/x-bugdetective-ticket';

function TicketCard({
  ticket,
  title,
  ticketKey,
  draggable,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  ticket: TicketState;
  title: string;
  ticketKey: string;
  draggable: boolean;
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
      className={`w-full rounded-xl border bg-card p-4 text-left shadow-sm transition hover:border-primary/40 hover:shadow focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
        draggable ? 'cursor-grab border-primary/30 active:cursor-grabbing' : 'cursor-pointer border-border'
      }`}
    >
      <p className="font-mono text-sm font-bold text-primary">{ticketKey}</p>
      <p className="mt-1 text-base leading-snug font-semibold text-foreground">{title}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">
        {ticket.status === 'inQa' && (
          <Badge tone="warn">
            <Spinner className="size-3" /> {t('board.qaRunning')}
          </Badge>
        )}
        {ticket.attempts.length > 0 && <Badge>{t('board.attempts', { count: ticket.attempts.length })}</Badge>}
      </div>
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

  const canDrag = (ticket: TicketState) =>
    ticket.ticket === state.currentTicket && (PLAYER_MOVES[ticket.status]?.length ?? 0) > 0 && snapshot.busy !== 'qa';

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
    if (!isPlayerMoveAllowed(ticket.status, column)) {
      toast.info(t('board.notAllowed'));
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
        <p className="mt-1 text-base text-muted-foreground">{state.tickets.length === 0 ? t('board.empty') : t('board.hint')}</p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-5 gap-4">
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
              className={`flex min-h-0 flex-col rounded-xl border transition ${
                dragging && allowed ? 'border-primary ring-2 ring-primary/30' : 'border-border'
              } ${dragging && !allowed ? 'opacity-60' : ''} ${over === column && allowed ? 'bg-primary/10' : 'bg-muted/40'}`}
            >
              <h2 className="flex items-center justify-between gap-2 px-3 py-3 text-xs font-bold tracking-wider text-foreground uppercase">
                <span className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${STAGE[column].dot}`} aria-hidden />
                  {t(`board.columns.${column}`)}
                </span>
                <span className="rounded-full border border-border bg-card px-1.5 text-xs font-semibold text-muted-foreground">{tickets.length}</span>
              </h2>
              <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                {tickets.map((ticket) => (
                  <TicketCard
                    key={ticket.ticket}
                    ticket={ticket}
                    title={ticketTitle(snapshot, ticket.ticket, language).text}
                    ticketKey={ticketTitle(snapshot, ticket.ticket, language).key}
                    draggable={canDrag(ticket)}
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
