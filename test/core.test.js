// Unit tests for js/core.js — run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../js/core.js');

const RATE = { cents: 2000, chips: 1000 }; // $20 = 1000 chips (2c per chip)

function gameWith(players, rate = RATE) {
    // players: [{ name, buys: [chips...], final }]
    let g = K.createGame({ code: 'TEST1', name: 'Test', rate, now: 1 });
    players.forEach(p => {
        const r = K.addPlayer(g, { name: p.name, now: 2 });
        g = r.game;
        (p.buys || []).forEach(chips => { g = K.addBuyIn(g, { playerId: r.result.id, chips, now: 3 }).game; });
    });
    if (players.some(p => p.final !== undefined)) {
        g = K.endGame(g, 4).game;
        players.forEach(p => {
            if (p.final === undefined) return;
            const id = K.findPlayerByName(g, p.name).id;
            g = K.setFinal(g, id, p.final, 'host', 5).game;
        });
    }
    return g;
}

function sumTransfers(transfers) {
    const net = {};
    transfers.forEach(t => {
        net[t.from] = (net[t.from] || 0) - t.cents;
        net[t.to] = (net[t.to] || 0) + t.cents;
    });
    return net;
}

test('parsing money and chips', () => {
    assert.equal(K.parseMoneyToCents('20'), 2000);
    assert.equal(K.parseMoneyToCents('$20.5'), 2050);
    assert.equal(K.parseMoneyToCents('1,000.05'), 100005);
    assert.ok(Number.isNaN(K.parseMoneyToCents('abc')));
    assert.ok(Number.isNaN(K.parseMoneyToCents('1.234')));
    assert.equal(K.parseChips('1,250'), 1250);
    assert.equal(K.parseChips(' 300 '), 300);
    assert.ok(Number.isNaN(K.parseChips('12.5')));
    assert.ok(Number.isNaN(K.parseChips('-5')));
    assert.ok(Number.isNaN(K.parseChips('')));
});

test('rate conversions are exact and floor partial chips', () => {
    assert.equal(K.chipsForCents(RATE, 2000), 1000);
    assert.equal(K.chipsForCents(RATE, 5000), 2500);
    const odd = { cents: 3000, chips: 1000 }; // $30 = 1000 chips
    assert.equal(K.chipsForCents(odd, 1000), 333); // $10 -> 333.33 -> 333
    assert.equal(K.centsForChips(odd, 333), 999);
    assert.equal(K.centsForChips(RATE, -250), -500);
    // float-trap rate: $0.10 per 3 chips
    assert.equal(K.centsForChips({ cents: 10, chips: 3 }, 3), 10);
});

test('formatting', () => {
    assert.equal(K.formatMoney(2000), '$20');
    assert.equal(K.formatMoney(2050), '$20.50');
    assert.equal(K.formatMoney(-705), '−$7.05');
    assert.equal(K.formatMoney(705, { signed: true }), '+$7.05');
    assert.equal(K.formatMoney(123456789), '$1,234,567.89');
    assert.equal(K.formatChips(12500), '12,500');
});

test('simple exact settlement', () => {
    const g = gameWith([
        { name: 'Alice', buys: [1000], final: 1800 },
        { name: 'Bob', buys: [1000], final: 200 },
        { name: 'Cara', buys: [1000, 1000], final: 2000 }
    ]);
    const s = K.computeSettlement(g);
    assert.equal(s.ok, true);
    assert.equal(s.mode, 'exact');
    const byName = Object.fromEntries(s.rows.map(r => [r.name, r.netCents]));
    assert.deepEqual(byName, { Alice: 1600, Bob: -1600, Cara: 0 });
    assert.equal(s.transfers.length, 1);
    assert.equal(s.transfers[0].cents, 1600);
    assert.equal(K.findPlayer(g, s.transfers[0].from).name, 'Bob');
    assert.equal(K.findPlayer(g, s.transfers[0].to).name, 'Alice');
});

