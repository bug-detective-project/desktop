import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectCard, Snapshot } from '@shared/api.ts';
import { api } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Button, Modal, Notice } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';
import { Segmented } from '../components/Segmented.tsx';
import { ProjectFlipCard } from './ProjectFlipCard.tsx';
import { filterProjects } from './projectFilter.ts';
import type { LevelFilter } from './projectFilter.ts';

/** The dot before each difficulty option: the same colors as the cards' meter. */
const LEVEL_DOTS = { beginner: 'bg-emerald-500', intermediate: 'bg-amber-500', advanced: 'bg-destructive' } as const;

/**
 * Every project of the game, each a card that flips to its brief (ProjectFlipCard): what it is,
 * how hard, how many tickets per track, and the player's progress. Switching removes the active project from Docker (after a confirmation that offers a
 * backup first) and downloads the other one; progress and PRs are kept.
 */
export function Projects({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const toast = useToast();
  const language = snapshot.state.settings.language;
  const [confirm, setConfirm] = useState<ProjectCard | null>(null);
  const [exporting, setExporting] = useState(false);
  // Search and difficulty: they only hide cards, and reset when the player leaves the screen.
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  // Enter saves the search as a tag; the tags combine, every one must match ("vue" + "node").
  const [tags, setTags] = useState<string[]>([]);
  const addTag = () => {
    const tag = query.trim();
    if (tag && !tags.some((saved) => saved.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      setTags([...tags, tag]);
    }
    setQuery('');
    setDebounced('');
  };
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const visible = filterProjects(snapshot.projects ?? [], { query: debounced, tags, level }, language);
  const clearFilters = () => {
    setQuery('');
    setDebounced('');
    setLevel('all');
    setTags([]);
    searchField.current?.focus();
  };

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
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3" role="search">
        <label className="relative min-w-0 max-w-[420px] flex-[1_1_320px]">
          <span className="sr-only">{t('projects.search.label')}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={searchField}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                setDebounced('');
              } else if (event.key === 'Enter') {
                event.preventDefault();
                addTag();
              } else if (event.key === 'Backspace' && query === '' && tags.length > 0) {
                setTags(tags.slice(0, -1));
              }
            }}
            placeholder={t('projects.search.placeholder')}
            className="h-10 w-full rounded-lg border border-input bg-card pr-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            data-testid="project-search"
          />
        </label>
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t('projects.difficulty')}</span>
          <Segmented<LevelFilter>
            label={t('projects.difficulty')}
            value={level}
            options={(['all', 'beginner', 'intermediate', 'advanced'] as const).map((value) => ({
              value,
              icon: value === 'all' ? null : <span className={`size-2 rounded-full ${LEVEL_DOTS[value]}`} aria-hidden />,
              text: value === 'all' ? t('projects.search.all') : t(`projects.difficulties.${value}`),
            }))}
            onChange={setLevel}
            testId="project-level"
          />
        </div>
        <p className="ml-auto text-sm whitespace-nowrap text-muted-foreground" role="status" data-testid="project-count">
          {t('projects.search.count', { count: visible.length })}
        </p>
      </div>
      {tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={t('projects.search.tags')} data-testid="project-tags">
          {tags.map((tag) => (
            <li key={tag} className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 py-0.5 pr-1 pl-3 text-sm font-medium text-primary">
              {tag}
              <button
                type="button"
                onClick={() => setTags(tags.filter((saved) => saved !== tag))}
                aria-label={t('projects.search.removeTag', { tag })}
                className="rounded-full p-0.5 hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Icon name="x" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {visible.length > 0 ? (
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,450px)] gap-4">
          {visible.map((card) => (
            <ProjectFlipCard key={card.id} card={card} language={language} blocked={blocked} onPlay={setConfirm} />
          ))}
        </div>
      ) : (
        <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center" data-testid="projects-empty">
          <Search className="size-6 text-muted-foreground" aria-hidden />
          <p className="font-semibold text-foreground">{t('projects.search.emptyTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('projects.search.emptyBody')}</p>
          <Button size="sm" className="mt-2" onClick={clearFilters}>
            <Icon name="rotateCcw" />
            {t('projects.search.clear')}
          </Button>
        </div>
      )}

      {confirm && (
        <Modal title={t('projects.confirmTitle', { name: confirm.details?.name[language] ?? confirm.id })} onClose={() => setConfirm(null)} data-testid="switch-dialog">
          <Notice>
            <p className="text-base leading-relaxed">{t('projects.confirmRemoved')}</p>
            <p className="mt-2 text-base leading-relaxed">{t('projects.confirmKept')}</p>
          </Notice>
          <div className="mt-5 flex justify-end gap-2 whitespace-nowrap" data-testid="switch-actions">
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
