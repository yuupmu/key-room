import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const input = join(root, 'src/client/assets/demo/Merry-go-round.pdf');
const output = join(root, 'output/pdf/Merry-go-round-unfolded.pdf');
const demoOutput = join(root, 'src/client/assets/demo/Merry-go-round-unfolded.pdf');
export async function renderMerryDemo(sourceBytes) {
  const source = await PDFDocument.load(sourceBytes);
  if (source.getPageCount() !== 5) throw new Error('The demo source must have five pages.');
  const [, second, , fourth, fifth] = source.getPages();
  const white = rgb(1, 1, 1);
  function cover(page, x, y, width, height) { page.drawRectangle({ x, y, width, height, color: white }); }

// Erase only navigation labels; the notation itself stays as vector content.
  cover(second, 514, 344, 42, 15); // To Coda
  cover(fourth, 490, 242, 70, 20); // D.S. al Coda
  cover(fifth, 531, 767, 25, 15); // Fine
// The engraved segno and coda symbols are outside the staves.
  cover(second, 56, 670, 18, 35);
  cover(fourth, 56, 139, 18, 31);
  cover(fifth, 544, 786, 14, 15); // Original page number, repositioned below.

  const unfolded = await PDFDocument.create();
  unfolded.setTitle('Merry-go-round - unfolded performance order');
  unfolded.setAuthor('Keyroom');
  const pageSize = [595.28, 841.89];
  for (const page of await unfolded.copyPages(source, [0, 1, 2])) unfolded.addPage(page);

// Written measures 84-111 end at D.S.; the coda below them is moved after the return.
  const beforeJump = await unfolded.embedPage(fourth, { left: 0, bottom: 155, right: 595.28, top: 841.89 });
  unfolded.addPage(pageSize).drawPage(beforeJump, { x: 0, y: 155 });

// Played order after measure 111: repeat written 34-49, then jump to 112-125.
  const repeat = await unfolded.embedPage(second, { left: 0, bottom: 270, right: 595.28, top: 696 });
  const coda = await unfolded.embedPage(fourth, { left: 0, bottom: 20, right: 595.28, top: 155 });
  const ending = await unfolded.embedPage(fifth, { left: 0, bottom: 689, right: 595.28, top: 841.89 });
  const last = unfolded.addPage(pageSize);
  last.drawPage(repeat, { x: 0, y: 395 });
  last.drawPage(coda, { x: 0, y: 220 });
  last.drawPage(ending, { x: 0, y: 80 });
  const font = await unfolded.embedFont(StandardFonts.Helvetica);
  last.drawText('Second pass: written 34-49, then Coda 112-125', { x: 50, y: 821, size: 9, font });
  last.drawText('5', { x: 545, y: 821, size: 10, font });
  return Buffer.from(await unfolded.save());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pdf = await renderMerryDemo(await readFile(input));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(demoOutput), { recursive: true });
  await Promise.all([writeFile(output, pdf), writeFile(demoOutput, pdf)]);
  console.log(`${output}\n${demoOutput}`);
}
