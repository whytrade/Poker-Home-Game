/*
 * fake-firebase.js: a stand-in for the Firebase Realtime Database *compat* SDK
 * (firebase-app-compat.js + firebase-database-compat.js), backed by
 * test/harness/server.js.
 *
 * Every page that loads this script talks to the same in-memory database on
 * the harness server, so separate Playwright browser contexts behave like
 * separate devices sharing one realtime database:
 *
 *   server -> client  one Server-Sent Events stream (GET /__db/stream) that
 *                     carries the full tree after every mutation;
 *   client -> server  POST /__db/write and POST /__db/ondisconnect, sent one
 *                     at a time so writes land in the order they were made.
 *
 * Writes are applied to the local cache straight away (listeners fire before
 * the server answers, like the real SDK) and reconciled when the server echoes
 * the tree back. While disconnected, writes queue up and are sent on reconnect.
 *
 * The file doubles as a CommonJS module: under Node it exports the pure tree
 * helpers (`Core`) that server.js uses, so client and server share a single
 * implementation of Firebase's data semantics (arrays stored as index-keyed
 * objects, nulls delete, empty objects pruned, server values, validation).
 *
 * Options (set before this script runs, e.g. with context.addInitScript):
 *   window.FAKE_FIREBASE_OPTIONS = {
 *     serverUrl: 'http://127.0.0.1:4173', // default: the page's own origin
 *     strict: true,  // false: silently drop `undefined` instead of throwing
 *     log: false,    // true: console.debug connection changes and writes
 *   };
 *
 * Test hooks live on `firebase.__fake` (clientId, connected, whenIdle(), tree()).
 */
