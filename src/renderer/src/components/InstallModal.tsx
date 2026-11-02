import { useTranslation } from 'react-i18next';
import { useToast } from '../toast-context.ts';
import { Icon } from './icons.tsx';
import { Button, LogView, Modal, Notice, Spinner } from './ui.tsx';

export type InstallPhase = 'running' | 'done' | 'failed';

/**
 * The download of the game environment, with its log. It cannot be dismissed while it runs; when
 * it ends, well or not, it stays open with the whole log (to read or copy) until "Close".
 */
export function InstallModal({ phase, lines, error, onClose }: { phase: InstallPhase; lines: string[]; error: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const copy = () =>
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => toast.info(t('dashboard.installModal.copied')),
      (failure: unknown) => toast.error(failure),
    );
  return (
    <Modal
      size="large"
      title={t('dashboard.installModal.title')}
      icon={<Icon name="download" className="size-5 text-primary" />}
      data-testid="install-modal"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {phase === 'failed' ? (
          <Notice tone="danger" data-testid="install-modal-error">
            {error}
          </Notice>
        ) : (
          <p className="flex items-center gap-2 text-base font-medium" data-testid="install-modal-status">
            {phase === 'running' ? <Spinner /> : <Icon name="checkCircle" className="size-4 text-emerald-500" />}
            {t(phase === 'running' ? 'dashboard.installModal.running' : 'dashboard.installModal.done')}
          </p>
        )}
        <LogView lines={lines} className="min-h-0 flex-1 select-text" follow={phase === 'running'} />
        {phase !== 'running' && (
          <div className="flex justify-end gap-2">
            <Button onClick={() => void copy()} data-testid="install-modal-copy">
              {t('dashboard.installModal.copy')}
            </Button>
            <Button variant="primary" onClick={onClose} data-testid="install-modal-close">
              {t('dashboard.installModal.close')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
