/**
 * docker/workspace/forward.mjs in relay mode (the forwarder container), run with the local node:
 * every route reaches its target, and a target that is down closes the client's connection.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '..', '..', 'docker', 'workspace', 'forward.mjs');
const running: (ChildProcess | Server)[] = [];

afterEach(() => {
  for (const item of running.splice(0)) {
    if ('kill' in item) item.kill();
    else item.close();
  }
});

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}

async function echo(prefix: string): Promise<number> {
  const server = createServer((socket) => socket.on('data', (data) => socket.write(`${prefix}:${data.toString()}`)));
  running.push(server);
  return listen(server);
}

function start(routes: string): Promise<void> {
  const child = spawn(process.execPath, [script], { env: { ...process.env, BUGDETECTIVE_FORWARD: routes }, stdio: ['ignore', 'pipe', 'inherit'] });
  running.push(child);
  const expected = routes.split(',').length;
  return new Promise((done, fail) => {
    let lines = 0;
    child.stdout.on('data', (data: Buffer) => {
      lines += data.toString().trim().split('\n').length;
      if (lines >= expected) done();
    });
    child.once('exit', (code) => fail(new Error(`forward.mjs exited with ${code}`)));
  });
}

const ask = (port: number, text: string) =>
  new Promise<string>((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    socket.on('connect', () => socket.write(text));
    socket.on('data', (data) => {
      answer += data.toString();
      socket.destroy();
    });
    socket.on('close', () => done(answer));
    socket.on('error', () => done(answer));
  });

describe('the forwarder', () => {
  it('relays every route to its target', async () => {
    const [client, api] = [await echo('client'), await echo('api')];
    const [listenClient, listenApi] = [await freePort(), await freePort()];
    await start(`${listenClient}:127.0.0.1:${client},${listenApi}:127.0.0.1:${api}`);
    expect(await ask(listenClient, 'hello')).toBe('client:hello');
    expect(await ask(listenApi, 'hello')).toBe('api:hello');
  });

  it('closes the connection while the target is down, and works once it is up', async () => {
    const [listenPort, target] = [await freePort(), await freePort()];
    await start(`${listenPort}:127.0.0.1:${target}`);
    expect(await ask(listenPort, 'hello')).toBe('');
    const server = createServer((socket) => socket.on('data', () => socket.write('up')));
    running.push(server);
    await new Promise<void>((done) => server.listen(target, '127.0.0.1', done));
    expect(await ask(listenPort, 'hello')).toBe('up');
  });

  it('refuses a malformed route', async () => {
    await expect(start('15173:only-host')).rejects.toThrow(/exited/);
  });
});
