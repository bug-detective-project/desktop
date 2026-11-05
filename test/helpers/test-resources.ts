/**
 * The Docker resources of the integration tests, told apart from the app's by their prefix
 * (bugdetective-<name>-test): the app's builder and a player's workspace are never in these lists.
 */
const TEST_BUILDER = /^(bugdetective(?:-[a-z]+)?-test)-builder$/;
const TEST_CONTAINER = /^bugdetective(?:-[a-z]+)?-test-/;

/** The prefixes of the test builders in `docker buildx ls --format {{.Name}}`, which also lists their nodes. */
export function testBuilderPrefixes(listing: string): string[] {
  return listing.split('\n').flatMap((name) => TEST_BUILDER.exec(name.trim())?.[1] ?? []);
}

/** The test containers in `docker ps -a --format {{.Names}}`. */
export function testContainers(listing: string): string[] {
  return listing
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => TEST_CONTAINER.test(name));
}
