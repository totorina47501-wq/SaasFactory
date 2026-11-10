#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { launchSeasonal } from '../seasonal/launch.mjs';
import { generateDeployment } from '../deployment/generate.mjs';

const HELP = `Golden Path qualification for generated apps and Docker packaging.

Usage:
  node delivery/golden-path.mjs [--output-root <dir>] [--report-dir <dir>] [--write] [--verify|--check]
  node delivery/golden-path.mjs --help

Options:
  --output-root <dir>  Explicit destination root for generated apps (required with --write).
  --report-dir <dir>   Explicit destination for JSON/Markdown reports (required with --write unless default is accepted).
  --write              Allow file creation. Without this flag, runs strict dry-run only.
  --verify             Execute dependency install/tests/typecheck/build and Docker checks.
  --check              Alias of --verify.
  --help               Show this help.

Safety:
  - Dry-run is default and performs no file writes, dependency installs, Docker build/run, or network operations.
  - --verify requires --write.
  - Unknown CLI options are rejected.
`;

const SEASONAL_PRESETS = Object.freeze(['promo-flash', 'cadeaux-zen', 'noel-memory']);
const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCOMPLETE: 'INCOMPLETE' });
const DEFAULT_DRY_ROOT = path.join(os.tmpdir(), 'saas-factory-golden-path-dry-run');
const OUTPUT_LOG_LIMIT = 16_000;

function trimOutput(text) {
  if (typeof text !== 'string') return '';
  return text.length <= OUTPUT_LOG_LIMIT ? text : text.slice(-OUTPUT_LOG_LIMIT);
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeReadText(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error('Unsafe file read blocked: ' + file);
  }
  return fs.readFileSync(file, 'utf8');
}

function safeWriteNewFile(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
}

function parseCli(argv) {
  const options = {
    outputRoot: undefined,
    reportDir: undefined,
    write: false,
    verify: false,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--write') {
      if (seen.has(arg)) throw new Error('Duplicate --write.');
      options.write = true;
      seen.add(arg);
      continue;
    }
    if (arg === '--verify' || arg === '--check') {
      if (seen.has('--verify')) throw new Error('Duplicate verification flag.');
      options.verify = true;
      seen.add('--verify');
      continue;
    }
    if (arg === '--output-root' || arg === '--report-dir') {
      if (seen.has(arg)) throw new Error('Duplicate ' + arg + '.');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a value.');
      if (arg === '--output-root') options.outputRoot = value;
      else options.reportDir = value;
      seen.add(arg);
      index += 1;
      continue;
    }
    throw new Error('Unknown option: ' + arg);
  }
  if (options.verify && !options.write) {
    throw new Error('--verify/--check requires --write.');
  }
  if (options.write && (!options.outputRoot || !options.outputRoot.trim())) {
    throw new Error('--write requires explicit --output-root.');
  }
  return options;
}

function ensureSafeFreshRoot(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new Error('Invalid output root.');
  }
  const resolved = path.resolve(rootPath);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Unsafe output root parent.');
  }

  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Output root must be a real directory.');
    }
    const entries = fs.readdirSync(resolved);
    if (entries.length > 0) {
      throw new Error('Output root must be empty.');
    }
  } else {
    fs.mkdirSync(resolved, { mode: 0o755 });
  }

  const realResolved = fs.realpathSync(resolved);
  const realParent = fs.realpathSync(parent);
  const prefix = realParent.endsWith(path.sep) ? realParent : realParent + path.sep;
  if (!(realResolved === realParent || realResolved.startsWith(prefix))) {
    throw new Error('Output root escapes safe parent.');
  }
  return resolved;
}

function ensureSafeDirectoryForReports(reportDir) {
  const resolved = path.resolve(reportDir);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) throw new Error('Report directory parent does not exist.');
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Unsafe report directory parent.');

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { mode: 0o755 });
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe report directory.');
  return resolved;
}

function commandVersion(command, args) {
  const run = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (run.status !== 0) return null;
  return trimOutput((run.stdout || run.stderr || '').trim());
}

