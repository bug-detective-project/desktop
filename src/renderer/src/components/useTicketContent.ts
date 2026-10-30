import { useEffect, useState } from 'react';
import type { TicketContent } from '@shared/api.ts';
import type { Language, TicketState } from '@shared/types.ts';
import { api } from '../api.ts';
import { useToast } from '../toast-context.ts';

/**
 * Loads the ticket's texts again whenever the ticket, its progress or the language changes. A
 * failed load (a damaged package, for example) is reported and can be retried.
 */
export function useTicketContent(ticket: TicketState, language: Language) {
  const reportError = useToast().error;
  const [content, setContent] = useState<TicketContent | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { ticket: number, status, hintsRevealed, solutionRevealed } = ticket;
  useEffect(() => {
    let ignore = false;
    api
      .ticketContent(number, language)
      .then((loaded) => {
        if (ignore) return;
        setContent(loaded);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setFailed(true);
        reportError(error);
      });
    return () => {
      ignore = true;
    };
    // status, hints and solution decide what the main process returns, so they trigger a reload.
  }, [number, language, status, hintsRevealed, solutionRevealed, attempt, reportError]);
  const retry = () => {
    setFailed(false);
    setAttempt((current) => current + 1);
  };
  return { content, failed, retry };
}
