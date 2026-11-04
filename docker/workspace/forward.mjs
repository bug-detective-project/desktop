// Two jobs, one small TCP forwarder.
//
// In the workspace container (no BUGDETECTIVE_FORWARD) it keeps the container alive and forwards
// 0.0.0.0:15173 to the Vite dev server on localhost:5173. Vite listens on localhost only (::1 or
// 127.0.0.1, depending on how localhost resolves), so nothing outside could reach it otherwise.
// SupportDesk itself stays unchanged.
//
// In the forwarder container, BUGDETECTIVE_FORWARD lists the routes (listen:host:port, comma
// separated). That container is on the normal network, where Docker publishes the app's ports on
// 127.0.0.1, and on the workspace's internal network, which has no way out. The host name is
// resolved on every connection, so the workspace can be recreated without touching the forwarder.
import { connect, createServer } from 'node:net';

const LOOPBACK = ['::1', '127.0.0.1'];
const CLIENT_PORT = Number(process.env.BUGDETECTIVE_CLIENT_PORT ?? 5173);

/** The routes of a BUGDETECTIVE_FORWARD value, or the workspace's own route without one. */
export function parseRoutes(value) {
  if (!value) {
    return [{ listen: 15173, hosts: LOOPBACK, port: CLIENT_PORT }];
  }
  return value.split(',').map((route) => {
    const [listen, host, port] = route.trim().split(':');
    if (!/^\d+$/.test(listen) || !host || !/^\d+$/.test(port)) {
      throw new Error(`Invalid route: ${route}`);
    }
    return { listen: Number(listen), hosts: [host], port: Number(port) };
  });
}

/** Connects to the first host that accepts the connection. */
function connectUpstream(hosts, port, done) {
  const [host, ...rest] = hosts;
  const socket = connect({ host, port });
  socket.once('connect', () => done(socket));
  socket.once('error', () => {
    socket.destroy();
    if (rest.length > 0) {
      connectUpstream(rest, port, done);
    } else {
      done(null);
    }
  });
}

function serve({ listen, hosts, port }) {
  const server = createServer((client) => {
    client.pause();
    client.on('error', () => client.destroy());
    connectUpstream(hosts, port, (upstream) => {
      if (!upstream || client.destroyed) {
        upstream?.destroy();
        client.destroy();
        return;
      }
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  server.listen(listen, '0.0.0.0', () => {
    console.log(`Forwarding 0.0.0.0:${listen} to ${hosts.join(' or ')}:${port}`);
  });
  return server;
}

const servers = parseRoutes(process.env.BUGDETECTIVE_FORWARD).map(serve);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const server of servers) server.close();
    process.exit(0);
  });
}
