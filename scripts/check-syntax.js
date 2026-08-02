import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = [
  'server/config.js',
  'server/http-server.js',
  'server/main.js',
  'server/mixer-service.js',
  'server/bridges/bridge.js',
  'server/bridges/max-bridge.js',
  'server/bridges/mock-bridge.js',
  'public/app.js',
  'ableton/live-api-controller.js',
  'ableton/node-for-max-adapter.cjs',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const jsonFiles = [
  'config/band.json',
  'config/schema.json',
  'ableton/iem-remote-bridge.maxpat',
];

for (const file of jsonFiles) JSON.parse(readFileSync(file, 'utf8'));

console.log(`Checked ${files.length} JavaScript files and ${jsonFiles.length} JSON files.`);
