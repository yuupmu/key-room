import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { scoreToMidi, ScoreError, transcribe, transcribeScore, segmentLayout, expandMultiMeasureRests, handleScoreToMidi, handleScoreStatus, handleScoreReview, prepareScoreReview, parseManualVoice, finalizeReviewedScore, DEFAULT_SCORE_MODEL } from './score-to-midi.js';

const pitch = (step, octave = 4, tieToNext = false) => ({ step, alter: 0, octave, tieToNext });
const note = (pitches, base, dots = 0, tupletPlayed = 1, tupletInTimeOf = 1) => ({ kind: 'note', pitches, base, dots, tupletPlayed, tupletInTimeOf });
const rest = base => ({ kind: 'rest', pitches: [], base, dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 });
const measure = (number, events) => ({ number, numerator: 4, denominator: 4, uncertain: false, issue: '', staves: [{ staff: 1, voices: [{ voice: 1, events }] }] });

function readVariable(buffer, position) {
  let value = 0;
  let byte;
  do { byte = buffer[position.i++]; value = value * 128 + (byte & 127); } while (byte & 128);
  return value;
}

function noteEvents(midi, includeEnd = false) {
  let position = 14;
  const events = [];
  for (let track = 0; track < midi.readUInt16BE(10); track++) {
    assert.equal(midi.toString('ascii', position, position + 4), 'MTrk');
    const end = position + 8 + midi.readUInt32BE(position + 4);
    position += 8;
    let tick = 0;
    while (position < end) {
      const cursor = { i: position };
      tick += readVariable(midi, cursor);
      position = cursor.i;
      const status = midi[position++];
      if (status === 0xff) {
        const type = midi[position++];
        const lengthCursor = { i: position }; const length = readVariable(midi, lengthCursor);
        position = lengthCursor.i + length;
        if (includeEnd && type === 0x2f) events.push({ tick, status: 'end', track });
      }
      else { const pitch = midi[position++]; position++; events.push({ tick, status, pitch }); }
    }
  }
  return events;
}

test('encodes dotted notes, rests and triplets at exact MIDI ticks', () => {
  const events = [
    note([pitch('C')], 'quarter', 1), rest('eighth'),
    note([pitch('E')], 'eighth', 0, 3, 2),
    note([pitch('F')], 'eighth', 0, 3, 2),
    note([pitch('G')], 'eighth', 0, 3, 2),
    note([pitch('A')], 'quarter')
  ];
  const { midi, noteCount } = scoreToMidi({ bpm: 120, measures: [measure(1, events)] });
  assert.equal(midi.toString('ascii', 0, 4), 'MThd');
  assert.equal(midi.readUInt16BE(12), 6720);
  assert.equal(noteCount, 5);
  assert.deepEqual(noteEvents(midi), [
    { tick: 0, status: 0x90, pitch: 60 },
    { tick: 10080, status: 0x80, pitch: 60 },
    { tick: 13440, status: 0x90, pitch: 64 },
    { tick: 15680, status: 0x80, pitch: 64 },
    { tick: 15680, status: 0x90, pitch: 65 },
    { tick: 17920, status: 0x80, pitch: 65 },
    { tick: 17920, status: 0x90, pitch: 67 },
    { tick: 20160, status: 0x80, pitch: 67 },
    { tick: 20160, status: 0x90, pitch: 69 },
    { tick: 26880, status: 0x80, pitch: 69 }
  ]);
});

test('joins a tie over the barline into one sustained note', () => {
  const score = { bpm: 90, measures: [
    measure(1, [note([pitch('C', 4, true)], 'whole')]),
    measure(2, [note([pitch('C')], 'half'), note([pitch('D')], 'half')])
  ] };
  const { midi, noteCount } = scoreToMidi(score);
  assert.equal(noteCount, 2);
  assert.deepEqual(noteEvents(midi), [
    { tick: 0, status: 0x90, pitch: 60 },
    { tick: 40320, status: 0x80, pitch: 60 },
    { tick: 40320, status: 0x90, pitch: 62 },
    { tick: 53760, status: 0x80, pitch: 62 }
  ]);
});

