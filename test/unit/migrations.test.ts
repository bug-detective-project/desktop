import { describe, expect, it } from 'vitest';
import { SAVE_FORMAT_VERSION } from '../../src/main/services/backup.ts';
import { SAVE_MIGRATIONS, STATE_MIGRATIONS, canMigrate, migrate } from '../../src/main/services/migrations.ts';
import { RELEASED_SAVE_FORMAT_VERSION, RELEASED_SCHEMA_VERSION, SCHEMA_VERSION } from '../../src/shared/types.ts';

describe('the migration chains from the released versions', () => {
  it('has a step for every state schema since the released one: a schema change needs its migration', () => {
    expect(canMigrate(RELEASED_SCHEMA_VERSION, SCHEMA_VERSION, STATE_MIGRATIONS)).toBe(true);
  });

  it('has a step for every save format since the released one', () => {
    expect(canMigrate(RELEASED_SAVE_FORMAT_VERSION, SAVE_FORMAT_VERSION, SAVE_MIGRATIONS)).toBe(true);
  });
});

describe('a chain', () => {
  const chain = {
    1: (value: unknown) => ({ ...(value as object), two: true, schemaVersion: 2 }),
    2: (value: unknown) => ({ ...(value as object), three: true, schemaVersion: 3 }),
  };

  it('runs every step in order, and nothing when the version is current', () => {
    expect(migrate({ schemaVersion: 1 }, 1, 3, chain)).toEqual({ schemaVersion: 3, two: true, three: true });
    expect(migrate({ schemaVersion: 2 }, 2, 3, chain)).toEqual({ schemaVersion: 3, three: true });
    expect(migrate({ schemaVersion: 3 }, 3, 3, chain)).toEqual({ schemaVersion: 3 });
  });

  it('cannot cross a missing step', () => {
    expect(canMigrate(1, 3, chain)).toBe(true);
    expect(canMigrate(1, 4, chain)).toBe(false);
    expect(canMigrate(0, 3, chain)).toBe(false);
    expect(canMigrate(3, 3, chain)).toBe(true);
    expect(() => migrate({}, 1, 4, chain)).toThrow(/no migration from version 3/);
  });
});
