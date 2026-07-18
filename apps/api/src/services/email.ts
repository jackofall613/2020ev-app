/**
 * Transactional email via Resend's HTTP API (no SDK dependency — plain fetch).
 *
 * Dormant until RESEND_API_KEY is set in the environment. While dormant,
 * sendEmail() resolves false and callers degrade gracefully (e.g. the
 * forgot-password endpoint still answers 200 without revealing anything).
 *
 * Setup (one-time, ~5 min):
 *   1. Create a free Resend account (resend.com) and verify the 2020ev.app
 *      domain (they show the exact DNS records to add in Squarespace).
 *   2. Railway → API service → set RESEND_API_KEY (and optionally EMAIL_FROM).
 * No redeploy logic needed — the env var is read per call.
 */

const RESEND_URL = 'https://api.resend.com/emails';

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const from = process.env.EMAIL_FROM || '2020EV <support@2020ev.app>';
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Resend rejected send:', res.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[email] send failed:', err?.message);
    return false;
  }
}
