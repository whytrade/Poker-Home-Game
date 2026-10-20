import { describe, it, expect, beforeEach } from 'vitest';
import { calculatePayouts } from '../app/utils/payouts';
import { normalizePlayers, calculateTotals } from '../app/utils/helpers';
import { Player, PayoutResult } from '../app/types';
import { ref, get, __resetStore, __seed } from './fakeRtdb';
import {
  createGame,
  joinOrRebuy,
  hostAddPlayer,
  hostSetChips,
  hostReset,
  interleave,
  mulberry32,
  randInt,
} from './support';

beforeEach(() => __resetStore());

const cents = (d: number) => Math.round(d * 100);

async function loadPlayers(gameId: string): Promise<Player[]> {
  const snap = await get(ref(null, `games/${gameId}/state/players`));
  return normalizePlayers(snap.val());
}
async function loadState(gameId: string) {
  const snap = await get(ref(null, `games/${gameId}/state`));
  const raw = snap.val();
  return { players: normalizePlayers(raw?.players), nextPlayerId: raw?.nextPlayerId };
}

// Full settlement invariants for a non-all-lost game.
function expectSettles(players: Player[], ratio: number, res: PayoutResult) {
  const active = players.filter((p) => p.active !== false);
  expect(res.playerStats.reduce((s, ps) => s + cents(ps.netCash), 0)).toBe(0);
  for (const t of res.transactions) expect(cents(t.amount)).toBeGreaterThan(0);
  const flow = new Map<string, number>(res.playerStats.map((ps) => [ps.name, 0]));
  for (const t of res.transactions) {
    flow.set(t.to, (flow.get(t.to) ?? 0) + cents(t.amount));
    flow.set(t.from, (flow.get(t.from) ?? 0) - cents(t.amount));
  }
  for (const ps of res.playerStats) expect(flow.get(ps.name)).toBe(cents(ps.netCash));
  expect(res.transactions.length).toBeLessThanOrEqual(Math.max(0, active.length - 1));
  for (const p of active) {
    const floatNet = p.currentChips * res.effectiveRatio - p.initialChips * ratio;
    const ps = res.playerStats.find((s) => s.id === p.id)!;
    expect(Math.abs(cents(ps.netCash) - floatNet * 100)).toBeLessThanOrEqual(1 + 1e-6);
  }
}

describe('lifecycle Sim 1 — "friday night" (clean, conserved chips)', () => {
  it('4 QR joins @ $20/0.02, 2 rebuys, conserving host edits, exact settlement', async () => {
    await createGame('FRI', 'Friday Night', 0.02); // 1 chip = $0.02 -> $20 = 1000 chips

    for (const name of ['Alice', 'Bob', 'Cara', 'Dan']) {
      const chips = await joinOrRebuy('FRI', name, 20);
      expect(chips).toBe(1000);
    }
    let { players } = await loadState('FRI');
    expect(players).toHaveLength(4);
    expect(calculateTotals(players).totalStarting).toBe(4000);

    // Two rebuys.
    expect(await joinOrRebuy('FRI', 'Alice', 20)).toBe(1000); // +1000
    expect(await joinOrRebuy('FRI', 'Bob', 10)).toBe(500); // +500

    players = await loadPlayers('FRI');
    const totalInitial = calculateTotals(players).totalStarting;
    expect(totalInitial).toBe(5500);

    // Host edits final stacks, CONSERVING chips (sum stays 5500).
    const finals: Record<string, number> = { Alice: 2600, Bob: 1500, Cara: 400, Dan: 1000 };
    expect(Object.values(finals).reduce((a, b) => a + b, 0)).toBe(5500);
    for (const p of players) await hostSetChips('FRI', p.id, finals[p.name]);

    players = await loadPlayers('FRI');
    const totals = calculateTotals(players);
    expect(totals.totalCurrent).toBe(totals.totalStarting); // conserved
    expect(totals.discrepancy).toBe(0);

    const res = calculatePayouts(players, 0.02);
    expect(res.effectiveRatio).toBe(0.02); // no discrepancy
    expectSettles(players, 0.02, res);
    // Alice bought 2000 chips (join 1000 + rebuy 1000); net = (2600-2000)*0.02 = +12.
    expect(res.playerStats.find((s) => s.name === 'Alice')!.netCash).toBeCloseTo(12, 10);
  });
});

describe('lifecycle Sim 2 — "messy night" (legacy array, lost chip, effectiveRatio)', () => {
  it('legacy game + walk-in + rebuy + re-edit with a missing chip still settles exactly', async () => {
    // Legacy array game already in progress.
    __seed('games/MSY', {
      name: 'Messy',
      active: true,
      ratio: 0.05,
      state: {
        players: [
          { id: 0, name: 'Zed', initialChips: 200, currentChips: 150, active: true },
          { id: 1, name: 'Yan', initialChips: 200, currentChips: 260, active: true },
        ],
      },
    });
    expect(Array.isArray((await get(ref(null, 'games/MSY/state/players'))).val())).toBe(true);

    // Host adds a walk-in manually.
    await hostAddPlayer('MSY', 'Walkin', 200);
    // Phone rebuy for an existing (legacy) player — matched by name.
    const rc = await joinOrRebuy('MSY', 'Zed', 10); // 10/0.05 = 200 chips
    expect(rc).toBe(200);

    // Host fat-fingers a chip edit, then corrects it.
    await hostSetChips('MSY', 'p2', 9999); // oops (Walkin)
    await hostSetChips('MSY', 'p2', 250); // corrected

    // Deliberately leave chips NOT summing (a chip physically lost).
    await hostSetChips('MSY', 'p1', 100); // Zed final (should have been more)

    const players = await loadPlayers('MSY');
    expect(players.map((p) => p.name).sort()).toEqual(['Walkin', 'Yan', 'Zed']);
    const totals = calculateTotals(players);
    expect(totals.totalStarting).toBe(200 + 200 + 200 + 200); // Zed 400, Yan 200, Walkin 200
    // current: Zed 100 + Yan 260 + Walkin 250 = 610 vs 800 initial -> lost chips.
    expect(totals.discrepancy).toBeLessThan(0);

    const res = calculatePayouts(players, 0.05);
    expect(res.effectiveRatio).toBeGreaterThan(0.05); // missing chips worth more
    expectSettles(players, 0.05, res);
  });
});

