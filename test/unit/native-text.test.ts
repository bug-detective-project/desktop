import { describe, expect, it } from 'vitest';
import { NATIVE_TEXTS, nativeText } from '../../src/main/native-text.ts';

describe('native texts', () => {
  it('has the same keys in both languages, none empty', () => {
    expect(Object.keys(NATIVE_TEXTS.pt).sort()).toEqual(Object.keys(NATIVE_TEXTS.en).sort());
    for (const texts of Object.values(NATIVE_TEXTS)) {
      for (const value of Object.values(texts)) expect(value.trim()).not.toBe('');
    }
  });

  it('answers in the language asked, English for an unknown one', () => {
    expect(nativeText('pt', 'exportProgress')).toBe('Exportar progresso');
    expect(nativeText('en', 'exportProgress')).toBe('Export progress');
    expect(nativeText('xx' as 'en', 'saveFilter')).toBe('Bug Detective save');
  });
});
