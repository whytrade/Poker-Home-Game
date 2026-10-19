// Kapoker core — pure game logic, no DOM, no Firebase.
//
// The HOST device owns the game. Its browser keeps the canonical game object
// (localStorage) and every rule below runs there. Phones never edit the game
// directly; they send requests (join / buy-in / final count) that the host
// applies with `applyRequest`, then the host publishes a read-only snapshot.
// One writer => no sync races, and every number is computed in one place.
//
// Money is integer cents. Chips are integers. The chip value is the rational
// rate.cents / rate.chips (e.g. $20 = 1000 chips), and settlement is done with
// exact integer (BigInt) arithmetic, so payments always sum to zero exactly.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.KapokerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const STATUS = { LIVE: 'live', COUNTING: 'counting', SETTLED: 'settled' };
    const MAX_CHIPS = 100000000;
    const MAX_NAME = 24;
    const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

    // ---------- small helpers ----------

    function toInt(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : NaN;
        if (typeof value !== 'string') return NaN;
        const cleaned = value.replace(/[\s,_]/g, '');
        if (!/^-?\d+$/.test(cleaned)) return NaN;
        return parseInt(cleaned, 10);
    }

    // Parses "$20", "20.5", "1,000" -> cents (integer) or NaN.
    function parseMoneyToCents(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : NaN;
        if (typeof value !== 'string') return NaN;
        const cleaned = value.replace(/[\s,$]/g, '');
        if (!/^\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === '' || cleaned === '.') return NaN;
        const [whole, frac = ''] = cleaned.split('.');
        return (parseInt(whole || '0', 10) * 100) + parseInt((frac + '00').slice(0, 2), 10);
    }

    function parseChips(value) {
        const n = toInt(value);
        if (!Number.isInteger(n) || n < 0 || n > MAX_CHIPS) return NaN;
        return n;
    }

    function cleanName(name) {
        return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    }

    function nameKey(name) {
        return cleanName(name).toLowerCase();
    }

    function isValidRate(rate) {
        return !!rate && Number.isInteger(rate.cents) && rate.cents > 0 &&
            Number.isInteger(rate.chips) && rate.chips > 0;
    }

    // Whole chips a cash amount buys (rounded down — you can't hand out part of a chip).
    function chipsForCents(rate, cents) {
        if (!isValidRate(rate) || !Number.isInteger(cents) || cents <= 0) return 0;
        return Number((BigInt(cents) * BigInt(rate.chips)) / BigInt(rate.cents));
    }

    // Cash value of a chip count, rounded to the nearest cent (display only;
    // settlement uses exact arithmetic).
    function centsForChips(rate, chips) {
        if (!isValidRate(rate) || !Number.isFinite(chips)) return 0;
        const num = BigInt(Math.trunc(chips)) * BigInt(rate.cents);
        const den = BigInt(rate.chips);
        return Number(roundDiv(num, den));
    }

    function floorDiv(a, b) {
        const q = a / b;
        return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q;
    }

    function roundDiv(a, b) {
        // round half away from zero
        const neg = (a < 0n) !== (b < 0n);
        const absA = a < 0n ? -a : a;
        const absB = b < 0n ? -b : b;
        const q = (absA * 2n + absB) / (absB * 2n);
        return neg ? -q : q;
    }

    function formatMoney(cents, opts) {
        const signed = opts && opts.signed;
        const n = Number(cents) || 0;
        const abs = Math.abs(n);
        const dollars = Math.floor(abs / 100);
        const rem = abs % 100;
        const body = '$' + dollars.toLocaleString('en-US') + (rem ? '.' + String(rem).padStart(2, '0') : '');
        if (n < 0) return '−' + body;
        if (signed && n > 0) return '+' + body;
        return body;
    }

    function formatChips(chips) {
        return (Number(chips) || 0).toLocaleString('en-US');
    }

    function formatRate(rate) {
        if (!isValidRate(rate)) return '';
        return formatMoney(rate.cents) + ' = ' + formatChips(rate.chips) + ' chips';
    }

    function generateCode(random) {
        const rnd = random || Math.random;
        let code = '';
        for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(rnd() * CODE_ALPHABET.length)];
        return code;
    }

    function normalizeCode(code) {
        return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    }

    // RTDB returns arrays as arrays OR index-keyed objects and drops empty
    // arrays / null fields. Always read through this.
    function toArray(raw) {
        if (!raw) return [];
        if (Array.isArray(raw)) return raw.filter(x => x != null);
        return Object.keys(raw)
            .sort((a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0))
            .map(k => raw[k])
            .filter(x => x != null);
    }

    // ---------- game shape ----------

    function createGame({ code, name, rate, theme, now }) {
        if (!isValidRate(rate)) throw new Error('Invalid buy-in rate');
        const t = now || Date.now();
        return {
            v: 2,
            code: normalizeCode(code),
            name: cleanName(name) || 'Poker Night',
            rate: { cents: rate.cents, chips: rate.chips },
            theme: typeof theme === 'string' ? theme : 'felt',
            status: STATUS.LIVE,
            createdAt: t,
            updatedAt: t,
            rev: 1,
            nextId: 1,
            players: [],
            buyIns: [],
            settlement: null,
            processed: {}
        };
    }

    // Makes any stored/published game object safe to use (fills dropped fields).
    function normalizeGame(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const players = toArray(raw.players).map(p => ({
            id: String(p.id),
            name: cleanName(p.name) || 'Player',
            joinedAt: Number(p.joinedAt) || 0,
            via: p.via === 'phone' ? 'phone' : 'host',
            deviceId: p.deviceId || null,
            linked: !!(p.deviceId || p.linked),
            final: Number.isInteger(p.final) && p.final >= 0 ? p.final : null,
            finalBy: p.finalBy === 'player' || p.finalBy === 'host' ? p.finalBy : null,
            finalAt: Number(p.finalAt) || null
        }));
        const ids = new Set(players.map(p => p.id));
        const buyIns = toArray(raw.buyIns)
            .map(b => ({
                id: String(b.id),
                playerId: String(b.playerId),
                chips: parseChips(b.chips),
                at: Number(b.at) || 0,
                via: b.via === 'phone' ? 'phone' : 'host'
            }))
            .filter(b => ids.has(b.playerId) && Number.isInteger(b.chips) && b.chips > 0);
        const status = Object.values(STATUS).includes(raw.status) ? raw.status : STATUS.LIVE;
        const rate = isValidRate(raw.rate) ? { cents: raw.rate.cents, chips: raw.rate.chips } : { cents: 2000, chips: 1000 };
        return {
            v: 2,
            code: normalizeCode(raw.code),
            name: cleanName(raw.name) || 'Poker Night',
            rate,
            theme: typeof raw.theme === 'string' ? raw.theme : 'felt',
            status,
            createdAt: Number(raw.createdAt) || 0,
            updatedAt: Number(raw.updatedAt) || 0,
            rev: Number(raw.rev) || 0,
            nextId: Math.max(Number(raw.nextId) || 1, maxNumericId(players, buyIns) + 1),
            players,
            buyIns,
            settlement: status === STATUS.SETTLED ? normalizeSettlement(raw.settlement) : null,
            processed: raw.processed && typeof raw.processed === 'object' ? Object.assign({}, raw.processed) : {}
        };
    }

    function normalizeSettlement(raw) {
        if (!raw) return null;
        return {
            at: Number(raw.at) || 0,
            mode: raw.mode === 'spread' ? 'spread' : 'exact',
            transfers: toArray(raw.transfers).map(t => ({
                key: String(t.key || (t.from + '_' + t.to)),
                from: String(t.from),
                to: String(t.to),
                cents: Number(t.cents) || 0
            })),
            nets: Object.assign({}, raw.nets || {})
        };
    }

    function maxNumericId(players, buyIns) {
        let max = 0;
        players.concat(buyIns).forEach(x => {
            const n = parseInt(String(x.id).replace(/^\D+/, ''), 10);
            if (Number.isInteger(n) && n > max) max = n;
        });
        return max;
    }

    // Every mutation goes through here: copy, apply, bump revision.
    function mutate(game, fn, now) {
        const next = JSON.parse(JSON.stringify(game));
        const result = fn(next);
        next.updatedAt = Math.max(now || Date.now(), (game.updatedAt || 0) + 1);
        next.rev = (game.rev || 0) + 1;
        return { game: next, result };
    }

    function newId(game, prefix) {
        const id = prefix + game.nextId;
        game.nextId += 1;
        return id;
    }

    function findPlayer(game, playerId) {
        return game.players.find(p => p.id === String(playerId)) || null;
    }

    function findPlayerByName(game, name) {
        const key = nameKey(name);
        return key ? game.players.find(p => nameKey(p.name) === key) || null : null;
    }

    function fail(message) {
        const err = new Error(message);
        err.userFacing = true;
        throw err;
    }

    // ---------- host actions (all pure: return { game, result }) ----------

    function addPlayer(game, { name, via, deviceId, now }) {
        const clean = cleanName(name);
        if (!clean) fail('Enter a name');
        if (findPlayerByName(game, clean)) fail(`${clean} is already in the game`);
        return mutate(game, g => {
            const player = {
                id: newId(g, 'p'),
                name: clean,
                joinedAt: now || Date.now(),
                via: via === 'phone' ? 'phone' : 'host',
                deviceId: deviceId || null,
                linked: !!deviceId,
                final: null,
                finalBy: null,
                finalAt: null
            };
            g.players.push(player);
            return player;
        }, now);
    }

    function addBuyIn(game, { playerId, chips, via, now }) {
        if (game.status !== STATUS.LIVE) fail('Buy-ins are closed — the game has ended');
        const player = findPlayer(game, playerId);
        if (!player) fail('Player not found');
        const n = parseChips(chips);
        if (!Number.isInteger(n) || n <= 0) fail('Enter a chip amount above 0');
        return mutate(game, g => {
            const buyIn = { id: newId(g, 'b'), playerId: player.id, chips: n, at: now || Date.now(), via: via === 'phone' ? 'phone' : 'host' };
            g.buyIns.push(buyIn);
            return buyIn;
        }, now);
    }

    function removeBuyIn(game, buyInId, now) {
        if (game.status === STATUS.SETTLED) fail('Re-open the game to change buy-ins');
        if (!game.buyIns.some(b => b.id === buyInId)) fail('Buy-in not found');
        return mutate(game, g => {
            g.buyIns = g.buyIns.filter(b => b.id !== buyInId);
            return true;
        }, now);
    }

    function removePlayer(game, playerId, now) {
        if (game.status === STATUS.SETTLED) fail('Re-open the game to remove players');
        if (!findPlayer(game, playerId)) fail('Player not found');
        return mutate(game, g => {
            g.players = g.players.filter(p => p.id !== String(playerId));
            g.buyIns = g.buyIns.filter(b => b.playerId !== String(playerId));
            return true;
        }, now);
    }

    function renamePlayer(game, playerId, name, now) {
        const clean = cleanName(name);
        if (!clean) fail('Enter a name');
        const other = findPlayerByName(game, clean);
        if (other && other.id !== String(playerId)) fail(`${clean} is already in the game`);
        if (!findPlayer(game, playerId)) fail('Player not found');
        return mutate(game, g => {
            findPlayer(g, playerId).name = clean;
            return true;
        }, now);
    }

    // chips === null clears the count.
    function setFinal(game, playerId, chips, by, now) {
        if (game.status === STATUS.SETTLED) fail('Already settled — ask the host to edit counts');
        if (game.status !== STATUS.COUNTING) fail('Final counts open when the host ends the game');
        if (!findPlayer(game, playerId)) fail('Player not found');
        let n = null;
        if (chips !== null && chips !== '' && chips !== undefined) {
            n = parseChips(chips);
            if (!Number.isInteger(n)) fail('Enter a whole number of chips');
        }
        const current = findPlayer(game, playerId);
        const source = n === null ? null : (by === 'player' ? 'player' : 'host');
        if (current.final === n && current.finalBy === source) return { game, result: false };
        return mutate(game, g => {
            const p = findPlayer(g, playerId);
            p.final = n;
            p.finalBy = source;
            p.finalAt = n === null ? null : (now || Date.now());
            return true;
        }, now);
    }

    function setRate(game, rate, now) {
        if (!isValidRate(rate)) fail('Enter a buy-in amount and chip count above 0');
        if (game.status === STATUS.SETTLED) fail('Re-open the game to change the rate');
        return mutate(game, g => { g.rate = { cents: rate.cents, chips: rate.chips }; return true; }, now);
    }

    function setName(game, name, now) {
        return mutate(game, g => { g.name = cleanName(name) || g.name; return true; }, now);
    }

    function setTheme(game, theme, now) {
        return mutate(game, g => { g.theme = String(theme || 'felt'); return true; }, now);
    }

    function endGame(game, now) {
        if (game.status !== STATUS.LIVE) return { game, result: false };
        if (!game.players.length) fail('Add players first');
        return mutate(game, g => { g.status = STATUS.COUNTING; g.settlement = null; return true; }, now);
    }

    // Back to taking buy-ins. Keeps any counts already entered.
    function reopenGame(game, now) {
        if (game.status === STATUS.LIVE) return { game, result: false };
        return mutate(game, g => { g.status = STATUS.LIVE; g.settlement = null; return true; }, now);
    }

    // Settled -> counting, to fix a count. Clears the frozen payments.
    function editCounts(game, now) {
        if (game.status !== STATUS.SETTLED) return { game, result: false };
        return mutate(game, g => { g.status = STATUS.COUNTING; g.settlement = null; return true; }, now);
    }

    function finalizeSettlement(game, { mode, now }) {
        if (game.status !== STATUS.COUNTING) fail('End the game before settling');
        const s = computeSettlement(game, { mode });
        if (!s.ok) fail(s.message);
        return mutate(game, g => {
            g.status = STATUS.SETTLED;
            g.settlement = {
                at: now || Date.now(),
                mode: s.mode,
                transfers: s.transfers,
                nets: s.rows.reduce((acc, r) => { acc[r.playerId] = r.netCents; return acc; }, {})
            };
            return g.settlement;
        }, now);
    }

    // ---------- requests from phones ----------
    //
    // req = { id, type: 'join'|'buyin'|'final', name?, playerId?, chips, deviceId }
    // Returns { game, ack } where ack = { ok, playerId?, message }.
    // Idempotent: a request id is applied at most once.
    function applyRequest(game, req, now) {
        if (!req || !req.id) return { game, ack: { ok: false, message: 'Bad request' } };
        if (game.processed && game.processed[req.id]) {
            return { game, ack: Object.assign({ duplicate: true }, game.processed[req.id]) };
        }
        let next = game;
        let ack;
        try {
            if (req.type === 'join') {
                const r = applyJoin(next, req, now);
                next = r.game; ack = r.ack;
            } else if (req.type === 'buyin') {
                const player = findPlayer(next, req.playerId);
                if (!player) fail('The host removed you from this game — join again');
                next = addBuyIn(next, { playerId: player.id, chips: req.chips, via: 'phone', now }).game;
                const chips = parseChips(req.chips);
                ack = { ok: true, playerId: player.id, message: `${formatMoney(centsForChips(next.rate, chips))} rebuy added (${formatChips(chips)} chips)` };
            } else if (req.type === 'final') {
                const player = findPlayer(next, req.playerId);
                if (!player) fail('Player not found');
                next = setFinal(next, player.id, req.chips, 'player', now).game;
                ack = { ok: true, playerId: player.id, message: 'Count received' };
            } else {
                fail('Unknown request');
            }
        } catch (err) {
            ack = { ok: false, message: err.userFacing ? err.message : 'Something went wrong' };
            next = game;
        }
        // Record the outcome (even failures) so retries/replays don't double-apply.
        const record = { ok: ack.ok, message: ack.message };
        if (ack.playerId) record.playerId = ack.playerId;
        const out = mutate(next, g => {
            g.processed = trimProcessed(Object.assign({}, g.processed, { [req.id]: Object.assign({ at: now || Date.now() }, record) }));
        }, now).game;
        return { game: out, ack };
    }

    function applyJoin(game, req, now) {
        if (game.status !== STATUS.LIVE) fail('This game has ended — ask the host to re-open it');
        const name = cleanName(req.name);
        if (!name) fail('Enter your name');
        const chips = parseChips(req.chips);
        if (!Number.isInteger(chips) || chips <= 0) fail('Choose a buy-in amount');

        // Same name => same seat (re-join after a refresh, or the host already
        // added them by hand). But never merge into a seat another phone owns:
        // two different "Sam"s must not share one stack.
        let player = findPlayerByName(game, name);
        if (player && player.deviceId && req.deviceId && player.deviceId !== req.deviceId) {
            fail(`"${player.name}" is already playing on another phone — add a last initial (e.g. ${player.name} B) or ask the host`);
        }
        let next = game;
        const rejoined = !!player;
        if (!player) {
            const r = addPlayer(next, { name, via: 'phone', deviceId: req.deviceId, now });
            next = r.game; player = r.result;
        } else if (req.deviceId && player.deviceId !== req.deviceId) {
            next = mutate(next, g => { const p = findPlayer(g, player.id); p.deviceId = req.deviceId; p.linked = true; }, now).game;
        }
        next = addBuyIn(next, { playerId: player.id, chips, via: 'phone', now }).game;
        return {
            game: next,
            ack: { ok: true, playerId: player.id, rejoined, message: rejoined ? `Welcome back, ${player.name}` : `Welcome, ${player.name}` }
        };
    }

    function trimProcessed(processed) {
        const keys = Object.keys(processed);
        if (keys.length <= 300) return processed;
        keys.sort((a, b) => (processed[a].at || 0) - (processed[b].at || 0));
        const out = {};
        keys.slice(-300).forEach(k => { out[k] = processed[k]; });
        return out;
    }

    // ---------- derived numbers ----------

    function summarize(game) {
        const rate = game.rate;
        const rows = game.players.map(p => {
            const mine = game.buyIns.filter(b => b.playerId === p.id);
            const boughtChips = mine.reduce((s, b) => s + b.chips, 0);
            const row = {
                playerId: p.id,
                name: p.name,
                via: p.via,
                linked: !!(p.deviceId || p.linked),
                buyInCount: mine.length,
                boughtChips,
                boughtCents: centsForChips(rate, boughtChips),
                final: p.final,
                finalBy: p.finalBy,
                netChips: p.final === null ? null : p.final - boughtChips
            };
            row.netCents = row.netChips === null ? null : centsForChips(rate, row.netChips);
            return row;
        });
        const boughtChips = rows.reduce((s, r) => s + r.boughtChips, 0);
        const counted = rows.filter(r => r.final !== null);
        const finalChips = counted.reduce((s, r) => s + r.final, 0);
        // Players who never bought in and have no count don't block anything.
        const needCount = rows.filter(r => r.final === null && r.boughtChips > 0);
        return {
            rows,
            totals: {
                players: rows.length,
                boughtChips,
                boughtCents: centsForChips(rate, boughtChips),
                buyIns: game.buyIns.length,
                countedPlayers: counted.length,
                finalChips,
                missingCounts: needCount.map(r => r.name),
                diffChips: finalChips - boughtChips, // >0 extra chips counted, <0 chips missing
                allCounted: needCount.length === 0
            }
        };
    }

    // Splits exact rational nets (num_i / den, summing to 0) into integer cents
    // that also sum to exactly 0, each within one cent of its exact value.
    function allocateCents(numerators, den) {
        const floors = numerators.map(n => floorDiv(n, den));
        const remainders = numerators.map((n, i) => n - floors[i] * den);
        let shortfall = -floors.reduce((s, f) => s + f, 0n); // cents still to hand out
        const order = remainders
            .map((r, i) => ({ r, i }))
            .sort((a, b) => (a.r === b.r ? a.i - b.i : (b.r > a.r ? 1 : -1)));
        const cents = floors.slice();
        for (let k = 0; shortfall > 0n && k < order.length; k++, shortfall--) cents[order[k].i] += 1n;
        return cents.map(Number);
    }

    // mode: 'exact' (default) requires counted chips == bought chips.
    //       'spread' accepts a mismatch and values every counted chip at
    //       (total cash in / total chips counted), so the books still balance.
    function computeSettlement(game, opts) {
        const mode = opts && opts.mode === 'spread' ? 'spread' : 'exact';
        const { rows: allRows, totals } = summarize(game);
        const rows = allRows.filter(r => r.boughtChips > 0 || (r.final !== null && r.final > 0));
        const base = { ok: false, mode, totals, rows: [], transfers: [] };

        if (rows.length < 2) return Object.assign(base, { code: 'few-players', message: 'Need at least 2 players with buy-ins' });
        const missing = rows.filter(r => r.final === null);
        if (missing.length) {
            return Object.assign(base, { code: 'missing-counts', missing: missing.map(r => r.name), message: 'Waiting on counts: ' + missing.map(r => r.name).join(', ') });
        }
        const totalFinal = rows.reduce((s, r) => s + r.final, 0);
        const totalBought = rows.reduce((s, r) => s + r.boughtChips, 0);
        const diff = totalFinal - totalBought;
        if (diff !== 0 && mode === 'exact') {
            return Object.assign(base, {
                code: 'chip-mismatch',
                diffChips: diff,
                message: diff < 0
                    ? `${formatChips(-diff)} chips missing — counts add up to ${formatChips(totalFinal)} but ${formatChips(totalBought)} were bought`
                    : `${formatChips(diff)} extra chips — counts add up to ${formatChips(totalFinal)} but only ${formatChips(totalBought)} were bought`
            });
        }
        if (mode === 'spread' && totalFinal === 0) {
            return Object.assign(base, { code: 'no-chips', message: 'Every count is 0 — check the counts' });
        }

        const rc = BigInt(game.rate.cents);
        const rch = BigInt(game.rate.chips);
        let nums, den;
        if (diff === 0) {
            // net_i = (final_i - bought_i) * cents / chips
            den = rch;
            nums = rows.map(r => BigInt(r.final - r.boughtChips) * rc);
        } else {
            // cashout_i = final_i / totalFinal * (totalBought * cents / chips)
            // net_i = cashout_i - bought_i * cents / chips
            const tf = BigInt(totalFinal);
            const tb = BigInt(totalBought);
            den = rch * tf;
            nums = rows.map(r => (BigInt(r.final) * tb - BigInt(r.boughtChips) * tf) * rc);
        }
        const nets = allocateCents(nums, den);
        const settledRows = rows.map((r, i) => Object.assign({}, r, { netCents: nets[i] }));
        return {
            ok: true,
            mode: diff === 0 ? 'exact' : 'spread',
            totals: Object.assign({}, totals, { diffChips: diff }),
            rows: settledRows.slice().sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name)),
            transfers: minimizeTransfers(settledRows)
        };
    }

    // Greedy largest-debtor -> largest-creditor matching: at most n-1 payments.
    function minimizeTransfers(rows) {
        const creditors = rows.filter(r => r.netCents > 0).map(r => ({ id: r.playerId, name: r.name, amt: r.netCents }));
        const debtors = rows.filter(r => r.netCents < 0).map(r => ({ id: r.playerId, name: r.name, amt: -r.netCents }));
        const byAmt = (a, b) => b.amt - a.amt || a.name.localeCompare(b.name);
        const transfers = [];
        creditors.sort(byAmt);
        debtors.sort(byAmt);
        while (creditors.length && debtors.length) {
            const c = creditors[0];
            const d = debtors[0];
            const cents = Math.min(c.amt, d.amt);
            transfers.push({ key: d.id + '_' + c.id, from: d.id, to: c.id, cents });
            c.amt -= cents;
            d.amt -= cents;
            if (c.amt === 0) creditors.shift();
            if (d.amt === 0) debtors.shift();
            creditors.sort(byAmt);
            debtors.sort(byAmt);
        }
        return transfers;
    }

    // Snapshot the host publishes for phones. Keeps deviceId so a phone that
    // lost its ack can still find its own seat; drops host-only bookkeeping.
    function publicSnapshot(game) {
        const snap = JSON.parse(JSON.stringify(game));
        delete snap.processed;
        return snap;
    }

    return {
        STATUS,
        MAX_NAME,
        toInt,
        parseMoneyToCents,
        parseChips,
        cleanName,
        nameKey,
        isValidRate,
        chipsForCents,
        centsForChips,
        formatMoney,
        formatChips,
        formatRate,
        generateCode,
        normalizeCode,
        toArray,
        createGame,
        normalizeGame,
        findPlayer,
        findPlayerByName,
        addPlayer,
        addBuyIn,
        removeBuyIn,
        removePlayer,
        renamePlayer,
        setFinal,
        setRate,
        setName,
        setTheme,
        endGame,
        reopenGame,
        editCounts,
        finalizeSettlement,
        applyRequest,
        summarize,
        computeSettlement,
        allocateCents,
        minimizeTransfers,
        publicSnapshot
    };
});
