import { describe, expect, it } from 'vitest';
import { GameError, contentError } from '../../src/main/game.ts';
import { GitHubContentSource, NoConnectionError, ProjectUnavailableError, RateLimitedError, retryAfterSeconds } from '../../src/main/services/content/github.ts';
import { IncompletePublicationError, UnsupportedFormatError } from '@bug-detective/catalog/contract';
import en from '../../src/renderer/src/locales/en.json' with { type: 'json' };
import pt from '../../src/renderer/src/locales/pt.json' with { type: 'json' };

describe('content errors', () => {
  it('turns an incomplete publication into its own error code', () => {
    const error = contentError(new IncompletePublicationError('no commit'));
    expect(error).toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe('incompletePublication');
  });

  it('turns no connection, GitHub\'s limit and a missing project into their own codes, explained in both languages', () => {
    expect((contentError(new NoConnectionError('fetch failed')) as GameError).code).toBe('noConnection');
    expect((contentError(new RateLimitedError('429', 120)) as GameError).code).toBe('githubRateLimited');
    expect((contentError(new ProjectUnavailableError('owner/demo', 'qa')) as GameError).code).toBe('projectUnavailable');
    for (const texts of [en, pt]) {
      for (const key of ['noConnection', 'githubRateLimited', 'projectUnavailable'] as const) expect(texts.errors[key].trim()).not.toBe('');
    }
    expect(en.errors.noConnection).toBe('No internet connection. Connect and try again.');
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

describe('download errors', () => {
  const sleeps: number[] = [];
  const source = (fetchImpl: (url: string) => Promise<Response>) =>
    new GitHubContentSource({
      repository: 'owner/demo',
      project: 'demo',
      retries: 2,
      fetch: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterSeconds('30')).toBe(30);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('not a date')).toBeNull();
    const now = Date.parse('2026-11-04T10:00:00Z');
    expect(retryAfterSeconds('Wed, 04 Nov 2026 10:00:45 GMT', now)).toBe(45);
  });

  it('waits what a 429 asks and then succeeds, without really waiting', async () => {
    sleeps.length = 0;
    let calls = 0;
    const data = await source(async () => (calls++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : new Response('zip'))).download('https://github.com/x.zip');
    expect(Buffer.from(data).toString()).toBe('zip');
    expect(sleeps).toEqual([3000]);
  });

  it('gives up as rate limited when the wait would pass a minute', async () => {
    sleeps.length = 0;
    await expect(source(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } })).download('https://github.com/x.zip')).rejects.toBeInstanceOf(RateLimitedError);
    expect(sleeps).toEqual([]);
  });

  it('reports no connection when every attempt fails on the network', async () => {
    sleeps.length = 0;
    await expect(
      source(async () => {
        throw new TypeError('fetch failed');
      }).download('https://github.com/x.zip'),
    ).rejects.toBeInstanceOf(NoConnectionError);
    expect(sleeps).toHaveLength(2);
  });

  it('reports the project unavailable when neither the qa branch nor the tag exists', async () => {
    await expect(source(async () => new Response('', { status: 404 })).prepare()).rejects.toBeInstanceOf(ProjectUnavailableError);
  });
});
