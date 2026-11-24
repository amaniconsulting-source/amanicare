-- Indexes for the admin lists, which are now loaded page by page (newest first).
CREATE INDEX users_role_created ON users(role, created_at DESC);
CREATE INDEX audit_actor_action ON audit(actor_id, action, at DESC);
CREATE INDEX bills_created ON bills(created_at DESC);
CREATE INDEX payments_created ON payments(created_at DESC);
