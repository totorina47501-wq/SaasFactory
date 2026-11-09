import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../database/index.mjs';
import { EVENT_STATES, EVENT_TRANSITIONS, PERIOD_MS, PLANS } from './contract.mjs';
import { BillingModuleError, fail } from './errors.mjs';

const migration = Object.freeze({
  moduleId: 'billing-simulated',
  version: 1,
  id: '0001_local_billing',
  sql: readFileSync(new URL('./migrations/0001_local_billing.sql', import.meta.url), 'utf8'),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCHEMA_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function validateTenantId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function validateSchema(value) {
  if (typeof value !== 'string' || !SCHEMA_PATTERN.test(value) ||
      value.startsWith('pg_') || ['public', 'information_schema'].includes(value)) {
    fail('INVALID_CONFIGURATION');
  }
  return `"${value}"`;
}

function rowValue(row, key) {
  return row && typeof row === 'object' && Object.hasOwn(row, key) ? row[key] : null;
}

async function transaction(pool, schema, tenantId, operation) {
  let client;
  let started = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    started = true;
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        fail('UNAVAILABLE');
      }
    }
    if (error instanceof BillingModuleError) throw error;
    fail('UNAVAILABLE');
  } finally {
    client?.release();
  }
}

async function lockTenant(client, tenantId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($1 || \':billing\'))', [tenantId]);
}

async function appendHistory(client, tenantId, entry) {
  await client.query(
    'INSERT INTO simulated_billing_history (tenant_id, entry) VALUES ($1, $2::jsonb)',
    [tenantId, JSON.stringify(entry)],
  );
}