test('nets always sum to zero and transfers reproduce nets (randomized)', () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const rates = [RATE, { cents: 3000, chips: 1000 }, { cents: 5000, chips: 3000 }, { cents: 100, chips: 7 }, { cents: 2500, chips: 2500 }];
    for (let trial = 0; trial < 400; trial++) {
        const rate = rates[trial % rates.length];
        const n = 2 + Math.floor(rnd() * 8);
        const players = [];
        let pool = 0;
        for (let i = 0; i < n; i++) {
            const buys = [];
            const k = 1 + Math.floor(rnd() * 3);
            for (let j = 0; j < k; j++) buys.push(1 + Math.floor(rnd() * 3000));
            pool += buys.reduce((a, b) => a + b, 0);
            players.push({ name: 'P' + i, buys });
        }
        // random conserved split of the pool
        let left = pool;
        players.forEach((p, i) => {
            const take = i === players.length - 1 ? left : Math.floor(rnd() * left * 0.6);
            p.final = take; left -= take;
        });
        const g = gameWith(players, rate);
        const s = K.computeSettlement(g);
        assert.equal(s.ok, true, s.message);
        const total = s.rows.reduce((a, r) => a + r.netCents, 0);
        assert.equal(total, 0, 'nets must sum to 0');
        s.rows.forEach(r => {
            const exact = (r.final - r.boughtChips) * rate.cents / rate.chips;
            assert.ok(Math.abs(r.netCents - exact) < 1 + 1e-9, `within a cent: ${r.netCents} vs ${exact}`);
        });
        const flows = sumTransfers(s.transfers);
        s.rows.forEach(r => assert.equal(flows[r.playerId] || 0, r.netCents));
        assert.ok(s.transfers.length <= s.rows.length - 1);
        s.transfers.forEach(t => assert.ok(t.cents > 0));
    }
});

test('chip mismatch blocks exact mode with a clear message', () => {
    const g = gameWith([
        { name: 'A', buys: [1000], final: 1500 },
        { name: 'B', buys: [1000], final: 300 }
    ]);
    const s = K.computeSettlement(g);
    assert.equal(s.ok, false);
    assert.equal(s.code, 'chip-mismatch');
    assert.equal(s.diffChips, -200);
    assert.match(s.message, /200 chips missing/);
});

test('spread mode balances the books when chips do not add up', () => {
    const g = gameWith([
        { name: 'A', buys: [1000], final: 1500 },
        { name: 'B', buys: [1000], final: 300 }
    ]);
    const s = K.computeSettlement(g, { mode: 'spread' });
    assert.equal(s.ok, true);
    assert.equal(s.mode, 'spread');
    // pot $40 split 1500:300 -> A cashes 33.33, B 6.67
    const byName = Object.fromEntries(s.rows.map(r => [r.name, r.netCents]));
    assert.equal(byName.A + byName.B, 0);
    assert.equal(byName.A, 1333);
    assert.equal(byName.B, -1333);
});

test('missing counts block settlement; zero-buy-in players are ignored', () => {
    let g = gameWith([
        { name: 'A', buys: [1000] },
        { name: 'B', buys: [1000] },
        { name: 'Ghost', buys: [] }
    ]);
    g = K.endGame(g, 10).game;
    let s = K.computeSettlement(g);
    assert.equal(s.code, 'missing-counts');
    assert.deepEqual(s.missing, ['A', 'B']);
    g = K.setFinal(g, K.findPlayerByName(g, 'A').id, 2000, 'host').game;
    g = K.setFinal(g, K.findPlayerByName(g, 'B').id, '0', 'player').game;
    s = K.computeSettlement(g);
    assert.equal(s.ok, true);
    assert.equal(s.rows.length, 2);
    assert.equal(s.transfers.length, 1);
    assert.equal(s.transfers[0].cents, 2000);
});

test('busted player (final 0) pays their full buy-in', () => {
    const g = gameWith([
        { name: 'A', buys: [1000, 1000, 1000], final: 0 },
        { name: 'B', buys: [1000], final: 4000 }
    ]);
    const s = K.computeSettlement(g);
    assert.equal(s.transfers.length, 1);
    assert.equal(s.transfers[0].cents, 6000);
});

test('summary totals and diff', () => {
    let g = gameWith([
        { name: 'A', buys: [1000, 500] },
        { name: 'B', buys: [1000] }
    ]);
    let sum = K.summarize(g);
    assert.equal(sum.totals.boughtChips, 2500);
    assert.equal(sum.totals.boughtCents, 5000);
    assert.equal(sum.rows[0].buyInCount, 2);
    g = K.endGame(g).game;
    g = K.setFinal(g, K.findPlayerByName(g, 'A').id, 2000, 'host').game;
    sum = K.summarize(g);
    assert.equal(sum.totals.allCounted, false);
    assert.deepEqual(sum.totals.missingCounts, ['B']);
    assert.equal(sum.rows[0].netCents, 1000);
});

