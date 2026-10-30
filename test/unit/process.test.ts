import { describe, expect, it } from 'vitest';
import { CommandError, runChecked, runCommand } from '../../src/main/services/process.ts';

const print = (bytes: number) => ['-e', `process.stdout.write('x'.repeat(${bytes}))`];

describe('runCommand', () => {
  it('returns the whole output when it fits', async () => {
    const result = await runCommand(process.execPath, print(1000), { maxStdout: 1000 });
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(1000);
  });

  it('fails instead of cutting the output short when it is larger than maxStdout', async () => {
    const result = await runCommand(process.execPath, print(1024 * 1024), { maxStdout: 1000 });
    expect(result.code).not.toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toContain('larger than 1000 bytes');
    await expect(runChecked(runCommand, process.execPath, print(1024 * 1024), { maxStdout: 1000 })).rejects.toBeInstanceOf(CommandError);
  });
});
