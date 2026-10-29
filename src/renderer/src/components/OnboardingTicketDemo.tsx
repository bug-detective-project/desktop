import { useTranslation } from 'react-i18next';
import type { QaComment } from '@shared/types.ts';
import { story } from '../content.ts';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import type { DemoTab } from './onboardingSteps.ts';
import { QaCommentView } from './QaComment.tsx';
import { Badge, Button, StagePill, Tabs } from './ui.tsx';

/** A fixed moment for the example's dates, so the panel looks the same every time. */
const AT = '2026-10-29T10:00:00.000Z';

/**
 * The example ticket panel of the onboarding: laid out like the real ticket panel, filled with
 * example content ("SD-000"), never a real ticket. It is only shown: the onboarding overlay takes
 * every click, and the panel is inert.
 */
export function OnboardingTicketDemo({ tab }: { tab: DemoTab }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language === 'pt' ? 'pt' : 'en';
  const senior = story(language).people.senior.name;
  const locale = language === 'pt' ? 'pt-BR' : 'en-US';
  const time = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toLocaleString(locale);
  const failed: QaComment = {
    id: 'onboarding-example',
    at: AT,
    kind: 'gate2Failed',
    failing: [{ name: t('onboarding.demo.qaTest'), error: t('onboarding.demo.qaError') }],
  };
  const column = (value: string) => t(`board.columns.${value}`);
  const history: [number, string][] = [
    [0, t('ticket.created', { to: column('todo') })],
    [5, t('ticket.transition', { from: column('todo'), to: column('inProgress') })],
    [40, t('ticket.transition', { from: column('inProgress'), to: column('inQa') })],
    [42, t('ticket.transition', { from: column('inQa'), to: column('inProgress') })],
  ];

  return (
    <aside
      className="absolute inset-y-0 right-0 flex w-panel max-w-full flex-col border-l border-border bg-background shadow-2xl"
      inert
      aria-hidden
      data-onboarding-demo="panel"
      data-tab={tab}
      data-testid="onboarding-ticket-demo"
    >
      <header className="space-y-3 border-b border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4" data-onboarding-demo="header">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-primary">SD-000</span>
              <StagePill status="inProgress" />
            </div>
            <h2 className="mt-2 text-xl font-bold tracking-tight">{t('onboarding.demo.title')}</h2>
          </div>
          <span className="rounded-md px-2 py-1.5 text-muted-foreground">
            <Icon name="x" />
          </span>
        </div>
        <div className="space-y-2" data-onboarding-demo="actions">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" className="w-full">
              <Icon name="code" />
              {t('ticket.openVSCode')}
            </Button>
            <Button className="w-full">
              <Icon name="externalLink" />
              {t('ticket.openBrowser')}
              <span className="font-mono text-sm text-muted-foreground">:5173</span>
            </Button>
          </div>
          <Button className="w-full">
            <Icon name="play" />
            {t('ticket.startDevServer')}
          </Button>
        </div>
      </header>
      <div className="px-5 pt-3">
        <Tabs<DemoTab>
          active={tab}
          onChange={() => {}}
          tabs={[
            { id: 'ticket', label: t('ticket.tabs.ticket') },
            { id: 'qa', label: t('ticket.tabs.qa'), badge: <Badge>1</Badge> },
            { id: 'history', label: t('ticket.tabs.history') },
            { id: 'senior', label: t('ticket.tabs.senior', { name: senior }) },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-5" data-onboarding-demo="content">
        {tab === 'ticket' && <Markdown>{t('onboarding.demo.ticketMarkdown')}</Markdown>}
        {tab === 'qa' && <QaCommentView comment={failed} defaultOpen />}
        {tab === 'history' && (
          <div className="space-y-6">
            <section>
              <h3 className="mb-2 text-base font-semibold">{t('ticket.attemptHistory')}</h3>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-base">
                <span className="font-medium">{t('ticket.attempt', { number: 1 })}</span>
                <Badge tone="danger">{t('ticket.attemptResult.failed')}</Badge>
                <span className="text-muted-foreground">{t('ticket.testsSummary', { passed: 11, failed: 1 })}</span>
                <time className="ml-auto text-sm text-muted-foreground">{time(42)}</time>
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-base font-semibold">{t('ticket.activity')}</h3>
              <ol className="space-y-1.5 text-base">
                {history.map(([minutes, text]) => (
                  <li key={minutes} className="flex gap-3">
                    <time className="w-40 shrink-0 text-sm text-muted-foreground">{time(minutes)}</time>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
        {tab === 'senior' && (
          <div className="space-y-4">
            <p className="text-base text-muted-foreground">{t('ticket.senior.intro', { name: senior })}</p>
            <div className="space-y-3">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-base text-primary-foreground">{t('onboarding.demo.question')}</div>
              </div>
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl border border-border bg-muted px-4 py-2.5 text-base text-foreground">
                  <p className="mb-1 text-sm font-semibold text-primary">{senior}</p>
                  {t('onboarding.demo.hint')}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button variant="primary">{t('ticket.senior.ask')}</Button>
              <span className="ml-auto text-sm text-muted-foreground">{t('ticket.hintsUsed', { used: 1, total: 3 })}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
