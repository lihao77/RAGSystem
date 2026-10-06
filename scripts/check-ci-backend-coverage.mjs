import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredTasks = {
  'typecheck:backend': ['typecheck'],
  'build:backend': ['build'],
  'check:backend': ['typecheck', 'build', 'test'],
};

// Audit the explicit npm chains against the actual backend workspace packages.
// A newly added plugin must join all backend gates before CI can pass.
export function findMissingBackendChecks(scripts, packages) {
  const missing = [];
  for (const [gate, tasks] of Object.entries(requiredTasks)) {
    const commands = (scripts[gate] ?? '').split('&&').map((command) => command.trim());
    for (const pkg of packages) {
      for (const task of tasks) {
        if (!pkg.scripts?.[task]) {
          missing.push(`${pkg.name} has no ${task} script`);
        } else if (!commands.includes(`npm -w ${pkg.name} run ${task}`)
          && !(task === 'test' && commands.includes(`npm -w ${pkg.name} test`))) {
          missing.push(`${gate} does not run ${pkg.name} ${task}`);
        }
      }
    }
  }
  return [...new Set(missing)];
}

export async function checkBackendCoverage() {
  const pluginDirectories = (await readdir(resolve(root, 'plugins'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `plugins/${entry.name}`);
  const directories = [
    'backend-core', 'backend-local', 'backend-saas',
    'packages/sandbox-runtime', 'sandbox-service', ...pluginDirectories,
  ];
  const packages = await Promise.all(directories.map(async (directory) => {
    try {
      return JSON.parse(await readFile(resolve(root, directory, 'package.json'), 'utf8'));
    } catch (error) {
      // Plugin folders without a package.json are not npm workspaces.
      if (directory.startsWith('plugins/') && error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  const { scripts } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const missing = findMissingBackendChecks(scripts, packages.filter(Boolean));
  if (missing.length) throw new Error(`Incomplete backend CI coverage:\n${missing.join('\n')}`);
  console.log(`Backend CI coverage verified for ${packages.filter(Boolean).length} workspaces.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkBackendCoverage();
}
