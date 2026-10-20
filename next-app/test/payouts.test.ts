import { describe, it, expect } from 'vitest';
import { calculatePayouts } from '../app/utils/payouts';
import { Player, PayoutResult } from '../app/types';
import { mulberry32, generateGame } from './support';

// Build a Player with sensible defaults.
function P(partial: Partial<Player> & { name: string }): Player {
  return {
    id: `p_${partial.name}`,
    initialChips: 0,
    currentChips: 0,
    active: true,
    ...partial,
  } as Player;
}

const cents = (dollars: number) => Math.round(dollars * 100);

// Assert every settlement invariant that must hold for a NON-all-lost game.
function assertSettles(players: Player[], ratio: number, res: PayoutResult) {
  const active = players.filter((p) => p.active !== false);

  // (1) adjusted nets sum to exactly zero cents.
  const netSum = res.playerStats.reduce((s, ps) => s + cents(ps.netCash), 0);
  expect(netSum).toBe(0);

  // (2) every transaction amount is a positive whole number of cents.
  for (const t of res.transactions) {
    const c = cents(t.amount);
    expect(c).toBeGreaterThan(0);
    expect(Math.abs(t.amount * 100 - c)).toBeLessThan(1e-6);
  }

  // (3) total paid === total received.
  const paid = res.transactions.reduce((s, t) => s + cents(t.amount), 0);
  expect(paid).toBe(res.transactions.reduce((s, t) => s + cents(t.amount), 0));
  // net flow per name must equal each player's adjusted net.
  const flow = new Map<string, number>();
  for (const ps of res.playerStats) flow.set(ps.name, 0);
  for (const t of res.transactions) {
    flow.set(t.to, (flow.get(t.to) ?? 0) + cents(t.amount));
    flow.set(t.from, (flow.get(t.from) ?? 0) - cents(t.amount));
  }
  for (const ps of res.playerStats) {
    expect(flow.get(ps.name)).toBe(cents(ps.netCash));
  }

  // (4) transactions.length <= players - 1 (greedy debt-settlement bound).
  expect(res.transactions.length).toBeLessThanOrEqual(Math.max(0, active.length - 1));

  // (5) each player within 1 cent of their exact float net.
  for (const p of active) {
    const floatNet = p.currentChips * res.effectiveRatio - p.initialChips * ratio;
    const ps = res.playerStats.find((s) => s.id === p.id)!;
    expect(Math.abs(cents(ps.netCash) - floatNet * 100)).toBeLessThanOrEqual(1 + 1e-6);
  }
}

