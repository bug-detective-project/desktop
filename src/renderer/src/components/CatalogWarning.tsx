import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { Button, Notice } from './ui.tsx';

/** The project list could not be refreshed (offline, or an invalid catalog): the last saved list shows, with a retry. */
export function CatalogWarning() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await api.loadProjects();
    } catch {
      // The warning stays while the refresh keeps failing.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="warn" data-testid="catalog-warning">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">{t('projects.catalogWarning')}</span>
        <Button size="sm" busy={busy} disabled={busy} onClick={() => void retry()} data-testid="catalog-retry">
          {t('projects.catalogRetry')}
        </Button>
      </div>
    </Notice>
  );
}