test('154 measures share one timeline even when a tie crosses a four-bar segment', () => {
  const bars = Array.from({ length: 154 }, (_, index) => measure(index + 1,
    [note([pitch('C', 4, index === 3)], 'whole')]));
  const result = scoreToMidi({ bpm: 190, measures: bars });
  assert.equal(result.measureCount, 154);
  assert.equal(result.midi.readUInt16BE(12), 6720);
  const events = noteEvents(result.midiByStaff[1]);
  assert.ok(events.some(event => event.tick === 5 * 26880 && event.status === 0x80 && event.pitch === 60));
  assert.ok(events.some(event => event.tick === 153 * 26880 && event.status === 0x90));
  assert.equal(result.noteCount, 153);
});

test('layout chunks at system boundaries and semantic comparison ignores chord order', () => {
  const layout = { measures: Array.from({ length: 154 }, (_, index) => ({ system: Math.floor(index / 4) + 1,
    box: { left: index % 4 * 240, right: index % 4 * 240 + 230, top: 50, bottom: 900 } })) };
  const segments = segmentLayout(layout);
  assert.equal(segments.length, 39);
  assert.deepEqual(segments.slice(0, 2).map(item => [item.start, item.end]), [[1, 4], [5, 8]]);
  assert.deepEqual([segments.at(-1).start, segments.at(-1).end], [153, 154]);
  const varying = { measures: layout.measures.slice(0, 4).map((bar, index) => ({ ...bar, density: index === 0 ? 'dense' : 'normal' })) };
  assert.deepEqual(segmentLayout(varying).map(item => [item.start, item.end]), [[1, 1], [2, 3], [4, 4]]);
  const chord = measure(1, [note([pitch('C'), pitch('E'), pitch('G')], 'whole')]);
  const reordered = structuredClone(chord);
  reordered.staves[0].voices[0].events[0].pitches.reverse();
  assert.equal(prepareScoreReview({ bpm: 120, measures: [chord] }, { bpm: 120, measures: [reordered] }).review.length, 0);
});

test('expands a four-measure rest before numbering and keeps the following double stop on the shared timeline', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'score-multirest-test-'));
  const image = await sharp({ create: { width: 1000, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
  const unknown = { kind: 'unknown', pitches: [], base: 'unknown', dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 };
  const multiRest = { number: 1, numerator: 4, denominator: 4, uncertain: true,
    issue: '두 오선 모두 숫자 4가 붙은 4마디 다중쉼표이다. 단일 마디 구조로 펼칠 수 없다.',
    staves: [1, 2].map(staff => ({ staff, voices: [{ voice: 1, events: [unknown] }] })) };
  const played = { number: 1, numerator: 4, denominator: 4, uncertain: false, issue: '', staves: [
    { staff: 1, voices: [{ voice: 1, events: [note([pitch('C'), pitch('E')], 'whole')] }] },
    { staff: 2, voices: [{ voice: 1, events: [note([pitch('G', 2)], 'whole')] }] }
  ] };
  const api = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200 });
  let calls = 0;
  try {
    const { score } = await transcribeScore(image, 'image/png', { key: 'test-key', transcriptionDir: scratch,
      fetchImpl: async () => {
        calls++;
        return api(calls === 1 ? { measures: [
          { system: 1, density: 'dense', box: { left: 10, top: 50, right: 400, bottom: 450 } },
          { system: 2, density: 'normal', box: { left: 10, top: 500, right: 400, bottom: 900 } }
        ] } : { bpm: 142, measures: [calls === 2 ? multiRest : played] });
      } });
    assert.equal(calls, 3, 'the recognized multi-rest must not trigger another AI recheck');
    assert.equal(score.measures.length, 5);
    assert.deepEqual(score.measures.map(bar => bar.number), [1, 2, 3, 4, 5]);
    assert.ok(score.measures.slice(0, 4).every(bar => !bar.uncertain && bar.staves.every(staff => staff.voices[0].events[0].kind === 'rest')));
    const result = scoreToMidi(score);
    assert.equal(result.measureCount, 5);
    assert.equal(result.noteCount, 3);
    assert.ok(noteEvents(result.midiByStaff[1]).some(event => event.tick === 4 * 26880 && event.status === 0x90 && event.pitch === 60));
  } finally { await rm(scratch, { recursive: true }); }

  const ambiguous = structuredClone(multiRest);
  ambiguous.issue += ' 박자표 확인 필요.';
  assert.equal(expandMultiMeasureRests([ambiguous]).measures[0].uncertain, true);
});