describe('calculatePayouts — hand-built cases', () => {
  it('all-even game produces zero transactions and zero nets', () => {
    const players = [
      P({ name: 'A', initialChips: 1000, currentChips: 1000 }),
      P({ name: 'B', initialChips: 1000, currentChips: 1000 }),
      P({ name: 'C', initialChips: 1000, currentChips: 1000 }),
    ];
    const res = calculatePayouts(players, 0.02);
    expect(res.transactions).toHaveLength(0);
    expect(res.playerStats.every((s) => s.netCash === 0)).toBe(true);
    assertSettles(players, 0.02, res);
  });

  it('single winner, many losers', () => {
    const players = [
      P({ name: 'W', initialChips: 1000, currentChips: 4000 }),
      P({ name: 'L1', initialChips: 1000, currentChips: 0 }),
      P({ name: 'L2', initialChips: 1000, currentChips: 0 }),
      P({ name: 'L3', initialChips: 1000, currentChips: 0 }),
    ];
    const res = calculatePayouts(players, 0.02);
    assertSettles(players, 0.02, res);
    expect(res.transactions).toHaveLength(3);
    const wStat = res.playerStats.find((s) => s.name === 'W')!;
    expect(wStat.netCash).toBeCloseTo(60, 10); // won 3000 chips @0.02
  });

  it('many winners, single loser', () => {
    const players = [
      P({ name: 'L', initialChips: 4000, currentChips: 1000 }),
      P({ name: 'W1', initialChips: 1000, currentChips: 2000 }),
      P({ name: 'W2', initialChips: 1000, currentChips: 2000 }),
      P({ name: 'W3', initialChips: 1000, currentChips: 2000 }),
    ];
    const res = calculatePayouts(players, 0.02);
    assertSettles(players, 0.02, res);
    expect(res.transactions.every((t) => t.from === 'L')).toBe(true);
    expect(res.transactions).toHaveLength(3);
  });

  it('positive chip discrepancy (extra chips) rescales via effectiveRatio', () => {
    // current > initial: effectiveRatio < nominal.
    const players = [
      P({ name: 'A', initialChips: 1000, currentChips: 2500 }),
      P({ name: 'B', initialChips: 1000, currentChips: 500 }),
      P({ name: 'C', initialChips: 1000, currentChips: 500 }),
    ];
    const res = calculatePayouts(players, 0.02);
    expect(res.discrepancy).toBe(500);
    expect(res.effectiveRatio).toBeLessThan(0.02);
    assertSettles(players, 0.02, res);
  });

  it('negative chip discrepancy (missing chips) rescales via effectiveRatio', () => {
    const players = [
      P({ name: 'A', initialChips: 1000, currentChips: 1500 }),
      P({ name: 'B', initialChips: 1000, currentChips: 300 }),
      P({ name: 'C', initialChips: 1000, currentChips: 200 }),
    ];
    const res = calculatePayouts(players, 0.02);
    expect(res.discrepancy).toBe(-1000);
    expect(res.effectiveRatio).toBeGreaterThan(0.02);
    assertSettles(players, 0.02, res);
  });

  it('all chips lost (totalCurrent === 0): zero transactions, nets = -buyIn, no fabricated winner', () => {
    const players = [
      P({ name: 'A', initialChips: 1000, currentChips: 0 }),
      P({ name: 'B', initialChips: 2000, currentChips: 0 }),
      P({ name: 'C', initialChips: 500, currentChips: 0 }),
    ];
    const res = calculatePayouts(players, 0.02);
    expect(res.effectiveRatio).toBe(0);
    expect(res.transactions).toHaveLength(0);
    // Unadjusted: each net is exactly -buyIn; they intentionally do NOT sum to 0.
    const byName = Object.fromEntries(res.playerStats.map((s) => [s.name, s.netCash]));
    expect(byName.A).toBeCloseTo(-20, 10);
    expect(byName.B).toBeCloseTo(-40, 10);
    expect(byName.C).toBeCloseTo(-10, 10);
    expect(res.playerStats.every((s) => s.netCash <= 0)).toBe(true);
  });

  it('awkward ratio 0.0133 still settles exactly to the cent', () => {
    const players = [
      P({ name: 'A', initialChips: 1500, currentChips: 2300 }),
      P({ name: 'B', initialChips: 1500, currentChips: 900 }),
      P({ name: 'C', initialChips: 1500, currentChips: 1300 }),
    ];
    const res = calculatePayouts(players, 0.0133);
    assertSettles(players, 0.0133, res);
  });

  it('awkward ratio 1/3 still settles exactly to the cent', () => {
    const players = [
      P({ name: 'A', initialChips: 100, currentChips: 175 }),
      P({ name: 'B', initialChips: 100, currentChips: 25 }),
      P({ name: 'C', initialChips: 100, currentChips: 100 }),
    ];
    const res = calculatePayouts(players, 1 / 3);
    assertSettles(players, 1 / 3, res);
  });

  it('inactive players (active:false) excluded; active:undefined included', () => {
    const players = [
      P({ name: 'A', initialChips: 1000, currentChips: 1500 }),
      P({ name: 'B', initialChips: 1000, currentChips: 500 }),
      // active omitted entirely -> treated as active
      { id: 'p_U', name: 'U', initialChips: 1000, currentChips: 1000 } as Player,
      // explicitly inactive -> excluded from math + stats
      P({ name: 'Ghost', initialChips: 9999, currentChips: 0, active: false }),
    ];
    const res = calculatePayouts(players, 0.02);
    expect(res.playerStats.map((s) => s.name).sort()).toEqual(['A', 'B', 'U']);
    expect(res.playerStats.find((s) => s.name === 'Ghost')).toBeUndefined();
    // Ghost's chips must not affect discrepancy.
    expect(res.discrepancy).toBe(0);
    assertSettles(players, 0.02, res);
  });

  it('tiny nets where the rounding residual is comparable to the smallest net', () => {
    // Ratios chosen so cash-outs land near half-cents; residual redistribution
    // must keep every player within a cent and still net to zero.
    const players = [
      P({ name: 'A', initialChips: 3, currentChips: 4 }),
      P({ name: 'B', initialChips: 3, currentChips: 3 }),
      P({ name: 'C', initialChips: 3, currentChips: 2 }),
    ];
    const res = calculatePayouts(players, 0.0133);
    assertSettles(players, 0.0133, res);
  });
});

describe('calculatePayouts — property test (seeded, 600 random games)', () => {
  it('every generated game satisfies all settlement invariants', () => {
    const rng = mulberry32(0xC0FFEE);
    let allLostSeen = 0;
    let discrepancySeen = 0;
    for (let i = 0; i < 600; i++) {
      const { players, ratio, allChipsLost } = generateGame(rng);
      const res = calculatePayouts(players, ratio);

      if (res.discrepancy !== 0) discrepancySeen++;

      if (allChipsLost) {
        allLostSeen++;
        // Special case: no settlement, nets = -buyIn each, no winner fabricated.
        expect(res.effectiveRatio).toBe(0);
        expect(res.transactions).toHaveLength(0);
        for (const ps of res.playerStats) expect(ps.netCash).toBeLessThanOrEqual(0);
        continue;
      }

      assertSettles(players, ratio, res);
    }
    // Sanity: our generator actually exercised the interesting branches.
    expect(allLostSeen).toBeGreaterThan(0);
    expect(discrepancySeen).toBeGreaterThan(0);
  });
});
