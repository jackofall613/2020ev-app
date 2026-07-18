'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Header control + modal for changing the signed-in admin's password.
 * Shared by the super-admin /buildings header and the building-admin /dashboard
 * header. The API invalidates all refresh tokens and returns a fresh pair, which
 * we swap into localStorage so the current session keeps working.
 */
export default function ChangePassword({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const reset = () => {
    setCurrent(''); setNext(''); setConfirm(''); setError(''); setSaving(false); setDone(false);
  };
  const close = () => { setOpen(false); reset(); };

  const getToken = () => (typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null);

  // Refresh-on-401 so an expired access token doesn't masquerade as a wrong password
  // (the API returns 400 — not 401 — for an incorrect current password).
  const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const makeReq = (token: string) =>
      fetch(`${API_URL}${url}`, {
        ...options,
        headers: { ...options.headers, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
    let res = await makeReq(getToken() ?? '');
    if (res.status === 401) {
      const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
      if (refreshToken) {
        const rr = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
        });
        const rd = await rr.json();
        if (rd.success) {
          localStorage.setItem('accessToken', rd.data.accessToken);
          localStorage.setItem('refreshToken', rd.data.refreshToken);
          res = await makeReq(rd.data.accessToken);
        } else { localStorage.clear(); router.push('/login'); throw new Error('Session expired'); }
      } else { localStorage.clear(); router.push('/login'); throw new Error('Session expired'); }
    }
    return res;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 12) { setError('New password must be at least 12 characters'); return; }
    if (next !== confirm) { setError('New passwords do not match'); return; }
    if (next === current) { setError('New password must be different from the current one'); return; }
    setSaving(true);
    try {
      const r = await authFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      }).then(x => x.json());
      if (!r.success) throw new Error(r.error || 'Failed to change password');
      // Swap in the freshly-minted tokens so this session survives the invalidation.
      localStorage.setItem('accessToken', r.data.accessToken);
      localStorage.setItem('refreshToken', r.data.refreshToken);
      setDone(true);
      setTimeout(close, 1400);
    } catch (err: any) {
      if (err.message !== 'Session expired') setError(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={className || 'text-white/40 hover:text-white/70 text-sm transition-colors'}
      >
        Change password
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'var(--overlay)' }} onClick={close}>
          <div className="w-full max-w-sm border border-white/10 rounded-2xl p-6 shadow-2xl" style={{ backgroundColor: 'var(--modal-bg)' }} onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-white text-lg">Change password</h2>
            <p className="text-white/40 text-xs mt-1">Signs you out of all other devices.</p>

            {done ? (
              <div className="mt-5 bg-green-500/10 border border-green-500/25 rounded-xl px-4 py-3 text-green-400 text-sm">
                ✓ Password updated
              </div>
            ) : (
              <form onSubmit={submit} className="mt-4 space-y-3">
                {error && (
                  <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-2.5 text-red-400 text-sm">{error}</div>
                )}
                <input
                  type="password" value={current} onChange={e => setCurrent(e.target.value)} required
                  autoComplete="current-password" placeholder="Current password"
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500"
                />
                <input
                  type="password" value={next} onChange={e => setNext(e.target.value)} required
                  autoComplete="new-password" placeholder="New password (min 12 chars)"
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500"
                />
                <input
                  type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                  autoComplete="new-password" placeholder="Confirm new password"
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500"
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button type="button" onClick={close}
                    className="text-white/50 hover:text-white/80 text-sm px-3 py-2 transition-colors">Cancel</button>
                  <button type="submit" disabled={saving}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl px-4 py-2 text-sm font-semibold text-on-accent transition-colors">
                    {saving ? 'Saving…' : 'Update password'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
