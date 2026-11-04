import { useTranslation } from 'react-i18next';
import { qaMessage } from '@shared/qaMessages.ts';
import type { QaComment as Comment } from '@shared/types.ts';
import { Icon } from './icons.tsx';
import { Badge } from './ui.tsx';

const TONE = {
  gate1Failed: 'danger',
  gate2Failed: 'danger',
  timeout: 'danger',
  outOfMemory: 'danger',
  passed: 'ok',
  interrupted: 'warn',
  error: 'warn',
  branchWarning: 'warn',
} as const;

/** One QA comment; with defaultOpen, the dropdown of that run's errors starts expanded (the latest run). */
export function QaCommentView({ comment, defaultOpen = false }: { comment: Comment; defaultOpen?: boolean }) {
  const { t, i18n } = useTranslation();
  const message = qaMessage(comment);
  return (
    <article className="rounded-lg border border-border bg-card p-4" data-testid="qa-comment" data-kind={comment.kind}>
      <header className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        {/* Players do not know QA gates: the badge says whether the tests failed or passed. */}
        <Badge tone={TONE[message.key]}>
          {TONE[message.key] === 'danger' ? t('qa.badge.failed') : message.key === 'passed' ? t('qa.badge.passed') : 'QA'}
        </Badge>
        <time>{new Date(comment.at).toLocaleString(i18n.language === 'pt' ? 'pt-BR' : 'en-US')}</time>
      </header>
      <p className="text-base">{t(`qa.comment.${message.key}`, message.params)}</p>
      {(message.failing.length > 0 || message.unfinished.length > 0) && (
        // The errors of one QA run, grouped in a dropdown under that run's comment.
        <details className="group mt-3 rounded-lg border border-border" open={defaultOpen} data-testid="qa-errors">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold text-foreground select-none hover:bg-muted [&::-webkit-details-marker]:hidden">
            <Icon name="chevronDown" className="size-4 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0" />
            {t('qa.errors', { count: message.failing.length + message.unfinished.length })}
          </summary>
          <div className="space-y-3 border-t border-border px-3 py-3">
            {message.failing.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-muted-foreground">{t('qa.failingTests')}</p>
                <ul className="mt-1 space-y-2">
                  {message.failing.map((test) => (
                    <li key={test.name} data-testid="qa-failing-test">
                      <p className="text-base font-medium">• {test.name}</p>
                      {test.error && (
                        <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-sm whitespace-pre-wrap text-muted-foreground">{test.error}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {message.unfinished.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-muted-foreground">{t('qa.unfinishedTests')}</p>
                <ul className="mt-1 list-disc pl-5 text-base">
                  {message.unfinished.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </article>
  );
}
