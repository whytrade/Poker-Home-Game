// Kapoker sync — the only file that talks to Firebase.
//
// Layout under games/{CODE}:
//   v: 2, name, createdAt, active     basic info (old-app compatible fields)
//   host: { deviceId, at }            which device currently owns the game
//   presence/host                     set while the host page is open
//   snapshot                          read-only copy of the host's game state
//   requests/{pushId}                 phone -> host: join / buyin / final
//   acks/{pushId}                     host -> phone: result of a request
//   paid/{transferKey}                "this payment is done" ticks (anyone)
//
// Only the host writes `snapshot`; phones only push requests. That single-
// writer rule is what keeps the numbers consistent.
(function () {
    'use strict';

    let db = null;
    const STORAGE_DEVICE = 'kapoker.deviceId';

    function storageGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storageSet(key, value) {
        try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
    }
    function storageRemove(key) {
        try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    function randomId(len) {
        const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
        let out = '';
        const bytes = (window.crypto && window.crypto.getRandomValues)
            ? window.crypto.getRandomValues(new Uint8Array(len))
            : Array.from({ length: len }, () => Math.floor(Math.random() * 256));
        for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
        return out;
    }

    function deviceId() {
        let id = storageGet(STORAGE_DEVICE);
        if (!id) {
            id = 'd_' + randomId(12);
            storageSet(STORAGE_DEVICE, id);
        }
        return id;
    }

    function init() {
        if (db) return db;
        try {
            if (typeof firebase === 'undefined' || !window.firebaseConfig) return null;
            if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
            db = firebase.database();
        } catch (err) {
            console.error('[sync] Firebase init failed', err);
            db = null;
        }
        return db;
    }

    function ref(code, path) {
        if (!db) throw new Error('offline');
        return db.ref('games/' + code + (path ? '/' + path : ''));
    }

    function listen(r, event, cb) {
        const handler = r.on(event, cb, err => console.error('[sync] listener error', r.toString(), err));
        return () => r.off(event, handler);
    }

    function onConnection(cb) {
        if (!db) { cb(false); return () => {}; }
        return listen(db.ref('.info/connected'), 'value', snap => cb(snap.val() === true));
    }

    // ---- host side ----

    async function codeExists(code) {
        const snap = await ref(code).once('value');
        return snap.exists();
    }

    // A lease id is deviceId + per-tab id, so two tabs on one laptop can't
    // both act as host.
    function leaseId() {
        let tab = null;
        try { tab = window.sessionStorage.getItem('kapoker.tabId'); } catch (e) { /* ignore */ }
        if (!tab) {
            tab = randomId(6);
            try { window.sessionStorage.setItem('kapoker.tabId', tab); } catch (e) { /* ignore */ }
        }
        return deviceId() + ':' + tab;
    }

    function claimHost(code, info) {
        const updates = {
            v: 2,
            active: true,
            host: { deviceId: leaseId(), at: Date.now() }
        };
        if (info && info.name) updates.name = info.name;
        if (info && info.createdAt) updates.createdAt = info.createdAt;
        return ref(code).update(updates);
    }

    function watchHost(code, cb) {
        return listen(ref(code, 'host'), 'value', snap => {
            const v = snap.val();
            cb(v && v.deviceId ? v.deviceId : null);
        });
    }

    // Keeps presence/host set while this page is connected.
    function hostPresence(code) {
        if (!db) return () => {};
        const presence = ref(code, 'presence/host');
        const stop = onConnection(connected => {
            if (!connected) return;
            presence.onDisconnect().remove().then(() => presence.set(Date.now())).catch(() => {});
        });
        return () => {
            stop();
            presence.onDisconnect().cancel().catch(() => {});
            presence.remove().catch(() => {});
        };
    }

    // One atomic write: new snapshot + acks for handled requests + removal of
    // those requests. Phones see their ack and the updated numbers together.
    function commit(code, snapshot, acks) {
        const updates = { snapshot: snapshot, name: snapshot.name, updatedAt: snapshot.updatedAt };
        Object.keys(acks || {}).forEach(id => {
            updates['acks/' + id] = acks[id];
            updates['requests/' + id] = null;
        });
        return ref(code).update(updates);
    }

    function watchRequests(code, cb) {
        return listen(ref(code, 'requests'), 'child_added', snap => {
            const val = snap.val();
            if (val && typeof val === 'object') cb(Object.assign({}, val, { id: snap.key }));
        });
    }

    function loadSnapshot(code) {
        return ref(code, 'snapshot').once('value').then(s => s.val());
    }

    function closeGame(code) {
        return ref(code).update({ active: false, 'presence/host': null }).catch(() => {});
    }

    // ---- everyone ----

    function watchSnapshot(code, cb) {
        return listen(ref(code, 'snapshot'), 'value', snap => cb(snap.val()));
    }

    function hostOnlineOnce(code) {
        return ref(code, 'presence/host').once('value').then(s => s.exists());
    }

    function watchHostOnline(code, cb) {
        return listen(ref(code, 'presence/host'), 'value', snap => cb(snap.exists()));
    }

    function watchPaid(code, cb) {
        return listen(ref(code, 'paid'), 'value', snap => cb(snap.val() || {}));
    }

    function setPaid(code, key, paid) {
        return ref(code, 'paid/' + key).set(paid ? { at: Date.now(), by: deviceId() } : null);
    }

    function clearPaid(code) {
        return ref(code, 'paid').remove();
    }

    // ---- phone side ----

    function sendRequest(code, req) {
        const r = ref(code, 'requests').push();
        const body = Object.assign({}, req, { deviceId: deviceId(), at: Date.now() });
        Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
        return { id: r.key, done: r.set(body) };
    }

    function watchAck(code, id, cb) {
        return listen(ref(code, 'acks/' + id), 'value', snap => { if (snap.exists()) cb(snap.val()); });
    }

    function cancelRequest(code, id) {
        return ref(code, 'requests/' + id).remove();
    }

    function removeAck(code, id) {
        return ref(code, 'acks/' + id).remove();
    }

    function online() {
        return !!db;
    }

    window.KapokerSync = {
        init,
        online,
        deviceId,
        leaseId,
        storageGet,
        storageSet,
        storageRemove,
        onConnection,
        codeExists,
        claimHost,
        watchHost,
        hostPresence,
        commit,
        watchRequests,
        loadSnapshot,
        closeGame,
        watchSnapshot,
        watchHostOnline,
        hostOnlineOnce,
        watchPaid,
        setPaid,
        clearPaid,
        sendRequest,
        watchAck,
        cancelRequest,
        removeAck
    };
})();
