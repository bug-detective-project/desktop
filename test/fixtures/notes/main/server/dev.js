// The development server: the client on 5173 (behind the workspace's forwarder) and the API on 3001.
import { createServer } from 'node:http';

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Notes</title><h1>Notes</h1>\n');
}).listen(5173, 'localhost');

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"notes":[]}\n');
}).listen(3001);
