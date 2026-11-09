import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAuthService } from '../modules/auth/index.mjs';
import {
  createUxAuthActions,
  createUxSettingsActions,
} from '../modules/ux/actions.mjs';

const modulePath = fileURLToPath(new URL('../modules/ux/', import.meta.url));

function fakeAuth(overrides = {}) {
  const calls = [];
  const auth = {
    async register(input) {
      calls.push(['register', input]);
    },
    async login(input) {
      calls.push(['login', input]);
      return { user: { id: 'authenticated-user' }, csrfToken: 'csrf-token', setCookie: 'session-cookie' };
    },
    async requestPasswordReset(input) {
      calls.push(['requestPasswordReset', input]);
      return { accepted: true };
    },
    async completePasswordReset(input) {
      calls.push(['completePasswordReset', input]);
      return { accepted: true };
    },
    async currentUser(input) {
      calls.push(['currentUser', input]);
      return { id: 'authenticated-user' };
    },
    async logout(input) {
      calls.push(['logout', input]);
      return { setCookie: 'expired-session-cookie' };
    },
    ...overrides,
  };
  return { auth, calls };
}

function makeAuthActions(auth, overrides = {}) {
  const cookieCalls = [];
  const actions = createUxAuthActions({
    auth,
    origin: 'http://localhost:3000',
    getRateLimitActor: async () => '127.0.0.1',
    getCookieHeader: async () => 'sf_session=valid',
    getCsrfToken: async () => 'valid-csrf-token',
    setSessionCookies: async value => cookieCalls.push(['set', value]),
    clearSessionCookie: async value => cookieCalls.push(['clear', value]),
    ...overrides,
  });
  return { actions, cookieCalls };
}

