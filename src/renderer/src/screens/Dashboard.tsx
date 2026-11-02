import type { Snapshot } from '@shared/api.ts'
import { blocksVSCode } from '@shared/api.ts'
import { findTicket } from '@shared/kanban.ts'
import type { GameState, InboxMessage, Language, TicketState, TrackChoice } from '@shared/types.ts'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api } from '../api.ts'
import { Icon } from '../components/icons.tsx'
import type { IconName } from '../components/icons.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { ticketTitle } from '../components/ticketTitle.ts'
import { Badge, Button, LogView, Notice, Spinner, StagePill, Tooltip } from '../components/ui.tsx'
import type { Story } from '../content.ts'
import { story } from '../content.ts'
import { NextAssignmentMenu } from '../components/NextAssignmentMenu.tsx'
import { useToast } from '../toast-context.ts'
import { deskState, environmentRows, environmentSummary, inboxMessageText } from './dashboardState.ts'
import type { DeskState, Tone } from './dashboardState.ts'

const locale = (language: Language) => (language === 'pt' ? 'pt-BR' : 'en-US')

function messageText(content: Story, message: InboxMessage, t: TFunction, state: GameState) {
  const idOf = (ticket: number) => state.tickets.find((item) => item.ticket === ticket)?.id
  return inboxMessageText(content.messages, message, {
    subject: t('dashboard.genericAssignmentSubject'),
    body: t('dashboard.genericAssignmentBody'),
  }, idOf)
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

function Tag({
  children,
  tone = 'muted',
  size = 'sm',
}: {
  children: ReactNode
  tone?: 'muted' | 'primary'
  size?: 'xs' | 'sm'
}) {
  const look =
    tone === 'primary'
      ? 'bg-primary/10 font-semibold text-primary'
      : 'bg-muted font-medium text-muted-foreground'
  return (
    <span
      className={`rounded px-1.5 py-0.5 whitespace-nowrap ${size === 'xs' ? 'text-xs' : 'text-sm'} ${look}`}
    >
      {children}
    </span>
  )
}

/** A section label of the desk and the drawer: 14px icon and a 12px uppercase title, with something on the right. */
function SectionLabel({
  icon,
  children,
  aside,
  tone,
}: {
  icon: IconName
  children: ReactNode
  aside?: ReactNode
  /** Title and icon in green (all fine) or red (a problem) for Local environment; primary for Current task. */
  tone?: 'ok' | 'danger' | 'primary'
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <h3
        className={`flex min-w-0 items-center gap-1.5 text-xs font-bold tracking-wider uppercase ${tone === 'danger' ? 'text-destructive' : tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'primary' ? 'text-primary' : 'text-foreground'}`}
      >
        <Icon
          name={icon}
          className={`size-3.5 ${tone ? '' : 'text-muted-foreground'}`}
        />
        <span
          className="truncate"
          title={typeof children === 'string' ? children : undefined}
        >
          {children}
        </span>
      </h3>
      {aside && <span className="shrink-0 whitespace-nowrap">{aside}</span>}
    </div>
  )
}

/** The 32px icon tile of the inbox and drawer headers. */
function IconTile({ icon }: { icon: 'inbox' | 'users' }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
      <Icon
        name={icon}
        className="size-[18px]"
      />
    </span>
  )
}

interface Actions {
  openBoard: () => void
  openTicket: (ticket: number) => void
  openReview: (ticket: number) => void
  nextAssignment: (track: TrackChoice) => void
  run: (id: string, action: () => Promise<unknown>) => void
  busy: string | null
}

