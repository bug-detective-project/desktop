/**
 * Removes what the integration tests may leave in Docker once the whole suite ends, also after a
 * failure. A test's afterAll removes its own containers and volumes, but the builder is created
 * only by the first test that needs an image, so no single test can own it.
 */
import { currentPlatform } from '../../src/main/platform/index.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { testBuilderPrefixes, testContainers } from '../helpers/test-resources.ts';

export async function teardown(): Promise<void> {
  const { cli } = await currentPlatform().locateDocker();
  if (!cli) return;
  const docker = new Docker(cli, runCommand);
  const containers = await docker.run(['ps', '-a', '--format', '{{.Names}}']);
  for (const name of testContainers(containers.stdout.toString('utf8'))) {
    await docker.removeContainer(name);
  }
  const builders = await docker.run(['buildx', 'ls', '--format', '{{.Name}}']);
  for (const prefix of testBuilderPrefixes(builders.stdout.toString('utf8'))) {
    await docker.removeBuilder(prefix);
  }
}
