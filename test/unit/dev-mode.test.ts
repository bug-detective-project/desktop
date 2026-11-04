import { describe, expect, it } from 'vitest';
import { isDevelopmentRun, userDataOverride } from '../../src/main/services/dev-mode.ts';

describe('what counts as a development run', () => {
  it('is pnpm run dev: the Vite server is what tells it from a build run from source', () => {
    expect(isDevelopmentRun({ packaged: false, env: { ELECTRON_RENDERER_URL: 'http://localhost:5173' } })).toBe(true);
  });

  it('is not pnpm run start: a build run from source behaves like the installed app', () => {
    expect(isDevelopmentRun({ packaged: false, env: {} })).toBe(false);
    expect(isDevelopmentRun({ packaged: false, env: { BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON: 'true' } })).toBe(false);
  });

  it('is never the installed app, whatever the environment says', () => {
    expect(isDevelopmentRun({ packaged: true, env: { ELECTRON_RENDERER_URL: 'http://localhost:5173', BUGDETECTIVE_E2E: '1' } })).toBe(false);
  });

  it('is the e2e tests, which cover the development tools, unless a test plays as a player', () => {
    expect(isDevelopmentRun({ packaged: false, env: { BUGDETECTIVE_E2E: '1' } })).toBe(true);
    expect(isDevelopmentRun({ packaged: false, env: { BUGDETECTIVE_E2E: '1', BUGDETECTIVE_E2E_PLAYER_RUN: '1' } })).toBe(false);
  });
});

describe('the data folder variable', () => {
  const env = { BUGDETECTIVE_USER_DATA: '/tmp/other' };

  it('is ignored by an installed app: nothing outside it chooses where its data lives', () => {
    expect(userDataOverride({ packaged: true, testBuild: false, env })).toBeUndefined();
  });

  it('works in the test build of the installer, and from source', () => {
    expect(userDataOverride({ packaged: true, testBuild: true, env })).toBe('/tmp/other');
    expect(userDataOverride({ packaged: false, testBuild: false, env })).toBe('/tmp/other');
  });

  it('leaves the default alone when it is not set', () => {
    expect(userDataOverride({ packaged: false, testBuild: false, env: {} })).toBeUndefined();
  });
});
