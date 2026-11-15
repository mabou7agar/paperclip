import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const source = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(source, '../../..');
const destination = path.resolve(process.argv[2] ?? path.join(source, 'dist'));
await mkdir(path.join(destination, 'plugin'), { recursive: true });
await mkdir(path.join(destination, 'broker'), { recursive: true });
for (const name of ['worker', 'manifest']) await build({ entryPoints: [path.join(source, 'plugin', name + '.mjs')],
  outfile: path.join(destination, 'plugin', name + '.mjs'), bundle: true, platform: 'node', target: 'node24',
  format: 'esm', nodePaths: [path.join(repository, 'server/node_modules')], legalComments: 'eof' });
const pkg = JSON.parse(await readFile(path.join(source, 'plugin/package.json'), 'utf8'));
delete pkg.peerDependencies;
await writeFile(path.join(destination, 'plugin/package.json'), JSON.stringify(pkg, null, 2) + '\n');
const files = ['plugin/worker.mjs', 'plugin/manifest.mjs', 'plugin/package.json'];
for (const file of await readdir(path.join(source, 'broker'))) if (file.endsWith('.py')) {
  await copyFile(path.join(source, 'broker', file), path.join(destination, 'broker', file)); files.push('broker/' + file);
}
for (const file of ['install.py', 'paperclip-runner-results.service']) {
  await copyFile(path.join(source, file), path.join(destination, file)); files.push(file);
}
const manifest = {};
for (const file of files.sort()) manifest[file] = createHash('sha256').update(await readFile(path.join(destination, file))).digest('hex');
await writeFile(path.join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory: destination, files: files.length,
  manifestSha256: createHash('sha256').update(await readFile(path.join(destination, 'release-manifest.json'))).digest('hex') }));
