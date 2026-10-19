/**
 * Helpers for multi-device browser tests against the fake Firebase harness.
 *
 *   import { loadPlaywright, startServer, newDevice } from './harness/helpers.mjs';
 *   const { chromium } = await loadPlaywright();
 *   const server = await startServer();              // own port, own empty database
 *   const browser = await chromium.launch();
 *   const host = await newDevice(browser, server.url, { label: 'host' });
 *   await host.page.goto('/');                        // baseURL is server.url
 *   ...
 *   await browser.close(); await server.stop();
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVER_SCRIPT = path.join(HERE, 'server.js');
const FAKE_FIREBASE_SCRIPT = path.join(HERE, 'fake-firebase.js');

/** Served for any external URL containing "qrcode" (the app loads qrcodejs from cdnjs). */
export const QRCODE_STUB = `window.QRCode = function (el, opts) {
  el.textContent = 'QR:' + ((opts && opts.text) || opts);
};
QRCode.CorrectLevel = { L: 1, M: 0, Q: 3, H: 2 };
QRCode.prototype.clear = function () {};
QRCode.prototype.makeCode = function () {};
`;

/**
 * Imports Playwright from a local install if there is one, otherwise from the
 * global npm root (where it lives in this sandbox).
 */
export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // fall through to the global install
  }
  const roots = [path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules')];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    // npm not on PATH
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'noop.js'))('playwright');
    } catch {
      // try the next root
    }
  }
  throw new Error(`Playwright not found locally or in ${roots.join(', ')}`);
}

/** Polls `fn` until it returns something truthy (and returns that), or throws after `timeout` ms. */
export async function waitFor(fn, { timeout = 5000, interval = 25, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${message}${lastError ? `: ${lastError.message}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Spawns server.js on a free port and waits until it answers.
 * Returns { url, port, process, stop(), dump(path?), reset(), seed(path, value),
 *           write(op, path, value), setOffline(bool), status() }.
 */
export async function startServer({ port = 0, host = '127.0.0.1', log = false } = {}) {
  const env = { ...process.env, HOST: host };
  delete env.NODE_TEST_CONTEXT; // server.js no-ops under `node --test`; we really want it running
  if (log) env.DEBUG_DB = '1';
  const child = spawn(process.execPath, [SERVER_SCRIPT, String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const killChild = () => child.kill();
  process.once('exit', killChild);

  const url = await new Promise((resolve, reject) => {
    let output = '';
    const fail = (why) => {
      clearTimeout(timer);
      child.kill();
      reject(new Error(`${why}\n${output}`));
    };
    const timer = setTimeout(() => fail('server.js did not start within 10s'), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (log) process.stdout.write(chunk);
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once('exit', (code) => fail(`server.js exited early (code ${code})`));
  });

  const get = async (p) => (await fetch(url + p)).json();
  const post = async (p, body) => {
    const res = await fetch(url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${p} failed (${res.status}): ${json.error}`);
    return json;
  };
  await waitFor(() => get('/__db/status').then((s) => s.ok), { message: 'server.js to respond' });

  return {
    url,
    port: Number(new URL(url).port),
    process: child,
    /** The stored tree (Firebase's stored form: arrays come back as index-keyed objects). */
    dump: (p = '') => get(`/__db/dump?path=${encodeURIComponent(p)}`),
    reset: () => post('/__db/reset', {}),
    seed: (p, value) => post('/__db/write', { op: 'set', path: p, value }),
    write: (op, p, value) => post('/__db/write', { op, path: p, value }),
    setOffline: (offline) => post('/__db/offline', { offline }),
    status: () => get('/__db/status'),
    stop: () => new Promise((resolve) => {
      process.removeListener('exit', killChild);
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    }),
  };
}

let deviceCount = 0;
const unreachableOrigins = new Set(); // origins whose network fetch failed once: stub immediately afterwards
const reportedStubs = new Set();

function stubBody(route, label) {
  const request = route.request();
  const type = request.resourceType();
  const url = request.url();
  if (!reportedStubs.has(url)) {
    reportedStubs.add(url);
    console.log(`[${label}] external ${type} unreachable, stubbed: ${url}`);
  }
  if (type === 'script') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  if (type === 'stylesheet') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  return route.abort('internetdisconnected');
}

