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
variables and button order must match exactly. Approval usually takes minutes, sometimes hours.

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
`💰 AmaniCare : {{1}} envoyé sur {{2}}. Réf {{3}}. Patient : {{4}}. Le patient peut sortir.`

Samples: `$23.00` · `Bank ••4821` · `SBX-P-1A2B3C4D` · `Josephine K.`

### `amanicare_bill_update`: Utility, French and English
- fr: `AmaniCare : facture de {{1}} – {{2}}.`
- en: `AmaniCare: {{1}}'s bill – {{2}}.`

Samples: `Josephine K.` · `payée à la clinique` (en: `paid to the clinic`)

### `amanicare_invite`: Utility, French and English
- fr: `Bonjour ! {{1}} vous invite sur AmaniCare pour payer directement vos factures d'hôpital. Ouvrez {{2}}, inscrivez-vous comme famille avec ce numéro et entrez le code {{3}}.`
- en: `Hello! {{1}} invites you to AmaniCare to pay your hospital bills directly. Open {{2}}, sign up as family with this number, and enter the code {{3}}.`

Samples: `Alain` · `https://amanicare.example` · `A1B2C3`

Meta may re-classify this one as *Marketing* (higher price, and recipients can opt out). The app
works either way.

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
