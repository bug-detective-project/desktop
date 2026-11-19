import type { TicketType } from '@shared/ticketMeta.ts';

/** The tones of a badge. */
export const TONES = {
  neutral: 'border-border bg-secondary text-secondary-foreground',
  ok: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-400',
  warn: 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-400',
  danger: 'border-destructive/20 bg-destructive/10 text-red-800 dark:text-destructive',
  brand: 'border-primary/20 bg-primary/10 text-[color-mix(in_oklab,var(--primary)_85%,black)] dark:text-primary',
};

/**
 * One hue per kind of ticket, on the card's tag and on the "Issue type" row of the ticket. None of
 * them is a hue the card already uses for something else: sky and violet are the tracks, amber is
 * "Front + back".
 */
export const TYPE_TONES: Record<TicketType, string> = {
  fix: TONES.danger,
  // Written out in full: Tailwind only keeps the classes it can read in the source.
  build: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  complete: 'border-teal-500/30 bg-teal-500/10 text-teal-800 dark:text-teal-300',
  refactor: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-800 dark:text-fuchsia-300',
  optimize: 'border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300',
  upgrade: 'border-blue-500/30 bg-blue-500/10 text-blue-800 dark:text-blue-300',
  investigate: 'border-slate-500/30 bg-slate-500/10 text-slate-800 dark:text-slate-300',
};