test('keeps trailing rests in the MIDI track duration', () => {
  const { midi } = scoreToMidi({ bpm: 120, measures: [measure(1, [note([pitch('C')], 'quarter'), rest('half'), rest('quarter')])] });
  assert.deepEqual(noteEvents(midi, true).filter(event => event.status === 'end'), [
    { tick: 26880, status: 'end', track: 0 },
    { tick: 26880, status: 'end', track: 1 }
  ]);
});

test('exports each piano staff as a separate MIDI with the same tempo and full duration', () => {
  const score = { bpm: 96, measures: [
    { number: 1, numerator: 4, denominator: 4, uncertain: false, issue: '', staves: [
      { staff: 1, voices: [{ voice: 1, events: [note([pitch('C', 4)], 'quarter'), rest('half'), rest('quarter')] }] },
      { staff: 2, voices: [{ voice: 1, events: [rest('half'), note([pitch('G', 2)], 'half')] }] }
    ] }
  ] };
  const { midi, midiByStaff } = scoreToMidi(score);
  assert.equal(midi.readUInt16BE(10), 3);
  assert.equal(midiByStaff[1].readUInt16BE(10), 2);
  assert.equal(midiByStaff[2].readUInt16BE(10), 2);
  assert.deepEqual(noteEvents(midiByStaff[1]).map(({ tick, status, pitch }) => ({ tick, status, pitch })), [
    { tick: 0, status: 0x90, pitch: 60 }, { tick: 6720, status: 0x80, pitch: 60 }
  ]);
  assert.deepEqual(noteEvents(midiByStaff[2]).map(({ tick, status, pitch }) => ({ tick, status, pitch })), [
    { tick: 13440, status: 0x91, pitch: 43 }, { tick: 26880, status: 0x81, pitch: 43 }
  ]);
  for (const hand of [1, 2]) {
    assert.deepEqual(noteEvents(midiByStaff[hand], true).filter(event => event.status === 'end').map(event => event.tick), [26880, 26880]);
    assert.ok(midiByStaff[hand].includes(Buffer.from([0xff, 0x51, 3, 9, 0x89, 0x68]))); // 96 BPM
  }
});

test('encodes accidentals as exact MIDI pitches', () => {
  const chord = [
    { step: 'C', alter: 1, octave: 4, tieToNext: false },
    { step: 'B', alter: -1, octave: 3, tieToNext: false }
  ];
  const { midi } = scoreToMidi({ bpm: 120, measures: [measure(1, [note(chord, 'whole')])] });
  assert.deepEqual(noteEvents(midi), [
    { tick: 0, status: 0x90, pitch: 58 },
    { tick: 0, status: 0x90, pitch: 61 },
    { tick: 26880, status: 0x80, pitch: 58 },
    { tick: 26880, status: 0x80, pitch: 61 }
  ]);
});

test('rejects incomplete measures and uncertain transcription', () => {
  assert.throws(() => scoreToMidi({ bpm: 120, measures: [measure(1, [note([pitch('C')], 'quarter')])] }), ScoreError);
  const uncertain = measure(1, [note([pitch('C')], 'whole')]);
  uncertain.uncertain = true;
  uncertain.issue = '음표 머리가 흐림';
  assert.throws(() => scoreToMidi({ bpm: 120, measures: [uncertain] }), /판독이 불확실/);
});

