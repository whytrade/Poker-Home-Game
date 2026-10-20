# 🃏 Kapoker

Run a home poker game from one device. Players scan a QR code to buy in and rebuy from their phones, the host sees everything live, and at the end the app works out exactly who pays who.

## How a game night works

1. **Host** opens the site (laptop or phone), names the game and sets the buy-in, e.g. `$20 gets 1,000 chips`, then taps **Create game**.
2. **Players** scan the QR code (or open `buy-in.html` and type the 5-letter code), enter their name and pick a buy-in. It shows up on the host's screen right away, marked 📱.
3. **Rebuys**: players tap **Rebuy** on their phone, or the host taps **+$20** on that player's row. Every buy-in is in the Activity list with an **Undo** button, and a player's ⋯ menu covers custom amounts, removing a buy-in, renaming and removing the player.
4. **End game & count chips**: buy-ins close and every phone asks *"How many chips do you have?"*. When a player sends their count, a 📱 appears next to it on the host. The host can type or correct any count; ✓ means the host entered it, ⏳ means it's still missing.
5. The counting screen shows **counted vs. bought chips** live. **Settle up** works once every count is in:
   - Chips balance → exact payments.
   - Chips don't balance → the app tells you how many are missing or extra. You can fix the counts, or **Settle anyway**, which splits the pot by chips counted so the books still balance.
6. **Payments** show as `Leo → Mia $46` (the fewest payments possible). Anyone can tick a payment as paid; everyone sees it live. **Share results** sends a link to `results.html`.

Need to switch devices mid-game? On the new device, type the game code under **Continue a game** and tap **Host it here**. The old device stops hosting.

## How the data works (why the numbers stay right)

- The **host device owns the game.** The full game lives in the host browser's `localStorage`, and all the math happens there (`js/core.js`).
- **Phones never edit the game.** They push *requests* (`join`, `buyin`, `final`) to Firebase. The host applies each one exactly once (requests are idempotent by ID), then publishes a read-only **snapshot** along with an **ack** in a single atomic write.
- One writer means no race conditions: a phone rebuy can't overwrite a host edit, and an incoming update can't clobber a number the host is typing.
- If the host's screen is off, phone requests wait in Firebase and go through when it's back. Players see a "waiting for host" banner.
- Money is integer **cents** and chips are integers. Payouts use exact rational (BigInt) math with largest-remainder rounding, so nets always sum to exactly $0.00 and every payment is within a cent of the exact value.

Firebase layout (`games/{CODE}`): `host` (lease), `presence/host`, `snapshot`, `requests/*`, `acks/*`, `paid/*`.

## Files

| File | What it is |
| --- | --- |
| `index.html` + `js/host.js` | Host app |
| `buy-in.html` + `js/player.js` | Player phone page |
| `results.html` + `js/results.js` | Shareable live results |
| `js/core.js` | Pure game logic and settlement math (no DOM, no Firebase) |
| `js/sync.js` | The only file that talks to Firebase |
| `js/ui.js` | Shared UI helpers (sheets, toasts, QR, settlement view) |
| `css/app.css` | All styles, mobile first |
| `next-app/` | Older experimental Next.js/Capacitor port, not deployed |

## Develop & test

No build step. It's static files.

```bash
npm test            # unit tests for the game logic and payouts (node --test)
npm run dev         # static server at http://localhost:4173 (talks to the real Firebase)
npm run test:e2e    # host + phones end-to-end in headless Chromium (fake Firebase)
```

## Deploy

- **Firebase Hosting**: pushing to the `live` branch deploys via GitHub Actions. PRs get a preview channel.
- **Vercel**: static, output directory `.` (see `vercel.json`).

## License

MIT, see [LICENSE](LICENSE).
