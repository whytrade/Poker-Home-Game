// Kapoker host app (index.html).
//
// This page is the single source of truth for the game. State lives in
// memory + localStorage; every change goes through KapokerCore and is then
// published to Firebase as a read-only snapshot for the phones.
(function () {
    'use strict';

    const K = window.KapokerCore;
    const UI = window.KapokerUI;
    const Sync = window.KapokerSync;
    const h = UI.h;

    const LS_GAME = 'kapoker.host.game';
    const LS_PREFS = 'kapoker.host.prefs';
    const LS_ARCHIVE = 'kapoker.host.archive';

    const S = {
        game: null,
        online: false,       // Firebase SDK available
        connected: false,    // socket up
        hosting: false,      // we hold the host lease and are processing requests
        leaseOwner: null,    // lease id currently in Firebase
        leaseLost: false,    // someone else holds the lease
        otherHostOnline: false,
        paid: {},
        pendingAcks: {},
        flushTimer: null,
        publishFailed: false,
        flash: {},           // playerId -> timestamp (row highlight)
        gameSubs: [],
        hostingSubs: [],
        view: null,
        refs: {},
        storageWarned: false
    };

    // ---------- storage ----------

    function loadJSON(key) {
        const raw = Sync.storageGet(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function saveJSON(key, value) {
        const ok = Sync.storageSet(key, JSON.stringify(value));
        if (!ok && !S.storageWarned) {
            S.storageWarned = true;
            UI.toast('This browser won\'t save the game — keep this tab open', { type: 'error', duration: 6000 });
        }
    }

    function prefs() {
        return Object.assign({ rateCents: 2000, rateChips: 1000, theme: 'banana', name: '' }, loadJSON(LS_PREFS) || {});
    }

    function savePrefs(patch) {
        saveJSON(LS_PREFS, Object.assign(prefs(), patch));
    }

    function archive(game) {
        if (!game || (!game.players.length && !game.buyIns.length)) return;
        const list = (loadJSON(LS_ARCHIVE) || []).filter(g => g && g.code !== game.code);
        list.unshift(game);
        saveJSON(LS_ARCHIVE, list.slice(0, 12));
    }

    function persist() {
        if (S.game) saveJSON(LS_GAME, S.game);
        else Sync.storageRemove(LS_GAME);
    }

    // ---------- applying changes ----------

    // Runs a KapokerCore action against the current game. Returns
    // { ok, result }. User-facing errors become toasts.
    function act(fn) {
        if (!S.game) return { ok: false };
        if (S.leaseLost) {
            UI.toast('Another device is hosting this game', { type: 'error' });
            return { ok: false };
        }
        try {
            const r = fn(S.game);
            if (r.game !== S.game) commitLocal(r.game);
            return { ok: true, result: r.result };
        } catch (err) {
            if (err && err.userFacing) UI.toast(err.message, { type: 'error' });
            else { console.error(err); UI.toast('Something went wrong', { type: 'error' }); }
            return { ok: false };
        }
    }

    function commitLocal(game) {
        S.game = game;
        persist();
        schedulePublish();
        render();
    }

    function schedulePublish(immediate) {
        if (!S.hosting || !S.game) return;
        clearTimeout(S.flushTimer);
        S.flushTimer = setTimeout(flush, immediate ? 0 : 60);
    }

    function flush() {
        if (!S.hosting || !S.game) return;
        const acks = S.pendingAcks;
        S.pendingAcks = {};
        const code = S.game.code;
        Sync.commit(code, K.publicSnapshot(S.game), acks)
            .then(() => {
                if (S.publishFailed) { S.publishFailed = false; renderTopbar(); }
            })
            .catch(err => {
                console.error('[host] publish failed', err);
                S.pendingAcks = Object.assign(acks, S.pendingAcks);
                S.publishFailed = true;
                renderTopbar();
                clearTimeout(S.flushTimer);
                S.flushTimer = setTimeout(flush, 2500);
            });
    }

    // ---------- phone requests ----------

    function onRequest(req) {
        if (!S.hosting || !S.game) return;
        const before = S.game;
        const { game, ack } = K.applyRequest(S.game, req, Date.now());
        S.pendingAcks[req.id] = JSON.parse(JSON.stringify(Object.assign({ at: Date.now() }, ack)));
        S.game = game;
        persist();
        schedulePublish();
        if (!ack.duplicate) announce(req, ack, before);
        render();
    }

    function confetti() {
        return S.game && S.game.theme === 'banana' ? ['🍌', '🪙', '✨'] : ['🪙', '♠️', '♥️', '✨'];
    }

    function burstOnRow(playerId, emojis, count) {
        requestAnimationFrame(() => UI.burstFrom(document.querySelector(`[data-key="${playerId}"] .pamt, [data-key="${playerId}"] .count-input`), emojis, count));
    }

    function announce(req, ack, before) {
        const player = ack.playerId ? K.findPlayer(S.game, ack.playerId) : null;
        const who = player ? player.name : K.cleanName(req.name) || 'A player';
        if (!ack.ok) {
            UI.toast(`${who}: ${ack.message}`, { type: 'warn' });
            return;
        }
        if (player) S.flash[player.id] = Date.now();
        const chips = K.parseChips(req.chips);
        const money = Number.isInteger(chips) ? K.formatMoney(K.centsForChips(S.game.rate, chips)) : '';
        if (req.type === 'join') {
            const existed = before.players.some(p => p.id === ack.playerId);
            UI.toast(existed ? `${who} +${money} 📱` : `${who} joined · ${money} 📱`, { type: 'success' });
            UI.play(existed ? 'playChipSound' : 'playKachingSound');
            burstOnRow(player.id, confetti(), existed ? 8 : 18);
        } else if (req.type === 'buyin') {
            UI.toast(`${who} +${money} 📱`, { type: 'success' });
            UI.play('playChipSound');
            burstOnRow(player.id, ['🪙'], 8);
        } else if (req.type === 'final') {
            UI.toast(`${who}: ${K.formatChips(chips)} 📱`, { type: 'success' });
            UI.play('playPopSound');
        }
    }

    // ---------- connecting to Firebase ----------

    function stopSubs(list) {
        while (list.length) {
            try { list.pop()(); } catch (e) { /* ignore */ }
        }
    }

    function disconnectGame() {
        stopHosting();
        stopSubs(S.gameSubs);
        S.leaseOwner = null;
        S.leaseLost = false;
        S.paid = {};
    }

    function connectGame() {
        disconnectGame();
        if (!S.online || !S.game) { render(); return; }
        const code = S.game.code;
        let first = true;
        S.gameSubs.push(Sync.watchHost(code, owner => {
            if (!S.game || S.game.code !== code) return;
            S.leaseOwner = owner;
            const mine = owner === Sync.leaseId();
            const sameDevice = owner && owner.split(':')[0] === Sync.deviceId();
            if (!owner || mine) {
                if (!owner) Sync.claimHost(code, { name: S.game.name, createdAt: S.game.createdAt }).catch(err => console.error(err));
                S.leaseLost = false;
                startHosting();
            } else if (first && sameDevice) {
                // Same laptop/phone, new tab. If the old tab is gone, quietly
                // carry on; if it's still open, ask before taking over.
                Sync.hostOnlineOnce(code).then(online => {
                    if (!S.game || S.game.code !== code || S.hosting) return;
                    if (!online) takeOver({ silent: true });
                    else { S.leaseLost = true; render(); }
                }).catch(() => { S.leaseLost = true; render(); });
            } else {
                if (S.hosting) UI.toast('Hosting moved to another device', { type: 'warn', duration: 5000 });
                stopHosting();
                S.leaseLost = true;
            }
            first = false;
            render();
        }));
        S.gameSubs.push(Sync.watchHostOnline(code, online => {
            S.otherHostOnline = online && !S.hosting;
            if (S.leaseLost) render();
        }));
        S.gameSubs.push(Sync.watchPaid(code, paid => {
            S.paid = paid;
            if (S.game && S.game.status === K.STATUS.SETTLED) render();
        }));
    }

    function startHosting() {
        if (S.hosting || !S.game) return;
        S.hosting = true;
        const code = S.game.code;
        S.hostingSubs.push(Sync.hostPresence(code));
        S.hostingSubs.push(Sync.watchRequests(code, onRequest));
        schedulePublish(true);
    }

    function stopHosting() {
        S.hosting = false;
        clearTimeout(S.flushTimer);
        stopSubs(S.hostingSubs);
    }

    // Become host of S.game.code on this tab, adopting the newest copy of the
    // game (the published snapshot, unless our local copy is newer).
    async function takeOver(opts) {
        if (!S.game) return;
        const code = S.game.code;
        try {
            const snap = await Sync.loadSnapshot(code);
            const remote = snap ? K.normalizeGame(snap) : null;
            if (remote && remote.code === code && (remote.rev || 0) > (S.game.rev || 0)) {
                remote.processed = S.game.processed || {};
                S.game = remote;
                persist();
            }
            await Sync.claimHost(code, { name: S.game.name, createdAt: S.game.createdAt });
            if (!opts || !opts.silent) UI.toast('You\'re hosting from this device now', { type: 'success' });
        } catch (err) {
            console.error(err);
            UI.toast('Couldn\'t take over — check your connection', { type: 'error' });
        }
    }

    // ---------- game lifecycle ----------

    async function createGame(form) {
        const name = K.cleanName(form.name) || 'Poker Night';
        const cents = K.parseMoneyToCents(form.money);
        const chips = K.parseChips(form.chips);
        if (!Number.isInteger(cents) || cents <= 0 || !Number.isInteger(chips) || chips <= 0) {
            UI.toast('Enter a buy-in amount and how many chips it gets', { type: 'error' });
            return false;
        }
        let code = K.generateCode();
        if (S.online && S.connected) {
            for (let i = 0; i < 4; i++) {
                try {
                    if (!(await withTimeout(Sync.codeExists(code), 4000))) break;
                } catch (e) { break; }
                code = K.generateCode();
            }
        }
        if (S.game) archive(S.game);
        const game = K.createGame({ code, name, rate: { cents, chips }, theme: form.theme || prefs().theme, now: Date.now() });
        savePrefs({ rateCents: cents, rateChips: chips, name, theme: game.theme });
        S.game = game;
        S.flash = {};
        persist();
        UI.applyTheme(game.theme);
        connectGame();
        if (S.online) {
            Sync.claimHost(code, { name: game.name, createdAt: game.createdAt }).catch(err => console.error(err));
        }
        UI.play('playKachingSound');
        render();
        return true;
    }

    function withTimeout(promise, ms) {
        return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    }

    async function resumeByCode(rawCode) {
        const code = K.normalizeCode(rawCode);
        if (code.length < 4) { UI.toast('Enter the game code', { type: 'error' }); return; }
        if (!S.online) { UI.toast('Offline — can\'t look up games', { type: 'error' }); return; }
        let snap;
        try { snap = await withTimeout(Sync.loadSnapshot(code), 6000); } catch (e) { snap = undefined; }
        if (snap === undefined) { UI.toast('Couldn\'t reach the server', { type: 'error' }); return; }
        if (!snap) { UI.toast(`No game with code ${code}`, { type: 'error' }); return; }
        const remote = K.normalizeGame(snap);
        if (S.game && S.game.code !== code) archive(S.game);
        if (S.game && S.game.code === code && (S.game.rev || 0) >= (remote.rev || 0)) {
            // our local copy is at least as new
        } else {
            S.game = remote;
        }
        persist();
        UI.applyTheme(S.game.theme);
        try { await Sync.claimHost(code, { name: S.game.name, createdAt: S.game.createdAt }); } catch (e) { console.error(e); }
        connectGame();
        UI.toast(`Hosting ${S.game.name}`, { type: 'success' });
    }

    function openArchived(code) {
        const list = loadJSON(LS_ARCHIVE) || [];
        const found = list.find(g => g && g.code === code);
        if (!found) return;
        if (S.game) archive(S.game);
        S.game = K.normalizeGame(found);
        persist();
        UI.applyTheme(S.game.theme);
        connectGame();
        if (S.online) Sync.claimHost(code, { name: S.game.name, createdAt: S.game.createdAt }).catch(() => {});
        render();
    }

    function newGame() {
        const leave = () => {
            if (S.game) {
                archive(S.game);
                if (S.hosting) Sync.closeGame(S.game.code);
            }
            disconnectGame();
            S.game = null;
            persist();
            render();
            window.scrollTo(0, 0);
        };
        if (S.game && S.game.status !== K.STATUS.SETTLED && S.game.buyIns.length) {
            UI.confirmSheet({
                title: 'Start a new game?',
                message: 'This one isn\'t settled. It\'ll be kept under Recent.',
                confirmLabel: 'New game',
                danger: true,
                onConfirm: leave
            });
        } else {
            leave();
        }
    }

    function addStandardBuyIn(player) {
        const r = act(g => K.addBuyIn(g, { playerId: player.id, chips: g.rate.chips, via: 'host', now: Date.now() }));
        if (!r.ok) return;
        S.flash[player.id] = Date.now();
        UI.play('playChipSound');
        UI.vibrate();
        burstOnRow(player.id, ['🪙'], 7);
        const buyIn = r.result;
        UI.toast(`${player.name} +${K.formatMoney(S.game.rate.cents)}`, {
            type: 'success',
            action: { label: 'Undo', run: () => undoBuyIn(buyIn.id) }
        });
        render();
    }

    function undoBuyIn(buyInId) {
        const b = S.game && S.game.buyIns.find(x => x.id === buyInId);
        if (!b) return;
        const r = act(g => K.removeBuyIn(g, buyInId, Date.now()));
        if (r.ok) {
            UI.play('playRemoveSound');
            const p = K.findPlayer(S.game, b.playerId);
            UI.toast(`Removed ${K.formatMoney(K.centsForChips(S.game.rate, b.chips))} buy-in${p ? ' from ' + p.name : ''}`);
        }
    }

    function endGame() {
        const sum = K.summarize(S.game);
        const go = () => {
            const r = act(g => K.endGame(g, Date.now()));
            if (r.ok) {
                UI.play('playSuccessSound');
                UI.toast('Counting time 🧮', { type: 'success' });
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        };
        if (sum.totals.players < 2) { UI.toast('Add at least 2 players first', { type: 'error' }); return; }
        UI.confirmSheet({
            title: 'End the game?',
            message: 'Buy-ins close and phones ask for chip counts.',
            confirmLabel: 'End it',
            onConfirm: go
        });
    }

    function settle(mode) {
        const r = act(g => K.finalizeSettlement(g, { mode, now: Date.now() }));
        if (r.ok) {
            if (S.hosting) Sync.clearPaid(S.game.code).catch(() => {});
            S.paid = {};
            UI.play('playPayoutSound');
            UI.vibrate(30);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            render();
            UI.burst(confetti().concat(['💸', '🎉']), { count: 46 });
        }
    }

    function trySettle() {
        const s = K.computeSettlement(S.game);
        if (s.ok) { settle('exact'); return; }
        if (s.code === 'chip-mismatch') { openMismatchSheet(s); return; }
        UI.toast(s.message, { type: 'error', duration: 4000 });
    }

    // ---------- sheets ----------

    function openMismatchSheet(s) {
        const spread = K.computeSettlement(S.game, { mode: 'spread' });
        const missing = s.diffChips < 0;
        const totalCounted = s.totals.finalChips;
        const pot = s.totals.boughtCents;
        UI.openSheet('Chips don\'t add up', close => h('div', { class: 'stack' },
            h('div', { class: 'callout callout-warn' },
                h('strong', { class: 'num', text: `${K.formatChips(Math.abs(s.diffChips))} chips ${missing ? 'missing' : 'extra'}` }),
                h('span', { text: ` — counted ${K.formatChips(totalCounted)}, but ${K.formatChips(s.totals.boughtChips)} were bought in.` })),
            spread.ok ? h('p', { class: 'muted small', text: `"Settle anyway" splits the ${K.formatMoney(pot)} pot by chips counted.` }) : null,
            h('div', { class: 'row-actions' },
                h('button', { class: 'btn btn-primary', type: 'button', text: 'Fix counts', onclick: close }),
                spread.ok ? h('button', { class: 'btn btn-ghost', type: 'button', text: 'Settle anyway', onclick: () => { close(); settle('spread'); } }) : null)));
    }

    // Amount field that accepts dollars or chips.
    function amountField(opts) {
        const rate = S.game.rate;
        let unit = opts.unit || 'money';
        const input = h('input', {
            class: 'input input-lg num',
            type: 'text',
            inputmode: 'decimal',
            autocomplete: 'off',
            enterkeyhint: 'done',
            'aria-label': 'Amount'
        });
        const preview = h('div', { class: 'muted small amount-preview' });
        const unitBtns = {};
        const unitRow = h('div', { class: 'seg', role: 'group', 'aria-label': 'Unit' },
            ['money', 'chips'].map(u => (unitBtns[u] = h('button', {
                type: 'button',
                class: 'seg-btn',
                text: u === 'money' ? '$' : 'Chips',
                onclick: () => { setUnit(u); input.focus(); }
            }))));
        function value() {
            if (unit === 'money') {
                const cents = K.parseMoneyToCents(input.value);
                return Number.isInteger(cents) ? K.chipsForCents(rate, cents) : NaN;
            }
            return K.parseChips(input.value);
        }
        function update() {
            const chips = value();
            if (!input.value.trim()) preview.textContent = '';
            else if (!Number.isInteger(chips) || chips <= 0) preview.textContent = 'Enter an amount';
            else {
                const cents = K.centsForChips(rate, chips);
                const typed = unit === 'money' ? K.parseMoneyToCents(input.value) : cents;
                preview.textContent = unit === 'money'
                    ? `${K.formatChips(chips)} chips` + (typed !== cents ? ` (worth ${K.formatMoney(cents)} — chips round down)` : '')
                    : `worth ${K.formatMoney(cents)}`;
            }
        }
        function setUnit(u) {
            const chips = value();
            unit = u;
            Object.keys(unitBtns).forEach(k => unitBtns[k].classList.toggle('is-on', k === u));
            input.setAttribute('inputmode', u === 'money' ? 'decimal' : 'numeric');
            if (Number.isInteger(chips) && chips > 0) {
                input.value = u === 'money' ? (K.centsForChips(rate, chips) / 100).toString() : String(chips);
            }
            update();
        }
        input.addEventListener('input', update);
        if (opts.initialChips) input.value = unit === 'money' ? (K.centsForChips(rate, opts.initialChips) / 100).toString() : String(opts.initialChips);
        setUnit(unit);
        return { el: h('div', { class: 'amount-field' }, h('div', { class: 'amount-row' }, input, unitRow), preview), input, value };
    }

    function openPlayerSheet(playerId) {
        const player = K.findPlayer(S.game, playerId);
        if (!player) return;
        const live = S.game.status === K.STATUS.LIVE;
        UI.openSheet(player.name, close => {
            const p = K.findPlayer(S.game, playerId);
            const mine = S.game.buyIns.filter(b => b.playerId === playerId);
            const field = live ? amountField({ initialChips: S.game.rate.chips }) : null;
            const quick = live ? h('div', { class: 'quick-row' }, [0.5, 1, 2, 5].map(mult => {
                const chips = Math.round(S.game.rate.chips * mult);
                return h('button', {
                    class: 'chip-btn', type: 'button',
                    text: K.formatMoney(K.centsForChips(S.game.rate, chips)),
                    onclick: () => { addCustom(chips); }
                });
            })) : null;
            function addCustom(chips) {
                const n = chips !== undefined ? chips : field.value();
                if (!Number.isInteger(n) || n <= 0) { UI.toast('Enter an amount above 0', { type: 'error' }); return; }
                const r = act(g => K.addBuyIn(g, { playerId, chips: n, via: 'host', now: Date.now() }));
                if (r.ok) {
                    S.flash[playerId] = Date.now();
                    UI.play('playChipSound');
                    const id = r.result.id;
                    UI.toast(`${p.name} +${K.formatMoney(K.centsForChips(S.game.rate, n))}`, { type: 'success', action: { label: 'Undo', run: () => undoBuyIn(id) } });
                    close();
                }
            }
            const nameInput = h('input', { class: 'input', type: 'text', maxlength: String(K.MAX_NAME), value: p.name, 'aria-label': 'Name', autocomplete: 'off' });
            return h('div', { class: 'stack' },
                live ? h('form', { class: 'stack-sm', onsubmit: e => { e.preventDefault(); addCustom(); } },
                    h('label', { class: 'label', text: 'Add a buy-in' }),
                    quick,
                    field.el,
                    h('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Add buy-in' })) : null,
                h('div', { class: 'stack-sm' },
                    h('div', { class: 'label', text: `Buy-ins (${mine.length}) · ${K.formatMoney(K.centsForChips(S.game.rate, mine.reduce((s, b) => s + b.chips, 0)))}` }),
                    mine.length ? h('ul', { class: 'mini-list' }, mine.slice().reverse().map(b => h('li', null,
                        h('span', { class: 'num', text: `${K.formatMoney(K.centsForChips(S.game.rate, b.chips))} · ${K.formatChips(b.chips)} chips` }),
                        h('span', { class: 'muted small', text: (b.via === 'phone' ? '📱 ' : '') + UI.timeAgo(b.at) }),
                        S.game.status !== K.STATUS.SETTLED ? h('button', {
                            class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': 'Remove buy-in', text: '✕',
                            onclick: () => { undoBuyIn(b.id); close(); openPlayerSheet(playerId); }
                        }) : null))) : h('p', { class: 'muted small', text: 'No buy-ins yet' })),
                h('form', { class: 'stack-sm', onsubmit: e => {
                    e.preventDefault();
                    const r = act(g => K.renamePlayer(g, playerId, nameInput.value, Date.now()));
                    if (r.ok) { UI.toast('Name updated'); close(); }
                } },
                    h('label', { class: 'label', text: 'Name' }),
                    h('div', { class: 'inline-form' }, nameInput, h('button', { class: 'btn btn-ghost', type: 'submit', text: 'Save' }))),
                S.game.status !== K.STATUS.SETTLED ? h('button', {
                    class: 'btn btn-danger-ghost btn-block', type: 'button', text: 'Remove player',
                    onclick: () => {
                        close();
                        UI.confirmSheet({
                            title: `Remove ${p.name}?`,
                            message: mine.length ? `Their ${mine.length} buy-in${mine.length > 1 ? 's' : ''} will be deleted too.` : 'They have no buy-ins.',
                            confirmLabel: 'Remove',
                            danger: true,
                            onConfirm: () => {
                                const r = act(g => K.removePlayer(g, playerId, Date.now()));
                                if (r.ok) { UI.play('playRemoveSound'); UI.toast(`Removed ${p.name}`); }
                            }
                        });
                    }
                }) : null);
        }, { noAutofocus: true });
    }

    function openSettingsSheet() {
        const g = S.game;
        UI.openSheet(g ? 'Game settings' : 'Settings', close => {
            const parts = [];
            if (g) {
                const nameInput = h('input', { class: 'input', type: 'text', value: g.name, maxlength: '40', autocomplete: 'off' });
                const moneyInput = h('input', { class: 'input num', type: 'text', inputmode: 'decimal', value: String(g.rate.cents / 100), autocomplete: 'off' });
                const chipsInput = h('input', { class: 'input num', type: 'text', inputmode: 'numeric', value: String(g.rate.chips), autocomplete: 'off' });
                parts.push(h('form', { class: 'stack-sm', onsubmit: e => {
                    e.preventDefault();
                    const cents = K.parseMoneyToCents(moneyInput.value);
                    const chips = K.parseChips(chipsInput.value);
                    let ok = true;
                    if (K.cleanName(nameInput.value) && K.cleanName(nameInput.value) !== g.name) ok = act(x => K.setName(x, nameInput.value, Date.now())).ok && ok;
                    if (cents !== g.rate.cents || chips !== g.rate.chips) ok = act(x => K.setRate(x, { cents, chips }, Date.now())).ok && ok;
                    if (ok) { UI.toast('Saved'); close(); }
                } },
                    h('label', { class: 'label', text: 'Game name' }), nameInput,
                    h('label', { class: 'label', text: 'Buy-in' }),
                    h('div', { class: 'rate-row' }, h('span', { class: 'rate-prefix', text: '$' }), moneyInput, h('span', { class: 'muted', text: 'gets' }), chipsInput, h('span', { class: 'muted', text: 'chips' })),
                    g.buyIns.length ? h('p', { class: 'muted small', text: 'Changing this changes what every chip is worth. Recorded buy-ins keep their chip amounts.' }) : null,
                    h('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Save' })));
            }
            parts.push(h('div', { class: 'stack-sm' },
                h('div', { class: 'label', text: 'Colour' }),
                themePicker(g ? g.theme : prefs().theme, id => {
                    UI.applyTheme(id);
                    savePrefs({ theme: id });
                    if (S.game) act(x => K.setTheme(x, id, Date.now()));
                })));
            parts.push(h('label', { class: 'toggle-row' },
                h('span', { text: 'Sounds' }),
                (() => {
                    const cb = h('input', { type: 'checkbox', class: 'switch' });
                    cb.checked = prefs().sound !== false;
                    cb.addEventListener('change', () => {
                        savePrefs({ sound: cb.checked });
                        if (window.SoundSystem) window.SoundSystem.enabled = cb.checked;
                    });
                    return cb;
                })()));
            if (g) {
                parts.push(h('div', { class: 'stack-sm' },
                    S.leaseLost ? null : h('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'Show join QR', onclick: () => { close(); openQrSheet(); } }),
                    h('button', { class: 'btn btn-danger-ghost btn-block', type: 'button', text: 'New game', onclick: () => { close(); newGame(); } })));
            }
            return h('div', { class: 'stack' }, parts);
        }, { noAutofocus: true });
    }

    function themePicker(current, onPick) {
        const row = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' });
        UI.THEMES.forEach(t => {
            const b = h('button', {
                type: 'button',
                class: 'swatch' + (t.id === current ? ' is-on' : ''),
                style: `--swatch:${t.swatch}`,
                role: 'radio',
                'aria-checked': t.id === current ? 'true' : 'false',
                'aria-label': t.name,
                title: t.name,
                onclick: () => {
                    row.querySelectorAll('.swatch').forEach(s => { s.classList.remove('is-on'); s.setAttribute('aria-checked', 'false'); });
                    b.classList.add('is-on');
                    b.setAttribute('aria-checked', 'true');
                    UI.play('playUIClickSound');
                    onPick(t.id);
                }
            });
            row.appendChild(b);
        });
        return row;
    }

    function joinUrl() {
        return UI.pageUrl('buy-in.html', { game: S.game.code });
    }

    function resultsUrl() {
        return UI.pageUrl('results.html', { game: S.game.code });
    }

    function openQrSheet() {
        UI.openSheet('Scan to join', () => {
            const qr = h('div', { class: 'qr qr-lg' });
            UI.renderQr(qr, joinUrl(), 280);
            return h('div', { class: 'stack center' },
                qr,
                h('div', { class: 'code-big num', text: S.game.code }),
                h('p', { class: 'muted small', text: joinUrl() }),
                h('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Share link', onclick: shareJoin }));
        }, { noAutofocus: true });
    }

    async function shareJoin() {
        const r = await UI.share({ title: `Join ${S.game.name}`, text: `Join ${S.game.name} on Kapoker — code ${S.game.code}`, url: joinUrl() });
        if (r === 'copied') UI.toast('Link copied', { type: 'success' });
        else if (r === 'failed') UI.toast(joinUrl());
    }

    async function shareResults() {
        const r = await UI.share({ title: `${S.game.name} — results`, text: `${S.game.name} payouts`, url: resultsUrl() });
        if (r === 'copied') UI.toast('Results link copied', { type: 'success' });
        else if (r === 'failed') UI.toast(resultsUrl());
    }

    // ---------- rendering ----------

    const app = () => document.getElementById('app');

    function render() {
        renderTopbar();
        const root = app();
        const view = !S.game ? 'setup' : S.leaseLost ? 'lease' : S.game.status;
        if (view !== S.view) {
            S.view = view;
            S.refs = {};
            root.innerHTML = '';
            root.dataset.view = view;
            if (view === 'setup') buildSetup(root);
            else if (view === 'lease') buildLease(root);
            else if (view === K.STATUS.LIVE) buildLive(root);
            else if (view === K.STATUS.COUNTING) buildCounting(root);
            else buildSettled(root);
        }
        if (view === K.STATUS.LIVE) updateLive();
        else if (view === K.STATUS.COUNTING) updateCounting();
        else if (view === K.STATUS.SETTLED) updateSettled();
        else if (view === 'lease') updateLease();
    }

    function renderTopbar() {
        const g = S.game;
        const nameEl = document.getElementById('topbar-name');
        const codeBtn = document.getElementById('topbar-code');
        const dot = document.getElementById('sync-dot');
        const label = document.getElementById('sync-label');
        UI.setText(nameEl, g ? g.name : '');
        codeBtn.hidden = !g || S.leaseLost;
        if (g) UI.setText(codeBtn, g.code);
        let state = 'off';
        let text = 'Offline';
        if (!g) { state = S.connected ? 'ok' : (S.online ? 'wait' : 'off'); text = S.connected ? 'Online' : (S.online ? 'Connecting…' : 'Offline'); }
        else if (!S.online) { state = 'off'; text = 'Offline — phones can\'t join'; }
        else if (S.leaseLost) { state = 'warn'; text = 'Not hosting'; }
        else if (!S.connected) { state = 'wait'; text = 'Reconnecting… (saved here)'; }
        else if (S.publishFailed) { state = 'warn'; text = 'Sync error — retrying'; }
        else if (S.hosting) { state = 'ok'; text = 'Live'; }
        else { state = 'wait'; text = 'Connecting…'; }
        dot.dataset.state = state;
        UI.setText(label, text);
        dot.title = text;
    }

    // "2¢", "1.67¢", "$0.25", "$5"
    function chipValueLabel(rate) {
        const perCents = rate.cents / rate.chips;
        if (perCents >= 100) return '$' + (perCents / 100).toFixed(perCents % 100 ? 2 : 0);
        if (perCents >= 10) return '$' + (perCents / 100).toFixed(2);
        return (Math.round(perCents * 100) / 100) + '¢';
    }

    // ----- setup -----

    function buildSetup(root) {
        const p = prefs();
        const nameInput = h('input', { class: 'input', id: 'setup-name', type: 'text', placeholder: 'Friday night poker', maxlength: '40', autocomplete: 'off', value: '' });
        const moneyInput = h('input', { class: 'input num', id: 'setup-money', type: 'text', inputmode: 'decimal', value: String(p.rateCents / 100), autocomplete: 'off', 'aria-label': 'Buy-in amount in dollars' });
        const chipsInput = h('input', { class: 'input num', id: 'setup-chips', type: 'text', inputmode: 'numeric', value: String(p.rateChips), autocomplete: 'off', 'aria-label': 'Chips per buy-in' });
        const ratePreview = h('p', { class: 'muted small' });
        let theme = p.theme;
        function updatePreview() {
            const cents = K.parseMoneyToCents(moneyInput.value);
            const chips = K.parseChips(chipsInput.value);
            if (Number.isInteger(cents) && cents > 0 && Number.isInteger(chips) && chips > 0) {
                ratePreview.textContent = 'Each chip is worth ' + chipValueLabel({ cents, chips });
            } else ratePreview.textContent = 'Enter the buy-in price and chips';
        }
        moneyInput.addEventListener('input', updatePreview);
        chipsInput.addEventListener('input', updatePreview);
        updatePreview();
        const createBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: 'Create game' });
        const form = h('form', { class: 'stack', onsubmit: async e => {
            e.preventDefault();
            createBtn.disabled = true;
            createBtn.textContent = 'Creating…';
            const ok = await createGame({ name: nameInput.value, money: moneyInput.value, chips: chipsInput.value, theme });
            if (!ok) { createBtn.disabled = false; createBtn.textContent = 'Create game'; }
        } },
            h('div', { class: 'field' }, h('label', { class: 'label', for: 'setup-name', text: 'Game name' }), nameInput),
            h('div', { class: 'field' },
                h('div', { class: 'label', text: 'Buy-in' }),
                h('div', { class: 'rate-row' }, h('span', { class: 'rate-prefix', text: '$' }), moneyInput, h('span', { class: 'muted', text: 'gets' }), chipsInput, h('span', { class: 'muted', text: 'chips' })),
                ratePreview),
            h('div', { class: 'field' }, h('div', { class: 'label', text: 'Colour' }), themePicker(theme, id => { theme = id; UI.applyTheme(id); savePrefs({ theme: id }); })),
            createBtn);

        const codeBoxes = UI.codeBoxes();
        const resume = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); resumeByCode(codeBoxes.value()); } },
            codeBoxes.el, h('button', { class: 'btn btn-ghost btn-block', type: 'submit', text: 'Host it' }));

        const archived = (loadJSON(LS_ARCHIVE) || []).filter(Boolean).slice(0, 6);
        root.append(...[
            h('section', { class: 'card hero-setup' },
                h('div', { class: 'eyebrow', text: 'Host a game' }),
                h('h1', { class: 'title title-xl', text: 'Deal me in.' }),
                form),
            h('section', { class: 'card' },
                h('div', { class: 'card-head' }, h('h2', { text: 'Got a code?' })),
                resume),
            archived.length ? h('section', { class: 'card' },
                h('div', { class: 'card-head' }, h('h2', { text: 'Recent games' })),
                h('ul', { class: 'mini-list' }, archived.map(g => {
                    const n = K.normalizeGame(g);
                    const pot = K.summarize(n).totals.boughtCents;
                    return h('li', null,
                        h('div', { class: 'grow' },
                            h('div', { text: n.name }),
                            h('div', { class: 'muted small', text: `${new Date(n.createdAt).toLocaleDateString()} · ${n.players.length} players · ${K.formatMoney(pot)} · ${n.status}` })),
                        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Open', onclick: () => openArchived(n.code) }));
                }))) : null
        ].filter(Boolean));
    }

    // ----- lease lost -----

    function buildLease(root) {
        S.refs.leaseMsg = h('p', { class: 'muted' });
        root.append(h('section', { class: 'card stack' },
            h('div', { class: 'eyebrow', text: S.game.code }),
            h('h1', { class: 'title', text: 'Hosted on another device' }),
            S.refs.leaseMsg,
            h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', text: 'Host from this device', onclick: () => takeOver() }),
            h('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'Start a different game', onclick: newGame })));
    }

    function updateLease() {
        UI.setText(S.refs.leaseMsg, S.otherHostOnline
            ? 'It\'s open on another device right now.'
            : 'The other device is offline. Nothing is lost.');
    }

    // ----- live -----

    function buildLive(root) {
        const r = S.refs;
        r.pot = h('div', { class: 'stat-value num' });
        r.potSub = h('div', { class: 'stat-sub num' });
        r.players = h('div', { class: 'stat-value num' });
        r.playersSub = h('div', { class: 'stat-sub' });
        r.rate = h('div', { class: 'stat-value num' });
        r.rateSub = h('div', { class: 'stat-sub num' });
        r.qr = h('button', { class: 'qr qr-sm', type: 'button', 'aria-label': 'Show big QR code', onclick: openQrSheet });
        r.joinCode = h('div', { class: 'code-big num' });
        r.list = h('ul', { class: 'player-list' });
        r.empty = h('div', { class: 'empty', text: 'No one yet. Scan the QR 👆' });
        r.activity = h('ul', { class: 'activity-list' });
        r.activityCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Activity' })), r.activity);
        r.endBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', text: 'End game 🏁', onclick: endGame });

        const nameInput = h('input', { class: 'input', type: 'text', placeholder: 'Name', maxlength: String(K.MAX_NAME), autocomplete: 'off', enterkeyhint: 'next', 'aria-label': 'Player name' });
        const amtInput = h('input', { class: 'input num amt-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Buy-in in dollars', enterkeyhint: 'done' });
        r.addAmt = amtInput;
        const addForm = h('form', { class: 'add-player', onsubmit: e => {
            e.preventDefault();
            const name = K.cleanName(nameInput.value);
            if (!name) { nameInput.focus(); return; }
            let chips = 0;
            if (amtInput.value.trim()) {
                const cents = K.parseMoneyToCents(amtInput.value);
                chips = Number.isInteger(cents) ? K.chipsForCents(S.game.rate, cents) : NaN;
                if (!Number.isInteger(chips) || chips < 0) { UI.toast('Enter the buy-in in dollars', { type: 'error' }); return; }
            }
            const existing = K.findPlayerByName(S.game, name);
            if (existing) {
                UI.toast(`${existing.name} is already in — tap + on their row to add a buy-in`, { type: 'warn', duration: 4000 });
                return;
            }
            const added = act(g => K.addPlayer(g, { name, via: 'host', now: Date.now() }));
            if (!added.ok) return;
            if (chips > 0) act(g => K.addBuyIn(g, { playerId: added.result.id, chips, via: 'host', now: Date.now() }));
            S.flash[added.result.id] = Date.now();
            UI.play('playKachingSound');
            burstOnRow(added.result.id, confetti(), 14);
            nameInput.value = '';
            amtInput.value = (S.game.rate.cents / 100).toString();
            nameInput.focus();
            render();
        } },
            nameInput,
            h('div', { class: 'amt-wrap' }, h('span', { class: 'amt-prefix', text: '$' }), amtInput),
            h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add' }));
        amtInput.value = (S.game.rate.cents / 100).toString();

        root.append(
            h('section', { class: 'stats' },
                h('div', { class: 'stat stat-main' }, h('div', { class: 'stat-label', text: 'In the pot' }), r.pot, r.potSub),
                h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Players' }), r.players, r.playersSub),
                h('button', { class: 'stat stat-btn', type: 'button', onclick: openSettingsSheet, 'aria-label': 'Change buy-in' }, h('div', { class: 'stat-label', text: 'Buy-in' }), r.rate, r.rateSub)),
            h('section', { class: 'card join-card' },
                r.qr,
                h('div', { class: 'join-info' },
                    h('div', { class: 'eyebrow', text: 'Scan to join' }),
                    r.joinCode,
                    h('div', { class: 'row-actions' },
                        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Share link', onclick: shareJoin }),
                        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Big QR', onclick: openQrSheet })))),
            h('section', { class: 'card' },
                h('div', { class: 'card-head' }, h('h2', { text: 'Players' })),
                r.empty,
                r.list,
                addForm),
            r.activityCard,
            h('div', { class: 'action-bar' }, r.endBtn));
        UI.renderQr(r.qr, joinUrl(), 132);
        UI.setText(r.joinCode, S.game.code);
    }

    function updateLive() {
        const r = S.refs;
        const g = S.game;
        const { rows, totals } = K.summarize(g);
        UI.rollTo(r.pot, totals.boughtCents, K.formatMoney);
        UI.setText(r.potSub, `${K.formatChips(totals.boughtChips)} chips`);
        UI.rollTo(r.players, totals.players, String);
        const phones = rows.filter(x => x.linked).length;
        UI.setText(r.playersSub, phones ? `📱 ${phones}` : '');
        UI.setText(r.rate, K.formatMoney(g.rate.cents));
        UI.setText(r.rateSub, `${K.formatChips(g.rate.chips)} chips`);
        r.empty.hidden = rows.length > 0;
        r.endBtn.disabled = rows.length < 2;
        if (document.activeElement !== r.addAmt && !r.addAmt.value) r.addAmt.value = (g.rate.cents / 100).toString();

        UI.keyedList(r.list, rows, x => x.playerId, row => {
            const el = h('li', { class: 'player-row' });
            el._avatar = h('span');
            el._name = h('span', { class: 'pname' });
            el._phone = h('span', { class: 'phone-ic', title: 'Joined on their phone', 'aria-label': 'on phone', text: '📱' });
            el._meta = h('span', { class: 'pmeta num' });
            el._amt = h('span', { class: 'pamt num' });
            el._plus = h('button', { class: 'btn-plus', type: 'button' });
            el._more = h('button', { class: 'icon-btn', type: 'button', text: '⋯' });
            el.append(el._avatar,
                h('button', { class: 'pinfo', type: 'button', onclick: () => openPlayerSheet(el.dataset.key) }, h('span', { class: 'pname-row' }, el._name, el._phone), el._meta),
                el._amt, el._plus, el._more);
            el._plus.addEventListener('click', () => {
                const p = K.findPlayer(S.game, el.dataset.key);
                if (p) addStandardBuyIn(p);
            });
            el._more.addEventListener('click', () => openPlayerSheet(el.dataset.key));
            return el;
        }, (el, row) => {
            if (el._avatarName !== row.name) {
                el._avatarName = row.name;
                const a = UI.avatar(row.name);
                el.replaceChild(a, el.firstChild);
            }
            UI.setText(el._name, row.name);
            el._phone.hidden = !row.linked;
            UI.setText(el._meta, row.buyInCount ? `${K.formatChips(row.boughtChips)} chips${row.buyInCount > 1 ? ' · ×' + row.buyInCount : ''}` : 'no buy-in');
            UI.rollTo(el._amt, row.boughtCents, K.formatMoney);
            UI.setText(el._plus, '+' + K.formatMoney(g.rate.cents));
            el._plus.setAttribute('aria-label', `Add ${K.formatMoney(g.rate.cents)} buy-in for ${row.name}`);
            el._more.setAttribute('aria-label', `More for ${row.name}`);
            flashRow(el, row.playerId);
        });

        const recent = g.buyIns.slice(-8).reverse();
        r.activityCard.hidden = recent.length === 0;
        UI.keyedList(r.activity, recent, b => b.id, b => {
            const el = h('li');
            el._text = h('span', { class: 'grow' });
            el._time = h('span', { class: 'muted small' });
            el.append(el._text, el._time, h('button', {
                class: 'btn btn-ghost btn-sm', type: 'button', text: 'Undo',
                onclick: () => undoBuyIn(el.dataset.key)
            }));
            return el;
        }, (el, b) => {
            const p = K.findPlayer(g, b.playerId);
            UI.setText(el._text, `${b.via === 'phone' ? '📱 ' : ''}${p ? p.name : '?'} +${K.formatMoney(K.centsForChips(g.rate, b.chips))}`);
            UI.setText(el._time, UI.timeAgo(b.at));
        });
    }

    function flashRow(el, playerId) {
        const t = S.flash[playerId];
        if (t && Date.now() - t < 1500 && el._flashed !== t) {
            el._flashed = t;
            el.classList.remove('flash');
            void el.offsetWidth;
            el.classList.add('flash');
        }
    }

    // ----- counting -----

    function buildCounting(root) {
        const r = S.refs;
        r.meterText = h('div', { class: 'meter-text num' });
        r.meterBar = h('span');
        r.meterStatus = h('div', { class: 'meter-status' });
        r.list = h('ul', { class: 'count-list' });
        r.settleBtn = h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', text: 'Settle up', onclick: trySettle });
        root.append(
            h('section', { class: 'card count-head' },
                h('h1', { class: 'title', text: 'Count chips 🧮' }),
                h('div', { class: 'meter' }, r.meterText, h('div', { class: 'progress' }, r.meterBar), r.meterStatus)),
            h('section', { class: 'card' }, r.list),
            h('div', { class: 'action-bar' },
                h('button', { class: 'btn btn-ghost btn-lg', type: 'button', text: 'Reopen', onclick: () => {
                    const res = act(g => K.reopenGame(g, Date.now()));
                    if (res.ok) UI.toast('Buy-ins reopened');
                } }),
                r.settleBtn));
    }

    function updateCounting() {
        const r = S.refs;
        const g = S.game;
        const { rows, totals } = K.summarize(g);
        const pct = totals.boughtChips ? Math.min(100, Math.round(100 * totals.finalChips / totals.boughtChips)) : 0;
        UI.setText(r.meterText, `${K.formatChips(totals.finalChips)} / ${K.formatChips(totals.boughtChips)}`);
        r.meterBar.style.width = pct + '%';
        let status = '';
        let state = 'wait';
        if (!totals.allCounted) {
            const n = totals.missingCounts.length;
            status = `⏳ ${totals.missingCounts.slice(0, 4).join(', ')}${n > 4 ? '…' : ''}`;
        } else if (totals.diffChips === 0) {
            status = '✓ Balanced';
            state = 'ok';
        } else {
            status = totals.diffChips < 0
                ? `⚠ ${K.formatChips(-totals.diffChips)} chips missing`
                : `⚠ ${K.formatChips(totals.diffChips)} chips extra`;
            state = 'warn';
        }
        UI.setText(r.meterStatus, status);
        r.meterStatus.dataset.state = state;
        r.meterBar.parentNode.dataset.state = state;
        r.settleBtn.disabled = !totals.allCounted || totals.players < 2;

        UI.keyedList(r.list, rows, x => x.playerId, () => {
            const el = h('li', { class: 'count-row' });
            el._avatar = h('span');
            el._name = h('span', { class: 'pname' });
            el._meta = h('span', { class: 'pmeta num' });
            el._input = h('input', {
                class: 'input count-input num',
                type: 'text',
                inputmode: 'numeric',
                pattern: '[0-9,]*',
                autocomplete: 'off',
                enterkeyhint: 'next',
                placeholder: '—'
            });
            el._badge = h('span', { class: 'src-badge' });
            el._net = h('span', { class: 'pnet num' });
            el.append(el._avatar, h('div', { class: 'pinfo' }, el._name, el._meta),
                h('div', { class: 'count-field' }, el._input, el._badge), el._net);
            el._input.addEventListener('input', () => commitCount(el));
            el._input.addEventListener('blur', () => {
                // Tidy the display (e.g. "1250" -> "1,250") once editing stops.
                const p = K.findPlayer(S.game, el.dataset.key);
                if (p && p.final !== null) el._input.value = K.formatChips(p.final);
                el._input.classList.remove('is-invalid');
            });
            el._input.addEventListener('keydown', e => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const next = el.nextElementSibling && el.nextElementSibling._input;
                if (next) next.focus(); else el._input.blur();
            });
            el._input.addEventListener('focus', () => {
                setTimeout(() => { try { el._input.select(); } catch (e) { /* ignore */ } }, 0);
            });
            return el;
        }, (el, row) => {
            if (el._avatarName !== row.name) {
                el._avatarName = row.name;
                el.replaceChild(UI.avatar(row.name), el.firstChild);
            }
            UI.setText(el._name, row.name);
            UI.setText(el._meta, `in ${K.formatChips(row.boughtChips)}`);
            el._input.setAttribute('aria-label', `Final chips for ${row.name}`);
            UI.syncInput(el._input, row.final === null ? '' : K.formatChips(row.final));
            el._badge.dataset.src = row.finalBy || 'none';
            UI.setText(el._badge, row.finalBy === 'player' ? '📱' : row.finalBy === 'host' ? '✓' : '⏳');
            el._badge.title = row.finalBy === 'player' ? 'Sent from their phone' : row.finalBy === 'host' ? 'Entered here' : 'Waiting for a count';
            el.classList.toggle('is-done', row.final !== null);
            el.classList.toggle('no-buyin', row.boughtChips === 0);
            if (row.netCents === null) { UI.setText(el._net, ''); el._net.className = 'pnet num'; }
            else {
                UI.setText(el._net, K.formatMoney(row.netCents, { signed: true }));
                el._net.className = 'pnet num ' + (row.netCents > 0 ? 'up' : row.netCents < 0 ? 'down' : 'even');
            }
            flashRow(el, row.playerId);
        });
    }

    function commitCount(el) {
        const raw = el._input.value.trim();
        const playerId = el.dataset.key;
        if (raw === '') {
            el._input.classList.remove('is-invalid');
            act(g => K.setFinal(g, playerId, null, 'host', Date.now()));
            return;
        }
        const n = K.parseChips(raw);
        if (!Number.isInteger(n)) { el._input.classList.add('is-invalid'); return; }
        el._input.classList.remove('is-invalid');
        act(g => K.setFinal(g, playerId, n, 'host', Date.now()));
    }

    // ----- settled -----

    function buildSettled(root) {
        S.refs.body = h('div');
        root.append(
            h('section', { class: 'card settled-head' },
                h('div', { class: 'eyebrow', text: 'Settled' }),
                h('h1', { class: 'title', text: S.game.name }),
                S.refs.headSub = h('p', { class: 'muted' })),
            S.refs.body,
            h('div', { class: 'action-bar' },
                h('button', { class: 'btn btn-ghost btn-lg', type: 'button', text: 'Edit counts', onclick: () => {
                    UI.confirmSheet({
                        title: 'Edit counts?',
                        message: 'Paid ticks will be cleared.',
                        confirmLabel: 'Edit counts',
                        onConfirm: () => {
                            const res = act(g => K.editCounts(g, Date.now()));
                            if (res.ok && S.hosting) Sync.clearPaid(S.game.code).catch(() => {});
                        }
                    });
                } }),
                h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', text: 'Share results', onclick: shareResults })),
            h('div', { class: 'center pad' }, h('button', { class: 'btn btn-link', type: 'button', text: 'Start a new game', onclick: newGame })));
    }

    function updateSettled() {
        const g = S.game;
        const s = g.settlement;
        const nets = s.nets || {};
        const top = g.players.filter(p => nets[p.id] !== undefined).sort((a, b) => nets[b.id] - nets[a.id])[0];
        const pot = K.summarize(g).totals.boughtCents;
        UI.setText(S.refs.headSub, `${K.formatMoney(pot)} pot · ${s.transfers.length} payment${s.transfers.length === 1 ? '' : 's'}` +
            (top && nets[top.id] > 0 ? ` · 👑 ${top.name} ${K.formatMoney(nets[top.id], { signed: true })}` : ''));
        S.refs.body.innerHTML = '';
        S.refs.body.appendChild(UI.renderSettlement({
            game: g,
            paid: S.paid,
            onTogglePaid: (key, paid) => {
                if (!S.online) { UI.toast('Offline — can\'t sync paid ticks', { type: 'error' }); return; }
                S.paid = Object.assign({}, S.paid, { [key]: paid ? { at: Date.now() } : undefined });
                if (!paid) delete S.paid[key];
                UI.play('playUIClickSound');
                render();
                Sync.setPaid(g.code, key, paid).catch(() => UI.toast('Couldn\'t save — retrying when online', { type: 'warn' }));
            }
        }));
    }

    // ---------- boot ----------

    function boot() {
        const p = prefs();
        if (window.SoundSystem) {
            window.SoundSystem.enabled = p.sound !== false;
            const unlock = () => { window.SoundSystem.init(); window.removeEventListener('pointerdown', unlock); };
            window.addEventListener('pointerdown', unlock);
        }
        S.online = !!Sync.init();
        const stored = loadJSON(LS_GAME);
        S.game = stored ? K.normalizeGame(stored) : null;
        UI.applyTheme(S.game ? S.game.theme : p.theme);

        document.getElementById('topbar-code').addEventListener('click', () => S.game && openQrSheet());
        document.getElementById('settings-btn').addEventListener('click', openSettingsSheet);
        document.getElementById('brand').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

        if (S.online) {
            Sync.onConnection(connected => {
                const was = S.connected;
                S.connected = connected;
                renderTopbar();
                if (connected && !was && S.hosting) schedulePublish(true);
            });
        }
        connectGame();
        render();

        // Keep "2m ago" labels fresh.
        setInterval(() => { if (S.view === K.STATUS.LIVE) updateLive(); }, 30000);
        // Another tab on this device changed the stored game (e.g. took over).
        window.addEventListener('storage', e => {
            if (e.key !== LS_GAME || S.hosting) return;
            const g = loadJSON(LS_GAME);
            S.game = g ? K.normalizeGame(g) : null;
            connectGame();
            render();
        });
    }

    window.KapokerHost = { state: S, render };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
