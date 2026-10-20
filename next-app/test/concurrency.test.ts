import { describe, it, expect, beforeEach } from 'vitest';
import { mutateGameState, normalizePlayers } from '../app/utils/helpers';
import { Player } from '../app/types';
import { ref, get, set, __resetStore, __rawAt, __seed } from './fakeRtdb';
import {
  createGame,
  joinOrRebuy,
  hostAddPlayer,
  hostSetChips,
  hostReset,
  interleave,
} from './support';

beforeEach(() => __resetStore());

async function readState(gameId: string): Promise<{ players: Player[]; nextPlayerId: number; raw: any }> {
  const snap = await get(ref(null, `games/${gameId}/state`));
  const raw = snap.val();
  return {
    players: normalizePlayers(raw?.players),
    nextPlayerId: raw?.nextPlayerId,
    raw,
  };
}

describe('concurrency — forced stale-read / retry interleavings', () => {
  it('two concurrent joins: both present, distinct ids, nextPlayerId correct', async () => {
    await createGame('G', 'Table', 1.0);
    await interleave(
      () => joinOrRebuy('G', 'Alice', 20),
      () => joinOrRebuy('G', 'Bob', 20)
    );
    const { players, nextPlayerId } = await readState('G');
    const names = players.map((p) => p.name).sort();
    expect(names).toEqual(['Alice', 'Bob']);
    const ids = players.map((p) => p.id);
    expect(new Set(ids).size).toBe(2); // distinct
    expect(nextPlayerId).toBe(3);
    // Bob committed first (p1), Alice retried onto fresh state (p2).
    expect(players.find((p) => p.name === 'Bob')!.id).toBe('p1');
    expect(players.find((p) => p.name === 'Alice')!.id).toBe('p2');
  });

  it('phone rebuy interleaved with host edit of a DIFFERENT player: both survive (the historical data-loss bug)', async () => {
    await createGame('G', 'Table', 1.0);
    await joinOrRebuy('G', 'Alice', 100); // p1: init 100 cur 100
    await joinOrRebuy('G', 'Bob', 100); // p2: init 100 cur 100

    await interleave(
      () => joinOrRebuy('G', 'Alice', 50), // rebuy Alice: +50 chips
      () => hostSetChips('G', 'p2', 40) // host sets Bob current = 40
    );

    const { players } = await readState('G');
    const alice = players.find((p) => p.name === 'Alice')!;
    const bob = players.find((p) => p.name === 'Bob')!;
    expect(alice.initialChips).toBe(150); // rebuy NOT erased
    expect(alice.currentChips).toBe(150);
    expect(bob.currentChips).toBe(40); // host edit NOT erased
  });

  it('phone rebuy interleaved with host edit of the SAME player: increment never lost, rebuy (last commit) wins the field', async () => {
    await createGame('G', 'Table', 1.0);
    await joinOrRebuy('G', 'Alice', 100); // init 100 cur 100

    await interleave(
      () => joinOrRebuy('G', 'Alice', 50), // rebuy: init+50, cur+50 (commits last)
      () => hostSetChips('G', 'p1', 500) // host sets cur=500 (commits first)
    );

    const { players } = await readState('G');
    const alice = players.find((p) => p.name === 'Alice')!;
    // initialChips increment is never lost regardless of ordering.
    expect(alice.initialChips).toBe(150);
    // rebuy retried on top of the host's 500 -> 500 + 50.
    expect(alice.currentChips).toBe(550);
  });

  it('host manual add interleaved with a join: distinct ids, both present', async () => {
    await createGame('G', 'Table', 1.0);
    await interleave(
      () => hostAddPlayer('G', 'Carol', 500), // reaches gate first, retries last
      () => joinOrRebuy('G', 'Dave', 20) // commits first as p1
    );
    const { players, nextPlayerId } = await readState('G');
    expect(players.map((p) => p.name).sort()).toEqual(['Carol', 'Dave']);
    expect(new Set(players.map((p) => p.id)).size).toBe(2);
    expect(nextPlayerId).toBe(3);
    expect(players.find((p) => p.name === 'Carol')!.isHost).toBe(true);
    expect(players.find((p) => p.name === 'Dave')!.id).toBe('p1');
  });

  it('reset-game interleaved with a rebuy: no lost players; reset commits last so currentChips === initialChips (rebuy survives in initialChips)', async () => {
    await createGame('G', 'Table', 0.02);
    await joinOrRebuy('G', 'Alice', 20); // init 1000 cur 1000
    await joinOrRebuy('G', 'Bob', 20); // init 1000 cur 1000
    await hostSetChips('G', 'p1', 1500); // Alice up
    await hostSetChips('G', 'p2', 500); // Bob down

    await interleave(
      () => hostReset('G'), // reset reaches gate first, retries + commits last
      () => joinOrRebuy('G', 'Alice', 20) // rebuy commits first: +1000 chips
    );

    const { players } = await readState('G');
    expect(players).toHaveLength(2); // no lost players
    // Serialization: reset committed last, so every current == initial, and the
    // concurrent rebuy survives inside Alice's initialChips.
    for (const p of players) expect(p.currentChips).toBe(p.initialChips);
    expect(players.find((p) => p.name === 'Alice')!.initialChips).toBe(2000);
    expect(players.find((p) => p.name === 'Bob')!.initialChips).toBe(1000);
  });
});

