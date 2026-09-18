import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMidi } from 'midi-file';
import { unfoldMeasures, renderUnfoldedScore, createUnfoldedPdf, UnfoldError } from './unfold-score.js';

function bar(number, markers = {}) {
  return { number, numerator: 4, denominator: 4, keyFifths: 1, keyMode: 'major', ending: [], repeatStart: false, repeatEnd: false, segno: false, coda: false, toCoda: false, fine: false, jump: 'none', jumpTarget: 'end', uncertain: false, issue: '', parts: [{ clef: 'G', clefLine: 2, voices: [[{ kind: 'note', pitches: [{ step: 'G', alter: 0, octave: 4, tieToNext: false }], type: 'whole', dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 }]] }], ...markers };
}
function score(measures) { return { title: 'Test', keyFifths: 1, keyMode: 'major', parts: [{ name: 'Piano', clef: 'G', clefLine: 2 }], measures }; }

test('unfolds first and second endings in played order', () => {
  const input = score([bar(1, { repeatStart: true }), bar(2, { repeatEnd: true, ending: [1] }), bar(3, { ending: [2] })]);
  assert.deepEqual(unfoldMeasures(input), [0, 1, 0, 2]);
});

test('unfolds D.S. al Coda and removes the unused route', () => {
  const input = score([bar(1), bar(2, { segno: true }), bar(3, { toCoda: true }), bar(4, { jump: 'ds', jumpTarget: 'coda' }), bar(5, { coda: true })]);
  assert.deepEqual(unfoldMeasures(input), [0, 1, 2, 3, 1, 2, 4]);
});

test('stops at Fine after D.C.', () => {
  const input = score([bar(1), bar(2, { fine: true }), bar(3, { jump: 'dc', jumpTarget: 'fine' })]);
  assert.deepEqual(unfoldMeasures(input), [0, 1, 2, 0, 1]);
});

test('rejects ambiguous rhythm and unresolved navigation', () => {
  const wrong = score([bar(1)]); wrong.measures[0].parts[0].voices[0][0].type = 'quarter';
  assert.throws(() => unfoldMeasures(wrong), UnfoldError);
  assert.throws(() => unfoldMeasures(score([bar(1, { jump: 'ds' })])), /세뇨/);
});

test('engraves a real staff PDF from MusicXML', async () => {
  const pdf = await renderUnfoldedScore(score([bar(1)]));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 2000, `PDF has ${pdf.length} bytes`);
});

test('accepts MIDI and uses AI key inference before engraving', async () => {
  const midi = Buffer.from(writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 480 }, tracks: [[
    { deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 66, velocity: 80 },
    { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 66, velocity: 0 },
    { deltaTime: 0, type: 'endOfTrack' }
  ]] }));
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ fifths: 1, mode: 'major', confidence: 'medium' }) }] }] }), { status: 200 });
  };
  const result = await createUnfoldedPdf(midi, 'melody.mid', { key: 'test', fetchImpl });
  assert.equal(request.model, 'gpt-5.6-luna');
  assert.equal(request.reasoning.effort, 'high');
  assert.equal(result.keyFifths, 1);
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
});

test('uses Luna high reasoning to read a PDF while keeping its written key', async () => {
  const input = score([bar(1, { repeatStart: true }), bar(2, { repeatEnd: true })]);
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(input) }] }] }), { status: 200 });
  };
  const result = await createUnfoldedPdf(Buffer.from('%PDF- fake input'), 'sheet.pdf', { key: 'test', fetchImpl });
  assert.equal(request.model, 'gpt-5.6-luna');
  assert.equal(request.reasoning.effort, 'high');
  assert.equal(request.input[0].content[0].type, 'input_file');
  assert.equal(result.keyFifths, 1);
  assert.equal(result.outputMeasures, 4);
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
});
