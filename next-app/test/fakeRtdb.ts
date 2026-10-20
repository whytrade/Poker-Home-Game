// ---------------------------------------------------------------------------
// fakeRtdb.ts — an in-memory fake of the subset of 'firebase/database' the app
// uses (ref/get/set/update/onValue/runTransaction/remove + getDatabase).
//
// Faithfulness goals (see task spec):
//   * update() shallow-merges at the ref path; set() replaces; get() returns a
//     snapshot-like { val(), exists() }.
//   * ARRAY COERCION ON READ: a stored object whose keys are all non-negative
//     integers and "reasonably dense" is returned as an array, exactly like the
//     real SDK. Applied recursively at every level. This is why legacy players
//     persisted as arrays behave realistically and why "p<N>" keys are safe.
//   * runTransaction() models real optimistic-concurrency semantics: the mutator
//     may first run against a STALE cached value; if the committed value changed
//     underneath it, the transaction RETRIES against fresh data. A test hook
//     (armCommitGate) forces deterministic interleavings.
//   * runTransaction() accepts and ignores the { applyLocally: false } options
//     argument the app now passes.
//   * A mutator returning undefined ABORTS: no write, no listener echo, and no
//     node is created for a path that did not exist.
// ---------------------------------------------------------------------------

// The single source of truth: the raw stored tree (uncoerced). null == absent.
let store: Record<string, unknown> = {};

// Per-path logical clock. A transaction records the version of its path when it
// reads, and only commits if that version is unchanged. Writing a path bumps the
// version of that exact path AND all of its ancestor prefixes (a child write
// invalidates an ancestor's in-flight transaction), matching real conflict scope.
let versions: Map<string, number> = new Map();
let clock = 0;

// ------------------------------- utilities ---------------------------------

function clone<T>(v: T): T {
  if (v === null || v === undefined) return v;
  return structuredClone(v);
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

// Read the RAW (uncoerced) value at a path from the store.
function readRaw(path: string): unknown {
  const parts = splitPath(path);
  let node: unknown = store;
  for (const key of parts) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[key];
    if (node === undefined) return null;
  }
  return node === undefined ? null : node;
}

// Firebase's array-coercion heuristic, applied recursively. An object is
// rendered as an array when every key is a non-negative integer and more than
// half of the slots between 0 and the max key are populated. Missing slots
// become null (holes). null/undefined children are pruned (absent nodes).
function coerce(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const mapped = value.map((v) => coerce(v));
    // Firebase would itself re-coerce an array; index holes stay null.
    return mapped.map((v) => (v === undefined ? null : v));
  }

  const kept: Array<[string, unknown]> = [];
  for (const [k, raw] of Object.entries(value as Record<string, unknown>)) {
    const cv = coerce(raw);
    if (cv === null) continue; // prune absent children
    kept.push([k, cv]);
  }
  if (kept.length === 0) return null; // empty node == absent

  const allIntKeys = kept.every(([k]) => /^(0|[1-9]\d*)$/.test(k));
  if (allIntKeys) {
    const nums = kept.map(([k]) => parseInt(k, 10));
    const maxKey = Math.max(...nums);
    if (maxKey < 1 << 20 && kept.length * 2 > maxKey + 1) {
      const arr: unknown[] = new Array(maxKey + 1).fill(null);
      for (const [k, v] of kept) arr[parseInt(k, 10)] = v;
      return arr;
    }
  }

  const obj: Record<string, unknown> = {};
  for (const [k, v] of kept) obj[k] = v;
  return obj;
}

function makeSnapshot(path: string) {
  const val = coerce(readRaw(path));
  return {
    // Return `any` (like the real DataSnapshot.val()) so tests can index freely.
    val: (): any => clone(val),
    exists: () => val !== null,
    key: splitPath(path).slice(-1)[0] ?? null,
  };
}

// Bump the version of a path and all ancestor prefixes.
function bumpVersions(path: string): void {
  const parts = splitPath(path);
  let prefix = '';
  clock++;
  versions.set('', clock); // root
  for (const key of parts) {
    prefix = prefix ? `${prefix}/${key}` : key;
    versions.set(prefix, clock);
  }
}

function versionOf(path: string): number {
  return versions.get(path) ?? 0;
}

// Write a raw value at a path (creating intermediate objects). A null/undefined
// value removes the node. Bumps versions and notifies listeners.
function writeRaw(path: string, value: unknown): void {
  const parts = splitPath(path);
  if (parts.length === 0) {
    store = (value ?? {}) as Record<string, unknown>;
  } else {
    let node = store as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (node[key] === null || node[key] === undefined || typeof node[key] !== 'object') {
        node[key] = {};
      }
      node = node[key] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (value === null || value === undefined) {
      delete node[last];
    } else {
      node[last] = clone(value);
    }
  }
  bumpVersions(path);
  notifyAll();
}

// ------------------------------- listeners ---------------------------------

interface Listener {
  path: string;
  cb: (snap: ReturnType<typeof makeSnapshot>) => void;
  lastJson: string;
}
const listeners: Set<Listener> = new Set();

