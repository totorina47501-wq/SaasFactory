import { createHash } from 'node:crypto';

const trustedModules = Object.freeze({
  'ai-disabled': { version: '1.0.0', files: ['lib/ai-disabled.mjs'] },
  api: { version: '1.0.0', files: ['app/api/example/route.js'] },
  auth: { version: '1.0.0', files: ['lib/auth.mjs'] },
  'billing-test': { version: '1.0.0', files: ['lib/billing-test.mjs'] },
  media: { version: '1.0.0', files: ['lib/media-fixture.mjs', 'public/media-fixture.svg'] },
});
const safePathPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(message) {
  throw new Error(`Generator v2 composition failed: ${message}`);
}

function validatePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 256 || !safePathPattern.test(filePath) ||
      filePath.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) {
    fail('unsafe generated file path.');
  }
}

function hashContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function composeModuleFiles(resolved, sourceFiles) {
  if (!resolved || !Array.isArray(resolved.modules) || !Array.isArray(resolved.limitations) ||
      !(sourceFiles instanceof Map)) {
    fail('invalid composition input.');
  }

  const pathsByCase = new Map();
  for (const [filePath, content] of sourceFiles) {
    validatePath(filePath);
    if (typeof content !== 'string') fail('generated file content must be text.');
    const folded = filePath.toLowerCase();
    const collision = pathsByCase.get(folded);
    if (collision) fail('generated paths collide by case.');
    pathsByCase.set(folded, filePath);
  }

  const modules = [];
  const seenModules = new Set();
  for (const descriptor of resolved.modules) {
    const id = descriptor?.id;
    const version = descriptor?.version;
    const trusted = trustedModules[id];
    const trustedFiles = trusted?.files;
    if (!trustedFiles || version !== trusted.version ||
        !Array.isArray(descriptor.generatedFiles) ||
        descriptor.generatedFiles.length !== trustedFiles.length ||
        descriptor.generatedFiles.some((filePath, index) => filePath !== trustedFiles[index]) ||
        seenModules.has(id)) {
      fail('module has no matching trusted source manifest.');
    }
    seenModules.add(id);

    const limitationEntry = resolved.limitations.find(item =>
      item.moduleId === id && item.version === version,
    );
    const limitations = limitationEntry?.accepted ?? [];
    if (!Array.isArray(limitations)) fail('invalid module limitations.');
    modules.push(Object.freeze({
      id,
      version,
      maturity: descriptor.maturity,
      limitations: Object.freeze([...limitations]),
    }));
    for (const filePath of trustedFiles) {
      if (typeof sourceFiles.get(filePath) !== 'string') fail('a declared module source is missing.');
    }
  }

  modules.sort((left, right) => compareText(left.id, right.id));
  const hashes = [...sourceFiles]
    .map(([filePath, content]) => Object.freeze({ path: filePath, sha256: hashContent(content) }))
    .sort((left, right) => compareText(left.path, right.path));
  return Object.freeze({
    files: sourceFiles,
    modules: Object.freeze(modules),
    hashes: Object.freeze(hashes),
  });
}
