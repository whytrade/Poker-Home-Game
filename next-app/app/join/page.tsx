'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { database } from '../lib/firebase';
import { ref, get, onValue } from 'firebase/database';
import Link from 'next/link';
import { Player } from '../types';
import { normalizePlayers, mutateGameState } from '../utils/helpers';

function JoinContent() {
  const searchParams = useSearchParams();
  
  // States
  const [view, setView] = useState<'JOIN' | 'DASHBOARD'>('JOIN');
  const [gameId, setGameId] = useState('');
  
  // Dashboard State
  const [activePlayerName, setActivePlayerName] = useState('');
  const [playerStats, setPlayerStats] = useState<{initial: number, current: number} | null>(null);

  // Form State
  const [playerNameInput, setPlayerNameInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRebuyMode, setIsRebuyMode] = useState(false);

  // 1. Initialize from URL and LocalStorage
  useEffect(() => {
    const urlGameId = searchParams.get('gameId');
    if (urlGameId) setGameId(urlGameId);

    const storedGameId = localStorage.getItem('playerGameId');
    const storedName = localStorage.getItem('playerName');

    // If URL has a DIFFERENT game ID, ignore storage for that session logic
    // But if no URL, or URL matches storage, try to restore session
    if (storedGameId && storedName) {
        if (!urlGameId || urlGameId === storedGameId) {
            setGameId(storedGameId);
            setActivePlayerName(storedName);
            setView('DASHBOARD');
        }
    }
  }, [searchParams]);

  // 2. Listen to Player Stats when in Dashboard mode
  useEffect(() => {
    if (view === 'DASHBOARD' && gameId && activePlayerName) {
        const gameRef = ref(database, `games/${gameId}/state/players`);
        const unsubscribe = onValue(gameRef, (snapshot) => {
            const playerList = normalizePlayers(snapshot.val());
            if (playerList.length > 0) {
                const me = playerList.find((p) => p.name.trim().toLowerCase() === activePlayerName.trim().toLowerCase());
                if (me) {
                    setPlayerStats({
                        initial: me.initialChips,
                        current: me.currentChips
                    });
                } else {
                    // Player kicked or game reset?
                    // Optional: Kick back to join screen
                }
            }
        });
        return () => unsubscribe();
    }
  }, [view, gameId, activePlayerName]);

  const handleTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const buyInAmount = parseFloat(amountInput);
    const nameToUse = view === 'DASHBOARD' ? activePlayerName : playerNameInput;

    if (!gameId || !nameToUse || isNaN(buyInAmount) || buyInAmount <= 0) {
      setError("Please check all fields.");
      setLoading(false);
      return;
    }

    try {
      // Check Game
      const gameRef = ref(database, `games/${gameId}`);
      const gameSnapshot = await get(gameRef);
      if (!gameSnapshot.exists()) throw new Error("Game not found.");
      
      const gameData = gameSnapshot.val();
      if (!gameData.active) throw new Error("Game is closed.");

      const ratio = gameData.ratio || 1.0;
      const chips = Math.floor(buyInAmount / ratio);

      // Run Transaction
      const normalizedName = nameToUse.trim().toLowerCase();
      await mutateGameState(gameId, (draft) => {
        const existing = draft.players.find(
          (p) => p.name.trim().toLowerCase() === normalizedName
        );

        if (existing) {
            // Rebuy: update only the matched player, preserve everyone else.
            return {
                players: draft.players.map((p) =>
                    p.id === existing.id
                        ? {
                              ...p,
                              initialChips: (p.initialChips || 0) + chips,
                              currentChips: (p.currentChips || 0) + chips,
                              lastBuyIn: Date.now(),
                          }
                        : p
                ),
                nextPlayerId: draft.nextPlayerId,
            };
        }

        // Join: append a new player.
        const newPlayer = {
            id: `p${draft.nextPlayerId}`,
            name: nameToUse.trim(),
            initialChips: chips,
            currentChips: chips,
            active: true,
            joinedAt: Date.now(),
        } as Player;

        return {
            players: [...draft.players, newPlayer],
            nextPlayerId: draft.nextPlayerId + 1,
        };
      });

      // Success
      if (view === 'JOIN') {
          localStorage.setItem('playerGameId', gameId);
          localStorage.setItem('playerName', nameToUse.trim());
          setActivePlayerName(nameToUse.trim());
          setView('DASHBOARD');
      }

      setAmountInput('');
      setIsRebuyMode(false);
      alert(`Success! Added ${chips} chips.`);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Transaction failed.");
    } finally {
      setLoading(false);
    }
  };

  // --- VIEW: JOIN FORM ---
  if (view === 'JOIN') {
      return (
        <div className="min-h-screen bg-slate-950 text-white p-4 flex items-center justify-center">
        <div className="w-full max-w-md bg-slate-900 p-8 rounded-xl shadow-xl border border-slate-800">
            <Link href="/" className="text-sm text-slate-500 hover:text-white mb-4 block">← Back</Link>
            <h1 className="text-2xl font-bold mb-6 text-center">Join Game</h1>
            
            {error && <div className="mb-4 p-3 bg-red-900/50 border border-red-800 rounded-lg text-red-200 text-sm">{error}</div>}

            <form onSubmit={handleTransaction} className="space-y-4">
            <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Game ID</label>
                <input 
                type="text" 
                value={gameId}
                onChange={(e) => setGameId(e.target.value)}
                className="w-full bg-slate-800 border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono"
                placeholder="ABCD"
                required
                />
            </div>

            <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Your Name</label>
                <input 
                type="text" 
                value={playerNameInput}
                onChange={(e) => setPlayerNameInput(e.target.value)}
                className="w-full bg-slate-800 border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="John Doe"
                required
                />
            </div>

            <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Buy-in Amount ($)</label>
                <input 
                type="number" 
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="w-full bg-slate-800 border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="20.00"
                min="1"
                step="0.01"
                required
                />
            </div>

            <button 
                type="submit" 
                disabled={loading}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 rounded-lg font-bold transition-colors disabled:opacity-50"
            >
                {loading ? 'Joining...' : 'Buy In'}
            </button>
            </form>
        </div>
        </div>
      );
  }

  // --- VIEW: PLAYER DASHBOARD ---
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 flex items-center justify-center">
      <div className="w-full max-w-md bg-slate-900 p-6 rounded-2xl shadow-xl border border-slate-800 relative overflow-hidden">
        
        {/* Background Decoration */}
        <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
            <span className="text-9xl font-bold">♠</span>
        </div>

        <div className="relative z-10">
            <div className="flex justify-between items-start mb-8">
                <div>
                    <h2 className="text-2xl font-bold">{activePlayerName}</h2>
                    <p className="text-slate-400 text-sm">Game ID: <span className="font-mono text-white">{gameId}</span></p>
                </div>
                <button 
                    onClick={() => {
                        localStorage.removeItem('playerGameId');
                        localStorage.removeItem('playerName');
                        setView('JOIN');
                        setPlayerNameInput('');
                    }}
                    className="text-xs text-slate-500 hover:text-red-400"
                >
                    Leave
                </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-8">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Bought In</p>
                    <p className="text-2xl font-mono text-white">{playerStats?.initial || 0}</p>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Current</p>
                    <p className="text-2xl font-mono text-blue-400">{playerStats?.current || 0}</p>
                </div>
            </div>

            {!isRebuyMode ? (
                <button 
                    onClick={() => setIsRebuyMode(true)}
                    className="w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 rounded-xl font-bold text-lg shadow-lg shadow-blue-900/20 transition-all"
                >
                    Rebuy Chips
                </button>
            ) : (
                <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 animate-in fade-in slide-in-from-bottom-2">
                    <h3 className="font-bold mb-3">Rebuy Amount</h3>
                    <form onSubmit={handleTransaction} className="space-y-3">
                        <input 
                            type="number" 
                            value={amountInput}
                            onChange={(e) => setAmountInput(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-600 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="Amount ($)"
                            autoFocus
                        />
                        <div className="flex gap-2">
                            <button 
                                type="button"
                                onClick={() => setIsRebuyMode(false)}
                                className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium"
                            >
                                Cancel
                            </button>
                            <button 
                                type="submit"
                                disabled={loading}
                                className="flex-1 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-bold"
                            >
                                {loading ? '...' : 'Confirm'}
                            </button>
                        </div>
                    </form>
                </div>
            )}
            
            <p className="mt-6 text-center text-xs text-slate-500">
                Waiting for the game to finish? Check the host screen for updates.
            </p>
        </div>
      </div>
    </div>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950 flex items-center justify-center text-white">Loading...</div>}>
      <JoinContent />
    </Suspense>
  );
}
