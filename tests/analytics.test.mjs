import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalyticsModuleError,
  analyticsContract,
  createAnalyticsService,
  createMemoryAnalyticsStore,
} from '../modules/analytics/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'request-analytics';
const NOW = Date.UTC(2026, 10, 9, 12);
const context = (tenantId = TENANT_A) => ({
  contractVersion: 1,
  tenantId,
  requestId: REQUEST,
});
const id = value =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const subject = value => String(value).padStart(64, '0');

function fixture(options = {}) {
  let now = NOW;
  const revokedSubjects = new Set();
  const service = createAnalyticsService({
    store: createMemoryAnalyticsStore(),
    authorize: options.authorize ?? (async () => true),
    checkConsent: options.checkConsent ?? (async ({ subjectKey }) =>
      !revokedSubjects.has(subjectKey)),
    setConsent: options.setConsent ?? (async ({ subjectKey, granted }) => {
      if (granted) revokedSubjects.delete(subjectKey);
      else revokedSubjects.add(subjectKey);
      return true;
    }),
    features: ['reports', 'search'],
    clock: () => now,
    limits: options.limits,
  });
  return {
    service,
    setTime(value) {
      now = value;
    },
  };
}

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: id(1),
    eventType: 'feature.used',
    featureId: 'reports',
    occurredAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function input(subjectKey = subject(1), overrides = {}) {
  return {
    context: context(),
    subjectKey,
    event: event(),
    ...overrides,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof AnalyticsModuleError && error.code === code);
}

test('exports a versioned privacy-first event contract and fails closed on bad configuration', () => {
  assert.equal(analyticsContract.version, 1);
  assert.equal(analyticsContract.eventSchemaVersion, 1);
  assert.equal(analyticsContract.defaultLimits.minGroupSize, 5);
  assert.throws(() => createAnalyticsService({
    store: createMemoryAnalyticsStore(),
    authorize: async () => true,
    checkConsent: async () => true,
    setConsent: async () => true,
    features: ['reports', 'reports'],
  }), error => error.code === 'INVALID_CONFIGURATION');
  assert.throws(() => createAnalyticsService({
    store: createMemoryAnalyticsStore(),
    authorize: async () => true,
    checkConsent: async () => true,
    setConsent: async () => true,
    features: ['reports'],
    limits: { undocumented: 1 },
  }), error => error.code === 'INVALID_INPUT');
  assert.throws(() => createAnalyticsService({
    store: createMemoryAnalyticsStore(),
    authorize: async () => true,
    checkConsent: async () => true,
    setConsent: async () => true,
    features: ['reports'],
    limits: { minGroupSize: 4 },
  }), error => error.code === 'INVALID_CONFIGURATION');
});

test('tracks consented allowlisted events idempotently and rejects conflicts or content', async () => {
  const { service } = fixture({ limits: { maxEventsPerDay: 2 } });
  const first = input();
  assert.deepEqual(await service.track(first), { accepted: true, duplicate: false });
  assert.deepEqual(await service.track(first), { accepted: false, duplicate: true });

  await expectCode(service.track(input(subject(1), {
    event: event({ eventType: 'visit' }),
  })), 'IDEMPOTENCY_CONFLICT');
  await expectCode(service.track(input(subject(2), {
    event: event({ eventId: id(2), content: 'document text' }),
  })), 'INVALID_INPUT');
  await expectCode(service.track(input(subject(2), {
    event: event({ eventId: id(2), featureId: 'unlisted' }),
  })), 'INVALID_INPUT');
  await expectCode(service.track(input(subject(2), {
    event: event({ eventId: id(2), eventType: 'prompt.submitted' }),
  })), 'INVALID_INPUT');

  assert.deepEqual(await service.track(input(subject(2), {
    event: event({ eventId: id(2) }),
  })), { accepted: true, duplicate: false });
  await expectCode(service.track(input(subject(3), {
    event: event({ eventId: id(3) }),
  })), 'QUOTA_EXCEEDED');
});

test('requires authorization and explicit consent; tenant isolation is enforced by authorization', async () => {
  const denied = fixture({
    authorize: async ({ context: tenantContext, action }) =>
      tenantContext.tenantId === TENANT_A && action === 'analytics.read',
  }).service;
  await expectCode(denied.track(input()), 'FORBIDDEN');

  const notConsented = fixture({ checkConsent: async () => false }).service;
  await expectCode(notConsented.track(input()), 'CONSENT_REQUIRED');

  const unavailable = fixture({
    checkConsent: async () => { throw new Error('private consent detail'); },
  }).service;
  await expectCode(unavailable.track(input()), 'CONSENT_UNAVAILABLE');

  const authorized = fixture({
    authorize: async ({ context: tenantContext }) => tenantContext.tenantId === TENANT_A,
  }).service;
  await expectCode(authorized.dashboard({ context: context(TENANT_B) }), 'FORBIDDEN');
});

