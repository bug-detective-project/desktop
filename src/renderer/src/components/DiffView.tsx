import { useTranslation } from 'react-i18next';
import { parseDiff } from './diff.ts';

const ROW = {
  add: 'bg-emerald-500/12 text-emerald-900 dark:text-emerald-200',
  del: 'bg-rose-500/12 text-rose-900 dark:text-rose-200',
  context: 'text-foreground',
  hunk: 'bg-primary/10 text-muted-foreground',
};
const SIGN = { add: '+', del: '−', context: ' ', hunk: '' };

export function DiffView({ diff, testId, emptyText }: { diff: string | null; testId?: string; emptyText?: string }) {
  const { t } = useTranslation();
  const files = diff ? parseDiff(diff) : [];
  if (files.length === 0) {
    return (
      <p className="text-base text-muted-foreground" data-testid={testId}>
        {emptyText ?? t('diff.empty')}
      </p>
    );
  }
  return (
    <div className="space-y-4" data-testid={testId}>
      {files.map((file) => (
        <div key={file.path} className="overflow-hidden rounded-lg border border-border">
          <div className="border-b border-border bg-muted px-3 py-1.5 font-mono text-sm font-semibold text-foreground">{file.path}</div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-sm leading-5">
              <tbody>
                {file.lines.map((line, index) => (
                  <tr key={index} className={ROW[line.kind]} data-kind={line.kind}>
                    <td className="w-10 pr-2 text-right text-muted-foreground/70 select-none">{line.oldNumber ?? ''}</td>
                    <td className="w-10 pr-2 text-right text-muted-foreground/70 select-none">{line.newNumber ?? ''}</td>
                    <td className="w-4 select-none">{SIGN[line.kind]}</td>
                    <td className="pr-4 whitespace-pre">{line.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
