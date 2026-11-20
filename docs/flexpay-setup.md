# FlexPay pilot (proof of concept)

AmaniCare uses FlexPay for the pilot while the bank partnership is set up. FlexPay is a Congolese
payment aggregator (INFOSET SARL, authorized by the Banque Centrale du Congo): one API for M-Pesa,
Orange Money, Airtel Money, Afrimoney and Visa/Mastercard. The code is in `server/payments/flexpay.ts`.

## How the money moves

Chosen per hospital in **Admin → Hospitals → FlexPay setup**:

1. **Direct (preferred).** The hospital has its own FlexPay merchant code. The payer's money goes
   straight into the hospital's FlexPay account; the hospital withdraws to its bank or wallet whenever
   it wants. AmaniCare never holds the money and there is no payout step. AmaniCare's fee comes from
   FlexPay's commission split (to confirm with FlexPay, see below).
2. **Through AmaniCare.** No merchant code yet. The money is collected into AmaniCare's FlexPay merchant
   account, then sent to the hospital's **mobile-money payout number**. FlexPay's API has no bank
   payout, so a bank-only hospital without a merchant code ends in *payout failed*: pay it by hand from
   the FlexPay dashboard, or give it a merchant code or payout number.

Payers choose **bank card** (FlexPay's secure card page) or **M-Pesa / Orange Money / Airtel Money**
(a request on their phone, approved with their PIN).

## Setup

1. Get AmaniCare's merchant account from FlexPay: merchant code and token, for test and live.
2. On Render, set:
   - `PAYMENT_PARTNER=flexpay`
   - `FLEXPAY_TOKEN`, `FLEXPAY_MERCHANT` (AmaniCare's merchant code)
   - for the test environment, the addresses FlexPay gives you: `FLEXPAY_PAYMENT_URL`,
     `FLEXPAY_CARD_URL`, `FLEXPAY_CHECK_URL`, `FLEXPAY_PAYOUT_URL` (empty = production endpoints)
3. Give FlexPay the callback URL: `https://<your domain>/api/webhooks/payments/flexpay`.
4. For each pilot hospital, enter its FlexPay merchant code (or its mobile-money payout number).

Callbacks from FlexPay are not signed, so the app never trusts them as such: on every callback it asks
FlexPay's status API about the order number it stored for that payment, and checks the answer names
that payment.

## To confirm with FlexPay before going live

- Request and response fields: the adapter follows FlexPay's published client libraries; compare with
  the documentation FlexPay sends with your credentials.
- **Commission split**: how AmaniCare's fee is taken when the money goes to the hospital's account
  (the `TODO(flexpay)` in `createCollection`).
- **Foreign cards** (diaspora payers in the US and Europe) and **USD** settlement.
- Signing up hospitals as merchants under AmaniCare, and how long it takes.
