'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ChangePassword from '../ChangePassword';
import ThemeToggle from '../ThemeToggle';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface User {
  id: string;
  name: string;
  email?: string;
  role: string;
  priority_day: string | null;
  unit_number?: string;
  balance_cents?: number;
}

interface ReportImport {
  id: string;
  source: string;
  filename: string | null;
  processed_at: string;
  rows_total: number;
  rows_matched: number;
  total_deducted_cents: number;
}

interface CPDriver {
  id: string;
  driver_name: string;
  driver_account_number: string;
  status: 'pending' | 'mapped';
  is_ignored: boolean;
  user_id: string | null;
  mapped_user_name: string | null;
  last_seen_at: string;
}

interface Session {
  id: string;
  user_name: string;
  type: string;
  status: string;
  started_at: string;
  estimated_end: string;
  actual_end?: string;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

const DAY_SHORT: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri',
};

const TYPE_LABEL: Record<string, string> = {
  top_up: 'Top-up', normal: 'Normal', long: 'Long',
};

function getInitials(name: string) {
  const parts = name.trim().split(' ');
  return parts.length === 1
    ? parts[0][0].toUpperCase()
    : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = ['#5E5CE6','#0A84FF','#30D158','#FF9F0A','#FF453A','#AC8E68'];
function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function elapsed(d: string) {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${m%60}m`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteResult, setInviteResult] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savingDay, setSavingDay] = useState<string | null>(null);
  // Rules management — pre-seeded with defaults so Save works before fetch completes
  const DEFAULT_RULES = [
    { icon: '⏱', text: 'Soft target: 2–4 hours' },
    { icon: '🔴', text: 'Hard cap: 6 hours max' },
    { icon: '📋', text: 'Announce in feed when plugging in' },
    { icon: '🚗', text: 'Move car promptly when done' },
  ];
  const [rules, setRules] = useState<{icon: string; text: string}[]>(DEFAULT_RULES);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  // Wallet
  const [walletUsers, setWalletUsers] = useState<User[]>([]);
  const [creditingUser, setCreditingUser] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState('1000');
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditSuccess, setCreditSuccess] = useState<string | null>(null);
  const [deductSuccess, setDeductSuccess] = useState<string | null>(null);
  // Report import
  const [reportCsv, setReportCsv] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportResult, setReportResult] = useState<{ rows_total: number; rows_matched: number; rows_unmatched: number; rows_already_billed: number; total_deducted_cents: number } | null>(null);
  const [reportError, setReportError] = useState('');
  const [reportHistory, setReportHistory] = useState<ReportImport[]>([]);
  // Driver mapping
  const [drivers, setDrivers] = useState<CPDriver[]>([]);
  const [driverMapping, setDriverMapping] = useState<Record<string, string>>({});
  const [mappingLoading, setMappingLoading] = useState<string | null>(null);
  const [placeholderLoading, setPlaceholderLoading] = useState<string | null>(null);
  const [clearBillingLoading, setClearBillingLoading] = useState<string | null>(null);
  const [ignoreLoading, setIgnoreLoading] = useState<string | null>(null);
  const [unmapLoading, setUnmapLoading] = useState<string | null>(null);
  // Settings
  const [rateCents, setRateCents] = useState<number | null>(null);
  const [rateInput, setRateInput] = useState('');
  const [rateSaving, setRateSaving] = useState(false);
  const [rateSaved, setRateSaved] = useState(false);
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null);
  const [idleFeeCents, setIdleFeeCents] = useState<number | null>(null);
  const [idleGraceMin, setIdleGraceMin] = useState<number | null>(null);
  const [idleFeeInput, setIdleFeeInput] = useState('');
  const [idleGraceInput, setIdleGraceInput] = useState('');
  const [idleFeeSaving, setIdleFeeSaving] = useState(false);
  const [idleFeeSaved, setIdleFeeSaved] = useState(false);
  // Billing activity
  const [billingActivity, setBillingActivity] = useState<Array<{
    id: string; user_name: string; amount_cents: number; kwh: number;
    rate_cents_per_kwh: number | null; description: string;
    chargepoint_session_id: string | null; created_at: string;
  }>>([]);
  // Monthly statement
  interface StatementRow {
    user_id: string; name: string; unit_number: string | null;
    sessions: number; total_kwh: number; billed_cents: number; balance_cents: number;
  }
  interface Statement {
    month: string; generated_at: string; rate_cents_per_kwh: number;
    totals: { residents: number; sessions: number; total_kwh: number; recovered_cents: number };
    rows: StatementRow[];
  }
  const thisMonth = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const [statementMonth, setStatementMonth] = useState(thisMonth);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryError, setAiSummaryError] = useState<string | null>(null);
  // Board insights
  interface Insights {
    trend: { month: string; sessions: number; kwh: number; recovered_cents: number }[];
    top_residents: { name: string; sessions: number; kwh: number; recovered_cents: number }[];
    totals: { sessions: number; kwh: number; recovered_cents: number; residents: number };
  }
  const [insights, setInsights] = useState<Insights | null>(null);
  const [building, setBuilding] = useState<{ id: string; name: string; billing_status: string } | null>(null);
  const [impersonation, setImpersonation] = useState<{ buildingName: string; expiresAt: string } | null>(null);
  const [impRemaining, setImpRemaining] = useState('');
  const [accessLog, setAccessLog] = useState<{ id: string; action: string; created_at: string; operator_name: string | null }[]>([]);
  const isSuperAdmin = typeof window !== 'undefined' && (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'super_admin'; } catch { return false; }
  })();

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const makeReq = (token: string) => {
      // Super-admin "manage building X" selection — building admins never set this,
      // and the server only honors X-Building-Id for super_admins.
      const sel = typeof window !== 'undefined' ? localStorage.getItem('selectedBuildingId') : null;
      return fetch(`${API_URL}${url}`, {
        ...options,
        headers: {
          ...options.headers,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(sel ? { 'X-Building-Id': sel } : {}),
        },
      });
    };

    let res = await makeReq(getToken() ?? '');

    if (res.status === 401) {
      // Access token expired — try to refresh silently
      const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
      if (refreshToken) {
        try {
          const rr = await fetch(`${API_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          });
          const rd = await rr.json();
          if (rd.success) {
            localStorage.setItem('accessToken', rd.data.accessToken);
            localStorage.setItem('refreshToken', rd.data.refreshToken);
            res = await makeReq(rd.data.accessToken);
          } else {
            localStorage.clear();
            router.push('/login');
            throw new Error('Session expired');
          }
        } catch (e: any) {
          if (e.message === 'Session expired') throw e;
          localStorage.clear();
          router.push('/login');
          throw new Error('Session expired');
        }
      } else {
        localStorage.clear();
        router.push('/login');
        throw new Error('Session expired');
      }
    }

    return res;
  };

  useEffect(() => {
    if (!getToken()) { router.push('/login'); return; }
    // A super-admin must pick a building first (sets selectedBuildingId on /buildings).
    if (isSuperAdmin && typeof window !== 'undefined' && !localStorage.getItem('selectedBuildingId')) {
      router.push('/buildings');
      return;
    }
    authFetch('/building').then(r => r.json()).then(r => { if (r.data) setBuilding(r.data); }).catch(() => {});
    authFetch('/building/access-log').then(r => r.json()).then(r => { if (r.data) setAccessLog(r.data); }).catch(() => {});
    try {
      const imp = localStorage.getItem('impersonation');
      if (imp) setImpersonation(JSON.parse(imp));
    } catch {}
    fetchData();
  }, []);

  const exitImpersonation = () => {
    const sa = localStorage.getItem('superAdminToken');
    if (sa) localStorage.setItem('accessToken', sa);
    localStorage.removeItem('superAdminToken');
    localStorage.removeItem('impersonation');
    localStorage.removeItem('selectedBuildingId');
    router.push('/buildings');
  };

  // Impersonation countdown → auto-exit when the 30-minute token expires.
  useEffect(() => {
    if (!impersonation) return;
    const tick = () => {
      const ms = new Date(impersonation.expiresAt).getTime() - Date.now();
      if (ms <= 0) { exitImpersonation(); return; }
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setImpRemaining(`${m}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [impersonation]);

  const fetchData = async () => {
    // Fire the secondary (non-blocking) fetches FIRST so they run concurrently
    // with the blocking trio below — previously they waited behind the
    // Promise.all and added a full round-trip to every section's load time.
    authFetch('/settings/rules').then(r => r.json()).then(r => {
      if (r.data) setRules(r.data);
    }).catch(() => {});
    authFetch('/wallet/users').then(r => r.json()).then(r => {
      if (r.data) setWalletUsers(r.data);
    }).catch(() => {});
    authFetch('/wallet/reports').then(r => r.json()).then(r => {
      if (r.data) setReportHistory(r.data);
    }).catch(() => {});
    authFetch('/wallet/drivers').then(r => r.json()).then(r => {
      if (r.data) setDrivers(r.data);
    }).catch(() => {});
    authFetch('/settings/electricity-rate').then(r => r.json()).then(r => {
      if (r.data) {
        setRateCents(r.data.rate_cents);
        setRateInput(String(r.data.rate_cents));
        setRateUpdatedAt(r.data.updated_at);
      }
    }).catch(() => {});
    authFetch('/settings/idle-fee').then(r => r.json()).then(r => {
      if (r.data) {
        setIdleFeeCents(r.data.idle_fee_cents_per_15min);
        setIdleFeeInput(String(r.data.idle_fee_cents_per_15min));
        setIdleGraceMin(r.data.idle_grace_min);
        setIdleGraceInput(String(r.data.idle_grace_min));
      }
    }).catch(() => {});
    authFetch('/wallet/activity').then(r => r.json()).then(r => {
      if (r.data) setBillingActivity(r.data);
    }).catch(() => {});
    fetchStatement(thisMonth);
    authFetch('/wallet/insights').then(r => r.json()).then(r => {
      if (r.data) setInsights(r.data);
    }).catch(() => {});

    // Blocking trio — gates the initial loading state only.
    try {
      const [u, s, a] = await Promise.all([
        authFetch('/users').then(r => r.json()),
        authFetch('/sessions/history?limit=10').then(r => r.json()),
        authFetch('/sessions/active').then(r => r.json()),
      ]);
      setUsers(u.data || []);
      setSessions(s.data || []);
      setActiveSession(a.data);
    } catch { router.push('/login'); }
    finally { setLoading(false); }
  };

  const monthLabel = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const fetchStatement = async (month: string) => {
    setStatementLoading(true);
    setAiSummary(null);
    setAiSummaryError(null);
    try {
      const res = await authFetch(`/wallet/statement?month=${month}`);
      const data = await res.json();
      if (data.success) setStatement(data.data);
    } catch { /* non-fatal */ }
    finally { setStatementLoading(false); }
  };

  const generateAiSummary = async () => {
    if (!statement) return;
    setAiSummaryLoading(true);
    setAiSummaryError(null);
    try {
      const res = await authFetch('/wallet/statement/summary', {
        method: 'POST',
        body: JSON.stringify({
          month: statement.month,
          rate_cents: statement.rate_cents_per_kwh,
          totals: statement.totals,
          rows: statement.rows,
        }),
      });
      const data = await res.json();
      if (data.success) setAiSummary(data.data.summary);
      else setAiSummaryError(data.error || 'Could not generate summary.');
    } catch { setAiSummaryError('Could not generate summary.'); }
    finally { setAiSummaryLoading(false); }
  };

  const downloadStatementCsv = () => {
    if (!statement) return;
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ['Resident', 'Unit', 'Sessions', 'kWh', 'Amount billed ($)', 'Current balance ($)'];
    const lines = statement.rows.map(r => [
      esc(r.name), esc(r.unit_number || ''), r.sessions,
      (r.total_kwh).toFixed(3), (r.billed_cents / 100).toFixed(2), (r.balance_cents / 100).toFixed(2),
    ].join(','));
    const totals = statement.totals;
    const footer = ['', '', totals.sessions, totals.total_kwh.toFixed(3), (totals.recovered_cents / 100).toFixed(2), ''].join(',');
    const csv = [
      `2020EV Charging Statement — ${monthLabel(statement.month)}`,
      `Rate: ${statement.rate_cents_per_kwh}c/kWh`,
      '',
      header.join(','),
      ...lines,
      `TOTAL,${footer}`,
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `2020EV-statement-${statement.month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const printStatement = () => {
    if (!statement) return;
    const s = statement;
    const rowsHtml = s.rows.map(r => `
      <tr>
        <td>${r.name}${r.unit_number ? ` <span class="unit">#${r.unit_number}</span>` : ''}</td>
        <td class="num">${r.sessions}</td>
        <td class="num">${r.total_kwh.toFixed(2)}</td>
        <td class="num">$${(r.billed_cents / 100).toFixed(2)}</td>
        <td class="num ${r.balance_cents < 0 ? 'neg' : ''}">$${(r.balance_cents / 100).toFixed(2)}</td>
      </tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>2020EV Statement — ${monthLabel(s.month)}</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a2030;margin:40px;}
        h1{font-size:22px;margin:0;color:#0A0F1E;} .sub{color:#66707f;font-size:13px;margin:4px 0 24px;}
        .totals{display:flex;gap:28px;margin:0 0 24px;padding:16px 20px;background:#f2f6fb;border-radius:10px;}
        .totals div span{display:block;} .totals .k{font-size:11px;color:#66707f;text-transform:uppercase;letter-spacing:.04em;}
        .totals .v{font-size:20px;font-weight:700;color:#0A0F1E;margin-top:2px;}
        table{width:100%;border-collapse:collapse;font-size:13px;}
        th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e6eaf0;}
        th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#66707f;}
        td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;} .unit{color:#9aa3b5;font-size:11px;}
        tfoot td{font-weight:700;border-top:2px solid #0A0F1E;border-bottom:none;}
        .neg{color:#c02626;} .footer{margin-top:28px;color:#9aa3b5;font-size:11px;}
      </style></head><body>
      <h1>2020EV — Charging Statement</h1>
      <div class="sub">${monthLabel(s.month)} · billed at ${s.rate_cents_per_kwh}¢/kWh · generated ${new Date(s.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div class="totals">
        <div><span class="k">Residents charged</span><span class="v">${s.totals.residents}</span></div>
        <div><span class="k">Sessions</span><span class="v">${s.totals.sessions}</span></div>
        <div><span class="k">Energy</span><span class="v">${s.totals.total_kwh.toFixed(1)} kWh</span></div>
        <div><span class="k">Recovered</span><span class="v">$${(s.totals.recovered_cents / 100).toFixed(2)}</span></div>
      </div>
      <table>
        <thead><tr><th>Resident</th><th class="num">Sessions</th><th class="num">kWh</th><th class="num">Billed</th><th class="num">Balance</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${s.totals.sessions}</td><td class="num">${s.totals.total_kwh.toFixed(2)}</td><td class="num">$${(s.totals.recovered_cents / 100).toFixed(2)}</td><td></td></tr></tfoot>
      </table>
      <div class="footer">2020EV — electricity cost recovery for shared EV chargers. Balances are prepaid; charges are billed automatically from ChargePoint session data.</div>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteLoading(true);
    setInviteResult('');
    try {
      const res = await authFetch('/auth/invite', { method: 'POST', body: JSON.stringify({ email: inviteEmail }) });
      const data = await res.json();
      if (data.success) {
        const token = data.data.token ?? data.data.invite_token ?? '';
        setInviteResult(token ? `ev2020://invite?token=${token}` : JSON.stringify(data.data));
        setInviteEmail('');
      } else {
        setInviteResult(`error:${data.error}`);
      }
    } catch { setInviteResult('error:Failed to create invite'); }
    finally { setInviteLoading(false); }
  };

  const copyInvite = async () => {
    await navigator.clipboard.writeText(inviteResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const updateUserDay = async (userId: string, day: string | null) => {
    setSavingDay(userId);
    await authFetch(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ priority_day: day }) });
    await fetchData();
    setSavingDay(null);
  };

  const removeUser = async (userId: string, name: string) => {
    if (!confirm(`Remove ${name} from 2020EV?`)) return;
    await authFetch(`/users/${userId}`, { method: 'DELETE' });
    fetchData();
  };

  const saveRules = async () => {
    setRulesLoading(true);
    try {
      await authFetch('/settings/rules', { method: 'PATCH', body: JSON.stringify({ rules }) });
      setRulesSaved(true);
      setTimeout(() => setRulesSaved(false), 2000);
    } catch { /* non-fatal */ }
    finally { setRulesLoading(false); }
  };

  const creditWallet = async (userId: string) => {
    setCreditLoading(true);
    setCreditSuccess(null);
    try {
      const res = await authFetch('/wallet/credit', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, amount_dollars: parseFloat(creditAmount) }),
      });
      const data = await res.json();
      if (data.success) {
        setCreditSuccess(userId);
        setTimeout(() => setCreditSuccess(null), 2500);
        authFetch('/wallet/users').then(r => r.json()).then(r => { if (r.data) setWalletUsers(r.data); });
      }
    } catch {}
    finally { setCreditLoading(false); }
  };

  const deductWallet = async (userId: string) => {
    const target = walletUsers.find(u => u.id === userId);
    const confirmed = window.confirm(
      `Deduct $${creditAmount} from ${target?.name ?? 'this resident'}?\n\nThis will reduce their wallet balance. This action is logged but cannot be automatically reversed.`
    );
    if (!confirmed) return;
    setCreditLoading(true);
    setDeductSuccess(null);
    try {
      const res = await authFetch('/wallet/credit', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, amount_dollars: -Math.abs(parseFloat(creditAmount)) }),
      });
      const data = await res.json();
      if (data.success) {
        setDeductSuccess(userId);
        setTimeout(() => setDeductSuccess(null), 2500);
        authFetch('/wallet/users').then(r => r.json()).then(r => { if (r.data) setWalletUsers(r.data); });
      }
    } catch {}
    finally { setCreditLoading(false); }
  };

  const createPlaceholder = async (driverId: string, driverName: string) => {
    if (!confirm(`Create "${driverName}" as a placeholder resident? Their sessions will be tracked and billed. You can link them to a real account later when they join the app.`)) return;
    setPlaceholderLoading(driverId);
    try {
      const res = await authFetch(`/wallet/drivers/${driverId}/create-placeholder`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDrivers(prev => prev.map(d =>
          d.id === driverId
            ? { ...d, status: 'mapped', mapped_user_name: driverName }
            : d
        ));
        authFetch('/wallet/users').then(r => r.json()).then(r => { if (r.data) setWalletUsers(r.data); });
      }
    } catch {}
    finally { setPlaceholderLoading(null); }
  };

  const clearDriverBilling = async (driverId: string, driverName: string) => {
    if (!confirm(`Clear all ChargePoint billing records for ${driverName}?\n\nThis reverses any deductions and removes the transaction records so you can re-import the CSV to bill them fresh. Use this if sessions show as "already billed" but the wallet balance looks wrong.`)) return;
    setClearBillingLoading(driverId);
    try {
      const res = await authFetch(`/wallet/drivers/${driverId}/transactions`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        authFetch('/wallet/users').then(r => r.json()).then(r => { if (r.data) setWalletUsers(r.data); });
      }
    } catch {}
    finally { setClearBillingLoading(null); }
  };

  const unmapDriver = async (driverId: string, driverName: string) => {
    if (!confirm(`Unmap "${driverName}"? This sets them back to pending so you can re-map to the correct resident. Existing billing transactions are not affected.`)) return;
    setUnmapLoading(driverId);
    try {
      const res = await authFetch(`/wallet/drivers/${driverId}/unmap`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDrivers(prev => prev.map(d =>
          d.id === driverId ? { ...d, status: 'pending', user_id: null, mapped_user_name: null } : d
        ));
      }
    } catch {}
    finally { setUnmapLoading(null); }
  };

  const ignoreDriver = async (driverId: string, ignore: boolean) => {
    setIgnoreLoading(driverId);
    try {
      const res = await authFetch(`/wallet/drivers/${driverId}/${ignore ? 'ignore' : 'unignore'}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDrivers(prev => prev.map(d => d.id === driverId ? { ...d, is_ignored: ignore } : d));
      }
    } catch {}
    finally { setIgnoreLoading(null); }
  };

  const mapDriver = async (driverId: string) => {
    const userId = driverMapping[driverId];
    if (!userId) return;
    setMappingLoading(driverId);
    try {
      const res = await authFetch(`/wallet/drivers/${driverId}/map`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId }),
      });
      const data = await res.json();
      if (data.success) {
        const user = walletUsers.find(u => u.id === userId);
        setDrivers(prev => prev.map(d =>
          d.id === driverId
            ? { ...d, status: 'mapped', user_id: userId, mapped_user_name: user?.name ?? null }
            : d
        ));
        setDriverMapping(prev => { const n = { ...prev }; delete n[driverId]; return n; });
      }
    } catch {}
    finally { setMappingLoading(null); }
  };

  const saveRate = async () => {
    const parsed = parseInt(rateInput, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 200) return;
    setRateSaving(true);
    try {
      const res = await authFetch('/settings/electricity-rate', {
        method: 'PATCH',
        body: JSON.stringify({ rate_cents: parsed }),
      });
      const data = await res.json();
      if (data.success) {
        setRateCents(parsed);
        setRateSaved(true);
        setTimeout(() => setRateSaved(false), 3000);
      }
    } catch {}
    finally { setRateSaving(false); }
  };

  const saveIdleFee = async () => {
    const fee = parseInt(idleFeeInput, 10);
    const grace = parseInt(idleGraceInput, 10);
    if (isNaN(fee) || fee < 0 || fee > 500) return;
    if (isNaN(grace) || grace < 5 || grace > 120) return;
    setIdleFeeSaving(true);
    try {
      const res = await authFetch('/settings/idle-fee', {
        method: 'PATCH',
        body: JSON.stringify({ idle_fee_cents_per_15min: fee, idle_grace_min: grace }),
      });
      const data = await res.json();
      if (data.success) {
        setIdleFeeCents(fee);
        setIdleGraceMin(grace);
        setIdleFeeSaved(true);
        setTimeout(() => setIdleFeeSaved(false), 3000);
      }
    } catch {}
    finally { setIdleFeeSaving(false); }
  };

  const importReport = async () => {
    if (!reportCsv.trim()) return;
    setReportLoading(true);
    setReportError('');
    setReportResult(null);
    try {
      const res = await authFetch('/wallet/import', {
        method: 'POST',
        body: JSON.stringify({ csv: reportCsv }),
      });
      const data = await res.json();
      if (data.success) {
        setReportResult(data.data);
        setReportCsv('');
        authFetch('/wallet/users').then(r => r.json()).then(r => { if (r.data) setWalletUsers(r.data); });
        authFetch('/wallet/reports').then(r => r.json()).then(r => { if (r.data) setReportHistory(r.data); });
      } else {
        setReportError(data.error || 'Import failed');
      }
    } catch { setReportError('Import failed'); }
    finally { setReportLoading(false); }
  };

  const logout = () => { localStorage.clear(); router.push('/login'); };

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-white/40 text-sm">Loading dashboard…</p>
      </div>
    </div>
  );

  const isError = inviteResult.startsWith('error:');
  const errorMsg = isError ? inviteResult.replace('error:', '') : '';

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--page-fg)' }}>
      {impersonation && (
        <div className="sticky top-0 z-20 bg-purple-600 text-on-accent text-sm">
          <div className="max-w-6xl mx-auto px-6 py-2.5 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span>👁️</span>
              <span>Support view — you are viewing <strong>{impersonation.buildingName}</strong> as this building's admin. This session is logged.</span>
            </span>
            <span className="flex items-center gap-3 flex-shrink-0">
              <span className="tabular-nums opacity-80">ends in {impRemaining}</span>
              <button onClick={exitImpersonation} className="bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1 font-medium transition-colors">Exit</button>
            </span>
          </div>
        </div>
      )}
      {/* Top bar */}
      <header className="border-b border-white/8 backdrop-blur-sm sticky top-0 z-10" style={{ backgroundColor: 'var(--header-bg)' }}>
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <span className="font-bold text-white tracking-tight">2020EV</span>
            <span className="text-white/30 text-sm ml-1">Admin</span>
            {building && (
              <span className="text-white/50 text-sm ml-2 pl-2 border-l border-white/15">{building.name}</span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {isSuperAdmin && (
              <button
                onClick={() => { localStorage.removeItem('selectedBuildingId'); router.push('/buildings'); }}
                className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
              >
                ← Buildings
              </button>
            )}
            <ThemeToggle />
            {!impersonation && <ChangePassword />}
            <button onClick={logout} className="text-white/40 hover:text-white/70 text-sm transition-colors">
              Sign out
            </button>
          </div>
        </div>
      </header>

      {building && (building.billing_status === 'past_due' || building.billing_status === 'canceled') && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-sm">
          <div className="max-w-6xl mx-auto px-6 py-2.5 flex items-center gap-2">
            <span>⚠</span>
            <span>
              This building's subscription is <strong>{building.billing_status.replace('_', ' ')}</strong>.
              Please contact 2020EV to restore full service.
            </span>
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">

        {/* Charger Status Banner */}
        <div className={`rounded-2xl p-5 flex items-center justify-between ${
          activeSession
            ? 'bg-amber-500/8 border border-amber-500/25'
            : 'bg-emerald-500/8 border border-emerald-500/25'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ring-4 ${
              activeSession
                ? 'bg-amber-400 ring-amber-400/20'
                : 'bg-emerald-400 ring-emerald-400/20'
            }`} />
            <div>
              <p className={`font-semibold ${activeSession ? 'text-amber-300' : 'text-emerald-300'}`}>
                {activeSession ? 'Charger In Use' : 'Charger Available'}
              </p>
              {activeSession && (
                <p className="text-white/50 text-sm mt-0.5">
                  {activeSession.user_name} · {TYPE_LABEL[activeSession.type] ?? activeSession.type} · started {elapsed(activeSession.started_at)} ago · done ~{formatTime(activeSession.estimated_end)}
                </p>
              )}
            </div>
          </div>
          <button onClick={fetchData} className="text-white/30 hover:text-white/60 text-xs transition-colors px-3 py-1.5 rounded-lg hover:bg-white/5">
            Refresh
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Residents', value: users.length, sub: `${users.filter(u => u.role === 'admin').length} admin` },
            { label: 'Sessions (recent)', value: sessions.length, sub: 'last 10' },
            { label: 'Assigned days', value: users.filter(u => u.priority_day).length, sub: `of ${users.length} users` },
          ].map(s => (
            <div key={s.label} className="bg-white/4 border border-white/8 rounded-2xl p-5">
              <p className="text-white/40 text-xs font-medium uppercase tracking-wider mb-1">{s.label}</p>
              <p className="text-3xl font-bold text-white">{s.value}</p>
              <p className="text-white/35 text-xs mt-1">{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Users table — takes 3 cols */}
          <div className="lg:col-span-3 bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8">
              <h2 className="font-semibold text-white">Residents &amp; Schedule</h2>
              <p className="text-white/40 text-xs mt-0.5">Assign each resident their priority charging day</p>
            </div>
            <div className="divide-y divide-white/5">
              {users.map(u => (
                <div key={u.id} className="px-6 py-4 flex items-center gap-4 hover:bg-white/3 transition-colors">
                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                    style={{ backgroundColor: avatarColor(u.id) }}>
                    {getInitials(u.name)}
                  </div>
                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-white truncate">{u.name}</p>
                      {u.role === 'admin' && (
                        <span className="text-xs bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 rounded-md px-1.5 py-0.5 font-medium">
                          Admin
                        </span>
                      )}
                    </div>
                    <p className="text-white/35 text-xs mt-0.5">
                      {u.unit_number ? `Unit #${u.unit_number}` : 'No unit set'}
                    </p>
                  </div>
                  {/* Priority day picker */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {savingDay === u.id ? (
                      <div className="w-4 h-4 border border-blue-500 border-t-transparent rounded-full animate-spin" />
                    ) : null}
                    <select
                      value={u.priority_day || ''}
                      onChange={e => updateUserDay(u.id, e.target.value || null)}
                      className="bg-white/8 border border-white/12 rounded-lg px-3 py-1.5 text-xs text-white appearance-none cursor-pointer hover:bg-white/12 transition-colors focus:outline-none focus:border-blue-500"
                    >
                      <option value="">No day</option>
                      {WEEKDAYS.map(d => (
                        <option key={d} value={d}>{DAY_SHORT[d]}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeUser(u.id, u.name)}
                      className="text-white/20 hover:text-red-400 text-xs transition-colors px-2 py-1.5 rounded-lg hover:bg-red-500/8"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {users.length === 0 && (
                <div className="px-6 py-10 text-center text-white/30 text-sm">No residents yet</div>
              )}
            </div>
          </div>

          {/* Right column — 2 cols */}
          <div className="lg:col-span-2 space-y-6">
            {/* Invite */}
            <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/8">
                <h2 className="font-semibold text-white">Invite Resident</h2>
                <p className="text-white/40 text-xs mt-0.5">Send a one-time sign-up link</p>
              </div>
              <div className="p-6 space-y-3">
                <form onSubmit={handleInvite} className="space-y-3">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    placeholder="resident@email.com"
                    className="w-full bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500 transition-colors"
                    required
                  />
                  <button
                    type="submit"
                    disabled={inviteLoading}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl py-2.5 text-sm font-semibold text-on-accent transition-colors"
                  >
                    {inviteLoading ? 'Generating…' : 'Generate Invite Link'}
                  </button>
                </form>

                {isError && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-xs">
                    {errorMsg}
                  </div>
                )}

                {inviteResult && !isError && (
                  <div className="space-y-2">
                    <div className="bg-emerald-500/8 border border-emerald-500/20 rounded-xl p-3">
                      <p className="text-emerald-400 text-xs font-medium mb-1.5">✓ Invite link ready</p>
                      <p className="text-white/55 text-xs break-all leading-relaxed font-mono">{inviteResult}</p>
                    </div>
                    <button
                      onClick={copyInvite}
                      className={`w-full rounded-xl py-2.5 text-xs font-semibold transition-all ${
                        copied
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-white/8 hover:bg-white/12 text-white/70 border border-white/10'
                      }`}
                    >
                      {copied ? '✓ Copied!' : 'Copy Link'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Community Rules */}
            <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/8">
                <h2 className="font-semibold text-white">Community Rules</h2>
                <p className="text-white/40 text-xs mt-0.5">Displayed in residents&apos; Profile tab</p>
              </div>
              <div className="p-6 space-y-3">
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={rule.icon}
                      onChange={e => setRules(r => r.map((x, j) => j === i ? {...x, icon: e.target.value} : x))}
                      className="w-12 bg-white/6 border border-white/12 rounded-lg px-2 py-2 text-sm text-white text-center outline-none focus:border-blue-500"
                      maxLength={2}
                      placeholder="⏱"
                    />
                    <input
                      value={rule.text}
                      onChange={e => setRules(r => r.map((x, j) => j === i ? {...x, text: e.target.value} : x))}
                      className="flex-1 bg-white/6 border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-blue-500"
                      placeholder="Rule description"
                    />
                    <button
                      onClick={() => setRules(r => r.filter((_, j) => j !== i))}
                      className="text-white/20 hover:text-red-400 transition-colors px-2 py-2 text-xs"
                    >✕</button>
                  </div>
                ))}
                <button
                  onClick={() => setRules(r => [...r, { icon: '📋', text: '' }])}
                  className="w-full py-2 text-xs text-white/40 hover:text-white/60 border border-dashed border-white/12 rounded-lg transition-colors"
                >+ Add rule</button>
                <button
                  onClick={saveRules}
                  disabled={rulesLoading}
                  className={`w-full rounded-xl py-2.5 text-xs font-semibold transition-all ${
                    rulesSaved
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-on-accent'
                  }`}
                >
                  {rulesLoading ? 'Saving…' : rulesSaved ? '✓ Saved' : 'Save Rules'}
                </button>
              </div>
            </div>

            {/* Recent Sessions */}
            <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/8">
                <h2 className="font-semibold text-white">Recent Sessions</h2>
              </div>
              <div className="divide-y divide-white/5">
                {sessions.slice(0, 6).map(s => (
                  <div key={s.id} className="px-6 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white/80 font-medium">{s.user_name}</p>
                      <p className="text-white/35 text-xs mt-0.5">
                        {TYPE_LABEL[s.type] ?? s.type}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-white/50">{formatDate(s.started_at)}</p>
                      <span className={`text-xs font-medium mt-0.5 inline-block ${
                        s.status === 'active' ? 'text-amber-400' : 'text-white/30'
                      }`}>
                        {s.status === 'active' ? 'Active' : 'Done'}
                      </span>
                    </div>
                  </div>
                ))}
                {sessions.length === 0 && (
                  <div className="px-6 py-8 text-center text-white/30 text-sm">No sessions yet</div>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* ── Resident Wallets ── */}
        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Resident Wallets</h2>
              <p className="text-white/40 text-xs mt-0.5">
                Credit balance · {rateCents != null ? `${rateCents}¢/kWh` : '$0.18/kWh'} deducted nightly
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-white/40 text-xs">Amount $</span>
              <input
                type="number"
                value={creditAmount}
                onChange={e => setCreditAmount(e.target.value)}
                className="w-20 bg-white/6 border border-white/12 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500"
                min="1"
                step="1"
              />
            </div>
          </div>
          <div className="divide-y divide-white/5">
            {walletUsers.map(u => {
              const bal = (u.balance_cents ?? 0) / 100;
              const isLow = bal < 100;
              return (
                <div key={u.id} className="px-6 py-4 flex items-center gap-4">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                    style={{ backgroundColor: avatarColor(u.id) }}>
                    {getInitials(u.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{u.name}</p>
                    <p className="text-white/35 text-xs">{u.unit_number ? `Unit #${u.unit_number}` : u.email}</p>
                  </div>
                  <span className={`text-lg font-bold tabular-nums ${isLow ? 'text-red-400' : 'text-emerald-400'}`}>
                    ${bal.toFixed(2)}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => creditWallet(u.id)}
                      disabled={creditLoading}
                      className={`rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                        creditSuccess === u.id
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-on-accent'
                      }`}
                    >
                      {creditSuccess === u.id ? '✓ Added' : `+ $${creditAmount}`}
                    </button>
                    <button
                      onClick={() => deductWallet(u.id)}
                      disabled={creditLoading}
                      className={`rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                        deductSuccess === u.id
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : 'bg-white/8 hover:bg-white/14 disabled:opacity-50 text-red-400 border border-red-500/30'
                      }`}
                    >
                      {deductSuccess === u.id ? '✓ Deducted' : `− $${creditAmount}`}
                    </button>
                  </div>
                </div>
              );
            })}
            {walletUsers.length === 0 && (
              <div className="px-6 py-8 text-center text-white/30 text-sm">No residents yet</div>
            )}
          </div>
        </div>

        {/* ── ChargePoint Driver Mapping ── */}
        {drivers.length > 0 && (
          <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-white">ChargePoint Drivers</h2>
                <p className="text-white/40 text-xs mt-0.5">
                  Map each ChargePoint driver to a resident so their sessions get billed correctly
                </p>
              </div>
              {drivers.filter(d => d.status === 'pending' && !d.is_ignored).length > 0 && (
                <span className="bg-red-500/15 text-red-400 border border-red-500/25 rounded-full px-2.5 py-0.5 text-xs font-semibold">
                  {drivers.filter(d => d.status === 'pending' && !d.is_ignored).length} pending
                </span>
              )}
            </div>
            <div className="divide-y divide-white/5">
              {drivers.filter(d => !d.is_ignored).map(d => (
                <div key={d.id} className="px-6 py-4 flex items-center gap-4">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${d.status === 'mapped' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{d.driver_name}</p>
                    <p className="text-white/35 text-xs mt-0.5">
                      {d.status === 'mapped'
                        ? `Mapped to ${d.mapped_user_name}`
                        : `Last seen ${new Date(d.last_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                      }
                    </p>
                  </div>
                  {d.status === 'pending' && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <select
                        value={driverMapping[d.id] ?? ''}
                        onChange={e => setDriverMapping(prev => ({ ...prev, [d.id]: e.target.value }))}
                        className="bg-white/8 border border-white/12 rounded-lg px-3 py-1.5 text-xs text-white appearance-none cursor-pointer hover:bg-white/12 transition-colors focus:outline-none focus:border-blue-500"
                      >
                        <option value="">Select resident…</option>
                        {walletUsers.map(u => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => mapDriver(d.id)}
                        disabled={!driverMapping[d.id] || mappingLoading === d.id}
                        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors"
                      >
                        {mappingLoading === d.id ? '…' : 'Map'}
                      </button>
                      <button
                        onClick={() => createPlaceholder(d.id, d.driver_name)}
                        disabled={!!driverMapping[d.id] || placeholderLoading === d.id}
                        title="Create this person as a new resident so their sessions are tracked. Link to their real account when they join the app."
                        className="bg-white/6 hover:bg-white/12 disabled:opacity-40 disabled:cursor-not-allowed border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/70 transition-colors"
                      >
                        {placeholderLoading === d.id ? '…' : '+ New resident'}
                      </button>
                      <button
                        onClick={() => ignoreDriver(d.id, true)}
                        disabled={ignoreLoading === d.id}
                        title="Ignore this account — future ingests will skip it silently"
                        className="text-white/20 hover:text-white/50 disabled:opacity-40 text-xs transition-colors"
                      >
                        {ignoreLoading === d.id ? '…' : 'Ignore'}
                      </button>
                    </div>
                  )}
                  {d.status === 'mapped' && (
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-emerald-400 text-xs font-medium">Mapped</span>
                      <button
                        onClick={() => unmapDriver(d.id, d.driver_name)}
                        disabled={unmapLoading === d.id}
                        title="Revert to pending so you can re-map to the correct resident"
                        className="text-white/20 hover:text-blue-400 disabled:opacity-40 text-xs transition-colors"
                      >
                        {unmapLoading === d.id ? '…' : 'Unmap'}
                      </button>
                      <button
                        onClick={() => clearDriverBilling(d.id, d.driver_name)}
                        disabled={clearBillingLoading === d.id}
                        title="Clear billing records so sessions can be re-imported fresh"
                        className="text-white/20 hover:text-amber-400 disabled:opacity-40 text-xs transition-colors"
                      >
                        {clearBillingLoading === d.id ? '…' : 'Reset billing'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {drivers.some(d => d.is_ignored) && (
                <div className="px-6 py-3 bg-white/2">
                  <p className="text-white/20 text-xs font-medium uppercase tracking-wide mb-2">Ignored</p>
                  {drivers.filter(d => d.is_ignored).map(d => (
                    <div key={d.id} className="flex items-center gap-3 py-1.5">
                      <div className="w-2 h-2 rounded-full flex-shrink-0 bg-white/15" />
                      <p className="text-white/30 text-xs flex-1">{d.driver_name}</p>
                      <button
                        onClick={() => ignoreDriver(d.id, false)}
                        disabled={ignoreLoading === d.id}
                        className="text-white/20 hover:text-white/50 text-xs transition-colors"
                      >
                        {ignoreLoading === d.id ? '…' : 'Unignore'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {drivers.some(d => d.status === 'pending' && !d.is_ignored) && (
              <div className="px-6 py-3 border-t border-white/8 bg-amber-500/5">
                <p className="text-amber-400/70 text-xs">
                  After mapping all drivers, re-upload the same CSV file above to bill their sessions.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Import ChargePoint Report ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8">
              <h2 className="font-semibold text-white">Import ChargePoint Report</h2>
              <p className="text-white/40 text-xs mt-0.5">Paste CSV from ChargePoint → Reports. Sessions auto-matched to residents.</p>
            </div>
            <div className="p-6 space-y-3">
              <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-white/15 rounded-xl cursor-pointer hover:border-blue-500/50 hover:bg-white/4 transition-all group">
                <input
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = ev => setReportCsv(ev.target?.result as string ?? '');
                    reader.readAsText(file);
                    e.target.value = '';
                  }}
                />
                {reportCsv ? (
                  <div className="text-center">
                    <p className="text-emerald-400 text-sm font-semibold">✓ CSV loaded</p>
                    <p className="text-white/40 text-xs mt-1">{reportCsv.split('\n').length - 1} rows · click to replace</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-white/50 text-sm group-hover:text-white/70 transition-colors">Click to upload ChargePoint CSV</p>
                    <p className="text-white/25 text-xs mt-1">session_details_meter_data_summary_*.csv</p>
                  </div>
                )}
              </label>
              {reportError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-xs">{reportError}</div>
              )}
              {reportResult && (
                <div className="bg-emerald-500/8 border border-emerald-500/20 rounded-xl p-4 space-y-1">
                  <p className="text-emerald-400 text-xs font-semibold">✓ Report processed</p>
                  <p className="text-white/60 text-xs">
                    <span className="text-white font-semibold">{reportResult.rows_matched}</span> new sessions billed
                    {reportResult.rows_already_billed > 0 && <span className="text-white/35"> · {reportResult.rows_already_billed} already billed (skipped)</span>}
                    {reportResult.rows_unmatched > 0 && <span className="text-amber-400"> · {reportResult.rows_unmatched} unmatched</span>}
                  </p>
                  <p className="text-white/60 text-xs">Total deducted: <span className="text-white font-semibold">${(reportResult.total_deducted_cents / 100).toFixed(2)}</span></p>
                </div>
              )}
              <button
                onClick={importReport}
                disabled={reportLoading || !reportCsv.trim()}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl py-2.5 text-sm font-semibold text-on-accent transition-colors"
              >
                {reportLoading ? 'Processing…' : 'Process Report'}
              </button>
            </div>
          </div>

          {/* Report History */}
          <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8">
              <h2 className="font-semibold text-white">Report History</h2>
              <p className="text-white/40 text-xs mt-0.5">Latest ChargePoint reports · scroll for older</p>
            </div>
            {/* ~7 rows tall, then scrolls — the full history stays reachable */}
            <div className="divide-y divide-white/5 max-h-[26rem] overflow-y-auto">
              {reportHistory.map(r => (
                <div key={r.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white/80 font-medium">
                        {r.source === 'email' ? '📧' : '📋'} {r.filename || `Report ${r.id.slice(0, 8)}`}
                      </p>
                      <p className="text-white/35 text-xs mt-0.5">
                        {new Date(r.processed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 flex items-start gap-3">
                      <div>
                        <p className={`text-sm font-bold ${r.total_deducted_cents > 0 ? 'text-emerald-400' : 'text-white/30'}`}>
                          -${((r.total_deducted_cents ?? 0) / 100).toFixed(2)}
                        </p>
                        <p className="text-white/35 text-xs mt-0.5">{r.rows_matched}/{r.rows_total} matched</p>
                      </div>
                      <button
                        title="Delete this import record so the same CSV can be re-uploaded"
                        onClick={async () => {
                          if (!confirm('Delete this import record? This lets you re-upload the same CSV. It does NOT reverse any charges already applied.')) return;
                          await authFetch(`/wallet/reports/${r.id}`, { method: 'DELETE' });
                          setReportHistory(prev => prev.filter(x => x.id !== r.id));
                          setReportError('');
                          setReportResult(null);
                          setReportCsv('');
                        }}
                        className="text-white/20 hover:text-red-400 transition-colors text-lg leading-none mt-0.5"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {reportHistory.length === 0 && (
                <div className="px-6 py-8 text-center text-white/30 text-sm">No reports yet</div>
              )}
            </div>
          </div>
        </div>

        {/* ── Board Insights ── */}
        {insights && (
          <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8">
              <h2 className="font-semibold text-white">Insights</h2>
              <p className="text-white/40 text-xs mt-0.5">Cost recovered and charger usage over time — the ROI view for the board</p>
            </div>
            <div className="p-6 space-y-6">
              {/* All-time totals */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { k: 'Total recovered', v: `$${(insights.totals.recovered_cents / 100).toFixed(2)}` },
                  { k: 'Energy delivered', v: `${insights.totals.kwh.toFixed(0)} kWh` },
                  { k: 'Sessions', v: insights.totals.sessions },
                  { k: 'Residents charging', v: insights.totals.residents },
                ].map(t => (
                  <div key={t.k} className="bg-white/4 border border-white/8 rounded-xl px-4 py-3">
                    <p className="text-white/40 text-xs">{t.k}</p>
                    <p className="text-white font-bold text-xl mt-1 tabular-nums">{t.v}</p>
                  </div>
                ))}
              </div>

              {/* 6-month recovered-$ bar chart */}
              {insights.trend.length > 0 && (() => {
                const max = Math.max(...insights.trend.map(t => t.recovered_cents), 1);
                return (
                  <div>
                    <p className="text-white/50 text-xs mb-3 font-medium">Cost recovered by month</p>
                    <div className="flex items-end gap-3 h-36">
                      {insights.trend.map(t => {
                        const pct = Math.round((t.recovered_cents / max) * 100);
                        const [, mo] = t.month.split('-').map(Number);
                        const label = new Date(2000, mo - 1, 1).toLocaleDateString('en-US', { month: 'short' });
                        return (
                          <div key={t.month} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end">
                            <span className="text-white/50 text-[10px] tabular-nums">${(t.recovered_cents / 100).toFixed(0)}</span>
                            <div
                              className="w-full bg-gradient-to-t from-emerald-600 to-emerald-400 rounded-t-md min-h-[2px]"
                              style={{ height: `${pct}%` }}
                              title={`${label}: $${(t.recovered_cents / 100).toFixed(2)} · ${t.kwh.toFixed(1)} kWh · ${t.sessions} sessions`}
                            />
                            <span className="text-white/40 text-[10px]">{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Top residents */}
              {insights.top_residents.length > 0 && (
                <div>
                  <p className="text-white/50 text-xs mb-2 font-medium">Top residents (all time)</p>
                  <div className="space-y-1.5">
                    {insights.top_residents.map((r, i) => (
                      <div key={r.name} className="flex items-center gap-3 text-sm">
                        <span className="text-white/30 w-4 tabular-nums">{i + 1}</span>
                        <span className="text-white flex-1 truncate">{r.name}</span>
                        <span className="text-white/40 text-xs tabular-nums">{r.kwh.toFixed(0)} kWh</span>
                        <span className="text-white font-semibold tabular-nums w-16 text-right">${(r.recovered_cents / 100).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Monthly Statement ── */}
        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="font-semibold text-white">Monthly Statement</h2>
              <p className="text-white/40 text-xs mt-0.5">Per-resident charging summary for the association&apos;s books · export or print</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="month"
                value={statementMonth}
                max={thisMonth}
                onChange={e => { setStatementMonth(e.target.value); fetchStatement(e.target.value); }}
                className="bg-white/6 border border-white/12 rounded-lg px-3 py-1.5 text-sm text-white outline-none"
              />
              <button
                onClick={downloadStatementCsv}
                disabled={!statement || statement.rows.length === 0}
                className="text-xs px-3 py-1.5 rounded-lg bg-white/6 hover:bg-white/10 text-white/70 transition-colors disabled:opacity-30"
              >
                Download CSV
              </button>
              <button
                onClick={printStatement}
                disabled={!statement || statement.rows.length === 0}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-on-accent font-semibold transition-colors disabled:opacity-30"
              >
                Print / PDF
              </button>
              <button
                onClick={generateAiSummary}
                disabled={!statement || statement.rows.length === 0 || aiSummaryLoading}
                className="text-xs px-3 py-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-on-accent font-semibold transition-colors disabled:opacity-30"
              >
                {aiSummaryLoading ? 'Writing…' : '✨ AI summary'}
              </button>
            </div>
          </div>

          {(aiSummary || aiSummaryError) && (
            <div className="px-6 py-4 border-b border-white/8">
              {aiSummary && (
                <div className="bg-violet-500/8 border border-violet-500/20 rounded-xl px-4 py-3">
                  <p className="text-violet-300 text-xs font-semibold mb-1.5">✨ Summary for the board</p>
                  <p className="text-white/80 text-sm whitespace-pre-wrap leading-relaxed">{aiSummary}</p>
                </div>
              )}
              {aiSummaryError && (
                <p className="text-amber-400/80 text-xs">{aiSummaryError}</p>
              )}
            </div>
          )}

          {/* Totals */}
          {statement && (
            <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 border-b border-white/8">
              {[
                { k: 'Residents charged', v: statement.totals.residents },
                { k: 'Sessions', v: statement.totals.sessions },
                { k: 'Energy', v: `${statement.totals.total_kwh.toFixed(1)} kWh` },
                { k: 'Recovered', v: `$${(statement.totals.recovered_cents / 100).toFixed(2)}` },
              ].map(t => (
                <div key={t.k}>
                  <p className="text-white/40 text-xs">{t.k}</p>
                  <p className="text-white font-bold text-lg mt-0.5 tabular-nums">{t.v}</p>
                </div>
              ))}
            </div>
          )}

          <div className="divide-y divide-white/5 max-h-96 overflow-y-auto">
            {statementLoading && (
              <div className="px-6 py-8 text-center text-white/30 text-sm">Loading {monthLabel(statementMonth)}…</div>
            )}
            {!statementLoading && statement && statement.rows.map(r => (
              <div key={r.user_id} className="px-6 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-white">{r.name}</p>
                    {r.unit_number && (
                      <span className="text-xs text-white/30">#{r.unit_number}</span>
                    )}
                  </div>
                  <p className="text-white/35 text-xs mt-0.5 tabular-nums">
                    {r.sessions} session{r.sessions !== 1 ? 's' : ''} · {r.total_kwh.toFixed(2)} kWh
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-white tabular-nums">${(r.billed_cents / 100).toFixed(2)}</p>
                  <p className={`text-xs mt-0.5 tabular-nums ${r.balance_cents < 0 ? 'text-red-400' : 'text-white/30'}`}>
                    bal ${(r.balance_cents / 100).toFixed(2)}
                  </p>
                </div>
              </div>
            ))}
            {!statementLoading && statement && statement.rows.length === 0 && (
              <div className="px-6 py-10 text-center text-white/30 text-sm">No charging activity in {monthLabel(statementMonth)}</div>
            )}
          </div>
        </div>

        {/* ── Billing Activity Log ── */}
        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Billing Activity</h2>
              <p className="text-white/40 text-xs mt-0.5">Every ChargePoint charge deducted — last 100 · rate used is shown per transaction</p>
            </div>
            <button
              onClick={() => authFetch('/wallet/activity').then(r => r.json()).then(r => { if (r.data) setBillingActivity(r.data); })}
              className="text-white/30 hover:text-white/60 text-xs transition-colors px-3 py-1.5 rounded-lg hover:bg-white/5"
            >
              Refresh
            </button>
          </div>
          <div className="divide-y divide-white/5 max-h-96 overflow-y-auto">
            {billingActivity.map(tx => {
              const dollars = Math.abs(tx.amount_cents) / 100;
              const rate = tx.rate_cents_per_kwh;
              const kwh = parseFloat(String(tx.kwh ?? 0));
              const dateStr = new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              const timeStr = new Date(tx.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
              return (
                <div key={tx.id} className="px-6 py-3 flex items-center gap-4">
                  <div className="text-base flex-shrink-0">⚡</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-white">{tx.user_name}</p>
                      <span className="text-xs bg-white/6 border border-white/10 rounded-md px-1.5 py-0.5 text-white/50 font-mono">
                        {kwh.toFixed(3)} kWh
                      </span>
                      {rate != null && (
                        <span className={`text-xs rounded-md px-1.5 py-0.5 font-mono border ${
                          rate !== 18
                            ? 'bg-amber-500/10 border-amber-500/25 text-amber-400'
                            : 'bg-white/4 border-white/8 text-white/30'
                        }`}>
                          {rate}¢/kWh
                        </span>
                      )}
                    </div>
                    <p className="text-white/35 text-xs mt-0.5">{tx.description}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-red-400">−${dollars.toFixed(2)}</p>
                    <p className="text-white/30 text-xs mt-0.5">{dateStr} · {timeStr}</p>
                  </div>
                </div>
              );
            })}
            {billingActivity.length === 0 && (
              <div className="px-6 py-10 text-center text-white/30 text-sm">No billing activity yet</div>
            )}
          </div>
        </div>

        {/* ── Settings ── */}
        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8">
            <h2 className="font-semibold text-white">Settings</h2>
            <p className="text-white/40 text-xs mt-0.5">Billing configuration — changes apply to all future ingests</p>
          </div>
          <div className="p-6 space-y-5">
            {/* Electricity rate */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Electricity Rate</p>
                  <p className="text-white/40 text-xs mt-0.5">
                    Applied to every kWh billed. Currently:{' '}
                    {rateCents != null
                      ? <span className={`font-semibold ${rateCents !== 18 ? 'text-amber-400' : 'text-emerald-400'}`}>{rateCents}¢/kWh (${(rateCents / 100).toFixed(4)}/kWh)</span>
                      : <span className="text-white/25">loading…</span>
                    }
                    {rateUpdatedAt && (
                      <span className="text-white/25 ml-1">
                        · last changed {new Date(rateUpdatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-white/6 border border-white/12 rounded-xl px-4 py-2.5 flex-1 max-w-xs">
                  <input
                    type="number"
                    value={rateInput}
                    onChange={e => setRateInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveRate()}
                    className="bg-transparent text-white text-sm outline-none w-20 tabular-nums"
                    min="1"
                    max="200"
                    step="1"
                    placeholder="18"
                  />
                  <span className="text-white/40 text-sm">¢ / kWh</span>
                  {rateInput && parseInt(rateInput) > 0 && (
                    <span className="text-white/25 text-xs ml-1">(${(parseInt(rateInput || '0') / 100).toFixed(4)})</span>
                  )}
                </div>
                <button
                  onClick={saveRate}
                  disabled={rateSaving || !rateInput || parseInt(rateInput) < 1 || parseInt(rateInput) > 200}
                  className={`rounded-xl px-5 py-2.5 text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    rateSaved
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-blue-600 hover:bg-blue-500 text-on-accent'
                  }`}
                >
                  {rateSaving ? 'Saving…' : rateSaved ? '✓ Saved' : 'Update Rate'}
                </button>
              </div>
              {rateCents != null && rateCents !== 18 && (
                <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl px-4 py-3">
                  <p className="text-amber-400 text-xs font-medium">
                    ⚠ Rate is {rateCents}¢/kWh — default is 18¢/kWh. Verify this is correct before the next ingest.
                  </p>
                  <p className="text-amber-400/60 text-xs mt-0.5">
                    Past charges used whatever rate was set at the time. Check the Billing Activity log to see rate used per transaction.
                  </p>
                </div>
              )}
              {rateCents === 18 && rateSaved && (
                <p className="text-emerald-400/70 text-xs">Rate set to 18¢/kWh ✓</p>
              )}
            </div>
            {/* Idle fee */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Idle fee</p>
                  <p className="text-white/40 text-xs mt-0.5">
                    Bill a per-15-min fee when a finished car blocks the charger while neighbors are queued. 0 = off (default). Currently:{' '}
                    {idleFeeCents != null
                      ? idleFeeCents === 0
                        ? <span className="font-semibold text-emerald-400">Off</span>
                        : <span className="font-semibold text-amber-400">{idleFeeCents}¢ / 15 min after {idleGraceMin} min grace</span>
                      : <span className="text-white/25">loading…</span>
                    }
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-white/6 border border-white/12 rounded-xl px-4 py-2.5">
                  <input
                    type="number"
                    value={idleFeeInput}
                    onChange={e => setIdleFeeInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveIdleFee()}
                    className="bg-transparent text-white text-sm outline-none w-20 tabular-nums"
                    min="0"
                    max="500"
                    step="1"
                    placeholder="0"
                  />
                  <span className="text-white/40 text-sm">¢ / 15 min</span>
                </div>
                <div className="flex items-center gap-2 bg-white/6 border border-white/12 rounded-xl px-4 py-2.5">
                  <input
                    type="number"
                    value={idleGraceInput}
                    onChange={e => setIdleGraceInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveIdleFee()}
                    className="bg-transparent text-white text-sm outline-none w-20 tabular-nums"
                    min="5"
                    max="120"
                    step="1"
                    placeholder="15"
                  />
                  <span className="text-white/40 text-sm">min grace</span>
                </div>
                <button
                  onClick={saveIdleFee}
                  disabled={idleFeeSaving || !idleFeeInput || !idleGraceInput || parseInt(idleFeeInput) < 0 || parseInt(idleFeeInput) > 500 || parseInt(idleGraceInput) < 5 || parseInt(idleGraceInput) > 120}
                  className={`rounded-xl px-5 py-2.5 text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    idleFeeSaved
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-blue-600 hover:bg-blue-500 text-on-accent'
                  }`}
                >
                  {idleFeeSaving ? 'Saving…' : idleFeeSaved ? '✓ Saved' : 'Update Fee'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Portal access log — operator (super-admin) support access to this building */}
        <div>
          <h2 className="text-white font-semibold mb-3">Portal Access Log</h2>
          <div className="bg-white/4 border border-white/10 rounded-2xl p-4">
            <p className="text-white/40 text-xs mb-3">
              A record of any 2020EV support ("view-as") access to your portal. You see everything we do.
            </p>
            {accessLog.length === 0 ? (
              <p className="text-white/40 text-sm">No support access recorded.</p>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {accessLog.map(row => (
                  <div key={row.id} className="flex items-center justify-between text-xs border-b border-white/5 pb-1.5">
                    <span className="text-white/70">
                      {row.action.startsWith('impersonation_started')
                        ? <span className="text-purple-300">🔑 Support session started{row.action.includes(':') ? ` — ${row.action.split(':').slice(1).join(':').trim()}` : ''}</span>
                        : <span className="font-mono">{row.action}</span>}
                    </span>
                    <span className="text-white/35 flex-shrink-0 ml-3">
                      {row.operator_name || 'operator'} · {new Date(row.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
