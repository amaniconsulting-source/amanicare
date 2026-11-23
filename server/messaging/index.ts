// Outbound messages (login codes, clinic confirmation requests, payment notices, invites).
// 'sandbox' stores messages in the outbox table (admins can read them in the app).
// 'whatsapp' sends through the WhatsApp Business Cloud API and also logs to the outbox.
//
// WhatsApp only delivers a business-initiated message as an approved *template*. Every
// notification below therefore has a template (name + language + parameters). The template
// texts to create in Meta's WhatsApp Manager are in docs/whatsapp-setup.md; keep them in step
// with the texts here (which are what the outbox shows and what sandbox mode "sends").
import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { run } from '../db.js';

export interface Button { id: string; title: string }
export interface Template {
  name: string;
  language: string;
  body: string[];
  /** Quick-reply button payloads, in the order of the template's buttons. */
  quickReplies?: string[];
  /** Authentication templates: the code for the "copy code" button. */
  copyCode?: string;
}
/** A WhatsApp list: one button that opens up to 10 choices. Only sent as a reply (within 24 h of the person's last message). */
export interface ListChoice { id: string; title: string; description?: string }
export interface OutboundMessage {
  to: string; text: string; buttons?: Button[]; kind?: string; template?: Template;
  list?: { button: string; choices: ListChoice[] };
}

type Params = Record<string, any>;
type Texts = { fr: (p: Params) => string } & Partial<Record<'en' | 'ln' | 'sw', (p: Params) => string>>;

interface Notification {
  texts: Texts;
  /** Template name in WhatsApp Manager, and the languages it was created in (first = fallback). */
  template: { name: string; languages: ('fr' | 'en')[]; body: (p: Params) => unknown[]; auth?: boolean };
}

