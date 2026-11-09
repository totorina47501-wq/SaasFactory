import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createJobsService } from '../modules/jobs/index.mjs';
import {
  createNotificationsService,
  NotificationsModuleError,
  notificationsContract,
  renderEmailTemplate,
} from '../modules/notifications/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessions = {
  'tenant-a-user-a': { tenantId: TENANT_A, userId: USER_A },
  'tenant-a-user-b': { tenantId: TENANT_A, userId: USER_B },
  'tenant-b-user-b': { tenantId: TENANT_B, userId: USER_B },
};
const auth = (cookieHeader = 'tenant-a-user-a', tenantId = TENANT_A) => ({
  cookieHeader,
  tenantId,
  requestId: 'request-1',
});

function tenancy() {
  return {
    async resolveTenantContext(input) {
      const session = sessions[input.cookieHeader];
      if (!session || session.tenantId !== input.tenantId) throw new Error('denied');
      return { contractVersion: 1, tenantId: session.tenantId, requestId: input.requestId };
    },
    async listMembers(input) {
      const session = sessions[input.cookieHeader];
      if (!session || session.tenantId !== input.tenantId) throw new Error('denied');
      const ids = input.tenantId === TENANT_A ? [USER_A, USER_B] : [USER_B];
      return ids.map((id, index) => ({
        id,
        email: id === USER_A ? 'user-a@example.test' : 'user-b@example.test',
        role: index === 0 ? 'owner' : 'member',
      }));
    },
  };
}

