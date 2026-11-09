export const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_MS = 30 * DAY_MS;
export const TRIAL_MS = 14 * DAY_MS;
export const STATES = Object.freeze(['trialing', 'active', 'past_due', 'canceled']);
export const EVENT_STATES = Object.freeze({
  'subscription.active': 'active',
  'subscription.past_due': 'past_due',
  'subscription.canceled': 'canceled',
});
export const EVENT_TRANSITIONS = Object.freeze({
  'subscription.active': Object.freeze(['trialing', 'active', 'past_due']),
  'subscription.past_due': Object.freeze(['trialing', 'active', 'past_due']),
  'subscription.canceled': Object.freeze(['trialing', 'active', 'past_due', 'canceled']),
});
export const PLANS = Object.freeze([
  Object.freeze({ id: 'free', name: 'Free', amountCents: 0, currency: 'USD', simulated: true }),
  Object.freeze({ id: 'pro', name: 'Pro', amountCents: 1200, currency: 'USD', simulated: true }),
  Object.freeze({ id: 'business', name: 'Business', amountCents: 4900, currency: 'USD', simulated: true }),
]);