describe('concurrency — abort semantics', () => {
  it('mutator returning undefined leaves an existing state byte-identical and creates no node', async () => {
    await createGame('G', 'Table', 1.0);
    await joinOrRebuy('G', 'Alice', 20);
    const before = JSON.stringify(__rawAt('games/G'));

    await mutateGameState('G', () => undefined);

    const after = JSON.stringify(__rawAt('games/G'));
    expect(after).toBe(before);
  });

  it('mutator returning undefined against a NONEXISTENT game path does not create the node', async () => {
    expect(__rawAt('games/NOPE')).toBeNull();
    await mutateGameState('NOPE', () => undefined);
    expect(__rawAt('games/NOPE')).toBeNull();
    // Not even an empty state skeleton.
    expect(__rawAt('games/NOPE/state')).toBeNull();
  });
});

describe('concurrency — legacy migration under a write', () => {
  it('array-of-numeric-id players migrates to a p-keyed object on the next rebuy, preserving all fields', async () => {
    // Seed a GENUINE legacy array (positional) with numeric player ids and no
    // nextPlayerId, written through the fake so read-coercion applies.
    __seed('games/G', {
      name: 'Legacy',
      active: true,
      ratio: 0.02,
      state: {
        players: [
          { id: 1, name: 'Ann', initialChips: 1000, currentChips: 800, active: true, joinedAt: 111 },
          { id: 2, name: 'Bo', initialChips: 1000, currentChips: 1200, active: true, isHost: true },
        ],
      },
    });

    // Sanity: it really is stored/read as an array before migration.
    const preSnap = await get(ref(null, 'games/G/state/players'));
    expect(Array.isArray(preSnap.val())).toBe(true);

    await joinOrRebuy('G', 'Ann', 20); // rebuy Ann: +1000 chips

    const rawPlayers = __rawAt('games/G/state/players');
    // Migrated to a plain object (NOT an array), keyed by p<N>.
    expect(Array.isArray(rawPlayers)).toBe(false);
    expect(Object.keys(rawPlayers).sort()).toEqual(['p1', 'p2']);

    const { players, nextPlayerId } = await readState('G');
    const ann = players.find((p) => p.name === 'Ann')!;
    const bo = players.find((p) => p.name === 'Bo')!;

    // All fields intact, ids p-prefixed.
    expect(ann.id).toBe('p1');
    expect(bo.id).toBe('p2');
    expect(ann.initialChips).toBe(2000); // rebuy applied
    expect(ann.currentChips).toBe(1800);
    expect(ann.joinedAt).toBe(111);
    expect(bo.initialChips).toBe(1000);
    expect(bo.currentChips).toBe(1200);
    expect(bo.isHost).toBe(true);

    // nextPlayerId derived above the max legacy id (2).
    expect(nextPlayerId).toBeGreaterThan(2);
  });
});
