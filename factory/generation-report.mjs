const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function installationReport(modules, hashes) {
  const moduleLines = modules.map(module =>
    `- \`${module.id}@${module.version}\` (${module.maturity}); limitations: ${module.limitations.join(', ') || 'none'}`,
  );
  const fileLines = hashes.map(file => `- \`${file.path}\` — SHA-256 \`${file.sha256}\``);
  return `# Installation report

This project was generated from trusted, local Factory templates. Generation did not execute module hooks or commands and did not contact external services.

## Selected modules

${moduleLines.join('\n')}

Non-verified modules remain scaffolds; their limitations are listed above and must not be interpreted as production capabilities.

## Generated file checksums

${fileLines.join('\n')}

Review this report and the versioned module contract before installing or extending the project.
`;
}

export function createGenerationReport({
  mode,
  projectSlug,
  destination,
  deploymentTarget,
  modules,
  hashes,
  files,
}) {
  if (!['dry-run', 'write'].includes(mode) || typeof projectSlug !== 'string' ||
      typeof destination !== 'string' || typeof deploymentTarget !== 'string' ||
      !Array.isArray(modules) || !Array.isArray(hashes) || !(files instanceof Map)) {
    throw new Error('Generator v2 report received invalid input.');
  }

  const stableHashes = [...hashes].sort((left, right) => compareText(left.path, right.path));
  const stableModules = [...modules].sort((left, right) => compareText(left.id, right.id));
  const reservedPaths = new Set(['factory-manifest.json', 'docs/installation-report.md']);
  const existingPaths = new Set([...files.keys()].map(filePath => filePath.toLowerCase()));
  if ([...reservedPaths].some(filePath => existingPaths.has(filePath.toLowerCase()))) {
    throw new Error('Generator v2 report paths collide with a generated file.');
  }
  const factoryManifest = {
    schemaVersion: 2,
    generatorVersion: 2,
    projectSlug,
    deploymentTarget,
    modules: stableModules,
    files: stableHashes,
    reportExclusions: ['factory-manifest.json', 'docs/installation-report.md'],
  };
  const generatedFiles = new Map(files);
  generatedFiles.set('factory-manifest.json', jsonFile(factoryManifest));
  generatedFiles.set('docs/installation-report.md', installationReport(stableModules, stableHashes));

  return Object.freeze({
    manifest: Object.freeze({
      schemaVersion: 2,
      generatorVersion: 2,
      mode,
      projectSlug,
      destination,
      deploymentTarget,
      modules: Object.freeze(stableModules),
      files: Object.freeze([...generatedFiles.keys()].sort(compareText)),
      hashes: Object.freeze(stableHashes),
      excluded: Object.freeze(['credentials', 'production configuration', 'repository history', 'remote deployment']),
      checks: Object.freeze([
        'strict schema v2 and explicit module versions',
        'resolved dependencies, incompatibilities, limitations, and offline requirements',
        'trusted local source manifest and SHA-256 file hashes',
        'safe destination, path, case-collision, and symlink checks',
        'no module hooks, declared commands, or network access',
      ]),
    }),
    files: generatedFiles,
  });
}
