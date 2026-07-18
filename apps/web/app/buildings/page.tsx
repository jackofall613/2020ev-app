'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ChangePassword from '../ChangePassword';
import ThemeToggle from '../ThemeToggle';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface Building {
  id: string;
  slug: string;
  name: string;
  plan: string;
  price_cents: number;
  billing_status: string;
  timezone: string;
  cp_station_id: string | null;
  has_cp_creds: boolean;
  resident_count: number;
  admin_count: number;
}

const STATUSES = ['trial', 'active', 'past_due', 'canceled'];
const STATUS_COLOR: Record<string, string> = {
  active: '#30D158', trial: '#0A84FF', past_due: '#FF9F0A', canceled: '#FF453A',
};

export default function BuildingsPage() {
  const router = useRouter();
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [mrr, setMrr] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add-building form
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [price, setPrice] = useState('199');
  const [adminEmail, setAdminEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState<{ name: string; url: string; token: string } | null>(null);

  const getToken = () => (typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null);

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

  useEffect(() => {
    if (!getToken()) { router.push('/login'); return; }
    try {
      const role = JSON.parse(localStorage.getItem('user') || '{}').role;
      if (role !== 'super_admin') { router.push('/dashboard'); return; }
    } catch { router.push('/login'); return; }
    load();
  }, []);

  const load = async () => {
    try {
      const r = await authFetch('/admin/buildings').then(x => x.json());
      if (!r.success) throw new Error(r.error);
      setBuildings(r.data.buildings || []);
      setMrr(r.data.mrr_cents || 0);
    } catch (e: any) {
      if (e.message !== 'Session expired') setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const createBuilding = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    setInvite(null);
    try {
      const r = await authFetch('/admin/buildings', {
        method: 'POST',
        body: JSON.stringify({
          name, slug,
          price_cents: Math.round((parseFloat(price) || 0) * 100),
          admin_email: adminEmail || undefined,
        }),
      }).then(x => x.json());
      if (!r.success) throw new Error(r.error);
      setInvite({ name: r.data.building.name, url: r.data.invite_url, token: r.data.invite_token });
      setName(''); setSlug(''); setAdminEmail(''); setPrice('199');
      await load();
    } catch (e: any) {
      setError(e.message || 'Failed to create building');
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (id: string, billing_status: string) => {
    try {
      const r = await authFetch(`/admin/buildings/${id}`, {
        method: 'PATCH', body: JSON.stringify({ billing_status }),
      }).then(x => x.json());
      if (!r.success) throw new Error(r.error);
      await load();
    } catch (e: any) {
      setError(e.message || 'Failed to update');
    }
  };

  const manage = (b: Building) => {
    localStorage.setItem('selectedBuildingId', b.id);
    router.push('/dashboard');
  };

  const viewAs = async (b: Building) => {
    if (!confirm(`Start a support "view-as" session for ${b.name}? This is logged and visible to the building's admin, and ends automatically in 30 minutes.`)) return;
    try {
      const r = await authFetch(`/admin/buildings/${b.id}/impersonate`, { method: 'POST', body: JSON.stringify({}) }).then(x => x.json());
      if (!r.success) throw new Error(r.error);
      // Preserve the super-admin session so we can restore it on exit.
      localStorage.setItem('superAdminToken', localStorage.getItem('accessToken') || '');
      localStorage.setItem('accessToken', r.data.token);
      localStorage.setItem('impersonation', JSON.stringify({ buildingName: b.name, expiresAt: r.data.expires_at }));
      localStorage.setItem('selectedBuildingId', b.id);
      router.push('/dashboard');
    } catch (e: any) {
      setError(e.message || 'Failed to start view-as session');
    }
  };

  const logout = () => { localStorage.clear(); router.push('/login'); };

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--page-fg)' }}>
      <span className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--page-fg)' }}>
      <header className="border-b border-white/8 sticky top-0 z-10" style={{ backgroundColor: 'var(--header-bg)' }}>
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <span className="font-bold text-white tracking-tight">2020EV</span>
            <span className="text-white/30 text-sm ml-1">Super-admin</span>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <ChangePassword />
            <button onClick={logout} className="text-white/40 hover:text-white/70 text-sm transition-colors">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Buildings</h1>
            <p className="text-white/40 text-sm mt-1">
              {buildings.length} building{buildings.length !== 1 ? 's' : ''} ·
              {' '}<span className="text-green-400">${(mrr / 100).toFixed(0)}/mo</span> recurring (active)
            </p>
          </div>
          <button onClick={() => { setShowAdd(v => !v); setInvite(null); }}
            className="bg-blue-600 hover:bg-blue-500 rounded-xl px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors">
            {showAdd ? 'Close' : '+ Add building'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-red-400 text-sm">{error}</div>
        )}

        {showAdd && (
          <div className="bg-white/4 border border-white/10 rounded-2xl p-6 space-y-4">
            <h2 className="font-semibold text-white">New building</h2>
            <form onSubmit={createBuilding} className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-white/50 uppercase tracking-wider">Building name</label>
                <input value={name} onChange={e => setName(e.target.value)} required
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-blue-500"
                  placeholder="Oceanview Condos" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-white/50 uppercase tracking-wider">Slug (URL id)</label>
                <input value={slug} onChange={e => setSlug(e.target.value)} required
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-blue-500"
                  placeholder="oceanview" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-white/50 uppercase tracking-wider">Price ($/mo)</label>
                <input value={price} onChange={e => setPrice(e.target.value)} type="number" min="0"
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-white/50 uppercase tracking-wider">Admin email (optional)</label>
                <input value={adminEmail} onChange={e => setAdminEmail(e.target.value)} type="email"
                  className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-blue-500"
                  placeholder="manager@building.com" />
              </div>
              <div className="sm:col-span-2">
                <button type="submit" disabled={creating}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors">
                  {creating ? 'Creating…' : 'Create + generate admin invite'}
                </button>
              </div>
            </form>
            {invite && (
              <div className="bg-green-500/10 border border-green-500/25 rounded-xl px-4 py-3 text-sm space-y-1">
                <p className="text-green-400 font-medium">✓ {invite.name} created — send this one-time admin invite:</p>
                <code className="block text-white/70 break-all bg-black/30 rounded-lg px-3 py-2 mt-1">{invite.url}</code>
                <p className="text-white/40 text-xs">The building admin registers with this link, then sets their ChargePoint credentials + rate.</p>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          {buildings.map(b => (
            <div key={b.id} className="bg-white/4 border border-white/10 rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: STATUS_COLOR[b.billing_status] || '#8E8E93' }} />
                <div className="min-w-0">
                  <div className="font-semibold text-white truncate">{b.name} <span className="text-white/30 font-normal text-sm">/{b.slug}</span></div>
                  <div className="text-white/40 text-xs mt-0.5">
                    {b.resident_count} resident{b.resident_count !== 1 ? 's' : ''} · {b.admin_count} admin{b.admin_count !== 1 ? 's' : ''}
                    {' · '}${(b.price_cents / 100).toFixed(0)}/mo
                    {' · '}{b.has_cp_creds ? '🔌 charger configured' : '⚠ no charger creds'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select value={b.billing_status} onChange={e => setStatus(b.id, e.target.value)}
                  className="bg-white/6 border border-white/12 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-blue-500">
                  {STATUSES.map(s => <option key={s} value={s} >{s.replace('_', ' ')}</option>)}
                </select>
                <button onClick={() => viewAs(b)}
                  className="bg-white/8 hover:bg-white/12 border border-white/12 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors">
                  View as
                </button>
                <button onClick={() => manage(b)}
                  className="bg-white/8 hover:bg-white/12 border border-white/12 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors">
                  Manage →
                </button>
              </div>
            </div>
          ))}
          {buildings.length === 0 && (
            <p className="text-white/40 text-sm text-center py-8">No buildings yet. Add your first one.</p>
          )}
        </div>
      </main>
    </div>
  );
}
