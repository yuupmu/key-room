import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeMidi } from 'midi-file';
import { PDFDocument } from 'pdf-lib';
import { unfoldMeasures, renderUnfoldedScore, createUnfoldedPdf, transcribeUnfoldScore, UnfoldError } from './unfold-score.js';

function bar(number, markers = {}) {
  return { number, numerator: 4, denominator: 4, keyFifths: 1, keyMode: 'major', ending: [], repeatStart: false, repeatEnd: false, segno: false, coda: false, toCoda: false, fine: false, jump: 'none', jumpTarget: 'end', uncertain: false, issue: '', parts: [{ clef: 'G', clefLine: 2, voices: [[{ kind: 'note', pitches: [{ step: 'G', alter: 0, octave: 4, tieToNext: false }], type: 'whole', dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 }]] }], ...markers };
}
function score(measures) { return { title: 'Test', keyFifths: 1, keyMode: 'major', parts: [{ name: 'Piano', clef: 'G', clefLine: 2 }], measures }; }
function cropBar(number, markers = {}) {
  return { number, box: { left: (number - 1) * 400 + 30, top: 100, right: number * 400 + 30, bottom: 300 },
    ending: [], repeatStart: false, repeatEnd: false, segno: false, coda: false, toCoda: false, fine: false,
    jump: 'none', jumpTarget: 'end', ...markers };
}
async function blankPdf(pageCount = 1) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage().drawRectangle({ x: 20, y: 20, width: 10, height: 10 });
  return Buffer.from(await pdf.save());
}
function aiResponse(value) {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
}

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

test('handles the Merry-go-round D.S. al Coda route beyond 120 written measures', () => {
  const measures = Array.from({ length: 125 }, (_, index) => bar(index + 1));
  measures[33].segno = true;
  measures[48].toCoda = true;
  measures[110].jump = 'ds';
  measures[110].jumpTarget = 'coda';
  measures[111].coda = true;
  measures[124].fine = true;
  const order = unfoldMeasures(score(measures));
  assert.equal(order.length, 141);
  assert.deepEqual(order.slice(109, 115), [109, 110, 33, 34, 35, 36]);
  assert.deepEqual(order.slice(-14), Array.from({ length: 14 }, (_, index) => index + 111));
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
  assert.equal(request.model, 'gpt-5.6-sol');
  assert.equal(request.reasoning.effort, 'xhigh');
  assert.equal(result.keyFifths, 1);
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
});

test('reads PDF measure crops and navigation without transcribing notes', async () => {
  const input = { measures: [cropBar(1, { repeatStart: true }), cropBar(2, { repeatEnd: true })] };
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(input) }] }] }), { status: 200 });
  };
  const result = await createUnfoldedPdf(await blankPdf(), 'sheet.pdf', { key: 'test', fetchImpl });
  assert.equal(request.model, 'gpt-5.6-sol');
  assert.equal(request.reasoning.effort, 'xhigh');
  assert.equal(request.background, true);
  assert.equal(request.store, false);
  assert.equal(request.input[0].content[0].type, 'input_file');
  assert.match(request.instructions, /Do not transcribe pitches/);
  assert.equal(result.outputMeasures, 4);
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
});

test('polls a background PDF transcription instead of timing out on one connection', async () => {
  const calls = [];
  const input = { measures: [cropBar(1)] };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    const result = calls.length === 1
      ? { id: 'resp_test123', status: 'queued' }
      : calls.length === 2 ? { id: 'resp_test123', status: 'in_progress' }
        : { id: 'resp_test123', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(input) }] }] };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const result = await createUnfoldedPdf(await blankPdf(), 'Merry-go-round.pdf', { key: 'test', fetchImpl, sleepImpl: async () => {} });
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'GET']);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses/resp_test123');
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
});

test('locates PDF crops page by page and checks absolute measure continuity', async () => {
  const filenames = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const filename = body.input[0].content[0].filename;
    filenames.push(filename);
    const number = filename === 'score-page-1.pdf' ? 1 : 2;
    return aiResponse({ measures: [cropBar(number, { box: { left: 30, top: 100, right: 430, bottom: 300 } })] });
  };
  const result = await createUnfoldedPdf(await blankPdf(2), 'two-pages.pdf', { key: 'test', fetchImpl });
  assert.deepEqual(filenames.sort(), ['score-page-1.pdf', 'score-page-2.pdf']);
  assert.equal(result.sourceMeasures, 2);
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
});

test('rejects overlapping crop boxes instead of duplicating the same notation', async () => {
  let calls = 0;
  const box = { left: 30, top: 100, right: 430, bottom: 300 };
  const fetchImpl = async () => { calls++; return aiResponse({ measures: [cropBar(1, { box }), cropBar(2, { box })] }); };
  await assert.rejects(createUnfoldedPdf(await blankPdf(), 'overlap.pdf', { key: 'test', fetchImpl }), /자를 영역이 겹칩니다/);
  assert.equal(calls, 3);
});

test('keeps successful pages and retries only the page that failed', async () => {
  const calls = [0, 0];
  const fetchImpl = async (_url, init) => {
    const filename = JSON.parse(init.body).input[0].content[0].filename;
    const page = Number(filename.match(/score-page-(\d+)\.pdf/)[1]);
    calls[page - 1]++;
    if (page === 1 && calls[0] === 1) throw new TypeError('temporary disconnection');
    return aiResponse(score([bar(page)]));
  };
  const result = await transcribeUnfoldScore(await blankPdf(2), { key: 'test', fetchImpl });
  assert.deepEqual(calls, [2, 1]);
  assert.deepEqual(result.measures.map(item => item.number), [1, 2]);
});

