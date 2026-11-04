/**
 * Whether this run has the development tools (DevTools, desktop/.env, catalog.local.json, the
 * BUGDETECTIVE_DEV_* switches, Settings → Development). Only `pnpm run dev` has them: a production
 * build run from source (`pnpm run start`) behaves like the installed app. The e2e tests run the
 * build too and cover those tools, except when a test plays as a player.
 */
export function isDevelopmentRun(options: { packaged: boolean; env: NodeJS.ProcessEnv | Record<string, string | undefined> }): boolean {
  const { packaged, env } = options;
  if (packaged) {
    return false;
  }
  if (env.BUGDETECTIVE_E2E === '1') {
    return env.BUGDETECTIVE_E2E_PLAYER_RUN !== '1';
  }
  return env.ELECTRON_RENDERER_URL !== undefined;
}

/**
 * BUGDETECTIVE_USER_DATA, the data folder of the tests and the clean-profile checks. An installed
 * app ignores it, unless it is the installer's test build (pnpm run dist:win:test).
 */
export function userDataOverride(options: { packaged: boolean; testBuild: boolean; env: NodeJS.ProcessEnv | Record<string, string | undefined> }): string | undefined {
  const { packaged, testBuild, env } = options;
  return !packaged || testBuild ? env.BUGDETECTIVE_USER_DATA || undefined : undefined;
}
