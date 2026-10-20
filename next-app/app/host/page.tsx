'use client';

import { useState, useEffect } from 'react';
import { database } from '../lib/firebase';
import { ref, set, onValue, update, get } from 'firebase/database'; // Import get
import { Player, PayoutResult } from '../types';
import { calculatePayouts } from '../utils/payouts';
import { generateShortGameId, calculateTotals, normalizePlayers, mutateGameState } from '../utils/helpers'; // Import helpers
import QRCode from 'react-qr-code';
import { Copy, Info, Users, DollarSign, Calculator, RefreshCw, LogOut } from 'lucide-react';

export default function HostPage() {
  // Game State
  const [gameId, setGameId] = useState<string | null>(null);
  const [gameName, setGameName] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [gameRatio, setGameRatio] = useState<number>(1.0);
  const [payouts, setPayouts] = useState<PayoutResult | null>(null);
  const [chipDrafts, setChipDrafts] = useState<Record<string, string>>({});
  
  // UI State
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Forms
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerChips, setNewPlayerChips] = useState('');
  const [ratioMoney, setRatioMoney] = useState('');
  const [ratioChips, setRatioChips] = useState('');

  // Computed
  const { totalStarting, totalCurrent, discrepancy } = calculateTotals(players);

  // Load game ID on mount
  useEffect(() => {
    const storedGameId = localStorage.getItem('hostGameId');
    if (storedGameId) setGameId(storedGameId);
  }, []);

  // Listen to Firebase Data
  useEffect(() => {
    if (!gameId) return;

    const gameRef = ref(database, `games/${gameId}`);
    const unsubscribe = onValue(gameRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setGameName(data.name || 'Poker Game');
        setGameRatio(data.ratio || 1.0);
        
        setPlayers(normalizePlayers(data.state?.players));
      } else {
        // Game might have been deleted
        setGameId(null);
        localStorage.removeItem('hostGameId');
      }
    });

    return () => unsubscribe();
  }, [gameId]);

  const createGame = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Generate unique short ID
      let newGameId = generateShortGameId();
      let retries = 5;
      while (retries > 0) {
        const snapshot = await get(ref(database, `games/${newGameId}`));
        if (!snapshot.exists()) break;
        newGameId = generateShortGameId();
        retries--;
      }

      const newGameRef = ref(database, `games/${newGameId}`);
      
      await set(newGameRef, {
        name: gameName,
        active: true,
        ratio: 1.0,
        created: Date.now(),
        state: { players: [], nextPlayerId: 1 }
      });
      setGameId(newGameId);
      localStorage.setItem('hostGameId', newGameId);
      
    } catch (error) {
      console.error(error);
      alert("Failed to create game");
    } finally {
      setLoading(false);
    }
  };

  const handleAddPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gameId || !newPlayerName || !newPlayerChips) return;

    try {
      const chips = parseInt(newPlayerChips);
      if (isNaN(chips) || chips < 0) return;

      await mutateGameState(gameId, (draft) => {
        const newPlayer: Player = {
          id: `p${draft.nextPlayerId}`,
          name: newPlayerName,
          initialChips: chips,
          currentChips: chips,
          active: true,
          isHost: true // Manually added players are marked
        };
        return {
          players: [...draft.players, newPlayer],
          nextPlayerId: draft.nextPlayerId + 1,
        };
      });

      setNewPlayerName('');
      setNewPlayerChips('');
    } catch (error) {
      console.error("Error adding player:", error);
      alert("Failed to add player.");
    }
  };

  const handleSetRatio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gameId) return;
    
    const money = parseFloat(ratioMoney);
    const chips = parseFloat(ratioChips);

    if (isNaN(money) || isNaN(chips) || chips === 0) {
      alert("Please enter valid numbers");
      return;
    }

    const newRatio = money / chips;
    
    await update(ref(database, `games/${gameId}`), {
      ratio: newRatio
    });
    
    setRatioMoney('');
    setRatioChips('');
  };

  const commitChips = async (playerId: string) => {
    if (!gameId) return;

    const raw = chipDrafts[playerId];
    // Nothing typed for this player — nothing to commit.
    if (raw === undefined) return;

    const clearDraft = () =>
      setChipDrafts(prev => {
        const next = { ...prev };
        delete next[playerId];
        return next;
      });

    const trimmed = raw.trim();
    // Invalid / empty / non-integer / negative: discard, snap back to server value.
    if (!/^\d+$/.test(trimmed)) {
      clearDraft();
      return;
    }

    const amount = parseInt(trimmed, 10);
    const current = players.find(p => p.id === playerId);
    if (!current || current.currentChips === amount) {
      clearDraft();
      return;
    }

    try {
      await mutateGameState(gameId, (draft) => ({
        players: draft.players.map(p =>
          p.id === playerId ? { ...p, currentChips: amount } : p
        ),
        nextPlayerId: draft.nextPlayerId,
      }));
    } catch (error) {
      console.error("Failed to update chips:", error);
    } finally {
      clearDraft();
    }
  };

  const calculate = () => {
    if (players.length < 2) {
      alert("Need at least 2 players");
      return;
    }
    const res = calculatePayouts(players, gameRatio);
    setPayouts(res);
  };

  const resetGame = async () => {
    if (!gameId) return;
    if (confirm("Are you sure you want to reset all chip counts? Game ID will be preserved.")) {
       try {
           await mutateGameState(gameId, (draft) => ({
               players: draft.players.map(p => ({
                   ...p,
                   currentChips: p.initialChips,
               })),
               nextPlayerId: draft.nextPlayerId,
           }));
           await update(ref(database, `games/${gameId}`), { payoutsFinalized: false });
           setPayouts(null);
       } catch(e) {
           console.error("Reset failed", e);
           alert("Failed to reset game on server.");
       }
    }
  };

  const copyJoinLink = () => {
    if (!gameId) return;
    const url = `${window.location.origin}/join?gameId=${gameId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // --- RENDER: NO GAME ID ---
  if (!gameId) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Host New Game</h1>
            <p className="text-slate-400">Create a lobby to start tracking chips</p>
          </div>
          <form onSubmit={createGame} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-2">Game Name</label>
              <input 
                type="text" 
                value={gameName} 
                onChange={e => setGameName(e.target.value)}
                placeholder="Friday Night Poker"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                required
              />
            </div>
            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg shadow-blue-900/20 disabled:opacity-50"
            >
              {loading ? 'Creating Lobby...' : 'Create Lobby'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- RENDER: DASHBOARD ---
  const joinUrl = typeof window !== 'undefined' ? `${window.location.origin}/join?gameId=${gameId}` : '';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 lg:p-6 font-sans">
      <header className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-3">
           <h1 className="text-2xl font-bold text-white tracking-tight">Kapoker</h1>
        </div>
        <div className="flex items-center gap-3 bg-slate-900/50 p-2 rounded-lg border border-slate-800/50">
           <span className="text-sm text-slate-400 px-2">Game ID: <span className="text-white font-mono font-bold tracking-widest text-lg">{gameId}</span></span>
           <button 
             onClick={() => {
                if(confirm("Exit game? ID will be lost if not saved.")) {
                  setGameId(null);
                  localStorage.removeItem('hostGameId');
                }
             }}
             className="p-2 hover:bg-slate-800 rounded-md text-slate-400 hover:text-red-400 transition-colors"
             title="Exit Game"
           >
             <LogOut size={18} />
           </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* LEFT COLUMN: LOBBY & ADD PLAYER */}
        <div className="lg:col-span-3 space-y-6">
          {/* Game Lobby Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center">
              <h2 className="font-bold text-white">Game Lobby</h2>
              <span className="flex h-3 w-3 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
              </span>
            </div>
            <div className="p-6 flex flex-col items-center space-y-4">
              <div className="bg-white p-4 rounded-xl">
                 <QRCode value={joinUrl} size={140} />
              </div>
              <div className="text-center w-full">
                <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider font-semibold">Join Link</p>
                <div 
                  onClick={copyJoinLink}
                  className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex items-center justify-between cursor-pointer hover:border-slate-700 group transition-all"
                >
                  <span className="text-xs text-blue-400 truncate max-w-[150px]">{joinUrl}</span>
                  {copied ? <span className="text-green-500 text-xs font-bold">Copied!</span> : <Copy size={14} className="text-slate-500 group-hover:text-white" />}
                </div>
              </div>
            </div>
          </div>

          {/* Add Player Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-800">
              <h2 className="font-bold text-white">Add Player</h2>
            </div>
            <div className="p-4 space-y-4">
              <div className="bg-blue-900/20 border border-blue-900/50 rounded-lg p-3 flex gap-3">
                <Info className="text-blue-400 shrink-0" size={18} />
                <p className="text-xs text-blue-200/80 leading-relaxed">
                  Players can join automatically via QR code. Use this for manual entry.
                </p>
              </div>
              <form onSubmit={handleAddPlayer} className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase">Player Name</label>
                  <input 
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-white focus:ring-1 focus:ring-blue-500 outline-none mt-1"
                    placeholder="Enter name"
                    value={newPlayerName}
                    onChange={e => setNewPlayerName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase">Initial Chips</label>
                  <input 
                    type="number"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-white focus:ring-1 focus:ring-blue-500 outline-none mt-1"
                    placeholder="0"
                    value={newPlayerChips}
                    onChange={e => setNewPlayerChips(e.target.value)}
                  />
                </div>
                <button 
                  type="submit"
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-2.5 rounded-lg transition-colors"
                >
                  Add Player
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* CENTER COLUMN: PLAYER LIST */}
        <div className="lg:col-span-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm h-full flex flex-col">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900 sticky top-0 z-10">
              <h2 className="font-bold text-white flex items-center gap-2">
                Players <span className="bg-slate-800 text-xs px-2 py-0.5 rounded-full text-slate-300">{players.length}</span>
              </h2>
            </div>
            
            <div className="flex-1 overflow-auto min-h-[400px]">
              {players.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-3 p-8">
                  <Users size={48} className="text-slate-700" />
                  <p className="font-medium">No players added yet</p>
                  <p className="text-sm">Scan the QR code or add manually to start.</p>
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-950/50 text-xs uppercase text-slate-500 font-semibold sticky top-0">
                    <tr>
                      <th className="p-4">Player</th>
                      <th className="p-4 text-right">Starting</th>
                      <th className="p-4 text-right">Current</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {players.map(player => (
                      <tr key={player.id} className="hover:bg-slate-800/30 transition-colors group">
                        <td className="p-4">
                          <div className="font-medium text-white">{player.name}</div>
                          {player.isHost && <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">Manual</span>}
                        </td>
                        <td className="p-4 text-right font-mono text-slate-400">
                          {player.initialChips}
                        </td>
                        <td className="p-4 text-right">
                          <input
                            type="number"
                            className="bg-transparent text-right font-mono font-bold text-white w-20 focus:bg-slate-800 focus:ring-1 focus:ring-blue-500 rounded px-1 outline-none transition-all"
                            value={chipDrafts[player.id] ?? String(player.currentChips)}
                            onChange={(e) => setChipDrafts(prev => ({ ...prev, [player.id]: e.target.value }))}
                            onBlur={() => commitChips(player.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-950/50 sticky bottom-0 border-t border-slate-800 font-bold text-sm">
                    <tr>
                        <td className="p-4 text-slate-400 uppercase text-xs">Totals</td>
                        <td className="p-4 text-right text-blue-300">{totalStarting}</td>
                        <td className={`p-4 text-right ${discrepancy !== 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                            {totalCurrent}
                            {discrepancy !== 0 && (
                                <span className="block text-[10px] text-yellow-500/80 font-normal">
                                    {discrepancy > 0 ? '+' : ''}{discrepancy}
                                </span>
                            )}
                        </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: CONTROLS & PAYOUTS */}
        <div className="lg:col-span-3 space-y-6">
          
          {/* Game Controls */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-800">
              <h2 className="font-bold text-white">Game Controls</h2>
            </div>
            <div className="p-4 space-y-4">
              <form onSubmit={handleSetRatio} className="space-y-3">
                <div>
                   <label className="text-xs font-semibold text-slate-500 uppercase">Money Amount ($)</label>
                   <div className="relative mt-1">
                     <DollarSign size={14} className="absolute left-3 top-3 text-slate-500" />
                     <input 
                       className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2.5 text-sm text-white focus:ring-1 focus:ring-blue-500 outline-none"
                       placeholder="20.00"
                       type="number"
                       step="0.01"
                       value={ratioMoney}
                       onChange={e => setRatioMoney(e.target.value)}
                     />
                   </div>
                </div>
                <div>
                   <label className="text-xs font-semibold text-slate-500 uppercase">Chip Amount</label>
                   <input 
                       className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-sm text-white focus:ring-1 focus:ring-blue-500 outline-none mt-1"
                       placeholder="1000"
                       type="number"
                       value={ratioChips}
                       onChange={e => setRatioChips(e.target.value)}
                   />
                </div>
                <button 
                  type="submit"
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-2.5 rounded-lg transition-colors"
                >
                  Set Ratio
                </button>
              </form>

              <div className="bg-slate-950 rounded-lg p-3 flex items-center justify-between border border-slate-800">
                 <span className="text-xs text-slate-400">Current Ratio</span>
                 <span className="text-sm font-bold text-white">1 Chip = ${(gameRatio).toFixed(2)}</span>
              </div>

              <button 
                 onClick={resetGame}
                 className="w-full border border-slate-700 hover:bg-slate-800 text-slate-300 text-sm font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <RefreshCw size={14} /> Reset Game
              </button>
            </div>
          </div>

          {/* Payout Calculator */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-800">
              <h2 className="font-bold text-white">Payout Calculator</h2>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-xs text-slate-400 leading-relaxed">
                Calculate optimal payouts based on final chip counts. Update the "Current" column in the player list first.
              </p>
              
              {!payouts ? (
                 <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-center">
                    <p className="text-sm text-slate-500">No payouts calculated yet</p>
                 </div>
              ) : (
                 <div className="bg-slate-950 border border-slate-800 rounded-lg p-0 overflow-hidden">
                    {payouts.transactions.length === 0 ? (
                       <div className="p-4 text-center text-green-400 text-sm font-medium">Everyone is even!</div>
                    ) : (
                       <div className="divide-y divide-slate-800">
                          {payouts.transactions.map((t, idx) => (
                             <div key={idx} className="p-3 flex justify-between items-center text-sm">
                                <div className="flex flex-col">
                                   <span className="text-red-400 font-bold">{t.from}</span>
                                   <span className="text-[10px] text-slate-500 uppercase">Pays</span>
                                </div>
                                <div className="flex flex-col text-right">
                                   <span className="text-green-400 font-bold">{t.to}</span>
                                   <span className="text-white font-mono font-bold">${t.amount.toFixed(2)}</span>
                                </div>
                             </div>
                          ))}
                       </div>
                    )}
                 </div>
              )}

              <button 
                onClick={calculate}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-3 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20"
              >
                 <Calculator size={16} /> Calculate Payouts
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
