import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changedLines, parseDiff, splitRows, visibleFiles } from './diff.ts';
import type { DiffFile, SplitCell } from './diff.ts';
import { Icon } from './icons.tsx';
import { Badge } from './ui.tsx';

/** Files with more changed lines than this start collapsed, with a "Load diff" button. */
export const LARGE_DIFF_LINES = 2000;

export interface SplitLabels {
  left: string;
  right: string;
  /** A file that exists only on the left (old) side, or only on the right (new) side. */
  onlyLeft: string;
  onlyRight: string;
}

const CELL: Record<SplitCell['kind'], string> = {
  context: 'text-foreground',
  del: 'bg-rose-500/12 text-rose-900 dark:text-rose-200',
  add: 'bg-emerald-500/12 text-emerald-900 dark:text-emerald-200',
  empty: 'bg-muted/50',
};
const NUMBER: Record<SplitCell['kind'], string> = {
  context: 'text-muted-foreground',
  del: 'bg-rose-500/18 text-rose-900 dark:text-rose-200/70',
  add: 'bg-emerald-500/18 text-emerald-900 dark:text-emerald-200/70',
  empty: 'bg-muted/50',
};

function fileId(testId: string, index: number) {
  return `${testId}-file-${index}`;
}

function StatusBadge({ file, labels }: { file: DiffFile; labels: SplitLabels }) {
  const { t } = useTranslation();
  if (file.status === 'deleted') return <Badge>{labels.onlyLeft}</Badge>;
  if (file.status === 'added') return <Badge tone="brand">{labels.onlyRight}</Badge>;
  if (file.status === 'renamed') return <Badge>{t('comparison.renamed')}</Badge>;
  return null;
}

function Counts({ file }: { file: DiffFile }) {
  const { added, removed } = changedLines(file);
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-rose-700 dark:text-rose-400">−{removed}</span> <span className="text-emerald-700 dark:text-emerald-400">+{added}</span>
    </span>
  );
}

function Cell({ cell }: { cell: SplitCell }) {
  return (
    <>
      <td className={`border-r border-border/60 pr-2 text-right align-top select-none ${NUMBER[cell.kind]}`}>{cell.number ?? ''}</td>
      <td className={`pr-3 pl-2 align-top break-all whitespace-pre-wrap ${CELL[cell.kind]}`}>{cell.text}</td>
    </>
  );
}

function FileDiff({ file, labels, id, open, onToggle }: { file: DiffFile; labels: SplitLabels; id: string; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { added, removed } = changedLines(file);
  const [loaded, setLoaded] = useState(added + removed <= LARGE_DIFF_LINES);
  const name = file.status === 'deleted' ? file.oldPath : file.path;
  return (
    <section id={id} className="overflow-hidden rounded-lg border border-border" data-testid="comparison-file" data-path={name} data-status={file.status}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-border bg-muted px-3 py-2 text-left hover:bg-muted/80"
      >
        <Icon name="chevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">
          {file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : name}
        </span>
        <StatusBadge file={file} labels={labels} />
        {!file.binary && <Counts file={file} />}
      </button>
      {open &&
        (file.binary ? (
          <p className="px-3 py-3 text-sm text-muted-foreground" data-testid="binary-file">
            {t('comparison.binary')}
          </p>
        ) : !loaded ? (
          <div className="flex items-center justify-between gap-3 px-3 py-3 text-sm text-muted-foreground">
            {t('comparison.large', { count: added + removed })}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => setLoaded(true)} data-testid="load-diff">
              {t('comparison.loadDiff')}
            </button>
          </div>
        ) : file.lines.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">{t('comparison.noLineChanges')}</p>
        ) : (
          <div>
            <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
              {/* Long lines wrap inside their own pane, so the two sides never overlap. */}
              <colgroup>
                <col className="w-14" />
                <col />
                <col className="w-14" />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold text-muted-foreground">
                  <th colSpan={2} className="px-3 py-1 font-sans">
                    {labels.left}
                  </th>
                  <th colSpan={2} className="border-l border-border px-3 py-1 font-sans">
                    {labels.right}
                  </th>
                </tr>
              </thead>
              <tbody>
                {splitRows(file.lines).map((row, index) =>
                  row.kind === 'hunk' ? (
                    <tr key={index} className="bg-primary/10 text-muted-foreground" data-kind="hunk">
                      <td colSpan={4} className="px-3 py-0.5 whitespace-pre">
                        {row.text}
                      </td>
                    </tr>
                  ) : (
                    <tr key={index} data-testid="split-row" data-left={row.left.kind} data-right={row.right.kind}>
                      <Cell cell={row.left} />
                      <Cell cell={row.right} />
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

/**
 * A pull-request style "Files changed" view of a unified diff: the file list, then one collapsible
 * split diff per file. Both panes of a file always show that same file (matched by path, as git
 * pairs them), whatever the number and structure of the files on each side.
 */
export function SplitDiff({ diff, labels, testId }: { diff: string; labels: SplitLabels; testId: string }) {
  const { t } = useTranslation();
  const files = visibleFiles(parseDiff(diff));
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const toggle = (index: number) =>
    setClosed((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  const show = (index: number) => {
    setClosed((current) => {
      const next = new Set(current);
      next.delete(index);
      return next;
    });
    document.getElementById(fileId(testId, index))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="rounded-lg border border-border" data-testid={`${testId}-files`}>
        <p className="border-b border-border px-3 py-2 text-sm font-semibold text-foreground">{t('comparison.files', { count: files.length })}</p>
        <ul className="divide-y divide-border/60">
          {files.map((file, index) => (
            <li key={`${file.oldPath}:${file.path}`}>
              <button type="button" onClick={() => show(index)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{file.status === 'deleted' ? file.oldPath : file.path}</span>
                <StatusBadge file={file} labels={labels} />
                {!file.binary && <Counts file={file} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {files.map((file, index) => (
        <FileDiff
          key={`${file.oldPath}:${file.path}`}
          file={file}
          labels={labels}
          id={fileId(testId, index)}
          open={!closed.has(index)}
          onToggle={() => toggle(index)}
        />
      ))}
    </div>
  );
}
