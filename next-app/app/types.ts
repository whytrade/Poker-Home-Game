export interface Player {
  id: string;
  name: string;
  initialChips: number; // Total chips bought (initial + rebuys)
  currentChips: number; // Current stack size
  active: boolean;
  isHost?: boolean;
  lastBuyIn?: number; // Timestamp of last buy-in/rebuy
  joinedAt?: number; // Timestamp of first join (QR-code joiners)
}

export interface GameState {
  id: string;
  name: string;
  ratio: number; // Dollars per chip
  players: Player[];
  active: boolean;
  payoutsFinalized: boolean;
}
export interface Transaction {
  from: string;
  to: string;
  amount: number; // Cash amount
}

export interface PayoutResult {
  transactions: Transaction[];
  effectiveRatio: number;
  discrepancy: number; // Difference in chips (current - initial)
  playerStats: PlayerStat[];
}

export interface PlayerStat {
  id: string;
  name: string;
  netCash: number;
  buyIn: number;
  cashOut: number;
}