/** VS Code and browser buttons with short labels, so they fit side by side; the full label is the tooltip. */
function WorkspaceButtons({
  snapshot,
  actions,
}: {
  snapshot: Snapshot
  actions: Actions
}) {
  const { t } = useTranslation()
  const dockerDown = snapshot.dockerState !== 'running'
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        size="sm"
        variant="card"
        disabled={dockerDown || blocksVSCode(snapshot.busy)}
        busy={actions.busy === 'vscode'}
        title={t('ticket.openVSCode')}
        onClick={() => actions.run('vscode', () => api.openVSCode())}
        data-testid="desk-vscode"
      >
        {actions.busy !== 'vscode' && (
          <Icon
            name="code"
            className="size-3.5"
          />
        )}
        {t('dashboard.vscodeShort')}
      </Button>
      <Button
        size="sm"
        variant="card"
        disabled={dockerDown}
        busy={actions.busy === 'browser'}
        title={t('ticket.openBrowser')}
        onClick={() => actions.run('browser', () => api.openAppInBrowser())}
        data-testid="desk-browser"
      >
        {actions.busy !== 'browser' && (
          <Icon
            name="externalLink"
            className="size-3.5"
          />
        )}
        {t('dashboard.browserShort')}
      </Button>
    </div>
  )
}