test('status rules: buy-ins only while live, counts only while counting', () => {
    let g = gameWith([{ name: 'A', buys: [1000] }, { name: 'B', buys: [1000] }]);
    const a = K.findPlayerByName(g, 'A').id;
    assert.throws(() => K.setFinal(g, a, 100, 'host'), /ends the game/);
    g = K.endGame(g).game;
    assert.throws(() => K.addBuyIn(g, { playerId: a, chips: 100 }), /closed/);
    g = K.setFinal(g, a, 1200, 'host').game;
    g = K.reopenGame(g).game;
    assert.equal(g.status, 'live');
    assert.equal(K.findPlayer(g, a).final, 1200, 'reopen keeps counts');
    g = K.addBuyIn(g, { playerId: a, chips: 500 }).game;
    assert.equal(K.summarize(g).totals.boughtChips, 2500);
});

test('finalize freezes settlement; editCounts clears it', () => {
    let g = gameWith([
        { name: 'A', buys: [1000], final: 1250 },
        { name: 'B', buys: [1000], final: 750 }
    ]);
    g = K.finalizeSettlement(g, { now: 99 }).game;
    assert.equal(g.status, 'settled');
    assert.equal(g.settlement.transfers.length, 1);
    assert.equal(g.settlement.transfers[0].cents, 500);
    assert.throws(() => K.removeBuyIn(g, g.buyIns[0].id), /Re-open/);
    g = K.editCounts(g).game;
    assert.equal(g.status, 'counting');
    assert.equal(g.settlement, null);
});

test('undo a buy-in and remove a player', () => {
    let g = gameWith([{ name: 'A', buys: [1000, 1000] }, { name: 'B', buys: [1000] }]);
    g = K.removeBuyIn(g, g.buyIns[1].id).game;
    assert.equal(K.summarize(g).totals.boughtChips, 2000);
    g = K.removePlayer(g, K.findPlayerByName(g, 'B').id).game;
    assert.equal(g.players.length, 1);
    assert.equal(g.buyIns.length, 1);
});

test('duplicate names rejected (case-insensitive), rename works', () => {
    let g = gameWith([{ name: 'Sam', buys: [1000] }]);
    assert.throws(() => K.addPlayer(g, { name: ' sam ' }), /already/);
    g = K.addPlayer(g, { name: 'Jo' }).game;
    assert.throws(() => K.renamePlayer(g, K.findPlayerByName(g, 'Jo').id, 'SAM'), /already/);
    g = K.renamePlayer(g, K.findPlayerByName(g, 'Jo').id, 'Joanne').game;
    assert.ok(K.findPlayerByName(g, 'joanne'));
});

test('phone requests: join, re-join, buy-in, final — idempotent', () => {
    let g = K.createGame({ code: 'ABCDE', name: 'Night', rate: RATE, now: 1 });
    let r = K.applyRequest(g, { id: 'r1', type: 'join', name: 'Mia', chips: 1000, deviceId: 'dev-mia' }, 10);
    assert.equal(r.ack.ok, true);
    g = r.game;
    const mia = r.ack.playerId;
    // Replaying the same request id must not add a second buy-in.
    r = K.applyRequest(g, { id: 'r1', type: 'join', name: 'Mia', chips: 1000, deviceId: 'dev-mia' }, 11);
    assert.equal(r.ack.duplicate, true);
    g = r.game;
    assert.equal(g.buyIns.length, 1);
    // Re-join from the same phone (e.g. after clearing the page) -> same seat.
    r = K.applyRequest(g, { id: 'r2', type: 'join', name: 'mia', chips: 1000, deviceId: 'dev-mia' }, 12);
    assert.equal(r.ack.playerId, mia);
    g = r.game;
    assert.equal(g.players.length, 1);
    assert.equal(K.summarize(g).rows[0].boughtChips, 2000);
    // Another phone can't hijack Mia's seat.
    r = K.applyRequest(g, { id: 'r3', type: 'join', name: 'Mia', chips: 1000, deviceId: 'dev-other' }, 13);
    assert.equal(r.ack.ok, false);
    assert.match(r.ack.message, /another phone/);
    g = r.game;
    assert.equal(K.summarize(g).rows[0].boughtChips, 2000);
    // Host-added player gets linked when they scan in.
    g = K.addPlayer(g, { name: 'Leo' }).game;
    r = K.applyRequest(g, { id: 'r4', type: 'join', name: 'Leo', chips: 500, deviceId: 'dev-leo' }, 14);
    assert.equal(r.ack.ok, true);
    g = r.game;
    assert.equal(K.findPlayerByName(g, 'Leo').linked, true);
    // Rebuy
    r = K.applyRequest(g, { id: 'r5', type: 'buyin', playerId: mia, chips: 1000, deviceId: 'dev-mia' }, 15);
    g = r.game;
    assert.equal(K.summarize(g).rows[0].boughtChips, 3000);
    // Final count is rejected while live, accepted while counting.
    r = K.applyRequest(g, { id: 'r6', type: 'final', playerId: mia, chips: 2500 }, 16);
    assert.equal(r.ack.ok, false);
    g = K.endGame(r.game).game;
    r = K.applyRequest(g, { id: 'r7', type: 'final', playerId: mia, chips: '2,500' }, 17);
    assert.equal(r.ack.ok, true);
    g = r.game;
    assert.equal(K.findPlayer(g, mia).final, 2500);
    assert.equal(K.findPlayer(g, mia).finalBy, 'player');
    // Join while counting is refused.
    r = K.applyRequest(g, { id: 'r8', type: 'join', name: 'Late', chips: 1000, deviceId: 'dev-late' }, 18);
    assert.equal(r.ack.ok, false);
    assert.equal(r.game.players.length, 2);
});

