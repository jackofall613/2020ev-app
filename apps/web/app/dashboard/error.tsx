'use client';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0A0F1E', color: '#f1f5f9' }}>
      <div className="max-w-lg w-full mx-4 space-y-4">
        <div className="bg-red-500/10 border border-red-500/25 rounded-2xl p-6">
          <p className="text-red-400 font-semibold text-sm mb-1">Dashboard error</p>
          <p className="text-white/60 text-xs font-mono break-all">{error.message || 'Unknown error'}</p>
          {error.digest && (
            <p className="text-white/30 text-xs mt-1">digest: {error.digest}</p>
          )}
        </div>
        <button
          onClick={reset}
          className="w-full bg-blue-600 hover:bg-blue-500 rounded-xl py-2.5 text-sm font-semibold transition-colors"
        >
          Try again
        </button>
        <p className="text-white/20 text-xs text-center">
          If this keeps happening, send a screenshot of the error above.
        </p>
      </div>
    </div>
  );
}
