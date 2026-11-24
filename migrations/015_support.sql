-- Customer service: a conversation ("ticket") between a user and AmaniCare.
-- The assistant answers first (status 'bot'); when it hands over, or the person asks for someone,
-- an agent picks it up ('open' = needs an agent, 'waiting' = agent answered, 'resolved').
-- Messages to the WhatsApp Business number open one too (channel 'whatsapp'); WhatsApp vouches for the number.
-- People who are not signed in give their phone number; they prove nothing, so the assistant never
-- shows them account data, and they reach their conversation again with a token kept on their device.
CREATE TABLE support_tickets (
  id               TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  guest_phone      TEXT,
  guest_name       TEXT NOT NULL DEFAULT '',
  guest_token_hash TEXT,
  lang             TEXT NOT NULL DEFAULT 'fr',
  channel          TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app','whatsapp')),
  bill_id          TEXT REFERENCES bills(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','open','waiting','resolved')),
  subject          TEXT NOT NULL DEFAULT '',
  escalate_reason  TEXT NOT NULL DEFAULT '',
  assigned_to      TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_unread      INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  escalated_at     TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX support_tickets_status ON support_tickets(status, updated_at DESC);
CREATE INDEX support_tickets_user ON support_tickets(user_id, updated_at DESC);

CREATE TABLE support_messages (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sender    TEXT NOT NULL CHECK (sender IN ('user','bot','agent','system')),
  agent_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  body      TEXT NOT NULL
);
CREATE INDEX support_messages_ticket ON support_messages(ticket_id, id);
