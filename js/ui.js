// Kapoker UI helpers shared by the host, player and results pages.
(function () {
    'use strict';

    // h('div', { class: 'x', onclick: fn }, 'text', childNode, [more])
    function h(tag, attrs) {
        const el = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(key => {
                const value = attrs[key];
                if (value === undefined || value === null || value === false) return;
                if (key === 'class') el.className = value;
                else if (key === 'text') el.textContent = value;
                else if (key === 'dataset') Object.assign(el.dataset, value);
                else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
                else if (value === true) el.setAttribute(key, '');
                else el.setAttribute(key, value);
            });
        }
        for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
        return el;
    }

    function append(el, child) {
        if (child === undefined || child === null || child === false) return;
        if (Array.isArray(child)) { child.forEach(c => append(el, c)); return; }
        el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    function setText(el, text) {
        if (el && el.textContent !== String(text)) el.textContent = text;
    }

    // Keyed list reconciliation: keeps DOM nodes (and focused inputs) stable
    // across re-renders. create(item) -> element, update(el, item).
    function keyedList(container, items, keyFn, create, update) {
        const existing = new Map();
        Array.from(container.children).forEach(child => {
            if (child.dataset && child.dataset.key) existing.set(child.dataset.key, child);
        });
        const seen = new Set();
        let cursor = container.firstChild;
        items.forEach(item => {
            const key = String(keyFn(item));
            seen.add(key);
            let el = existing.get(key);
            if (!el) {
                el = create(item);
                el.dataset.key = key;
                el.classList.add('is-new');
                setTimeout(() => el.classList.remove('is-new'), 600);
            }
            update(el, item);
            if (el !== cursor) container.insertBefore(el, cursor);
            else cursor = cursor.nextSibling;
        });
        existing.forEach((el, key) => { if (!seen.has(key)) el.remove(); });
    }

    // Only overwrite an input's value when the user isn't typing in it.
    function syncInput(input, value) {
        if (document.activeElement === input) return;
        const v = value === null || value === undefined ? '' : String(value);
        if (input.value !== v) input.value = v;
    }

    // ---------- toasts ----------

    function toast(message, opts) {
        const options = opts || {};
        let root = document.getElementById('toast-root');
        if (!root) {
            root = h('div', { id: 'toast-root', class: 'toast-root', 'aria-live': 'polite' });
            document.body.appendChild(root);
        }
        const node = h('div', { class: 'toast toast-' + (options.type || 'info'), role: 'status' },
            h('span', { class: 'toast-text', text: message }));
        if (options.action) {
            node.appendChild(h('button', {
                class: 'toast-action',
                type: 'button',
                text: options.action.label,
                onclick: () => { options.action.run(); dismiss(); }
            }));
        }
        root.appendChild(node);
        while (root.children.length > 3) root.firstChild.remove();
        let timer = setTimeout(dismiss, options.duration || (options.action ? 5000 : 2600));
        function dismiss() {
            clearTimeout(timer);
            node.classList.add('toast-out');
            setTimeout(() => node.remove(), 220);
        }
        return dismiss;
    }

    // ---------- bottom sheet / dialog ----------

    let openSheetState = null;

    function closeSheet() {
        if (!openSheetState) return;
        const { overlay, onClose } = openSheetState;
        openSheetState = null;
        overlay.classList.add('sheet-out');
        setTimeout(() => overlay.remove(), 200);
        document.removeEventListener('keydown', onKey);
        if (onClose) onClose();
    }

    function onKey(e) {
        if (e.key === 'Escape') closeSheet();
    }

    // content: Node or (close) => Node
    function openSheet(title, content, opts) {
        closeSheet();
        const options = opts || {};
        const body = typeof content === 'function' ? content(closeSheet) : content;
        const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
            h('div', { class: 'sheet-handle' }),
            h('div', { class: 'sheet-head' },
                h('h2', { class: 'sheet-title', text: title }),
                h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close', onclick: closeSheet, text: '✕' })),
            h('div', { class: 'sheet-body' }, body));
        const overlay = h('div', { class: 'sheet-overlay', onclick: e => { if (e.target === overlay) closeSheet(); } }, panel);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
        openSheetState = { overlay, onClose: options.onClose };
        const focusable = panel.querySelector('[autofocus], input, button.btn-primary');
        if (focusable && !options.noAutofocus) setTimeout(() => focusable.focus(), 50);
        return closeSheet;
    }

    function confirmSheet({ title, message, confirmLabel, danger, onConfirm }) {
        openSheet(title, close => h('div', { class: 'stack' },
            h('p', { class: 'muted', text: message }),
            h('div', { class: 'row-actions' },
                h('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onclick: close }),
                h('button', {
                    class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
                    type: 'button',
                    text: confirmLabel || 'Confirm',
                    onclick: () => { close(); onConfirm(); }
                }))));
    }

    // ---------- QR + sharing ----------

    function renderQr(container, text, size) {
        container.innerHTML = '';
        if (typeof QRCode === 'undefined') {
            container.appendChild(h('div', { class: 'qr-fallback', text: 'QR unavailable — share the link' }));
            return;
        }
        try {
            new QRCode(container, {
                text,
                width: size || 220,
                height: size || 220,
                colorDark: '#0b0f14',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
            container.title = '';
        } catch (err) {
            container.appendChild(h('div', { class: 'qr-fallback', text: 'QR unavailable — share the link' }));
        }
    }

    async function share({ title, text, url }) {
        if (navigator.share) {
            try {
                await navigator.share({ title, text, url });
                return 'shared';
            } catch (err) {
                if (err && err.name === 'AbortError') return 'cancelled';
            }
        }
        return copy(url) ? 'copied' : 'failed';
    }

    function copy(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* fall through */ }
        const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.remove();
        return ok;
    }

    function pageUrl(file, params) {
        const base = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
        const qs = new URLSearchParams(params).toString();
        return base + file + (qs ? '?' + qs : '');
    }

    // ---------- theme + misc ----------

    const THEMES = [
        { id: 'felt', name: 'Felt', swatch: '#1f9d63' },
        { id: 'royal', name: 'Royal', swatch: '#3b6cf5' },
        { id: 'crimson', name: 'Crimson', swatch: '#e2445c' },
        { id: 'violet', name: 'Violet', swatch: '#8b5cf6' },
        { id: 'gold', name: 'Gold', swatch: '#e0a526' }
    ];

    function applyTheme(id) {
        const theme = THEMES.find(t => t.id === id) ? id : 'felt';
        document.documentElement.setAttribute('data-theme', theme);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', '#0b0f14');
        return theme;
    }

    function initials(name) {
        const parts = String(name || '?').trim().split(/\s+/);
        return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }

    // Stable hue per name so avatars are recognisable across devices.
    function hue(name) {
        let x = 0;
        const s = String(name || '').toLowerCase();
        for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 360;
        return x;
    }

    function avatar(name) {
        return h('span', { class: 'avatar', style: `--h:${hue(name)}`, 'aria-hidden': 'true', text: initials(name) });
    }

    function play(sound) {
        try {
            if (window.SoundSystem && typeof window.SoundSystem[sound] === 'function') window.SoundSystem[sound]();
        } catch (e) { /* sound is optional */ }
    }

    function vibrate(ms) {
        try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { /* optional */ }
    }

    function timeAgo(ts) {
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 45) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return m + 'm ago';
        const hrs = Math.floor(m / 60);
        return hrs + 'h ' + (m % 60) + 'm ago';
    }

    // Settlement view shared by host (settled), phones and results page.
    // opts: { game, paid, meId, onTogglePaid(key, bool) }
    function renderSettlement(opts) {
        const K = window.KapokerCore;
        const game = opts.game;
        const s = game.settlement;
        const paid = opts.paid || {};
        const byId = id => K.findPlayer(game, id) || { name: '?' };
        const nets = s.nets || {};
        const standings = game.players
            .filter(p => nets[p.id] !== undefined)
            .map(p => ({ id: p.id, name: p.name, net: nets[p.id] }))
            .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
        const paidCount = s.transfers.filter(t => paid[t.key]).length;

        const wrap = h('div', { class: 'settlement' });

        if (opts.meId && nets[opts.meId] !== undefined) {
            const mine = nets[opts.meId];
            const myTransfers = s.transfers.filter(t => t.from === opts.meId || t.to === opts.meId);
            wrap.appendChild(h('section', { class: 'card hero-card ' + (mine > 0 ? 'is-up' : mine < 0 ? 'is-down' : '') },
                h('div', { class: 'eyebrow', text: mine > 0 ? 'You won' : mine < 0 ? 'You lost' : 'You broke even' }),
                h('div', { class: 'hero-amount num', text: K.formatMoney(Math.abs(mine)) }),
                myTransfers.length ? h('ul', { class: 'my-transfers' }, myTransfers.map(t => h('li', null,
                    t.from === opts.meId
                        ? ['Pay ', h('strong', { text: byId(t.to).name }), ' ', h('span', { class: 'num', text: K.formatMoney(t.cents) })]
                        : [h('strong', { text: byId(t.from).name }), ' pays you ', h('span', { class: 'num', text: K.formatMoney(t.cents) })],
                    paid[t.key] ? h('span', { class: 'pill pill-ok', text: 'Paid' }) : null))) : null));
        }

        const transfersCard = h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('h2', { text: s.transfers.length ? 'Payments' : 'No payments needed' }),
                s.transfers.length ? h('span', { class: 'muted small num', text: `${paidCount}/${s.transfers.length} paid` }) : null),
            s.transfers.length ? h('div', { class: 'progress' }, h('span', { style: `width:${Math.round(100 * paidCount / s.transfers.length)}%` })) : null,
            s.transfers.length
                ? h('ul', { class: 'transfer-list' }, s.transfers.map(t => {
                    const isPaid = !!paid[t.key];
                    const involvesMe = opts.meId && (t.from === opts.meId || t.to === opts.meId);
                    return h('li', { class: 'transfer' + (isPaid ? ' is-paid' : '') + (involvesMe ? ' is-mine' : '') },
                        h('div', { class: 'transfer-who' },
                            h('span', { class: 'transfer-from', text: byId(t.from).name }),
                            h('span', { class: 'transfer-arrow', 'aria-label': 'pays', text: '→' }),
                            h('span', { class: 'transfer-to', text: byId(t.to).name })),
                        h('span', { class: 'transfer-amt num', text: K.formatMoney(t.cents) }),
                        opts.onTogglePaid ? h('button', {
                            class: 'check' + (isPaid ? ' is-on' : ''),
                            type: 'button',
                            'aria-pressed': isPaid ? 'true' : 'false',
                            'aria-label': (isPaid ? 'Mark unpaid: ' : 'Mark paid: ') + byId(t.from).name + ' to ' + byId(t.to).name,
                            onclick: () => opts.onTogglePaid(t.key, !isPaid)
                        }, isPaid ? '✓' : '') : null);
                }))
                : h('p', { class: 'muted', text: 'Everyone finished exactly even.' }));
        wrap.appendChild(transfersCard);

        wrap.appendChild(h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', { text: 'Standings' }),
                s.mode === 'spread' ? h('span', { class: 'pill pill-warn', text: 'Chip difference spread' }) : null),
            h('ul', { class: 'standings' }, standings.map((p, i) => h('li', { class: p.id === opts.meId ? 'is-me' : '' },
                h('span', { class: 'rank num', text: String(i + 1) }),
                avatar(p.name),
                h('span', { class: 'standing-name', text: p.name }),
                h('span', { class: 'num ' + (p.net > 0 ? 'up' : p.net < 0 ? 'down' : 'even'), text: K.formatMoney(p.net, { signed: true }) }))))));
        return wrap;
    }

    window.KapokerUI = {
        h,
        setText,
        keyedList,
        syncInput,
        toast,
        openSheet,
        closeSheet,
        confirmSheet,
        renderQr,
        share,
        copy,
        pageUrl,
        THEMES,
        applyTheme,
        avatar,
        initials,
        play,
        vibrate,
        timeAgo,
        renderSettlement
    };
})();
