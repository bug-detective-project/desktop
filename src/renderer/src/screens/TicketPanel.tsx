import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { blocksVSCode } from '@shared/api.ts';
import type { Snapshot, TicketContent, WorkspaceStatus } from '@shared/api.ts';
import { findTicket } from '@shared/kanban.ts';
import type { ChatEntry, TicketState } from '@shared/types.ts';
import { api } from '../api.ts';
import { story } from '../content.ts';
import { DiffView } from '../components/DiffView.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { QaCommentView } from '../components/QaComment.tsx';
import { Icon } from '../components/icons.tsx';
import { ContentError } from '../components/ContentError.tsx';
import { useTicketContent } from '../components/useTicketContent.ts';
import { ticketTitle } from '../components/ticketTitle.ts';
import { Badge, Button, LogView, StagePill, Tabs, Tooltip } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

type Tab = 'ticket' | 'qa' | 'history' | 'senior';

// Rows of the ticket's field table that show live data or a colored badge, in both languages.
const STATUS_FIELDS = new Set(['Status']);
const TYPE_FIELDS = new Set(['Issue type', 'Tipo de item']);

function WorkspaceActions({ snapshot, ticket }: { snapshot: Snapshot; ticket: TicketState }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dockerUp = snapshot.dockerState === 'running';

  const refresh = useCallback(() => {
    if (dockerUp) {
      void api.workspaceStatus().then(setStatus).catch(() => setStatus(null));
    }
  }, [dockerUp]);
  useEffect(refresh, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (ticket.status === 'done') {
    return <p className="text-base text-muted-foreground">{t('ticket.readOnly')}</p>;
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Tooltip content={t('ticket.vscodeHint')} hoverOnly>
          <Button variant="primary" className="w-full" disabled={!dockerUp || blocksVSCode(snapshot.busy)} busy={busy === 'vscode'} onClick={() => run('vscode', () => api.openVSCode())} data-testid="open-vscode">
            {busy !== 'vscode' && <Icon name="code" />}
            {t('ticket.openVSCode')}
          </Button>
        </Tooltip>
        <Button className="w-full" disabled={!dockerUp} busy={busy === 'browser'} onClick={() => run('browser', () => api.openAppInBrowser())} data-testid="open-browser">
          {busy !== 'browser' && <Icon name="externalLink" />}
          {t('ticket.openBrowser')}
          {status?.ports && <span className="font-mono text-sm text-muted-foreground">:{status.ports.client}</span>}
        </Button>
      </div>
      {status?.devServerUp ? (
        <Tooltip content={t('ticket.devServerUp')} className="w-full" hoverOnly>
          <Button className="w-full" disabled={!dockerUp} busy={busy === 'dev'} onClick={() => run('dev', () => api.stopDevServer())} data-testid="stop-dev-server">
            {busy !== 'dev' && <Icon name="pause" />}
            {t('ticket.stopDevServer')}
          </Button>
        </Tooltip>
      ) : (
        <Tooltip content={t('ticket.devServerDown')} className="w-full" hoverOnly>
          <Button className="w-full" disabled={!dockerUp || !status} busy={busy === 'dev'} onClick={() => run('dev', () => api.startDevServer())} data-testid="start-dev-server">
            {busy !== 'dev' && <Icon name="play" />}
            {t('ticket.startDevServer')}
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

function Conversation({ snapshot, ticket, content }: { snapshot: Snapshot; ticket: TicketState; content: TicketContent | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const people = story(snapshot.state.settings.language).people;
  const senior = people.senior.name;
  const [busy, setBusy] = useState(false);
  const total = snapshot.hintsTotal[ticket.ticket] ?? 3;
  const canAsk = ticket.status === 'inProgress' && ticket.ticket === snapshot.state.currentTicket;

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const bubble = (entry: ChatEntry, index: number) => {
    const mine = entry.from === 'player';
    let body: ReactNode;
    if (entry.kind === 'question') body = t('ticket.senior.question', { name: senior });
    else if (entry.kind === 'solutionRequest') body = t('ticket.senior.solutionQuestion');
    else if (entry.kind === 'hint') body = content?.hints[entry.hintIndex ?? 0] ?? '…';
    else
      body = (
        <div className="space-y-3">
          <p>{t('ticket.senior.solutionIntro')}</p>
          {content?.solutionMarkdown && <Markdown testId="solution">{content.solutionMarkdown}</Markdown>}
          <DiffView diff={content?.referencePatch ?? null} testId="solution-diff" />
        </div>
      );
    return (
      <div key={index} className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid={`chat-${entry.kind}`}>
        <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-base ${mine ? 'bg-primary text-primary-foreground' : 'border border-border bg-muted text-foreground'}`}>
          {!mine && <p className="mb-1 text-sm font-semibold text-primary">{senior}</p>}
          {body}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="conversation">
      <p className="text-base text-muted-foreground">{t('ticket.senior.intro', { name: senior })}</p>
      <div className="space-y-3">{ticket.conversation.map(bubble)}</div>
      {canAsk ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {ticket.hintsRevealed < total ? (
            <Button variant="primary" busy={busy} onClick={() => act(() => api.askSenior(ticket.ticket))} data-testid="ask-hint">
              {t('ticket.senior.ask')}
            </Button>
          ) : !ticket.solutionRevealed ? (
            <>
              <span className="text-base text-muted-foreground">{t('ticket.senior.noMoreHints')}</span>
              <Button variant="primary" busy={busy} onClick={() => act(() => api.revealSolution(ticket.ticket))} data-testid="reveal-solution">
                {t('ticket.senior.askSolution')}
              </Button>
            </>
          ) : null}
          <span className="ml-auto text-sm text-muted-foreground" data-testid="hints-used">
            {t('ticket.hintsUsed', { used: ticket.hintsRevealed, total })}
          </span>
        </div>
      ) : (
        ticket.status !== 'done' && <p className="text-base text-muted-foreground">{t('ticket.senior.onlyInProgress')}</p>
      )}
    </div>
  );
}

function History({ ticket, snapshot }: { ticket: TicketState; snapshot: Snapshot }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'pt' ? 'pt-BR' : 'en-US';
  const activity = snapshot.state.activity.filter((entry) => entry.ticket === ticket.ticket);
  const column = (value: string) => t(`board.columns.${value}`);
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-base font-semibold">{t('ticket.attemptHistory')}</h3>
        {ticket.attempts.length === 0 ? (
          <p className="text-base text-muted-foreground">{t('ticket.noAttempts')}</p>
        ) : (
          <ol className="space-y-2" data-testid="attempts">
            {ticket.attempts.map((attempt) => {
              const passed = attempt.result.tests.filter((test) => test.status === 'passed').length;
              const failed = attempt.result.tests.filter((test) => test.status === 'failed').length;
              return (
                <li key={attempt.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-base" data-testid="attempt">
                  <span className="font-medium">{t('ticket.attempt', { number: attempt.number })}</span>
                  <Badge tone={attempt.result.status === 'passed' ? 'ok' : 'danger'}>
                    {t(`ticket.attemptResult.${attempt.result.status}`)}
                  </Badge>
                  <span className="text-muted-foreground">{t('ticket.testsSummary', { passed, failed })}</span>
                  <time className="ml-auto text-sm text-muted-foreground">{new Date(attempt.finishedAt).toLocaleString(locale)}</time>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-base font-semibold">{t('ticket.activity')}</h3>
        <ol className="space-y-1.5 text-base" data-testid="activity">
          {activity.map((entry, index) => (
            <li key={index} className="flex gap-3" data-testid="activity-entry">
              <time className="w-40 shrink-0 text-sm text-muted-foreground">{new Date(entry.at).toLocaleString(locale)}</time>
              <span>
                {entry.from ? t('ticket.transition', { from: column(entry.from), to: column(entry.to) }) : t('ticket.created', { to: column(entry.to) })}
                <span className="ml-2 text-sm text-muted-foreground">({t(`ticket.actor.${entry.actor}`)})</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
      <p className="text-base text-muted-foreground">
        {t('ticket.hintsUsed', { used: ticket.hintsRevealed, total: snapshot.hintsTotal[ticket.ticket] ?? 3 })}
        {ticket.solutionRevealed && ` · ${t('ticket.solutionRevealed')}`}
      </p>
    </div>
  );
}

export function TicketPanel({
  snapshot,
  ticketNumber,
  onClose,
  onOpenReview,
}: {
  snapshot: Snapshot;
  ticketNumber: number;
  onClose: () => void;
  onOpenReview: () => void;
}) {
  const { t } = useTranslation();
  const ticket = findTicket(snapshot.state, ticketNumber)!;
  const language = snapshot.state.settings.language;
  const { content, failed, retry } = useTicketContent(ticket, language);
  const [tab, setTab] = useState<Tab>('ticket');
  const senior = story(language).people.senior.name;
  const qaRunning = ticket.status === 'inQa';

  // Jump to the QA tab when a QA run finishes with a new comment (adjusted during render).
  const commentCount = ticket.comments.length;
  const [seenComments, setSeenComments] = useState(commentCount);
  if (commentCount > seenComments) {
    setSeenComments(commentCount);
    setTab('qa');
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={onClose} data-testid="ticket-panel-backdrop">
      <aside
        className="flex h-full w-panel max-w-full flex-col border-l border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        data-testid="ticket-panel"
        aria-label={snapshot.titles[ticket.ticket]?.[language]}
      >
        <header className="space-y-3 border-b border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-primary">{ticketTitle(snapshot, ticket.ticket, language).key}</span>
                <StagePill status={ticket.status} />
              </div>
              <h2 className="mt-2 text-xl font-bold tracking-tight" data-testid="ticket-title">
                {snapshot.titles[ticket.ticket]?.[language]}
              </h2>
            </div>
            <Button variant="ghost" size="sm" className="px-2" onClick={onClose} aria-label={t('common.close')} data-testid="close-panel">
              <Icon name="x" />
            </Button>
          </div>
          <WorkspaceActions snapshot={snapshot} ticket={ticket} />
          {(ticket.status === 'codeReview' || ticket.status === 'done') && (
            <Button
              variant={ticket.status === 'codeReview' ? 'review' : 'primary'}
              className={ticket.status === 'codeReview' ? 'w-full' : ''}
              onClick={onOpenReview}
              data-testid="open-review"
            >
              <Icon name="checkCircle" />
              {t('ticket.openReview')}
            </Button>
          )}
        </header>
        <div className="px-5 pt-3">
          <Tabs<Tab>
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'ticket', label: t('ticket.tabs.ticket') },
              { id: 'qa', label: t('ticket.tabs.qa'), badge: ticket.comments.length > 0 ? <Badge>{ticket.comments.length}</Badge> : undefined },
              { id: 'history', label: t('ticket.tabs.history') },
              { id: 'senior', label: t('ticket.tabs.senior', { name: senior }) },
            ]}
          />
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {(tab === 'ticket' || tab === 'senior') && failed && <ContentError onRetry={retry} />}
          {tab === 'ticket' && content && (
            <Markdown
              testId="ticket-markdown"
              fieldValue={(field, value) => {
                // The file is written when the ticket is created, so the status comes from the board instead.
                if (STATUS_FIELDS.has(field)) return <StagePill status={ticket.status} />;
                if (TYPE_FIELDS.has(field)) return <Badge tone={value.toLowerCase() === 'bug' ? 'danger' : 'neutral'}>{value}</Badge>;
                return undefined;
              }}
            >
              {content.ticketMarkdown}
            </Markdown>
          )}
          {tab === 'qa' && (
            <div className="space-y-3" data-testid="qa-comments">
              {qaRunning && (
                <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-base" data-testid="qa-running">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <Icon name="spinner" className="size-4 text-amber-500" />
                    {t('qa.running')}
                  </p>
                  {snapshot.busy === 'qa' && <LogView lines={snapshot.log} />}
                </div>
              )}
              {ticket.comments.length === 0 && !qaRunning && <p className="text-base text-muted-foreground">{t('ticket.noComments')}</p>}
              {[...ticket.comments].reverse().map((comment, index) => (
                <QaCommentView key={comment.id} comment={comment} defaultOpen={index === 0} />
              ))}
            </div>
          )}
          {tab === 'history' && <History ticket={ticket} snapshot={snapshot} />}
          {tab === 'senior' && !failed && <Conversation snapshot={snapshot} ticket={ticket} content={content} />}
        </div>
      </aside>
    </div>
  );
}
