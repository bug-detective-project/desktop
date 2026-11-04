import { useTranslation } from 'react-i18next';
import { useToast } from '../toast-context.ts';
import { Icon } from './icons.tsx';
import { Button, LogView, Modal, Notice, Spinner } from './ui.tsx';

export type InstallPhase = 'running' | 'done' | 'failed';
/** What is being downloaded: the game environment (images) or a ticket (its code and package). */
export type InstallKind = 'environment' | 'ticket';

/**
 * A download with its log: the game environment, or a ticket. It cannot be dismissed while it
 * runs; when it ends, well or not, it stays open with the whole log (to read or copy) until "Close".
 */
export function InstallModal({
  kind = 'environment',
  phase,
  lines,
  error,
  onClose,
  onRetry,
}: {
  kind?: InstallKind;
  phase: InstallPhase;
  lines: string[];
  error: string | null;
  onClose: () => void;
  /** A failure worth repeating as it is (no internet, GitHub's limit): "Try again" runs the same download. */
  onRetry?: (() => void) | null;
}) {
  const { t } = useTranslation();
  const text = kind === 'ticket' ? 'dashboard.ticketModal' : 'dashboard.installModal';
  const toast = useToast();
  const copy = () =>
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => toast.info(t('dashboard.installModal.copied')),
      (failure: unknown) => toast.error(failure),
    );
  return (
    <Modal
      size="large"
      title={t(`${text}.title`)}
      icon={<Icon name="download" className="size-5 text-primary" />}
      data-testid="install-modal"
      data-kind={kind}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {phase === 'failed' && (
          <Notice tone="danger" data-testid="install-modal-error">
            {error}
          </Notice>
        )}
        {phase === 'done' && (
          <Notice tone="success" data-testid="install-modal-status">
            {t(`${text}.done`)}
          </Notice>
        )}
        {phase === 'running' && (
          <p className="flex items-center gap-2 text-base font-medium" data-testid="install-modal-status">
            <Spinner />
            {t(`${text}.running`)}
          </p>
        )}
        <LogView lines={lines} className="min-h-0 flex-1 select-text" follow={phase === 'running'} />
        {phase !== 'running' && (
          <div className="flex justify-end gap-2">
            {phase === 'failed' && onRetry && (
              <Button variant="primary" onClick={onRetry} data-testid="install-modal-retry">
                {t('dashboard.installModal.retry')}
              </Button>
            )}
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