test('reports an exhausted page retry without dropping the other page or engraving partial output', async () => {
  const calls = [0, 0];
  const fetchImpl = async (_url, init) => {
    const filename = JSON.parse(init.body).input[0].content[0].filename;
    const page = Number(filename.match(/score-page-(\d+)\.pdf/)[1]);
    calls[page - 1]++;
    if (page === 2) return new Response(JSON.stringify({ error: { code: 'temporary' } }), { status: 503 });
    return aiResponse(score([bar(1)]));
  };
  await assert.rejects(transcribeUnfoldScore(await blankPdf(2), { key: 'test', fetchImpl }), /2페이지.*HTTP 503/);
  assert.deepEqual(calls, [1, 3]);
});

test('rechecks only an uncertain measure, retaining the other measures', async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const text = JSON.parse(init.body).input[0].content[1].text;
    requests.push(text);
    return aiResponse(text.includes('Recheck only') ? score([bar(2)]) : score([bar(1), bar(2, { uncertain: true, issue: 'blurred notehead' }), bar(3)]));
  };
  const result = await transcribeUnfoldScore(await blankPdf(), { key: 'test', fetchImpl });
  assert.equal(requests.length, 2);
  assert.match(requests[1], /only written measure 2/);
  assert.deepEqual(result.measures.map(item => item.number), [1, 2, 3]);
  assert.equal(result.measures[1].uncertain, false);
});

test('retries rhythmically invalid measures twice and reports the precise unresolved location', async () => {
  const requests = [];
  const invalid = bar(2);
  invalid.parts[0].voices[0][0].type = 'quarter';
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body).input[0].content[1].text);
    return aiResponse(score([bar(1), invalid]));
  };
  await assert.rejects(transcribeUnfoldScore(await blankPdf(), { key: 'test', fetchImpl }), /1페이지 2마디.*음표 길이 합계/);
  assert.equal(requests.length, 3);
  assert.equal(requests.filter(text => text.includes('Recheck only')).length, 2);
});

test('retries discontinuous page numbers without discarding other pages', async () => {
  const calls = [0, 0, 0];
  const fetchImpl = async (_url, init) => {
    const filename = JSON.parse(init.body).input[0].content[0].filename;
    const page = Number(filename.match(/score-page-(\d+)\.pdf/)[1]);
    calls[page - 1]++;
    return aiResponse(score([bar(page === 2 && calls[1] === 1 ? 4 : page)]));
  };
  const result = await transcribeUnfoldScore(await blankPdf(3), { key: 'test', fetchImpl });
  assert.deepEqual(result.measures.map(item => item.number), [1, 2, 3]);
  assert.deepEqual(calls, [2, 2, 2]);
});

test('retries a transient background status connection without resubmitting the PDF', async () => {
  let posts = 0, polls = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'POST') { posts++; return new Response(JSON.stringify({ id: 'resp_retry', status: 'queued' })); }
    polls++;
    if (polls === 1) throw new TypeError('temporary connection loss');
    return new Response(JSON.stringify({ id: 'resp_retry', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ measures: [cropBar(1)] }) }] }] }));
  };
  const result = await createUnfoldedPdf(await blankPdf(), 'retry.pdf', { key: 'test', fetchImpl, sleepImpl: async () => {} });
  assert.equal(posts, 1);
  assert.equal(polls, 2);
  assert.equal(result.sourceMeasures, 1);
});

test('retries a temporary HTTP 503 while polling without resubmitting its page', async () => {
  let posts = 0, polls = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'POST') { posts++; return new Response(JSON.stringify({ id: 'resp_retry503', status: 'queued' })); }
    polls++;
    return polls === 1 ? new Response(JSON.stringify({ error: { code: 'unavailable' } }), { status: 503 }) : aiResponse(score([bar(1)]));
  };
  const result = await transcribeUnfoldScore(await blankPdf(), { key: 'test', fetchImpl, sleepImpl: async () => {} });
  assert.equal(posts, 1);
  assert.equal(polls, 2);
  assert.equal(result.measures.length, 1);
});

test('sends all five real Merry-go-round demo pages as separate PDF inputs', async () => {
  const source = await readFile(new URL('../src/client/assets/demo/Merry-go-round.pdf', import.meta.url));
  const pages = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = request.input[0].content[0];
    const number = Number(input.filename.match(/score-page-(\d+)\.pdf/)[1]);
    const pdf = await PDFDocument.load(Buffer.from(input.file_data.split(',')[1], 'base64'));
    assert.equal(pdf.getPageCount(), 1);
    pages.push(number);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(score([bar(number)])) }] }] }));
  };
  const result = await transcribeUnfoldScore(source, { key: 'test', fetchImpl });
  assert.deepEqual(pages.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(result.measures.length, 5);
});

test('unfolds the exact bundled demo without AI retranscription', async () => {
  const source = await readFile(new URL('../src/client/assets/demo/Merry-go-round.pdf', import.meta.url));
  const result = await createUnfoldedPdf(source, 'Merry-go-round.pdf', { key: '', fetchImpl: () => { throw new Error('AI should not be called'); } });
  const pdf = await PDFDocument.load(result.pdf);
  assert.equal(pdf.getPageCount(), 5);
  assert.equal(result.sourceMeasures, 125);
  assert.equal(result.outputMeasures, 141);
});
