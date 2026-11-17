/** What the Dashboard's work desk shows, as pure functions of the snapshot (unit-tested). */
import type { EnvironmentItemId, Snapshot } from '@shared/api.ts'
import type { InboxMessage, Language, TicketState } from '@shared/types.ts'

/**
 * The Current task state. The order matters: missing downloads block everything, then an unlock
 * in progress, then the active ticket, the queued next one (or Docker to start first), the end of
 * the sprint.
 */
export type DeskState = 'download' | 'unlocking' | 'active' | 'dockerDown' | 'queued' | 'allDone' | 'none'

export function deskState(snapshot: Snapshot, active: TicketState | undefined): DeskState {
  const { environment } = snapshot
  if (environment && (!environment.ready || snapshot.busy === 'installing')) return 'download'
  if (snapshot.busy === 'unlocking') return 'unlocking'
  if (active) return 'active'
  if (snapshot.nextTicket !== null) return snapshot.dockerState === 'running' ? 'queued' : 'dockerDown'
  if (snapshot.state.inbox.some((item) => item.kind === 'completion')) return 'allDone'
  return 'none'
}

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral'

export interface EnvRow {
  /** `service-<name>` is one service the project declares. */
  id: 'docker' | EnvironmentItemId | 'database' | `service-${string}`
  icon: 'server' | 'package' | 'download' | 'hardDrive'
  name: string
  tone: Tone
  /** Always a word, never only a color. */
  status: string
  /** A spinner replaces the icon. */
  busy: boolean
  /** The row offers an action: "Try again" after a failed database reset, "Recreate services" on the first service that stopped. */
  action?: 'retryDatabaseReset' | 'recreateServices'
}

/** Approximate download sizes, shown next to the environment items. */
const ENVIRONMENT_SIZES: Partial<Record<EnvironmentItemId, string>> = {
  workspaceImage: '1.1 GB',
  qaImage: '3 GB',
  projectDependencies: '160 MB',
}

/** The rows after Docker Engine, always shown in this order. */
const ENVIRONMENT_ITEMS: { id: EnvironmentItemId; icon: 'package' | 'download' }[] = [
  { id: 'workspaceImage', icon: 'package' },
  { id: 'qaImage', icon: 'package' },
  { id: 'projectDependencies', icon: 'download' },
]

/** "1.1 GB" in English, "1,1 GB" in Portuguese. */
const localSize = (size: string, language: Language) => (language === 'pt' ? size.replace('.', ',') : size)

