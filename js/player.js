// Kapoker player page (buy-in.html) — what everyone sees on their phone.
//
// Read-only view of the host's snapshot plus three requests: join, rebuy and
// "here's my final count". The host device applies them; we just wait for
// its ack. Nothing on this page can change the numbers directly.
(function () {
    'use strict';

    const K = window.KapokerCore;
    const UI = window.KapokerUI;
    const Sync = window.KapokerSync;
    const h = UI.h;

    const params = new URLSearchParams(window.location.search);
    const P = {
        code: K.normalizeCode(params.get('game') || params.get('code') || ''),
        legacyId: params.get('gameId'),
        game: null,
        snapshotLoaded: false,
        hostOnline: false,
        connected: false,
        me: null,
        pending: null,
        paid: {},
        view: null,
        refs: {},
        removedNotice: false,
        subs: []
    };

    const meKey = () => 'kapoker.player.' + P.code;
    const pendingKey = () => 'kapoker.pending.' + P.code;

    function loadJSON(key) {
        const raw = Sync.storageGet(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function saveMe(me) {
        if (!me || !P.me || me.playerId !== P.me.playerId) P.seenSelf = false;
        P.me = me;
        if (me) Sync.storageSet(meKey(), JSON.stringify(me));
        else Sync.storageRemove(meKey());
    }

    function savePending(pending) {
        P.pending = pending;
        if (pending) Sync.storageSet(pendingKey(), JSON.stringify({ id: pending.id, type: pending.type, chips: pending.chips, name: pending.name, sentAt: pending.sentAt }));
        else Sync.storageRemove(pendingKey());
    }

    function myRow() {
        if (!P.me || !P.game) return null;
        return K.summarize(P.game).rows.find(r => r.playerId === P.me.playerId) || null;
    }

    // ---------- requests ----------

    function send(type, body) {
        if (!Sync.online()) { UI.toast('No connection to the game', { type: 'error' }); return; }
        if (P.pending) { UI.toast('Hang on — still waiting for the host', { type: 'warn' }); return; }
        let req;
        try { req = Sync.sendRequest(P.code, Object.assign({ type }, body)); } catch (e) { UI.toast('No connection to the game', { type: 'error' }); return; }
        const pending = { id: req.id, type, chips: body.chips, name: body.name, sentAt: Date.now() };
        savePending(pending);
        watchPending();
        req.done.catch(err => {
            console.error(err);
            if (P.pending && P.pending.id === pending.id) {
                clearPending();
                UI.toast('Couldn\'t send — check your connection and try again', { type: 'error' });
            }
        });
        UI.vibrate();
        render();
    }

    function watchPending() {
        if (!P.pending) return;
        const id = P.pending.id;
        if (P.pending.unsub) P.pending.unsub();
        P.pending.unsub = Sync.watchAck(P.code, id, ack => onAck(id, ack));
        clearTimeout(P.pending.timer);
        P.pending.timer = setTimeout(render, 7000);
    }

    function clearPending() {
        if (P.pending) {
            if (P.pending.unsub) P.pending.unsub();
            clearTimeout(P.pending.timer);
        }
        savePending(null);
    }

    function onAck(id, ack) {
        if (!P.pending || P.pending.id !== id) return;
        const type = P.pending.type;
        const name = P.pending.name;
        clearPending();
        Sync.removeAck(P.code, id).catch(() => {});
        if (!ack.ok) {
            UI.toast(ack.message || 'The host couldn\'t apply that', { type: 'error', duration: 5000 });
            UI.vibrate(60);
            render();
            return;
        }
        if (type === 'join') {
            saveMe({ playerId: ack.playerId, name });
            Sync.storageSet('kapoker.player.name', name || '');
            UI.toast('You\'re in 🎉', { type: 'success' });
            UI.play('playKachingSound');
            setTimeout(() => UI.burst(confetti(), { count: 34 }), 60);
        } else if (type === 'buyin') {
            UI.toast(ack.message || 'Rebuy added', { type: 'success' });
            UI.play('playChipSound');
            setTimeout(() => UI.burstFrom(document.querySelector('.hero-amount'), ['🪙'], 12), 60);
        } else if (type === 'final') {
            UI.toast('Sent ✓', { type: 'success' });
            UI.play('playSuccessSound');
        }
        UI.vibrate(25);
        render();
    }

    function confetti() {
        return P.game && P.game.theme === 'banana' ? ['🍌', '🪙', '✨'] : ['🪙', '♠️', '♥️', '✨'];
    }

    function cancelPending() {
        if (!P.pending) return;
        const id = P.pending.id;
        clearPending();
        Sync.cancelRequest(P.code, id).catch(() => {});
        render();
    }

    // ---------- snapshot ----------

    function onSnapshot(raw) {
        P.snapshotLoaded = true;
        const before = P.game;
        P.game = raw ? K.normalizeGame(raw) : null;
        if (P.game) {
            UI.applyTheme(P.game.theme);
            document.title = P.game.name + ' — Kapoker';
            // Lost our saved identity (new browser tab, cleared storage)? The
            // host stores our device id on our seat — find it.
            if (!P.me) {
                const mine = P.game.players.filter(p => p.deviceId === Sync.deviceId());
                if (mine.length === 1) saveMe({ playerId: mine[0].id, name: mine[0].name });
            } else if (!K.findPlayer(P.game, P.me.playerId)) {
                // Only treat it as "removed" once we've actually seen our seat;
                // right after a join ack the snapshot may still be catching up.
                if (P.seenSelf) {
                    saveMe(null);
                    P.removedNotice = true;
                }
            } else {
                P.seenSelf = true;
                P.removedNotice = false;
                const p = K.findPlayer(P.game, P.me.playerId);
                if (p.name !== P.me.name) saveMe({ playerId: p.id, name: p.name });
            }
            if (before && before.status !== P.game.status) {
                if (P.game.status === K.STATUS.COUNTING) { UI.vibrate([40, 60, 40]); UI.play('playSuccessSound'); }
                if (P.game.status === K.STATUS.SETTLED) {
                    UI.vibrate([30, 40, 30]);
                    UI.play('playPayoutSound');
                    const net = P.me && P.game.settlement ? P.game.settlement.nets[P.me.playerId] : undefined;
                    setTimeout(() => UI.burst(net < 0 ? ['🫠', '💸'] : confetti().concat(['💸', '🎉']), { count: net < 0 ? 16 : 40 }), 120);
                }
            }
        }
        render();
    }

    function subscribe() {
        while (P.subs.length) P.subs.pop()();
        if (!Sync.online() || !P.code) return;
        P.subs.push(Sync.onConnection(c => { P.connected = c; renderStatus(); }));
        P.subs.push(Sync.watchSnapshot(P.code, onSnapshot));
        P.subs.push(Sync.watchHostOnline(P.code, online => { P.hostOnline = online; renderStatus(); if (P.pending) render(); }));
        P.subs.push(Sync.watchPaid(P.code, paid => {
            P.paid = paid;
            if (P.game && P.game.status === K.STATUS.SETTLED) render();
        }));
    }

    // ---------- rendering ----------

    const app = () => document.getElementById('app');

    function viewKey() {
        if (!P.code) return 'code';
        if (!Sync.online()) return 'offline';
        if (!P.snapshotLoaded) return 'loading';
        if (!P.game) return 'missing';
        const joined = !!(P.me && K.findPlayer(P.game, P.me.playerId));
        if (P.game.status === K.STATUS.SETTLED) return 'settled';
        if (P.game.status === K.STATUS.COUNTING) return joined ? 'count' : 'counting-guest';
        return joined ? 'me' : 'join';
    }

    function render() {
        renderStatus();
        const key = viewKey();
        const root = app();
        if (key !== P.view) {
            P.view = key;
            P.refs = {};
            root.innerHTML = '';
            root.dataset.view = key;
            ({
                code: buildCode,
                offline: buildOffline,
                loading: buildLoading,
                missing: buildMissing,
                join: buildJoin,
                me: buildMe,
                count: buildCount,
                'counting-guest': buildCountingGuest,
                settled: buildSettled
            })[key](root);
        }
        const updater = { join: updateJoin, me: updateMe, count: updateCount, 'counting-guest': updateTable, settled: updateSettled }[key];
        if (updater) updater();
        renderPending();
    }

    function renderStatus() {
        const nameEl = document.getElementById('topbar-name');
        const dot = document.getElementById('sync-dot');
        const label = document.getElementById('sync-label');
        UI.setText(nameEl, P.game ? P.game.name : (P.code ? P.code : ''));
        let state = 'wait';
        let text = 'Connecting…';
        if (!Sync.online()) { state = 'off'; text = 'Offline'; }
        else if (!P.connected) { state = 'wait'; text = 'Reconnecting…'; }
        else if (P.game && !P.hostOnline && P.game.status !== K.STATUS.SETTLED) { state = 'warn'; text = 'Host offline'; }
        else if (P.game) { state = 'ok'; text = 'Live'; }
        dot.dataset.state = state;
        UI.setText(label, text);
    }

    // Pending banner sits on top of whatever view is showing.
    function renderPending() {
        let bar = document.getElementById('pending-bar');
        if (!P.pending) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = h('div', { id: 'pending-bar', class: 'pending-bar', role: 'status' });
            document.body.appendChild(bar);
        }
        const slow = Date.now() - P.pending.sentAt > 6500;

        bar.innerHTML = '';
        bar.append(
            h('span', { class: 'spinner', 'aria-hidden': 'true' }),
            h('div', { class: 'grow' },
                h('div', { class: 'pending-title', text: 'Waiting for host…' }),
                !P.hostOnline || slow ? h('div', { class: 'muted small', text: 'Host screen is off — hang tight' }) : null),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Cancel', onclick: cancelPending }));
    }

    // ----- simple states -----

    function buildCode(root) {
        const input = h('input', { class: 'input input-lg num code-input', type: 'text', placeholder: 'CODE', maxlength: '8', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Game code', autofocus: true });
        root.append(h('section', { class: 'card stack' },
            h('h1', { class: 'title', text: 'Game code' }),
            h('form', { class: 'stack', onsubmit: e => {
                e.preventDefault();
                const code = K.normalizeCode(input.value);
                if (code.length >= 4) window.location.search = '?game=' + code;
            } }, input, h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: 'Join' }))));
        if (P.legacyId) {
            root.append(h('p', { class: 'muted small center pad', text: 'That link is from the old version of Kapoker. Ask the host for the new code.' }));
        }
    }

    function buildOffline(root) {
        root.append(h('section', { class: 'card stack center' },
            h('h1', { class: 'title', text: 'Can\'t connect' }),
            h('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Reload', onclick: () => window.location.reload() })));
    }

    function buildLoading(root) {
        const note = h('p', { class: 'muted small' });
        root.append(h('section', { class: 'card stack center' },
            h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }),
            h('p', { class: 'muted', text: `Finding game ${P.code}…` }),
            note));
        setTimeout(() => { if (P.view === 'loading') note.textContent = 'Taking a while — check your connection.'; }, 8000);
    }

    function buildMissing(root) {
        root.append(h('section', { class: 'card stack center' },
            h('div', { class: 'eyebrow num', text: P.code }),
            h('h1', { class: 'title', text: 'Game not found' }),
            h('a', { class: 'btn btn-ghost btn-block', href: 'buy-in.html', text: 'Try another code' })));
    }

    // ----- join -----

    // Buy-in picker: quick multiples of the standard buy-in + custom $.
    function amountPicker(opts) {
        const state = { mult: 1, custom: '' };
        const quick = h('div', { class: 'quick-row' });
        const customInput = h('input', { class: 'input input-lg num', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Other amount', 'aria-label': 'Other amount in dollars' });
        const preview = h('div', { class: 'muted small amount-preview' });
        function chips() {
            const rate = P.game.rate;
            if (state.mult) return Math.round(rate.chips * state.mult);
            const cents = K.parseMoneyToCents(customInput.value);
            return Number.isInteger(cents) ? K.chipsForCents(rate, cents) : NaN;
        }
        function paint() {
            const rate = P.game.rate;
            quick.innerHTML = '';
            [1, 2, 3].forEach(mult => {
                quick.appendChild(h('button', {
                    type: 'button',
                    class: 'chip-btn' + (state.mult === mult ? ' is-on' : ''),
                    onclick: () => { state.mult = mult; customInput.value = ''; paint(); UI.play('playUIClickSound'); }
                }, h('span', { class: 'num', text: K.formatMoney(K.centsForChips(rate, Math.round(rate.chips * mult))) })));
            });
            const n = chips();
            if (Number.isInteger(n) && n > 0) {
                const cents = K.centsForChips(rate, n);
                const typed = state.mult ? cents : K.parseMoneyToCents(customInput.value);
                preview.textContent = `You get ${K.formatChips(n)} chips` + (typed !== cents ? ` (worth ${K.formatMoney(cents)})` : '');
            } else preview.textContent = state.mult ? '' : 'Enter an amount';
        }
        customInput.addEventListener('input', () => { state.mult = customInput.value.trim() ? 0 : 1; paint(); });
        customInput.addEventListener('focus', () => { if (customInput.value.trim()) state.mult = 0; });
        return { el: h('div', { class: 'stack-sm' }, quick, customInput, preview), chips, paint, label: opts && opts.label };
    }

    function buildJoin(root) {
        const r = P.refs;
        r.name = h('input', { class: 'input input-lg', type: 'text', maxlength: String(K.MAX_NAME), autocomplete: 'given-name', placeholder: 'Your name', 'aria-label': 'Your name', enterkeyhint: 'done' });
        r.name.value = Sync.storageGet('kapoker.player.name') || '';
        r.picker = amountPicker();
        r.title = h('h1', { class: 'title title-xl' });
        r.submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: 'Buy in 🪙' });
        r.removed = h('div', { class: 'callout callout-warn', text: 'The host removed you.' });
        root.append(
            h('section', { class: 'card stack' },
                r.title,
                r.removed,
                h('form', { class: 'stack', onsubmit: e => {
                    e.preventDefault();
                    const name = K.cleanName(r.name.value);
                    if (!name) { r.name.focus(); UI.toast('Enter your name', { type: 'error' }); return; }
                    const n = r.picker.chips();
                    if (!Number.isInteger(n) || n <= 0) { UI.toast('Choose a buy-in amount', { type: 'error' }); return; }
                    send('join', { name, chips: n });
                } },
                    r.name,
                    r.picker.el,
                    r.submit)),
            tableCard());
        if (!r.name.value) setTimeout(() => r.name.focus(), 100);
    }

    function updateJoin() {
        const r = P.refs;
        UI.setText(r.title, P.game.name);
        r.removed.hidden = !P.removedNotice;
        r.submit.disabled = !!P.pending;
        r.picker.paint();
        updateTable();
    }

    // ----- joined, live -----

    function buildMe(root) {
        const r = P.refs;
        r.avatarSlot = h('span');
        r.name = h('div', { class: 'me-name' });
        r.amount = h('div', { class: 'hero-amount num' });
        r.sub = h('div', { class: 'muted num' });
        r.picker = amountPicker();
        r.rebuyBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: 'Rebuy 🪙' });
        root.append(
            h('section', { class: 'card hero-card' },
                h('div', { class: 'me-head' }, r.avatarSlot, r.name),
                r.amount,
                r.sub),
            h('section', { class: 'card stack' },
                h('form', { class: 'stack', onsubmit: e => {
                    e.preventDefault();
                    const n = r.picker.chips();
                    if (!Number.isInteger(n) || n <= 0) { UI.toast('Choose an amount', { type: 'error' }); return; }
                    send('buyin', { playerId: P.me.playerId, chips: n });
                } }, r.picker.el, r.rebuyBtn)),
            tableCard(),
            h('div', { class: 'center pad' }, h('button', { class: 'btn btn-link', type: 'button', text: 'Switch player', onclick: () => { saveMe(null); render(); } })));
    }

    function updateMe() {
        const r = P.refs;
        const row = myRow();
        if (!row) return;
        if (r.avatarName !== row.name) {
            r.avatarName = row.name;
            r.avatarSlot.replaceWith(r.avatarSlot = UI.avatar(row.name));
        }
        UI.setText(r.name, row.name);
        UI.rollTo(r.amount, row.boughtCents, K.formatMoney);
        UI.setText(r.sub, `${K.formatChips(row.boughtChips)} chips`);
        r.rebuyBtn.disabled = !!P.pending;
        r.picker.paint();
        updateTable();
    }

    // ----- counting -----

    function buildCount(root) {
        const r = P.refs;
        r.input = h('input', { class: 'input input-xl num', type: 'text', inputmode: 'numeric', pattern: '[0-9,]*', autocomplete: 'off', placeholder: 'Chips', 'aria-label': 'Your chip count', enterkeyhint: 'send' });
        r.bought = h('p', { class: 'muted num' });
        r.status = h('div', { class: 'count-status' });
        r.preview = h('div', { class: 'muted small num' });
        r.sendBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: 'Send' });
        r.input.addEventListener('input', paintPreview);
        root.append(
            h('section', { class: 'card stack count-card' },
                h('h1', { class: 'title', text: 'How many chips do you have?' }),
                r.bought,
                h('form', { class: 'stack', onsubmit: e => {
                    e.preventDefault();
                    const n = K.parseChips(r.input.value);
                    if (!Number.isInteger(n)) { UI.toast('Enter a whole number of chips', { type: 'error' }); r.input.focus(); return; }
                    r.input.blur();
                    send('final', { playerId: P.me.playerId, chips: n });
                } }, r.input, r.preview, r.sendBtn),
                r.status),
            tableCard());
        setTimeout(() => { if (!myRow() || myRow().final === null) r.input.focus(); }, 150);
    }

    function paintPreview() {
        const r = P.refs;
        const row = myRow();
        const n = K.parseChips(r.input.value);
        if (!row || !Number.isInteger(n) || !r.input.value.trim()) { r.preview.textContent = ''; return; }
        const net = K.centsForChips(P.game.rate, n - row.boughtChips);
        r.preview.textContent = net === 0 ? 'Even' : (net > 0 ? '📈 up ' : '📉 down ') + K.formatMoney(Math.abs(net));
    }

    function updateCount() {
        const r = P.refs;
        const row = myRow();
        if (!row) return;
        UI.setText(r.bought, `In for ${K.formatChips(row.boughtChips)}`);
        if (row.final !== null) {
            UI.syncInput(r.input, K.formatChips(row.final));
            r.status.hidden = false;
            r.status.dataset.state = 'ok';
            UI.setText(r.status, row.finalBy === 'player'
                ? `✓ Host has ${K.formatChips(row.final)}`
                : `✓ Host entered ${K.formatChips(row.final)}`);
            UI.setText(r.sendBtn, 'Update');
        } else {
            r.status.hidden = true;
            UI.setText(r.sendBtn, 'Send');
        }
        r.sendBtn.disabled = !!P.pending;
        paintPreview();
        updateTable();
    }

    function buildCountingGuest(root) {
        root.append(h('section', { class: 'card stack' },
            h('h1', { class: 'title', text: 'Counting chips 🧮' })),
            tableCard());
    }

    // ----- settled -----

    function buildSettled(root) {
        P.refs.body = h('div');
        root.append(
            h('section', { class: 'card settled-head' },
                h('h1', { class: 'title', text: P.game.name })),
            P.refs.body);
    }

    function updateSettled() {
        P.refs.body.innerHTML = '';
        P.refs.body.appendChild(UI.renderSettlement({
            game: P.game,
            paid: P.paid,
            meId: P.me ? P.me.playerId : null,
            onTogglePaid: (key, paid) => {
                UI.play('playUIClickSound');
                Sync.setPaid(P.code, key, paid).catch(() => UI.toast('Couldn\'t save', { type: 'error' }));
            }
        }));
    }

    // ----- the table (everyone's buy-ins) -----

    function tableCard() {
        P.refs.tableList = h('ul', { class: 'table-list' });
        P.refs.tableEmpty = h('p', { class: 'muted small', text: 'Be the first 👀' });
        P.refs.tableHead = h('span', { class: 'muted small num' });
        P.refs.tableTitle = h('h2', { text: 'Table' });
        return h('section', { class: 'card' },
            h('div', { class: 'card-head' }, P.refs.tableTitle, P.refs.tableHead),
            P.refs.tableEmpty,
            P.refs.tableList);
    }

    function updateTable() {
        const r = P.refs;
        if (!r.tableList || !P.game) return;
        const { rows, totals } = K.summarize(P.game);
        const counting = P.game.status === K.STATUS.COUNTING;
        if (r.tableEmpty) r.tableEmpty.hidden = rows.length > 0;
        UI.setText(r.tableHead, counting
            ? `${totals.countedPlayers}/${totals.players}`
            : K.formatMoney(totals.boughtCents));
        UI.keyedList(r.tableList, rows, x => x.playerId, () => {
            const el = h('li');
            el._slot = h('span');
            el._name = h('span', { class: 'grow' });
            el._val = h('span', { class: 'num' });
            el.append(el._slot, el._name, el._val);
            return el;
        }, (el, row) => {
            if (el._avatarName !== row.name) { el._avatarName = row.name; el.replaceChild(UI.avatar(row.name), el.firstChild); }
            UI.setText(el._name, row.name + (P.me && row.playerId === P.me.playerId ? ' (you)' : ''));
            el.classList.toggle('is-me', !!(P.me && row.playerId === P.me.playerId));
            if (counting) UI.setText(el._val, row.final === null ? '⏳' : (row.finalBy === 'player' ? '📱 ' : '✓ ') + K.formatChips(row.final));
            else UI.setText(el._val, K.formatMoney(row.boughtCents));
        });
    }

    // ---------- boot ----------

    function boot() {
        UI.applyTheme('banana');
        if (window.SoundSystem) {
            const unlock = () => { window.SoundSystem.init(); window.removeEventListener('pointerdown', unlock); };
            window.addEventListener('pointerdown', unlock);
        }
        Sync.init();
        if (P.code) {
            P.me = loadJSON(meKey());
            const pending = loadJSON(pendingKey());
            if (pending && pending.id && Date.now() - (pending.sentAt || 0) < 6 * 3600 * 1000) {
                P.pending = pending;
                watchPending();
            } else if (pending) {
                Sync.storageRemove(pendingKey());
            }
            subscribe();
        }
        render();
        setInterval(() => { if (P.pending) renderPending(); }, 2000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
