CREATE TABLE organization_invitations (
  invitation_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  inviter_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  accepted_at timestamptz,
  CHECK (accepted_at IS NULL OR accepted_at >= created_at)
);

CREATE UNIQUE INDEX organization_invitations_pending_email
  ON organization_invitations (tenant_id, email)
  WHERE accepted_at IS NULL;
CREATE INDEX organization_invitations_expiry
  ON organization_invitations (tenant_id, expires_at)
  WHERE accepted_at IS NULL;

ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_tenant_policy ON organization_invitations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

CREATE POLICY memberships_self_list_policy ON memberships FOR SELECT
  USING (user_id::text = NULLIF(current_setting('app.user_id', true), ''));

CREATE POLICY users_self_read_policy ON users FOR SELECT
  USING (id::text = NULLIF(current_setting('app.user_id', true), ''));
