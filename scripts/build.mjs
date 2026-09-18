import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'src', 'client');
const outputDir = join(projectRoot, 'dist');

await rm(outputDir, { recursive: true, force: true });
await mkdir(join(outputDir, 'client'), { recursive: true });
await mkdir(join(outputDir, 'server'), { recursive: true });
await cp(sourceDir, join(outputDir, 'client'), { recursive: true });
await cp(join(projectRoot, 'src', 'worker'), join(outputDir, 'server'), { recursive: true });
await cp(join(projectRoot, 'server', 'song-search.js'), join(outputDir, 'server', 'song-search.js'));
await cp(join(projectRoot, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.esm.js'), join(outputDir, 'server', 'pdf-lib.esm.js'));
await cp(join(projectRoot, 'node_modules', 'signalsmith-stretch', 'SignalsmithStretch.mjs'), join(outputDir, 'client', 'signalsmith-stretch.mjs'));
await cp(join(projectRoot, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js'), join(outputDir, 'client', 'pdf-lib.min.js'));
console.log(`Built ${outputDir}`);
