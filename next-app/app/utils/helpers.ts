import { Player } from '../types';
import { database } from '../lib/firebase';
import { ref, runTransaction } from 'firebase/database';

// Players are persisted as a map keyed by "p<N>" (non-numeric keys prevent
// Firebase RTDB from coercing the map back into an array). Legacy games may
// still hold a plain array or an index-keyed object with numeric ids.
export function toPlayerKey(id: string | number): string {
  const s = String(id);
  return s.startsWith('p') ? s : `p${s}`;
}

// Accepts any historical shape of games/{id}/state/players and returns a
// clean list with string "p<N>" ids. All reads must go through this.
export function normalizePlayers(raw: unknown): Player[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw as Record<string, Player>);
  return (list as Player[])
    .filter(p => p && typeof p === 'object')
    .map(p => ({ ...p, id: toPlayerKey(p.id) }));
}

export function playersToMap(players: Player[]): Record<string, Player> {
  const map: Record<string, Player> = {};
  for (const p of players) {
    map[p.id] = p;
  }
  return map;
}

function maxNumericId(players: Player[]): number {
  return players.reduce((max, p) => {
    const n = parseInt(String(p.id).replace(/^p/, ''), 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
}

export interface GameStateDraft {
  players: Player[];
  nextPlayerId: number;
}

// The single write-path for games/{gameId}/state. Runs a Firebase transaction,
// hands the mutator a normalized draft, and persists the result as a keyed map
// (migrating legacy array data as a side effect). Return undefined from the
// mutator to leave the state untouched.
export async function mutateGameState(
  gameId: string,
  mutator: (draft: GameStateDraft) => GameStateDraft | undefined
): Promise<void> {
  await runTransaction(
    ref(database, `games/${gameId}/state`),
    (current) => {
      const players = normalizePlayers(current?.players);
      const nextPlayerId: number =
        typeof current?.nextPlayerId === 'number' && current.nextPlayerId > maxNumericId(players)
          ? current.nextPlayerId
          : maxNumericId(players) + 1;

      const result = mutator({ players, nextPlayerId });
      // Returning undefined ABORTS the transaction (a true no-op). Returning
      // `current` would commit a redundant write and re-fire every listener.
      if (!result) return undefined;

      return {
        ...(current || {}),
        players: playersToMap(result.players),
        nextPlayerId: result.nextPlayerId,
      };
    },
    // Don't fire listeners with the first optimistic run, which may execute
    // against a cold (null) cache and briefly show an empty player list.
    { applyLocally: false }
  );
}

export function generateShortGameId(length = 4): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 1, 0
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function calculateTotals(players: Player[]) {
    const totalStarting = players.reduce((sum, p) => sum + (p.initialChips || 0), 0);
    const totalCurrent = players.reduce((sum, p) => sum + (p.currentChips || 0), 0);
    const discrepancy = totalCurrent - totalStarting;
    return { totalStarting, totalCurrent, discrepancy };
}

