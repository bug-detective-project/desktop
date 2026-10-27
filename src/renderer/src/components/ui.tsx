/** Small building blocks shared by the screens. See docs/design-system.md for the rules they follow. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Column } from '@shared/types.ts';
import { Icon } from './icons.tsx';
import { STAGE } from './stage.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerOutline';
type Size = 'sm' | 'md';

// Icons inside buttons always inherit the button's text color (currentColor).
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:opacity-95 disabled:opacity-50',
  secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-60',
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60',
  danger: 'bg-destructive text-destructive-foreground shadow-sm hover:opacity-95 disabled:opacity-50',
  dangerOutline: 'border border-destructive/50 text-destructive shadow-2xs hover:bg-destructive/10 disabled:opacity-60',
};

const SIZES: Record<Size, string> = {
  sm: 'gap-1.5 rounded-md px-3 py-1.5 text-sm',
  md: 'gap-2 rounded-lg px-3.5 py-2 text-base',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy && <Spinner className={size === 'sm' ? 'size-3.5' : 'size-4'} />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Icon name="spinner" className={className} />;
}

export function Card({ children, className = '', ...props }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm ${className}`} {...props}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-xs font-bold tracking-wider text-foreground uppercase">{children}</h2>
      {aside}
    </div>
  );
}

const TONES = {
  neutral: 'border-border bg-secondary text-secondary-foreground',
  ok: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'border-destructive/20 bg-destructive/10 text-destructive',
  brand: 'border-primary/20 bg-primary/10 text-primary',
};

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-medium ${TONES[tone]}`}>{children}</span>;
}

export function StagePill({ status, className = '' }: { status: Column; className?: string }) {
  const { t } = useTranslation();
  const stage = STAGE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${stage.pill} ${className}`} data-stage={status}>
      {stage.pulse && <span className={`size-1.5 animate-pulse rounded-full ${stage.dot}`} aria-hidden />}
      {t(`board.columns.${status}`)}
    </span>
  );
}

export function StatusIcon({ status }: { status: 'ok' | 'missing' | 'pending' | 'warning' }) {
  const styles = {
    ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    missing: 'bg-destructive/10 text-destructive',
    pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  };
  const icons = { ok: 'check', missing: 'x', pending: 'spinner', warning: 'alertTriangle' } as const;
  return (
    <span className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full ${styles[status]}`} aria-hidden>
      <Icon name={icons[status]} className="size-3.5" />
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: ReactNode }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-border" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          data-testid={`tab-${tab.id}`}
          onClick={() => onChange(tab.id)}
          className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-base font-medium transition-colors ${
            tab.id === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

export function LogView({ lines }: { lines: string[] }) {
  return (
    <pre
      className="max-h-56 overflow-auto rounded-lg border border-border/50 bg-muted/60 p-2.5 font-mono text-xs leading-relaxed text-foreground"
      data-testid="log-view"
    >
      {lines.slice(-200).join('\n') || '…'}
    </pre>
  );
}

/** A dialog. Without onClose it cannot be dismissed (used while a task must finish). */
export function Modal({
  title,
  icon,
  children,
  onClose,
  ...props
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose?: () => void;
  'data-testid'?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs" role="dialog" aria-modal aria-label={title} {...props}>
      <div className="w-full max-w-lg rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="flex items-center gap-2.5 text-xl font-bold tracking-tight">
            {icon}
            {title}
          </h2>
          {onClose && (
            <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
              <Icon name="x" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A notice block: warnings and destructive confirmations inside cards and modals. */
export function Notice({ tone = 'warn', children, ...props }: { tone?: 'warn' | 'danger'; children: ReactNode; 'data-testid'?: string }) {
  const styles = {
    warn: 'border-amber-500/30 bg-amber-500/10 text-foreground',
    danger: 'border-destructive/40 bg-destructive/5 text-foreground',
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border p-3 text-base ${styles[tone]}`} {...props}>
      <Icon name="alertTriangle" className={`mt-0.5 size-4 ${tone === 'warn' ? 'text-amber-500' : 'text-destructive'}`} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
