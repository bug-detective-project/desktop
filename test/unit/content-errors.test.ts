import { describe, expect, it } from 'vitest';
import { GameError, contentError } from '../../src/main/game.ts';
import { IncompletePublicationError } from '../../src/main/services/content/source.ts';
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
});
