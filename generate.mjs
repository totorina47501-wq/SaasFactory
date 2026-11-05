#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleOrder = ['ai-disabled', 'api', 'auth', 'billing-test', 'media'];
const allowedModules = new Set(moduleOrder);
const allowedTargets = new Set(['none', 'cloudflare-opennext']);
const requiredKeys = [
  'schemaVersion',
  'productName',
  'projectSlug',
  'domain',
  'modules',
  'languages',
  'defaultLanguage',
  'deploymentTarget',
];
const reservedSlugs = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const excludedMarkers = [
  /mentioncheck/i,
  /\bmia\b/i,
  /\brag\b/i,
  /mentioncheck\.toto-rina47501\.workers\.dev/i,
  /\b(?:sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function parseConfigText(text) {
  if (Buffer.byteLength(text, 'utf8') > 65_536) {
    throw new Error('Configuration exceeds the 64 KiB limit.');
  }

  let cursor = 0;
  const fail = () => {
    throw new Error(`Invalid JSON configuration at offset ${cursor}.`);
  };
  const skipWhitespace = () => {
    while (/[ \t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor += 1;
  };

  function parseString() {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch {
          fail();
        }
      }
      if (character === '\\') {
        cursor += 2;
      } else {
        if (character.charCodeAt(0) < 0x20) fail();
        cursor += 1;
      }
    }
    fail();
  }

  function parseValue(depth = 0) {
    if (depth > 64) throw new Error('Configuration nesting exceeds 64 levels.');
    skipWhitespace();
    const character = text[cursor];
    if (character === '"') return parseString();
    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (text[cursor] === '}') {
        cursor += 1;
        return result;
      }
      while (cursor < text.length) {
        skipWhitespace();
        if (text[cursor] !== '"') fail();
        const key = parseString();
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[cursor] !== ':') fail();
        cursor += 1;
        result[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === '}') {
          cursor += 1;
          return result;
        }
        if (text[cursor] !== ',') fail();
        cursor += 1;
      }
      fail();
    }
    if (character === '[') {
      cursor += 1;
      skipWhitespace();
      const result = [];
      if (text[cursor] === ']') {
        cursor += 1;
        return result;
      }
      while (cursor < text.length) {
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[cursor] === ']') {
          cursor += 1;
          return result;
        }
        if (text[cursor] !== ',') fail();
        cursor += 1;
      }
      fail();
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numberPattern.lastIndex = cursor;
    const numberMatch = numberPattern.exec(text);
    if (numberMatch) {
      cursor = numberPattern.lastIndex;
      return Number(numberMatch[0]);
    }
    fail();
  }

  const value = parseValue();
  skipWhitespace();
  if (cursor !== text.length) fail();
  return value;
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Configuration must be a JSON object.');
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !requiredKeys.includes(key));
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`Unknown configuration field: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`Missing configuration field: ${missing.join(', ')}`);

  if (value.schemaVersion !== 1) throw new Error('schemaVersion must be exactly 1.');
  if (typeof value.productName !== 'string') throw new Error('productName must be a string.');
  const productName = value.productName.trim();
  if (productName.length < 2 || productName.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(productName)) {
    throw new Error('productName must contain 2 to 80 printable characters.');
  }

  if (typeof value.projectSlug !== 'string' ||
      value.projectSlug.length > 48 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.projectSlug) ||
      reservedSlugs.has(value.projectSlug)) {
    throw new Error('projectSlug must be a safe lowercase ASCII slug of at most 48 characters.');
  }

  if (typeof value.domain !== 'string' || value.domain.length > 253) {
    throw new Error('domain must be a valid lowercase ASCII DNS name.');
  }
  const labels = value.domain.split('.');
  if (labels.length < 2 || labels.some((label) =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('domain must contain valid lowercase ASCII DNS labels.');
  }

  if (!Array.isArray(value.modules) || value.modules.length === 0) {
    throw new Error('modules must be a non-empty array.');
  }
  if (value.modules.some((module) => typeof module !== 'string' || !allowedModules.has(module))) {
    throw new Error('modules contains an unsupported value.');
  }
  if (new Set(value.modules).size !== value.modules.length) {
    throw new Error('modules must not contain duplicates.');
  }
  if (!value.modules.includes('ai-disabled')) {
    throw new Error('modules must include ai-disabled.');
  }

  if (!Array.isArray(value.languages) || value.languages.length === 0) {
    throw new Error('languages must be a non-empty array.');
  }
  const languages = value.languages.map((language) => {
    if (typeof language !== 'string') throw new Error('languages values must be strings.');
    let canonical;
    try {
      [canonical] = Intl.getCanonicalLocales(language);
    } catch {
      throw new Error(`Invalid canonical BCP 47 language: ${language}`);
    }
    if (canonical !== language) throw new Error(`Language must be canonical BCP 47: ${language}`);
    return canonical;
  });
  if (new Set(languages).size !== languages.length) {
    throw new Error('languages must not contain duplicates.');
  }
  if (typeof value.defaultLanguage !== 'string' || !languages.includes(value.defaultLanguage)) {
    throw new Error('defaultLanguage must be included in languages.');
  }
  if (typeof value.deploymentTarget !== 'string' || !allowedTargets.has(value.deploymentTarget)) {
    throw new Error('deploymentTarget must be none or cloudflare-opennext.');
  }

  return {
    schemaVersion: 1,
    productName,
    projectSlug: value.projectSlug,
    domain: value.domain,
    modules: moduleOrder.filter((module) => value.modules.includes(module)),
    languages,
    defaultLanguage: value.defaultLanguage,
    deploymentTarget: value.deploymentTarget,
  };
}

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeMarkdownJson(value) {
  return jsonFile(value)
    .replaceAll('`', '\\u0060')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function buildSmokeTests(config) {
  const imports = [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "import test from 'node:test';",
    "import { aiEnabled } from '../lib/ai-disabled.mjs';",
  ];
  const tests = [
    `test('starter page and AI-disabled default are present', async () => {
  const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /Welcome/);
  assert.equal(aiEnabled, false);
});`,
  ];

  if (config.modules.includes('api')) {
    imports.push("import { GET } from '../app/api/example/route.js';");
    tests.push(`test('example API route returns its neutral payload', async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: 'Example API route is ready.' });
});`);
  }
  if (config.modules.includes('auth')) {
    imports.push("import { createAuthBoundary } from '../lib/auth.mjs';");
    tests.push(`test('auth boundary requires a user and has no provider credentials', async () => {
  const boundary = createAuthBoundary(async () => 'user-1');
  assert.equal(await boundary.requireUser(), 'user-1');
  await assert.rejects(createAuthBoundary(async () => null).requireUser(), /not authenticated/);
});`);
  }
  if (config.modules.includes('billing-test')) {
    imports.push("import { simulateBillingTest } from '../lib/billing-test.mjs';");
    tests.push(`test('billing-test simulates without handling money', () => {
  assert.deepEqual(simulateBillingTest({ reference: 'local-reference' }), {
    mode: 'test',
    status: 'simulated',
    reference: 'local-reference',
  });
  assert.throws(() => simulateBillingTest({ reference: ' ' }), /reference/);
});`);
  }
  if (config.modules.includes('media')) {
    imports.push("import { mediaFixture } from '../lib/media-fixture.mjs';");
    tests.push(`test('media module uses a synthetic local fixture', async () => {
  assert.equal(mediaFixture.synthetic, true);
  assert.equal(mediaFixture.path, '/media-fixture.svg');
  assert.match(await readFile(new URL('../public/media-fixture.svg', import.meta.url), 'utf8'), /Synthetic fixture/);
});`);
  }
  return `${imports.join('\n')}\n\n${tests.join('\n\n')}\n`;
}

