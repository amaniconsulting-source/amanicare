-- Hospital bills in the DRC have no common format: numbers are written "N° 0457", "Fact. 457",
-- "FAC-0457" or are missing, and names appear as "Débora BUDIAYI" or "Budiayi Debora".
-- These functions reduce both to a comparable key, so duplicate checks aren't fooled by formatting.

-- "N° 0457" / "Fact. 457" / "FAC-0457" / "#457" → "457". Empty when there is no number.
CREATE FUNCTION amc_bill_key(raw TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(upper(coalesce(raw, '')), '[^A-Z0-9]', '', 'g'),
             '^(FACTURE|FACT|FAC|NUMERO|NUM|NO|N|INVOICE|INV|REF|BILL)(?=[0-9])', ''),
           '^0+(?=[0-9A-Z])', '')
$$;

-- "Débora  BUDIAYI" and "Budiayi Debora" → "budiayi debora" (accents, case, spacing and word order ignored).
CREATE FUNCTION amc_name_key(raw TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_to_string(ARRAY(
    SELECT w FROM unnest(regexp_split_to_array(
      trim(regexp_replace(
        translate(lower(coalesce(raw, '')), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
        '[^a-z0-9]+', ' ', 'g')), ' ')) AS w
    WHERE w <> '' ORDER BY w), ' '), '')
$$;

ALTER TABLE bills ADD COLUMN bill_number_key TEXT GENERATED ALWAYS AS (amc_bill_key(bill_number)) STORED;
ALTER TABLE bills ADD COLUMN patient_key TEXT GENERATED ALWAYS AS (amc_name_key(patient_name)) STORED;
CREATE INDEX bills_clinic_number_key ON bills(clinic_id, bill_number_key);
CREATE INDEX bills_patient_key ON bills(patient_key, created_at);
