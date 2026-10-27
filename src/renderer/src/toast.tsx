import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorInfo } from './api.ts';
import { ToastContext } from './toast-context.ts';
import type { ToastApi } from './toast-context.ts';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone']) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const value = useMemo<ToastApi>(
    () => ({
      info: (text) => push(text, 'info'),
      error: (error) => {
        const { code, message } = errorInfo(error);
        push(t([`errors.${code}`, 'errors.failed'], { message }), 'error');
      },
    }),
    [push, t],
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            data-testid={toast.tone === 'error' ? 'toast-error' : 'toast-info'}
            className={`pointer-events-auto rounded-xl border bg-popover px-4 py-3 text-base text-popover-foreground shadow-lg ${
              toast.tone === 'error' ? 'border-destructive/40 border-l-4 border-l-destructive' : 'border-border border-l-4 border-l-primary'
            }`}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
