/**
 * The notes fixture's QA CLI: the same contract as SupportDesk's, without dependencies.
 *   node run.ts --ticket <n> --workspace <path> --package <dir> [--lang en|pt] [--json out.json]
 *               [--timeout 180] [--deps-cache <dir>]
 * It copies the workspace (without node_modules, .git and databases), adds the package's gate1/
 * (the regression tests of main) and runs them with `node --test`, then runs gate2/ (the ticket's
 * test). The result goes to --json in the desktop's format.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

type Status = 'passed' | 'failed' | 'timeout';
interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'unfinished';
  error?: string;
}

const MESSAGES = {
  en: {
    passed: 'Both gates passed.',
    failed: (gate: number) => `Gate ${gate} failed.`,
    timeout: (seconds: number) => `QA exceeded the time limit of ${seconds} seconds.`,
  },
  pt: {
    passed: 'Os dois gates passaram.',
    failed: (gate: number) => `O gate ${gate} falhou.`,
    timeout: (seconds: number) => `O QA passou do limite de ${seconds} segundos.`,
  },
};

const { values } = parseArgs({
  options: {
    ticket: { type: 'string' },
    workspace: { type: 'string' },
    package: { type: 'string' },
    lang: { type: 'string', default: 'en' },
    json: { type: 'string' },
    timeout: { type: 'string', default: '180' },
    'deps-cache': { type: 'string' },
  },
});
const ticket = Number(values.ticket);
const timeoutSeconds = Number(values.timeout);
if (!Number.isInteger(ticket) || !values.workspace || !values.package || !(timeoutSeconds > 0)) {
  console.error('Usage: node run.ts --ticket <n> --workspace <path> --package <dir> [--lang en|pt] [--json out.json] [--timeout 180]');
  process.exit(2);
}
const text = values.lang === 'pt' ? MESSAGES.pt : MESSAGES.en;
const started = Date.now();
const deadline = started + timeoutSeconds * 1000;

/** Runs `node --test` on the files; top-level TAP lines become the tests. Kills the whole run at the deadline. */
function nodeTest(cwd: string, files: string): Promise<{ status: Status; tests: TestResult[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', files], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, Math.max(0, deadline - Date.now()));
    child.on('close', (code) => {
      clearTimeout(timer);
      const tests = [...output.matchAll(/^(not )?ok \d+ - (.+)$/gm)].map(
        (match): TestResult => (match[1] ? { name: match[2], status: 'failed', error: output.slice(-2000) } : { name: match[2], status: 'passed' }),
      );
      resolve({ status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed', tests: timedOut ? tests.concat({ name: files, status: 'unfinished' }) : tests });
    });
  });
}

async function main(): Promise<void> {
  const app = await mkdtemp(join(tmpdir(), 'notes-qa-'));
  const skip = new Set(['node_modules', '.git']);
  await cp(values.workspace!, app, { recursive: true, filter: (source) => !skip.has(basename(source)) && !source.endsWith('.db') });
  let gate: 1 | 2 = 1;
  let result: { status: Status; tests: TestResult[] };
  try {
    await cp(join(values.package!, 'gate1'), app, { recursive: true });
    result = await nodeTest(app, 'test/**/*.test.js');
    if (result.status === 'passed') {
      gate = 2;
      await cp(join(values.package!, 'gate2'), join(app, 'qa-gate2'), { recursive: true });
      const gate2 = await nodeTest(app, 'qa-gate2/**/*.test.js');
      result = { status: gate2.status, tests: [...result.tests, ...gate2.tests] };
    }
  } finally {
    await rm(app, { recursive: true, force: true });
  }
  const message = result.status === 'passed' ? text.passed : result.status === 'timeout' ? text.timeout(timeoutSeconds) : text.failed(gate);
  const output = { ticket, gate, status: result.status, message, tests: result.tests, durationMs: Date.now() - started };
  console.log(message);
  if (values.json) {
    await writeFile(values.json, `${JSON.stringify(output, null, 2)}\n`);
  }
  process.exit(result.status === 'passed' ? 0 : 1);
}

await main();
