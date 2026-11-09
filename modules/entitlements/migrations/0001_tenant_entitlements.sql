CREATE TABLE entitlements_usage (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  quota_id text NOT NULL,
  period_start_at bigint NOT NULL,
  period_end_at bigint NOT NULL,
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (tenant_id, quota_id, period_start_at),
  CHECK (period_end_at > period_start_at),
  CHECK (quota_id ~ '^[a-z][a-z0-9._-]{0,127}$')
);

CREATE TABLE entitlements_reservations (
  tenant_id text NOT NULL,
  reservation_id uuid NOT NULL,
  quota_id text NOT NULL,
  period_start_at bigint NOT NULL,
  period_end_at bigint NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'consumed', 'refunded')),
  PRIMARY KEY (tenant_id, reservation_id),
  UNIQUE (tenant_id, quota_id, period_start_at, idempotency_key),
  FOREIGN KEY (tenant_id, quota_id, period_start_at)
    REFERENCES entitlements_usage (tenant_id, quota_id, period_start_at) ON DELETE CASCADE,
  CHECK (period_end_at > period_start_at),
  CHECK (idempotency_key ~ '^[A-Za-z][A-Za-z0-9._-]{0,127}$')
);

CREATE TABLE entitlements_overrides (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  target_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('feature', 'quota')),
  override_value jsonb NOT NULL,
  PRIMARY KEY (tenant_id, target_id),
  CHECK (target_id ~ '^[A-Za-z][A-Za-z0-9._-]{0,127}$'),
  CHECK ((kind = 'feature' AND jsonb_typeof(override_value) = 'boolean') OR
         (kind = 'quota' AND jsonb_typeof(override_value) = 'number' AND
          (override_value #>> '{}')::numeric >= 0 AND
          (override_value #>> '{}')::numeric <= 9007199254740991 AND
          trunc((override_value #>> '{}')::numeric) = (override_value #>> '{}')::numeric))
);

ALTER TABLE entitlements_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlements_usage_tenant_policy ON entitlements_usage
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE entitlements_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlements_reservations_tenant_policy ON entitlements_reservations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE entitlements_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlements_overrides_tenant_policy ON entitlements_overrides
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