async function setup({ limits = {}, jobsLimits = {}, clock = () => Date.now() } = {}) {
  const parent = await mkdtemp(resolve(tmpdir(), 'sf-notifications-'));
  await chmod(parent, 0o700);
  const tenantService = tenancy();
  const jobs = createJobsService({
    directory: resolve(parent, 'jobs'),
    tenancy: tenantService,
    limits: jobsLimits,
    clock,
  });
  const notifications = await createNotificationsService({
    directory: resolve(parent, 'notifications'),
    auth: {
      async currentUser({ cookieHeader }) {
        const session = sessions[cookieHeader];
        return session ? { id: session.userId } : null;
      },
    },
    tenancy: tenantService,
    jobs,
    limits,
    clock,
  });
  return {
    parent,
    jobs,
    notifications,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function sendInput(overrides = {}) {
  return {
    ...auth(),
    idempotencyKey: 'notification-key-1',
    title: 'Welcome',
    body: 'Your workspace is ready.',
    ...overrides,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof NotificationsModuleError && error.code === code);
}

test('escapes hostile email content and rejects unversioned or injected template input', () => {
  const rendered = renderEmailTemplate({
    templateVersion: 1,
    subject: '<img src=x onerror=alert(1)> & "',
    body: `<script>alert('x')</script>\n&`,
  });
  assert.equal(rendered.html,
    '<main><h1>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;</h1>' +
    '<p>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;<br>&amp;</p></main>');
  assert.equal(rendered.text, `<script>alert('x')</script>\n&`);
  assert.throws(() => renderEmailTemplate({
    templateVersion: 1, subject: 'safe\r\nBcc: victim@example.test', body: 'body',
  }), error => error instanceof NotificationsModuleError && error.code === 'INVALID_TEMPLATE');
  assert.throws(() => renderEmailTemplate({
    templateVersion: 2, subject: 'safe', body: 'body',
  }), error => error instanceof NotificationsModuleError && error.code === 'INVALID_TEMPLATE');
  assert.throws(() => renderEmailTemplate({
    templateVersion: 1, subject: 'safe', body: 'body', html: '<script>',
  }), error => error instanceof NotificationsModuleError && error.code === 'INVALID_INPUT');
});

test('persists self-scoped tenant notifications and email previews idempotently', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  await fixture.notifications.setPreferences({
    ...auth(),
    inAppEnabled: true,
    emailEnabled: true,
  });
  const input = sendInput({
    title: '<img src=x onerror=alert(1)>',
    body: '<script>alert(1)</script>',
  });
  const first = await fixture.notifications.send(input);
  const duplicate = await fixture.notifications.send(input);
  assert.equal(first.id, duplicate.id);
  assert.equal(Object.hasOwn(first, 'email'), false);
  await expectCode(fixture.notifications.send(sendInput({ body: 'different body' })),
    'IDEMPOTENCY_CONFLICT');
  assert.equal(notificationsContract.version, 1);
  assert.equal(notificationsContract.retryOwner, 'jobs-module');
  assert.equal(notificationsContract.emailTransport, 'local-inbox-only');

  const queue = JSON.parse(await readFile(resolve(fixture.parent, 'jobs', 'jobs-v1.json'), 'utf8'));
  assert.equal(Object.keys(queue.jobs).length, 1);
  assert.deepEqual(Object.keys(Object.values(queue.jobs)[0].payload), ['notificationId', 'tenantId']);
  await expectCode(fixture.notifications.jobHandlers()['notifications.email.preview']({
    payload: { notificationId: first.id, tenantId: TENANT_A },
    tenantContext: { contractVersion: 1, tenantId: TENANT_B, requestId: 'request-1' },
  }), 'TENANT_ACCESS_DENIED');
  assert.deepEqual((await fixture.notifications.list(auth())).map(item => item.id), [first.id]);
  assert.equal((await fixture.notifications.list(auth('tenant-a-user-b'))).length, 0);
  await expectCode(fixture.notifications.list(auth('tenant-b-user-b')), 'TENANT_ACCESS_DENIED');

  await fixture.jobs.runOnce({ handlers: fixture.notifications.jobHandlers() });
  const inbox = await fixture.notifications.listEmailInbox(auth());
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].to, 'user-a@example.test');
  assert.ok(inbox[0].html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(inbox[0].html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(inbox[0].html.includes('<script>'), false);
});

test('honors preferences, read state, deletion, tenant isolation, and retention', async t => {
  let now = 1000;
  const fixture = await setup({ clock: () => now, limits: { retentionMs: 100 } });
  t.after(fixture.dispose);
  await fixture.notifications.setPreferences({
    ...auth(),
    inAppEnabled: false,
    emailEnabled: false,
  });
  const suppressed = await fixture.notifications.send(sendInput({
    idempotencyKey: 'disabled-key',
  }));
  assert.deepEqual(suppressed, { suppressed: true });

  await fixture.notifications.setPreferences({
    ...auth(),
    inAppEnabled: true,
    emailEnabled: false,
  });
  const first = await fixture.notifications.send(sendInput());
  const read = await fixture.notifications.markRead({
    ...auth(), notificationId: first.id,
  });
  assert.equal(read.readAt, now);
  await expectCode(fixture.notifications.markRead({
    ...auth('tenant-a-user-b'), notificationId: first.id,
  }), 'NOT_FOUND');
  assert.equal((await fixture.notifications.list(auth('tenant-a-user-b'))).length, 0);
  assert.equal((await fixture.notifications.list(auth('tenant-b-user-b', TENANT_B))).length, 0);

  await fixture.notifications.delete({ ...auth(), notificationId: first.id });
  assert.deepEqual(await fixture.notifications.list(auth()), []);
  await expectCode(fixture.notifications.delete({
    ...auth(), notificationId: first.id,
  }), 'NOT_FOUND');

  const next = await fixture.notifications.send(sendInput({
    idempotencyKey: 'retention-key',
  }));
  now += 100;
  assert.equal(await fixture.notifications.purgeExpired(), 2);
  assert.deepEqual(await fixture.notifications.list(auth()), []);
  await expectCode(fixture.notifications.markRead({
    ...auth(), notificationId: next.id,
  }), 'NOT_FOUND');
});

test('uses the existing jobs retry policy and sanitizes failed delivery details', async t => {
  let now = 2000;
  const fixture = await setup({
    clock: () => now,
    jobsLimits: { maxAttempts: 2, retryBaseMs: 10, retryMaxMs: 10 },
  });
  t.after(fixture.dispose);
  await fixture.notifications.setPreferences({
    ...auth(), inAppEnabled: true, emailEnabled: true,
  });
  await fixture.notifications.send(sendInput());
  const queuePath = resolve(fixture.parent, 'jobs', 'jobs-v1.json');
  const initial = JSON.parse(await readFile(queuePath, 'utf8'));
  const jobId = Object.keys(initial.jobs)[0];
  const handler = fixture.notifications.jobHandlers()['notifications.email.preview'];
  const transient = async () => {
    const error = new Error('private email content must not be persisted');
    error.code = 'TEMPORARY_FAILURE';
    throw error;
  };
  await fixture.jobs.runOnce({ handlers: {
    'notifications.email.preview': transient,
  } });
  let job = await fixture.jobs.get({ ...auth(), jobId });
  assert.equal(job.status, 'queued');
  assert.equal(job.attempt, 1);
  now += 10;
  await fixture.jobs.runOnce({ handlers: {
    'notifications.email.preview': handler,
  } });
  job = await fixture.jobs.get({ ...auth(), jobId });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempt, 2);
  const persisted = await readFile(queuePath, 'utf8');
  assert.ok(!persisted.includes('private email content'));
  assert.equal((await fixture.notifications.listEmailInbox(auth())).length, 1);
});
