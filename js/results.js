// Kapoker results page (results.html?game=CODE): shareable, live settlement.
// Anyone with the link can tick payments as paid; everyone sees it live.
(function () {
    'use strict';

    const K = window.KapokerCore;
    const UI = window.KapokerUI;
    const Sync = window.KapokerSync;
    const h = UI.h;

    const params = new URLSearchParams(window.location.search);
    const code = K.normalizeCode(params.get('game') || params.get('code') || '');
    let game = null;
    let loaded = false;
    let paid = {};

    function status(state, text) {
        document.getElementById('sync-dot').dataset.state = state;
        UI.setText(document.getElementById('sync-label'), text);
    }

    function message(title, text) {
        return h('section', { class: 'card stack center' },
            h('h1', { class: 'title', text: title }),
            h('p', { class: 'muted', text }));
    }

    function render() {
        const root = document.getElementById('app');
        root.innerHTML = '';
        if (!code) { root.appendChild(message('No game', 'This link is missing its game code.')); return; }
        if (!loaded) {
            root.appendChild(h('section', { class: 'card stack center' },
                h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }),
                h('p', { class: 'muted', text: 'Loading results…' })));
            return;
        }
        if (!game) { root.appendChild(message('Game not found', `No game with code ${code}.`)); return; }
        UI.setText(document.getElementById('topbar-name'), game.name);
        document.title = game.name + ' — results';
        if (game.status !== K.STATUS.SETTLED || !game.settlement) {
            root.appendChild(message(game.name, game.status === K.STATUS.COUNTING
                ? 'Counting chips 🧮'
                : 'Game\'s still on 🃏'));
            root.appendChild(h('div', { class: 'center pad' }, h('a', { class: 'btn btn-ghost', href: UI.pageUrl('buy-in.html', { game: code }), text: 'Go to the game' })));
            return;
        }
        const me = (() => {
            try { return JSON.parse(Sync.storageGet('kapoker.player.' + code) || 'null'); } catch (e) { return null; }
        })();
        const d = new Date(game.settlement.at || game.createdAt);
        root.append(
            h('section', { class: 'card settled-head' },
                h('h1', { class: 'title', text: game.name }),
                h('p', { class: 'muted small', text: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + K.formatRate(game.rate) })),
            UI.renderSettlement({
                game,
                paid,
                meId: me ? me.playerId : null,
                onTogglePaid: (key, isPaid) => {
                    Sync.setPaid(code, key, isPaid).catch(() => UI.toast('Couldn\'t save', { type: 'error' }));
                }
            }));
    }

    function boot() {
        UI.applyTheme('banana');
        if (!Sync.init()) { status('off', 'Offline'); loaded = true; render(); return; }
        if (code) {
            Sync.onConnection(c => status(c ? 'ok' : 'wait', c ? 'Live' : 'Reconnecting…'));
            Sync.watchSnapshot(code, raw => {
                loaded = true;
                game = raw ? K.normalizeGame(raw) : null;
                if (game) UI.applyTheme(game.theme);
                render();
            });
            Sync.watchPaid(code, v => { paid = v; render(); });
        }
        render();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
