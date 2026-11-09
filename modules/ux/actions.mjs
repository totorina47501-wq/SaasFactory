const AUTH_METHODS = [
  'register',
  'login',
  'requestPasswordReset',
  'completePasswordReset',
  'currentUser',
  'logout',
];
const THEMES = new Set(['system', 'light', 'dark']);
const DENSITIES = new Set(['comfortable', 'compact']);

const MESSAGES = Object.freeze({
  AUTHENTICATION_FAILED: 'Adresse e-mail ou mot de passe invalide.',
  INVALID_INPUT: 'Vérifiez les champs saisis.',
  INVALID_SESSION: 'Votre session a expiré. Reconnectez-vous.',
  ORIGIN_REJECTED: 'Requête refusée.',
  RATE_LIMITED: 'Trop de tentatives. Réessayez plus tard.',
  RESET_INVALID: 'Le lien de réinitialisation est invalide ou expiré.',
  UNAVAILABLE: 'Service temporairement indisponible.',
});

export class UxActionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'UxActionError';
    this.code = code;
  }
}

function fail(code) {
  throw new UxActionError(code);
}

function exactObject(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONFIGURATION');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_CONFIGURATION');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    fail('INVALID_CONFIGURATION');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_CONFIGURATION');
  }
}

function formValues(formData, fields, limits = {}) {
  if (!(formData instanceof FormData)) fail('INVALID_INPUT');
  for (const [key] of formData) {
    if (!fields.includes(key)) fail('INVALID_INPUT');
  }
  return Object.fromEntries(fields.map(field => {
    const values = formData.getAll(field);
    const maxLength = limits[field] ?? 1024;
    if (values.length !== 1 || typeof values[0] !== 'string' ||
        values[0].length > maxLength || !values[0].isWellFormed()) {
      fail('INVALID_INPUT');
    }
    return [field, values[0]];
  }));
}

function formState(status, message) {
  return Object.freeze({ status, message });
}

function failureState(error, fallback = 'UNAVAILABLE') {
  const code = error instanceof UxActionError || error?.name === 'AuthModuleError'
    ? error.code
    : fallback;
  return formState('error', MESSAGES[code] ?? MESSAGES[fallback]);
}

function validateCookieHeader(value) {
  if (typeof value !== 'string' || value.length > 8192) fail('INVALID_SESSION');
  return value;
}

async function rateLimitActor(getRateLimitActor) {
  const value = await getRateLimitActor();
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) fail('UNAVAILABLE');
  return value;
}

function validateAuthService(auth) {
  if (!auth || AUTH_METHODS.some(method => typeof auth[method] !== 'function')) {
    fail('INVALID_CONFIGURATION');
  }
}

export function createUxAuthActions(options) {
  exactObject(options, [
    'auth',
    'origin',
    'getRateLimitActor',
    'getCookieHeader',
    'getCsrfToken',
    'setSessionCookies',
    'clearSessionCookie',
  ]);
  validateAuthService(options.auth);
  if (typeof options.origin !== 'string' || options.origin.length > 255 ||
      ['getRateLimitActor', 'getCookieHeader', 'getCsrfToken', 'setSessionCookies', 'clearSessionCookie']
        .some(field => typeof options[field] !== 'function')) {
    fail('INVALID_CONFIGURATION');
  }

  const { auth } = options;
  const runFormAction = callback => async (_previousState, formData) => {
    try {
      return await callback(formData);
    } catch (error) {
      return failureState(error);
    }
  };

  const login = runFormAction(async formData => {
    const { email, password } = formValues(formData, ['email', 'password'], {
      email: 254,
      password: 1024,
    });
    const result = await auth.login({
      email,
      password,
      origin: options.origin,
      rateLimitActor: await rateLimitActor(options.getRateLimitActor),
    });
    await options.setSessionCookies({
      sessionCookie: result.setCookie,
      csrfToken: result.csrfToken,
    });
    return formState('success', 'Connexion réussie.');
  });

  const signup = runFormAction(async formData => {
    const { email, password } = formValues(formData, ['email', 'password'], {
      email: 254,
      password: 1024,
    });
    await auth.register({
      email,
      password,
      origin: options.origin,
      rateLimitActor: await rateLimitActor(options.getRateLimitActor),
    });
    return formState('success', 'Si le compte peut être créé, vous pourrez vous connecter.');
  });

  const requestPasswordReset = runFormAction(async formData => {
    const { email } = formValues(formData, ['email'], { email: 254 });
    await auth.requestPasswordReset({
      email,
      origin: options.origin,
      rateLimitActor: await rateLimitActor(options.getRateLimitActor),
    });
    return formState('success', 'Si un compte correspond, les instructions seront transmises au canal local.');
  });

  const completePasswordReset = runFormAction(async formData => {
    const { token, newPassword } = formValues(formData, ['token', 'newPassword'], {
      token: 43,
      newPassword: 1024,
    });
    await auth.completePasswordReset({
      token,
      newPassword,
      origin: options.origin,
      rateLimitActor: await rateLimitActor(options.getRateLimitActor),
    });
    return formState('success', 'Le mot de passe a été mis à jour.');
  });

  const logout = runFormAction(async formData => {
    formValues(formData, []);
    const result = await auth.logout({
      cookieHeader: validateCookieHeader(await options.getCookieHeader()),
      csrfToken: await options.getCsrfToken(),
      origin: options.origin,
    });
    await options.clearSessionCookie(result.setCookie);
    return formState('success', 'Vous êtes déconnecté·e.');
  });

  return Object.freeze({ login, signup, requestPasswordReset, completePasswordReset, logout });
}

function validatePreferences(value) {
  exactObject(value, ['theme', 'density']);
  if (!THEMES.has(value.theme) || !DENSITIES.has(value.density)) fail('INVALID_PREFERENCES');
  return Object.freeze({ theme: value.theme, density: value.density });
}

async function authenticatedUser(auth, getCookieHeader) {
  let user;
  try {
    user = await auth.currentUser({
      cookieHeader: validateCookieHeader(await getCookieHeader()),
    });
  } catch {
    fail('UNAVAILABLE');
  }
  if (!user || typeof user.id !== 'string') return null;
  return user;
}

export function createUxSettingsActions(options) {
  exactObject(options, ['auth', 'store', 'getCookieHeader']);
  if (!options.auth || typeof options.auth.currentUser !== 'function' ||
      !options.store || typeof options.store.loadForUser !== 'function' ||
      typeof options.store.saveForUser !== 'function' ||
      typeof options.getCookieHeader !== 'function') {
    fail('INVALID_CONFIGURATION');
  }

  return Object.freeze({
    async load() {
      const user = await authenticatedUser(options.auth, options.getCookieHeader);
      if (!user) return null;
      try {
        return validatePreferences(await options.store.loadForUser(user.id));
      } catch {
        fail('UNAVAILABLE');
      }
    },

    async save(_previousState, formData) {
      try {
        const values = formValues(formData, ['theme', 'density'], { theme: 10, density: 16 });
        const preferences = validatePreferences(values);
        const user = await authenticatedUser(options.auth, options.getCookieHeader);
        if (!user) return formState('error', MESSAGES.INVALID_SESSION);
        await options.store.saveForUser({ userId: user.id, ...preferences });
        return formState('success', 'Préférences enregistrées.');
      } catch (error) {
        return failureState(error, 'INVALID_INPUT');
      }
    },
  });
}
