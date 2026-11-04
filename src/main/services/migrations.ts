/**
 * The chains that bring what older released versions wrote up to date: one step per version, vN to
 * vN+1, keyed by N. A state step returns the state with its new schemaVersion. test/unit/migrations.test.ts
 * fails when SCHEMA_VERSION or SAVE_FORMAT_VERSION passes the released one without a step, and each
 * step gets a test of its own.
 */
export type Migration = (value: unknown) => unknown;
export type MigrationChain = Readonly<Record<number, Migration>>;

/** Runs on a state.json, of the game or of a save, before it is validated. */
export const STATE_MIGRATIONS: MigrationChain = {};

/** Runs on a save's entries (a Map of path to file), after their checksums are verified. */
export const SAVE_MIGRATIONS: MigrationChain = {};

export function canMigrate(from: number, to: number, chain: MigrationChain): boolean {
  for (let version = from; version < to; version += 1) {
    if (!chain[version]) {
      return false;
    }
  }
  return true;
}

export function migrate(value: unknown, from: number, to: number, chain: MigrationChain): unknown {
  let current = value;
  for (let version = from; version < to; version += 1) {
    const step = chain[version];
    if (!step) {
      throw new Error(`There is no migration from version ${version}`);
    }
    current = step(current);
  }
  return current;
}
