#!/usr/bin/env node
'use strict';
/*
 * Zero-dependency dev server for browser tests: serves the repo as static
 * files and hosts an in-memory fake of the Firebase Realtime Database that
 * every page (every Playwright browser context) shares through
 * test/harness/fake-firebase.js.
 *
 *   node test/harness/server.js [port]     default 4173; 0 picks a free port
 *   HOST=0.0.0.0 node test/harness/server.js   (default host 127.0.0.1)
 *   DEBUG_DB=1 node test/harness/server.js     log every mutation
 *
 * Database endpoints:
 *   GET  /__db/stream?clientId=ID  Server-Sent Events. `event: tree` with the
 *                                  full tree JSON on connect and after every
 *                                  mutation (`id:` is "<bootId>:<version>").
 *                                  Closing the stream runs ID's onDisconnect ops.
 *   POST /__db/write               {op: 'set'|'update'|'remove', path, value}
 *                                  (also op 'transaction' with `expected`, used
 *                                  by Reference.transaction; a stale `expected`
 *                                  answers {ok: false, stale: true, current})
 *                                  -> {ok: true, version, value}
 *   POST /__db/ondisconnect        {clientId, op: 'set'|'update'|'remove'|'cancel', path, value}
 *   GET  /__db/dump[?path=a/b]     the stored tree (or a subtree) as JSON
 *   POST /__db/reset               clear the tree and all onDisconnect ops
 *   POST /__db/offline             {offline: true|false}: true drops every stream
 *                                  (so onDisconnect ops run, like a real network
 *                                  loss) and answers streams and writes with 503
 *   GET  /__db/status              {offline, version, clients, onDisconnect}
 *
 * The server prints "listening on http://HOST:PORT" once it is ready.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const Core = require('./fake-firebase.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_MS = 15000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The in-memory database: tree, live streams and per-connection onDisconnect ops. */
function createDatabase(log) {
  const bootId = Math.random().toString(36).slice(2, 8);
  let tree = null;
  let version = 0;
  let offline = false;
  let anonymousClients = 0;
  const streams = new Map();          // clientId -> ServerResponse
  const onDisconnectOps = new Map();  // clientId -> [op]
  const recentWrites = new Map();     // writeId -> {status, body}: makes retried POSTs idempotent

  const treeFrame = () => `id: ${bootId}:${version}\nevent: tree\ndata: ${JSON.stringify(tree)}\n\n`;

  function mutate(ops, source) {
    const now = Date.now();
    for (const op of ops) tree = Core.applyOp(tree, op, now);
    version++;
    log(`[db] v${version} ${source}: ${ops.map((op) => `${op.op} /${op.path}`).join(', ')}`);
    if (!offline) {
      const frame = treeFrame();
      for (const res of streams.values()) res.write(frame);
    }
    return version;
  }

  function validateOp(body, allowed) {
    if (!body || !allowed.includes(body.op)) {
      throw new HttpError(400, `op must be one of ${allowed.join(', ')}`);
    }
    if (typeof body.path !== 'string') throw new HttpError(400, 'path must be a string');
    try {
      Core.validatePath('', body.path, false);
      if (body.op === 'update') Core.validateUpdate('', body.value, true);
      else if (body.op === 'set' || body.op === 'transaction') Core.validateData('Value ', body.value, [], true);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return { op: body.op, path: body.path, value: body.value };
  }

  function runOnDisconnect(clientId) {
    const ops = onDisconnectOps.get(clientId);
    onDisconnectOps.delete(clientId);
    if (ops && ops.length) mutate(ops, `onDisconnect(${clientId})`);
  }

  return {
    openStream(req, res, clientId) {
      if (offline) throw new HttpError(503, 'offline');
      clientId = clientId || `anonymous-${++anonymousClients}`;
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }, CORS_HEADERS));
      res.write('retry: 1000\n\n');
      res.write(treeFrame());
      streams.get(clientId)?.end(); // a client id has at most one live stream
      streams.set(clientId, res);
      log(`[db] stream open ${clientId} (${streams.size} connected)`);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      res.on('close', () => {
        clearInterval(heartbeat);
        if (streams.get(clientId) !== res) return;
        streams.delete(clientId);
        log(`[db] stream closed ${clientId} (${streams.size} connected)`);
        runOnDisconnect(clientId);
      });
    },

    write(body) {
      if (offline) throw new HttpError(503, 'offline');
      if (body && body.writeId && recentWrites.has(body.writeId)) return recentWrites.get(body.writeId);
      const op = validateOp(body, ['set', 'update', 'remove', 'transaction']);
      const segs = Core.splitPath(op.path);
      if (op.op === 'transaction' && Core.stableStringify(Core.getIn(tree, segs)) !== body.expected) {
        // Compare-and-set failed: the client reruns its update function on `current`
        // and retries with the same writeId. (200, not 409, so the browser logs no error.)
        return { status: 200, body: { ok: false, stale: true, error: 'datastale', current: Core.getIn(tree, segs) } };
      }
      const v = mutate([op], body.writeId ? `client ${body.writeId}` : 'write');
      const result = { status: 200, body: { ok: true, version: v, value: Core.getIn(tree, segs) } };
      if (body.writeId) {
        recentWrites.set(body.writeId, result);
        if (recentWrites.size > 5000) recentWrites.delete(recentWrites.keys().next().value);
      }
      return result;
    },

    registerOnDisconnect(body) {
      if (offline) throw new HttpError(503, 'offline');
      if (!body || !streams.has(body.clientId)) throw new HttpError(503, `client ${body && body.clientId} is not connected`);
      const ops = onDisconnectOps.get(body.clientId) || [];
      if (body.op === 'cancel') {
        const at = Core.splitPath(body.path);
        onDisconnectOps.set(body.clientId, ops.filter((op) => !Core.isPrefix(at, Core.splitPath(op.path))));
      } else {
        // Server values (e.g. TIMESTAMP) stay unresolved until the ops run.
        onDisconnectOps.set(body.clientId, ops.concat(validateOp(body, ['set', 'update', 'remove'])));
      }
      return { ok: true };
    },

    dump: (p) => Core.getIn(tree, Core.splitPath(p)),

    reset() {
      tree = null;
      onDisconnectOps.clear();
      recentWrites.clear();
      return { ok: true, version: mutate([], 'reset') };
    },

    setOffline(value) {
      offline = Boolean(value);
      log(`[db] offline=${offline}`);
      if (offline) for (const res of [...streams.values()]) res.end();
      return { ok: true, offline };
    },

    status: () => ({
      ok: true,
      offline,
      version,
      clients: [...streams.keys()],
      onDisconnect: Object.fromEntries([...onDisconnectOps].map(([id, ops]) => [id, ops.length])),
    }),
  };
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  }, CORS_HEADERS));
  res.end(json);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

