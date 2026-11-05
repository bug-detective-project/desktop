// Fails when a page of the project that the app opens does not exist: the "Send feedback" button
// once opened a 404 because Discussions were off, and comparing URLs in a test cannot see that.
// Sites of other people stay out, so that their outage never fails this build.
//
//   node tools/check-links.mjs
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EXTERNAL_LINKS } from '../src/shared/api.ts';

const PROJECT = 'https://github.com/bug-detective-project/';

/** Each page of the project once, without its #section (README.md sections are checked apart). */
export function projectUrls(links) {
  const urls = Object.values(links)
    .filter((url) => url.startsWith(PROJECT))
    .map((url) => url.split('#')[0]);
  return [...new Set(urls)];
}

/** The pages that answer with an error, as "<url>: <why>" strings. A rate limit is asked again. */
export async function brokenLinks(urls, fetchUrl = fetch, waitMs = 5000) {
  const problems = [];
  for (const url of urls) {
    try {
      let { status } = await fetchUrl(url);
      if (status === 429) {
        await new Promise((done) => setTimeout(done, waitMs));
        ({ status } = await fetchUrl(url));
      }
      if (status >= 400) problems.push(`${url}: ${status}`);
    } catch (error) {
      problems.push(`${url}: ${error.message}`);
    }
  }
  return problems;
}

const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-');

/** The links of the project to a section README.md does not have. */
export function missingAnchors(links, readme) {
  const sections = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => slug(heading)));
  return Object.entries(links).flatMap(([name, url]) => {
    const [page, anchor] = url.split('#');
    return page.startsWith(PROJECT) && anchor && !sections.has(anchor) ? [`${name}: no section "${anchor}" in README.md`] : [];
  });
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const readme = await readFile(resolve(import.meta.dirname, '..', 'README.md'), 'utf8');
  const problems = [...missingAnchors(EXTERNAL_LINKS, readme), ...(await brokenLinks(projectUrls(EXTERNAL_LINKS)))];
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log('Every link of the project answers.');
}