function renderFiles(config) {
  const packageJson = {
    name: config.projectSlug,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      test: 'node --test',
      typecheck: 'tsc --noEmit',
      ...(config.deploymentTarget === 'cloudflare-opennext'
        ? { 'build:worker': 'opennextjs-cloudflare build' }
        : {}),
    },
    engines: { node: '>=22.12.0 <27' },
    dependencies: { next: '15.5.28', react: '19.3.1', 'react-dom': '19.3.1' },
    devDependencies: {
      '@types/node': '22.19.2',
      '@types/react': '19.2.0',
      '@types/react-dom': '19.2.0',
      typescript: '5.9.3',
      ...(config.deploymentTarget === 'cloudflare-opennext'
        ? { '@opennextjs/cloudflare': '1.20.15' }
        : {}),
    },
  };
  const metadata = {
    productName: config.productName,
    projectSlug: config.projectSlug,
    domain: config.domain,
    modules: config.modules,
    languages: config.languages,
    defaultLanguage: config.defaultLanguage,
    deploymentTarget: config.deploymentTarget,
  };
  const files = new Map([
    ['.env.example', '# Placeholders only; configure local values separately.\nNEXT_PUBLIC_APP_URL=REPLACE_WITH_LOCAL_URL\n'],
    ['.github/workflows/ci.yml', `name: Project CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --ignore-scripts --no-audit --no-fund
      - run: npm test
      - run: npm run typecheck
      - run: npm run build
${config.deploymentTarget === 'cloudflare-opennext' ? '      - run: npm run build:worker\n' : ''}`],
    ['.gitignore', `node_modules/
.next/
.open-next/
out/
coverage/
.env
.dev.vars
`],
    ['README.md', `# ${config.projectSlug}

Neutral SaaS starter. Generated files are a clean scaffold, not a copy of another application.

\`\`\`json
${safeMarkdownJson(metadata).trimEnd()}
\`\`\`

Run \`npm install\`, \`npm test\`, \`npm run typecheck\`, then \`npm run dev\`.
See [setup](docs/setup.md) before configuring providers or deployment.
`],
    ['app/globals.css', `:root {
  color-scheme: light;
  font-family: Arial, sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
}

main {
  margin: 4rem auto;
  max-width: 48rem;
  padding: 0 1.5rem;
}
`],
    ['app/layout.tsx', `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SaaS project',
  description: 'A neutral application starter.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="${config.defaultLanguage}">
      <body>{children}</body>
    </html>
  );
}
`],
    ['app/page.tsx', `export default function Home() {
  return (
    <main>
      <h1>Welcome</h1>
      <p>This neutral starter is ready for your product.</p>
    </main>
  );
}
`],
    ['docs/setup.md', `# Setup

- Node.js 22.12 or newer (below 27).
- Install dependencies with \`npm install\`.
- Run \`npm test\`, \`npm run typecheck\`, and \`npm run build\`.
- \`.env.example\` contains placeholders only; add local values yourself if needed.
- No provider, payment, remote repository, or deployment is configured by default.
${config.deploymentTarget === 'cloudflare-opennext'
    ? '\nCloudflare OpenNext configuration is a local build scaffold only. Review it and configure account-specific settings manually; this project does not deploy.\n'
    : ''}
`],
    ['next-env.d.ts', `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`],
    ['next.config.ts', `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;
`],
    ['package.json', jsonFile(packageJson)],
    ['public/.gitkeep', ''],
    ['tests/smoke.test.mjs', buildSmokeTests(config)],
    ['tsconfig.json', jsonFile({
      compilerOptions: {
        target: 'ES2022',
        lib: ['dom', 'dom.iterable', 'es2022'],
        allowJs: false,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    })],
    ['i18n/config.json', jsonFile({
      languages: config.languages,
      defaultLanguage: config.defaultLanguage,
    })],
    ['lib/ai-disabled.mjs', `export const aiEnabled = false;\n`],
  ]);

  for (const language of config.languages) {
    files.set(`i18n/messages/${language}.json`, jsonFile({}));
  }
  if (config.modules.includes('api')) {
    files.set('app/api/example/route.js', `export function GET() {
  return Response.json({ message: 'Example API route is ready.' });
}
`);
  }
  if (config.modules.includes('auth')) {
    files.set('lib/auth.mjs', `export function createAuthBoundary(getCurrentUser) {
  if (typeof getCurrentUser !== 'function') {
    throw new TypeError('getCurrentUser must be a function.');
  }
  return {
    async requireUser() {
      const user = await getCurrentUser();
      if (typeof user !== 'string' || user.length === 0) {
        throw new Error('User is not authenticated.');
      }
      return user;
    },
  };
}
`);
  }
  if (config.modules.includes('billing-test')) {
    files.set('lib/billing-test.mjs', `export function simulateBillingTest({ reference }) {
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    throw new TypeError('A non-empty reference is required.');
  }
  return { mode: 'test', status: 'simulated', reference: reference.trim() };
}
`);
  }
  if (config.modules.includes('media')) {
    files.set('lib/media-fixture.mjs', `export const mediaFixture = Object.freeze({
  path: '/media-fixture.svg',
  contentType: 'image/svg+xml',
  synthetic: true,
});
`);
    files.set('public/media-fixture.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90">
  <rect width="160" height="90" fill="#e5e7eb"/>
  <text x="12" y="48" font-family="sans-serif" font-size="12" fill="#111827">Synthetic fixture</text>
</svg>
`);
  }
  if (config.deploymentTarget === 'cloudflare-opennext') {
    files.set('open-next.config.ts', `import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();
`);
    files.set('wrangler.jsonc', jsonFile({
      name: config.projectSlug,
      main: '.open-next/worker.js',
      compatibility_date: '2025-01-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    }));
  }

  for (const [filePath, content] of files) {
    for (const marker of excludedMarkers) {
      if (marker.test(content)) {
        throw new Error(`Generated content failed the exclusion check: ${filePath}`);
      }
    }
  }
  return new Map([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function assertSafeDirectory(directory, createMissing) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createMissing) return { absolute, exists: false };
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error('Output paths must not contain symbolic links.');
    if (!stat.isDirectory()) throw new Error('Every output root path component must be a directory.');
    if (fs.realpathSync(current) !== current) {
      throw new Error('Output root must use its canonical path.');
    }
  }
  return { absolute, exists: true };
}

function checkDestination(outputRoot, projectSlug, createRoot) {
  const rootStatus = assertSafeDirectory(outputRoot, createRoot);
  const root = rootStatus.absolute;
  const destination = path.join(root, projectSlug);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Destination must be strictly inside the output root.');
  }

  if (rootStatus.exists) {
    const collision = fs.readdirSync(root).find((entry) => entry.toLowerCase() === projectSlug.toLowerCase());
    if (collision) throw new Error('Destination already exists or collides by case.');
  }
  try {
    fs.lstatSync(destination);
    throw new Error('Destination already exists; refusing to overwrite.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { root, destination };
}

function writeFiles(destination, files) {
  fs.mkdirSync(destination);
  for (const [filePath, contents] of files) {
    const segments = filePath.split('/');
    const fileName = segments.pop();
    let directory = destination;
    for (const segment of segments) {
      directory = path.join(directory, segment);
      try {
        fs.mkdirSync(directory);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('Generated paths must not contain symbolic links or non-directories.');
        }
      }
    }
    const filePathname = path.join(directory, fileName);
    fs.writeFileSync(filePathname, contents, { flag: 'wx', mode: 0o644 });
  }
}

function generateProject({ configText, outputRoot, write = false }) {
  if (typeof outputRoot !== 'string' || outputRoot.trim().length === 0) {
    throw new Error('An explicit --output-root is required.');
  }
  const config = validateConfig(parseConfigText(configText));
  const files = renderFiles(config);
  const { root, destination } = checkDestination(outputRoot, config.projectSlug, write);
  if (write) {
    if (!fs.existsSync(root)) assertSafeDirectory(root, true);
    checkDestination(root, config.projectSlug, false);
    writeFiles(destination, files);
  }
  return {
    mode: write ? 'write' : 'dry-run',
    projectSlug: config.projectSlug,
    destination,
    modules: config.modules,
    languages: config.languages,
    defaultLanguage: config.defaultLanguage,
    deploymentTarget: config.deploymentTarget,
    files: [...files.keys()],
    excluded: ['credentials', 'production configuration', 'repository history', 'remote deployment'],
    checks: [
      'camelCase v1 schema',
      'duplicate JSON keys and values',
      'safe destination and collision checks',
      'independent allowlisted templates',
      'exclusion sentinel scan',
      'no network or remote commands',
    ],
  };
}

function parseArguments(args) {
  const options = { config: undefined, outputRoot: undefined, write: false };
  let modeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { help: true };
    if (argument === '--dry-run' || argument === '--write') {
      if (modeSeen) throw new Error('Choose exactly one of --dry-run or --write.');
      modeSeen = true;
      options.write = argument === '--write';
      continue;
    }
    if (argument === '--config' || argument === '--output-root') {
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
        throw new Error(`${argument} requires a value.`);
      }
      const key = argument === '--config' ? 'config' : 'outputRoot';
      if (options[key] !== undefined) throw new Error(`${argument} may only be specified once.`);
      options[key] = args[++index];
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.config) throw new Error('--config is required.');
  if (!options.outputRoot) throw new Error('--output-root is required.');
  return options;
}

function printHelp() {
  return `Usage: node generate.mjs --config <file> --output-root <directory> [--dry-run|--write]

The default is --dry-run. --write creates a new <projectSlug> directory and never overwrites.
`;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(printHelp());
      return;
    }
    const configText = fs.readFileSync(options.config, 'utf8');
    const manifest = generateProject({
      configText,
      outputRoot: options.outputRoot,
      write: options.write,
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`saas-factory: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}

export { generateProject, parseConfigText, validateConfig };
