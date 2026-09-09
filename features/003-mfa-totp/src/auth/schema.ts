// Include MFA in the desired auth schema so later migrations retain its tables.
// One outstanding challenge per factor; a new challenge replaces the previous one.
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
  -- Reject OTP reuse across challenges. migration.ts adds this column to existing tables.
  last_verified_step    integer NOT NULL DEFAULT 0,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- NULLIF permits repeated empty names without depending on the partial-index patch.
-- Whitespace-only names still participate: trim/btrim is unsupported by this translator.
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_user_friendly_name_key
  ON auth.mfa_factors (user_id, (NULLIF(friendly_name, '')));

-- Supports factor listing by user, ordered by creation time.
CREATE INDEX IF NOT EXISTS mfa_factors_user_id_created_at_idx
  ON auth.mfa_factors (user_id, created_at);

-- One history row per method and session, including repeated verifications.
CREATE TABLE IF NOT EXISTS auth.mfa_amr_claims (
  id                     text PRIMARY KEY,
  session_id             uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  authentication_method  text NOT NULL,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  UNIQUE (session_id, authentication_method)
);
`
