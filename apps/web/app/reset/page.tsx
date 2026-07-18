'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Public password-reset page, used by BOTH the admin portal and mobile-app
 *  residents (the app links here). Two modes:
 *  - no ?token → ask for an email, POST /auth/forgot-password
 *  - ?token=… (from the email link) → set a new password, POST /auth/reset-password */
function ResetForm() {
  const token = useSearchParams().get('token') || '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    if (token) {
      if (password.length < 12) return setError('Password must be at least 12 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/${token ? 'reset-password' : 'forgot-password'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token ? { token, new_password: password } : { email }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Something went wrong');
      setMessage(data.data?.message || 'Done.');
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--page-fg)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600/15 border border-blue-500/25 text-3xl mb-4">
            🔑
          </div>
          <h1 className="text-2xl font-bold text-white">{token ? 'Set a new password' : 'Reset your password'}</h1>
          <p className="text-white/40 text-sm mt-1">
            {token ? 'Minimum 12 characters.' : "Enter your account email and we'll send a reset link."}
          </p>
        </div>

        <div className="bg-white/4 border border-white/10 rounded-2xl p-7 space-y-4 shadow-xl shadow-black/20">
          {error && (
            <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-red-400 text-sm">⚠ {error}</div>
          )}
          {message ? (
            <div className="space-y-4">
              <div className="bg-emerald-500/8 border border-emerald-500/25 rounded-xl px-4 py-3 text-emerald-400 text-sm">
                ✓ {message}
              </div>
              <a href="/login" className="block text-center text-sm text-blue-400 hover:text-blue-300">
                Back to sign in
              </a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {token ? (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-white/50 uppercase tracking-wider">New password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500 focus:bg-white/8 transition-colors"
                      placeholder="At least 12 characters"
                      required
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-white/50 uppercase tracking-wider">Confirm password</label>
                    <input
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500 focus:bg-white/8 transition-colors"
                      placeholder="Same password again"
                      required
                      autoComplete="new-password"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-white/50 uppercase tracking-wider">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500 focus:bg-white/8 transition-colors"
                    placeholder="you@email.com"
                    required
                    autoComplete="email"
                  />
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl py-2.5 text-sm font-semibold text-on-accent transition-colors mt-2 shadow-lg shadow-blue-600/20"
              >
                {loading ? 'Working…' : token ? 'Set new password' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-white/25 text-xs mt-6">
          <a href="/login" className="hover:text-white/50 transition-colors">← Back to sign in</a>
        </p>
      </div>
    </div>
  );
}

export default function ResetPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
