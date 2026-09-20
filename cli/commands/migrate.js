import { join } from 'node:path';
import { getNodeMajor, getPackageRoot } from '../lib/platform.js';
import { checkWranglerAuth, runMigrations, wranglerLogin } from '../lib/wrangler.js';
import { banner, bold, fail, info, success, warn } from '../lib/ui.js';

export default async function migrateCommand() {
  banner();
  console.log(bold('  Apply database migrations\n'));

  if (getNodeMajor() < 22) {
    fail('Node.js 22 or newer is required.');
    process.exit(1);
  }

  const root = getPackageRoot();
  if (!(await checkWranglerAuth(root))) {
    warn('Not logged into Cloudflare. Opening browser...');
    if (!(await wranglerLogin(root))) {
      fail('Cloudflare login failed.');
      process.exit(1);
    }
  }

  info('Using the local fork source and its configured hearth-dash-db binding.');
  const result = await runMigrations('hearth-dash-db', join(root, 'migrations'), root);
  if (!result.ok) {
    fail(`Migration failed${result.version ? ` at ${result.version}` : ''}: ${result.error}`);
    process.exit(1);
  }
  if (result.applied.length) success(`Applied: ${result.applied.join(', ')}`);
  else success('Database is already up to date.');
}
