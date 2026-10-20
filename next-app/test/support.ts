// ---------------------------------------------------------------------------
// support.ts — shared test utilities.
//   * mulberry32: a tiny seeded deterministic PRNG (no dependency).
//   * Mirrored page mutators: these replicate EXACTLY the mutator callbacks that
//     app/host/page.tsx and app/join/page.tsx pass to mutateGameState. They are
//     copied (not imported) because the callbacks live inline inside React event
//     handlers. Keep them in sync with the pages.
//   * High-level flow helpers that drive the REAL app helpers (mutateGameState)
//     against the fake RTDB, mirroring what each page does around the mutator.
//   * interleave(): forces a stale-read / retry ordering between two writers.
//   * Random game generator for the payout property test.
// ---------------------------------------------------------------------------
import { Player } from '../app/types';
import { mutateGameState } from '../app/utils/helpers';
import { ref, get, set, update, armCommitGate } from './fakeRtdb';

// ------------------------------- PRNG --------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// -------------------- mirrored page mutator callbacks ----------------------
// join/page.tsx handleTransaction inner mutator (join OR rebuy by name).
export function joinMutator(name: string, chips: number, now: number) {
  const normalizedName = name.trim().toLowerCase();
  return (draft: { players: Player[]; nextPlayerId: number }) => {
    const existing = draft.players.find(
      (p) => p.name.trim().toLowerCase() === normalizedName
    );
    if (existing) {
      return {
        players: draft.players.map((p) =>
          p.id === existing.id
            ? {
                ...p,
                initialChips: (p.initialChips || 0) + chips,
                currentChips: (p.currentChips || 0) + chips,
                lastBuyIn: now,
              }
            : p
        ),
        nextPlayerId: draft.nextPlayerId,
      };
    }
    const newPlayer = {
      id: `p${draft.nextPlayerId}`,
      name: name.trim(),
      initialChips: chips,
      currentChips: chips,
      active: true,
      joinedAt: now,
    } as Player;
    return {
      players: [...draft.players, newPlayer],
      nextPlayerId: draft.nextPlayerId + 1,
    };
  };
}

// host/page.tsx handleAddPlayer inner mutator (manual add, isHost:true).
export function hostAddMutator(name: string, chips: number) {
  return (draft: { players: Player[]; nextPlayerId: number }) => {
    const newPlayer: Player = {
      id: `p${draft.nextPlayerId}`,
      name,
      initialChips: chips,
      currentChips: chips,
      active: true,
      isHost: true,
    };
    return {
      players: [...draft.players, newPlayer],
      nextPlayerId: draft.nextPlayerId + 1,
    };
  };
}

// host/page.tsx commitChips inner mutator (set one player's currentChips).
export function hostSetChipsMutator(playerId: string, amount: number) {
  return (draft: { players: Player[]; nextPlayerId: number }) => ({
    players: draft.players.map((p) =>
      p.id === playerId ? { ...p, currentChips: amount } : p
    ),
    nextPlayerId: draft.nextPlayerId,
  });
}

// host/page.tsx resetGame inner mutator (currentChips := initialChips).
export function hostResetMutator() {
  return (draft: { players: Player[]; nextPlayerId: number }) => ({
    players: draft.players.map((p) => ({ ...p, currentChips: p.initialChips })),
    nextPlayerId: draft.nextPlayerId,
  });
}

// ----------------------- high-level flow helpers ---------------------------
// createGame mirrors host/page.tsx createGame (minus QR/localStorage).
export async function createGame(gameId: string, name: string, ratio = 1.0): Promise<void> {
  await set(ref(null, `games/${gameId}`), {
    name,
    active: true,
    ratio,
    created: 0,
    state: { players: [], nextPlayerId: 1 },
  });
}

export async function setRatio(gameId: string, ratio: number): Promise<void> {
  await update(ref(null, `games/${gameId}`), { ratio });
}

