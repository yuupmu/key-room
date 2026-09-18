import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'src', 'client');
const outputDir = join(projectRoot, 'dist');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });
await cp(join(projectRoot, 'node_modules', 'signalsmith-stretch', 'SignalsmithStretch.mjs'), join(outputDir, 'signalsmith-stretch.mjs'));
await cp(join(projectRoot, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js'), join(outputDir, 'pdf-lib.min.js'));
console.log(`Built ${outputDir}`);
