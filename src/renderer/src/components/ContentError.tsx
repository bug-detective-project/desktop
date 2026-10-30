import { useTranslation } from 'react-i18next';
import { Icon } from './icons.tsx';
import { Button } from './ui.tsx';

/** Shown where the ticket's texts go when they could not be loaded. */
export function ContentError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-base" data-testid="content-error">
      <Icon name="alertTriangle" className="size-4 text-destructive" />
      <span className="text-foreground">{t('common.contentFailed')}</span>
      <Button size="sm" onClick={onRetry} data-testid="content-retry">
        {t('common.retry')}
      </Button>
    </div>
  );
}
