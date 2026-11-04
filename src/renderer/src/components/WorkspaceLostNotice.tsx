import { useTranslation } from 'react-i18next'
import { Button, Notice } from './ui.tsx'

/**
 * The workspace has no repository although tickets were unlocked (its volume was removed outside
 * the game): the player recreates the code of every ticket, or restores a backup instead.
 */
export function WorkspaceLostNotice({ busy, onRebuild, onRestore }: { busy: boolean; onRebuild: () => void; onRestore: () => void }) {
  const { t } = useTranslation()
  return (
    <Notice
      tone="danger"
      data-testid="workspace-lost"
    >
      <p className="font-semibold">{t('dashboard.workspaceLost.title')}</p>
      <p className="mt-1 text-sm">{t('dashboard.workspaceLost.text')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={busy}
          onClick={onRebuild}
          data-testid="rebuild-workspace"
        >
          {busy ? t('dashboard.workspaceLost.rebuilding') : t('dashboard.workspaceLost.rebuild')}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={onRestore}
          data-testid="restore-backup-instead"
        >
          {t('dashboard.workspaceLost.restore')}
        </Button>
      </div>
    </Notice>
  )
}
