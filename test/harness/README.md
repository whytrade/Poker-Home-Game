# Browser test harness

A fake Firebase Realtime Database that lets several Playwright browser contexts
("devices") share one realtime database with no network access.

| File | What it is |
| --- | --- |
| `server.js` | Zero-dependency static server for the repo + in-memory database (SSE + JSON endpoints) |
| `fake-firebase.js` | Browser stand-in for the `firebase-app-compat` / `firebase-database-compat` SDK (also the shared tree logic `server.js` requires) |
| `helpers.mjs` | `startServer()`, `newDevice()`, `loadPlaywright()` and friends |
| `selftest.mjs` / `selftest.html` | Two-device self-test of the harness |

## Run

```sh
node test/harness/server.js [port]   # default 4173, 0 = any free port; serves the repo root
node test/harness/selftest.mjs       # PASS/FAIL per check, non-zero exit on failure
```

`DEBUG_DB=1` logs every mutation. Database endpoints: `GET /__db/stream`,
`POST /__db/write`, `POST /__db/ondisconnect`, `GET /__db/dump?path=`,
`POST /__db/reset`, `POST /__db/offline {offline}`, `GET /__db/status`
(details at the top of `server.js`).

## Injecting the fake into app pages

`newDevice()` does this for you. By hand it is:

```js
const fake = fs.readFileSync('test/harness/fake-firebase.js', 'utf8');
await context.route('https://www.gstatic.com/firebasejs/**', (route) => route.fulfill({
  status: 200,
  contentType: 'text/javascript',
  body: route.request().url().endsWith('/firebase-app-compat.js') ? fake : '',
}));
```

The page must be served by `server.js`, because the fake talks to `/__db/*` on
the page's own origin. You can point it elsewhere with
`window.FAKE_FIREBASE_OPTIONS = { serverUrl }` in an init script.

## Helpers

```js
import { loadPlaywright, startServer, newDevice, waitFor, setDeviceOffline, whenSynced } from './harness/helpers.mjs';

const { chromium } = await loadPlaywright();      // local install, else the global npm root
const server = await startServer();              // { url, port, stop, dump, reset, seed, write, setOffline, status }
const browser = await chromium.launch();
const host = await newDevice(browser, server.url, { label: 'host', viewport: { width: 390, height: 844 } });
const guest = await newDevice(browser, server.url, { label: 'guest' });
await host.page.goto('/');                        // baseURL = server.url
await guest.page.goto('/buy-in.html?game=ABC');

await waitFor(async () => (await server.dump('games/ABC/players')) !== null, { message: 'player joined' });
await whenSynced(guest.page);                     // every write from that page acknowledged and echoed
await setDeviceOffline(guest.page, true);         // db.goOffline(): the server runs its onDisconnect ops
await server.setOffline(true);                    // every device loses the server at once

await browser.close();
await server.stop();
```

`newDevice` routes `firebase-app-compat.js` to the fake, other gstatic Firebase
scripts to an empty body, any external `qrcode` URL to a tiny `QRCode` stub
(`el.textContent = 'QR:' + text`), and other external URLs to the real network
when reachable, otherwise an empty script or stylesheet. Console errors and
uncaught exceptions are printed as `[label] ...`; pass
`console: 'warnings' | 'all' | false` to change that.

## How close it is to real Firebase

Matches: `ref/child/parent/key/root`, `set/update/remove/push` (Firebase push
IDs), multi-path `update` with `null` deletes, `transaction` (compare-and-set,
safe across devices), `once`, `on/off` for `value`, `child_added`,
`child_changed` and `child_removed`, `onDisconnect().set/update/remove/cancel`,
`.info/connected`, `ServerValue.TIMESTAMP` and `increment()`, `goOffline/goOnline`.
Writes fire local listeners before the server answers, and queue while offline.
Listeners attached with `.on()` always fire asynchronously.

These behave like the real SDK, so expect them:

- Arrays are stored as objects keyed `"0"`, `"1"`, … (that is what `dump()`
  shows), but `snapshot.val()` turns them back into arrays (with holes where
  items were deleted), using Firebase's rule.
- `set({ a: undefined })`, invalid keys (`.`, `#`, `$`, `/`, `[`, `]`) and
  overlapping `update()` paths throw synchronously. Pass
  `FAKE_FIREBASE_OPTIONS = { strict: false }` to drop `undefined` instead.
- Empty objects are never stored, and deleting the last child removes the parent.
- `firebase.database()` throws if no app has been initialized.
- When a stream drops (context closed, `goOffline()`, server offline), the
  server runs that connection's onDisconnect ops. They are not re-armed on
  reconnect, so register them again in your `.info/connected` handler.

Not supported: `orderBy*`, `limitTo*`, `startAt/endAt/equalTo` (these throw),
priorities, security rules, and `child_moved`.

`node --test` with no arguments also picks up files under `test/`, so
`server.js` and `selftest.mjs` exit straight away when `NODE_TEST_CONTEXT` is
set. `startServer()` clears that variable for the server it spawns.
