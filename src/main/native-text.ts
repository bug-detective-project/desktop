/**
 * The texts of the native windows (file dialogs, and the dialogs of the main process): the
 * renderer's i18n does not reach them, so they come from this dictionary, in the language the
 * player chose in the settings.
 */
import type { Language } from '../shared/types.ts';

const TEXTS = {
  en: {
    exportProgress: 'Export progress',
    restoreProgress: 'Restore progress',
    saveFilter: 'Bug Detective save',
    projectsCatalog: 'Projects catalog',
    projectQaFolder: 'Project qa folder',
    rendererGoneTitle: 'Bug Detective',
    rendererGone: 'The Bug Detective window stopped. Your progress is saved.',
    unresponsiveTitle: 'Not responding',
    unresponsive: 'The Bug Detective window is not responding. Your progress is saved.',
    reload: 'Reload',
    copyDiagnostics: 'Copy diagnostics',
    quit: 'Quit',
    wait: 'Wait',
  },
  pt: {
    exportProgress: 'Exportar progresso',
    restoreProgress: 'Restaurar progresso',
    saveFilter: 'Save do Bug Detective',
    projectsCatalog: 'Catálogo de projetos',
    projectQaFolder: 'Pasta qa do projeto',
    rendererGoneTitle: 'Bug Detective',
    rendererGone: 'A janela do Bug Detective parou. Seu progresso está salvo.',
    unresponsiveTitle: 'Sem resposta',
    unresponsive: 'A janela do Bug Detective não está respondendo. Seu progresso está salvo.',
    reload: 'Recarregar',
    copyDiagnostics: 'Copiar diagnóstico',
    quit: 'Sair',
    wait: 'Aguardar',
  },
} as const satisfies Record<Language, Record<string, string>>;

export type NativeTextKey = keyof (typeof TEXTS)['en'];

export const NATIVE_TEXTS: Record<Language, Record<NativeTextKey, string>> = TEXTS;

export function nativeText(language: Language, key: NativeTextKey): string {
  return (TEXTS[language] ?? TEXTS.en)[key];
}
