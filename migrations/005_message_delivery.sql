-- WhatsApp message ids, so delivery receipts (delivered, read, failed) can update the outbox.
ALTER TABLE messages ADD COLUMN provider_id TEXT;
ALTER TABLE messages ADD COLUMN error TEXT;
CREATE INDEX messages_provider_id ON messages(provider_id);