// joinOrRebuy mirrors join/page.tsx handleTransaction: read ratio, compute
// chips = floor(dollars/ratio), run the join mutator through mutateGameState.
export async function joinOrRebuy(
  gameId: string,
  name: string,
  dollars: number,
  now = 0
): Promise<number> {
  const snap = await get(ref(null, `games/${gameId}`));
  const gameData: any = snap.val();
  if (!gameData) throw new Error('Game not found.');
  if (!gameData.active) throw new Error('Game is closed.');
  const ratio = gameData.ratio || 1.0;
  const chips = Math.floor(dollars / ratio);
  await mutateGameState(gameId, joinMutator(name, chips, now));
  return chips;
}

export async function hostAddPlayer(gameId: string, name: string, chips: number): Promise<void> {
  await mutateGameState(gameId, hostAddMutator(name, chips));
}

export async function hostSetChips(gameId: string, playerId: string, amount: number): Promise<void> {
  await mutateGameState(gameId, hostSetChipsMutator(playerId, amount));
}

export async function hostReset(gameId: string): Promise<void> {
  await mutateGameState(gameId, hostResetMutator());
  await update(ref(null, `games/${gameId}`), { payoutsFinalized: false });
}

// ------------------------------ interleave ---------------------------------
// Force a stale-read/retry ordering: `first` reads and runs its mutator, then
// PAUSES before commit; `second` runs fully and commits; `first` resumes, sees
// the conflict, and retries against the fresh (post-`second`) state.
export async function interleave(
  first: () => Promise<unknown>,
  second: () => Promise<unknown>
): Promise<void> {
  const gate = armCommitGate();
  const pFirst = first();
  await gate.reached; // `first` is paused at its pre-commit point
  await second(); // `second` commits underneath it
  gate.release(); // `first` resumes -> conflict -> retry on fresh data
  await pFirst;
}

// --------------------------- random game generator -------------------------
export interface GeneratedGame {
  players: Player[];
  ratio: number;
  allChipsLost: boolean;
}

const AWKWARD_RATIOS = [1, 0.02, 0.05, 0.1, 0.25, 0.5, 1 / 3, 0.0133, 2, 5, 0.01];

export function generateGame(rng: () => number): GeneratedGame {
  const n = randInt(rng, 2, 12);
  const ratio =
    rng() < 0.5
      ? AWKWARD_RATIOS[randInt(rng, 0, AWKWARD_RATIOS.length - 1)]
      : Math.max(0.01, Math.round(rng() * 500) / 100);

  const players: Player[] = [];
  let totalInitial = 0;
  for (let i = 0; i < n; i++) {
    // buy-in plus 0-3 rebuys
    let initial = randInt(rng, 1, 40) * randInt(rng, 5, 50);
    const rebuys = randInt(rng, 0, 3);
    for (let r = 0; r < rebuys; r++) initial += randInt(rng, 5, 40) * 10;
    players.push({
      id: `p${i + 1}`,
      name: `Player_${i + 1}`,
      initialChips: initial,
      currentChips: 0,
      active: true,
    });
    totalInitial += initial;
  }

  const mode = rng();
  const allChipsLost = mode < 0.06; // ~6% of games: table wiped out
  if (allChipsLost) {
    players.forEach((p) => (p.currentChips = 0));
    return { players, ratio, allChipsLost };
  }

  // Decide the pot of current chips: conserved, or forced +/- discrepancy.
  let totalCurrent = totalInitial;
  if (mode < 0.5) {
    const swing = Math.round(totalInitial * (rng() * 0.3));
    totalCurrent = Math.max(1, totalInitial + (rng() < 0.5 ? -swing : swing));
  }

  // Randomly partition totalCurrent across players (some may bust to 0).
  const weights = players.map(() => rng());
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  let assigned = 0;
  players.forEach((p, i) => {
    const share =
      i === players.length - 1
        ? totalCurrent - assigned
        : Math.round((weights[i] / wSum) * totalCurrent);
    p.currentChips = Math.max(0, share);
    assigned += p.currentChips;
  });
  // Fix any rounding drift onto the largest stack so totals land on target.
  const drift = totalCurrent - players.reduce((s, p) => s + p.currentChips, 0);
  if (drift !== 0) {
    let idx = 0;
    for (let i = 1; i < players.length; i++)
      if (players[i].currentChips > players[idx].currentChips) idx = i;
    players[idx].currentChips = Math.max(0, players[idx].currentChips + drift);
  }

  return { players, ratio, allChipsLost: false };
}
