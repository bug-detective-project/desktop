import { Database, FileText, Monitor, Ticket } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectCard } from '@shared/api.ts';
import { TRACKS } from '@shared/types.ts';
import type { Language } from '@shared/types.ts';
import { Icon } from '../components/icons.tsx';
import { Button } from '../components/ui.tsx';
import { monogram } from './monogram.ts';

/** Difficulty → filled bars and colors (the meter on the front). */
const LEVELS = {
  beginner: { filled: 1, bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  intermediate: { filled: 2, bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  advanced: { filled: 3, bar: 'bg-destructive', text: 'text-destructive' },
} as const;

const face = 'absolute inset-0 flex flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm [backface-visibility:hidden]';
const label = 'text-xs font-semibold tracking-wider text-muted-foreground uppercase';

/**
 * A project of the Projects screen as a card that flips: the front shows the project at a glance
 * (monogram, difficulty, the current project, tickets, description and the actions), the back its
 * brief (client, stack, tickets and the skills practiced). It flips only from its buttons; the
 * hidden face is inert, and the focus moves to the button that flips back.
 */
export function ProjectFlipCard({ card, language, blocked, onPlay }: { card: ProjectCard; language: Language; blocked: string | null; onPlay: (card: ProjectCard) => void }) {
  const { t } = useTranslation();
  const [flipped, setFlipped] = useState(false);
  const briefButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const { details } = card;
  const name = details?.name[language] ?? card.id;

  const flip = (next: boolean) => {
    setFlipped(next);
    // The face that was hidden is inert until this render ends: focus it on the next frame.
    requestAnimationFrame(() => (next ? closeButton : briefButton).current?.focus());
  };

  // "Front 4/4 · Back 0/4" while played here, "Front 4 · Back 4" otherwise.
  const tickets = details
    ? TRACKS.filter((track) => details.counts[track] > 0)
        .map((track) => {
          const done = card.progress?.[track].done;
          const total = details.counts[track];
          return `${t(`dashboard.track.${track}`)} ${done !== undefined ? `${done}/${total}` : total}`;
        })
        .join(' · ')
    : null;

  return (
    <div className="h-[380px] [perspective:1200px]" data-testid={`project-${card.id}`}>
      <div
        className="relative h-full transition-transform duration-[450ms] ease-[cubic-bezier(.2,.7,.2,1)] [transform-style:preserve-3d] motion-reduce:duration-0"
        style={flipped ? { transform: 'rotateY(180deg)' } : undefined}
        data-testid={`project-${card.id}-flipper`}
      >
        <section className={face} aria-hidden={flipped || undefined} inert={flipped} data-testid={`project-${card.id}-front`}>
          <div className="flex items-center gap-4 border-b border-border bg-muted/70 px-6 py-5">
            <div
              className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--primary)_18%,var(--card))] font-mono text-xl font-semibold text-primary"
              aria-hidden
              data-testid={`project-${card.id}-monogram`}
            >
              {monogram(name)}
            </div>
            {details?.difficulty && <Difficulty level={details.difficulty} />}
            {card.active && (
              <span className="ml-auto shrink-0 self-start rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-sm font-medium text-primary" data-testid="project-current">
                {t('projects.current')}
              </span>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-5 pb-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-xl font-bold tracking-tight text-foreground">{name}</h2>
              {tickets && (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="project-tickets">
                  <Ticket className="size-3.5" aria-hidden />
                  {tickets}
                </span>
              )}
            </div>
            <p className="line-clamp-4 text-base leading-relaxed text-muted-foreground">{details ? details.about[language] : t('projects.noDetails')}</p>
            {card.unavailable === 'appTooOld' && (
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400" data-testid="project-needs-update">
                {t('projects.needsUpdate')}
              </p>
            )}
            {!card.active && blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
            <div className="mt-auto flex items-center justify-between gap-3 whitespace-nowrap">
              <Button ref={briefButton} size="sm" disabled={!details} onClick={() => flip(true)} data-testid={`project-${card.id}-brief`}>
                <FileText className="size-4" aria-hidden />
                {t('projects.brief')}
              </Button>
              {!card.active && (
                <Button
                  variant="primary"
                  disabled={blocked !== null || card.unavailable !== null}
                  title={card.unavailable ? t('projects.needsUpdate') : (blocked ?? undefined)}
                  onClick={() => onPlay(card)}
                  data-testid={`switch-${card.id}`}
                >
                  <Icon name="arrowRight" />
                  {card.played ? t('projects.resume') : t('projects.play')}
                </Button>
              )}
            </div>
          </div>
        </section>

        <section className={`${face} [transform:rotateY(180deg)]`} aria-hidden={!flipped || undefined} inert={!flipped} data-testid={`project-${card.id}-back`}>
          <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/70 px-6 py-4">
            <div className="min-w-0">
              <p className={label}>{name}</p>
              {details && (
                <h3 className="mt-0.5 text-lg font-bold text-foreground" data-testid="project-client">
                  {t('projects.client', { name: details.client[language] })}
                </h3>
              )}
            </div>
            <Button ref={closeButton} variant="ghost" size="sm" onClick={() => flip(false)} aria-label={t('projects.closeBrief')} data-testid={`project-${card.id}-close-brief`}>
              <Icon name="x" />
            </Button>
          </div>
          {details && (
            <div className="flex min-h-0 flex-1 flex-col px-6 pt-7 pb-6">
              {/* The label column is at least 76px and as wide as the longest label ("Banco de dados"), so values line up. */}
              <dl className="grid grid-cols-[auto_minmax(76px,auto)_1fr] items-center gap-x-2 gap-y-2 text-sm">
                {details.stack?.frontend && <Row icon={<Monitor />} label={t('projects.frontend')} value={details.stack.frontend} testId="project-stack-frontend" />}
                {details.stack?.backend && <Row icon={<Icon name="server" />} label={t('projects.backend')} value={details.stack.backend} testId="project-stack-backend" />}
                {details.stack?.database && <Row icon={<Database />} label={t('projects.database')} value={details.stack.database} testId="project-stack-database" />}
                {tickets && <Row icon={<Ticket />} label={t('projects.tickets')} value={tickets} testId="project-tickets" />}
              </dl>
              {details.skills[language].length > 0 && (
                <div className="mt-3 border-t border-border pt-4">
                  <p className={label}>{t('projects.practice')}</p>
                  <ul className="mt-2 space-y-1.5" data-testid="project-skills">
                    {details.skills[language].map((skill) => (
                      <li key={skill} className="flex items-center gap-2 text-sm text-foreground">
                        <Icon name="check" className="size-3.5 text-primary" />
                        {skill}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Difficulty({ level }: { level: keyof typeof LEVELS }) {
  const { t } = useTranslation();
  const { filled, bar, text } = LEVELS[level];
  const name = t(`projects.difficulties.${level}`);
  return (
    <div data-testid="project-difficulty" data-level={level}>
      <p className={label}>{t('projects.difficulty')}</p>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex gap-[3px]" role="img" aria-label={name}>
          {[1, 2, 3].map((index) => (
            <span key={index} className={`h-1.5 w-[18px] rounded-full ${index <= filled ? bar : 'bg-border'}`} />
          ))}
        </div>
        <span className={`text-sm font-semibold ${text}`}>{name}</span>
      </div>
    </div>
  );
}

/** The icons come from lucide-react directly: components/icons.tsx is imported by the app header, which this screen must not change. */
function Row({ icon, label: name, value, testId }: { icon: ReactNode; label: string; value: ReactNode; testId: string }) {
  return (
    <div className="contents" data-testid={testId}>
      <span className="text-muted-foreground [&>svg]:size-4" aria-hidden>
        {icon}
      </span>
      <dt className="whitespace-nowrap text-muted-foreground">{name}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </div>
  );
}
