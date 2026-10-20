import { defineConfig } from 'vitest/config';
import path from 'node:path';

// We alias the real Firebase entrypoints to in-memory fakes so the entire app
// data layer (helpers.ts / payouts.ts / page mutator logic) exercises a
// faithful RTDB simulation with ZERO network, emulator, Java, or browser.
//
//   firebase/database -> test/fakeRtdb.ts  (ref/get/set/update/onValue/
//                                           runTransaction/remove + getDatabase)
//   firebase/app      -> test/fakeApp.ts   (initializeApp/getApps/getApp)
//
// app/lib/firebase.ts therefore runs unmodified but produces a dummy database
// object, and every `import { ... } from 'firebase/database'` resolves to the
// fake.
export default defineConfig({
  resolve: {
    alias: {
      'firebase/database': path.resolve(__dirname, 'test/fakeRtdb.ts'),
      'firebase/app': path.resolve(__dirname, 'test/fakeApp.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
