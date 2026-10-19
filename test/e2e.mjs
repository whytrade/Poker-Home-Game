// End-to-end test: one host + several phones against the fake Firebase.
// Run: npm run test:e2e   (screenshots go to $SHOTS or test/.shots)
import { startServer, newDevice, loadPlaywright } from './harness/helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = await loadPlaywright();
const SHOTS = process.env.SHOTS || path.join(path.dirname(new URL(import.meta.url).pathname), '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 860 };

const server = await startServer();
const browser = await chromium.launch();
let failures = 0;
let step = 0;

async function shot(page, name) {
    step += 1;
    const junk = await page.evaluate(() => (document.body.innerText.match(/\b(null|undefined|NaN)\b/) || [])[0]);
    if (junk) { failures += 1; console.log(`FAIL stray "${junk}" text on screen: ${name}`); }
    await page.screenshot({ path: path.join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
}

async function check(name, fn) {
    try {
        await fn();
        console.log('PASS', name);
    } catch (err) {
        failures += 1;
        console.log('FAIL', name, '\n   ', err && err.message ? err.message.split('\n').slice(0, 6).join('\n    ') : err);
    }
}

const text = loc => loc.innerText();

try {
    // ---------- host creates a game ----------
    const host = await newDevice(browser, server.url, { viewport: LAPTOP, label: 'host' });
    await host.page.goto(server.url + '/index.html');
    await host.page.fill('#setup-name', 'Test Night');
    await host.page.fill('#setup-money', '20');
    await host.page.fill('#setup-chips', '1000');
    await shot(host.page, 'host-setup');
    await host.page.click('button:has-text("Create game")');
    await host.page.waitForSelector('.join-card');
    const code = (await text(host.page.locator('#topbar-code'))).trim();
    await check('game created with a code', async () => {
        assert.match(code, /^[A-Z2-9]{5}$/);
        await host.page.waitForSelector('#sync-dot[data-state="ok"]', { timeout: 5000 });
    });

    // ---------- phones join ----------
    const mia = await newDevice(browser, server.url, { viewport: PHONE, label: 'mia' });
    await mia.page.goto(`${server.url}/buy-in.html?game=${code}`);
    await mia.page.waitForSelector('button[type="submit"]:has-text("Buy in")');
    await shot(mia.page, 'phone-join');
    await mia.page.fill('input[aria-label="Your name"]', 'Mia');
    await mia.page.click('button[type="submit"]:has-text("Buy in")');
    await check('Mia joins from her phone', async () => {
        await mia.page.waitForSelector('.me-name:has-text("Mia")', { timeout: 5000 });
        assert.equal(await text(mia.page.locator('.hero-amount')), '$20');
    });
    await shot(mia.page, 'phone-joined');

    const leo = await newDevice(browser, server.url, { viewport: PHONE, label: 'leo' });
    await leo.page.goto(`${server.url}/buy-in.html?game=${code}`);
    await leo.page.fill('input[aria-label="Your name"]', 'Leo');
    await leo.page.click('.chip-btn:has-text("$40")');
    await leo.page.click('button[type="submit"]:has-text("Buy in")');
    await check('Leo joins with a 2x buy-in', async () => {
        await leo.page.waitForSelector('.me-name:has-text("Leo")', { timeout: 5000 });
        assert.equal(await text(leo.page.locator('.hero-amount')), '$40');
    });

    await check('host sees both phone players', async () => {
        await host.page.waitForSelector('.player-row:has-text("Mia")');
        await host.page.waitForSelector('.player-row:has-text("Leo")');
        await host.page.waitForFunction(() => [...document.querySelectorAll('.player-row')].some(r => r.textContent.includes('Leo') && r.querySelector('.pamt').textContent === '$40'), null, { timeout: 3000 });
    });

    // ---------- host adds a player by hand + one-tap buy-in ----------
    await host.page.fill('input[aria-label="Player name"]', 'Sam');
    await host.page.click('.add-player button[type="submit"]');
    await host.page.waitForSelector('.player-row:has-text("Sam")');
    await host.page.click('.player-row:has-text("Sam") .btn-plus');
    await check('manual player + one-tap buy-in', async () => {
        await host.page.waitForFunction(() => {
            const row = [...document.querySelectorAll('.player-row')].find(r => r.textContent.includes('Sam'));
            return row && row.querySelector('.pamt').textContent === '$40';
        });
    });

    // ---------- phone rebuy ----------
    await mia.page.click('button[type="submit"]:has-text("Rebuy")');
    await check('Mia rebuys from her phone', async () => {
        await mia.page.waitForFunction(() => document.querySelector('.hero-amount').textContent === '$40', null, { timeout: 5000 });
        await host.page.waitForFunction(() => {
            const row = [...document.querySelectorAll('.player-row')].find(r => r.textContent.includes('Mia'));
            return row && row.querySelector('.pamt').textContent === '$40';
        });
    });
    await check('pot total is $120', async () => {
        await host.page.waitForFunction(() => document.querySelector('.stat-main .stat-value').textContent === '$120', null, { timeout: 3000 });
    });
    await shot(host.page, 'host-live');

    // ---------- undo ----------
    await host.page.click('.player-row:has-text("Sam") .btn-plus');
    await host.page.waitForFunction(() => document.querySelector('.stat-main .stat-value').textContent === '$140');
    await host.page.click('.toast-action:has-text("Undo")');
    await check('undo removes the accidental buy-in', async () => {
        await host.page.waitForFunction(() => document.querySelector('.stat-main .stat-value').textContent === '$120');
    });

    // ---------- host offline: rebuy queues, then applies when host is back ----------
    const hostCtx = host.context;
    await host.page.close();
    await leo.page.click('button[type="submit"]:has-text("Rebuy")');
    await check('rebuy waits while the host page is closed', async () => {
        await leo.page.waitForSelector('#pending-bar', { timeout: 3000 });
    });
    await shot(leo.page, 'phone-pending');
    const hostPage = await hostCtx.newPage();
    host.page = hostPage;
    await hostPage.goto(server.url + '/index.html');
    await check('host reopens in a new tab and the queued rebuy lands', async () => {
        await hostPage.waitForSelector('.player-row:has-text("Leo")', { timeout: 8000 });
        await hostPage.waitForFunction(() => {
            const row = [...document.querySelectorAll('.player-row')].find(r => r.textContent.includes('Leo'));
            return row && row.querySelector('.pamt').textContent === '$60';
        }, null, { timeout: 8000 });
        await leo.page.waitForFunction(() => !document.getElementById('pending-bar'), null, { timeout: 5000 });
        await leo.page.waitForFunction(() => document.querySelector('.hero-amount').textContent === '$60', null, { timeout: 3000 });
    });

    // ---------- end game ----------
    await hostPage.click('button:has-text("End game")');
    await hostPage.click('.sheet button:has-text("End it")');
    await check('phones are prompted for their count', async () => {
        await mia.page.waitForSelector('text=How many chips do you have?', { timeout: 5000 });
        await leo.page.waitForSelector('text=How many chips do you have?', { timeout: 5000 });
    });
    await shot(mia.page, 'phone-count');
    // Bought: Mia 2000, Leo 3000, Sam 2000 = 7000 chips.
    await mia.page.fill('input[aria-label="Your chip count"]', '4,500');
    await mia.page.click('button:has-text("Send")');
    await leo.page.fill('input[aria-label="Your chip count"]', '700');
    await leo.page.click('button:has-text("Send")');
    await check('player counts arrive with a phone badge', async () => {
        await hostPage.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.count-row')];
            const mia = rows.find(r => r.textContent.includes('Mia'));
            const leo = rows.find(r => r.textContent.includes('Leo'));
            return mia && leo && mia.querySelector('.count-input').value === '4,500' &&
                leo.querySelector('.count-input').value === '700' &&
                mia.querySelector('.src-badge').dataset.src === 'player';
        }, null, { timeout: 5000 });
        await mia.page.waitForSelector('.count-status:has-text("Host has 4,500")');
    });
    // Host types Sam's count with a deliberate miscount first.
    const samInput = hostPage.locator('.count-row:has-text("Sam") .count-input');
    await samInput.fill('1700');
    await check('mismatch is flagged', async () => {
        await hostPage.waitForSelector('.meter-status:has-text("100 chips missing")');
    });
    await shot(hostPage, 'host-count-mismatch');
    await hostPage.click('button:has-text("Settle up")');
    await check('settling with missing chips asks first', async () => {
        await hostPage.waitForSelector('.sheet:has-text("Chips don\'t add up")');
    });
    await shot(hostPage, 'host-mismatch-sheet');
    await hostPage.click('.sheet button:has-text("Fix counts")');
    await samInput.fill('1800');
    await check('balanced after fixing the count', async () => {
        await hostPage.waitForSelector('.meter-status:has-text("Balanced")');
    });
    await hostPage.click('button:has-text("Settle up")');

    // ---------- settlement ----------
    // Nets: Mia 4500-2000 = +2500 chips = +$50; Leo 700-3000 = -$46; Sam 1800-2000 = -$4.
    await check('host shows exact payments', async () => {
        await hostPage.waitForSelector('.transfer');
        const rows = await hostPage.locator('.transfer').allInnerTexts();
        const flat = rows.map(r => r.replace(/\s+/g, ' ').trim());
        assert.deepEqual(flat.sort(), ['Leo → Mia $46', 'Sam → Mia $4'].sort());
    });
    await shot(hostPage, 'host-settled');
    await check('phones show personal results', async () => {
        await mia.page.waitForSelector('.hero-card:has-text("You won")', { timeout: 5000 });
        assert.equal(await text(mia.page.locator('.hero-card .hero-amount')), '$50');
        await leo.page.waitForSelector('.hero-card:has-text("You lost")', { timeout: 5000 });
        assert.equal(await text(leo.page.locator('.hero-card .hero-amount')), '$46');
    });
    await shot(leo.page, 'phone-settled');

    await leo.page.click('.transfer:has-text("Leo") .check');
    await check('paid tick syncs to the host', async () => {
        await hostPage.waitForSelector('.transfer.is-paid:has-text("Leo")', { timeout: 5000 });
    });

    // ---------- results page ----------
    const viewer = await newDevice(browser, server.url, { viewport: PHONE, label: 'viewer' });
    await viewer.page.goto(`${server.url}/results.html?game=${code}`);
    await check('shareable results page', async () => {
        await viewer.page.waitForSelector('.transfer.is-paid:has-text("Leo")', { timeout: 5000 });
        await viewer.page.waitForSelector('.standings:has-text("Mia")');
    });
    await shot(viewer.page, 'results-page');

    // ---------- persistence ----------
    await hostPage.reload();
    await check('host reload keeps the settled game', async () => {
        await hostPage.waitForSelector('.transfer:has-text("Leo")', { timeout: 5000 });
        assert.equal((await text(hostPage.locator('#topbar-code'))).trim(), code);
    });

    // ---------- take over from another device ----------
    const host2 = await newDevice(browser, server.url, { viewport: PHONE, label: 'host2' });
    await host2.page.goto(server.url + '/index.html');
    await host2.page.fill('input[aria-label="Game code"]', code);
    await host2.page.click('button:has-text("Host it")');
    await check('second device takes over hosting', async () => {
        await host2.page.waitForSelector('.transfer:has-text("Leo")', { timeout: 5000 });
        await hostPage.waitForSelector('text=Hosted on another device', { timeout: 5000 });
    });
    await shot(host2.page, 'host2-phone');

    // ---------- money integrity in the stored data ----------
    await check('published snapshot matches', async () => {
        const db = await server.dump();
        const snap = db.games[code].snapshot;
        assert.equal(snap.status, 'settled');
        const transfers = Object.values(snap.settlement.transfers);
        assert.equal(transfers.reduce((s, t) => s + t.cents, 0), 5000);
        const nets = Object.values(snap.settlement.nets);
        assert.equal(nets.reduce((a, b) => a + b, 0), 0);
        assert.equal(Object.keys(db.games[code].requests || {}).length, 0, 'all requests consumed');
    });
} catch (err) {
    failures += 1;
    console.log('FAIL (crashed)', err);
} finally {
    await browser.close();
    await server.stop();
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll e2e checks passed');
console.log('Screenshots:', SHOTS);
process.exit(failures ? 1 : 0);
