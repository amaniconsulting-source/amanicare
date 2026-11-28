# Payment option logos

One file per option, PNG, square, about 96×96 px, transparent or white background:

| File | Option |
|---|---|
| `card.png` | Bank card (Visa / Mastercard) |
| `mobile.png` | Mobile money (a generic icon, or the operators' logos side by side) |
| `mpesa.png` | M-Pesa (Vodacom) |
| `orange.png` | Orange Money |
| `airtel.png` | Airtel Money |

Use only the official logos from each company's brand or press kit (or the files they send you),
and follow their brand guidelines. After adding a file, add its name to `PAY_LOGOS` in `web/app.ts` (e.g. `'sendwave'`).
An option not listed there shows its name only.

In place (27 Nov 2026, from FlexPaie's payment page): `card.png` (Visa + Mastercard), `mobile.png` (M-Pesa, Orange Money, Airtel Money), `flexpaie.png` (shown as "Paiement sécurisé par FlexPaie").
