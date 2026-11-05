import { describe, expect, it } from 'vitest';
import { testBuilderPrefixes, testContainers } from '../helpers/test-resources.ts';

describe('the Docker resources the integration tests leave behind', () => {
  it('finds the builders of test prefixes, and never the builder of the app or of a player', () => {
    const listing = ['bugdetective-builder', 'bugdetective-builder0', 'bugdetective-lost-test-builder', 'bugdetective-lost-test-builder0', 'bugdetective-test-builder', 'bugdetective-builder-test-builder', 'default', 'desktop-linux', ''].join('\n');
    expect(testBuilderPrefixes(listing)).toEqual(['bugdetective-lost-test', 'bugdetective-test', 'bugdetective-builder-test']);
  });

  it('finds the containers of test prefixes, and never the workspace of the game', () => {
    const listing = ['bugdetective-workspace', 'bugdetective-forward-supportdesk', 'bugdetective-lost-test-workspace', 'bugdetective-test-forward-notes', 'buildx_buildkit_bugdetective-builder0', 'nginx-test-1'].join('\n');
    expect(testContainers(listing)).toEqual(['bugdetective-lost-test-workspace', 'bugdetective-test-forward-notes']);
  });
});
