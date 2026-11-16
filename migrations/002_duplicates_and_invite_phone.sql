-- Photo fingerprints catch the same bill photo uploaded twice.
ALTER TABLE bill_drafts ADD COLUMN photo_sha256 TEXT;
ALTER TABLE bills ADD COLUMN photo_sha256 TEXT;
CREATE INDEX bills_photo_sha256 ON bills(photo_sha256);
CREATE INDEX bills_clinic_patient_total ON bills(clinic_id, lower(patient_name), total);

-- Invites can be made for a specific phone number (only that number can use the code).
ALTER TABLE invites ADD COLUMN phone TEXT;
