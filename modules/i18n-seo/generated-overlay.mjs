import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRobots, createSitemap, LOCALES, PUBLIC_ROUTES, marketingPage } from './index.mjs';

const CORE_FILES = Object.freeze(['globals.css', 'layout.tsx', 'page.tsx']);
function readSafe(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw Error('Unsafe generated app file');
  return fs.readFileSync(file, 'utf8');
}
function readUntouchedStarter(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw Error('Project directory required');
  const root = path.resolve(dir);
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root ||
      fs.existsSync(path.join(root, '.git'))) throw Error('Unsafe generated project');
  const appDir = path.join(root, 'app');
  const names = fs.readdirSync(appDir);
  if (names.length !== CORE_FILES.length || names.some(name => !CORE_FILES.includes(name))) {
    throw Error('Only untouched neutral ai-disabled starter is supported');
  }
  const layout = readSafe(path.join(appDir, 'layout.tsx'));
  const page = readSafe(path.join(appDir, 'page.tsx'));
  const smoke = readSafe(path.join(root, 'tests/smoke.test.mjs'));
  if (!readSafe(path.join(root, 'README.md')).includes('Neutral SaaS starter.') ||
      !layout.includes("import './globals.css'") ||
      !layout.includes("title: 'SaaS project'") ||
      !page.includes('This neutral starter is ready for your product.') ||
      !smoke.includes('../app/page.tsx')) throw Error('Unexpected starter template');
  return { root, layout, page, smoke };
}

function localizedPage(origin, locale, route) {
  const copy = marketingPage({ origin, locale, route });
  const meta = copy.metadata;
  const metadata = {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: meta.canonical, languages: meta.alternates.languages },
    robots: { index: false, follow: false },
  };
  const data = {
    title: copy.title, description: copy.description, note: copy.disclaimer,
    links: copy.links,
    languages: LOCALES.map(lang => ({ href: '/' + lang + (route === '/' ? '' : route), label: lang })),
  };
  return [
    "import type { Metadata } from 'next';",
    'export const metadata: Metadata = ' + JSON.stringify(metadata, null, 2) + ';',
    'const copy = ' + JSON.stringify(data, null, 2) + ';',
    'export default function LocalizedPage() {',
    '  return (<main>',
    '    <nav aria-label="Main navigation">{copy.links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}</nav>',
    '    <nav aria-label="Choose a language">{copy.languages.map(link => <a key={link.href} href={link.href} lang={link.label}>{link.label}</a>)}</nav>',
    '    <h1>{copy.title}</h1><p>{copy.description}</p>',
    '    <p role="note">{copy.note}</p>',
    '  </main>);',
    '}',
    '',
  ].join('\n');
}
function planFiles(starter, origin) {
  const files = new Map();
  const layout = starter.layout.replace("import './globals.css'", "import '../globals.css'")
    .replace("description: 'A neutral application starter.',",
             "description: 'A neutral application starter.',\n  robots: { index: false, follow: false },");
  if (!layout.includes('robots: { index: false')) throw Error('Unknown root layout');
  files.set('app/(default)/layout.tsx', layout);
  files.set('app/(default)/page.tsx', starter.page.replace('</main>',
    '  <nav aria-label="Choose a language"><a href="/fr-FR">Français</a> <a href="/en">English</a></nav>\n    </main>'));
  for (const locale of LOCALES) {
    files.set('app/' + locale + '/layout.tsx', [
      "import '../globals.css';",
      'export default function LocaleLayout({ children }: Readonly<{ children: React.ReactNode }>) {',
      '  return <html lang=' + JSON.stringify(locale) + '><body>{children}</body></html>;',
      '}',
      '',
    ].join('\n'));
    for (const route of PUBLIC_ROUTES) {
      files.set('app/' + locale + (route === '/' ? '' : route) + '/page.tsx', localizedPage(origin, locale, route));
    }
  }
  files.set('app/robots.ts', "import type { MetadataRoute } from 'next';\nexport default function robots(): MetadataRoute.Robots { return " +
    JSON.stringify(createRobots({ origin }), null, 2) + "; }\n");
  createSitemap({ origin }); // validates the public origin and route contract
  files.set('app/sitemap.ts', "import type { MetadataRoute } from 'next';\nexport default function sitemap(): MetadataRoute.Sitemap { return []; }\n");
  return files;
}

/** Opt-in only for a pristine independent neutral Next.js v1 starter; no publication. */
export function integrateNeutralI18nSeo({ projectDir, origin, write = false } = {}) {
  if (typeof write !== 'boolean') throw Error('write must be boolean');
  const starter = readUntouchedStarter(projectDir);
  const files = planFiles(starter, origin);
  const digest = createHash('sha256').update([...files].map(([name, value]) => name + ':' + value).join('\n')).digest('hex');
  const summary = Object.freeze({
    status: write ? 'written' : 'dry-run', projectDir: starter.root,
    files: [...files.keys()].sort(), sha256: digest, publishEnabled: false,
  });
  if (!write) return summary;
  for (const name of files.keys()) if (fs.existsSync(path.join(starter.root, name))) {
    throw Error('Overlay already exists: ' + name);
  }
  const created = [], removed = [];
  const layoutPath = path.join(starter.root, 'app/layout.tsx');
  const pagePath = path.join(starter.root, 'app/page.tsx');
  const smokePath = path.join(starter.root, 'tests/smoke.test.mjs');
  try {
    for (const [name, contents] of files) {
      const target = path.join(starter.root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, { flag: 'wx', encoding: 'utf8' });
      created.push(target);
    }
    fs.writeFileSync(smokePath, starter.smoke.replace('../app/page.tsx', '../app/(default)/page.tsx'), 'utf8');
    fs.unlinkSync(layoutPath); removed.push(layoutPath);
    fs.unlinkSync(pagePath); removed.push(pagePath);
  } catch (error) {
    if (removed.includes(layoutPath)) fs.writeFileSync(layoutPath, starter.layout, { flag: 'wx' });
    if (removed.includes(pagePath)) fs.writeFileSync(pagePath, starter.page, { flag: 'wx' });
    fs.writeFileSync(smokePath, starter.smoke, 'utf8');
    for (const file of created.reverse()) fs.rmSync(file, { force: true });
    throw error;
  }
  return summary;
}
