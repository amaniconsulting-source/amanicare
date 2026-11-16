-- Prices differ between facilities: a health centre in Lemba doesn't charge what a private clinic
-- in Gombe does. Facilities get a type, and reference prices can apply to everyone (general),
-- to one type of facility, or to one facility. The most specific matching price is used.

ALTER TABLE clinics ADD COLUMN category TEXT NOT NULL DEFAULT 'clinic'
  CHECK (category IN ('health_centre', 'clinic', 'hospital', 'diagnostic', 'pharmacy'));

ALTER TABLE reference_prices ADD COLUMN category TEXT
  CHECK (category IN ('health_centre', 'clinic', 'hospital', 'diagnostic', 'pharmacy'));
ALTER TABLE reference_prices ADD COLUMN clinic_id TEXT REFERENCES clinics(id) ON DELETE CASCADE;
ALTER TABLE reference_prices ADD CONSTRAINT reference_prices_one_scope CHECK (category IS NULL OR clinic_id IS NULL);
CREATE INDEX reference_prices_clinic ON reference_prices(clinic_id);
CREATE INDEX reference_prices_category ON reference_prices(category);

-- Demo data: the demo health centre is a health centre.
UPDATE clinics SET category = 'health_centre' WHERE name = 'Centre de Santé Amani';
