import type { EnvironmentItemId, Snapshot } from '@shared/api.ts'
import { findTicket } from '@shared/kanban.ts'
import type { InboxMessage, Language, TicketState } from '@shared/types.ts'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api.ts'
import { Icon } from '../components/icons.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { ticketTitle } from '../components/ticketTitle.ts'
import { Button, LogView, StagePill } from '../components/ui.tsx'
import type { Story } from '../content.ts'
import { story } from '../content.ts'
import { useToast } from '../toast-context.ts'

/** Approximate download sizes, shown next to the environment items. */
const ENVIRONMENT_SIZES: Record<EnvironmentItemId, string> = {
  workspaceImage: '1.1 GB',
  qaImage: '3 GB',
  projectDependencies: '160 MB',
}

const locale = (language: Language) => (language === 'pt' ? 'pt-BR' : 'en-US')

function messageText(content: Story, message: InboxMessage) {
  if (message.kind === 'welcome') return content.messages.welcome
  if (message.kind === 'completion') return content.messages.completion
  return content.messages.assignments[
    String(message.ticket) as keyof Story['messages']['assignments']
  ]
}

/** The first paragraph of a message body, without markdown marks. */
function preview(body: string): string {
  return (
    body
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.replace(/[*_`#]/g, '') ?? ''
  )
}

function threadDate(at: string, language: Language): string {
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(locale(language), {
        hour: '2-digit',
        minute: '2-digit',
      })
    : date.toLocaleDateString(locale(language), {
        month: 'short',
        day: 'numeric',
      })
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function Panel({
  children,
  className = '',
  ...props
}: {
  children: ReactNode
  className?: string
  'data-testid'?: string
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-card p-4 text-base shadow-sm ${className}`}
      {...props}
    >
      {children}
    </section>
  )
}

function Tag({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'muted' | 'primary'
}) {
  const look =
    tone === 'primary'
      ? 'bg-primary/10 font-semibold text-primary'
      : 'bg-muted font-medium text-muted-foreground'
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-sm whitespace-nowrap ${look}`}
    >
      {children}
    </span>
  )
}

/** The colored box at the bottom of the open message, with the next thing to do. */
function Dock({
  tone,
  label,
  title,
  body,
  icon,
  aside,
  actions,
  children,
  ...props
}: {
  tone: 'primary' | 'neutral' | 'danger' | 'ok'
  label?: ReactNode
  title: ReactNode
  body?: ReactNode
  icon?: ReactNode
  aside?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  'data-testid'?: string
}) {
  const look = {
    primary: {
      box: 'border-primary/30 bg-primary/5',
      label: 'text-primary',
      rule: 'border-primary/20',
    },
    neutral: {
      box: 'border-border bg-card',
      label: 'text-muted-foreground',
      rule: 'border-border/60',
    },
    danger: {
      box: 'border-destructive/40 bg-destructive/5',
      label: 'text-destructive',
      rule: 'border-destructive/20',
    },
    ok: {
      box: 'border-emerald-500/30 bg-emerald-500/5',
      label: 'text-emerald-600 dark:text-emerald-400',
      rule: 'border-emerald-500/20',
    },
  }[tone]
  return (
    <div
      className={`mt-6 rounded-xl border p-4 ${look.box}`}
      data-testid="action-dock"
      {...props}
    >
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          {label && (
            <div
              className={`mb-0.5 flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wider uppercase ${look.label}`}
            >
              {label}
            </div>
          )}
          <h4 className="text-base font-bold text-foreground">{title}</h4>
          {body && (
            <p className="mt-0.5 text-base text-muted-foreground">{body}</p>
          )}
        </div>
        {aside}
      </div>
      {children}
      {actions && (
        <div
          className={`mt-3 flex flex-wrap items-center gap-2 border-t pt-3 ${look.rule}`}
        >
          {actions}
        </div>
      )}
    </div>
  )
}

function DockIcon({
  tone,
  children,
}: {
  tone: 'primary' | 'danger' | 'ok'
  children: ReactNode
}) {
  const look = {
    primary: 'bg-primary/10 text-primary',
    danger: 'bg-destructive/10 text-destructive',
    ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  }[tone]
  return <div className={`rounded-lg p-1.5 ${look}`}>{children}</div>
}

interface Actions {
  openBoard: () => void
  openTicket: (ticket: number) => void
  openReview: (ticket: number) => void
  nextAssignment: () => void
  run: (id: string, action: () => Promise<unknown>) => void
  busy: string | null
}

function WorkspaceButtons({
  snapshot,
  actions,
  compact = false,
}: {
  snapshot: Snapshot
  actions: Actions
  compact?: boolean
}) {
  const { t } = useTranslation()
  const dockerDown = snapshot.dockerState !== 'running'
  return (
    <>
      <Button
        size="sm"
        disabled={dockerDown}
        busy={actions.busy === 'vscode'}
        onClick={() => actions.run('vscode', () => api.openVSCode())}
      >
        {actions.busy !== 'vscode' && (
          <Icon
            name="code"
            className="size-3.5"
          />
        )}{' '}
        {compact ? t('dashboard.vscodeShort') : t('ticket.openVSCode')}
      </Button>
      <Button
        size="sm"
        disabled={dockerDown}
        busy={actions.busy === 'browser'}
        onClick={() => actions.run('browser', () => api.openAppInBrowser())}
      >
        {actions.busy !== 'browser' && (
          <Icon
            name="externalLink"
            className="size-3.5"
          />
        )}{' '}
        {compact ? t('dashboard.browserShort') : t('ticket.openBrowser')}
      </Button>
    </>
  )
}

function ActionDock({
  snapshot,
  message,
  active,
  actions,
}: {
  snapshot: Snapshot
  message: InboxMessage | undefined
  active: TicketState | undefined
  actions: Actions
}) {
  const { t } = useTranslation()
  const { state } = snapshot
  const language = state.settings.language
  const environment = snapshot.environment
  const installing = snapshot.busy === 'installing'
  const dockerDown = snapshot.dockerState !== 'running'
  const viewed =
    message?.kind === 'assignment' && message.ticket !== undefined
      ? findTicket(state, message.ticket)
      : undefined
  const allDone = state.inbox.some((item) => item.kind === 'completion')

  // Missing downloads block everything else, so they come first.
  if (environment && (!environment.ready || installing)) {
    return (
      <Dock
        tone="danger"
        data-testid="environment-panel"
        icon={
          <DockIcon tone="danger">
            {installing ? <Icon name="spinner" /> : <Icon name="download" />}
          </DockIcon>
        }
        label={t('dashboard.blockedLabel')}
        title={t('environment.title')}
        body={t('environment.intro')}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              busy={installing}
              disabled={snapshot.busy !== null && !installing}
              onClick={() =>
                actions.run('install', () => api.installEnvironment())
              }
              data-testid="install-environment"
            >
              {!installing && (
                <Icon
                  name="download"
                  className="size-3.5"
                />
              )}
              {installing
                ? t('environment.installing')
                : t('environment.install')}
            </Button>
          </>
        }
      >
        <ul className="mt-3 space-y-1.5">
          {environment.items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2 text-base"
              data-testid={`env-${item.id}`}
              data-ready={item.ready}
            >
              <span
                className={
                  item.ready
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : installing
                      ? 'text-amber-500'
                      : 'text-destructive'
                }
              >
                <Icon
                  name={
                    item.ready
                      ? 'check'
                      : installing
                        ? 'spinner'
                        : 'alertCircle'
                  }
                  className="size-3.5"
                />
              </span>
              <span className="text-foreground">
                {t(`environment.items.${item.id}`)}
              </span>
            </li>
          ))}
        </ul>
        {installing && snapshot.log.length > 0 && (
          <div className="mt-3">
            <LogView lines={snapshot.log} />
          </div>
        )}
      </Dock>
    )
  }

  if (snapshot.busy === 'unlocking') {
    return (
      <Dock
        tone="neutral"
        icon={
          <DockIcon tone="primary">
            <Icon name="spinner" />
          </DockIcon>
        }
        title={t('dashboard.unlocking')}
        body={t('dashboard.unlockingBody')}
      >
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-busy
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
        {snapshot.log.length > 0 && (
          <div className="mt-3">
            <LogView lines={snapshot.log} />
          </div>
        )}
      </Dock>
    )
  }

  // An older directive whose ticket is already done.
  if (viewed && viewed.status === 'done' && viewed.ticket !== active?.ticket) {
    const { key, text } = ticketTitle(snapshot, viewed.ticket, language)
    return (
      <Dock
        tone="ok"
        label={
          <>
            {t('dashboard.completedLabel')}
            <span className="flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold tracking-normal normal-case">
              <Icon
                name="checkCircle"
                className="size-3.5"
              />{' '}
              {t('dashboard.doneMerged', { key })}
            </span>
          </>
        }
        title={`${key}: ${text}`}
        body={t('dashboard.completedBody')}
        actions={
          <>
            {active ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => actions.openTicket(active.ticket)}
              >
                <Icon
                  name="arrowRight"
                  className="size-3.5"
                />
                {t('dashboard.returnToActive', {
                  key: ticketTitle(snapshot, active.ticket, language).key,
                })}
              </Button>
            ) : (
              snapshot.nextTicket !== null && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={dockerDown || snapshot.busy !== null}
                  onClick={actions.nextAssignment}
                >
                  <Icon
                    name="download"
                    className="size-3.5"
                  />
                  {t('dashboard.nextAssignment')}
                </Button>
              )
            )}
            <Button
              size="sm"
              onClick={() => actions.openTicket(viewed.ticket)}
            >
              <Icon
                name="board"
                className="size-3.5"
              />
              {t('dashboard.viewOnBoard', { key })}
            </Button>
          </>
        }
      />
    )
  }

  if (active) {
    const { key, text } = ticketTitle(snapshot, active.ticket, language)
    const primary = {
      todo: {
        icon: 'play',
        label: t('dashboard.startOnBoard'),
        onClick: () => actions.openTicket(active.ticket),
      },
      inProgress: {
        icon: 'board',
        label: t('dashboard.goToBoard'),
        onClick: () => actions.openTicket(active.ticket),
      },
      inQa: {
        icon: 'spinner',
        label: t('dashboard.viewQa'),
        onClick: () => actions.openTicket(active.ticket),
      },
      codeReview: {
        icon: 'checkCircle',
        label: t('dashboard.acceptReview'),
        onClick: () => actions.openReview(active.ticket),
      },
      done: {
        icon: 'board',
        label: t('dashboard.goToBoard'),
        onClick: actions.openBoard,
      },
    } as const
    const action = primary[active.status]
    return (
      <Dock
        tone="neutral"
        label={
          <>
            {t('dashboard.activeLabel')}{' '}
            <StagePill
              status={active.status}
              className="tracking-normal normal-case"
            />
          </>
        }
        title={`${key}: ${text}`}
        body={
          <>
            {dockerDown
              ? t('dashboard.dockerDownActive')
              : t('dashboard.finishFirst')}
          </>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={action.onClick}
            >
              <Icon
                name={action.icon}
                className="size-3.5"
              />
              {action.label}
            </Button>
            {active.status === 'inProgress' && (
              <WorkspaceButtons
                snapshot={snapshot}
                actions={actions}
              />
            )}
          </>
        }
      />
    )
  }

  if (snapshot.nextTicket !== null) {
    if (dockerDown) {
      return (
        <Dock
          tone="danger"
          icon={
            <DockIcon tone="danger">
              <Icon name="alertTriangle" />
            </DockIcon>
          }
          label={t('dashboard.blockedLabel')}
          title={t('dashboard.blockedDockerTitle')}
          body={t('dashboard.blockedDockerBody')}
          actions={
            snapshot.dockerState !== 'notInstalled' && (
              <Button
                size="sm"
                variant="primary"
                busy={
                  snapshot.busy === 'startingDocker' ||
                  snapshot.dockerState === 'starting'
                }
                onClick={() => actions.run('docker', () => api.startDocker())}
              >
                <Icon
                  name="play"
                  className="size-3.5"
                />
                {t('banner.startDocker')}
              </Button>
            )
          }
        />
      )
    }
    return (
      <Dock
        tone="primary"
        label={t('dashboard.nextLabel')}
        title={t('dashboard.nextTitle')}
        body={t('dashboard.nextBody')}
        aside={
          <Button
            size="sm"
            variant="primary"
            className="shrink-0 self-center"
            disabled={snapshot.busy !== null}
            onClick={actions.nextAssignment}
          >
            <Icon
              name="download"
              className="size-3.5"
            />
            {t('dashboard.nextAssignment')}
          </Button>
        }
      />
    )
  }

  if (allDone) {
    return (
      <Dock
        tone="ok"
        icon={
          <DockIcon tone="ok">
            <Icon name="checkCircle" />
          </DockIcon>
        }
        label={t('dashboard.allDoneLabel')}
        title={t('dashboard.allDone')}
        body={t('dashboard.allDoneBody')}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={actions.openBoard}
            >
              <Icon
                name="board"
                className="size-3.5"
              />
              {t('dashboard.goToBoard')}
            </Button>
            <Button
              size="sm"
              disabled={dockerDown}
              busy={actions.busy === 'vscode'}
              onClick={() => actions.run('vscode', () => api.openVSCode())}
            >
              <Icon
                name="code"
                className="size-3.5"
              />
              {t('ticket.openVSCode')}
            </Button>
          </>
        }
      />
    )
  }
  return null
}

function MessageView({
  snapshot,
  message,
  active,
  actions,
}: {
  snapshot: Snapshot
  message: InboxMessage | undefined
  active: TicketState | undefined
  actions: Actions
}) {
  const { t } = useTranslation()
  const language = snapshot.state.settings.language
  const content = story(language)
  const manager = content.people.manager
  const text = message ? messageText(content, message) : undefined
  const viewed =
    message?.kind === 'assignment' && message.ticket !== undefined
      ? findTicket(snapshot.state, message.ticket)
      : undefined
  const previous =
    viewed && viewed.status === 'done' && viewed.ticket !== active?.ticket
  const viewedKey = viewed
    ? ticketTitle(snapshot, viewed.ticket, language).key
    : ''
  const activeKey = active
    ? ticketTitle(snapshot, active.ticket, language).key
    : ''
  const messageId =
    message?.kind === 'assignment'
      ? `msg-${viewedKey.toLowerCase().replace(/[^a-z0-9]/g, '')}`
      : `msg-${message?.kind ?? ''}`

  return (
    <article
      className="rounded-xl border border-border bg-card p-6 shadow-sm lg:col-span-6"
      data-testid="message"
    >
      {message && text && (
        <>
          <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/15 text-base font-bold text-primary">
                {initials(manager.name)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-foreground">
                    {manager.name}
                  </h2>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-muted-foreground">
                    &lt;{manager.email}&gt;
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {manager.role} ·{' '}
                  {new Date(message.at).toLocaleString(locale(language), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
            </div>
            <span className="shrink-0 font-mono text-sm text-muted-foreground">
              {t('dashboard.messageId')}: {messageId}
            </span>
          </header>

          {previous && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-base">
              <div className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full bg-emerald-500"
                  aria-hidden
                />
                <span className="text-foreground">
                  {active
                    ? t('dashboard.previousDirective', {
                        key: viewedKey,
                        active: activeKey,
                      })
                    : t('dashboard.previousDirectiveNoActive', {
                        key: viewedKey,
                      })}
                </span>
              </div>
              {active && (
                <span className="shrink-0 rounded border border-primary/30 bg-background px-2 py-0.5 font-mono text-sm font-bold text-primary">
                  {t('dashboard.activeChip', { key: activeKey })}
                </span>
              )}
            </div>
          )}

          <h1 className="mb-4 text-xl font-bold tracking-tight text-foreground">
            {text.subject}
          </h1>
          <Markdown
            testId="inbox-body"
            className="text-base"
          >
            {text.body}
          </Markdown>
        </>
      )}
      <ActionDock
        snapshot={snapshot}
        message={message}
        active={active}
        actions={actions}
      />
    </article>
  )
}

function AssignmentCard({
  snapshot,
  active,
  actions,
}: {
  snapshot: Snapshot
  active: TicketState | undefined
  actions: Actions
}) {
  const { t } = useTranslation()
  const { state } = snapshot
  const language = state.settings.language
  const unlocking = snapshot.busy === 'unlocking'
  const dockerDown = snapshot.dockerState !== 'running'
  const needsEnvironment =
    snapshot.environment !== null &&
    !snapshot.environment.items.find((item) => item.id === 'workspaceImage')
      ?.ready
  const allDone = state.inbox.some((item) => item.kind === 'completion')

  const heading = (aside: ReactNode) => (
    <div className="mb-2 flex items-center justify-between gap-2 border-b border-border/60 pb-2">
      <h3 className="text-xs font-bold tracking-wider text-foreground uppercase">
        {t('dashboard.current')}
      </h3>
      {aside}
    </div>
  )

  if (active) {
    const { key, text } = ticketTitle(snapshot, active.ticket, language)
    return (
      <Panel data-testid="assignment-card">
        {heading(
          <StagePill
            status={active.status}
            className="text-sm"
          />,
        )}
        <div className="space-y-1.5">
          <span className="block font-mono text-base font-bold text-primary">
            {key}
          </span>
          <p className="text-lg leading-snug font-semibold text-foreground">
            {text}
          </p>
          <div className="space-y-0.5 pt-1 text-base text-muted-foreground">
            <div>
              {t('dashboard.client')}:{' '}
              <span className="font-medium text-foreground">
                {story(language).client.name}
              </span>
            </div>
          </div>
        </div>
        <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2.5">
          <Button
            size="sm"
            variant="primary"
            className="w-full"
            onClick={() => actions.openTicket(active.ticket)}
          >
            <Icon
              name="board"
              className="size-3.5"
            />
            {t('dashboard.goToBoard')}
          </Button>
          <div className="grid grid-cols-2 gap-1.5">
            <WorkspaceButtons
              snapshot={snapshot}
              actions={actions}
              compact
            />
          </div>
        </div>
      </Panel>
    )
  }

  if (snapshot.nextTicket !== null) {
    return (
      <Panel data-testid="assignment-card">
        {heading(<Tag>{t('dashboard.queued')}</Tag>)}
        <p className="rounded-lg border border-primary/20 bg-primary/5 p-3 leading-snug font-medium text-foreground">
          {t('dashboard.queuedBody')}
        </p>
        <div className="mt-3 border-t border-border/60 pt-2.5">
          <Button
            size="sm"
            variant="primary"
            className="w-full"
            busy={unlocking}
            disabled={
              dockerDown ||
              needsEnvironment ||
              (snapshot.busy !== null && !unlocking)
            }
            onClick={actions.nextAssignment}
            data-testid="next-assignment"
          >
            {!unlocking && (
              <Icon
                name="download"
                className="size-3.5"
              />
            )}
            {unlocking
              ? t('dashboard.unlocking')
              : t('dashboard.nextAssignment')}
          </Button>
        </div>
      </Panel>
    )
  }

  return (
    <Panel data-testid="assignment-card">
      {heading(allDone && <Tag>{t('dashboard.completed')}</Tag>)}
      <p className="text-muted-foreground">
        {allDone ? t('dashboard.allDone') : t('dashboard.noTicket')}
      </p>
    </Panel>
  )
}

function ContactsCard({ language }: { language: Language }) {
  const { t } = useTranslation()
  const content = story(language)
  const senior = content.people.senior
  return (
    <Panel>
      <h3 className="mb-2.5 text-xs font-bold tracking-wider text-foreground uppercase">
        {t('dashboard.contacts')}
      </h3>
      <ul className="divide-y divide-border/40">
        {content.client.reporters.map((person) => (
          <li
            key={person.name}
            className="py-2 first:pt-0"
          >
            <span className="block font-semibold text-foreground">
              {person.name}
            </span>
            <span className="block text-base text-muted-foreground">
              {person.role} · {content.client.name}
            </span>
          </li>
        ))}
        <li className="pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-primary">{senior.name}</span>
            <Tag tone="primary">{t('dashboard.mentorTag')}</Tag>
          </div>
          <span className="block text-base text-muted-foreground">
            {senior.role} · {content.company.name}
          </span>
        </li>
      </ul>
    </Panel>
  )
}

function EnvironmentCard({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation()
  const installing = snapshot.busy === 'installing'
  const docker =
    snapshot.busy === 'startingDocker' ? 'starting' : snapshot.dockerState
  const status = (look: 'ok' | 'pending' | 'bad', label: string) => {
    const style = {
      ok: 'text-emerald-600 dark:text-emerald-400',
      pending: 'text-amber-500',
      bad: 'text-destructive',
    }[look]
    const icon = (
      { ok: 'check', pending: 'spinner', bad: 'alertCircle' } as const
    )[look]
    return (
      <span
        className={`flex items-center gap-1 font-semibold whitespace-nowrap ${style}`}
      >
        <Icon
          name={icon}
          className="size-3.5"
        />{' '}
        {label}
      </span>
    )
  }
  return (
    <Panel data-testid="environment-card">
      <h3 className="mb-2.5 text-xs font-bold tracking-wider text-foreground uppercase">
        {t('dashboard.environment')}
      </h3>
      <dl className="space-y-2">
        {docker && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t('dashboard.env.docker')}
            </dt>
            <dd>
              {status(
                docker === 'running'
                  ? 'ok'
                  : docker === 'starting'
                    ? 'pending'
                    : 'bad',
                t(`dashboard.envStatus.${docker}`),
              )}
            </dd>
          </div>
        )}
        {snapshot.environment?.items.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-2"
          >
            <dt className="text-muted-foreground">
              {t(`dashboard.env.${item.id}`)}
            </dt>
            <dd>
              {item.ready
                ? status(
                    'ok',
                    `${t('dashboard.envStatus.ready')} (${ENVIRONMENT_SIZES[item.id]})`,
                  )
                : installing
                  ? status('pending', t('dashboard.envStatus.installing'))
                  : status('bad', t('dashboard.envStatus.missing'))}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

export function Dashboard({
  snapshot,
  onOpenBoard,
  onOpenTicket,
  onOpenReview,
}: {
  snapshot: Snapshot
  onOpenBoard: () => void
  onOpenTicket: (ticket: number) => void
  onOpenReview: (ticket: number) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const { state } = snapshot
  const language = state.settings.language
  const content = story(language)
  const threads = [...state.inbox].reverse()
  const [selectedId, setSelectedId] = useState<string | null>(
    threads[0]?.id ?? null,
  )
  const [busy, setBusy] = useState<string | null>(null)

  // A new message (a new assignment, the completion) opens on arrival (adjusted during render).
  const [seenCount, setSeenCount] = useState(state.inbox.length)
  if (state.inbox.length !== seenCount) {
    setSeenCount(state.inbox.length)
    setSelectedId(threads[0]?.id ?? null)
  }
  const selected =
    threads.find((message) => message.id === selectedId) ?? threads[0]
  const current =
    state.currentTicket !== null
      ? findTicket(state, state.currentTicket)
      : undefined
  const active = current && current.status !== 'done' ? current : undefined

  const select = (message: InboxMessage) => {
    setSelectedId(message.id)
    if (!message.read) {
      void api.markInboxRead(message.id)
    }
  }

  const run = (id: string, action: () => Promise<unknown>) => {
    setBusy(id)
    action()
      .catch(toast.error)
      .finally(() => setBusy(null))
  }

  const actions: Actions = {
    openBoard: onOpenBoard,
    openTicket: onOpenTicket,
    openReview: onOpenReview,
    nextAssignment: () =>
      void api.nextAssignment().then(onOpenBoard).catch(toast.error),
    run,
    busy,
  }

  return (
    <div
      className="mx-auto grid max-w-7xl grid-cols-1 items-start gap-6 px-6 py-6 lg:grid-cols-12"
      data-testid="dashboard"
    >
      <div className="space-y-3 lg:col-span-3">
        <Panel className="p-3">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-border/70 pb-2">
            <h3 className="text-xs font-bold tracking-wider text-foreground uppercase">
              {t('dashboard.inbox')}
            </h3>
            <span className="text-sm font-medium whitespace-nowrap text-muted-foreground">
              {t('dashboard.inboxCount', { count: threads.length })}
            </span>
          </div>
          <ul
            className="space-y-1.5"
            data-testid="inbox"
          >
            {threads.map((message) => {
              const text = messageText(content, message)
              const isOpen = message.id === selected?.id
              return (
                <li
                  key={message.id}
                  data-testid="inbox-message"
                  data-kind={message.kind}
                >
                  <button
                    type="button"
                    onClick={() => select(message)}
                    aria-current={isOpen ? 'true' : undefined}
                    className={`w-full rounded-lg border p-2.5 text-left transition-all ${
                      isOpen
                        ? 'border-primary/40 bg-primary/5 shadow-xs'
                        : 'border-transparent hover:bg-muted/40'
                    }`}
                  >
                    <span className="mb-1 flex items-center justify-between gap-1">
                      <span
                        className={`truncate text-base ${message.read ? 'font-semibold text-foreground' : 'font-bold text-primary'}`}
                      >
                        {content.people.manager.name}
                      </span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {threadDate(message.at, language)}
                      </span>
                    </span>
                    <span className="mb-1 flex items-center gap-1.5">
                      {!message.read && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                          title={t('dashboard.unread')}
                        />
                      )}
                      <span className="truncate text-base font-semibold text-foreground">
                        {text.subject}
                      </span>
                    </span>
                    <span className="block truncate text-base text-muted-foreground">
                      {preview(text.body)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Panel>

        <Panel className="p-3.5">
          <span className="mb-1 block text-lg font-bold tracking-tight text-foreground">
            {content.company.name}
          </span>
          <p className="text-base leading-relaxed text-muted-foreground">
            {content.company.summary}
          </p>
        </Panel>

        <Panel className="space-y-2 p-3.5">
          <div className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full bg-emerald-500"
              aria-hidden
            />
            <span className="text-lg font-bold tracking-tight text-foreground">
              {content.client.name}
            </span>
            <Tag>{t('dashboard.clientTag')}</Tag>
          </div>
          <p className="text-base leading-relaxed text-muted-foreground">
            {content.client.about}
          </p>
          <p className="border-t border-border/50 pt-2 text-base text-muted-foreground">
            <span className="font-semibold text-foreground">
              {content.project.name}:
            </span>{' '}
            {content.project.stack}
          </p>
        </Panel>
      </div>

      <MessageView
        snapshot={snapshot}
        message={selected}
        active={active}
        actions={actions}
      />

      <div className="space-y-4 lg:col-span-3">
        <AssignmentCard
          snapshot={snapshot}
          active={active}
          actions={actions}
        />
        <ContactsCard language={language} />
        <EnvironmentCard snapshot={snapshot} />
      </div>
    </div>
  )
}
