#!/usr/bin/env node
/**
 * Self-test for the fake Firebase harness: separate browser contexts
 * ("devices") share one database through server.js.
 *
 *   node test/harness/selftest.mjs
 *
 * Prints PASS/FAIL per check and exits non-zero if any check fails.
 */
import assert from 'node:assert/strict';
import { loadPlaywright, newDevice, startServer, waitFor, setDeviceOffline, whenSynced } from './helpers.mjs';

if (process.env.NODE_TEST_CONTEXT) {
  console.log('selftest.mjs: skipped under `node --test`; run it directly.');
  process.exit(0);
}

const PAGE = '/test/harness/selftest.html';
const TIMEOUT = { timeout: 5000 };
let failures = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const { chromium } = await loadPlaywright();
const server = await startServer();
const browser = await chromium.launch();

try {
  const A = await newDevice(browser, server.url, { label: 'A' });
  const B = await newDevice(browser, server.url, { label: 'B' });
  await Promise.all([A.page.goto(PAGE), B.page.goto(PAGE)]);

  // Tracks .info/connected through the public API and waits for `true`.
  const connected = async (page) => {
    await page.evaluate(() => {
      if (window.connectedLog) return;
      window.connectedLog = [];
      db.ref('.info/connected').on('value', (s) => connectedLog.push(s.val()));
    });
    await page.waitForFunction(() => connectedLog[connectedLog.length - 1] === true, null, TIMEOUT);
  };

  await check('.info/connected is true on both devices', async () => {
    await Promise.all([connected(A.page), connected(B.page)]);
  });

  await check('set / once round trip (and visible to the other device)', async () => {
    const value = { a: 1, b: 'x', nested: { c: true } };
    const got = await A.page.evaluate(async (v) => {
      await db.ref('selftest/roundtrip').set(v);
      return (await db.ref('selftest/roundtrip').once('value')).val();
    }, value);
    assert.deepEqual(got, value);
    assert.deepEqual(await server.dump('selftest/roundtrip'), value);
    assert.deepEqual(await B.page.evaluate(async () => (await db.ref('selftest/roundtrip').once('value')).val()), value);
  });

  await check('value listener on B sees a set from A (and never fires inside .on())', async () => {
    const firedSync = await B.page.evaluate(() => {
      window.live = [];
      let inside = true;
      let sync = false;
      db.ref('selftest/live').on('value', (s) => { if (inside) sync = true; live.push(s.val()); });
      inside = false;
      return sync;
    });
    assert.equal(firedSync, false);
    await B.page.waitForFunction(() => live.length === 1 && live[0] === null, null, TIMEOUT);
    await A.page.evaluate(() => db.ref('selftest/live').set('hello'));
    await B.page.waitForFunction(() => live.includes('hello'), null, TIMEOUT);
  });

  await check('child_added on B fires for existing children and for a push from A', async () => {
    await A.page.evaluate(() => db.ref('selftest/list/existing').set({ n: 0 }));
    await B.page.evaluate(() => {
      window.added = [];
      db.ref('selftest/list').on('child_added', (s) => added.push([s.key, s.val()]));
    });
    await B.page.waitForFunction(() => added.some(([k]) => k === 'existing'), null, TIMEOUT);
    const key = await A.page.evaluate(async () => {
      const ref = db.ref('selftest/list').push({ n: 1 });
      await ref;
      return ref.key;
    });
    assert.match(key, /^[-0-9A-Za-z_]{20}$/);
    await B.page.waitForFunction((k) => added.some(([key, v]) => key === k && v.n === 1), key, TIMEOUT);
  });

  await check('child_changed / child_removed on B for writes from A', async () => {
    await B.page.evaluate(() => {
      window.changed = [];
      window.removed = [];
      db.ref('selftest/list').on('child_changed', (s) => changed.push([s.key, s.val()]));
      db.ref('selftest/list').on('child_removed', (s) => removed.push([s.key, s.val()]));
    });
    await A.page.evaluate(async () => {
      await db.ref('selftest/list/existing/n').set(5);
      await db.ref('selftest/list/existing').remove();
    });
    await B.page.waitForFunction(() => changed.some(([k, v]) => k === 'existing' && v.n === 5) &&
      removed.some(([k, v]) => k === 'existing' && v.n === 5), null, TIMEOUT);
  });

  await check('multi-path update with null deletes (empty parents pruned)', async () => {
    await A.page.evaluate(async () => {
      await db.ref('selftest/multi').set({ keep: 1, drop: 2, deep: { x: 1, y: 2 } });
      await db.ref().update({
        'selftest/multi/drop': null,
        'selftest/multi/deep/x': null,
        'selftest/multi/added': 'new',
        'selftest/other/flag': true,
      });
    });
    assert.deepEqual(await server.dump('selftest/multi'), { keep: 1, deep: { y: 2 }, added: 'new' });
    assert.equal(await server.dump('selftest/other/flag'), true);
    await A.page.evaluate(() => db.ref('selftest/multi').update({ 'deep/y': null }));
    assert.deepEqual(await server.dump('selftest/multi'), { keep: 1, added: 'new' });
    await waitFor(async () => {
      const seen = await B.page.evaluate(async () => (await db.ref('selftest/multi').once('value')).val());
      return JSON.stringify(seen) === JSON.stringify({ added: 'new', keep: 1 }) ||
        JSON.stringify(seen) === JSON.stringify({ keep: 1, added: 'new' });
    }, { message: 'B to see the update' });
  });

  await check('ServerValue.TIMESTAMP resolves to the server time; arrays store as objects, read as arrays', async () => {
    const before = Date.now();
    const val = await A.page.evaluate(async () => {
      await db.ref('selftest/ts').set(firebase.database.ServerValue.TIMESTAMP);
      await db.ref('selftest/arr').set(['x', 'y', 'z']);
      return (await db.ref('selftest/arr').once('value')).val();
    });
    const ts = await server.dump('selftest/ts');
    assert.ok(typeof ts === 'number' && ts >= before && ts <= Date.now(), `timestamp ${ts}`);
    assert.deepEqual(await server.dump('selftest/arr'), { 0: 'x', 1: 'y', 2: 'z' });
    assert.deepEqual(val, ['x', 'y', 'z']);
  });

  await check('concurrent transactions from both devices never lose an increment', async () => {
    const run = (page) => page.evaluate(async () => {
      const results = await Promise.all(Array.from({ length: 15 }, () =>
        db.ref('selftest/counter').transaction((n) => (n || 0) + 1)));
      return results.every((r) => r.committed);
    });
    const [okA, okB] = await Promise.all([run(A.page), run(B.page)]);
    assert.ok(okA && okB, 'every transaction committed');
    assert.equal(await server.dump('selftest/counter'), 30);
  });

  await check('invalid data is rejected like the real SDK', async () => {
    const errors = await A.page.evaluate(() => {
      const attempt = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
      return [
        attempt(() => db.ref('selftest/bad').set({ a: undefined })),
        attempt(() => db.ref('selftest/bad.key')),
        attempt(() => db.ref().update({ 'a': 1, 'a/b': 2 })),
      ];
    });
    assert.match(errors[0], /contains undefined in property 'a'/);
    assert.match(errors[1], /invalid path/);
    assert.match(errors[2], /ancestor of another path/);
  });

  await check('route injection: gstatic SDK URLs serve the fake, qrcode is stubbed', async () => {
    const C = await newDevice(browser, server.url, { label: 'C' });
    await C.page.goto(`${PAGE}?via=gstatic`);
    await connected(C.page);
    const info = await C.page.evaluate(async () => ({
      fake: Boolean(firebase.__fake),
      qrcode: typeof QRCode === 'function' && QRCode.CorrectLevel.H === 2,
      roundtrip: (await db.ref('selftest/roundtrip').once('value')).val(),
    }));
    assert.deepEqual(info, { fake: true, qrcode: true, roundtrip: { a: 1, b: 'x', nested: { c: true } } });
    await C.context.close();
  });

  await check('server offline: connected flips false, writes queue, then land on reconnect', async () => {
    await server.setOffline(true);
    await B.page.waitForFunction(() => firebase.__fake.connected === false, null, TIMEOUT);
    const local = await B.page.evaluate(async () => {
      db.ref('selftest/offline').set('queued');
      return (await db.ref('selftest/offline').once('value')).val(); // optimistic local apply
    });
    assert.equal(local, 'queued');
    assert.equal(await server.dump('selftest/offline'), null);
    await server.setOffline(false);
    await Promise.all([connected(A.page), connected(B.page)]);
    await whenSynced(B.page);
    assert.equal(await server.dump('selftest/offline'), 'queued');
  });

  await check('db.goOffline() runs the device\'s onDisconnect ops; goOnline() reconnects', async () => {
    await B.page.evaluate(async () => {
      await db.ref('selftest/presence/B').set(true);
      await db.ref('selftest/presence/B').onDisconnect().remove();
    });
    await setDeviceOffline(B.page, true);
    await waitFor(async () => (await server.dump('selftest/presence/B')) === null, { message: 'presence/B removed' });
    await setDeviceOffline(B.page, false);
    await connected(B.page);
  });

  await check('onDisconnect().remove() / .set(TIMESTAMP) run when context A closes', async () => {
    await A.page.evaluate(async () => {
      await db.ref('selftest/presence/A').set(true);
      await db.ref('selftest/presence/A').onDisconnect().remove();
      await db.ref('selftest/lastSeen/A').onDisconnect().set(firebase.database.ServerValue.TIMESTAMP);
    });
    await B.page.evaluate(() => {
      window.presence = [];
      db.ref('selftest/presence/A').on('value', (s) => presence.push(s.val()));
    });
    await B.page.waitForFunction(() => presence.includes(true), null, TIMEOUT);
    assert.equal(await server.dump('selftest/presence/A'), true);
    await A.context.close();
    await waitFor(async () => (await server.dump('selftest/presence/A')) === null, { message: 'presence/A removed' });
    assert.equal(typeof (await server.dump('selftest/lastSeen/A')), 'number');
    await B.page.waitForFunction(() => presence[presence.length - 1] === null, null, TIMEOUT);
  });
} finally {
  await browser.close();
  await server.stop();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
