import { describe, expect, it } from 'vitest';
import { resolveBranchRef } from '../../src/main/services/content/git.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';

describe('resolveBranchRef', () => {
  it('tells how to get a missing ticket branch: fetch it, or build it with bd', async () => {
    const missing: CommandRunner = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: '', timedOut: false });
    const error = await resolveBranchRef(missing, 'git', '/repo', 'front-1').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('git -C /repo fetch origin');
    expect((error as Error).message).toContain('npx bd build');
    expect((error as Error).message).not.toContain('build-tickets.sh');
  });
});
