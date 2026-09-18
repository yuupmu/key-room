import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
await cp(join(projectRoot, 'src', 'client', 'chord-offline.js'), join(outputDir, 'server', 'chord-offline.js'));
await cp(join(projectRoot, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.esm.js'), join(outputDir, 'server', 'pdf-lib.esm.js'));
const midiParserSource = await readFile(join(projectRoot, 'node_modules', 'midi-file', 'lib', 'midi-parser.js'), 'utf8');
await writeFile(join(outputDir, 'server', 'midi-parser.js'), midiParserSource.replace(/module\.exports = parseMidi\s*$/, 'export default parseMidi\n'));
await cp(join(projectRoot, 'node_modules', 'midi-file', 'LICENSE.md'), join(outputDir, 'server', 'midi-file-LICENSE.md'));
await cp(join(projectRoot, 'node_modules', 'signalsmith-stretch', 'SignalsmithStretch.mjs'), join(outputDir, 'client', 'signalsmith-stretch.mjs'));
await cp(join(projectRoot, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js'), join(outputDir, 'client', 'pdf-lib.min.js'));
console.log(`Built ${outputDir}`);