/** Tries the real network once per origin; falls back to an empty script/stylesheet (other types fail fast). */
async function passThroughOrStub(route, label) {
  const origin = new URL(route.request().url()).origin;
  if (!unreachableOrigins.has(origin)) {
    try {
      const response = await route.fetch({ timeout: 5000 });
      return await route.fulfill({ response });
    } catch {
      unreachableOrigins.add(origin);
    }
  }
  return stubBody(route, label);
}

/** Ignores errors from routes whose page or context has already closed. */
const safely = (handler) => async (route) => {
  try {
    await handler(route);
  } catch {
    // context closed mid-request
  }
};

/**
 * Installs the network routes newDevice() uses on an existing context:
 *   - gstatic firebase-app-compat.js  -> fake-firebase.js
 *   - any other gstatic firebasejs    -> empty script (database/auth/analytics compat)
 *   - any external URL with "qrcode"  -> QRCODE_STUB
 *   - other external origins          -> real network if reachable, else empty script/stylesheet
 */
export async function installRoutes(context, { baseUrl, label = 'device' } = {}) {
  const ownOrigin = baseUrl ? new URL(baseUrl).origin : null;
  const isExternal = (url) => /^https?:$/.test(url.protocol) && url.origin !== ownOrigin;

  // Playwright tries the most recently registered matching route first, so the
  // catch-all goes first and the specific overrides after it.
  await context.route(isExternal, safely((route) => passThroughOrStub(route, label)));
  await context.route(
    (url) => isExternal(url) && /qrcode/i.test(url.pathname),
    safely((route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: QRCODE_STUB }))
  );
  await context.route('https://www.gstatic.com/firebasejs/**', safely((route) => {
    const isApp = /\/firebase-app-compat\.js$/.test(new URL(route.request().url()).pathname);
    const body = isApp ? readFileSync(FAKE_FIREBASE_SCRIPT, 'utf8') : '/* stubbed by test/harness */';
    return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body });
  }));
}

/**
 * Forwards a page's console errors and uncaught exceptions to stdout, prefixed
 * with the device label. `mode`: 'errors' (default), 'warnings' (errors +
 * warnings), 'all', or false.
 */
export function forwardConsole(page, label, mode = 'errors') {
  if (!mode) return;
  page.on('console', (msg) => {
    const type = msg.type();
    // "Failed to load resource" for /__db/ endpoints is the harness's own offline simulation: not interesting.
    if (mode !== 'all' && /\/__db\//.test(msg.location().url || '')) return;
    if (mode === 'all' || type === 'error' || (mode === 'warnings' && type === 'warning')) {
      console.log(`[${label}] console.${type}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => console.log(`[${label}] pageerror: ${err.stack || err.message}`));
}

/**
 * A separate browser context (its own storage, cookies and Firebase
 * connection, i.e. a separate "device") with the harness routes installed and
 * one page opened. `baseUrl` becomes the context's baseURL, so
 * `page.goto('/index.html')` works.
 *
 * Options: viewport, label (log prefix), console ('errors' | 'warnings' | 'all' | false),
 * fakeOptions (window.FAKE_FIREBASE_OPTIONS), contextOptions (extra newContext options).
 * Returns { context, page, label }.
 */
export async function newDevice(browser, baseUrl, {
  viewport,
  label,
  console: consoleMode = 'errors',
  fakeOptions,
  contextOptions = {},
} = {}) {
  label = label || `device${++deviceCount}`;
  const context = await browser.newContext({ baseURL: baseUrl, ...(viewport ? { viewport } : {}), ...contextOptions });
  await installRoutes(context, { baseUrl, label });
  if (fakeOptions) {
    await context.addInitScript((options) => { window.FAKE_FIREBASE_OPTIONS = options; }, fakeOptions);
  }
  context.on('page', (p) => forwardConsole(p, label, consoleMode));
  const page = await context.newPage();
  return { context, page, label };
}

/** Simulates one device losing / regaining its connection (runs its onDisconnect ops server-side). */
export function setDeviceOffline(page, offline) {
  return page.evaluate((off) => {
    const db = window.firebase.database();
    if (off) db.goOffline();
    else db.goOnline();
  }, offline);
}

/** Resolves once every write the page has made has been acknowledged and echoed back by the server. */
export function whenSynced(page) {
  return page.evaluate(() => window.firebase.__fake.whenIdle());
}