function runCheckedCommand({ label, command, args, cwd, timeoutMs = 300_000, env = {} }) {
  const startedAt = Date.now();
  const run = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  const durationMs = Date.now() - startedAt;
  const result = {
    label,
    command,
    args,
    cwd,
    timeoutMs,
    durationMs,
    exitCode: run.status,
    signal: run.signal || null,
    stdoutTail: trimOutput(run.stdout || ''),
    stderrTail: trimOutput(run.stderr || ''),
  };
  if (run.error) {
    result.error = run.error.message;
    throw Object.assign(new Error(label + ' failed: ' + run.error.message), { detail: result });
  }
  if (run.status !== 0) {
    throw Object.assign(new Error(label + ' failed with exit code ' + String(run.status)), { detail: result });
  }
  return result;
}

// npm run start launches a Next.js descendant that inherits npm's stdout/stderr.
// Terminating only npm can leave that descendant and its pipe handles alive,
// preventing Node and the CI step from exiting after an otherwise PASS report.
async function stopSmokeProcessTree(child) {
  const sendSignal = (signal) => {
    try {
      // runLocalHttpSmoke starts an isolated POSIX process group; never signal our own group.
      if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };

  let timer;
  let closeListener;
  const closedPromise = new Promise((resolve) => {
    closeListener = () => resolve(true);
    child.once('close', closeListener);
  });
  const alreadyClosed = (child.exitCode !== null || child.signalCode !== null)
    && child.stdout?.destroyed && child.stderr?.destroyed;

  sendSignal('SIGTERM');
  const closed = alreadyClosed ? true : await Promise.race([
    closedPromise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
  ]);
  if (timer) clearTimeout(timer);
  child.off('close', closeListener);

  if (!closed) {
    // Force-stop inherited-pipe holders instead of waiting for the workflow timeout.
    sendSignal('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

async function runLocalHttpSmoke({ cwd, port, timeoutMs = 90_000 }) {
  const args = ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)];
  const child = spawn('npm', args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > OUTPUT_LOG_LIMIT) stdout = stdout.slice(-OUTPUT_LOG_LIMIT);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > OUTPUT_LOG_LIMIT) stderr = stderr.slice(-OUTPUT_LOG_LIMIT);
  });

  const deadline = Date.now() + timeoutMs;
  let responseCode = null;
  let responseBody = null;
  let responseOk = false;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch('http://127.0.0.1:' + String(port) + '/', {
        redirect: 'manual',
        signal: AbortSignal.timeout(3_000),
      });
      responseCode = res.status;
      responseBody = trimOutput(await res.text());
      if (res.ok && /<html/i.test(responseBody)) { responseOk = true; break; }
      lastError = new Error('Unexpected HTTP response status: ' + String(res.status));
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  await stopSmokeProcessTree(child);

  if (!responseOk || responseCode === null || responseBody === null || !/<html/i.test(responseBody)) {
    throw new Error('HTTP smoke failed: ' + (lastError ? String(lastError.message || lastError) : 'server did not become ready'));
  }

  return {
    statusCode: responseCode,
    bodySha256: sha256Text(responseBody),
    stdoutTail: trimOutput(stdout),
    stderrTail: trimOutput(stderr),
  };
}

function seasonalConfig(preset) {
  const names = {
    'promo-flash': ['PromoFlash', 'promo-flash.example'],
    'cadeaux-zen': ['CadeauxZen', 'cadeaux-zen.example'],
    'noel-memory': ['Noël Memory', 'noel-memory.example'],
  };
  const value = names[preset];
  if (!value) throw new Error('Unknown seasonal preset for config: ' + preset);
  return stableJson({
    schemaVersion: 1,
    productName: value[0],
    projectSlug: preset,
    domain: value[1],
    modules: ['ai-disabled'],
    languages: ['fr-FR'],
    defaultLanguage: 'fr-FR',
    deploymentTarget: 'none',
  });
}

function seasonalInteractionChecks(page, preset) {
  if (preset === 'promo-flash') {
    return [
      /Saisissez des montants valides/,
      /inputMode="decimal"/,
      /Votre économie calculée/,
      /aria-live="polite"/,
    ];
  }
  if (preset === 'cadeaux-zen') {
    return [
      /\+ Ajouter un cadeau/,
      /Retirer/,
      /de budget restant|au-dessus du budget/,
      /role="alert"/,
    ];
  }
  return [
    /Paire trouvée/,
    /Ce n\\'est pas une paire/,
    /Bravo, toutes les paires sont trouvées/,
    /Rejouer/,
    /prefers-reduced-motion/,
    /role="group"/,
    /aria-live="polite"/,
  ];
}

