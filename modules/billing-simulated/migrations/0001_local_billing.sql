CREATE TABLE simulated_billing_subscriptions (
  tenant_id text PRIMARY KEY REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL UNIQUE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE simulated_billing_invoices (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  period_start_at bigint NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (tenant_id, invoice_id),
  UNIQUE (tenant_id, subscription_id, period_start_at)
);

CREATE TABLE simulated_billing_operations (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('start', 'renew')),
  fingerprint text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (tenant_id, operation, idempotency_key)
);

CREATE TABLE simulated_billing_received_events (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  event_id text NOT NULL,
  canonical_payload jsonb NOT NULL CHECK (jsonb_typeof(canonical_payload) = 'object'),
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE simulated_billing_history (
  tenant_id text NOT NULL REFERENCES organizations (tenant_id) ON DELETE CASCADE,
  sequence bigserial NOT NULL,
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  PRIMARY KEY (tenant_id, sequence)
);

ALTER TABLE simulated_billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulated_billing_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY simulated_billing_subscriptions_tenant_policy ON simulated_billing_subscriptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE simulated_billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulated_billing_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY simulated_billing_invoices_tenant_policy ON simulated_billing_invoices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE simulated_billing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulated_billing_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY simulated_billing_operations_tenant_policy ON simulated_billing_operations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE simulated_billing_received_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulated_billing_received_events FORCE ROW LEVEL SECURITY;
CREATE POLICY simulated_billing_received_events_tenant_policy ON simulated_billing_received_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE simulated_billing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulated_billing_history FORCE ROW LEVEL SECURITY;
CREATE POLICY simulated_billing_history_tenant_policy ON simulated_billing_history
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
