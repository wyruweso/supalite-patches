// The schema MFA needs, as Postgres DDL appended to the auth schema the library already carries.
//
// Appended rather than created at start-up, because the migrator builds the schema it compares
// against by translating this DDL into a fresh database. A table created any other way exists only on
// the live side, and the next migration plans to drop it.
//
// Remaining simplification: one challenge per factor, held in columns on the factor. Upstream keeps
// challenges in their own table and can have two outstanding; here the second replaces the first.
export const MFA_SCHEMA_SQL = `
-- ============================================================
-- MFA
-- ============================================================

CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id                    text PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friendly_name         text,
  factor_type           text NOT NULL DEFAULT 'totp',
  status                text NOT NULL DEFAULT 'unverified',
  secret                text NOT NULL,
  challenge_id          text,
  challenge_expires_at  text,
  challenge_attempts    integer NOT NULL DEFAULT 0,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- Upstream writes this as a partial index, unique WHERE the name is not blank. A predicate would
-- depend on FIX-001 being applied alongside, and these patches are independent, so an expression
-- index says the same thing: a blank name indexes as NULL, and NULL does not collide. The column is
-- untouched, so a name comes back exactly as written.
--
-- Upstream compares trim(friendly_name) <> ''. trim does not survive translation here (the parser
-- calls it btrim, which the translator refuses by name), so a name of nothing but spaces takes part
-- in uniqueness where upstream would exempt it.
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_user_friendly_name_key
  ON auth.mfa_factors (user_id, (NULLIF(friendly_name, '')));

-- What listing a user's factors actually asks for: WHERE user_id = ? ORDER BY created_at.
CREATE INDEX IF NOT EXISTS mfa_factors_user_id_created_at_idx
  ON auth.mfa_factors (user_id, created_at);

-- The session's authentication methods, one row each, as upstream's mfa_amr_claims. They describe
-- the session and go with it.
--
-- Unique per method, as upstream: without it, re-verifying a factor grows the claim into
-- ['password', 'totp', 'totp'].
CREATE TABLE IF NOT EXISTS auth.mfa_amr_claims (
  id                     text PRIMARY KEY,
  session_id             uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  authentication_method  text NOT NULL,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  UNIQUE (session_id, authentication_method)
);
`
