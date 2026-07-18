/**
 * AI assistant — resident billing Q&A + admin monthly summary.
 *
 * Provider-switchable so we can burn OpenAI credits first, then move to Claude.
 * Selection (see resolveProvider):
 *   - AI_PROVIDER=openai|anthropic forces a provider (only if that key is set)
 *   - otherwise: prefer OpenAI when OPENAI_API_KEY is set, else Anthropic
 * Dormant (isConfigured() === false) until at least one provider key is present,
 * so the routes return 503 and the app runs fine without any AI key.
 *
 * To switch OpenAI → Claude later: set AI_PROVIDER=anthropic (and ANTHROPIC_API_KEY)
 * in Railway, or just remove OPENAI_API_KEY. No redeploy needed.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type OpenAIType from 'openai';

// Claude is the preferred model for this once we switch; OpenAI model is whatever
// credits you have — override with OPENAI_MODEL (default is a cheap, capable chat model).
const ANTHROPIC_MODEL = 'claude-opus-4-8';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

type Provider = 'anthropic' | 'openai';

function resolveProvider(): Provider | null {
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (forced === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : null;
  if (forced === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  // Auto: burn OpenAI credits first, fall back to Claude.
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export function isConfigured(): boolean {
  return resolveProvider() !== null;
}

/** Which provider is currently active ('openai' | 'anthropic' | null). Safe to expose. */
export function activeProvider(): Provider | null {
  return resolveProvider();
}

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAIType | null = null;

/** Single completion call, dispatched to whichever provider is active. */
async function complete(system: string, user: string, maxTokens: number): Promise<string> {
  const provider = resolveProvider();
  if (provider === 'anthropic') {
    if (!anthropicClient) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      anthropicClient = new SDK(); // reads ANTHROPIC_API_KEY
    }
    const msg = await anthropicClient.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  if (provider === 'openai') {
    if (!openaiClient) {
      const { default: SDK } = await import('openai');
      openaiClient = new SDK(); // reads OPENAI_API_KEY
    }
    // No token cap / temperature sent — model families differ on those params;
    // length is constrained by the prompt instead, for max cross-model compatibility.
    const resp = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return (resp.choices[0]?.message?.content ?? '').trim();
  }
  throw new Error('No AI provider configured');
}

export interface AssistantContext {
  balanceDollars: number;
  rateCentsPerKwh: number;
  transactions: Array<{
    date: string;
    type: string;
    description: string;
    kwh: number | null;
    amountDollars: number;
  }>;
}

/** Answer a resident's question about their own charging/wallet, grounded in their data. */
export async function askBillingAssistant(ctx: AssistantContext, question: string): Promise<string> {
  const txLines = ctx.transactions.length
    ? ctx.transactions
        .map((t) =>
          `- ${t.date}: ${t.type}${t.kwh != null ? ` · ${t.kwh.toFixed(2)} kWh` : ''} · ` +
          `${t.amountDollars < 0 ? '-' : '+'}$${Math.abs(t.amountDollars).toFixed(2)} — ${t.description}`)
        .join('\n')
    : '(no transactions yet)';

  const system =
    'You are the assistant for 2020EV, an app that lets condo residents share one EV charger. ' +
    'Answer the resident’s question about THEIR charging and wallet using only the data below. ' +
    'Be concise (a few sentences), warm, and specific with real numbers and dates. Charges are billed ' +
    'automatically from the charger at the building’s electricity rate; the balance is prepaid and topped ' +
    'up by the building admin. If the data does not contain the answer, say so plainly and suggest ' +
    'contacting the building admin. Never invent charges, amounts, or dates.\n\n' +
    `Current balance: $${ctx.balanceDollars.toFixed(2)}\n` +
    `Electricity rate: ${ctx.rateCentsPerKwh}¢/kWh\n` +
    `Recent transactions (newest first):\n${txLines}`;

  return complete(system, question, 1024);
}

export interface MonthSummaryInput {
  monthLabel: string;
  rateCentsPerKwh: number;
  totals: { residents: number; sessions: number; total_kwh: number; recovered_cents: number };
  rows: Array<{ name: string; sessions: number; total_kwh: number; billed_cents: number }>;
}

/** Write a short plain-English summary of the month for the building admin/board. */
export async function summarizeMonth(input: MonthSummaryInput): Promise<string> {
  const rows = input.rows
    .map((r) => `- ${r.name}: ${r.sessions} sessions, ${r.total_kwh.toFixed(1)} kWh, $${(r.billed_cents / 100).toFixed(2)}`)
    .join('\n');

  const system =
    'You write the monthly EV-charging summary for a condo building manager. Two or three short ' +
    'paragraphs, plain and factual — total electricity recovered, how usage compares across residents, ' +
    'and anything worth the board’s attention (heavy users, unusually quiet month). Use only the data ' +
    'given; do not invent figures. No greeting or sign-off.';

  const user =
    `Month: ${input.monthLabel}\n` +
    `Rate: ${input.rateCentsPerKwh}¢/kWh\n` +
    `Totals: ${input.totals.residents} residents charged, ${input.totals.sessions} sessions, ` +
    `${input.totals.total_kwh.toFixed(1)} kWh, $${(input.totals.recovered_cents / 100).toFixed(2)} recovered\n` +
    `Per resident:\n${rows || '(no activity)'}`;

  return complete(system, user, 1024);
}