/** A sentence of the desk that says what to do next. */
function DeskSentence({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
}

/**
 * Current task: what the player works on and the one next action, for every game state. The
 * order matters: missing downloads block everything, then an unlock in progress, then the active
 * ticket, the queued next one (or Docker to start first), the end of the sprint.
 */
function CurrentTask({
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
  const environment = snapshot.environment
  const installing = snapshot.busy === 'installing'
  const dockerDown = snapshot.dockerState !== 'running'
  const needsEnvironment =
    environment !== null &&
    !environment.items.find((item) => item.id === 'workspaceImage')?.ready
  const desk = deskState(snapshot, active)

  const section = (state: DeskState, aside: ReactNode, children: ReactNode, testId = 'assignment-card') => (
    // A full-bleed block on top of the desk: a card surface mixed with 22% primary.
    <section
      className="flex shrink-0 flex-col gap-3 border-b border-primary/25 bg-[color-mix(in_oklab,var(--primary)_22%,var(--card))] px-5 pt-6 pb-7"
      data-testid={testId}
      data-state={state}
      data-tour="current-task"
    >
      <SectionLabel
        icon="clipboardList"
        aside={aside}
        tone="primary"
      >
        {t('dashboard.current')}
      </SectionLabel>
      {children}
    </section>
  )

  if (desk === 'download') {
    return section(
      'download',
      null,
      <>
        <DeskSentence>{t('dashboard.downloadFirst')}</DeskSentence>
        <Button
          size="sm"
          variant="primary"
          className="mt-2 w-full"
          busy={installing}
          disabled={snapshot.busy !== null && !installing}
          onClick={() => actions.run('install', () => api.installEnvironment())}
          data-testid="install-environment"
        >
          {!installing && (
            <Icon
              name="download"
              className="size-3.5"
            />
          )}
          {installing ? t('dashboard.envStatus.installing') : t('environment.install')}
        </Button>
        {installing && snapshot.log.length > 0 && <LogView lines={snapshot.log} />}
      </>,
      'environment-panel',
    )
  }

  if (desk === 'unlocking') {
    return section(
      'unlocking',
      null,
      <>
        <DeskSentence>{t('dashboard.unlocking')}</DeskSentence>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-busy
          aria-label={t('dashboard.unlocking')}
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
        {snapshot.log.length > 0 && <LogView lines={snapshot.log} />}
      </>,
    )
  }

  if (desk === 'active' && active) {
    const { key, text } = ticketTitle(snapshot, active.ticket, language)
    const primary = {
      todo: { icon: 'play', label: t('dashboard.startOnBoard'), onClick: () => actions.openTicket(active.ticket) },
      inProgress: { icon: 'board', label: t('dashboard.goToBoard'), onClick: () => actions.openTicket(active.ticket) },
      inQa: { icon: 'spinner', label: t('dashboard.viewQa'), onClick: () => actions.openTicket(active.ticket) },
      codeReview: { icon: 'checkCircle', label: t('dashboard.acceptReview'), onClick: () => actions.openReview(active.ticket) },
      done: { icon: 'board', label: t('dashboard.goToBoard'), onClick: actions.openBoard },
    } as const
    const action = primary[active.status]
    return section(
      'active',
      <StagePill
        status={active.status}
        dot={active.status === 'todo'}
      />,
      <>
        <div className="min-w-0 space-y-2">
          <span className="block font-mono text-sm font-medium text-primary">{key}</span>
          <p className="text-base leading-snug font-semibold text-foreground">{text}</p>
        </div>
        <Button
          size="sm"
          variant="primary"
          className="mt-2 w-full"
          onClick={action.onClick}
          data-testid="desk-primary"
        >
          <Icon
            name={action.icon}
            className="size-3.5"
          />
          <span className="truncate">{action.label}</span>
        </Button>
        <WorkspaceButtons
          snapshot={snapshot}
          actions={actions}
        />
        {dockerDown && <p className="text-xs text-muted-foreground">{t('dashboard.dockerDownActive')}</p>}
      </>,
    )
  }

  if (desk === 'dockerDown') {
    return section(
      'dockerDown',
      <Badge tone="danger">{t('dashboard.envStatus.notRunning')}</Badge>,
      <>
        <DeskSentence>{t('dashboard.blockedDockerBody')}</DeskSentence>
        {snapshot.dockerState !== 'notInstalled' && (
          <Button
            size="sm"
            variant="primary"
            className="mt-2 w-full"
            busy={snapshot.busy === 'startingDocker' || snapshot.dockerState === 'starting'}
            onClick={() => actions.run('docker', () => api.startDocker())}
            data-testid="desk-start-docker"
          >
            <Icon
              name="play"
              className="size-3.5"
            />
            {t('banner.startDocker')}
          </Button>
        )}
      </>,
    )
  }

  if (desk === 'queued') {
    return section(
      'queued',
      <Tag>{t('dashboard.queued')}</Tag>,
      <>
        <DeskSentence>{t('dashboard.queuedBody')}</DeskSentence>
        <NextAssignmentMenu
          snapshot={snapshot}
          className="mt-2 w-full"
          disabled={needsEnvironment || snapshot.busy !== null}
          onChoose={actions.nextAssignment}
          testId="next-assignment"
        />
      </>,
    )
  }

  if (desk === 'allDone') {
    return section(
      'allDone',
      <Tag>{t('dashboard.completed')}</Tag>,
      <>
        <DeskSentence>
          {t('dashboard.allDone')} {t('dashboard.allDoneBody')}
        </DeskSentence>
        <Button
          size="sm"
          variant="primary"
          className="mt-2 w-full"
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
          className="w-full"
          disabled={dockerDown || blocksVSCode(snapshot.busy)}
          busy={actions.busy === 'vscode'}
          onClick={() => actions.run('vscode', () => api.openVSCode())}
        >
          {actions.busy !== 'vscode' && (
            <Icon
              name="code"
              className="size-3.5"
            />
          )}
          {t('ticket.openVSCode')}
        </Button>
      </>,
    )
  }

  return section('none', null, <DeskSentence>{t('dashboard.noTicket')}</DeskSentence>)
}

const TONE_STYLES: Record<Tone, { circle: string; text: string }> = {
  ok: { circle: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
  warn: { circle: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', text: 'text-amber-600 dark:text-amber-400' },
  danger: { circle: 'bg-destructive/10 text-destructive', text: 'text-destructive' },
  neutral: { circle: 'bg-muted text-muted-foreground', text: 'text-muted-foreground' },
}

/**
 * The SupportDesk dev server (npm run dev in the workspace), with a button to start or stop it.
 * Asked only once a ticket exists: before that the workspace has no code to run. Polled, so a
 * server started or stopped in the VS Code terminal shows up too.
 */
function DevServerRow({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation()
  const toast = useToast()
  const dockerUp = snapshot.dockerState === 'running'
  const [up, setUp] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!dockerUp) {
      return undefined
    }
    let ignore = false
    const check = () =>
      void api
        .workspaceStatus()
        .then((status) => !ignore && setUp(status.devServerUp))
        .catch(() => !ignore && setUp(null))
    check()
    const timer = setInterval(check, 5000)
    return () => {
      ignore = true
      clearInterval(timer)
    }
  }, [dockerUp])

  const toggle = async () => {
    setBusy(true)
    try {
      await (up ? api.stopDevServer() : api.startDevServer())
      setUp((await api.workspaceStatus()).devServerUp)
    } catch (error) {
      toast.error(error)
    } finally {
      setBusy(false)
    }
  }

  // Running in green, stopped in amber (worth a look, not an error); unknown in neutral.
  const tone: Tone = !dockerUp || up === null ? 'neutral' : up ? 'ok' : 'warn'
  const status = !dockerUp
    ? t('dashboard.envStatus.needsDocker')
    : up === null
      ? t('dashboard.envStatus.checking')
      : up
        ? t('dashboard.envStatus.running')
        : t('dashboard.envStatus.notRunning')
  const label = up ? t('dashboard.stopServer') : t('dashboard.startServer')
  return (
    <li
      className="flex min-w-0 items-center gap-2.5"
      data-testid="env-devServer"
      data-tone={tone}
      data-up={up === null ? undefined : String(up)}
    >
      <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${TONE_STYLES[tone].circle}`}>
        <Icon
          name="laptop"
          className="size-[13px]"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{t('dashboard.env.devServer')}</span>
        <span className={`block truncate text-xs font-medium ${TONE_STYLES[tone].text}`}>{status}</span>
      </span>
      {dockerUp && up !== null && (
        <Tooltip
          content={label}
          hoverOnly
          className="shrink-0 self-stretch"
          panelClassName="right-0 w-max"
        >
          {/* As tall as the name and status lines, and square: play in emerald, pause in amber. */}
          <button
            type="button"
            className={`inline-flex aspect-square h-full items-center justify-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
              up
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400'
            }`}
            disabled={busy}
            onClick={() => void toggle()}
            aria-label={label}
            data-testid={up ? 'desk-stop-server' : 'desk-start-server'}
          >
            {busy ? (
              <Spinner className="size-3.5" />
            ) : (
              <Icon
                name={up ? 'pause' : 'play'}
                className="size-3.5"
              />
            )}
          </button>
        </Tooltip>
      )}
    </li>
  )
}

/** Local environment, always expanded: four rows and a summary badge of their worst state. */
function LocalEnvironment({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation()
  const docker = snapshot.busy === 'startingDocker' ? 'starting' : snapshot.dockerState
  // The report is only made after an unlock or a restore: ask for it as soon as Docker runs.
  const unchecked = docker === 'running' && snapshot.environment === null
  useEffect(() => {
    if (unchecked) {
      void api.refreshEnvironment().catch(() => {})
    }
  }, [unchecked])
  const rows = environmentRows(snapshot, t)
  const tone = environmentSummary(rows)
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="environment-card"
      data-tone={tone}
    >
      <SectionLabel
        icon="hardDrive"
        tone={tone === 'warn' ? undefined : tone}
      >
        {t('dashboard.environment')}
      </SectionLabel>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex min-w-0 items-center gap-2.5"
            data-testid={`env-${row.id}`}
            data-tone={row.tone}
          >
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${TONE_STYLES[row.tone].circle}`}>
              <Icon
                name={row.busy ? 'spinner' : row.icon}
                className="size-[13px]"
              />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground">{row.name}</span>
              <span className={`block truncate text-xs font-medium ${TONE_STYLES[row.tone].text}`}>{row.status}</span>
            </span>
          </li>
        ))}
        {snapshot.state.tickets.length > 0 && <DevServerRow snapshot={snapshot} />}
      </ul>
    </section>
  )
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
  const content = story(language, snapshot.projectStory)
  const manager = content.people.manager
  const text = message ? messageText(content, message, t, snapshot.state) : undefined
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
  return (
    <article
      className="min-h-0 min-w-0 overflow-y-auto"
      data-testid="message"
    >
      {message && text && (
        <>
          <header className="flex flex-col gap-[18px] border-b border-border px-8 pt-6 pb-5">
            <h1 className="min-w-0 text-2xl font-bold tracking-tight text-foreground">
              {text.subject}
            </h1>
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/15 text-base font-bold text-primary">
                  {initials(manager.name)}
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-foreground">{manager.name}</span>
                    <span className="truncate font-mono text-[13px] text-muted-foreground">
                      &lt;{manager.email}&gt;
                    </span>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {manager.role}
                  </p>
                </div>
              </div>
              <span className="shrink-0 text-sm text-muted-foreground">
                {new Date(message.at).toLocaleString(locale(language), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </div>
          </header>

          <div className="max-w-[720px] px-8 pt-6 pb-8">
            {previous && (
              <div
                className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm"
                data-testid="previous-directive"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-full bg-emerald-500"
                    aria-hidden
                  />
                  <span className="text-foreground">
                    {active
                      ? t('dashboard.previousDirective', { key: viewedKey, active: activeKey })
                      : t('dashboard.previousDirectiveNoActive', { key: viewedKey })}
                  </span>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => actions.openTicket(viewed.ticket)}
                  data-testid="view-done-ticket"
                >
                  <Icon
                    name="board"
                    className="size-3.5"
                  />
                  {t('dashboard.viewOnBoard', { key: viewedKey })}
                </Button>
              </div>
            )}
            <Markdown
              testId="inbox-body"
              className="text-base"
            >
              {text.body}
            </Markdown>
            {deskState(snapshot, active) === 'queued' && (
              // The same next step as the desk, at the end of the e-mail.
              <div
                className="mt-6 flex items-center gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4"
                data-testid="email-next"
              >
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-xs font-semibold tracking-wider text-primary uppercase">{t('dashboard.nextLabel')}</p>
                  <h4 className="text-base font-bold text-foreground">{t('dashboard.nextTitle')}</h4>
                  <p className="mt-0.5 text-base text-muted-foreground">{t('dashboard.nextBody')}</p>
                </div>
                <NextAssignmentMenu
                  snapshot={snapshot}
                  className="shrink-0"
                  disabled={snapshot.busy !== null}
                  onChoose={actions.nextAssignment}
                  testId="email-next-assignment"
                />
              </div>
            )}
          </div>
        </>
      )}
    </article>
  )
}