function hashExistingFiles(files, rootDir) {
  const items = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = safeReadText(file);
    const relative = path.relative(rootDir, file).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) throw new Error('Evidence file escapes product root.');
    items.push({ file: relative, sha256: sha256Text(content) });
  }
  const digest = sha256Text(items.map((item) => item.file + ':' + item.sha256).join('\n'));
  return { contentSha256: digest, files: items };
}

function choosePort(index) {
  return 4010 + index;
}

function loadMinimalConfigWithSlug(slug) {
  const base = JSON.parse(safeReadText(path.resolve('examples/minimal.json')));
  base.projectSlug = slug;
  base.productName = 'GoldenPath ' + slug;
  base.domain = slug + '.example';
  base.deploymentTarget = 'none';
  return stableJson(base);
}

function dockerIsAvailable() {
  return !!commandVersion('docker', ['--version']);
}

function dockerComposeIsAvailable() {
  const first = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  return first.status === 0;
}

function statusFromChecks(checks) {
  if (checks.some((item) => item.status === STATUS.FAIL)) return STATUS.FAIL;
  if (checks.some((item) => item.status === STATUS.INCOMPLETE)) return STATUS.INCOMPLETE;
  return STATUS.PASS;
}

function summarizeCounts(results) {
  const counts = { PASS: 0, FAIL: 0, INCOMPLETE: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

function markdownReport(report) {
  const lines = [
    '# Golden Path Qualification Report',
    '',
    '- Source SHA: `' + report.sourceSha + '`',
    '- Mode: `' + report.mode + '`',
    '- Node: `' + (report.tools.node ?? 'unknown') + '`',
    '- npm: `' + (report.tools.npm ?? 'unknown') + '`',
    '- Docker: `' + (report.tools.docker ?? 'unavailable') + '`',
    '- Docker Compose: `' + (report.tools.dockerCompose ?? 'unavailable') + '`',
    '',
    '| Product | Profile | Status | Evidence SHA-256 | Notes |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const item of report.results) {
    const notes = item.notes.length === 0 ? 'n/a' : item.notes.join(' ; ');
    lines.push('| ' + item.product + ' | ' + item.profile + ' | ' + item.status + ' | `' + item.contentSha256 + '` | ' + notes.replace(/\|/g, '/') + ' |');
  }

  lines.push('');
  lines.push('## Check Details');
  lines.push('');
  for (const item of report.results) {
    lines.push('### ' + item.product + ' / ' + item.profile);
    lines.push('');
    for (const check of item.checks) {
      lines.push('- [' + check.status + '] ' + check.name + (check.reason ? ' — ' + check.reason : ''));
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

async function qualifySeasonalProduct({ preset, index, mode, seasonalRoot, seasonalStaticRoot, verify }) {
  const notes = [];
  const checks = [];
  const report = {
    product: preset,
    profile: 'seasonal',
    status: STATUS.PASS,
    destination: null,
    checks,
    notes,
    contentSha256: '',
    contentFiles: [],
  };

  try {
    const preflight = launchSeasonal({ preset, outputRoot: seasonalRoot, write: false, target: 'none' });
    report.destination = preflight.destination;
    checks.push({ name: 'seasonal-dry-run', status: STATUS.PASS, destination: preflight.destination });

    const staticPreview = generateDeployment({
      configText: seasonalConfig(preset),
      outputRoot: seasonalStaticRoot,
      profile: 'static-export',
      write: false,
    });
    checks.push({ name: 'static-export-compatibility', status: STATUS.PASS, destination: staticPreview.destination });

    if (mode === 'dry-run') {
      notes.push('Dry-run only: no writes, installs, builds, or runtime smoke.');
      const digest = sha256Text(preset + ':dry-run');
      report.contentSha256 = digest;
      report.status = statusFromChecks(checks);
      return report;
    }

    const generated = launchSeasonal({ preset, outputRoot: seasonalRoot, write: true, target: 'none' });
    const appDir = generated.destination;
    report.destination = appDir;
    checks.push({ name: 'seasonal-write', status: STATUS.PASS, destination: appDir });

    if (verify) {
      checks.push({ name: 'npm-install', status: STATUS.PASS, detail: runCheckedCommand({
        label: preset + ': npm install',
        command: 'npm',
        args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
        cwd: appDir,
        timeoutMs: 360_000,
      }) });

      const pkg = JSON.parse(safeReadText(path.join(appDir, 'package.json')));
      const testCommand = pkg?.scripts?.test
        ? { command: 'npm', args: ['test'] }
        : { command: 'node', args: ['--test'] };
      checks.push({ name: 'generated-tests', status: STATUS.PASS, detail: runCheckedCommand({
        label: preset + ': tests',
        command: testCommand.command,
        args: testCommand.args,
        cwd: appDir,
        timeoutMs: 360_000,
      }) });

      checks.push({ name: 'generated-typecheck', status: STATUS.PASS, detail: runCheckedCommand({
        label: preset + ': typecheck',
        command: 'npm',
        args: ['run', 'typecheck'],
        cwd: appDir,
        timeoutMs: 360_000,
      }) });

      checks.push({ name: 'generated-build', status: STATUS.PASS, detail: runCheckedCommand({
        label: preset + ': build',
        command: 'npm',
        args: ['run', 'build'],
        cwd: appDir,
        timeoutMs: 420_000,
      }) });

      const port = choosePort(index);
      const smoke = await runLocalHttpSmoke({ cwd: appDir, port, timeoutMs: 120_000 });
      checks.push({ name: 'http-runtime-smoke', status: STATUS.PASS, detail: smoke });

      const page = safeReadText(path.join(appDir, 'app/page.tsx'));
      for (const pattern of seasonalInteractionChecks(page, preset)) {
        if (!pattern.test(page)) {
          checks.push({
            name: 'interaction-check:' + pattern.source,
            status: STATUS.INCOMPLETE,
            reason: 'Could not prove interaction pattern in generated source: ' + pattern.source,
          });
        }
      }
      if (!checks.some((entry) => entry.name.startsWith('interaction-check:'))) {
        checks.push({ name: 'interaction-checks', status: STATUS.PASS });
      }

      const staticWrite = generateDeployment({
        configText: seasonalConfig(preset),
        outputRoot: seasonalStaticRoot,
        profile: 'static-export',
        write: true,
      });
      const staticDir = staticWrite.destination;
      checks.push({ name: 'static-export-write', status: STATUS.PASS, destination: staticDir });
      runCheckedCommand({
        label: preset + ': static npm install',
        command: 'npm',
        args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
        cwd: staticDir,
        timeoutMs: 360_000,
      });
      runCheckedCommand({
        label: preset + ': static build',
        command: 'npm',
        args: ['run', 'build'],
        cwd: staticDir,
        timeoutMs: 420_000,
      });
      notes.push('Static-export build validates the neutral Next.js baseline, NOT the seasonal interactive application.');
      if (!fs.existsSync(path.join(staticDir, 'out', 'index.html'))) {
        checks.push({ name: 'static-export-out', status: STATUS.FAIL, reason: 'Missing out/index.html after static-export build.' });
      } else {
        checks.push({ name: 'static-export-out', status: STATUS.PASS });
      }
    } else {
      notes.push('Write mode without --verify: dependency install/build/runtime checks intentionally skipped.');
      checks.push({ name: 'verification', status: STATUS.INCOMPLETE, reason: '--verify not enabled.' });
    }

    const evidence = hashExistingFiles([
      path.join(report.destination, 'app/page.tsx'),
      path.join(report.destination, 'tests/smoke.test.mjs'),
      path.join(report.destination, 'package.json'),
      path.join(report.destination, 'next.config.ts'),
    ], report.destination);
    report.contentSha256 = evidence.contentSha256;
    report.contentFiles = evidence.files;
  } catch (error) {
    const detail = error?.detail;
    checks.push({
      name: 'seasonal-qualification',
      status: STATUS.FAIL,
      reason: error instanceof Error ? error.message : String(error),
      detail: detail || null,
    });
  }

  report.status = statusFromChecks(checks);
  if (!report.contentSha256) {
    report.contentSha256 = sha256Text(preset + ':' + report.status);
  }
  return report;
}

async function qualifyDockerAndCompose({ mode, deploymentRoot, verify, sourceSha }) {
  const notes = [];
  const checks = [];
  const result = {
    product: 'minimal-saas',
    profile: 'docker+compose',
    status: STATUS.PASS,
    destination: null,
    checks,
    notes,
    contentSha256: '',
    contentFiles: [],
  };

  const dockerConfig = loadMinimalConfigWithSlug('minimal-docker-qualification');
  const composeConfig = loadMinimalConfigWithSlug('minimal-compose-qualification');
  const dockerRoot = path.join(deploymentRoot, 'docker');
  const composeRoot = path.join(deploymentRoot, 'compose');

  try {
    const dockerPreview = generateDeployment({ configText: dockerConfig, outputRoot: dockerRoot, profile: 'docker', write: false });
    const composePreview = generateDeployment({ configText: composeConfig, outputRoot: composeRoot, profile: 'docker-compose', write: false });
    checks.push({ name: 'docker-dry-run', status: STATUS.PASS, destination: dockerPreview.destination });
    checks.push({ name: 'compose-dry-run', status: STATUS.PASS, destination: composePreview.destination });

    if (mode === 'dry-run') {
      notes.push('Dry-run only: no file writes, lockfiles, Docker builds, or compose execution.');
      result.contentSha256 = sha256Text('minimal-saas:dry-run');
      result.status = statusFromChecks(checks);
      return result;
    }

    const dockerGenerated = generateDeployment({ configText: dockerConfig, outputRoot: dockerRoot, profile: 'docker', write: true });
    const dockerDir = dockerGenerated.destination;
    result.destination = dockerDir;
    checks.push({ name: 'docker-write', status: STATUS.PASS, destination: dockerDir });

    if (!verify) {
      checks.push({ name: 'verification', status: STATUS.INCOMPLETE, reason: '--verify not enabled.' });
      const evidence = hashExistingFiles([
        path.join(dockerDir, 'Dockerfile'),
        path.join(dockerDir, '.dockerignore'),
        path.join(dockerDir, 'DEPLOYMENT.md'),
      ], dockerDir);
      result.contentSha256 = evidence.contentSha256;
      result.contentFiles = evidence.files;
      result.status = statusFromChecks(checks);
      return result;
    }

    checks.push({ name: 'lockfile-generate', status: STATUS.PASS, detail: runCheckedCommand({
      label: 'docker: npm install --package-lock-only',
      command: 'npm',
      args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: dockerDir,
      timeoutMs: 360_000,
    }) });

    checks.push({ name: 'npm-install', status: STATUS.PASS, detail: runCheckedCommand({
      label: 'docker: npm install',
      command: 'npm',
      args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: dockerDir,
      timeoutMs: 360_000,
    }) });

    checks.push({ name: 'generated-tests', status: STATUS.PASS, detail: runCheckedCommand({
      label: 'docker: npm test',
      command: 'npm',
      args: ['test'],
      cwd: dockerDir,
      timeoutMs: 360_000,
    }) });

    checks.push({ name: 'generated-typecheck', status: STATUS.PASS, detail: runCheckedCommand({
      label: 'docker: npm run typecheck',
      command: 'npm',
      args: ['run', 'typecheck'],
      cwd: dockerDir,
      timeoutMs: 360_000,
    }) });

    checks.push({ name: 'generated-build', status: STATUS.PASS, detail: runCheckedCommand({
      label: 'docker: npm run build',
      command: 'npm',
      args: ['run', 'build'],
      cwd: dockerDir,
      timeoutMs: 420_000,
    }) });

    const dockerAvailable = dockerIsAvailable();
    if (!dockerAvailable) {
      checks.push({ name: 'docker-build-run', status: STATUS.INCOMPLETE, reason: 'Docker CLI is unavailable in this environment.' });
    } else {
      const imageTag = 'local/minimal-docker-qualification:' + sourceSha.slice(0, 12);
      checks.push({ name: 'docker-build', status: STATUS.PASS, detail: runCheckedCommand({
        label: 'docker build',
        command: 'docker',
        args: ['build', '-t', imageTag, '.'],
        cwd: dockerDir,
        timeoutMs: 600_000,
      }) });

      const containerName = 'golden-path-' + sourceSha.slice(0, 12);
      let running = false;
      try {
        const runDetail = runCheckedCommand({
          label: 'docker run',
          command: 'docker',
          args: ['run', '-d', '--rm', '--name', containerName, '-p', '127.0.0.1::3000', imageTag],
          cwd: dockerDir,
          timeoutMs: 60_000,
        });
        running = true;
        checks.push({ name: 'docker-run', status: STATUS.PASS, detail: runDetail });

        const portDetail = runCheckedCommand({
          label: 'docker port',
          command: 'docker',
          args: ['port', containerName, '3000/tcp'],
          cwd: dockerDir,
          timeoutMs: 30_000,
        });
        const portMatch = /:(\d+)\s*$/m.exec(portDetail.stdoutTail.trim());
        if (!portMatch) {
          checks.push({ name: 'docker-port', status: STATUS.FAIL, reason: 'Unable to resolve mapped localhost port from docker port output.' });
        } else {
          const hostPort = Number(portMatch[1]);
          const response = await (async () => {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
              try {
                const res = await fetch('http://127.0.0.1:' + String(hostPort) + '/', {
                  redirect: 'manual',
                  signal: AbortSignal.timeout(3_000),
                });
                const body = await res.text();
                if (res.ok && /<html/i.test(body)) {
                  return { statusCode: res.status, bodySha256: sha256Text(body) };
                }
              } catch {}
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
            throw new Error('Container HTTP endpoint did not become ready in time.');
          })();
          checks.push({ name: 'docker-http-smoke', status: STATUS.PASS, detail: response });

          const userDetail = runCheckedCommand({
            label: 'docker exec id -u',
            command: 'docker',
            args: ['exec', containerName, 'id', '-u'],
            cwd: dockerDir,
            timeoutMs: 30_000,
          });
          const uid = userDetail.stdoutTail.trim();
          if (uid === '0') {
            checks.push({ name: 'docker-non-root', status: STATUS.FAIL, reason: 'Container is running as root (uid 0).' });
          } else {
            checks.push({ name: 'docker-non-root', status: STATUS.PASS, detail: { uid } });
          }
        }
      } finally {
        if (running) {
          try {
            runCheckedCommand({
              label: 'docker stop',
              command: 'docker',
              args: ['stop', containerName],
              cwd: dockerDir,
              timeoutMs: 30_000,
            });
          } catch (error) {
            checks.push({
              name: 'docker-cleanup',
              status: STATUS.INCOMPLETE,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const composeGenerated = generateDeployment({ configText: composeConfig, outputRoot: composeRoot, profile: 'docker-compose', write: true });
      const composeDir = composeGenerated.destination;
      checks.push({ name: 'compose-write', status: STATUS.PASS, destination: composeDir });

      if (!dockerComposeIsAvailable()) {
        checks.push({ name: 'compose-config', status: STATUS.INCOMPLETE, reason: 'docker compose is unavailable in this environment.' });
      } else {
        // Never write test connection values to disk or print resolved Compose configuration.
        checks.push({ name: 'compose-config', status: STATUS.PASS, detail: runCheckedCommand({
          label: 'docker compose config --quiet',
          command: 'docker',
          args: ['compose', 'config', '--quiet'],
          cwd: composeDir,
          timeoutMs: 90_000,
          env: {
            APP_SLUG: 'minimal-compose-qualification',
            POSTGRES_PASSWORD: 'synthetic-local-only',
            DATABASE_URL: 'postgresql://saas:synthetic-local-only@postgres:5432/saas',
            APP_PORT: '3000',
            POSTGRES_DB: 'saas',
            POSTGRES_USER: 'saas',
            POSTGRES_PORT: '55432',
          },
        }) });
      }
    }

    const evidence = hashExistingFiles([
      path.join(dockerDir, 'Dockerfile'),
      path.join(dockerDir, '.dockerignore'),
      path.join(dockerDir, 'package-lock.json'),
      path.join(dockerDir, 'compose.yaml'),
      path.join(dockerDir, 'DEPLOYMENT.md'),
    ], dockerDir);
    result.contentSha256 = evidence.contentSha256;
    result.contentFiles = evidence.files;
  } catch (error) {
    checks.push({
      name: 'docker-compose-qualification',
      status: STATUS.FAIL,
      reason: error instanceof Error ? error.message : String(error),
      detail: error?.detail || null,
    });
  }

  result.status = statusFromChecks(checks);
  if (!result.contentSha256) result.contentSha256 = sha256Text('minimal-saas:' + result.status);
  return result;
}

export async function runGoldenPath(rawOptions = {}) {
  const options = {
    outputRoot: rawOptions.outputRoot,
    reportDir: rawOptions.reportDir,
    write: !!rawOptions.write,
    verify: !!rawOptions.verify,
  };

  if (options.verify && !options.write) {
    throw new Error('--verify requires --write.');
  }

  const mode = options.write ? (options.verify ? 'write-verify' : 'write') : 'dry-run';
  const sourceSha = trimOutput(spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    shell: false,
  }).stdout || '').trim();

  const outputRoot = options.write
    ? ensureSafeFreshRoot(options.outputRoot)
    : path.resolve(options.outputRoot || DEFAULT_DRY_ROOT);

  const reportDir = options.write
    ? ensureSafeDirectoryForReports(options.reportDir || path.join(outputRoot, 'report'))
    : null;

  if (options.write) {
    const seasonalRoot = path.join(outputRoot, 'seasonal');
    const staticRoot = path.join(outputRoot, 'seasonal-static-export');
    const deploymentRoot = path.join(outputRoot, 'deployment');
    for (const dir of [seasonalRoot, staticRoot, deploymentRoot]) {
      fs.mkdirSync(dir, { mode: 0o755 });
    }
  }

  const seasonalRoot = path.join(outputRoot, 'seasonal');
  const seasonalStaticRoot = path.join(outputRoot, 'seasonal-static-export');
  const deploymentRoot = path.join(outputRoot, 'deployment');

  const results = [];
  for (let index = 0; index < SEASONAL_PRESETS.length; index += 1) {
    results.push(await qualifySeasonalProduct({
      preset: SEASONAL_PRESETS[index],
      index,
      mode,
      seasonalRoot,
      seasonalStaticRoot,
      verify: options.verify,
    }));
  }

  results.push(await qualifyDockerAndCompose({
    mode,
    deploymentRoot,
    verify: options.verify,
    sourceSha,
  }));

  const report = {
    schemaVersion: 1,
    sourceSha,
    mode,
    outputRoot,
    generatedAt: new Date().toISOString(),
    tools: {
      node: process.version,
      npm: commandVersion('npm', ['--version']),
      docker: commandVersion('docker', ['--version']),
      dockerCompose: commandVersion('docker', ['compose', 'version']),
    },
    summary: summarizeCounts(results),
    results,
  };

  const reportJson = stableJson(report);
  const reportMd = markdownReport(report);

  if (reportDir) {
    const jsonPath = path.join(reportDir, 'golden-path-report.json');
    const mdPath = path.join(reportDir, 'golden-path-report.md');
    safeWriteNewFile(jsonPath, reportJson);
    safeWriteNewFile(mdPath, reportMd);
    report.reportFiles = { json: jsonPath, markdown: mdPath };
  }

  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  (async () => {
    try {
      const cli = parseCli(process.argv.slice(2));
      if (cli.help) {
        process.stdout.write(HELP);
        return;
      }
      const report = await runGoldenPath(cli);
      process.stdout.write(stableJson(report));
      if (report.summary.FAIL > 0 || (cli.verify && report.summary.INCOMPLETE > 0)) {
        // A required qualification not executed is not a green release gate.
        process.exitCode = 1;
      }
    } catch (error) {
      process.stderr.write('golden-path: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      process.exitCode = 1;
    }
  })();
}

export const _private = {
  parseCli,
  ensureSafeFreshRoot,
  seasonalInteractionChecks,
  markdownReport,
  runLocalHttpSmoke,
};