test('suppresses small groups and returns only anonymous tenant aggregates', async () => {
  const { service } = fixture({ limits: { minGroupSize: 5 } });
  for (let index = 1; index < 5; index += 1) {
    await service.track(input(subject(index), {
      event: event({ eventId: id(index) }),
    }));
  }
  const small = await service.dashboard({ context: context() });
  assert.equal(small.suppressed, true);
  assert.equal(small.totalEvents, null);
  assert.deepEqual(small.features, []);
  assert.equal(small.growthFunnel, null);

  await service.track(input(subject(5), {
    event: event({ eventId: id(5) }),
  }));
  await service.track(input(subject(6), {
    event: event({ eventId: id(6), eventType: 'visit', source: 'seo' }),
  }));
  await service.track(input(subject(7), {
    event: event({ eventId: id(7), eventType: 'visit', source: 'seo' }),
  }));
  await service.track(input(subject(8), {
    event: event({ eventId: id(8), eventType: 'visit', source: 'seo' }),
  }));
  await service.track(input(subject(9), {
    event: event({ eventId: id(9), eventType: 'visit', source: 'seo' }),
  }));
  await service.track(input(subject(10), {
    event: event({ eventId: id(10), eventType: 'visit', source: 'seo' }),
  }));
  const dashboard = await service.dashboard({ context: context() });
  assert.equal(dashboard.suppressed, false);
  assert.equal(dashboard.totalEvents, 10);
  assert.ok(dashboard.features.some(row =>
    row.eventType === 'feature.used' && row.featureId === 'reports' && row.count === 5));
  assert.ok(dashboard.features.some(row =>
    row.eventType === 'visit' && row.featureId === 'reports' && row.count === 5));
  assert.deepEqual(dashboard.growthFunnel, { visits: 5 });
  assert.doesNotMatch(JSON.stringify(dashboard), /subject\(|00000000-0000-4000/);

  const lowGroup = fixture().service;
  for (let index = 1; index <= 6; index += 1) {
    await lowGroup.track(input(subject(index), {
      event: event({
        eventId: id(index),
        featureId: index === 1 ? 'search' : 'reports',
      }),
    }));
  }
  const grouped = await lowGroup.dashboard({ context: context() });
  assert.equal(grouped.suppressed, true);
  assert.equal(grouped.totalEvents, null);
  assert.deepEqual(grouped.features, [
    { eventType: 'feature.used', featureId: 'reports', count: 5 },
  ]);

  const repeated = fixture().service;
  for (let index = 1; index <= 5; index += 1) {
    await repeated.track(input(subject(1), {
      event: event({
        eventId: id(index),
        featureId: 'search',
      }),
    }));
  }
  const repeatedOnly = await repeated.dashboard({ context: context() });
  assert.equal(repeatedOnly.suppressed, true);
  assert.equal(repeatedOnly.totalEvents, null);

  for (let index = 1; index <= 5; index += 1) {
    await repeated.track(input(subject(index + 1), {
      event: event({
        eventId: id(index + 10),
        featureId: 'reports',
      }),
    }));
  }
  const repeatedGroup = await repeated.dashboard({ context: context() });
  assert.equal(repeatedGroup.suppressed, true);
  assert.equal(repeatedGroup.totalEvents, null);
  assert.deepEqual(repeatedGroup.features, [
    { eventType: 'feature.used', featureId: 'reports', count: 5 },
  ]);

  const funnelDisclosure = fixture().service;
  for (let index = 1; index <= 5; index += 1) {
    await funnelDisclosure.track(input(subject(index), {
      event: event({
        eventId: id(index),
        eventType: 'visit',
        source: 'seo',
      }),
    }));
  }
  await funnelDisclosure.track(input(subject(6), {
    event: event({
      eventId: id(6),
      eventType: 'visit',
      featureId: 'search',
      source: 'seo',
    }),
  }));
  const noComplement = await funnelDisclosure.dashboard({ context: context() });
  assert.equal(noComplement.totalEvents, null);
  assert.deepEqual(noComplement.features, [
    { eventType: 'visit', featureId: 'reports', count: 5 },
  ]);
  assert.deepEqual(noComplement.growthFunnel, {});
});

test('exports only the authorized subject data, revocation deletes and suppresses future collection', async () => {
  const { service } = fixture();
  await service.track(input());
  await service.track(input(subject(2), {
    event: event({ eventId: id(2) }),
  }));

  const ownExport = await service.exportSubject({
    context: context(),
    subjectKey: subject(1),
  });
  assert.equal(ownExport.length, 1);
  assert.equal(ownExport[0].eventId, id(1));
  assert.doesNotMatch(JSON.stringify(ownExport), /document|prompt|content/u);

  assert.equal(await service.revokeConsent({
    context: context(),
    subjectKey: subject(1),
  }), 1);
  assert.deepEqual(await service.exportSubject({
    context: context(),
    subjectKey: subject(1),
  }), []);
  await expectCode(service.track(input()), 'CONSENT_REQUIRED');

  assert.equal(await service.grantConsent({
    context: context(),
    subjectKey: subject(1),
  }), true);
  assert.deepEqual(await service.track(input()), { accepted: true, duplicate: false });
});

test('serializes consent revocation against an in-flight event append', async () => {
  let consent = true;
  let signalConsentCheck;
  let releaseConsentCheck;
  const consentCheckStarted = new Promise(resolve => { signalConsentCheck = resolve; });
  const consentCheckGate = new Promise(resolve => { releaseConsentCheck = resolve; });
  const service = createAnalyticsService({
    store: createMemoryAnalyticsStore(),
    authorize: async () => true,
    checkConsent: async () => {
      signalConsentCheck();
      await consentCheckGate;
      return consent;
    },
    setConsent: async ({ granted }) => {
      consent = granted;
      return true;
    },
    features: ['reports'],
    clock: () => NOW,
  });
  const tracking = service.track(input());
  await consentCheckStarted;
  const revocation = service.revokeConsent({
    context: context(),
    subjectKey: subject(1),
  });
  releaseConsentCheck();

  assert.deepEqual(await tracking, { accepted: true, duplicate: false });
  assert.equal(await revocation, 1);
  assert.deepEqual(await service.exportSubject({
    context: context(),
    subjectKey: subject(1),
  }), []);
  await expectCode(service.track(input()), 'CONSENT_REQUIRED');
});

test('applies retention on cleanup and rejects events outside the configured window', async () => {
  const { service, setTime } = fixture({ limits: { retentionDays: 2 } });
  await service.track(input());
  await expectCode(service.track(input(subject(2), {
    event: event({
      eventId: id(2),
      occurredAt: new Date(NOW - 3 * 86400000).toISOString(),
    }),
  })), 'INVALID_INPUT');

  setTime(NOW + 3 * 86400000);
  const result = await service.cleanup({ context: context() });
  assert.equal(result, 1);
  const dashboard = await service.dashboard({ context: context() });
  assert.equal(dashboard.suppressed, true);
  assert.equal(dashboard.totalEvents, null);
});

test('suppresses Growth funnel counts against the same 90-day window they aggregate', async () => {
  const { service } = fixture({ limits: { retentionDays: 120 } });
  for (let index = 1; index <= 4; index += 1) {
    await service.track(input(subject(index), {
      event: event({
        eventId: id(index),
        eventType: 'visit',
        source: 'seo',
      }),
    }));
  }
  await service.track(input(subject(5), {
    event: event({
      eventId: id(5),
      eventType: 'visit',
      source: 'seo',
      occurredAt: new Date(NOW - 100 * 86400000).toISOString(),
    }),
  }));
  const dashboard = await service.dashboard({ context: context() });
  assert.equal(dashboard.totalEvents, 5);
  assert.deepEqual(dashboard.growthFunnel, {});
});

test('rejects malformed contexts and sensitive or unbounded event shapes', async () => {
  const { service } = fixture();
  await expectCode(service.dashboard({
    context: { ...context(), role: 'owner' },
  }), 'INVALID_TENANT_CONTEXT');
  await expectCode(service.track(input('person@example.invalid')), 'INVALID_SUBJECT');
  await expectCode(service.track(input(subject(1), {
    event: event({ occurredAt: '2026-11-09T12:00:00Z' }),
  })), 'INVALID_INPUT');
  await expectCode(service.track(input(subject(1), {
    event: event({ occurredAt: new Date(NOW + 1000).toISOString() }),
  })), 'INVALID_INPUT');
});
