const freezeMap = value => Object.freeze(Object.fromEntries(
  Object.entries(value).map(([key, entry]) => [key, Object.freeze(entry)]),
));

export const FEATURES = Object.freeze([
  'api.access',
  'ai.generation',
  'storage.private',
  'jobs.queue',
]);

export const QUOTAS = Object.freeze({
  'api.requests': Object.freeze({ featureId: 'api.access', unit: 'requests' }),
  'ai.tokens': Object.freeze({ featureId: 'ai.generation', unit: 'tokens' }),
  'storage.bytes': Object.freeze({ featureId: 'storage.private', unit: 'bytes' }),
  'jobs.business-units': Object.freeze({ featureId: 'jobs.queue', unit: 'business units' }),
});

export const PLAN_FEATURES = freezeMap({
  free: {
    'api.access': true,
    'ai.generation': false,
    'storage.private': true,
    'jobs.queue': true,
  },
  pro: {
    'api.access': true,
    'ai.generation': true,
    'storage.private': true,
    'jobs.queue': true,
  },
  business: {
    'api.access': true,
    'ai.generation': true,
    'storage.private': true,
    'jobs.queue': true,
  },
});

export const PLAN_QUOTAS = freezeMap({
  free: {
    'api.requests': 1_000,
    'ai.tokens': 0,
    'storage.bytes': 100 * 1024 * 1024,
    'jobs.business-units': 100,
  },
  pro: {
    'api.requests': 10_000,
    'ai.tokens': 100_000,
    'storage.bytes': 5 * 1024 * 1024 * 1024,
    'jobs.business-units': 10_000,
  },
  business: {
    'api.requests': 100_000,
    'ai.tokens': 1_000_000,
    'storage.bytes': 50 * 1024 * 1024 * 1024,
    'jobs.business-units': 100_000,
  },
});
