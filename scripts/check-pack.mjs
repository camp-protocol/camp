// Install the packed tarball into an empty project and import every entry point, as a user would.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outDir = mkdtempSync(join(tmpdir(), 'camp-pack-'));
execFileSync('pnpm', ['pack', '--pack-destination', outDir], { stdio: 'inherit' });
const tarball = resolve(outDir, readdirSync(outDir).find((f) => f.endsWith('.tgz')));
const app = mkdtempSync(join(tmpdir(), 'camp-consumer-'));
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
execFileSync('npm', ['install', '--silent', tarball], { cwd: app, stdio: 'inherit' });
const code = `
  const core = await import('@camp-protocol/kit');
  const client = await import('@camp-protocol/kit/client');
  const server = await import('@camp-protocol/kit/server');
  if (core.CAMP_VERSION !== '1' || typeof client.CampClient !== 'function' || typeof server.createCampServer !== 'function') process.exit(1);
  console.log('packed entry points OK');
`;
execFileSync('node', ['--input-type=module', '-e', code], { cwd: app, stdio: 'inherit' });