async function readSubscription(client, tenantId, lock = false) {
  const result = await client.query(
    `SELECT payload FROM simulated_billing_subscriptions WHERE tenant_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [tenantId],
  );
  return rowValue(result.rows?.[0], 'payload');
}

async function writeSubscription(client, tenantId, subscription) {
  await client.query(
    `INSERT INTO simulated_billing_subscriptions (tenant_id, subscription_id, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE
       SET subscription_id = EXCLUDED.subscription_id, payload = EXCLUDED.payload`,
    [tenantId, subscription.id, JSON.stringify(subscription)],
  );
}

async function storeOperation(client, { tenantId, idempotencyKey, operation, fingerprint, payload }) {
  await client.query(
    `INSERT INTO simulated_billing_operations
       (tenant_id, idempotency_key, operation, fingerprint, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenantId, idempotencyKey, operation, fingerprint, JSON.stringify(payload)],
  );
}

async function findOperation(client, tenantId, operation, idempotencyKey) {
  const result = await client.query(
    `SELECT operation, fingerprint, payload FROM simulated_billing_operations
     WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [tenantId, operation, idempotencyKey],
  );
  return result.rows?.[0] ?? null;
}

function sameEvent(left, right) {
  return left.version === right.version && left.id === right.id && left.type === right.type &&
    left.tenantId === right.tenantId && left.subscriptionId === right.subscriptionId &&
    left.occurredAt === right.occurredAt;
}

export async function runBillingMigrations(pool, schemaName) {
  try {
    return await runMigrations(pool, schemaName, { extensionMigrations: [migration] });
  } catch {
    fail('UNAVAILABLE');
  }
}

export function createPostgresBillingStore(configuration) {
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) {
    fail('INVALID_CONFIGURATION');
  }
  const prototype = Object.getPrototypeOf(configuration);
  const keys = Reflect.ownKeys(configuration);
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 2 || keys.some(key => !['pool', 'schemaName'].includes(key)) ||
      keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail('INVALID_CONFIGURATION');
  const pool = Object.getOwnPropertyDescriptor(configuration, 'pool')?.value;
  const schema = validateSchema(Object.getOwnPropertyDescriptor(configuration, 'schemaName')?.value);
  if (!pool || typeof pool.connect !== 'function') fail('INVALID_CONFIGURATION');

  return Object.freeze({
    async startSubscription({ subscription, idempotencyKey, fingerprint }) {
      const tenantId = validateTenantId(subscription.tenantId);
      if (typeof idempotencyKey !== 'string' || !ID_PATTERN.test(idempotencyKey) ||
          typeof fingerprint !== 'string' || fingerprint.length > 128) fail('INVALID_INPUT');
      return transaction(pool, schema, tenantId, async client => {
        await lockTenant(client, tenantId);
        const previous = await findOperation(client, tenantId, 'start', idempotencyKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            fail('IDEMPOTENCY_CONFLICT');
          }
          return previous.payload;
        }
        if (await readSubscription(client, tenantId)) fail('SUBSCRIPTION_EXISTS');
        await writeSubscription(client, tenantId, subscription);
        await storeOperation(client, {
          tenantId, idempotencyKey, operation: 'start', fingerprint, payload: subscription,
        });
        await appendHistory(client, tenantId, {
          id: subscription.id,
          type: 'subscription.started',
          occurredAt: subscription.createdAt,
          subscriptionId: subscription.id,
          planId: subscription.planId,
          status: subscription.status,
        });
        return subscription;
      });
    },

    async getSubscription(value) {
      const tenantId = validateTenantId(value);
      return transaction(pool, schema, tenantId, client => readSubscription(client, tenantId));
    },

    async listInvoices(value) {
      const tenantId = validateTenantId(value);
      return transaction(pool, schema, tenantId, async client => {
        const result = await client.query(
          `SELECT payload FROM simulated_billing_invoices
           WHERE tenant_id = $1 ORDER BY period_start_at, invoice_id`,
          [tenantId],
        );
        return (result.rows ?? []).map(row => row.payload);
      });
    },

    async cancelSubscription({ tenantId: value, now }) {
      const tenantId = validateTenantId(value);
      if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_INPUT');
      return transaction(pool, schema, tenantId, async client => {
        const subscription = await readSubscription(client, tenantId, true);
        if (!subscription) fail('NOT_FOUND');
        if (subscription.status === 'canceled' || subscription.cancelAtPeriodEnd) return subscription;
        const updated = {
          ...subscription,
          cancelAtPeriodEnd: true,
          updatedAt: now,
          version: subscription.version + 1,
        };
        await writeSubscription(client, tenantId, updated);
        await appendHistory(client, tenantId, {
          id: randomUUID(),
          type: 'subscription.cancel_scheduled',
          occurredAt: now,
          subscriptionId: updated.id,
          status: updated.status,
        });
        return updated;
      });
    },

    async renewSubscription({ tenantId: value, now, idempotencyKey, invoiceId }) {
      const tenantId = validateTenantId(value);
      if (!Number.isSafeInteger(now) || now < 0 ||
          typeof idempotencyKey !== 'string' || !ID_PATTERN.test(idempotencyKey) ||
          typeof invoiceId !== 'string' || !UUID_PATTERN.test(invoiceId)) fail('INVALID_INPUT');
      return transaction(pool, schema, tenantId, async client => {
        await lockTenant(client, tenantId);
        const previous = await findOperation(client, tenantId, 'renew', idempotencyKey);
        if (previous) {
          return previous.payload;
        }
        const subscription = await readSubscription(client, tenantId, true);
        if (!subscription) fail('NOT_FOUND');
        if (subscription.status === 'canceled') {
          const result = { status: 'canceled', subscription, invoice: null };
          await storeOperation(client, {
            tenantId, idempotencyKey, operation: 'renew', fingerprint: 'canceled', payload: result,
          });
          return result;
        }
        if (now < subscription.currentPeriodEnd) fail('NOT_DUE');
        if (subscription.cancelAtPeriodEnd) {
          const canceled = {
            ...subscription,
            status: 'canceled',
            cancelAtPeriodEnd: false,
            updatedAt: now,
            version: subscription.version + 1,
          };
          await writeSubscription(client, tenantId, canceled);
          await appendHistory(client, tenantId, {
            id: randomUUID(),
            type: 'subscription.canceled',
            occurredAt: now,
            subscriptionId: canceled.id,
            status: canceled.status,
          });
          const result = { status: 'canceled', subscription: canceled, invoice: null };
          await storeOperation(client, {
            tenantId, idempotencyKey, operation: 'renew', fingerprint: 'canceled', payload: result,
          });
          return result;
        }
        const plan = PLANS.find(candidate => candidate.id === subscription.planId);
        if (!plan) fail('UNAVAILABLE');
        const periodStartAt = subscription.currentPeriodEnd;
        const periodEndAt = periodStartAt + PERIOD_MS;
        if (!Number.isSafeInteger(periodEndAt)) fail('UNAVAILABLE');
        const invoice = plan.amountCents === 0 ? null : {
          id: invoiceId,
          tenantId,
          subscriptionId: subscription.id,
          number: `DEMO-${invoiceId}`,
          amountCents: plan.amountCents,
          currency: plan.currency,
          status: 'demo',
          paymentRequired: false,
          periodStartAt,
          periodEndAt,
          issuedAt: now,
          simulated: true,
        };
        const updated = {
          ...subscription,
          status: 'active',
          trialEndAt: null,
          currentPeriodStartAt: periodStartAt,
          currentPeriodEnd: periodEndAt,
          updatedAt: now,
          version: subscription.version + 1,
        };
        await writeSubscription(client, tenantId, updated);
        if (invoice) {
          await client.query(
            `INSERT INTO simulated_billing_invoices
               (tenant_id, invoice_id, subscription_id, period_start_at, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [tenantId, invoice.id, invoice.subscriptionId, invoice.periodStartAt, JSON.stringify(invoice)],
          );
        }
        await appendHistory(client, tenantId, {
          id: randomUUID(),
          type: 'subscription.renewed',
          occurredAt: now,
          subscriptionId: updated.id,
          status: updated.status,
          invoiceId: invoice?.id ?? null,
        });
        const result = { status: 'renewed', subscription: updated, invoice };
        await storeOperation(client, {
          tenantId, idempotencyKey, operation: 'renew', fingerprint: 'renewed', payload: result,
        });
        return result;
      });
    },

    async applyEvent({ event }) {
      const tenantId = validateTenantId(event.tenantId);
      return transaction(pool, schema, tenantId, async client => {
        await lockTenant(client, tenantId);
        const received = await client.query(
          `SELECT canonical_payload FROM simulated_billing_received_events
           WHERE tenant_id = $1 AND event_id = $2`,
          [tenantId, event.id],
        );
        if (received.rows?.length) {
          if (!sameEvent(received.rows[0].canonical_payload, event)) {
            fail('EVENT_ID_CONFLICT');
          }
          return {
            duplicate: true,
            stale: false,
            subscription: await readSubscription(client, tenantId),
          };
        }
        const subscription = await readSubscription(client, tenantId, true);
        if (!subscription || subscription.id !== event.subscriptionId) fail('NOT_FOUND');
        const stale = event.occurredAt <= subscription.updatedAt;
        const stateForEvent = EVENT_STATES[event.type];
        if (!stale && !EVENT_TRANSITIONS[event.type].includes(subscription.status)) {
          fail('INVALID_TRANSITION');
        }
        const updated = stale ? subscription : {
          ...subscription,
          status: stateForEvent,
          cancelAtPeriodEnd: stateForEvent === 'canceled' ? false : subscription.cancelAtPeriodEnd,
          updatedAt: event.occurredAt,
          version: subscription.version + 1,
        };
        if (!stale) await writeSubscription(client, tenantId, updated);
        await client.query(
          `INSERT INTO simulated_billing_received_events (tenant_id, event_id, canonical_payload)
           VALUES ($1, $2, $3::jsonb)`,
          [tenantId, event.id, JSON.stringify(event)],
        );
        await appendHistory(client, tenantId, {
          id: event.id,
          type: event.type,
          occurredAt: event.occurredAt,
          subscriptionId: event.subscriptionId,
          status: stateForEvent,
          stale,
        });
        return { duplicate: false, stale, subscription: updated };
      });
    },

    async getHistory(value) {
      const tenantId = validateTenantId(value);
      return transaction(pool, schema, tenantId, async client => {
        const result = await client.query(
          `SELECT entry FROM simulated_billing_history
           WHERE tenant_id = $1 ORDER BY sequence`,
          [tenantId],
        );
        return (result.rows ?? []).map(row => row.entry);
      });
    },
  });
}