describe('lifecycle Sim 3 — "reset and replay"', () => {
  it('play, reset (current := initial), replay, settle again', async () => {
    await createGame('RST', 'Rematch', 0.02);
    for (const name of ['Ann', 'Ben', 'Cy']) await joinOrRebuy('RST', name, 20);
    await joinOrRebuy('RST', 'Ann', 20); // rebuy -> Ann initial 2000

    // First game result.
    let players = await loadPlayers('RST');
    const conserved = { Ann: 2000, Ben: 1200, Cy: 800 };
    expect(Object.values(conserved).reduce((a, b) => a + b, 0)).toBe(4000);
    for (const p of players) await hostSetChips('RST', p.id, conserved[p.name as keyof typeof conserved]);
    players = await loadPlayers('RST');
    expectSettles(players, 0.02, calculatePayouts(players, 0.02));

    // Reset.
    await hostReset('RST');
    players = await loadPlayers('RST');
    for (const p of players) expect(p.currentChips).toBe(p.initialChips);
    // payoutsFinalized flag cleared.
    expect((await get(ref(null, 'games/RST'))).val().payoutsFinalized).toBe(false);

    // Replay: new stacks, settle again.
    const replay = { Ann: 1500, Ben: 1500, Cy: 1000 };
    for (const p of players) await hostSetChips('RST', p.id, replay[p.name as keyof typeof replay]);
    players = await loadPlayers('RST');
    expect(calculateTotals(players).discrepancy).toBe(0);
    expectSettles(players, 0.02, calculatePayouts(players, 0.02));
  });
});

describe('lifecycle Sim 4 — "hostile ordering" (seeded, 30+ contended ops)', () => {
  it('every player survives, all rebuy chips accounted for, no id collisions, nextPlayerId consistent', async () => {
    await createGame('HOS', 'Chaos', 1.0); // ratio 1 -> chips == dollars
    const rng = mulberry32(0x5EED42);
    const pool = ['Al', 'Bea', 'Cid', 'Deb', 'Eli', 'Fay'];

    // Expected accounting.
    const bought = new Map<string, number>(); // name -> total buy-in chips
    const created: string[] = []; // distinct names in creation order

    type Op = { run: () => Promise<unknown>; label: string };
    const ops: Op[] = [];

    for (let i = 0; i < 34; i++) {
      const roll = rng();
      // Edit only if we already have players; ~30% edits.
      if (roll < 0.3 && created.length > 0) {
        const name = created[randInt(rng, 0, created.length - 1)];
        const amount = randInt(rng, 0, 5000);
        // Edit targets current chips only (does not affect accounting).
        ops.push({
          label: `edit ${name}`,
          run: async () => {
            const players = await loadPlayers('HOS');
            const target = players.find((p) => p.name === name);
            if (target) await hostSetChips('HOS', target.id, amount);
          },
        });
      } else {
        // Join or rebuy by name.
        const name = pool[randInt(rng, 0, pool.length - 1)];
        const dollars = randInt(rng, 5, 200);
        if (!bought.has(name)) {
          bought.set(name, 0);
          created.push(name);
        }
        bought.set(name, bought.get(name)! + dollars); // chips == dollars at ratio 1
        ops.push({ label: `join ${name} $${dollars}`, run: () => joinOrRebuy('HOS', name, dollars) });
      }
    }

    // Execute in contended pairs (forced stale-read/retry) with some solo ops.
    let i = 0;
    while (i < ops.length) {
      if (i + 1 < ops.length && rng() < 0.7) {
        await interleave(ops[i].run, ops[i + 1].run);
        i += 2;
      } else {
        await ops[i].run();
        i += 1;
      }
    }

    const { players, nextPlayerId } = await loadState('HOS');

    // Every distinct player survived exactly once.
    expect(players.map((p) => p.name).sort()).toEqual([...bought.keys()].sort());
    expect(players).toHaveLength(bought.size);

    // No id collisions; ids are well-formed p<N>.
    const ids = players.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^p\d+$/.test(id))).toBe(true);

    // Every rebuy dollar accounted for: initialChips == total bought per player.
    for (const p of players) expect(p.initialChips).toBe(bought.get(p.name));
    const totalBought = [...bought.values()].reduce((a, b) => a + b, 0);
    expect(players.reduce((s, p) => s + p.initialChips, 0)).toBe(totalBought);

    // nextPlayerId consistent: exactly one id consumed per distinct player.
    expect(nextPlayerId).toBe(bought.size + 1);
  });
});
