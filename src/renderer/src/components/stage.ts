import type { Column } from '@shared/types.ts';

/** Workflow stage colors: one hue per Kanban column. */
export const STAGE: Record<Column, { pill: string; dot: string; pulse: boolean }> = {
  todo: { pill: 'border-border bg-secondary text-secondary-foreground', dot: 'bg-slate-400', pulse: false },
  inProgress: { pill: 'border-blue-500/20 bg-blue-500/10 text-blue-800 dark:text-blue-400', dot: 'bg-blue-500', pulse: true },
  inQa: { pill: 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-400', dot: 'bg-amber-500', pulse: true },
  codeReview: { pill: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-800 dark:text-indigo-300', dot: 'bg-indigo-500', pulse: false },
  done: { pill: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-400', dot: 'bg-emerald-500', pulse: false },
};
