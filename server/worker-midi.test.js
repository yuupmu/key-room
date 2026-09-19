import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMidi } from 'midi-file';
import * as pdfLib from 'pdf-lib';
import { arrangeChords } from '../src/client/chord-offline.js';
import { createChordScorePdf, createMidiScorePdf, guessMidiKey, MidiScoreError, readMidiScore } from '../src/worker/midi-score.js';

test('hosted MIDI converter produces a downloadable score PDF', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../src/client/assets/demo/Merry-go-round-right.mid', import.meta.url)));
  const midi = readMidiScore(bytes, parseMidi);
  const key = guessMidiKey(midi);
  const result = await createMidiScorePdf(midi, 'Merry-go-round-right.mid', key, pdfLib);
  assert.equal(midi.noteCount > 0, true);
  assert.equal(result.sourceMeasures, 28);
  assert.equal(result.keyFifths, 6);
  assert.deepEqual(Array.from(result.pdf.slice(0, 5)), [37, 80, 68, 70, 45]);
  assert.equal((await pdfLib.PDFDocument.load(result.pdf)).getPageCount() > 0, true);
});

test('hosted MIDI converter rejects non-MIDI files', () => {
  assert.throws(() => readMidiScore(new Uint8Array([1, 2, 3]), parseMidi), error => error instanceof MidiScoreError && error.status === 415);
});

test('hosted chord generator produces a vector score PDF', async () => {
  const bars = arrangeChords({ title: '연결 확인', progression: 'C | G | Am | F', pattern: 'hold', bpm: 120 });
  const pdf = await createChordScorePdf(bars, '연결 확인', 120, pdfLib);
  assert.deepEqual(Array.from(pdf.slice(0, 5)), [37, 80, 68, 70, 45]);
  assert.equal((await pdfLib.PDFDocument.load(pdf)).getPageCount(), 1);
});
