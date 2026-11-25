# WhatsApp setup

AmaniCare sends login codes, clinic confirmation requests and payment notices on WhatsApp through
Meta's **WhatsApp Business Cloud API**, and receives the clinics' **Confirmer / Rejeter** taps and
delivery receipts on its webhook (`/api/webhooks/whatsapp`).

## 1. Meta accounts and the app

1. Go to <https://developers.facebook.com>, log in with Facebook and register as a developer.
2. **My Apps → Create app**. Use case: **Other** → type **Business**. Name it `AmaniCare`, and
   create or pick a **Business portfolio** (e.g. *Amani Consulting Group LLC*).
3. In the app, **Add product → WhatsApp → Set up**. Meta creates a **test phone number** and a
   test WhatsApp Business Account.
4. In **WhatsApp → API Setup**, note the **Phone number ID**, and under **To**, add and verify the
   phone numbers that will receive test messages (up to 5, e.g. your own WhatsApp number).

## 2. Credentials (for `.env`)

| `.env` | Where to find it |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → *Phone number ID* |
| `WHATSAPP_TOKEN` | For a quick test: the *temporary access token* on API Setup (expires in 24 h). For real use: **Business settings → Users → System users → Add** (role Admin) → **Assign assets**: the AmaniCare app (full control) and the WhatsApp account → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry **Never**. |
| `WHATSAPP_APP_SECRET` | App settings → Basic → *App secret* (Show) |
| `WHATSAPP_VERIFY_TOKEN` | Any long random text you choose; you type the same text in Meta in step 4 |
| `WHATSAPP_API_VERSION` | The newest version shown in the API Setup sample request (e.g. `v23.0`) |

Then set `MESSAGING=whatsapp` and restart the app.

## 3. A public address for the webhook

Meta must reach your app over HTTPS. Once AmaniCare is deployed, use its address. On your own
computer, use a tunnel:

```powershell
scoop install cloudflared
cloudflared tunnel --url http://localhost:3000
```

It prints an address like `https://words-words.trycloudflare.com`. Put it in `.env` as `BASE_URL`
(used in invite messages). The address changes every time the tunnel restarts; then update it in
step 4 and in `.env` again.

## 4. Connect the webhook

WhatsApp → **Configuration → Webhook → Edit**:
- **Callback URL:** `https://<your address>/api/webhooks/whatsapp`
- **Verify token:** the same text as `WHATSAPP_VERIFY_TOKEN`
- **Verify and save** (the app must be running), then **Manage** → subscribe to **messages**.

## 5. Message templates