/** The drawer with the project context and the contacts; it covers the reading pane. */
function ProjectDrawer({
  language,
  projectStory,
  onClose,
}: {
  language: Language
  projectStory: Snapshot['projectStory']
  onClose: () => void
}) {
  const { t } = useTranslation()
  const content = story(language, projectStory)
  const senior = content.people.senior
  const closeButton = useRef<HTMLButtonElement>(null)
  // The latest onClose, so the effect below runs once per opening, not on every snapshot.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  // Focus moves into the drawer when it opens; Escape closes it.
  useEffect(() => {
    closeButton.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close.current()
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [])

  const organization = (name: string, tag: ReactNode, description: string, extra?: ReactNode) => (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-semibold text-foreground">{name}</span>
        {tag}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      {extra}
    </div>
  )

  const contact = (name: string, line: string, own: boolean, badge?: ReactNode) => (
    <li
      key={name}
      className="flex min-w-0 items-center gap-3"
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          own ? 'border border-primary/20 bg-primary/15 text-primary' : 'bg-secondary text-secondary-foreground'
        }`}
        aria-hidden
      >
        {initials(name)}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{name}</span>
          {badge}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{line}</span>
      </span>
    </li>
  )

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 starting:opacity-0"
        onClick={onClose}
        aria-hidden
        data-testid="project-drawer-backdrop"
      />
      <div
        id="project-drawer"
        role="dialog"
        aria-labelledby="project-drawer-title"
        className="fixed inset-y-0 right-0 z-50 flex w-[400px] max-w-full flex-col border-l border-border bg-background shadow-2xl transition-[opacity,translate] duration-150 starting:translate-x-4 starting:opacity-0"
        data-testid="project-drawer"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <IconTile icon="users" />
          <h2
            id="project-drawer-title"
            className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight text-foreground"
          >
            {t('dashboard.projectAndContacts')}
          </h2>
          <Button
            ref={closeButton}
            size="sm"
            variant="ghost"
            onClick={onClose}
            aria-label={t('dashboard.close')}
            title={t('dashboard.close')}
            data-testid="project-drawer-close"
          >
            <Icon
              name="x"
              className="size-4"
            />
          </Button>
        </div>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5">
          <section
            className="flex flex-col gap-4"
            data-testid="project-context"
          >
            <SectionLabel icon="briefcase">{t('dashboard.projectContext')}</SectionLabel>
            {organization(content.company.name, <Tag tone="primary" size="xs">{t('dashboard.companyTag')}</Tag>, content.company.summary)}
            {organization(
              content.client.name,
              <Tag size="xs">{t('dashboard.clientTag')}</Tag>,
              content.client.about,
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{content.project.name}:</span> {content.project.stack}
              </p>,
            )}
          </section>
          <div className="h-px shrink-0 bg-border" />
          <section
            className="flex flex-col gap-3"
            data-testid="contacts-card"
          >
            <SectionLabel icon="contact">{t('dashboard.contacts')}</SectionLabel>
            <ul className="flex flex-col gap-3">
              {contact(senior.name, `${senior.role} · ${content.company.name}`, true, <Tag tone="primary" size="xs">{t('dashboard.mentorTag')}</Tag>)}
              {contact(content.people.manager.name, `${content.people.manager.role} · ${content.company.name}`, true)}
              {content.client.reporters.map((person) => contact(person.name, `${person.role} · ${content.client.name}`, false))}
            </ul>
          </section>
        </div>
      </div>
    </>
  )
}

const DRAWER_OPEN_KEY = 'bd.dashboard.projectDrawerOpen'

/** The drawer is closed by default; its state is kept for the session only. */
function useDrawerOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(DRAWER_OPEN_KEY) === 'true'
    } catch {
      return false
    }
  })
  const change = (next: boolean) => {
    setOpen(next)
    try {
      sessionStorage.setItem(DRAWER_OPEN_KEY, String(next))
    } catch {
      // Only a convenience: without storage the drawer starts closed.
    }
  }
  return [open, change]
}

export function Dashboard({
  snapshot,
  onOpenBoard,
  onOpenTicket,
  onOpenReview,
  onboarding = false,
}: {
  snapshot: Snapshot
  onOpenBoard: () => void
  onOpenTicket: (ticket: number) => void
  onOpenReview: (ticket: number) => void
  /** Rafaela's onboarding is showing: the drawer stays closed so it does not cover the steps. */
  onboarding?: boolean
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const { state } = snapshot
  const language = state.settings.language
  const content = story(language, snapshot.projectStory)
  const threads = [...state.inbox].reverse()
  const [selectedId, setSelectedId] = useState<string | null>(
    threads[0]?.id ?? null,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useDrawerOpen()
  const drawerButton = useRef<HTMLButtonElement>(null)

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

  // The open message counts as read, also when it opened on its own (on arrival, or the newest
  // one shown when the Dashboard or the inbox button is opened), not only after a click.
  const openId = selected?.id
  const openUnread = selected !== undefined && !selected.read
  useEffect(() => {
    if (openId && openUnread) {
      void api.markInboxRead(openId)
    }
  }, [openId, openUnread])

  const select = (message: InboxMessage) => setSelectedId(message.id)

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
    nextAssignment: (track) =>
      void api.nextAssignment(track).then(onOpenBoard).catch(toast.error),
    run,
    busy,
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    drawerButton.current?.focus()
  }

  return (
    <div
      className="mx-auto h-full min-h-[560px] max-w-10xl p-6"
      data-testid="dashboard"
    >
      {snapshot.state.projectSwitch && <PendingSwitch snapshot={snapshot} />}
      {snapshot.projectNeedsUpdate && (
        <div className="mb-4">
          <Notice data-testid="project-needs-update">{t('dashboard.projectNeedsUpdate')}</Notice>
        </div>
      )}
      <div className="relative grid h-full grid-cols-[320px_400px_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <aside
          className="flex min-h-0 min-w-0 flex-col overflow-y-auto border-r border-border bg-muted/40"
          aria-label={t('dashboard.desk')}
          data-testid="work-desk"
        >
          <CurrentTask
            snapshot={snapshot}
            active={active}
            actions={actions}
          />
          <div className="flex flex-1 flex-col gap-5 p-5">
            <LocalEnvironment snapshot={snapshot} />
            <div className="h-px shrink-0 bg-border" />
            <section
              className="flex flex-col gap-1.5"
              data-testid="desk-client"
            >
              <SectionLabel icon="briefcase">{t('dashboard.client')}</SectionLabel>
              <p className="truncate text-sm font-medium text-foreground">{content.client.name}</p>
            </section>
            <Button
              ref={drawerButton}
              size="sm"
              className="mt-auto w-full shrink-0"
              onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
              aria-expanded={drawerOpen}
              aria-controls="project-drawer"
              data-testid="project-drawer-toggle"
            >
              <Icon
                name="users"
                className="size-3.5"
              />
              {t('dashboard.projectAndContacts')}
            </Button>
          </div>
        </aside>

        <section
          className="flex min-h-0 min-w-0 flex-col border-r border-border"
          aria-label={t('dashboard.inbox')}
          data-tour="inbox"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-[18px] pb-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <IconTile icon="inbox" />
              <h2 className="truncate text-lg font-bold text-foreground">{t('dashboard.inbox')}</h2>
            </div>
            <span className="shrink-0 text-sm whitespace-nowrap text-muted-foreground">
              {t('dashboard.inboxCount', { count: threads.length })}
            </span>
          </div>
          <ul
            className="min-h-0 flex-1 overflow-y-auto border-t border-border"
            data-testid="inbox"
          >
            {threads.map((message) => {
              const text = messageText(content, message, t, state)
              const isOpen = message.id === selected?.id
              return (
                <li
                  key={message.id}
                  className="border-b border-border"
                  data-testid="inbox-message"
                  data-kind={message.kind}
                >
                  <button
                    type="button"
                    onClick={() => select(message)}
                    aria-current={isOpen ? 'true' : undefined}
                    className={`block w-full px-5 py-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset ${
                      isOpen ? 'bg-primary/10' : 'hover:bg-muted/40'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {!message.read && (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-primary"
                            title={t('dashboard.unread')}
                          />
                        )}
                        <span
                          className={`truncate ${message.read ? 'font-medium text-foreground' : 'font-bold text-primary'}`}
                        >
                          {content.people.manager.name}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {threadDate(message.at, language)}
                      </span>
                    </span>
                    <span
                      className={`mt-0.5 block truncate text-foreground ${isOpen || !message.read ? 'font-medium' : ''}`}
                    >
                      {text.subject}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                      {preview(text.body)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <MessageView
          snapshot={snapshot}
          message={selected}
          active={active}
          actions={actions}
        />

        {drawerOpen && !onboarding && (
          <ProjectDrawer
            language={language}
            projectStory={snapshot.projectStory}
            onClose={closeDrawer}
          />
        )}
      </div>
    </div>
  )
}

/** A project switch whose Docker cleanup did not finish: what is left, and a retry. Nothing else can start meanwhile. */
function PendingSwitch({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation()
  const toast = useToast()
  const left = snapshot.projectSwitchLeft ?? []
  return (
    <div
      className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
      data-testid="pending-switch"
    >
      <div>
        <p className="text-base font-semibold text-foreground">{t('switch.pendingTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('switch.pendingBody')}</p>
        {left.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
            {left.map((item) => (
              <li key={`${item.kind}:${item.name}`}>
                {item.kind}: <code>{item.name}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Button
        size="sm"
        variant="primary"
        disabled={snapshot.busy !== null}
        onClick={() => void api.finishProjectSwitch().catch(toast.error)}
        data-testid="finish-switch"
      >
        <Icon name="refresh" className="size-3.5" />
        {t('switch.retry')}
      </Button>
    </div>
  )
}
