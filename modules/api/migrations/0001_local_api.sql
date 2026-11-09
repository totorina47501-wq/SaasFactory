CREATE TABLE api_keys (
  key_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 3),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX api_keys_tenant_actor_idx ON api_keys (tenant_id, actor_id, created_at DESC);
CREATE INDEX api_keys_expiry_idx ON api_keys (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE api_rate_limits (
  bucket_hash TEXT PRIMARY KEY CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_start TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);

CREATE INDEX api_rate_limits_window_idx ON api_rate_limits (window_start);

CREATE TABLE api_webhook_replays (
  tenant_id UUID NOT NULL,
  nonce TEXT NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22,86}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, nonce)
);

CREATE INDEX api_webhook_replays_expiry_idx ON api_webhook_replays (expires_at);
