import { describe, expect, it } from 'vitest';
import { attachedContainerUri } from '../../src/main/services/vscode.ts';
import { WORKSPACES_ROOT, workspaceDir } from '../../src/main/services/workspace.ts';

describe('workspaceDir', () => {
  it('is a folder of the workspaces volume named after the project', () => {
    expect(workspaceDir('supportdesk')).toBe('/workspaces/supportdesk');
    expect(workspaceDir('task-board')).toBe(`${WORKSPACES_ROOT}/task-board`);
  });

  it.each(['', 'Supportdesk', '../etc', 'a b', '1abc', 'x'.repeat(41)])('refuses the project id %j', (id) => {
    expect(() => workspaceDir(id)).toThrow(/Invalid project id/);
  });
});

describe('attachedContainerUri', () => {
  it('points at the container and the project folder', () => {
    const hex = Buffer.from(JSON.stringify({ containerName: '/bugdetective-workspace' })).toString('hex');
    expect(attachedContainerUri('bugdetective-workspace', workspaceDir('notes'))).toBe(`vscode-remote://attached-container+${hex}/workspaces/notes`);
  });

  it('refuses a folder outside the workspaces volume', () => {
    expect(() => attachedContainerUri('bugdetective-workspace', '/etc')).toThrow(/Invalid workspace folder/);
    expect(() => attachedContainerUri('bugdetective-workspace', '/workspaces/../etc')).toThrow(/Invalid workspace folder/);
  });
});