// Notify every listener whose observed value actually changed. Faithful enough:
// real RTDB only fires when the data at (or under) the listened path changes.
function notifyAll(): void {
  for (const l of listeners) {
    const snap = makeSnapshot(l.path);
    const json = JSON.stringify(snap.val() ?? null);
    if (json !== l.lastJson) {
      l.lastJson = json;
      l.cb(snap);
    }
  }
}

// --------------------------- transaction gate ------------------------------
// Test hook to force interleavings. Call armCommitGate() BEFORE kicking off a
// transaction; the next transaction to reach its pre-commit point pauses there
// until gate.release() is called. `gate.reached` resolves once it is paused
// (i.e. after that transaction has read + run its mutator but before commit).

interface CommitGate {
  reached: Promise<void>;
  release: () => void;
  _resolveReached: () => void;
  _consumed: boolean;
  _released: boolean;
  _onRelease?: () => void;
}

let pendingGate: CommitGate | null = null;

export function armCommitGate(): CommitGate {
  let resolveReached!: () => void;
  const reached = new Promise<void>((r) => (resolveReached = r));
  const gate: CommitGate = {
    reached,
    _resolveReached: resolveReached,
    _consumed: false,
    _released: false,
    release() {
      this._released = true;
      this._onRelease?.();
    },
  };
  pendingGate = gate;
  return gate;
}

async function maybePauseAtGate(): Promise<void> {
  const gate = pendingGate;
  if (!gate || gate._consumed) return;
  gate._consumed = true;
  pendingGate = null;
  gate._resolveReached();
  if (!gate._released) {
    await new Promise<void>((res) => {
      gate._onRelease = res;
    });
  }
}

// ------------------------------- public API --------------------------------

export interface FakeRef {
  _path: string;
}

export function getDatabase(): object {
  return { __fakeRtdb: true };
}

export function ref(_db: unknown, path = ''): FakeRef {
  return { _path: path };
}

export async function get(reference: FakeRef) {
  return makeSnapshot(reference._path);
}

export async function set(reference: FakeRef, value: unknown): Promise<void> {
  writeRaw(reference._path, value);
}

// Shallow merge at the ref path (each top-level key of `updates` is written).
export async function update(reference: FakeRef, updates: Record<string, unknown>): Promise<void> {
  const base = reference._path;
  const existing = readRaw(base);
  const merged: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = clone(v);
  }
  writeRaw(base, merged);
}

export function onValue(
  reference: FakeRef,
  cb: (snap: ReturnType<typeof makeSnapshot>) => void
): () => void {
  const snap = makeSnapshot(reference._path);
  const l: Listener = {
    path: reference._path,
    cb,
    lastJson: JSON.stringify(snap.val() ?? null),
  };
  listeners.add(l);
  cb(snap); // fire immediately, like the real SDK
  return () => {
    listeners.delete(l);
  };
}

export async function remove(reference: FakeRef): Promise<void> {
  writeRaw(reference._path, null);
}

export interface TransactionResult {
  committed: boolean;
  snapshot: ReturnType<typeof makeSnapshot>;
}

// Faithful optimistic-concurrency transaction. The mutator receives the coerced
// current value (array-coercion applied, like the real SDK). It may run against
// stale data; on a version conflict at commit time it RETRIES with fresh data.
// Returning undefined aborts with no write.
export async function runTransaction(
  reference: FakeRef,
  mutator: (current: any) => any,
  _options?: { applyLocally?: boolean }
): Promise<TransactionResult> {
  const path = reference._path;
  const MAX_RETRIES = 50;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const readVersion = versionOf(path);
    const current = coerce(readRaw(path));
    const result = mutator(clone(current));

    // Pre-commit yield point — lets a test interleave another committed write
    // between this transaction's read and its commit.
    await maybePauseAtGate();

    // Optimistic check: did the path change under us while we were computing?
    if (versionOf(path) !== readVersion) {
      continue; // conflict -> retry against fresh data
    }

    if (result === undefined || result === null) {
      // Abort: no write, no listener echo, no node creation.
      return { committed: false, snapshot: makeSnapshot(path) };
    }

    writeRaw(path, result);
    return { committed: true, snapshot: makeSnapshot(path) };
  }
  throw new Error(`runTransaction exceeded ${MAX_RETRIES} retries at ${path}`);
}

// ------------------------------- test helpers ------------------------------

// Reset the entire store + listeners + gate between tests.
export function __resetStore(): void {
  store = {};
  versions = new Map();
  clock = 0;
  listeners.clear();
  pendingGate = null;
}

// Directly seed a raw value (bypassing coercion) — e.g. to plant a genuine
// legacy array before a test.
export function __seed(path: string, value: unknown): void {
  writeRaw(path, value);
}

// Peek at the RAW stored value (uncoerced) — to assert on the persisted shape
// (e.g. that players came back as a keyed object, not an array).
export function __rawAt(path: string): any {
  return clone(readRaw(path));
}

// Peek at the COERCED value (what a reader/snapshot would see).
export function __coercedAt(path: string): any {
  return coerce(readRaw(path));
}

// Expose the coercion function for direct unit testing.
export const __coerce = coerce;

export default {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  remove,
  runTransaction,
};
