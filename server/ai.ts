// Reads a bill photo with Claude (Anthropic Messages API). Returns null when AI is not configured
// or fails, so the app always falls back to manual entry. The AI never makes decisions: it only
// turns a photo into structured data that the deterministic rules in screening.ts then check.
import * as Sentry from '@sentry/node';
import { config } from './config.js';
import type { AiBill } from './types.js';

const PROMPT = `You are reading a photo of a medical bill (facture) from a clinic or hospital in the Democratic Republic of the Congo. It is usually in French.
Return ONLY a JSON object, no other text:
{"clinic_name": string, "bill_number": string, "date": "YYYY-MM-DD" or "", "patient_name": string,
 "currency": "USD" or "CDF", "items": [{"description": string, "qty": number, "unit_price": number}],
 "total": number,
 "tamper_flags": [short English strings describing visible signs of editing or forgery, e.g. "total written over in different ink", "mismatched fonts", "photo of a screen", "no stamp or signature"],
 "confidence": number between 0 and 1}
Rules: copy what is written; do not invent items or prices. If a field is unreadable use "" or 0.
If the image is not a medical bill, return "items": [] and "confidence": 0.`;

export async function extractBill(imageBase64: string, mediaType = 'image/jpeg'): Promise<AiBill | null> {
  if (!config.anthropicKey) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      console.error('[ai] Anthropic API error', res.status, (await res.text()).slice(0, 300));
      Sentry.captureMessage(`Anthropic API error ${res.status}`, { level: 'warning', tags: { area: 'ai' } });
      return null;
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
    return sanitize(parseJson(text));
  } catch (e) {
    console.error('[ai] extraction failed:', (e as Error).message);
    Sentry.captureException(e, { level: 'warning', tags: { area: 'ai' } });
    return null;
  }
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Never trust model output blindly: coerce types and bound sizes.
export function sanitize(input: unknown): AiBill | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, any>;
  const str = (v: unknown, n = 120) => String(v ?? '').slice(0, n);
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  return {
    clinic_name: str(o.clinic_name),
    bill_number: str(o.bill_number, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '',
    patient_name: str(o.patient_name),
    currency: o.currency === 'CDF' ? 'CDF' : 'USD',
    items: (Array.isArray(o.items) ? o.items : []).slice(0, 40).map((i: any) => ({
      description: str(i?.description),
      qty: Math.max(1, Math.round(num(i?.qty) || 1)),
      unit_price: num(i?.unit_price),
    })).filter((i: { description: string }) => i.description),
    total: num(o.total),
    tamper_flags: (Array.isArray(o.tamper_flags) ? o.tamper_flags : []).slice(0, 6).map((f: unknown) => str(f, 160)),
    confidence: Math.min(1, num(o.confidence)),
  };
}
