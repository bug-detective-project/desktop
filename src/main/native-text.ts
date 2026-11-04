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
  },
  pt: {
    exportProgress: 'Exportar progresso',
    restoreProgress: 'Restaurar progresso',
    saveFilter: 'Save do Bug Detective',
    projectsCatalog: 'Catálogo de projetos',
    projectQaFolder: 'Pasta qa do projeto',
  },
} as const satisfies Record<Language, Record<string, string>>;

export type NativeTextKey = keyof (typeof TEXTS)['en'];

export const NATIVE_TEXTS: Record<Language, Record<NativeTextKey, string>> = TEXTS;

export function nativeText(language: Language, key: NativeTextKey): string {
  return (TEXTS[language] ?? TEXTS.en)[key];
}
