import { describe, expect, it } from 'vitest';
import { StateVersionError } from '../../src/main/services/state.ts';
import { startupErrorText } from '../../src/main/startup-error.ts';

describe('startupErrorText', () => {
  it('says in the system language that a newer version saved the game', () => {
    const error = new StateVersionError('The saved game was created by a newer version of Bug Detective (schema 99)');
    expect(startupErrorText('en-US', error)).toEqual({
      title: 'Bug Detective could not start',
      body: 'Your saved game was created by a newer version of Bug Detective. Update the app to keep playing.',
    });
    expect(startupErrorText('pt-BR', error)).toEqual({
      title: 'O Bug Detective não conseguiu abrir',
      body: 'O seu jogo salvo foi criado por uma versão mais nova do Bug Detective. Atualize o app para continuar jogando.',
    });
  });

  it('keeps any other reason as a detail under a translated sentence', () => {
    expect(startupErrorText('pt', new Error('EACCES: permission denied'))).toEqual({
      title: 'O Bug Detective não conseguiu abrir',
      body: 'Algo deu errado ao abrir o app.\n\nEACCES: permission denied',
    });
    expect(startupErrorText('fr-FR', 'boom').body).toBe('Something went wrong while opening the app.\n\nboom');
  });
});