test('sends an image with a strict score schema to the Responses API', async () => {
  assert.equal(DEFAULT_SCORE_MODEL, 'gpt-6-astra');
  const originalModel = process.env.OPENAI_SCORE_TO_MIDI_MODEL;
  const originalSharedModel = process.env.OPENAI_SCORE_MODEL;
  delete process.env.OPENAI_SCORE_TO_MIDI_MODEL;
  process.env.OPENAI_SCORE_MODEL = 'gpt-5.6-luna';
  const expected = { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
  let calls = 0;
  try {
    const result = await transcribe(Buffer.from([137, 80, 78, 71]), 'image/png', {
      key: 'test-key', secondPass: true,
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(options.headers.Authorization, 'Bearer test-key');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-6-astra');
        assert.equal(body.store, false);
        assert.equal(body.background, true);
        assert.equal(options.signal, undefined);
        assert.equal(body.reasoning.effort, 'high');
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        const eventFormat = body.text.format.schema.properties.measures.items.properties.staves.items.properties.voices.items.properties.events.items.properties;
        assert.deepEqual(eventFormat.tupletPlayed.enum, [1, 3, 5, 6, 7]);
        assert.deepEqual(eventFormat.tupletInTimeOf.enum, [1, 2, 4]);
        assert.match(body.instructions, /tupletPlayed=1, tupletInTimeOf=1/);
        assert.equal(body.input[0].content[0].detail, 'original');
        assert.match(body.instructions, /후보 JSON|원본 대상 이미지/);
        assert.equal(body.max_output_tokens, 28000);
        return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] }), { status: 200 });
      }
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, expected);
  } finally {
    if (originalModel === undefined) delete process.env.OPENAI_SCORE_TO_MIDI_MODEL;
    else process.env.OPENAI_SCORE_TO_MIDI_MODEL = originalModel;
    if (originalSharedModel === undefined) delete process.env.OPENAI_SCORE_MODEL;
    else process.env.OPENAI_SCORE_MODEL = originalSharedModel;
  }
});

test('background Responses are polled without an application timeout', async () => {
  const expected = { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
  const urls = []; const waits = [];
  const result = await transcribe(Buffer.from('image'), 'image/png', { key: 'test-key', sleepImpl: async ms => { waits.push(ms); },
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.equal(options.signal, undefined);
      if (urls.length === 1) {
        const body = JSON.parse(options.body);
        assert.equal(body.background, true);
        assert.equal(body.store, false);
        return new Response(JSON.stringify({ id: 'resp_example123', status: 'queued' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'resp_example123', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] }), { status: 200 });
    } });
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(urls, ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses/resp_example123']);
  assert.deepEqual(result, expected);
});

test('incomplete responses expose token exhaustion and record usage without score data', async () => {
  const logs = []; const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await assert.rejects(transcribe(Buffer.from('image'), 'image/png', { key: 'test-key',
      fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        usage: { output_tokens: 28000, output_tokens_details: { reasoning_tokens: 27900 } } }), { status: 200 }) }), /토큰 한도/);
    assert.match(logs.join('\n'), /max_output_tokens/);
    assert.match(logs.join('\n'), /27900/);
    assert.doesNotMatch(logs.join('\n'), /aW1hZ2U=/);
  } finally { console.error = original; }
});

test('token exhaustion splits four bars into smaller persisted segments', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'score-split-test-'));
  const image = await sharp({ create: { width: 1000, height: 300, channels: 3, background: '#fff' } }).png().toBuffer();
  const layout = { measures: Array.from({ length: 4 }, (_, index) => ({ system: 1,
    box: { left: index * 240 + 10, right: index * 240 + 235, top: 100, bottom: 900 } })) };
  const calls = [];
  const api = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200 });
  try {
    const { score, jobId } = await transcribeScore(image, 'image/png', { key: 'test-key',
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (body.text.format.name === 'score_page_layout') return api(layout);
        const message = body.input[0].content.at(-1).text;
        calls.push(message);
        if (calls.length === 1) return new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 28000 } }), { status: 200 });
        const count = Number(/이번 응답 1~(\d+)마디/.exec(message)[1]);
        return api({ bpm: 120, measures: Array.from({ length: count }, (_, index) => measure(index + 1, [note([pitch('C')], 'whole')])) });
      }, transcriptionDir: scratch });
    assert.equal(calls.length, 3);
    assert.equal(score.measures.length, 4);
    assert.deepEqual(score.measures.map(item => item.number), [1, 2, 3, 4]);
    assert.deepEqual(JSON.parse(await readFile(join(scratch, jobId, 'merged.json'))).measures.map(item => item.number), [1, 2, 3, 4]);
  } finally { await rm(scratch, { recursive: true }); }
});

