import { describe, expect, it } from 'vitest';
import { GameError, contentError } from '../../src/main/game.ts';
import { IncompletePublicationError, UnsupportedFormatError } from '@bug-detective/catalog/contract';
import en from '../../src/renderer/src/locales/en.json' with { type: 'json' };
import pt from '../../src/renderer/src/locales/pt.json' with { type: 'json' };

describe('content errors', () => {
  it('turns an incomplete publication into its own error code', () => {
    const error = contentError(new IncompletePublicationError('no commit'));
    expect(error).toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe('incompletePublication');
  });

  it('keeps other errors as they are', () => {
    const other = new Error('network');
    expect(contentError(other)).toBe(other);
  });

  it('explains an incomplete publication in both languages', () => {
    expect(en.errors.incompletePublication).toBe("The project's publication is incomplete. Try again later.");
    expect(pt.errors.incompletePublication).toBe('A publicação do projeto está incompleta. Tente de novo mais tarde.');
  });

  it('turns a content format newer than the app into appTooOld, explained in both languages', () => {
    const error = contentError(new UnsupportedFormatError(2));
    expect((error as GameError).code).toBe('appTooOld');
    expect(en.errors.appTooOld).toBe('This project needs a newer version of Bug Detective. Update the app to play it.');
    expect(pt.errors.appTooOld).toBe('Este projeto precisa de uma versão mais nova do Bug Detective. Atualize o app para jogar.');
  });
});
