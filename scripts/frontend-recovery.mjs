// Freeze a complete compatible frontend. Never reads browser data or deploys anything.
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FRONTEND_FILES = Object.freeze([
  'index.html', 'notification.html', 'task.html', 'notification.js', 'task.js',
  'notification.css', 'task.css', 'css/home.css', 'css/navigation.css', 'js/data.js', 'js/home.js',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildRecovery(parent = join(root, '.release')) {
  await mkdir(parent, { recursive: true });
  const destination = await mkdtemp(join(parent, 'frontend-compatible-'));
  const files = {};
  for (const file of FRONTEND_FILES) {
    const bytes = await readFile(join(root, file));
    const output = join(destination, 'public', file);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes, { flag: 'wx' });
    files[file] = hash(bytes);
  }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({
    format: 1, createdAt: new Date().toISOString(), source: 'working-tree',
    compatibility: ['extraction.deadlineDate', 'extraction.dateWarning', 'extraction.referenceTime', 'task.sourceKind', 'task.deadlineDate'],
    files,
  }, null, 2), { flag: 'wx' });
  await verifyRecovery(destination);
  return destination;
}

export async function verifyRecovery(destination) {
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...FRONTEND_FILES].sort())) {
    throw Error('Recovery manifest does not match the frontend allowlist');
  }
  const publicDir = join(destination, 'public');
  async function walk(path, prefix = '') {
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) files.push(...await walk(join(path, entry.name), name + '/'));
      else if (entry.isFile()) files.push(name);
      else throw Error('Unexpected recovery entry');
    }
    return files;
  }
  if (JSON.stringify((await walk(publicDir)).sort()) !== JSON.stringify([...FRONTEND_FILES].sort())) {
    throw Error('Unexpected or missing files in recovery package');
  }
  for (const file of FRONTEND_FILES) {
    if (hash(await readFile(join(publicDir, file))) !== manifest.files[file]) throw Error(`Recovery checksum mismatch: ${file}`);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--verify' && process.argv[3]) {
    await verifyRecovery(resolve(process.argv[3]));
    console.log('PASS recovery file allowlist and SHA-256 checksums');
  } else if (process.argv.length === 2) {
    console.log(await buildRecovery());
  } else throw Error('Usage: node scripts/frontend-recovery.mjs [--verify <package-directory>]');
}
