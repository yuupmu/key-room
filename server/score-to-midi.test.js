import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { scoreToMidi, ScoreError, transcribe, handleScoreToMidi, DEFAULT_SCORE_MODEL } from './score-to-midi.js';

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

test('keeps trailing rests in the MIDI track duration', () => {
  const { midi } = scoreToMidi({ bpm: 120, measures: [measure(1, [note([pitch('C')], 'quarter'), rest('half'), rest('quarter')])] });
  assert.deepEqual(noteEvents(midi, true).filter(event => event.status === 'end'), [
    { tick: 26880, status: 'end', track: 0 },
    { tick: 26880, status: 'end', track: 1 }
  ]);
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
  assert.equal(DEFAULT_SCORE_MODEL, 'gpt-5.6-luna');
  const originalModel = process.env.OPENAI_SCORE_MODEL;
  delete process.env.OPENAI_SCORE_MODEL;
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
        assert.equal(body.model, 'gpt-5.6-luna');
        assert.equal(body.store, false);
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        assert.equal(body.input[0].content[0].detail, 'original');
        assert.match(body.instructions, /Independently audit/);
        return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] }), { status: 200 });
      }
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, expected);
  } finally {
    if (originalModel === undefined) delete process.env.OPENAI_SCORE_MODEL;
    else process.env.OPENAI_SCORE_MODEL = originalModel;
  }
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

test('API handler returns MIDI only when two independent readings agree', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  const file = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const good = { bpm: 120, measures: [measure(1, [note([pitch('C')], 'whole')])] };
  const different = { bpm: 120, measures: [measure(1, [note([pitch('D')], 'whole')])] };
  const requestOnce = async () => {
    const request = Readable.from([file]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handleScoreToMidi(request, response);
    return response;
  };
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(good) }] }] }), { status: 200 });
    };
    const accepted = await requestOnce();
    assert.equal(calls, 2);
    assert.equal(accepted.status, 200);
    assert.equal(Buffer.from(accepted.body.midiBase64, 'base64').toString('ascii', 0, 4), 'MThd');

    calls = 0;
    globalThis.fetch = async () => {
      const score = ++calls === 1 ? good : different;
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(score) }] }] }), { status: 200 });
    };
    const rejected = await requestOnce();
    assert.equal(calls, 2);
    assert.equal(rejected.status, 422);
    assert.match(rejected.body.error, /일치하지 않습니다/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
