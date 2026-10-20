// Minimal stand-in for 'firebase/app'. app/lib/firebase.ts calls getApps() then
// initializeApp(); neither touches the network in the real SDK either, but we
// stub them so the test run is fully offline and deterministic.

const fakeApp = { name: '[DEFAULT]', options: {}, automaticDataCollectionEnabled: false };

export function initializeApp() {
  return fakeApp;
}

export function getApps() {
  return [] as unknown[];
}

export function getApp() {
  return fakeApp;
}

export default { initializeApp, getApps, getApp };
