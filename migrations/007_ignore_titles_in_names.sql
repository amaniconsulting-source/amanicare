-- Titles on bills ("Mme Deborah BUDIAYI", "M. Patrick", "Dr …") are not part of the name:
-- the duplicate and frequent-patient checks now ignore them.
CREATE OR REPLACE FUNCTION amc_name_key(raw TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_to_string(ARRAY(
    SELECT w FROM unnest(regexp_split_to_array(
      trim(regexp_replace(
        translate(lower(coalesce(raw, '')), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
        '[^a-z0-9]+', ' ', 'g')), ' ')) AS w
    WHERE w <> '' AND w NOT IN ('mme', 'mmes', 'madame', 'mlle', 'mademoiselle', 'm', 'mr', 'mrs', 'ms', 'miss',
                                'monsieur', 'dr', 'docteur', 'doctor', 'pr', 'prof', 'maman', 'papa', 'bebe', 'baby')
    ORDER BY w), ' '), '')
$$;

-- Recompute the stored keys with the new rule.
UPDATE bills SET patient_name = patient_name;
