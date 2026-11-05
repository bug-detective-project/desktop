import { describe, expect, it } from 'vitest';
// @ts-expect-error The checker is a plain Node script without types.
import { brokenLinks, missingAnchors, projectUrls } from '../../tools/check-links.mjs';

const links = {
  dockerDesktop: 'https://docs.docker.com/desktop/',
  proxyHelp: 'https://github.com/bug-detective-project/desktop#networks-with-a-proxy',
  credentialsHelp: 'https://github.com/bug-detective-project/desktop#vs-code-and-your-credentials',
  feedback: 'https://github.com/bug-detective-project/desktop/discussions',
};

describe('check-links', () => {
  it('checks each page of the project once, and leaves the sites of other people out', () => {
    expect(projectUrls(links)).toEqual(['https://github.com/bug-detective-project/desktop', 'https://github.com/bug-detective-project/desktop/discussions']);
  });

  it('reports a page that answers with an error or does not answer', async () => {
    const answers: Record<string, () => Promise<{ status: number }>> = {
      'https://a/ok': async () => ({ status: 200 }),
      'https://a/gone': async () => ({ status: 404 }),
      'https://a/down': async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    };
    const problems = await brokenLinks(Object.keys(answers), (url: string) => answers[url]!());
    expect(problems).toEqual(['https://a/gone: 404', 'https://a/down: getaddrinfo ENOTFOUND']);
  });

  it('asks again when GitHub limits the rate, instead of failing the build', async () => {
    const statuses = [429, 200];
    expect(await brokenLinks(['https://a/busy'], async () => ({ status: statuses.shift()! }), 0)).toEqual([]);
  });

  it('finds the section of the README each link points at', () => {
    const readme = '# App\n\n## Networks with a proxy\n\ntext\n';
    expect(missingAnchors(links, readme)).toEqual(['credentialsHelp: no section "vs-code-and-your-credentials" in README.md']);
  });
});
