import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { Button } from './ui.tsx';

/** The screen shown instead of a blank window when a render threw; the error went to the log file. */
function CrashScreen({ error }: { error: Error }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    api
      .diagnostics()
      .catch((cause: Error) => `diagnostics failed: ${cause.message}`)
      .then((text) => navigator.clipboard.writeText(`${text}\n## Renderer error\n${error.message}\n${error.stack ?? ''}\n`))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <main className="flex h-full min-h-screen items-center justify-center bg-background p-8 text-foreground" data-testid="error-boundary">
      <div className="max-w-lg space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('crash.title')}</h1>
        <p className="text-base text-muted-foreground">{t('crash.text')}</p>
        <p className="rounded-lg border border-border bg-card p-3 font-mono text-xs text-muted-foreground" data-testid="error-boundary-message">
          {error.message}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => location.reload()} data-testid="reload-app">
            {t('crash.reload')}
          </Button>
          <Button onClick={copy} data-testid="copy-crash-diagnostics">
            {copied ? t('crash.copied') : t('crash.copy')}
          </Button>
        </div>
      </div>
    </main>
  );
}

/** Catches a render error anywhere below, reports it to the main process and shows the crash screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void api.reportRendererError(error.message.slice(0, 2000), `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 20_000)).catch(() => {});
  }

  render() {
    return this.state.error ? <CrashScreen error={this.state.error} /> : this.props.children;
  }
}

/** e2e only: a render error on demand (window event "bugdetective:e2e-throw"), to test the boundary. */
export function E2eThrow({ enabled }: { enabled: boolean }) {
  const [boom, setBoom] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = () => setBoom(true);
    window.addEventListener('bugdetective:e2e-throw', handler);
    return () => window.removeEventListener('bugdetective:e2e-throw', handler);
  }, [enabled]);
  if (boom) {
    throw new Error('e2e: a render error on purpose');
  }
  return null;
}