const NOTIFICATIONS = {
  otp: {
    texts: {
      fr: (p) => `AmaniCare : votre code est ${p.code}. Il expire dans 10 minutes. Ne le partagez avec personne.`,
      en: (p) => `AmaniCare: your code is ${p.code}. It expires in 10 minutes. Don't share it with anyone.`,
      ln: (p) => `AmaniCare : code na yo ezali ${p.code}. Ekosila na miniti 10. Kopesa yango na moto te.`,
      sw: (p) => `AmaniCare: nambari yako ni ${p.code}. Itaisha baada ya dakika 10. Usimpe mtu yeyote.`,
    },
    // Authentication template: WhatsApp writes the text itself; we only pass the code.
    template: { name: 'amanicare_login_code', languages: ['fr', 'en'], body: (p) => [p.code], auth: true },
  },
  clinicRequest: {
    texts: {
      fr: (p) => `🏥 Demande de paiement AmaniCare\nPatient : ${p.patient}\nFacture : ${p.billNumber}\nMontant : ${p.amount}\n${p.note}\nConfirmez-vous ce patient et ce montant ?`,
      en: (p) => `🏥 AmaniCare payment request\nPatient: ${p.patient}\nBill: ${p.billNumber}\nAmount: ${p.amount}\n${p.note}\nDo you confirm this patient and amount?`,
      ln: (p) => `🏥 Lisengi ya kofuta AmaniCare\nMobeli : ${p.patient}\nFacture : ${p.billNumber}\nMotango : ${p.amount}\n${p.note}\nOndimi mobeli oyo mpe motango oyo?`,
    },
    template: { name: 'amanicare_clinic_request', languages: ['fr'], body: (p) => [p.patient, p.billNumber, p.amount, p.note] },
  },
  payerApprove: {
    texts: {
      fr: (p) => `AmaniCare : ${p.clinic} a confirmé la facture de ${p.patient} (${p.amount}). Ouvrez l'application pour payer.`,
      en: (p) => `AmaniCare: ${p.clinic} confirmed ${p.patient}'s bill (${p.amount}). Open the app to pay.`,
      ln: (p) => `AmaniCare : ${p.clinic} endimi facture ya ${p.patient} (${p.amount}). Fungola application mpo na kofuta.`,
    },
    template: { name: 'amanicare_bill_confirmed', languages: ['fr', 'en'], body: (p) => [p.clinic, p.patient, p.amount] },
  },
  clinicPaid: {
    texts: {
      fr: (p) => `💰 AmaniCare : ${p.amount} envoyé sur ${p.account}. Réf ${p.ref}. Patient : ${p.patient}. Le patient peut sortir.`,
      en: (p) => `💰 AmaniCare: ${p.amount} sent to ${p.account}. Ref ${p.ref}. Patient: ${p.patient}. The patient may be discharged.`,
      ln: (p) => `💰 AmaniCare : ${p.amount} etindami na ${p.account}. Ref ${p.ref}. Mobeli : ${p.patient}. Mobeli akoki kobima.`,
    },
    template: { name: 'amanicare_clinic_paid', languages: ['fr'], body: (p) => [p.amount, p.account, p.ref, p.patient] },
  },
  inviteAbroad: {
    // A relative in the DRC asks someone abroad to help pay hospital bills.
    texts: {
      fr: (p) => `Bonjour ! ${p.name} vous demande de l'aide sur AmaniCare pour payer des factures d'hôpital en RDC, directement à l'hôpital. Ouvrez ce lien pour accepter l'invitation : ${p.link} Inscrivez-vous comme personne vivant à l'étranger avec ce numéro de téléphone.`,
      en: (p) => `Hello! ${p.name} is asking for your help on AmaniCare to pay hospital bills in the DRC, directly to the hospital. Open this link to accept the invitation: ${p.link} Sign up as someone living abroad with this phone number.`,
      ln: (p) => `Mbote! ${p.name} azali kosenga lisalisi na yo na AmaniCare mpo na kofuta ba facture ya lopitalo na RDC, mbala moko na lopitalo. Fungola lien oyo mpo na kondima libyangi: ${p.link} Komisa nkombo lokola moto oyo afandi na mboka mopaya, na nimero ya telefone oyo.`,
    },
    template: { name: 'amanicare_invite_abroad', languages: ['fr', 'en'], body: (p) => [p.name, p.link] },
  },
  familyUpdate: {
    texts: {
      // WhatsApp templates can't end with a variable, hence the closing sentence.
      fr: (p) => `AmaniCare : la facture de ${p.patient} est ${p.status}. Ouvrez l'application pour les détails.`,
      en: (p) => `AmaniCare: ${p.patient}'s bill is ${p.status}. Open the app for details.`,
      ln: (p) => `AmaniCare : facture ya ${p.patient} – ${p.status}. Fungola application mpo na koyeba makambo nyonso.`,
      sw: (p) => `AmaniCare: bili ya ${p.patient} – ${p.status}. Fungua programu kwa maelezo zaidi.`,
    },
    template: { name: 'amanicare_bill_update', languages: ['fr', 'en'], body: (p) => [p.patient, p.status] },
  },
  invite: {
    texts: {
      // The invitation is a link (…/?invite=CODE), not a code to type: simpler for families, and
      // Meta classifies any template mentioning a "code" as an authentication message.
      fr: (p) => `Bonjour ! ${p.name} vous invite sur AmaniCare pour payer directement vos factures d'hôpital. Ouvrez ce lien pour accepter l'invitation : ${p.link} Inscrivez-vous comme famille avec ce numéro de téléphone.`,
      en: (p) => `Hello! ${p.name} invites you to AmaniCare to pay your hospital bills directly. Open this link to accept the invitation: ${p.link} Sign up as family with this phone number.`,
      ln: (p) => `Mbote! ${p.name} abengi yo na AmaniCare mpo na kofuta ba facture na yo ya lopitalo mbala moko. Fungola lien oyo mpo na kondima libyangi: ${p.link} Komisa nkombo lokola libota, na nimero ya telefone oyo.`,
    },
    template: { name: 'amanicare_invite', languages: ['fr', 'en'], body: (p) => [p.name, p.link] },
  },
} satisfies Record<string, Notification>;

export type TextKey = keyof typeof NOTIFICATIONS;

export function text(key: TextKey, lang: string, params: Params): string {
  const t: Texts = NOTIFICATIONS[key].texts;
  return (t[lang as keyof Texts] || t.fr)(params);
}

// Template parameters must be non-empty single lines.
const param = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || '—';