async function statOrNull(file) {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

async function serveStatic(req, res, root, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  // No dotfiles (.git, .env, ...) and no "..": everything served stays inside root.
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return sendText(res, 404, 'Not found');
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return sendText(res, 404, 'Not found');
  let stat = await statOrNull(file);
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await statOrNull(file);
  }
  if (!stat || !stat.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/**
 * Creates (but does not start) the harness server. Also usable in-process:
 *   const { createHarnessServer } = require('./server.js');
 *   const server = createHarnessServer(); server.listen(0);
 */
function createHarnessServer({ root = REPO_ROOT, log = () => {} } = {}) {
  const db = createDatabase(log);

  async function handleDb(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /__db/stream':
        return db.openStream(req, res, url.searchParams.get('clientId'));
      case 'POST /__db/write': {
        const { status, body } = db.write(await readJson(req));
        return sendJson(res, status, body);
      }
      case 'POST /__db/ondisconnect':
        return sendJson(res, 200, db.registerOnDisconnect(await readJson(req)));
      case 'GET /__db/dump':
        return sendJson(res, 200, db.dump(url.searchParams.get('path') || ''));
      case 'POST /__db/reset':
        return sendJson(res, 200, db.reset());
      case 'POST /__db/offline':
        return sendJson(res, 200, db.setOffline((await readJson(req)).offline));
      case 'GET /__db/status':
        return sendJson(res, 200, db.status());
      default:
        throw new HttpError(404, `no such endpoint: ${route}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/__db/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, CORS_HEADERS);
          return res.end();
        }
        return await handleDb(req, res, url);
      }
      return await serveStatic(req, res, root, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
      else res.end();
    }
  });
  server.db = db;
  return server;
}

module.exports = { createHarnessServer, REPO_ROOT };

if (require.main === module) {
  // `node --test` with no arguments runs every .js file under test/; this one
  // is not a test, so do nothing there. (helpers.mjs strips the variable when
  // it spawns the server from inside a test.)
  if (process.env.NODE_TEST_CONTEXT) process.exit(0);

  const port = Number(process.argv[2] ?? process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST || '127.0.0.1';
  const server = createHarnessServer({ log: process.env.DEBUG_DB ? console.log : () => {} });
  server.listen(port, host, () => {
    console.log(`Fake Firebase harness listening on http://${host}:${server.address().port}`);
  });
  const shutdown = () => {
    server.closeAllConnections(); // SSE streams would otherwise keep close() waiting
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
