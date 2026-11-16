// Outbound messages (OTP codes, clinic confirmation requests, payment notices).
// 'sandbox' stores messages in the outbox table (admins can read them in the app).
// 'whatsapp' sends through the WhatsApp Business Cloud API and also logs to the outbox.
import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { run } from '../db.js';

export interface Button { id: string; title: string }
export interface OutboundMessage { to: string; text: string; buttons?: Button[]; kind?: string }

async function sendWhatsApp(to: string, text: string, buttons?: Button[]): Promise<void> {
  const w = config.whatsapp;
  const url = `https://graph.facebook.com/${w.apiVersion}/${w.phoneNumberId}/messages`;
  const phone = to.replace(/[^\d]/g, '');
  // Note: outside a 24 h customer-service window, WhatsApp requires pre-approved templates.
  // Register templates for OTP and payment requests before going live.
  const body = buttons?.length
    ? {
        messaging_product: 'whatsapp', to: phone, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: text.slice(0, 1024) },
          action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      }
    : { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text.slice(0, 4096) } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function send(msg: OutboundMessage): Promise<string> {
  const channel = config.messaging === 'whatsapp' ? 'whatsapp' : 'sandbox';
  let status = 'stored';
  if (channel === 'whatsapp') {
    try { await sendWhatsApp(msg.to, msg.text, msg.buttons); status = 'sent'; }
    catch (e) {
      console.error('[messaging]', (e as Error).message);
      // Message text can contain codes and patient names: report the failure only.
      Sentry.captureException(e, { tags: { area: 'messaging', kind: msg.kind || 'info' } });
      status = 'failed';
    }
  }
  await run('INSERT INTO messages(to_phone, channel, body, payload, status) VALUES($1,$2,$3,$4,$5)',
    msg.to, channel, msg.kind === 'otp' && config.production ? '[OTP code hidden]' : msg.text,
    JSON.stringify({ kind: msg.kind || 'info', buttons: msg.buttons || [] }), status);
  return status;
}

// Short localized notification texts. French is the fallback for Lingala/Swahili where a phrase is missing.
type Params = Record<string, any>;
type Texts = { fr: (p: Params) => string } & Partial<Record<'en' | 'ln' | 'sw', (p: Params) => string>>;

const T = {
  otp: {
    fr: (p) => `AmaniCare : votre code est ${p.code}. Il expire dans 10 minutes. Ne le partagez avec personne.`,
    en: (p) => `AmaniCare: your code is ${p.code}. It expires in 10 minutes. Don't share it with anyone.`,
    ln: (p) => `AmaniCare : code na yo ezali ${p.code}. Ekosila na miniti 10. Kopesa yango na moto te.`,
    sw: (p) => `AmaniCare: nambari yako ni ${p.code}. Itaisha baada ya dakika 10. Usimpe mtu yeyote.`,
  },
  clinicRequest: {
    fr: (p) => `🏥 Demande de paiement AmaniCare\nPatient : ${p.patient}\nFacture : ${p.billNumber}\nMontant : ${p.amount}\nPayé par un membre de la famille à l'étranger.${p.warn ? '\n⚠️ Merci de vérifier attentivement cette facture.' : ''}\nConfirmez-vous ce patient et ce montant ?`,
    en: (p) => `🏥 AmaniCare payment request\nPatient: ${p.patient}\nBill: ${p.billNumber}\nAmount: ${p.amount}\nPaid by a family member abroad.${p.warn ? '\n⚠️ Please check this bill carefully.' : ''}\nDo you confirm this patient and amount?`,
  },
  payerApprove: {
    fr: (p) => `AmaniCare : ${p.clinic} a confirmé la facture de ${p.patient} (${p.amount}). Ouvrez l'application pour payer.`,
    en: (p) => `AmaniCare: ${p.clinic} confirmed ${p.patient}'s bill (${p.amount}). Open the app to pay.`,
  },
  clinicPaid: {
    fr: (p) => `💰 AmaniCare : ${p.amount} envoyé sur ${p.account}. Réf ${p.ref}. Patient : ${p.patient}. Le patient peut sortir.`,
    en: (p) => `💰 AmaniCare: ${p.amount} sent to ${p.account}. Ref ${p.ref}. Patient: ${p.patient}. The patient may be discharged.`,
  },
  familyUpdate: {
    fr: (p) => `AmaniCare : facture de ${p.patient} – ${p.status}.`,
    en: (p) => `AmaniCare: ${p.patient}'s bill – ${p.status}.`,
    ln: (p) => `AmaniCare : facture ya ${p.patient} – ${p.status}.`,
    sw: (p) => `AmaniCare: bili ya ${p.patient} – ${p.status}.`,
  },
} satisfies Record<string, Texts>;

export type TextKey = keyof typeof T;

export function text(key: TextKey, lang: string, params: Params): string {
  const t: Texts = T[key];
  return (t[lang as keyof Texts] || t.fr)(params);
}
