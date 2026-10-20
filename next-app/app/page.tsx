import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-2">
          <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-orange-500">
            Poker Home Game
          </h1>
          <p className="text-lg text-slate-400">
            Manage your game, track chips, and calculate payouts effortlessly.
          </p>
        </div>

        <div className="grid gap-4">
          <Link 
            href="/host"
            className="w-full py-4 px-6 text-xl font-bold rounded-xl bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 transition-all shadow-lg shadow-red-900/20"
          >
            Host a Game
          </Link>
          
          <Link 
            href="/join"
            className="w-full py-4 px-6 text-xl font-bold rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-all"
          >
            Join a Game
          </Link>
        </div>
      </div>
    </div>
  );
}