export function template(key: TextKey, lang: string, params: Params, buttons?: Button[]): Template {
  const tpl: Notification['template'] = NOTIFICATIONS[key].template;
  const language = tpl.languages.includes(lang as 'fr' | 'en') ? lang : tpl.languages[0];
  return {
    name: config.whatsapp.templatePrefix + tpl.name,
    language,
    body: tpl.body(params).map(param),
    quickReplies: buttons?.map((b) => b.id),
    copyCode: tpl.auth ? String(params.code) : undefined,
  };
}

/** Sends one of the notifications above (text in sandbox, template on WhatsApp). */
export function notify(key: TextKey, opts: { to: string; lang: string; params: Params; buttons?: Button[]; kind: string }): Promise<string> {
  return send({
    to: opts.to, kind: opts.kind, buttons: opts.buttons,
    text: text(key, opts.lang, opts.params),
    template: template(key, opts.lang, opts.params, opts.buttons),
  });
}

function whatsappBody(to: string, msg: OutboundMessage): Record<string, unknown> {
  const phone = to.replace(/[^\d]/g, '');
  if (msg.template && config.whatsapp.useTemplates) {
    const t = msg.template;
    const components: Record<string, unknown>[] = [{ type: 'body', parameters: t.body.map((text) => ({ type: 'text', text })) }];
    if (t.copyCode) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.copyCode }] });
    t.quickReplies?.forEach((payload, i) =>
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }));
    return { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: t.name, language: { code: t.language }, components } };
  }
  // Free-form messages: only delivered within 24 h of the recipient's last message to us.
  if (msg.list) {
    return {
      messaging_product: 'whatsapp', to: phone, type: 'interactive',
      interactive: {
        type: 'list', body: { text: msg.text.slice(0, 1024) },
        action: {
          button: msg.list.button.slice(0, 20),
          sections: [{ title: 'AmaniCare', rows: msg.list.choices.slice(0, 10).map((c) => ({ id: c.id, title: c.title.slice(0, 24), description: c.description?.slice(0, 72) })) }],
        },
      },
    };
  }
  return msg.buttons?.length
    ? {
        messaging_product: 'whatsapp', to: phone, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg.text.slice(0, 1024) },
          action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      }
    : { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: msg.text.slice(0, 4096) } };
}

/** Returns WhatsApp's message id, used to match delivery receipts. */
async function sendWhatsApp(msg: OutboundMessage): Promise<string | null> {
  const w = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/${w.apiVersion}/${w.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(whatsappBody(msg.to, msg)),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[] };
  return data.messages?.[0]?.id ?? null;
}

export async function send(msg: OutboundMessage): Promise<string> {
  const channel = config.messaging === 'whatsapp' && (msg.kind !== 'otp' || config.whatsapp.loginCodes) ? 'whatsapp' : 'sandbox';
  let status = 'stored';
  let providerId: string | null = null;
  let error: string | null = null;
  if (channel === 'whatsapp') {
    try { providerId = await sendWhatsApp(msg); status = 'sent'; }
    catch (e) {
      error = (e as Error).message;
      console.error('[messaging]', error);
      // Message text can contain codes and patient names: report the failure only.
      Sentry.captureException(e, { tags: { area: 'messaging', kind: msg.kind || 'info', template: msg.template?.name } });
      status = 'failed';
    }
  }
  await run('INSERT INTO messages(to_phone, channel, body, payload, status, provider_id, error) VALUES($1,$2,$3,$4,$5,$6,$7)',
    msg.to, channel, msg.kind === 'otp' && config.production ? '[OTP code hidden]' : msg.text,
    JSON.stringify({ kind: msg.kind || 'info', buttons: msg.buttons || [], template: msg.template?.name }), status, providerId, error);
  return status;
}

/** Delivery receipts from the WhatsApp webhook: sent → delivered → read, or failed. */
export async function updateDelivery(providerId: string, status: string, error?: string): Promise<void> {
  const rank = ['sent', 'delivered', 'read'];
  // Receipts can arrive out of order: never move a message backwards (e.g. read → delivered).
  await run(`UPDATE messages SET status = $2, error = COALESCE($3, error) WHERE provider_id = $1 AND status <> 'failed'
    AND ($2 = 'failed' OR COALESCE(array_position($4::text[], status), 0) < COALESCE(array_position($4::text[], $2), 0))`,
  providerId, status, error ?? null, rank);
}
