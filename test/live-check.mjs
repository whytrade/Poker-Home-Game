// Live smoke test against the deployed sites + real Firebase. Run on CI
// (GitHub Actions) where the network is open. Writes diag/report.json and
// screenshots to diag/.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const OUT = 'diag';
fs.mkdirSync(OUT, { recursive: true });
const DB = 'https://poker-home-game-699e7-default-rtdb.asia-southeast1.firebasedatabase.app';
const report = { at: new Date().toISOString(), sites: [], db: {}, flow: {}, errors: [] };

const candidates = [
    process.env.PROD_DEPLOY_URL,
    'https://poker-home-game-five.vercel.app',
    'https://poker-home-game-taodoggers-projects.vercel.app',
    'https://poker-home-game.vercel.app',
    'https://poker-home-game-699e7.web.app'
].filter(Boolean);

for (const url of candidates) {
    try {
        const res = await fetch(url + '/', { redirect: 'follow' });
        const body = await res.text();
        report.sites.push({
            url, status: res.status, finalUrl: res.url,
            title: (body.match(/<title>([^<]*)/) || [])[1] || null,
            isNewApp: body.includes('js/host.js'),
            walled: /Vercel Authentication|Security Checkpoint|Log in to Vercel|sso-api|vercel\.com\/login/i.test(body),
            snippet: body.replace(/\s+/g, ' ').slice(0, 300)
        });
    } catch (e) { report.sites.push({ url, error: String(e) }); }
}

// Real database: read, write, read back, delete.
const key = 'zz_healthcheck_' + Date.now();
async function rest(method, path, body) {
    const r = await fetch(`${DB}/${path}.json${method === 'GET' ? '?shallow=true' : ''}`, { method, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: (await r.text()).slice(0, 200) };
}
report.db.readGames = await rest('GET', 'games');
report.db.write = await rest('PUT', `games/${key}`, { v: 2, healthcheck: true });
report.db.readBack = await rest('GET', `games/${key}`);
report.db.delete = await rest('DELETE', `games/${key}`);
report.db.ok = [report.db.readGames, report.db.write, report.db.readBack, report.db.delete].every(r => r.status === 200);
delete report.db.readGames.text;

// Full flow on the first Vercel URL that serves the new app.
const site = report.sites.find(s => s.isNewApp && /vercel\.app/.test(s.finalUrl || s.url)) || report.sites.find(s => s.isNewApp);
report.flow.site = site ? site.url : null;
let code = null;
if (site) {
    const browser = await chromium.launch();
    const iphone = devices['iPhone 13'];
    const host = await browser.newContext({ ...iphone });
    const hp = await host.newPage();
    hp.on('pageerror', e => report.errors.push('host: ' + e.message));
    hp.on('console', m => { if (m.type() === 'error') report.errors.push('host console: ' + m.text()); });
    try {
        await hp.goto(site.url + '/index.html', { waitUntil: 'networkidle' });
        await hp.screenshot({ path: `${OUT}/1-host-setup.png` });
        await hp.fill('#setup-name', 'Diag check');
        await hp.click('button:has-text("Create game")');
        await hp.waitForSelector('.join-card', { timeout: 15000 });
        code = (await hp.textContent('#topbar-code')).trim();
        report.flow.code = code;
        try { await hp.waitForSelector('#sync-dot[data-state="ok"]', { timeout: 15000 }); report.flow.hostLive = true; }
        catch (e) { report.flow.hostLive = false; }
        report.flow.syncLabel = await hp.textContent('#sync-label');
        report.flow.joinUrl = await hp.evaluate(c => window.KapokerUI.pageUrl('buy-in.html', { game: c }), code);
        await hp.waitForTimeout(1500);
        await hp.screenshot({ path: `${OUT}/2-host-live.png` });

        const phone = await browser.newContext({ ...iphone });
        const pp = await phone.newPage();
        pp.on('pageerror', e => report.errors.push('phone: ' + e.message));
        await pp.goto(report.flow.joinUrl, { waitUntil: 'networkidle' });
        await pp.fill('input[aria-label="Your name"]', 'Bot');
        await pp.screenshot({ path: `${OUT}/3-phone-join.png` });
        await pp.click('button[type="submit"]');
        try { await pp.waitForSelector('.me-name', { timeout: 20000 }); report.flow.phoneJoined = true; }
        catch (e) { report.flow.phoneJoined = false; }
        await pp.waitForTimeout(800);
        await pp.screenshot({ path: `${OUT}/4-phone-after-join.png` });
        try { await hp.waitForSelector('.player-row:has-text("Bot")', { timeout: 10000 }); report.flow.hostSawPhone = true; }
        catch (e) { report.flow.hostSawPhone = false; }
        await hp.fill('input[aria-label="Player name"]', 'Manual');
        await hp.click('.add-player button[type="submit"]');
        await hp.waitForTimeout(1200);
        await hp.screenshot({ path: `${OUT}/5-host-two-players.png` });
        await hp.click('button:has-text("End game")');
        await hp.click('.sheet button:has-text("End it")');
        try {
            await pp.waitForSelector('text=How many chips do you have?', { timeout: 15000 });
            await pp.fill('input[aria-label="Your chip count"]', '1500');
            await pp.click('button:has-text("Send")');
            await hp.waitForFunction(() => [...document.querySelectorAll('.count-row')].some(r => r.querySelector('.src-badge').dataset.src === 'player'), null, { timeout: 15000 });
            report.flow.countArrived = true;
        } catch (e) { report.flow.countArrived = false; }
        await hp.fill('.count-row:has-text("Manual") .count-input', '500');
        await hp.waitForTimeout(500);
        await hp.click('button:has-text("Settle up")');
        try { await hp.waitForSelector('.transfer', { timeout: 10000 }); report.flow.settled = (await hp.locator('.transfer').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')); }
        catch (e) { report.flow.settled = false; }
        await hp.waitForTimeout(1500);
        await hp.screenshot({ path: `${OUT}/6-host-settled.png` });
        await pp.waitForTimeout(1500);
        await pp.screenshot({ path: `${OUT}/7-phone-settled.png` });
    } catch (e) {
        report.errors.push('flow: ' + e.message.split('\n')[0]);
        try { await hp.screenshot({ path: `${OUT}/x-host-error.png` }); } catch (_) {}
    }
    await browser.close();
}
if (code) report.flow.cleanup = (await rest('DELETE', `games/${code}`)).status;

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
