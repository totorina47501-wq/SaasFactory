CREATE TABLE auth_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX auth_users_email_unique ON auth_users (lower(email));

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE auth_password_resets (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at)
);

CREATE INDEX auth_password_resets_user_id_idx ON auth_password_resets (user_id);
CREATE INDEX auth_password_resets_expiry_idx ON auth_password_resets (expires_at);

CREATE TABLE auth_rate_limits (
  bucket_hash TEXT PRIMARY KEY CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_start TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);

CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits (window_start);
