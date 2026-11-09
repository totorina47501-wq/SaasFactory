CREATE INDEX memberships_user_id ON memberships (user_id, tenant_id);
CREATE INDEX audit_events_tenant_recorded ON audit_events (tenant_id, recorded_at DESC);

CREATE TABLE local_storage (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  value jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE module_data (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  module_id text NOT NULL CHECK (module_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  record_key text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 128),
  value jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_id, record_key)
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenant_policy ON organizations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_read_policy ON users FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM memberships
    WHERE memberships.user_id = users.id
      AND memberships.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  ));
CREATE POLICY users_tenant_create_policy ON users FOR INSERT
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_tenant_policy ON memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_read_policy ON audit_events FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY audit_events_tenant_insert_policy ON audit_events FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE local_storage ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_storage FORCE ROW LEVEL SECURITY;
CREATE POLICY local_storage_tenant_policy ON local_storage
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE module_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_data FORCE ROW LEVEL SECURITY;
CREATE POLICY module_data_tenant_policy ON module_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