/** Docker Engine and the three downloads, each with its tone and status. */
export function environmentRows(snapshot: Snapshot, t: (key: string) => string): EnvRow[] {
  const language = snapshot.state.settings.language
  const installing = snapshot.busy === 'installing'
  const docker = snapshot.busy === 'startingDocker' ? 'starting' : snapshot.dockerState
  const dockerRow: EnvRow = {
    id: 'docker',
    icon: 'server',
    name: t('dashboard.env.docker'),
    ...(docker === 'running'
      ? { tone: 'ok', status: t('dashboard.envStatus.running'), busy: false }
      : docker === 'starting'
        ? { tone: 'warn', status: t('dashboard.envStatus.starting'), busy: true }
        : docker
          ? { tone: 'danger', status: t(`dashboard.envStatus.${docker}`), busy: false }
          : { tone: 'warn', status: t('dashboard.envStatus.checking'), busy: true }),
  }
  const itemRow = ({ id, icon }: (typeof ENVIRONMENT_ITEMS)[number]): EnvRow => {
    const base = { id, icon, name: t(`dashboard.env.${id}`) }
    const item = snapshot.environment?.items.find((entry) => entry.id === id)
    if (item?.ready) {
      const size = ENVIRONMENT_SIZES[id]
      return { ...base, tone: 'ok', status: size ? `${t('dashboard.envStatus.ready')} · ${localSize(size, language)}` : t('dashboard.envStatus.ready'), busy: false }
    }
    if (installing) {
      return { ...base, tone: 'warn', status: t('dashboard.envStatus.installing'), busy: true }
    }
    if (!snapshot.environment) {
      // Images and dependencies can only be checked with Docker running.
      return docker === 'running'
        ? { ...base, tone: 'warn', status: t('dashboard.envStatus.checking'), busy: true }
        : { ...base, tone: 'neutral', status: t('dashboard.envStatus.needsDocker'), busy: false }
    }
    // Dependencies are listed only once the workspace exists; with the workspace image in place
    // they are installed with the first ticket, so they are not an error yet.
    const workspaceReady = snapshot.environment.items.some((entry) => entry.id === 'workspaceImage' && entry.ready)
    return !item && workspaceReady
      ? { ...base, tone: 'neutral', status: t('dashboard.envStatus.notYet'), busy: false }
      : { ...base, tone: 'danger', status: t('dashboard.envStatus.missing'), busy: false }
  }
  const rows = [dockerRow, ...ENVIRONMENT_ITEMS.map(itemRow)]
  // Only a project that declares services has their images among its downloads.
  if (snapshot.environment?.items.some((entry) => entry.id === 'serviceImages')) {
    rows.push(itemRow({ id: 'serviceImages', icon: 'package' }))
  }
  // One button recreates every service: it goes on the first one that stopped.
  let offered = false
  const recreate = (): { action?: 'recreateServices' } => {
    if (offered) return {}
    offered = true
    return { action: 'recreateServices' }
  }
  for (const service of snapshot.services ?? []) {
    const base = { id: `service-${service.name}` as const, icon: 'hardDrive' as const, name: `${service.name} · ${service.image}` }
    if (service.state === 'ready') {
      rows.push({ ...base, tone: 'ok', status: t('dashboard.envStatus.ready'), busy: false })
    } else if (service.state === 'starting') {
      // Before the environment is downloaded there is no container yet: nothing is starting.
      rows.push(
        snapshot.environment?.ready
          ? { ...base, tone: 'warn', status: t('dashboard.envStatus.starting'), busy: true }
          : { ...base, tone: 'neutral', status: t('dashboard.envStatus.notYet'), busy: false },
      )
    } else if (service.state === 'oom') {
      rows.push({ ...base, tone: 'danger', status: t('dashboard.envStatus.serviceOutOfMemory'), busy: false, ...recreate() })
    } else {
      // Docker's or the server's own words are not translated: they are what a search will find.
      const stopped = t('dashboard.envStatus.serviceStopped')
      rows.push({ ...base, tone: 'danger', status: service.reason ? `${stopped}: ${service.reason}` : stopped, busy: false, ...recreate() })
    }
  }
  if (snapshot.dbResetFailed) {
    // The data may be the previous ticket's: shown until a retry succeeds.
    rows.push({ id: 'database', icon: 'hardDrive', name: t('dashboard.env.database'), tone: 'danger', status: t('dashboard.envStatus.resetFailed'), busy: false, action: 'retryDatabaseReset' })
  }
  return rows
}

/** The summary badge: danger when something is missing or stopped, warn while something runs or the workspace is open to the internet, ok otherwise. */
export function environmentSummary(rows: EnvRow[], workspaceInternet = false): 'ok' | 'warn' | 'danger' {
  if (rows.some((row) => row.tone === 'danger')) return 'danger'
  if (workspaceInternet || rows.some((row) => row.tone === 'warn')) return 'warn'
  return 'ok'
}

export interface MessageText {
  subject: string
  body: string
}

/** The story texts the inbox shows. */
export interface StoryMessages {
  welcome: MessageText
  completion: MessageText
  trackCompletion: MessageText
  assignments: Record<string, MessageText>
}

/**
 * The text of an inbox message. Assignments are keyed by ticket id (front-1, …); a ticket without
 * its own message in the story gets the generic one, so any number of tickets works.
 */
export function inboxMessageText(
  messages: StoryMessages,
  message: InboxMessage,
  fallback: MessageText,
  idOf: (ticket: number) => string | undefined,
): MessageText {
  if (message.kind === 'welcome') return messages.welcome
  // Both completions may name the track ({{track}}: front, back or fullstack).
  const named = (text: MessageText): MessageText => ({
    subject: text.subject.replaceAll('{{track}}', message.track ?? ''),
    body: text.body.replaceAll('{{track}}', message.track ?? ''),
  })
  if (message.kind === 'completion') return named(messages.completion)
  if (message.kind === 'trackCompletion') return named(messages.trackCompletion)
  const id = message.ticket === undefined ? undefined : idOf(message.ticket)
  return (id && messages.assignments[id]) || fallback
}
