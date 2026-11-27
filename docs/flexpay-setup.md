# FlexPaie pilot (proof of concept)

AmaniCare uses FlexPaie (formerly FlexPay) for the pilot while the bank partnership is set up. FlexPaie is
a Congolese payment aggregator (INFOSET SARL, authorized by the Banque Centrale du Congo): one API for
M-Pesa, Orange Money, Airtel Money, Afrimoney and Visa/Mastercard. The code is in `server/payments/flexpay.ts`.

The adapter follows FlexPaie's **API de Paiement Corporate v2.0** and **API de Vérification de Transaction
v2.0** (23 May 2026), received 27 Nov 2026. Those documents are confidential (Infoset SARL): keep them out of
this repository and share them only with people FlexPaie allows.

## How the money moves

Chosen per hospital in **Admin → Hospitals → FlexPay setup**:

1. **Direct (preferred).** The hospital has its own FlexPaie merchant code. The payer's money goes
   straight into the hospital's FlexPaie account; the hospital withdraws to its bank or wallet whenever
   it wants. AmaniCare never holds the money and there is no payout step. AmaniCare's fee: to agree with
   FlexPaie (see below).
2. **Through AmaniCare.** No merchant code yet. The money is collected into AmaniCare's merchant account,
   then sent to the hospital's **mobile-money payout number**. The payout API is **not in the v2.0
   documents**: until FlexPaie sends it (`FLEXPAY_PAYOUT_URL`), these bills end in *payout failed* with a
   clear reason, and an admin pays the hospital by hand from the FlexPaie dashboard.

Payers choose **bank card** (FlexPaie's secure card page) or **M-Pesa / Orange Money / Airtel Money**
(a request on their phone, approved with their PIN). Amounts are sent in **USD**.

## The API, as documented

| Step | Call | Notes |
|---|---|---|
| Mobile money | `POST <base>/api/rest/v1/paymentService` | `merchant`, `type: "1"`, `reference` (our payment id), `phone` (digits, e.g. 243891234567), `amount`, `currency`, `callback_url` |
| Card | same URL | `type: "2"`, plus `approve_url`, `cancel_url`, `decline_url`; the answer's `url` is FlexPaie's card page |
| Answer | | `code` "0" = request accepted, plus FlexPaie's `orderNumber` |
| Result | FlexPaie POSTs to `callback_url` | `code` "0" = success; `amount`, `amountCustomer` (what the payer paid, fees included), `channel` |
| Check | `GET <checkBase>/api/rest/v1/check/{orderNumber}` | `transaction.status`: 0 success, 1 failed, 2 pending, 3 to be refunded, 4 refunded, 5 cancelled by the merchant |

Every call carries `Authorization: Bearer <token>`.

Callbacks are not signed, so the app never trusts them as such. On every callback it asks the check API
about the order number **it stored** for that payment, and accepts a success only if the answer names that
payment, **for the same amount in USD**. A success for another amount or currency stays pending and is
written to the audit log (`flexpay_amount_mismatch`) for an admin. Status 1, 3, 4 and 5 count as not paid
(the payer can try again).

## Setup

1. From FlexPaie: AmaniCare's merchant code, token and **base address**, for test and for live.
2. On Render, set:
   - `PAYMENT_PARTNER=flexpay`
   - `FLEXPAY_TOKEN`, `FLEXPAY_MERCHANT` (AmaniCare's merchant code), `FLEXPAY_BASE_URL`
   - `FLEXPAY_CHECK_BASE_URL` only if FlexPaie gives the check API its own host
   - `FLEXPAY_PAYOUT_URL` once FlexPaie sends the payout API
3. Callback URL (sent with every request, nothing to register): `https://<your domain>/api/webhooks/payments/flexpay`.
4. For each pilot hospital, enter its FlexPaie merchant code (or its mobile-money payout number).

Never paste the token in a chat, a document or the repository: Render and the local `.env` only.

## To confirm with FlexPaie

- **Base addresses** for test and live (the documents write `<base_url>`), and whether the check API has its own host.
- **Payout API** to a hospital's mobile-money number (mentioned in the document history, v1.4, but not included).
- **AmaniCare's commission** when the money goes into the hospital's own merchant account (`TODO(flexpay)` in `createCollection`).
- **Who pays FlexPaie's fee**: the example shows `amountCustomer` above `amount`, so the payer may pay it on top.
- **Foreign cards** (diaspora payers in the US and Europe), USD settlement, limits per transaction.
- Callback origin (IP addresses) and any signature, and the maximum length of `reference` (ours is a 36-character id).
- Signing up hospitals as merchants, and how long it takes.
