import { describe, it, expect, beforeEach } from 'vitest';
import { normalizePlayers, toPlayerKey, playersToMap } from '../app/utils/helpers';
import { Player } from '../app/types';
import { ref, set, get, __resetStore, __coerce } from './fakeRtdb';

beforeEach(() => __resetStore());

describe('toPlayerKey', () => {
  it('prefixes numeric and bare ids with p, leaves p-keys intact', () => {
    expect(toPlayerKey(0)).toBe('p0');
    expect(toPlayerKey(5)).toBe('p5');
    expect(toPlayerKey('7')).toBe('p7');
    expect(toPlayerKey('p3')).toBe('p3');
  });
});

describe('normalizePlayers — every historical shape', () => {
  it('legacy array input', () => {
    const raw = [
      { id: 0, name: 'A', initialChips: 100, currentChips: 100, active: true },
      { id: 1, name: 'B', initialChips: 200, currentChips: 200, active: true },
    ];
    const out = normalizePlayers(raw);
    expect(out.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(out.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('index-keyed object input', () => {
    const raw = {
      0: { id: 0, name: 'A', initialChips: 100, currentChips: 100, active: true },
      1: { id: 1, name: 'B', initialChips: 200, currentChips: 200, active: true },
    };
    const out = normalizePlayers(raw);
    expect(out.map((p) => p.id)).toEqual(['p0', 'p1']);
  });

  it('p-keyed map input (already migrated)', () => {
    const raw = {
      p1: { id: 'p1', name: 'A', initialChips: 100, currentChips: 100, active: true },
      p2: { id: 'p2', name: 'B', initialChips: 200, currentChips: 200, active: true },
    };
    const out = normalizePlayers(raw);
    expect(out.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('mixed numeric/string ids', () => {
    const raw = {
      p1: { id: 'p1', name: 'A', initialChips: 1, currentChips: 1, active: true },
      2: { id: 2, name: 'B', initialChips: 1, currentChips: 1, active: true },
      x: { id: 'p9', name: 'C', initialChips: 1, currentChips: 1, active: true },
    };
    const out = normalizePlayers(raw);
    expect(out.map((p) => p.id).sort()).toEqual(['p1', 'p2', 'p9']);
  });

  it('null / undefined input returns []', () => {
    expect(normalizePlayers(null)).toEqual([]);
    expect(normalizePlayers(undefined)).toEqual([]);
    expect(normalizePlayers(0 as unknown)).toEqual([]);
  });

  it('array with holes / null entries filters the gaps', () => {
    const raw = [
      null,
      { id: 1, name: 'A', initialChips: 1, currentChips: 1, active: true },
      undefined,
      { id: 3, name: 'B', initialChips: 1, currentChips: 1, active: true },
    ];
    const out = normalizePlayers(raw as unknown);
    expect(out.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('is idempotent (shape-wise): normalize(normalize(x)) === normalize(x)', () => {
    const raw = [
      { id: 0, name: 'A', initialChips: 100, currentChips: 150, active: true },
      { id: 1, name: 'B', initialChips: 200, currentChips: 150, active: true },
    ];
    const once = normalizePlayers(raw);
    const twice = normalizePlayers(once);
    expect(twice).toEqual(once);
    // and through the map form too
    const viaMap = normalizePlayers(playersToMap(once));
    expect(viaMap.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      once.slice().sort((a, b) => a.id.localeCompare(b.id))
    );
  });
});

describe('playersToMap — array-coercion safety', () => {
  it('keys are never all-numeric (they are p-prefixed)', () => {
    const players: Player[] = [
      { id: 'p0', name: 'A', initialChips: 1, currentChips: 1, active: true },
      { id: 'p1', name: 'B', initialChips: 1, currentChips: 1, active: true },
      { id: 'p2', name: 'C', initialChips: 1, currentChips: 1, active: true },
    ];
    const map = playersToMap(players);
    expect(Object.keys(map)).toEqual(['p0', 'p1', 'p2']);
    expect(Object.keys(map).every((k) => /^\d+$/.test(k))).toBe(false);
  });

  it('survives a fake-RTDB write/read cycle as an OBJECT, not an array', async () => {
    const players: Player[] = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      name: `N${i}`,
      initialChips: 100,
      currentChips: 100,
      active: true,
    }));
    const map = playersToMap(players);
    await set(ref(null, 'games/G/state/players'), map);
    const snap = await get(ref(null, 'games/G/state/players'));
    const val = snap.val();
    expect(Array.isArray(val)).toBe(false);
    expect(typeof val).toBe('object');
    expect(Object.keys(val).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    // And it still normalizes back to the same 5 players.
    expect(normalizePlayers(val)).toHaveLength(5);
  });

  it('CONTROL: a numeric-keyed map DOES coerce to an array on read (why p-keys matter)', async () => {
    // Prove the fake actually reproduces RTDB coercion, so the object-safety
    // assertion above is meaningful.
    const numericMap: Record<string, unknown> = {
      0: { id: 0, name: 'A', initialChips: 1, currentChips: 1, active: true },
      1: { id: 1, name: 'B', initialChips: 1, currentChips: 1, active: true },
    };
    await set(ref(null, 'games/G/state/players'), numericMap);
    const val = (await get(ref(null, 'games/G/state/players'))).val();
    expect(Array.isArray(val)).toBe(true);
    // normalizePlayers still recovers p-keyed ids from the coerced array.
    expect(normalizePlayers(val).map((p) => p.id)).toEqual(['p0', 'p1']);
  });

  it('coercion heuristic: sparse numeric keys stay an object', () => {
    // Only index 0 and 100 populated -> not "reasonably dense" -> object.
    const sparse = { 0: { v: 1 }, 100: { v: 2 } };
    expect(Array.isArray(__coerce(sparse))).toBe(false);
    // Dense 0..2 -> array.
    expect(Array.isArray(__coerce({ 0: { v: 1 }, 1: { v: 2 }, 2: { v: 3 } }))).toBe(true);
  });
});
