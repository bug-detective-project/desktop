/**
 * The dialog of a start that failed. It shows before the saved settings load, so it follows the
 * system language (Portuguese for any pt locale, English otherwise).
 */
import { StateVersionError } from './services/state.ts';

const TEXT = {
  en: {
    title: 'Bug Detective could not start',
    newerVersion: 'Your saved game was created by a newer version of Bug Detective. Update the app to keep playing.',
    failed: 'Something went wrong while opening the app.',
  },
  pt: {
    title: 'O Bug Detective não conseguiu abrir',
    newerVersion: 'O seu jogo salvo foi criado por uma versão mais nova do Bug Detective. Atualize o app para continuar jogando.',
    failed: 'Algo deu errado ao abrir o app.',
  },
};

export function startupErrorText(locale: string, error: unknown): { title: string; body: string } {
  const text = locale.toLowerCase().startsWith('pt') ? TEXT.pt : TEXT.en;
  if (error instanceof StateVersionError && /newer version/.test(error.message)) {
    return { title: text.title, body: text.newerVersion };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { title: text.title, body: `${text.failed}\n\n${detail}` };
}
