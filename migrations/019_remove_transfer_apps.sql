-- The transfer-app option (Taptap Send, Sendwave; migration 018) was removed from the pilot on 27 Nov 2026:
-- FlexPaie only. Its columns stay, unused. A transfer still waiting is ended, so the bill can be paid with FlexPaie.
UPDATE payments SET status = 'failed', failure_reason = 'Transfer option removed from the pilot', updated_at = now()
  WHERE partner = 'transfer' AND kind = 'collection' AND status = 'pending';
UPDATE bills SET status = 'payment_failed', updated_at = now()
  WHERE status = 'payment_pending'
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = bills.id AND p.kind = 'collection' AND p.status IN ('pending','succeeded'));
