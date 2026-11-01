import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { COLUMNS } from '@shared/types.ts';
import { api } from '../api.ts';
import { company } from '../content.ts';
import { useToast } from '../toast-context.ts';
import { Icon } from './icons.tsx';
import { ONBOARDING_STEPS, placeBalloon, unionBox } from './onboardingSteps.ts';
import type { Box, OnboardingIllustration, OnboardingStep, OnboardingView } from './onboardingSteps.ts';
import { OnboardingTicketDemo } from './OnboardingTicketDemo.tsx';
import { STAGE } from './stage.ts';
import { Button } from './ui.tsx';

/** 'first': opened on its own, it cannot be closed before the end. 'replay': opened from the "?" button, closes anytime. */
export type OnboardingMode = 'first' | 'replay';

/** -1 is Rafaela's welcome card, then one index per step, then her closing card. */
const WELCOME = -1;
const CLOSING = ONBOARDING_STEPS.length;

/**
 * Rafaela's onboarding: a welcome card, the Dashboard and Board steps (each one dims the screen
 * around the part it explains), and a closing card. The first time it cannot be skipped, except in
 * development with BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON.
 */
export function Onboarding({
  snapshot,
  mode,
  onNavigate,
  onClose,
}: {
  snapshot: Snapshot;
  mode: OnboardingMode;
  onNavigate: (view: OnboardingView) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [index, setIndex] = useState(WELCOME);
  const [finishing, setFinishing] = useState(false);
  const manager = company(snapshot.state.settings.language).people.manager;
  const closable = mode === 'replay';

  const go = (next: number) => {
    const step = ONBOARDING_STEPS[next] as OnboardingStep | undefined;
    if (step) {
      onNavigate(step.view);
    }
    setIndex(next);
  };

  /** "Finish", or "Skip onboarding" in development: it no longer opens on its own. */
  const finish = () => {
    setFinishing(true);
    api
      .finishOnboarding()
      .then(() => {
        onNavigate('dashboard');
        onClose();
      })
      .catch((error: unknown) => {
        setFinishing(false);
        toast.error(error);
      });
  };

  // Arrows move between the steps; Escape closes only a replay.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closable) {
        onClose();
      } else if (event.key === 'ArrowRight' && index >= 0 && index < CLOSING) {
        go(index + 1);
      } else if (event.key === 'ArrowLeft' && index > 0 && index < CLOSING) {
        go(index - 1);
      }
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  });

  const skip = snapshot.devSkipOnboarding ? (
    <Button variant="ghost" size="sm" onClick={finish} disabled={finishing} data-testid="onboarding-skip">
      {t('onboarding.skip')}
    </Button>
  ) : null;
  const close = closable ? (
    <button
      type="button"
      onClick={onClose}
      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={t('common.close')}
      title={t('common.close')}
      data-testid="onboarding-close"
    >
      <Icon name="x" className="size-4" />
    </button>
  ) : null;
  const avatar = (size: 'sm' | 'md') => (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/15 font-bold text-primary ${
        size === 'md' ? 'size-11 text-base' : 'size-7 text-xs'
      }`}
      aria-hidden
    >
      {manager.name
        .split(' ')
        .map((part) => part[0])
        .join('')}
    </div>
  );

  if (index === WELCOME || index === CLOSING) {
    const welcome = index === WELCOME;
    return (
      <CenteredCard testId={welcome ? 'onboarding-welcome' : 'onboarding-closing'} label={t(welcome ? 'onboarding.welcome.title' : 'onboarding.closing.title')}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {avatar('md')}
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground">{manager.name}</p>
              <p className="truncate text-sm text-muted-foreground">{manager.role}</p>
            </div>
          </div>
          {close}
        </div>
        <h2 className="mt-5 text-xl font-bold tracking-tight text-foreground">{t(welcome ? 'onboarding.welcome.title' : 'onboarding.closing.title')}</h2>
        <p className="mt-2 text-base leading-relaxed text-muted-foreground">
          {t(welcome ? 'onboarding.welcome.body' : closable ? 'onboarding.closing.bodyReplay' : 'onboarding.closing.body', {
            company: company(snapshot.state.settings.language).company.name,
          })}
        </p>
        <div className="mt-6 flex items-center justify-between gap-3">
          <span>{welcome && skip}</span>
          {welcome ? (
            <Button variant="primary" onClick={() => go(0)} autoFocus data-testid="onboarding-start">
              {t('onboarding.welcome.start')}
              <Icon name="arrowRight" className="size-4" />
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => go(CLOSING - 1)} disabled={finishing} data-testid="onboarding-back">
                {t('onboarding.back')}
              </Button>
              <Button variant="primary" onClick={finish} busy={finishing} autoFocus data-testid="onboarding-finish">
                {t('onboarding.closing.finish')}
              </Button>
            </div>
          )}
        </div>
      </CenteredCard>
    );
  }

  const step = ONBOARDING_STEPS[index];
  return (
    <StepOverlay key={step.id} step={step}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {avatar('sm')}
          <span className="truncate text-sm font-medium text-foreground">{manager.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="onboarding-progress">
            {t('onboarding.progress', { step: index + 1, total: ONBOARDING_STEPS.length })}
          </span>
          {close}
        </div>
      </div>
      <h2 id="onboarding-title" className="mt-3 text-base font-bold text-foreground">
        {t(`onboarding.steps.${step.id}.title`)}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t(`onboarding.steps.${step.id}.body`)}</p>
      {step.illustration && <Illustration kind={step.illustration} />}
      <div className="mt-4 flex items-center justify-between gap-2">
        <span>{skip}</span>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <Button variant="ghost" size="sm" onClick={() => go(index - 1)} data-testid="onboarding-back">
              {t('onboarding.back')}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => go(index + 1)} autoFocus data-testid="onboarding-next">
            {t('onboarding.next')}
          </Button>
        </div>
      </div>
    </StepOverlay>
  );
}

/** Keeps Tab inside the dialog: the screen behind it cannot be used during the onboarding. */
function trapTab(event: ReactKeyboardEvent, dialog: RefObject<HTMLElement | null>) {
  if (event.key !== 'Tab' || !dialog.current) {
    return;
  }
  const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  if (focusable.length === 0) {
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Rafaela's welcome and closing cards, over the blurred screen. */
function CenteredCard({ testId, label, children }: { testId: string; label: string; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm" data-testid="onboarding">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => trapTab(event, dialog)}
        className="w-[460px] max-w-full rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-2xl"
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}

interface Layout {
  target: Box | null;
  balloon: { left: number; top: number } | null;
  viewport: { width: number; height: number };
}

/** A rounded rectangle as an SVG path, drawn as a hole in the dimmed screen. */
function roundedRect({ left, top, width, height }: Box, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2);
  return `M${left + r} ${top}H${left + width - r}A${r} ${r} 0 0 1 ${left + width} ${top + r}V${top + height - r}A${r} ${r} 0 0 1 ${left + width - r} ${top + height}H${left + r}A${r} ${r} 0 0 1 ${left} ${top + height - r}V${top + r}A${r} ${r} 0 0 1 ${left + r} ${top}Z`;
}

/**
 * One step: the screen dims around its targets (measured every frame, so the highlight follows a
 * resize or a scroll) and the balloon sits beside them. The overlay takes every click: the
 * highlighted parts are shown, not used.
 */
function StepOverlay({ step, children }: { step: OnboardingStep; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>({ target: null, balloon: null, viewport: { width: 0, height: 0 } });

  useEffect(() => {
    const elements = () => step.targets.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]);
    elements()[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    let frame = 0;
    const measure = () => {
      const target = unionBox(elements().map((element) => element.getBoundingClientRect()));
      const size = dialog.current ? { width: dialog.current.offsetWidth, height: dialog.current.offsetHeight } : null;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const balloon = size ? placeBalloon(target, size, viewport, step.below) : null;
      const next = { target, balloon, viewport };
      setLayout((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [step]);

  const { target, balloon, viewport } = layout;
  const pad = 6;
  const hole = target && { left: target.left - pad, top: target.top - pad, width: target.width + pad * 2, height: target.height + pad * 2 };
  return (
    <div className="fixed inset-0 z-[60]" data-testid="onboarding" data-step={step.id}>
      {step.panelTab && <OnboardingTicketDemo tab={step.panelTab} />}
      {/* The dimmed screen with a hole around the targets, and the primary outline around the hole. */}
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
        <path fillRule="evenodd" fill="rgb(0 0 0 / 0.6)" d={`M0 0H${viewport.width}V${viewport.height}H0Z${hole ? roundedRect(hole, 14) : ''}`} />
      </svg>
      {hole && <div className="pointer-events-none absolute rounded-[14px] ring-2 ring-primary" style={hole} data-testid="onboarding-highlight" />}
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        onKeyDown={(event) => trapTab(event, dialog)}
        className={`absolute w-[340px] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl ${balloon ? '' : 'invisible'}`}
        style={balloon ?? { left: 0, top: 0 }}
        data-testid="onboarding-step"
      >
        {children}
      </div>
    </div>
  );
}

/** The miniatures of the Board steps: an example card, never a real ticket. */
function Illustration({ kind }: { kind: OnboardingIllustration }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/50 p-3" aria-hidden data-testid={`onboarding-illustration-${kind}`}>
      {kind === 'flow' && (
        <div className="relative">
          <div className="grid grid-cols-5 gap-1">
            {COLUMNS.map((column) => (
              <div key={column} className={`flex h-14 items-start justify-center rounded border pt-1 ${STAGE[column].pill}`}>
                <span className={`size-1.5 rounded-full ${STAGE[column].dot}`} />
              </div>
            ))}
          </div>
          <div className="absolute top-5 left-0 w-1/5 px-0.5 motion-safe:animate-onboarding-flow">
            <div className="rounded border border-primary/40 bg-background px-1 py-0.5 text-center font-mono text-[9px] font-medium text-primary shadow-sm">SD-000</div>
          </div>
        </div>
      )}
      {kind === 'card' && (
        <div className="mx-auto w-48 rounded-md border border-border bg-background px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <span className="font-mono text-[10px] font-medium text-primary">SD-000</span>
            <span className="rounded border border-border bg-secondary px-1.5 text-[10px] text-secondary-foreground">{t('board.move')}</span>
          </div>
          <p className="mt-0.5 truncate text-[11px] font-medium text-foreground">{t('onboarding.example')}</p>
        </div>
      )}
    </div>
  );
}