test('bad requests never throw and never change chips', () => {
    let g = K.createGame({ code: 'ABCDE', name: 'Night', rate: RATE });
    const before = JSON.stringify(g.buyIns);
    for (const req of [
        { id: 'x1', type: 'join', name: '', chips: 1000 },
        { id: 'x2', type: 'join', name: 'Z', chips: -5 },
        { id: 'x3', type: 'join', name: 'Z', chips: 'lots' },
        { id: 'x4', type: 'buyin', playerId: 'p999', chips: 100 },
        { id: 'x5', type: 'nope' }
    ]) {
        const r = K.applyRequest(g, req);
        assert.equal(r.ack.ok, false);
        g = r.game;
    }
    assert.equal(JSON.stringify(g.buyIns), before);
});

test('normalizeGame survives RTDB shapes (index-keyed objects, dropped fields)', () => {
    let g = gameWith([
        { name: 'A', buys: [1000], final: 1250 },
        { name: 'B', buys: [1000], final: 750 }
    ]);
    g = K.finalizeSettlement(g, {}).game;
    const snap = K.publicSnapshot(g);
    // Simulate RTDB: arrays become {"0":..,"1":..}, nulls vanish.
    const rtdb = JSON.parse(JSON.stringify(snap, (k, v) => {
        if (v === null) return undefined;
        if (Array.isArray(v)) return Object.fromEntries(v.map((x, i) => [String(i), x]));
        return v;
    }));
    const back = K.normalizeGame(rtdb);
    assert.equal(back.players.length, 2);
    assert.equal(back.buyIns.length, 2);
    assert.equal(back.status, 'settled');
    assert.equal(back.settlement.transfers.length, 1);
    assert.equal(back.settlement.transfers[0].cents, 500);
    assert.equal(back.players[0].final, 1250);
    // Empty game: players/buyIns missing entirely.
    const empty = K.normalizeGame({ code: 'X', name: 'N', rate: RATE, status: 'live' });
    assert.deepEqual(empty.players, []);
    assert.deepEqual(empty.buyIns, []);
});

test('mutations never touch the original object', () => {
    const g = gameWith([{ name: 'A', buys: [1000] }]);
    const frozen = JSON.stringify(g);
    K.addBuyIn(g, { playerId: g.players[0].id, chips: 5 });
    K.addPlayer(g, { name: 'B' });
    K.endGame(g);
    assert.equal(JSON.stringify(g), frozen);
});

test('allocateCents handles negative remainders correctly', () => {
    // exact nets: -1/3, -1/3, +2/3 cents  (den 3)
    const out = K.allocateCents([-1n, -1n, 2n], 3n);
    assert.equal(out.reduce((a, b) => a + b, 0), 0);
    out.forEach((c, i) => assert.ok(Math.abs(c - [-1, -1, 2][i] / 3) < 1));
});
