import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectCard, Snapshot } from '@shared/api.ts';
import { TRACKS } from '@shared/types.ts';
import { api } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Button, Card, Modal, Notice } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

/**
 * Every project of the game: what it is, how hard, how many tickets per track, and the player's
 * progress. Switching removes the active project from Docker (after a confirmation that offers a
 * backup first) and downloads the other one; progress and PRs are kept.
 */
export function Projects({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const toast = useToast();
  const language = snapshot.state.settings.language;
  const [confirm, setConfirm] = useState<ProjectCard | null>(null);
  const [exporting, setExporting] = useState(false);

  // Details of projects never downloaded come from a light download of their qa branch.
  useEffect(() => {
    api.loadProjects().catch(() => {});
  }, []);

  const current = snapshot.state.tickets.find((ticket) => ticket.ticket === snapshot.state.currentTicket);
  const ticketOpen = current !== undefined && current.status !== 'done';
  const blocked = ticketOpen ? t('projects.finishTicketFirst') : snapshot.busy !== null ? t('projects.busy') : null;

  const switchTo = (card: ProjectCard) => {
    setConfirm(null);
    api
      .switchProject(card.id)
      .then(() => toast.info(t('projects.switched', { name: card.details?.name[language] ?? card.id })))
      .catch(toast.error);
  };

  return (
    <main className="mx-auto w-full max-w-10xl px-6 py-8" data-testid="projects">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('projects.title')}</h1>
      <p className="mt-1 text-base text-muted-foreground">{t('projects.intro')}</p>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {(snapshot.projects ?? []).map((card) => (
          <Card key={card.id} className="flex flex-col gap-3 p-5" data-testid={`project-${card.id}`}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-bold text-foreground">{card.details?.name[language] ?? card.id}</h2>
              {card.active && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary" data-testid="project-active">
                  {t('projects.active')}
                </span>
              )}
            </div>
            {card.details ? (
              <>
                <p className="text-base text-muted-foreground">{card.details.about[language]}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="font-medium text-muted-foreground">{t('projects.stack')}</dt>
                  <dd className="text-foreground">{card.details.stack[language]}</dd>
                  {card.details.difficulty && (
                    <>
                      <dt className="font-medium text-muted-foreground">{t('projects.difficulty')}</dt>
                      <dd className="text-foreground" data-testid="project-difficulty">
                        {t(`projects.difficulties.${card.details.difficulty}`)}
                      </dd>
                    </>
                  )}
                  <dt className="font-medium text-muted-foreground">{t('projects.tickets')}</dt>
                  <dd className="text-foreground" data-testid="project-tickets">
                    {TRACKS.filter((track) => card.details!.counts[track] > 0)
                      .map((track) => {
                        const done = card.progress?.[track].done;
                        const total = card.details!.counts[track];
                        return `${t(`dashboard.track.${track}`)} ${done !== undefined ? `${done}/${total}` : total}`;
                      })
                      .join(' · ')}
                  </dd>
                </dl>
              </>
            ) : (
              <p className="text-base text-muted-foreground">{t('projects.noDetails')}</p>
            )}
            {!card.active && (
              <div className="mt-auto pt-2">
                <Button variant="primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => setConfirm(card)} data-testid={`switch-${card.id}`}>
                  <Icon name="arrowRight" />
                  {card.played ? t('projects.resume') : t('projects.play')}
                </Button>
                {blocked && <p className="mt-2 text-sm text-muted-foreground">{blocked}</p>}
              </div>
            )}
          </Card>
        ))}
      </div>

      {confirm && (
        <Modal title={t('projects.confirmTitle', { name: confirm.details?.name[language] ?? confirm.id })} onClose={() => setConfirm(null)} data-testid="switch-dialog">
          <Notice>
            <p className="text-base leading-relaxed">{t('projects.confirmRemoved')}</p>
            <p className="mt-2 text-base leading-relaxed">{t('projects.confirmKept')}</p>
          </Notice>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button
              busy={exporting}
              onClick={() => {
                setExporting(true);
                api
                  .exportProgress()
                  .then((result) => result.saved && toast.info(t('settings.exported', { path: result.path })))
                  .catch(toast.error)
                  .finally(() => setExporting(false));
              }}
              data-testid="switch-export"
            >
              <Icon name="download" />
              {t('projects.exportFirst')}
            </Button>
            <Button variant="danger" onClick={() => switchTo(confirm)} data-testid="confirm-switch">
              {t('projects.confirm')}
            </Button>
          </div>
        </Modal>
      )}
    </main>
  );
}
