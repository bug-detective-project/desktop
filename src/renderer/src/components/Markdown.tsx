import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** A task list item's box ("- [x]"): read-only, and named for screen readers. */
function TaskCheckbox({ checked }: { checked: boolean }) {
  const { t } = useTranslation();
  return <input type="checkbox" checked={checked} readOnly disabled aria-label={t(checked ? 'markdown.taskDone' : 'markdown.taskOpen')} className="mr-1.5 align-middle accent-primary" />;
}

// Links and images never load anything: the app shows no remote content.
const components: Components = {
  a: ({ children }) => <span className="font-medium text-primary underline decoration-dotted">{children}</span>,
  img: ({ alt }) => <span className="text-muted-foreground">[{alt}]</span>,
  h1: ({ children }) => <h1 className="mb-3 text-2xl font-bold tracking-tight text-foreground">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-lg font-bold tracking-tight text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold text-foreground">{children}</h3>,
  p: ({ children }) => <p className="mb-3 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  ul: ({ children }) => <ul className="mb-4 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1.5 pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-4 border-border pl-3">{children}</blockquote>,
  code: ({ children, className }) =>
    className ? (
      <code className={`${className} block overflow-x-auto rounded-lg border border-border/60 bg-muted p-3 font-mono text-sm text-foreground`}>{children}</code>
    ) : (
      <code className="rounded border border-border/60 bg-muted px-1.5 py-0.5 font-mono text-[0.85em] font-semibold text-foreground">{children}</code>
    ),
  table: ({ children }) => <table className="my-3 w-full border-collapse">{children}</table>,
  th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-medium text-foreground">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  input: ({ checked }) => <TaskCheckbox checked={checked ?? false} />,
};

type HastNode = NonNullable<ExtraProps['node']>['children'][number];

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(textOf).join('') : '';
}

/** Replaces the value cell of two-column "field | value" rows when fieldValue returns something for that field. */
function fieldRow(fieldValue: (field: string, value: string) => ReactNode | undefined): Components['tr'] {
  return function FieldRow({ node, children }) {
    const cells = node?.children.filter((child) => child.type === 'element') ?? [];
    const [field, value] = cells.map((cell) => textOf(cell).trim());
    const custom = cells.length === 2 && cells[0].tagName === 'td' ? fieldValue(field, value) : undefined;
    if (custom === undefined) return <tr>{children}</tr>;
    return (
      <tr>
        <td className="border border-border px-2 py-1">{field}</td>
        <td className="border border-border px-2 py-1">{custom}</td>
      </tr>
    );
  };
}

/** GitHub-flavored markdown. Body text is muted; emphasis and code stand out in the foreground color. */
export function Markdown({
  children,
  testId,
  className = 'text-base',
  fieldValue,
}: {
  children: string;
  testId?: string;
  className?: string;
  fieldValue?: (field: string, value: string) => ReactNode | undefined;
}) {
  return (
    <div className={`text-muted-foreground [&>*:last-child]:mb-0 ${className}`} data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={fieldValue ? { ...components, tr: fieldRow(fieldValue) } : components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