function localAuthStore() {
  const users = new Map();
  const sessions = new Map();
  const resets = new Map();
  const limits = new Map();
  const publicUser = user => user ? {
    id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
  } : null;
  return {
    async findUserByEmail(email) {
      return publicUser(users.get(email));
    },
    async findUserById(id) {
      return publicUser([...users.values()].find(user => user.id === id));
    },
    async createUser(user) {
      if (users.has(user.email)) return false;
      users.set(user.email, user);
      return true;
    },
    async createSessionIfPasswordHashMatches(session, expectedPasswordHash) {
      const user = [...users.values()].find(entry => entry.id === session.userId);
      if (!user || user.passwordHash !== expectedPasswordHash) return false;
      sessions.set(session.tokenHash, session);
      return true;
    },
    async findSessionByTokenHash(tokenHash) {
      const session = sessions.get(tokenHash);
      return session ? {
        userId: session.userId,
        csrfHash: session.csrfHash,
        expiresAt: session.expiresAt,
      } : null;
    },
    async deleteSessionByTokenHash(tokenHash) {
      sessions.delete(tokenHash);
    },
    async rotateSession(oldTokenHash, session) {
      if (!sessions.has(oldTokenHash)) return false;
      sessions.delete(oldTokenHash);
      sessions.set(session.tokenHash, session);
      return true;
    },
    async deleteSessionsByUserId(userId) {
      for (const [hash, session] of sessions) {
        if (session.userId === userId) sessions.delete(hash);
      }
    },
    async createResetToken(reset) {
      resets.set(reset.tokenHash, reset);
    },
    async revokeResetToken(tokenHash) {
      resets.delete(tokenHash);
    },
    async completePasswordReset() {
      return false;
    },
    async consumeRateLimit(key, limit, windowMs, now) {
      let entry = limits.get(key);
      if (!entry || entry.startedAt + windowMs <= now) {
        entry = { startedAt: now, count: 0 };
        limits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
}

function form(entries) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.append(key, value);
  }
  return data;
}

test('auth actions bind forms to the local auth service and store session material server-side', async () => {
  const { auth, calls } = fakeAuth();
  const { actions, cookieCalls } = makeAuthActions(auth);

  assert.deepEqual(await actions.login({}, form({
    email: 'member@example.test',
    password: 'a sufficiently long password',
  })), {
    status: 'success',
    message: 'Connexion réussie.',
  });
  assert.deepEqual(calls[0], ['login', {
    email: 'member@example.test',
    password: 'a sufficiently long password',
    origin: 'http://localhost:3000',
    rateLimitActor: '127.0.0.1',
  }]);
  assert.deepEqual(cookieCalls, [['set', {
    sessionCookie: 'session-cookie',
    csrfToken: 'csrf-token',
  }]]);
});

test('form actions authenticate against the real local auth service and revoke its session on logout', async () => {
  const auth = createAuthService({
    store: localAuthStore(),
    origin: 'http://localhost:3000',
    localResetChannel: { kind: 'local', deliver: async () => {} },
    clock: () => Date.UTC(2026, 0, 1),
  });
  let sessionCookie = '';
  let csrfToken = '';
  const actions = createUxAuthActions({
    auth,
    origin: 'http://localhost:3000',
    getRateLimitActor: async () => '127.0.0.1',
    getCookieHeader: async () => sessionCookie.split(';', 1)[0],
    getCsrfToken: async () => csrfToken,
    setSessionCookies: async value => {
      sessionCookie = value.sessionCookie;
      csrfToken = value.csrfToken;
    },
    clearSessionCookie: async value => {
      sessionCookie = value;
      csrfToken = '';
    },
  });

  assert.equal((await actions.signup({}, form({
    email: 'local@example.test',
    password: 'a sufficiently long password',
  }))).status, 'success');
  assert.equal((await actions.login({}, form({
    email: 'local@example.test',
    password: 'a sufficiently long password',
  }))).status, 'success');
  const currentUser = await auth.currentUser({
    cookieHeader: sessionCookie.split(';', 1)[0],
  });
  assert.match(currentUser.id, /^[0-9a-f-]{36}$/u);
  assert.equal((await actions.logout({}, new FormData())).status, 'success');
  assert.equal(await auth.currentUser({
    cookieHeader: sessionCookie.split(';', 1)[0],
  }), null);
});

test('signup and reset actions use local auth methods and do not reveal account existence', async () => {
  const { auth, calls } = fakeAuth();
  const { actions } = makeAuthActions(auth);

  assert.equal((await actions.signup({}, form({
    email: 'member@example.test',
    password: 'a sufficiently long password',
  }))).status, 'success');
  assert.equal((await actions.requestPasswordReset({}, form({
    email: 'unknown@example.test',
  }))).message, 'Si un compte correspond, les instructions seront transmises au canal local.');
  assert.equal((await actions.completePasswordReset({}, form({
    token: 'A'.repeat(43),
    newPassword: 'a different long password',
  }))).status, 'success');
  assert.deepEqual(calls.map(([method]) => method), [
    'register',
    'requestPasswordReset',
    'completePasswordReset',
  ]);
});

test('actions reject unknown or oversized form fields and never echo secrets from auth errors', async () => {
  let loginCalls = 0;
  const { auth } = fakeAuth({
    async login() {
      loginCalls += 1;
      throw Object.assign(new Error('******'), {
        name: 'AuthModuleError',
        code: 'AUTHENTICATION_FAILED',
      });
    },
  });
  const { actions } = makeAuthActions(auth);

  const unknown = await actions.login({}, form({
    email: 'member@example.test',
    password: 'password value',
    role: 'owner',
  }));
  assert.equal(unknown.status, 'error');
  assert.equal(loginCalls, 0);

  const oversized = await actions.login({}, form({
    email: 'member@example.test',
    password: 'x'.repeat(1025),
  }));
  assert.equal(oversized.status, 'error');
  assert.equal(loginCalls, 0);

  const failed = await actions.login({}, form({
    email: 'member@example.test',
    password: 'incorrect password value',
  }));
  assert.equal(failed.message, 'Adresse e-mail ou mot de passe invalide.');
  assert.equal(failed.message.includes('must-not-be-returned'), false);
  assert.equal(loginCalls, 1);
});

test('logout obtains cookies and CSRF context on the server and clears the returned cookie', async () => {
  const { auth, calls } = fakeAuth();
  const { actions, cookieCalls } = makeAuthActions(auth);

  assert.equal((await actions.logout({}, new FormData())).status, 'success');
  assert.deepEqual(calls[0], ['logout', {
    cookieHeader: 'sf_session=valid',
    csrfToken: 'valid-csrf-token',
    origin: 'http://localhost:3000',
  }]);
  assert.deepEqual(cookieCalls, [['clear', 'expired-session-cookie']]);
});

test('settings require a current local session and derive the settings key from authenticated identity', async () => {
  const { auth, calls } = fakeAuth();
  const writes = [];
  const store = {
    async loadForUser(userId) {
      writes.push(['load', userId]);
      return { theme: 'dark', density: 'compact' };
    },
    async saveForUser(value) {
      writes.push(['save', value]);
    },
  };
  const actions = createUxSettingsActions({
    auth,
    store,
    getCookieHeader: async () => 'sf_session=valid',
  });

  assert.deepEqual(await actions.load(), { theme: 'dark', density: 'compact' });
  assert.equal((await actions.save({}, form({
    theme: 'light',
    density: 'comfortable',
  }))).status, 'success');
  assert.deepEqual(writes, [
    ['load', 'authenticated-user'],
    ['save', {
      userId: 'authenticated-user',
      theme: 'light',
      density: 'comfortable',
    }],
  ]);
  assert.ok(calls.every(([method]) => method === 'currentUser'));
});

test('settings fail closed for absent sessions and client-supplied user identifiers', async () => {
  let storeCalls = 0;
  const { auth } = fakeAuth({
    async currentUser() {
      return null;
    },
  });
  const actions = createUxSettingsActions({
    auth,
    store: {
      async loadForUser() {
        storeCalls += 1;
        return { theme: 'system', density: 'comfortable' };
      },
      async saveForUser() {
        storeCalls += 1;
      },
    },
    getCookieHeader: async () => 'sf_session=missing',
  });

  assert.equal(await actions.load(), null);
  assert.equal((await actions.save({}, form({
    theme: 'dark',
    density: 'compact',
  }))).status, 'error');
  assert.equal((await actions.save({}, form({
    theme: 'dark',
    density: 'compact',
    userId: 'attacker-selected-user',
  }))).status, 'error');
  assert.equal(storeCalls, 0);
});

test('publishes stable routes and accessible component, theme, and responsive navigation contracts', () => {
  const routes = readFileSync(`${modulePath}/routes.ts`, 'utf8');
  const forms = readFileSync(`${modulePath}/components/auth-forms.tsx`, 'utf8');
  const settings = readFileSync(`${modulePath}/components/user-settings.tsx`, 'utf8');
  const navigation = readFileSync(`${modulePath}/components/mobile-navigation.tsx`, 'utf8');
  const shell = readFileSync(`${modulePath}/components/app-shell.tsx`, 'utf8');
  const dashboard = readFileSync(`${modulePath}/components/dashboard.tsx`, 'utf8');
  const theme = readFileSync(`${modulePath}/components/theme-toggle.tsx`, 'utf8');
  const themeContract = readFileSync(`${modulePath}/theme.ts`, 'utf8');
  const css = readFileSync(`${modulePath}/design-system.css`, 'utf8');

  for (const route of [
    '/dashboard',
    '/login',
    '/signup',
    '/reset-password',
    '/reset-password/complete',
    '/settings',
  ]) {
    assert.ok(routes.includes(`"${route}"`));
  }
  for (const component of [
    'LoginForm',
    'SignupForm',
    'PasswordResetRequestForm',
    'PasswordResetCompleteForm',
    'LogoutForm',
  ]) {
    assert.ok(forms.includes(`function ${component}`));
  }
  const formFields = [...forms.matchAll(/<(?:input|select)\b[\s\S]*?\/?>/gu)]
    .map(([field]) => field);
  const fieldIds = formFields.map(field => field.match(/\bid="([^"]+)"/u)?.[1]).filter(Boolean);
  const labelIds = [...forms.matchAll(/<label htmlFor="([^"]+)">/gu)].map(([, id]) => id);
  assert.ok(fieldIds.length > 0);
  assert.deepEqual([...fieldIds].sort(), [...labelIds].sort());
  assert.match(forms, /role=\{state\.status === "error" \? "alert" : "status"\}/u);
  assert.match(forms, /aria-live="polite"/u);
  assert.match(forms, /aria-busy=\{pending\}/u);
  assert.match(settings, /<legend>Préférences d’affichage<\/legend>/u);
  assert.match(settings, /defaultValue=\{initialPreferences\.theme\}/u);
  assert.match(settings, /applyThemePreference\(theme\)/u);
  assert.match(settings, /root\.dataset\.density = density/u);
  assert.match(theme, /window\.addEventListener\(THEME_CHANGE_EVENT, syncTheme\)/u);
  assert.match(themeContract, /window\.dispatchEvent\(new CustomEvent\(THEME_CHANGE_EVENT\)\)/u);
  assert.match(themeContract, /document\.documentElement\.dataset\.theme = theme/u);
  assert.match(navigation, /aria-expanded=\{open\}/u);
  assert.match(navigation, /aria-controls="ux-mobile-menu"/u);
  assert.match(navigation, /event\.key !== "Escape"/u);
  assert.match(shell, /href="#main-content"/u);
  assert.match(shell, /<main[^>]*tabIndex=\{-1\}/u);
  assert.match(dashboard, /aria-labelledby="dashboard-title"/u);
  assert.match(theme, /aria-pressed=\{theme === "dark"\}/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /prefers-color-scheme: dark/u);
  assert.match(css, /@media \(max-width: 48rem\)/u);
  assert.match(css, /prefers-reduced-motion: reduce/u);
  assert.match(css, /:root\[data-density="compact"\]/u);
});
