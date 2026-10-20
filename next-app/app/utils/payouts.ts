import { Player, Transaction, PayoutResult, PlayerStat } from '../types';

export function calculatePayouts(players: Player[], nominalRatio: number): PayoutResult {
  // Filter active players. Defensive: a player counts as active unless
  // explicitly marked inactive (undefined => active).
  const activePlayers = players.filter(p => p.active !== false);

  let totalInitialChips = 0;
  let totalCurrentChips = 0;

  activePlayers.forEach(p => {
    totalInitialChips += p.initialChips;
    totalCurrentChips += p.currentChips;
  });

  const chipDiscrepancy = totalCurrentChips - totalInitialChips;

  // Effective Ratio Calculation (intentional, unchanged behavior)
  // totalPotValue = totalInitialChips * nominalRatio; (Total cash put in)
  // effectiveRatio = totalPotValue / totalCurrentChips;
  // If totalCurrentChips < totalInitialChips (chips missing), effectiveRatio > nominalRatio,
  // so the remaining chips are worth more. This rebalances the pot.
  let effectiveRatio = nominalRatio;
  if (totalCurrentChips > 0 && Math.abs(chipDiscrepancy) > 0) {
    const totalPotValue = totalInitialChips * nominalRatio;
    effectiveRatio = totalPotValue / totalCurrentChips;
  } else if (totalCurrentChips === 0 && totalInitialChips > 0) {
    effectiveRatio = 0; // All lost
  }

  // Calculate Net Position, tracking both the exact (floating) net and the
  // rounded-to-cents net used for settlement.
  interface WorkStat {
    id: string;
    name: string;
    buyIn: number;
    cashOut: number;
    netFloat: number;   // exact dollar net (for reference/residual tie-breaking)
    netCents: number;   // integer-cent net actually settled
  }

  const work: WorkStat[] = activePlayers.map(p => {
    const nominalBuyIn = p.initialChips * nominalRatio;
    // We use effectiveRatio for cashOut to balance the pot.
    const cashOutValue = p.currentChips * effectiveRatio;
    const netFloat = cashOutValue - nominalBuyIn;

    return {
      id: p.id,
      name: p.name,
      buyIn: nominalBuyIn,
      cashOut: cashOutValue,
      netFloat,
      // Convert each player's net to integer CENTS.
      netCents: Math.round(netFloat * 100)
    };
  });

  // Because each net is rounded independently, the cents may not sum to exactly
  // zero even though the underlying floats do. Redistribute the residual one
  // cent at a time to the players whose rounding drifted furthest in the
  // residual's direction (largest-remainder method): every player stays within
  // one cent of their exact net, so a real winner can never be flipped negative.
  //
  // When effectiveRatio === 0 (every chip lost) the exact nets do NOT sum to
  // zero — everyone simply lost their buy-in and there is no settlement between
  // players — so no residual correction may run, otherwise it would fabricate
  // a fake winner out of the missing pot.
  if (effectiveRatio !== 0 && work.length > 0) {
    let residual = work.reduce((sum, w) => sum + w.netCents, 0);
    if (residual !== 0) {
      const sign = residual > 0 ? 1 : -1;
      // drift: how many cents rounding moved this player in the residual's direction
      const byDrift = work
        .map((w, i) => ({ i, drift: (w.netCents - w.netFloat * 100) * sign }))
        .sort((a, b) => b.drift - a.drift);
      for (let k = 0; residual !== 0; k++) {
        work[byDrift[k % byDrift.length].i].netCents -= sign;
        residual -= sign;
      }
    }
  }

  // Build the returned player stats using the adjusted (residual-corrected)
  // nets, expressed back in dollars, so the UI and the transactions agree to
  // the exact cent.
  const stats: PlayerStat[] = work.map(w => ({
    id: w.id,
    name: w.name,
    buyIn: w.buyIn,
    cashOut: w.cashOut,
    netCash: w.netCents / 100
  }));

  // Sort Winners (net > 0) and Losers (net < 0), all in integer cents.
  const winners = work
    .filter(w => w.netCents > 0)
    .sort((a, b) => b.netCents - a.netCents);
  const losers = work
    .filter(w => w.netCents < 0)
    .sort((a, b) => a.netCents - b.netCents);

  const transactions: Transaction[] = [];
  let winnerIdx = 0;
  let loserIdx = 0;

  // Mutable balances, all in integer cents (positive magnitudes).
  const winnerBalances = winners.map(w => w.netCents);
  const loserBalances = losers.map(l => -l.netCents);

  while (winnerIdx < winners.length && loserIdx < losers.length) {
    const amountOwed = loserBalances[loserIdx];
    const amountToReceive = winnerBalances[winnerIdx];

    const settlementCents = Math.min(amountOwed, amountToReceive);

    if (settlementCents > 0) {
      transactions.push({
        from: losers[loserIdx].name,
        to: winners[winnerIdx].name,
        amount: settlementCents / 100
      });
    }

    loserBalances[loserIdx] -= settlementCents;
    winnerBalances[winnerIdx] -= settlementCents;

    if (loserBalances[loserIdx] === 0) loserIdx++;
    if (winnerBalances[winnerIdx] === 0) winnerIdx++;
  }

  return {
    transactions,
    effectiveRatio,
    discrepancy: chipDiscrepancy,
    playerStats: stats
  };
}