test('PDF pages are rendered as images before layout and cropped transcription', async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 200]);
  const pdf = Buffer.from(await document.save());
  const scratch = await mkdtemp(join(tmpdir(), 'score-pdf-test-'));
  const calls = [];
  try {
    const result = await transcribeScore(pdf, 'application/pdf', { key: 'test-key', transcriptionDir: scratch,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        assert.equal(body.model, 'gpt-6-astra');
        assert.equal(body.reasoning.effort, 'high');
        assert.match(body.input[0].content[0].image_url, /^data:image\/png;base64,/);
        const value = body.text.format.name === 'score_page_layout'
          ? { measures: [{ system: 1, box: { left: 100, top: 100, right: 900, bottom: 900 } }] }
          : { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
        return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200 });
      } });
    assert.equal(calls.length, 2);
    assert.equal(result.score.measures.length, 1);
  } finally { await rm(scratch, { recursive: true }); }
});

test('segment-edge ties are checked after the five bars are joined', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'score-tie-test-'));
  const image = await sharp({ create: { width: 1000, height: 300, channels: 3, background: '#fff' } }).png().toBuffer();
  const layout = { measures: Array.from({ length: 5 }, (_, index) => ({ system: 1,
    box: { left: index * 190 + 10, right: index * 190 + 190, top: 100, bottom: 900 } })) };
  let calls = 0;
  try {
    const { score } = await transcribeScore(image, 'image/png', { key: 'test-key', transcriptionDir: scratch,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const value = calls++ === 0 ? layout : calls === 2
          ? { bpm: 120, measures: Array.from({ length: 4 }, (_, index) => measure(index + 1, [note([pitch('C', 4, index === 3)], 'whole')])) }
          : { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
        return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200 });
      } });
    assert.equal(calls, 3);
    assert.equal(score.measures.length, 5);
    assert.equal(scoreToMidi(score).noteCount, 4);
  } finally { await rm(scratch, { recursive: true }); }
});