WhatsApp only delivers messages that AmaniCare starts if they use a template Meta has approved.
Create these in **WhatsApp Manager → Message templates → Create template**. Names, languages,
variables and button order must match exactly. Meta lets you pick one language at a time: create
the French version, then create the English one with the same name. Use plain **French** and
**English** (not English (US) etc.), and variable type **Number**. A template can't start or end
with a variable (a final "." doesn't count), which is why some texts end with a short sentence. Approval usually takes minutes, sometimes hours.

### `amanicare_login_code`: Authentication, French and English
Meta only allows authentication templates once the business portfolio is **verified**
("This WhatsApp business account does not have permission to create message template").
Until then, set `WHATSAPP_LOGIN_CODES=0` in `.env`: login codes stay in the outbox (shown on screen
with `OTP_DEV=1`) and every other message goes out on WhatsApp. Create this template after verification.

Choose **Authentication** → **Copy code**. Add the security recommendation and an expiry of
**10 minutes**. Meta writes the text itself.

### `amanicare_clinic_request`: Utility, French
```
🏥 Demande de paiement AmaniCare
Patient : {{1}}
Facture : {{2}}
Montant : {{3}}
{{4}}
Confirmez-vous ce patient et ce montant ?
```
Buttons: **Quick reply** `✅ Confirmer`, then **Quick reply** `❌ Rejeter` (in this order).
Samples: `Josephine K.` · `CME-0457` · `$23.00` · `Payé par un membre de la famille à l'étranger.`

### `amanicare_bill_confirmed`: Utility, French and English
- fr: `AmaniCare : {{1}} a confirmé la facture de {{2}} ({{3}}). Ouvrez l'application pour payer.`
- en: `AmaniCare: {{1}} confirmed {{2}}'s bill ({{3}}). Open the app to pay.`

Samples: `Centre Médical Espoir` · `Josephine K.` · `$23.00`

### `amanicare_clinic_paid`: Utility, French
`💰 AmaniCare : {{1}} envoyé sur {{2}}. Réf {{3}}. Patient : {{4}}. La facture est réglée.`

Samples: `$23.00` · `Bank ••4821` · `SBX-P-1A2B3C4D` · `Josephine K.`

### `amanicare_bill_update`: Utility, French and English
- fr: `AmaniCare : la facture de {{1}} est {{2}}. Ouvrez l'application pour les détails.`
- en: `AmaniCare: {{1}}'s bill is {{2}}. Open the app for details.`

Samples: `Josephine K.` · `payée à la clinique` (en: `paid to the clinic`)

### `amanicare_invite`: Utility, French and English
- fr: `Bonjour ! {{1}} vous invite sur AmaniCare pour payer directement vos factures d'hôpital. Ouvrez ce lien pour accepter l'invitation : {{2}} Inscrivez-vous comme famille avec ce numéro de téléphone.`
- en: `Hello! {{1}} invites you to AmaniCare to pay your hospital bills directly. Open this link to accept the invitation: {{2}} Sign up as family with this phone number.`

Samples: `Alain` · `https://amanicare.example/?invite=A1B2C3`

The invitation is a link: opening it and logging in accepts the invitation automatically. Don't
mention a "code" in this template: Meta then classifies it as an authentication message.
Meta may re-classify it as *Marketing* (higher price, and recipients can opt out). The app works
either way.

### `amanicare_invite_abroad`: Marketing, French and English
Sent when a relative in the DRC invites someone abroad to help pay.
- fr: `Bonjour ! {{1}} vous demande de l'aide sur AmaniCare pour payer des factures d'hôpital en RDC, directement à l'hôpital. Ouvrez ce lien pour accepter l'invitation : {{2}} Inscrivez-vous comme personne vivant à l'étranger avec ce numéro de téléphone.`
- en: `Hello! {{1}} is asking for your help on AmaniCare to pay hospital bills in the DRC, directly to the hospital. Open this link to accept the invitation: {{2}} Sign up as someone living abroad with this phone number.`

Samples: `Maman Jeanne` · `https://amanicare.example/?invite=A1B2C3&as=payer`

Invitation links now end in `&as=family` or `&as=payer` (which side is signing up). The template
variable is the whole link, so the already-submitted `amanicare_invite` template doesn't change.

### `amanicare_support_reply`: Utility, French and English
Sent when someone on the team answers a customer-service conversation (in the app, or on WhatsApp
more than 24 h after the person's last message). The variable is only the request number: Meta
refuses a Utility template whose variable could be any text (the answer itself is in the app).
- fr: `AmaniCare : votre demande d'assistance {{1}} a reçu une réponse. Ouvrez myamanicare.com et touchez le bouton ? pour la lire.`
- en: `AmaniCare: your support request {{1}} has a reply. Open myamanicare.com and tap the ? button to read it.`

Sample: `S-1A2B3C`

### `amanicare_support_alert`: Utility, French and English
Sent to every active admin when a conversation needs a person.
- fr: `AmaniCare : la demande d'assistance {{1}} attend une réponse. Ouvrez l'onglet Support pour y répondre.`
- en: `AmaniCare: support request {{1}} is waiting for an answer. Open the Support tab to reply.`

Sample: `S-1A2B3C`

### Customer service on WhatsApp
A written message to the business number (anything that is not a button tap) goes to customer
service: the assistant answers on WhatsApp, or hands over to the team (Support tab). Replies within
24 h of the person's last message are free text; later ones use `amanicare_support_reply`.

Lingala and Swahili users receive the French templates until Lingala/Swahili versions are added
(add the language in Meta, then add it to `languages` in `server/messaging/index.ts`).

## 6. Test

1. In **Admin → Clinics**, set one clinic's WhatsApp number to your own (it must be one of the
   test recipients from step 1).
2. Submit a bill for that clinic as a family member: your WhatsApp receives the request with
   **✅ Confirmer / ❌ Rejeter**. Tap **Confirmer**: the bill moves to *Waiting for payer*.
3. **Admin → Messages** shows each message as *sent → delivered → read*, or *failed* with Meta's
   error (most often a template that isn't approved yet or a name that doesn't match).

`OTP_DEV=1` still shows login codes on screen too, so you can't lock yourself out while testing.

## Going live

Business verification of the portfolio, a real phone number (not used on the WhatsApp app),
display name approval, and payment details on the WhatsApp account. Meta charges per message
(authentication and utility templates have different prices per country).
