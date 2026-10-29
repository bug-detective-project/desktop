/**
 * Icons used only by the Dashboard (lucide-react), on top of the shared set in icons.tsx. Kept apart
 * so the shared set, which the app header imports, stays untouched.
 */
import { Briefcase, ClipboardList, Contact, Inbox, Package, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'

const ICONS = {
  clipboardList: ClipboardList,
  package: Package,
  users: Users,
  briefcase: Briefcase,
  contact: Contact,
  inbox: Inbox,
} satisfies Record<string, LucideIcon>

type DeskIconName = keyof typeof ICONS

/** Draws a Dashboard icon, or a shared one (same look as Icon: currentColor, 2px stroke). */
export function DeskIcon({ name, className = 'size-4' }: { name: DeskIconName | IconName; className?: string }) {
  if (!(name in ICONS)) {
    return <Icon name={name as IconName} className={className} />
  }
  const Lucide = ICONS[name as DeskIconName]
  return <Lucide className={`shrink-0 ${className}`} aria-hidden />
}
