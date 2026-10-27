import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Links and images never load anything: the app shows no remote content.
const components: Components = {
  a: ({ children }) => <span className="font-medium text-primary underline decoration-dotted">{children}</span>,
  img: ({ alt }) => <span className="text-muted-foreground">[{alt}]</span>,
  h1: ({ children }) => <h1 className="mb-3 text-xl font-bold tracking-tight text-foreground">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-base font-bold tracking-tight text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-sm font-semibold text-foreground">{children}</h3>,
  p: ({ children }) => <p className="mb-3 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  ul: ({ children }) => <ul className="mb-4 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1.5 pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-4 border-border pl-3">{children}</blockquote>,
  code: ({ children, className }) =>
    className ? (
      <code className={`${className} block overflow-x-auto rounded-lg border border-border/60 bg-muted p-3 font-mono text-xs text-foreground`}>{children}</code>
    ) : (
      <code className="rounded border border-border/60 bg-muted px-1.5 py-0.5 font-mono text-[0.85em] font-semibold text-foreground">{children}</code>
    ),
  table: ({ children }) => <table className="my-3 w-full border-collapse">{children}</table>,
  th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-medium text-foreground">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  input: ({ checked }) => <input type="checkbox" checked={checked} readOnly disabled className="mr-1.5 align-middle accent-primary" />,
};

/** GitHub-flavored markdown. Body text is muted; emphasis and code stand out in the foreground color. */
export function Markdown({ children, testId, className = 'text-sm' }: { children: string; testId?: string; className?: string }) {
  return (
    <div className={`text-muted-foreground [&>*:last-child]:mb-0 ${className}`} data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
