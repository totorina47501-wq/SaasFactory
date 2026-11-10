import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = process.env.FACTORY_APP_DIR;
if (typeof appDirectory !== 'string' || !appDirectory.trim()) {
  throw new Error('FACTORY_APP_DIR must point to a built generated app in a temporary directory.');
}

const resolvedAppDirectory = path.resolve(appDirectory);
if (lstatSync(resolvedAppDirectory).isSymbolicLink()) {
  throw new Error('FACTORY_APP_DIR must not be a symbolic link.');
}
const realAppDirectory = realpathSync(resolvedAppDirectory);
const allowedRoots = [process.env.RUNNER_TEMP, os.tmpdir()]
  .filter(Boolean)
  .map(root => realpathSync(root));
if (!allowedRoots.some(root => {
  const relative = path.relative(root, realAppDirectory);
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
})) {
  throw new Error('FACTORY_APP_DIR must be a child of RUNNER_TEMP or the system temporary directory.');
}

const packagePath = path.join(realAppDirectory, 'package.json');
if (!existsSync(packagePath) || !existsSync(path.join(realAppDirectory, '.next/BUILD_ID'))) {
  throw new Error('FACTORY_APP_DIR must be an installed, built generated app.');
}
if (!JSON.parse(readFileSync(packagePath, 'utf8')).scripts?.start) {
  throw new Error('FACTORY_APP_DIR must be a generated app with a start script.');
}

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default {
  testDir: path.join(repositoryRoot, 'tests/acceptance'),
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  retries: 0,
  reporter: 'list',
  outputDir: path.join(os.tmpdir(), `saas-factory-playwright-${process.pid}`),
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1 --port 4173',
    cwd: realAppDirectory,
    url: 'http://127.0.0.1:4173',
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
};
