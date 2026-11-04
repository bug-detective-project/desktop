import { describe, expect, it } from 'vitest';
import { GIT_FLAGS, WORKSPACE_SCRIPTS } from '../../src/main/services/workspace.ts';

describe('the workspace scripts', () => {
  it('every script defines git without the repository hooks and fsmonitor, right after set -eu', () => {
    for (const [name, script] of Object.entries(WORKSPACE_SCRIPTS)) {
      expect(script.startsWith('set -eu\ngit() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }\n'), name).toBe(true);
    }
  });

  it('no script sets the hooks path by itself any more, and the class flags match the wrapper', () => {
    for (const script of Object.values(WORKSPACE_SCRIPTS)) {
      expect(script.replace(/^.*\n.*\n/, '')).not.toContain('core.hooksPath');
    }
    expect(GIT_FLAGS).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  });

  it('sanitizeRepository removes hooks, the fsmonitor, command settings and filter or diff drivers', () => {
    const script = WORKSPACE_SCRIPTS.sanitizeRepository;
    expect(script).toContain('rm -rf .git/hooks/*');
    for (const key of ['core.fsmonitor', 'core.sshCommand', 'core.pager', 'core.editor']) expect(script).toContain(key);
    expect(script).toContain('--remove-section');
    expect(script).toMatch(/\(filter\|diff\)/);
  });
});