test('API handler reports a missing server key without accepting a conversion', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const request = Readable.from([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
    const response = {
      writeHead(status) { this.status = status; },
      end(body) { this.body = JSON.parse(body); }
    };
    await handleScoreToMidi(request, response);
    assert.equal(response.status, 503);
    assert.match(response.body.error, /OPENAI_API_KEY/);
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('API handler crops a target, saves its JSON, and rechecks only a faulty segment', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalDir = process.env.SCORE_TRANSCRIPTION_DIR;
  const scratch = await mkdtemp(join(tmpdir(), 'score-test-'));
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.SCORE_TRANSCRIPTION_DIR = scratch;
  const file = await sharp({ create: { width: 800, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const layout = { measures: [{ system: 1, box: { left: 100, top: 100, right: 900, bottom: 900 } }] };
  const good = { bpm: 120, measures: [{ ...measure(1, [note([pitch('C')], 'whole')]), staves: [
    { staff: 1, voices: [{ voice: 1, events: [note([pitch('C')], 'whole')] }] },
    { staff: 2, voices: [{ voice: 1, events: [note([pitch('G', 2)], 'whole')] }] }
  ] }] };
  const faulty = structuredClone(good);
  faulty.measures[0].staves[0].voices[0].events[0].base = 'quarter';
  const requestOnce = async () => {
    const request = Readable.from([file]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handleScoreToMidi(request, response);
    assert.equal(response.status, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      const check = { method: 'GET', url: `/api/score-to-midi/status?id=${response.body.jobId}`, headers: request.headers };
      const result = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      handleScoreStatus(check, result);
      if (result.status !== 202) return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('test job did not finish');
  };
  const api = value => new Response(JSON.stringify({ status: 'completed', usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200 });
  try {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      if (calls === 1) return api(layout);
      assert.match(body.input[0].content[0].image_url, /^data:image\/png;base64,/);
      if (calls === 2) return api(faulty);
      assert.match(body.input[0].content.at(-1).text, /후보 JSON/);
      return api(good);
    };
    const accepted = await requestOnce();
    assert.equal(calls, 3);
    assert.equal(accepted.status, 200);
    assert.match(accepted.body.transcriptionId, /^[0-9a-f-]{36}$/);
    assert.equal(Buffer.from(accepted.body.midiBase64, 'base64').toString('ascii', 0, 4), 'MThd');
    assert.deepEqual(Buffer.from(accepted.body.rightMidiBase64, 'base64'), scoreToMidi(good).midiByStaff[1]);
    assert.deepEqual(Buffer.from(accepted.body.leftMidiBase64, 'base64'), scoreToMidi(good).midiByStaff[2]);
    const saved = JSON.parse(await readFile(join(scratch, accepted.body.transcriptionId, '1-1-recheck.json')));
    assert.equal(saved.problems.length, 0);

    const singleStaff = { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
    calls = 0;
    globalThis.fetch = async () => api(++calls === 1 ? layout : singleStaff);
    const single = await requestOnce();
    assert.equal(single.status, 200);
    assert.equal(single.body.leftMidiBase64, null);
    assert.deepEqual(Buffer.from(single.body.rightMidiBase64, 'base64'), scoreToMidi(singleStaff).midiByStaff[1]);

    calls = 0;
    globalThis.fetch = async () => api(++calls === 1 ? layout : faulty);
    const rejected = await requestOnce();
    assert.equal(calls, 3);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.reviewRequired, true);
    assert.equal(rejected.body.review[0].number, 1);
    assert.match(rejected.body.review[0].issue, /박자 합/);
    assert.equal(rejected.body.midiBase64, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalDir === undefined) delete process.env.SCORE_TRANSCRIPTION_DIR;
    else process.env.SCORE_TRANSCRIPTION_DIR = originalDir;
    await rm(scratch, { recursive: true });
  }
});

test('an uncertain PDF transcription becomes an editable review instead of a rejected MIDI', () => {
  const uncertain = measure(1, [{ kind: 'unknown', pitches: [], base: 'unknown', dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 }]);
  uncertain.uncertain = true;
  uncertain.issue = 'The notehead could not be read';
  const { score, review } = prepareScoreReview({ bpm: 120, measures: [uncertain] }, { bpm: 120, measures: [uncertain] });
  assert.equal(review.length, 1);
  assert.equal(review[0].voices[0].text, '?');
  assert.throws(() => scoreToMidi(score), /판독이 불확실/);
  assert.throws(() => finalizeReviewedScore(score, [], 120), /빈칸/);
  assert.throws(() => finalizeReviewedScore(score, [{ number: 1, numerator: 4, denominator: 4, voices: [{ staff: 1, voice: 1, text: '?' }] }], 120), /표기를 읽을 수 없습니다/);
  const result = finalizeReviewedScore(score, [{ number: 1, numerator: 4, denominator: 4, voices: [{ staff: 1, voice: 1, text: 'C4/4 D4/4 E4/4 F4/4' }] }], 120);
  assert.equal(result.noteCount, 4);
  assert.equal(result.midi.toString('ascii', 0, 4), 'MThd');
});

test('manual notes support rests, accidentals, chords, ties and tuplets without inventing missing duration', () => {
  assert.deepEqual(parseManualVoice('[C#4,Eb4]/2 R/8 C4~/8 D4/8@3:2 E4/8@3:2 F4/8@3:2').map(event => event.kind), ['note', 'rest', 'note', 'note', 'note', 'note']);
  assert.throws(() => parseManualVoice('C4/4 ?'), /표기를 읽을 수 없습니다/);
  const base = { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
  assert.throws(() => finalizeReviewedScore(base, [{ number: 1, numerator: 4, denominator: 4, voices: [{ staff: 1, voice: 1, text: 'C4/4' }] }], 120), /길이가 4\/4 박자와 다릅니다/);
});

test('review endpoint validates correction and emits MIDI only after the measure is complete', async () => {
  const uncertain = measure(1, []);
  uncertain.uncertain = true;
  uncertain.issue = 'Unreadable';
  const draft = { bpm: 120, measures: [uncertain] };
  const requestOnce = async text => {
    const request = Readable.from([Buffer.from(JSON.stringify({ draft, bpm: 120, corrections: [{ number: 1, numerator: 4, denominator: 4, voices: [{ staff: 1, voice: 1, text }] }] }))]);
    request.method = 'POST'; request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handleScoreReview(request, response);
    return response;
  };
  const invalid = await requestOnce('C4/4');
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.midiBase64, undefined);
  const corrected = await requestOnce('C4/1');
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.noteCount, 1);
  assert.equal(Buffer.from(corrected.body.rightMidiBase64, 'base64').toString('ascii', 0, 4), 'MThd');
});
