CREATE TABLE mfa_authenticators (
  user_id UUID PRIMARY KEY REFERENCES auth_users (id) ON DELETE CASCADE,
  pending_secret TEXT,
  secret TEXT,
  last_accepted_step BIGINT CHECK (last_accepted_step >= 0),
  enabled_at TIMESTAMPTZ,
  CHECK ((secret IS NULL) = (enabled_at IS NULL)),
  CHECK ((secret IS NULL) = (last_accepted_step IS NULL))
);

CREATE TABLE mfa_recovery_codes (
  user_id UUID NOT NULL REFERENCES mfa_authenticators (user_id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

CREATE INDEX mfa_recovery_codes_user_id_idx ON mfa_recovery_codes (user_id);