(function () {
  'use strict';

  // ===========================================================================
  // Core: pure helpers for Firebase-shaped JSON trees (shared with server.js).
  // Trees are treated as immutable: every write returns a new tree that shares
  // untouched branches with the old one.
  // ===========================================================================
  const Core = (function () {
    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isServerValue = (v) => isObject(v) && hasOwn(v, '.sv');

    /** 'a//b/' -> ['a', 'b']. Numbers are accepted (the compat SDK stringifies them). */
    function splitPath(path) {
      if (path === undefined || path === null) return [];
      if (Array.isArray(path)) return path.slice();
      return String(path).split('/').filter(Boolean);
    }

    function isPrefix(prefix, segs) {
      return prefix.length <= segs.length && prefix.every((s, i) => s === segs[i]);
    }

    /** Value stored at `segs`, or null. */
    function getIn(node, segs) {
      for (const seg of segs) {
        if (!isObject(node) || !hasOwn(node, seg)) return null;
        node = node[seg];
      }
      return node === undefined ? null : node;
    }

    /**
     * Returns a new tree with the (already normalized) `value` at `segs`.
     * null deletes, and objects left empty by a delete are pruned, because
     * Firebase never stores empty objects.
     */
    function setIn(node, segs, value, depth = 0) {
      if (depth === segs.length) return value;
      if (!isObject(node)) {
        if (value === null) return node === undefined ? null : node; // nothing to delete
        node = {};
      }
      const key = segs[depth];
      const prev = hasOwn(node, key) ? node[key] : null;
      const next = setIn(prev, segs, value, depth + 1);
      if (next === prev) return node;
      const out = Object.assign({}, node);
      if (next === null) delete out[key];
      else out[key] = next;
      return Object.keys(out).length ? out : null;
    }

    /**
     * Converts a JS value to the shape Firebase stores: arrays become objects
     * keyed "0", "1", ...; null/undefined children are dropped; empty objects
     * become null (i.e. "no data").
     */
    function normalize(value) {
      if (value === undefined || value === null) return null;
      if (typeof value === 'object') {
        let out = null;
        for (const key of Object.keys(value)) {
          const child = normalize(value[key]);
          if (child !== null) (out || (out = {}))[key] = child;
        }
        return out;
      }
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'string' || typeof value === 'boolean') return value;
      return null;
    }

    /**
     * Replaces server-value placeholders ({'.sv': 'timestamp'} and
     * {'.sv': {increment: n}}) in `value`. `existingAt(relSegs)` returns the
     * currently stored value at a location relative to `value`'s root.
     */
    function resolveServerValues(value, existingAt, now) {
      const walk = (v, rel) => {
        if (isServerValue(v)) {
          const sv = v['.sv'];
          if (sv === 'timestamp') return now;
          if (isObject(sv) && typeof sv.increment === 'number') {
            const current = existingAt(rel);
            return (typeof current === 'number' ? current : 0) + sv.increment;
          }
          throw new Error('Unsupported server value: ' + JSON.stringify(sv));
        }
        if (v !== null && typeof v === 'object') {
          const out = Array.isArray(v) ? [] : {};
          for (const key of Object.keys(v)) out[key] = walk(v[key], rel.concat(key));
          return out;
        }
        return v;
      };
      return walk(value, []);
    }

    /** Returns a copy of `op` with server values resolved against `tree`. */
    function resolveOp(tree, op, now = Date.now()) {
      const base = splitPath(op.path);
      const resolveAt = (segs, v) => resolveServerValues(v, (rel) => getIn(tree, segs.concat(rel)), now);
      if (op.op === 'remove') return op;
      if (op.op === 'update') {
        const value = {};
        for (const key of Object.keys(op.value || {})) {
          value[key] = resolveAt(base.concat(splitPath(key)), op.value[key]);
        }
        return Object.assign({}, op, { value });
      }
      return Object.assign({}, op, { value: resolveAt(base, op.value) });
    }

    /**
     * Applies one write and returns the new tree. Ops:
     *   {op: 'set' | 'transaction', path, value}   replace (null deletes)
     *   {op: 'update', path, value: {relPath: v}}  multi-path update, null deletes
     *   {op: 'remove', path}
     */
    function applyOp(tree, op, now = Date.now()) {
      const { value } = resolveOp(tree, op, now);
      const base = splitPath(op.path);
      switch (op.op) {
        case 'set':
        case 'transaction':
          return setIn(tree, base, normalize(value));
        case 'remove':
          return setIn(tree, base, null);
        case 'update':
          return Object.keys(value || {}).reduce(
            (t, key) => setIn(t, base.concat(splitPath(key)), normalize(value[key])),
            tree
          );
        default:
          throw new Error('Unknown op "' + op.op + '"');
      }
    }

    // --- Validation (messages mirror the real SDK so failures look familiar) --

    const BAD_PATH_CHARS = /[.#$[\]\u0000-\u001F\u007F]/;
    const BAD_KEY_CHARS = /[.#$/[\]\u0000-\u001F\u007F]/;
    const PATH_RULES = 'Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"';
    const KEY_RULES = 'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';

    const isValidKey = (key) => typeof key === 'string' && key.length > 0 && !BAD_KEY_CHARS.test(key);

    /** Throws unless every segment of `path` is legal. `.info` is allowed as the first segment when `allowInfo`. */
    function validatePath(prefix, path, allowInfo) {
      let segs = splitPath(path);
      if (allowInfo && segs[0] === '.info') segs = segs.slice(1);
      if (segs.some((s) => BAD_PATH_CHARS.test(s))) {
        throw new Error(prefix + 'First argument was an invalid path = "' + path + '". ' + PATH_RULES);
      }
    }

    /** Throws on data the real SDK rejects: undefined, functions, NaN/Infinity, illegal keys. */
    function validateData(prefix, value, segs, allowUndefined) {
      const where = segs.length ? " in property '" + segs.join('.') + "'" : '';
      if (value === undefined) {
        if (allowUndefined) return;
        throw new Error(prefix + 'contains undefined' + where);
      }
      if (typeof value === 'function') throw new Error(prefix + 'contains a function' + where);
      if (typeof value === 'symbol' || typeof value === 'bigint') {
        throw new Error(prefix + 'contains a ' + typeof value + where);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(prefix + 'contains ' + value + where);
      }
      if (value === null || typeof value !== 'object' || isServerValue(value)) return;
      for (const key of Object.keys(value)) {
        if (!Array.isArray(value) && !isValidKey(key)) {
          throw new Error(prefix + 'contains an invalid key (' + key + ')' + where + '. ' + KEY_RULES);
        }
        validateData(prefix, value[key], segs.concat(key), allowUndefined);
      }
    }

    /** Validates a multi-path update object, including Firebase's "no overlapping paths" rule. */
    function validateUpdate(prefix, values, allowUndefined) {
      if (!isObject(values)) {
        throw new Error(prefix + 'First argument must be an object containing the children to replace.');
      }
      const paths = Object.keys(values).map((key) => {
        const segs = splitPath(key);
        if (!segs.length || segs.some((s) => BAD_PATH_CHARS.test(s))) {
          throw new Error(prefix + 'First argument contains an invalid key (' + key + '). ' + PATH_RULES);
        }
        validateData(prefix + 'First argument ', values[key], segs, allowUndefined);
        return segs;
      });
      for (const a of paths) {
        for (const b of paths) {
          if (a !== b && isPrefix(a, b)) {
            throw new Error(
              prefix + 'First argument contains a path /' + a.join('/') +
              ' that is ancestor of another path /' + b.join('/')
            );
          }
        }
      }
    }

    // --- Reading ---------------------------------------------------------------

    /** JSON with sorted keys, so equal trees always compare equal as strings. */
    function stableStringify(v) {
      if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
      if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }

    /** Firebase key order: 32-bit integer keys first (numerically), then strings. */
    function asInt32(key) {
      if (!/^-?\d{1,10}$/.test(key)) return null;
      const n = Number(key);
      return n >= -2147483648 && n <= 2147483647 ? n : null;
    }
    function compareKeys(a, b) {
      if (a === b) return 0;
      const ia = asInt32(a);
      const ib = asInt32(b);
      if (ia !== null && ib !== null) return ia - ib || a.length - b.length;
      if (ia !== null) return -1;
      if (ib !== null) return 1;
      return a < b ? -1 : 1;
    }
    const sortedKeys = (node) => (isObject(node) ? Object.keys(node).sort(compareKeys) : []);

    /**
     * What DataSnapshot.val() returns: a deep copy where objects whose keys are
     * all array indices, at least half of them present, come back as arrays.
     * This is the real SDK's heuristic, so stored arrays read back as arrays.
     */
    function toVal(node) {
      if (!isObject(node)) return node === undefined ? null : node;
      const keys = Object.keys(node);
      if (!keys.length) return null;
      const out = {};
      let allIndices = true;
      let maxIndex = 0;
      for (const key of keys) {
        out[key] = toVal(node[key]);
        if (allIndices && /^(0|[1-9]\d*)$/.test(key)) maxIndex = Math.max(maxIndex, Number(key));
        else allIndices = false;
      }
      if (allIndices && maxIndex < 2 * keys.length) {
        const arr = [];
        for (const key of keys) arr[key] = out[key];
        return arr;
      }
      return out;
    }

    // --- Push IDs (same algorithm as the real SDK: 8 time chars + 12 random) ---

    const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    let lastPushTime = 0;
    const lastRandChars = [];
    function nextPushId(now = Date.now()) {
      const duplicateTime = now === lastPushTime;
      lastPushTime = now;
      let time = '';
      for (let i = 0; i < 8; i++) {
        time = PUSH_CHARS.charAt(now % 64) + time;
        now = Math.floor(now / 64);
      }
      if (!duplicateTime) {
        for (let i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
      } else {
        // Same millisecond: increment the random part so IDs stay strictly ordered.
        let i = 11;
        for (; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
        lastRandChars[i]++;
      }
      return time + lastRandChars.map((n) => PUSH_CHARS.charAt(n)).join('');
    }

    return {
      isObject, splitPath, isPrefix, getIn, setIn, normalize, resolveOp, applyOp,
      validatePath, validateData, validateUpdate, stableStringify, compareKeys,
      sortedKeys, toVal, nextPushId,
    };
  })();

  // ===========================================================================
  // Node: export Core for server.js and stop here.
  // ===========================================================================
  if (typeof window === 'undefined') {
    module.exports = Core;
    return;
  }

  // ===========================================================================
  // Browser shim
  // ===========================================================================
  if (window.firebase && window.firebase.__fake) return; // loaded twice: keep the first instance

  const OPTIONS = Object.assign({ serverUrl: '', strict: true, log: false }, window.FAKE_FIREBASE_OPTIONS);
  const SERVER = (OPTIONS.serverUrl || window.location.origin).replace(/\/+$/, '');
  const SESSION_ID = Math.random().toString(36).slice(2, 10); // one per page load
  const MAX_TRANSACTION_RETRIES = 25;
  const { isObject, splitPath } = Core;

  const debug = (...args) => {
    if (OPTIONS.log) console.debug('[fake-firebase]', ...args);
  };

  /** Runs a user callback; rethrows its errors asynchronously so dispatch carries on (as the real SDK does). */
  function guard(fn, self, args) {
    try {
      return fn.apply(self, args);
    } catch (err) {
      setTimeout(() => { throw err; });
    }
  }

  /** Promise plus Node-style onComplete callback. A failed write never becomes an unhandled rejection (real SDK behaviour). */
  function deferred(onComplete) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    return {
      promise,
      resolve(value) {
        resolve(value);
        if (onComplete) guard(onComplete, null, [null]);
      },
      reject(err) {
        reject(err);
        if (onComplete) guard(onComplete, null, [err]);
      },
    };
  }

  /** Validates data like the real SDK, then returns its JSON form (exactly what the server will receive). */
  function toWire(prefix, value) {
    Core.validateData(prefix, value, [], !OPTIONS.strict);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }

  // ---------------------------------------------------------------------------
  // Local cache and write queue
  // ---------------------------------------------------------------------------

  let serverTree = null;   // last tree received from the server
  let serverBoot = null;   // server instance id (detects restarts)
  let serverVersion = 0;   // version of serverTree
  let haveTree = false;    // false until the first tree arrives
  let view = null;         // serverTree + local writes the server has not echoed yet

  // A write record: { id, kind: 'data' | 'ondisconnect', op, local, ref, acked, ackVersion, deferred, txn }
  const unechoed = [];     // data writes applied locally, dropped once a server tree includes them
  const outbox = [];       // writes and onDisconnect registrations not yet acknowledged, in order
  let writeSeq = 0;
  let onDisconnectOps = []; // ops the server holds for the current connection (mirrored locally)

  function rebuildView() {
    view = unechoed.reduce((tree, w) => Core.applyOp(tree, w.local), serverTree);
  }

  function nodeAt(segs) {
    if (segs[0] === '.info') return Core.getIn({ connected, serverTimeOffset: 0 }, segs.slice(1));
    return Core.getIn(view, segs);
  }

  function receiveTree(tree, eventId) {
    const [boot, version] = String(eventId).split(':');
    const restarted = serverBoot !== null && boot !== serverBoot;
    serverTree = tree;
    serverBoot = boot;
    serverVersion = Number(version) || 0;
    haveTree = true;
    // Drop local writes the server has incorporated. Writes are acknowledged in
    // order, so the acknowledged ones always form a prefix of `unechoed`.
    while (unechoed.length && unechoed[0].acked && (restarted || unechoed[0].ackVersion <= serverVersion)) {
      unechoed.shift();
    }
    rebuildView();
    flush();
  }

  /** Queues a data write, applies it locally (firing listeners synchronously, like the real SDK) and starts sending. */
  function writeData(ref, op, done, extra) {
    const w = Object.assign({
      id: SESSION_ID + ':' + ++writeSeq,
      kind: 'data',
      op,
      ref,
      acked: false,
      ackVersion: 0,
      applyLocally: true,
      deferred: done,
    }, extra);
    outbox.push(w);
    if (w.applyLocally) {
      w.local = Core.resolveOp(view, op);
      unechoed.push(w);
      view = Core.applyOp(view, w.local);
      flush();
    }
    debug('queued', op.op, '/' + op.path, op.value);
    pump();
    return done.promise;
  }

  function writeOnDisconnect(op, onComplete) {
    const done = deferred(onComplete);
    outbox.push({ id: SESSION_ID + ':' + ++writeSeq, kind: 'ondisconnect', op, deferred: done });
    pump();
    return done.promise;
  }

  function dropUnechoed(w) {
    const i = unechoed.indexOf(w);
    if (i < 0) return;
    unechoed.splice(i, 1);
    rebuildView();
    flush();
  }

  let pumping = false;

  /** Sends queued writes one at a time (preserving order) while connected. */
  async function pump() {
    if (pumping) return;
    pumping = true;
    let stalled = false;
    try {
      while (connected && outbox.length && !stalled) stalled = !(await sendHead());
    } catch (err) {
      console.error('[fake-firebase] write queue error', err);
      stalled = true;
    } finally {
      pumping = false;
    }
    if (stalled) setTimeout(pump, 250); // also resumed by reconnecting
  }

  /** Sends outbox[0]. Returns false if it could not be delivered and should be retried. */
  async function sendHead() {
    const w = outbox[0];
    const sentOn = clientId;
    const isOnDisconnect = w.kind === 'ondisconnect';
    const body = isOnDisconnect ? Object.assign({ clientId: sentOn }, w.op) : Object.assign({ writeId: w.id }, w.op);
    let res;
    let payload;
    try {
      res = await fetch(SERVER + (isOnDisconnect ? '/__db/ondisconnect' : '/__db/write'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      payload = await res.json().catch(() => ({}));
    } catch (err) {
      return false; // network failure
    }
    if (res.status === 503) return false; // server offline or our connection is gone: retry after reconnect

    if (w.txn && payload.stale) return retryTransaction(w, payload.current);

    outbox.shift();
    if (!res.ok || payload.ok === false) {
      const err = new Error(payload.error || 'HTTP ' + res.status);
      console.warn('FIREBASE WARNING: ' + w.op.op + ' at /' + w.op.path + ' failed: ' + err.message);
      if (!isOnDisconnect) dropUnechoed(w);
      w.deferred.reject(err);
      notifyIdle();
      return true;
    }

    if (isOnDisconnect) {
      if (sentOn === clientId && connected) {
        const at = splitPath(w.op.path);
        onDisconnectOps = w.op.op === 'cancel'
          ? onDisconnectOps.filter((op) => !Core.isPrefix(at, splitPath(op.path)))
          : onDisconnectOps.concat(w.op);
      }
      w.deferred.resolve();
    } else {
      w.acked = true;
      w.ackVersion = payload.version;
      if (payload.version <= serverVersion) dropUnechoed(w);
      w.deferred.resolve(w.txn ? { committed: true, snapshot: new DataSnapshot(w.ref, payload.value) } : undefined);
    }
    notifyIdle();
    return true;
  }

  /** Server rejected a transaction because the data changed: rerun the update function on the server's value. */
  function retryTransaction(w, current) {
    const abort = (err, committed) => {
      outbox.shift();
      dropUnechoed(w);
      if (err) w.deferred.reject(err);
      else w.deferred.resolve({ committed, snapshot: new DataSnapshot(w.ref, current) });
      notifyIdle();
      return true;
    };
    if (++w.txn.retries > MAX_TRANSACTION_RETRIES) return abort(new Error('maxretry'));
    let next;
    try {
      next = w.txn.update(Core.toVal(current));
      if (next === undefined) return abort(null, false);
      next = toWire('Reference.transaction failed: Update function ', next);
    } catch (err) {
      return abort(err);
    }
    w.op = Object.assign({}, w.op, { value: next, expected: Core.stableStringify(current) });
    if (w.applyLocally) {
      w.local = Core.resolveOp(view, w.op);
      rebuildView();
      flush();
    }
    return true; // resend immediately
  }

  // ---------------------------------------------------------------------------
  // Connection (Server-Sent Events)
  // ---------------------------------------------------------------------------

  let es = null;            // current EventSource
  let clientId = null;      // id of the current connection; the server ties onDisconnect ops to it
  let connectionCount = 0;
  let connected = false;
  let wantOnline = true;    // false after db.goOffline()
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  function connect() {
    if (es || !wantOnline) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clientId = SESSION_ID + '-' + ++connectionCount;
    const source = new EventSource(SERVER + '/__db/stream?clientId=' + encodeURIComponent(clientId));
    es = source;
    source.addEventListener('tree', (event) => {
      if (es !== source) return;
      let tree;
      try {
        tree = JSON.parse(event.data);
      } catch (err) {
        console.error('[fake-firebase] bad tree from server', err);
        return;
      }
      reconnectAttempts = 0;
      receiveTree(tree, event.lastEventId);
      setConnected(true);
    });
    source.addEventListener('error', () => {
      if (es !== source) return;
      // Reconnect ourselves, always with a fresh clientId, rather than letting
      // EventSource silently retry under the old one.
      source.close();
      es = null;
      setConnected(false);
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (!wantOnline || reconnectTimer) return;
    const delay = Math.min(1000, 100 * 2 ** reconnectAttempts++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    debug(value ? 'connected as ' + clientId : 'disconnected');
    if (!value && onDisconnectOps.length) {
      // Like the real SDK, apply our own onDisconnect ops to the local cache when
      // the connection drops (the server runs the authoritative copy).
      const now = Date.now();
      serverTree = onDisconnectOps.reduce((tree, op) => Core.applyOp(tree, op, now), serverTree);
      onDisconnectOps = [];
      rebuildView();
    }
    flush(); // .info/connected listeners
    if (value) pump();
  }

  // ---------------------------------------------------------------------------
  // Listeners and event dispatch
  // ---------------------------------------------------------------------------

  const EVENT_TYPES = ['value', 'child_added', 'child_changed', 'child_removed', 'child_moved'];
  const registrations = [];
  let flushing = false;
  let flushAgain = false;
  const idleWaiters = [];

  function addRegistration(ref, event, callback, userCallback, context, once) {
    if (!EVENT_TYPES.includes(event)) {
      throw new Error('Query.on failed: First argument must be a valid event type = "value", ' +
        '"child_added", "child_removed", "child_changed", or "child_moved".');
    }
    const reg = {
      ref, event, callback, userCallback, context, once,
      path: ref._segs.join('/'),
      isInfo: ref._segs[0] === '.info',
      armed: false,        // never fire inside .on(): armed on the next microtask
      initialized: false,
      removed: false,
      lastNode: undefined, // 'value': last delivered node and its JSON
      lastJSON: undefined,
      children: new Map(), // child events: key -> { node, json }
    };
    registrations.push(reg);
    queueMicrotask(() => {
      reg.armed = true;
      flush();
    });
    return reg;
  }

  function removeRegistration(reg) {
    reg.removed = true;
    const i = registrations.indexOf(reg);
    if (i >= 0) registrations.splice(i, 1);
  }

  /** Delivers pending events to every registration whose data changed. Re-entrant safe. */
  function flush() {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      let rounds = 0;
      do {
        flushAgain = false;
        for (const reg of registrations.slice()) {
          if (!reg.removed && reg.armed && (reg.isInfo || haveTree)) dispatch(reg);
        }
      } while (flushAgain && ++rounds < 50);
      if (flushAgain) {
        // A listener keeps writing in response to its own events; let the page breathe.
        flushAgain = false;
        setTimeout(flush, 0);
      }
    } finally {
      flushing = false;
    }
    notifyIdle();
  }

  function fire(reg, args) {
    if (reg.once) removeRegistration(reg);
    guard(reg.callback, reg.context, args);
  }

  function dispatch(reg) {
    const node = nodeAt(reg.ref._segs);

    if (reg.event === 'value') {
      if (reg.initialized && node === reg.lastNode) return;
      const json = Core.stableStringify(node);
      const changed = !reg.initialized || json !== reg.lastJSON;
      reg.initialized = true;
      reg.lastNode = node;
      reg.lastJSON = json;
      if (changed) fire(reg, [new DataSnapshot(reg.ref, node)]);
      return;
    }

    const prev = reg.children;
    const keys = Core.sortedKeys(node);
    const next = new Map();
    for (const key of keys) {
      const old = prev.get(key);
      const child = node[key];
      next.set(key, { node: child, json: old && old.node === child ? old.json : Core.stableStringify(child) });
    }
    reg.children = next;
    reg.initialized = true;

    const snap = (key, child) => new DataSnapshot(reg.ref.child(key), child);
    if (reg.event === 'child_removed') {
      for (const [key, old] of prev) {
        if (!next.has(key) && !reg.removed) fire(reg, [snap(key, old.node)]);
      }
    } else if (reg.event === 'child_added' || reg.event === 'child_changed') {
      let prevKey = null;
      for (const key of keys) {
        const old = prev.get(key);
        const hit = reg.event === 'child_added' ? !old : old && old.json !== next.get(key).json;
        if (hit && !reg.removed) fire(reg, [snap(key, next.get(key).node), prevKey]);
        prevKey = key;
      }
    }
    // child_moved needs ordered queries, which the harness does not implement: never fires.
  }

  function isIdle() {
    return haveTree && !outbox.length && !unechoed.length;
  }

  function notifyIdle() {
    if (isIdle()) idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  // ---------------------------------------------------------------------------
  // Public classes
  // ---------------------------------------------------------------------------

  class DataSnapshot {
    constructor(ref, node) {
      this.ref = ref;
      this._node = node === undefined ? null : node;
    }
    get key() { return this.ref.key; }
    get size() { return this.numChildren(); }
    val() { return Core.toVal(this._node); }
    exportVal() { return this.val(); }
    toJSON() { return this.val(); }
    exists() { return this._node !== null; }
    getPriority() { return null; }
    child(path) {
      return new DataSnapshot(this.ref.child(path), Core.getIn(this._node, splitPath(path)));
    }
    hasChild(path) { return Core.getIn(this._node, splitPath(path)) !== null; }
    hasChildren() { return this.numChildren() > 0; }
    numChildren() { return isObject(this._node) ? Object.keys(this._node).length : 0; }
    /** Iterates children in key order; stops (and returns true) when `fn` returns true. */
    forEach(fn) {
      for (const key of Core.sortedKeys(this._node)) {
        if (fn(new DataSnapshot(this.ref.child(key), this._node[key])) === true) return true;
      }
      return false;
    }
  }

  class OnDisconnect {
    constructor(ref) { this._ref = ref; }
    set(value, onComplete) {
      assertWritable('OnDisconnect.set', this._ref);
      const wire = toWire('OnDisconnect.set failed: First argument ', value);
      return writeOnDisconnect({ op: 'set', path: this._ref._path, value: wire }, onComplete);
    }
    setWithPriority(value, priority, onComplete) { return this.set(value, onComplete); }
    update(values, onComplete) {
      assertWritable('OnDisconnect.update', this._ref);
      Core.validateUpdate('OnDisconnect.update failed: ', values, !OPTIONS.strict);
      const wire = JSON.parse(JSON.stringify(values));
      return writeOnDisconnect({ op: 'update', path: this._ref._path, value: wire }, onComplete);
    }
    remove(onComplete) {
      assertWritable('OnDisconnect.remove', this._ref);
      return writeOnDisconnect({ op: 'remove', path: this._ref._path }, onComplete);
    }
    cancel(onComplete) {
      return writeOnDisconnect({ op: 'cancel', path: this._ref._path }, onComplete);
    }
  }

  function assertWritable(fnName, ref) {
    if (ref._segs[0] === '.info') throw new Error(fnName + ' failed: First argument cannot write to .info paths');
  }

  function unsupported(name) {
    return function () {
      throw new Error('fake-firebase: Query.' + name + '() is not supported by the test harness');
    };
  }

  let databaseUrl = 'https://fake-firebase.local';

  class Reference {
    constructor(segs) {
      this._segs = segs;
      this._path = segs.join('/');
    }
    get key() { return this._segs.length ? this._segs[this._segs.length - 1] : null; }
    get parent() { return this._segs.length ? new Reference(this._segs.slice(0, -1)) : null; }
    get root() { return new Reference([]); }
    get ref() { return this; }

    child(path) {
      if (typeof path === 'number') path = String(path);
      if (typeof path !== 'string' || !splitPath(path).length) {
        throw new Error('Reference.child failed: First argument was an invalid path = "' + path + '". ' +
          'Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"');
      }
      Core.validatePath('Reference.child failed: ', path, this._segs.length === 0);
      return new Reference(this._segs.concat(splitPath(path)));
    }
    toString() { return databaseUrl + '/' + this._segs.map(encodeURIComponent).join('/'); }
    toJSON() { return this.toString(); }
    isEqual(other) { return other instanceof Reference && other._path === this._path; }

    // --- Writes ---------------------------------------------------------------

    set(value, onComplete) {
      assertWritable('Reference.set', this);
      const wire = toWire('Reference.set failed: First argument ', value);
      return writeData(this, { op: 'set', path: this._path, value: wire }, deferred(onComplete));
    }
    setWithPriority(value, priority, onComplete) { return this.set(value, onComplete); }
    setPriority(priority, onComplete) { return deferredResolved(onComplete); }

    update(values, onComplete) {
      assertWritable('Reference.update', this);
      Core.validateUpdate('Reference.update failed: ', values, !OPTIONS.strict);
      if (!Object.keys(values).length) return deferredResolved(onComplete); // real SDK: no-op
      const wire = JSON.parse(JSON.stringify(values));
      return writeData(this, { op: 'update', path: this._path, value: wire }, deferred(onComplete));
    }

    remove(onComplete) {
      assertWritable('Reference.remove', this);
      return writeData(this, { op: 'remove', path: this._path }, deferred(onComplete));
    }

    /** New child with a chronologically ordered key. With a value it also writes it; the result is thenable. */
    push(value, onComplete) {
      const child = this.child(Core.nextPushId());
      const promise = value === undefined || value === null
        ? deferredResolved(onComplete)
        : child.set(value, onComplete);
      const thenable = new Reference(child._segs);
      const settled = promise.then(() => child);
      settled.catch(() => {}); // failures surface through .then/.catch/onComplete, never as unhandled rejections
      thenable.then = settled.then.bind(settled);
      thenable.catch = settled.catch.bind(settled);
      return thenable;
    }

    /**
     * Compare-and-set transaction. The update function runs against the local
     * cache first, then again on the server's value whenever another device
     * wrote in between. Resolves {committed, snapshot}.
     */
    transaction(update, onComplete, applyLocally = true) {
      assertWritable('Reference.transaction', this);
      if (typeof update !== 'function') {
        throw new Error('Reference.transaction failed: First argument must be a valid function.');
      }
      const ref = this;
      let resolveP;
      let rejectP;
      const promise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
      promise.catch(() => {});
      const done = {
        promise,
        resolve(result) {
          resolveP(result);
          if (onComplete) guard(onComplete, null, [null, result.committed, result.snapshot]);
        },
        reject(err) {
          rejectP(err);
          if (onComplete) guard(onComplete, null, [err, false, null]);
        },
      };
      const current = nodeAt(this._segs);
      let next;
      try {
        next = update(Core.toVal(current));
        if (next !== undefined) next = toWire('Reference.transaction failed: Update function ', next);
      } catch (err) {
        done.reject(err);
        return promise;
      }
      if (next === undefined) { // aborted by the update function
        queueMicrotask(() => done.resolve({ committed: false, snapshot: new DataSnapshot(ref, current) }));
        return promise;
      }
      const op = { op: 'transaction', path: this._path, value: next, expected: Core.stableStringify(current) };
      return writeData(this, op, done, { applyLocally: applyLocally !== false, txn: { update, retries: 0 } });
    }

    onDisconnect() { return new OnDisconnect(this); }

    // --- Reads ----------------------------------------------------------------

    on(eventType, callback, cancelCallbackOrContext, context) {
      if (typeof callback !== 'function') throw new Error('Query.on failed: Second argument must be a valid function.');
      const ctx = typeof cancelCallbackOrContext === 'object' ? cancelCallbackOrContext : context;
      addRegistration(this, eventType, callback, callback, ctx, false);
      return callback;
    }

    once(eventType, successCallback, failureCallbackOrContext, context) {
      const ctx = typeof failureCallbackOrContext === 'object' ? failureCallbackOrContext : context;
      return new Promise((resolve) => {
        const deliver = function (snapshot, prevKey) {
          if (successCallback) guard(successCallback, ctx, [snapshot, prevKey]);
          resolve(snapshot);
        };
        addRegistration(this, eventType, deliver, successCallback, ctx, true);
      });
    }

    /** off() removes every listener at exactly this path; off(event) / off(event, cb) narrow it down. */
    off(eventType, callback, context) {
      for (const reg of registrations.slice()) {
        if (reg.path !== this._path) continue;
        if (eventType && reg.event !== eventType) continue;
        if (callback && reg.userCallback !== callback) continue;
        if (context && reg.context !== context) continue;
        removeRegistration(reg);
      }
    }
  }

  // Ordered/limited queries are out of scope for the harness; fail loudly rather than return wrong data.
  ['orderByChild', 'orderByKey', 'orderByValue', 'orderByPriority', 'limitToFirst', 'limitToLast',
    'startAt', 'startAfter', 'endAt', 'endBefore', 'equalTo'].forEach((name) => {
    Reference.prototype[name] = unsupported(name);
  });

  function deferredResolved(onComplete) {
    const done = deferred(onComplete);
    queueMicrotask(() => done.resolve());
    return done.promise;
  }

  class Database {
    constructor(app) { this.app = app; }
    ref(path) {
      if (typeof path === 'number') path = String(path);
      if (path !== undefined && path !== null && typeof path !== 'string') {
        throw new Error('Database.ref failed: First argument must be a valid path string.');
      }
      Core.validatePath('Database.ref failed: ', path || '', true);
      return new Reference(splitPath(path));
    }
    refFromURL(url) {
      return this.ref(decodeURIComponent(new URL(url).pathname));
    }
    goOffline() {
      wantOnline = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (es) {
        es.close(); // the server sees the connection drop and runs our onDisconnect ops
        es = null;
      }
      setConnected(false);
    }
    goOnline() {
      wantOnline = true;
      connect();
    }
    useEmulator() {}
  }

  // ---------------------------------------------------------------------------
  // The `firebase` namespace
  // ---------------------------------------------------------------------------

  const DEFAULT_APP = '[DEFAULT]';
  const appRegistry = [];
  let database = null;

  function getApp(name = DEFAULT_APP) {
    const app = appRegistry.find((a) => a.name === name);
    if (!app) {
      throw new Error("Firebase: No Firebase App '" + name + "' has been created - call " +
        'Firebase App.initializeApp() (app/no-app).');
    }
    return app;
  }

  function databaseFor(app) {
    if (!database) {
      app = app || getApp();
      const { databaseURL, projectId } = app.options || {};
      if (databaseURL) databaseUrl = String(databaseURL).replace(/\/+$/, '');
      else if (projectId) databaseUrl = 'https://' + projectId + '-default-rtdb.firebaseio.com';
      database = new Database(app);
      connect();
    }
    return database;
  }

  function databaseNamespace(app) {
    return databaseFor(app);
  }
  Object.assign(databaseNamespace, {
    ServerValue: {
      TIMESTAMP: { '.sv': 'timestamp' },
      increment: (delta) => ({ '.sv': { increment: delta } }),
    },
    enableLogging() {},
    Database,
    Reference,
    Query: Reference,
    DataSnapshot,
    OnDisconnect,
  });

  // Minimal stubs so pages that also load auth/analytics compat don't crash.
  const auth = {
    currentUser: null,
    onAuthStateChanged(cb) {
      setTimeout(() => guard(cb, null, [auth.currentUser]));
      return () => {};
    },
    signInAnonymously() {
      auth.currentUser = { uid: 'anon-' + SESSION_ID, isAnonymous: true };
      return Promise.resolve({ user: auth.currentUser });
    },
    signOut() {
      auth.currentUser = null;
      return Promise.resolve();
    },
  };
  const analytics = { logEvent() {}, setUserId() {}, setUserProperties() {}, setAnalyticsCollectionEnabled() {} };

  const firebase = {
    SDK_VERSION: '10.7.1',
    get apps() { return appRegistry.slice(); },
    initializeApp(options = {}, name = DEFAULT_APP) {
      if (appRegistry.some((a) => a.name === name)) {
        throw new Error("Firebase: Firebase App named '" + name + "' already exists (app/duplicate-app).");
      }
      const app = {
        name,
        options: Object.assign({}, options),
        automaticDataCollectionEnabled: false,
        database: () => databaseFor(app),
        // Like the real SDK, the app leaves firebase.apps asynchronously.
        delete: () => Promise.resolve().then(() => {
          const i = appRegistry.indexOf(app);
          if (i >= 0) appRegistry.splice(i, 1);
        }),
      };
      appRegistry.push(app);
      return app;
    },
    app: getApp,
    database: databaseNamespace,
    auth: () => auth,
    analytics: () => analytics,

    /** Test hooks (not part of the real SDK). */
    __fake: {
      sessionId: SESSION_ID,
      serverUrl: SERVER,
      get clientId() { return clientId; },
      get connected() { return connected; },
      get pendingWrites() { return outbox.length; },
      /** Resolves once every local write has been acknowledged and echoed back by the server. */
      whenIdle() {
        return new Promise((resolve) => {
          idleWaiters.push(resolve);
          notifyIdle();
        });
      },
      /** The local cache (server tree + unechoed local writes), in stored form. */
      tree() { return view === null ? null : JSON.parse(JSON.stringify(view)); },
    },
  };

  window.firebase = firebase;
})();
