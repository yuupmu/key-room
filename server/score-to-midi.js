const TICKS_PER_QUARTER = 6720;
export const DEFAULT_SCORE_MODEL = 'gpt-5.6-luna';
const MAX_SCORE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 12000;
const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const BASE_TICKS = { whole: 26880, half: 13440, quarter: 6720, eighth: 3360, sixteenth: 1680, thirty_second: 840, sixty_fourth: 420 };
const TUPLETS = new Set(['1:1', '3:2', '5:4', '6:4', '7:4']);

const pitchSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    step: { type: 'string', enum: Object.keys(STEP_SEMITONES) },
    alter: { type: 'integer' }, octave: { type: 'integer' },
    tieToNext: { type: 'boolean' }
  },
  required: ['step', 'alter', 'octave', 'tieToNext']
};
const eventSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['note', 'rest'] },
    pitches: { type: 'array', items: pitchSchema },
    base: { type: 'string', enum: Object.keys(BASE_TICKS) },
    dots: { type: 'integer' },
    tupletPlayed: { type: 'integer' },
    tupletInTimeOf: { type: 'integer' }
  },
  required: ['kind', 'pitches', 'base', 'dots', 'tupletPlayed', 'tupletInTimeOf']
};
const scoreSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    bpm: { type: 'integer' },
    measures: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        number: { type: 'integer' }, numerator: { type: 'integer' }, denominator: { type: 'integer' },
        uncertain: { type: 'boolean' }, issue: { type: 'string' },
        staves: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            staff: { type: 'integer' },
            voices: { type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: { voice: { type: 'integer' }, events: { type: 'array', items: eventSchema } },
              required: ['voice', 'events']
            } }
          }, required: ['staff', 'voices']
        } }
      },
      required: ['number', 'numerator', 'denominator', 'uncertain', 'issue', 'staves']
    } }
  },
  required: ['bpm', 'measures']
};

export class ScoreError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

function assert(condition, message) {
  if (!condition) throw new ScoreError(message);
}

function eventTicks(event) {
  const base = BASE_TICKS[event.base];
  assert(base && Number.isInteger(event.dots) && event.dots >= 0 && event.dots <= 2, '음표 길이를 해석할 수 없습니다.');
  assert(Number.isInteger(event.tupletPlayed) && Number.isInteger(event.tupletInTimeOf), '잇단음표 길이를 해석할 수 없습니다.');
  const ratio = `${event.tupletPlayed}:${event.tupletInTimeOf}`;
  assert(TUPLETS.has(ratio), '지원하지 않는 잇단음표 비율입니다.');
  const dotted = base * (event.dots === 0 ? 1 : event.dots === 1 ? 3 / 2 : 7 / 4);
  const ticks = dotted * event.tupletInTimeOf / event.tupletPlayed;
  assert(Number.isInteger(ticks) && ticks > 0, '음표 길이를 MIDI 박자로 정확히 표현할 수 없습니다.');
  return ticks;
}

function midiPitch(pitch) {
  assert(Object.hasOwn(STEP_SEMITONES, pitch.step) && Number.isInteger(pitch.alter) && Math.abs(pitch.alter) <= 2 && Number.isInteger(pitch.octave), '음높이를 해석할 수 없습니다.');
  const number = (pitch.octave + 1) * 12 + STEP_SEMITONES[pitch.step] + pitch.alter;
  assert(number >= 0 && number <= 127, 'MIDI 음역을 벗어난 음표가 있습니다.');
  return number;
}

function variableLength(value) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= 0x0fffffff, 'MIDI 시간이 범위를 벗어났습니다.');
  const bytes = [value & 0x7f];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

function chunk(type, bytes) {
  const length = bytes.length;
  return Buffer.from([...Buffer.from(type, 'ascii'), (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...bytes]);
}

function buildTrack(events, endTick) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);
  const data = [];
  let previous = 0;
  for (const event of events) {
    data.push(...variableLength(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  data.push(...variableLength(endTick - previous), 0xff, 0x2f, 0);
  return chunk('MTrk', data);
}

export function scoreToMidi(score) {
  assert(score && Number.isInteger(score.bpm) && score.bpm >= 30 && score.bpm <= 300, 'BPM을 확인할 수 없습니다.');
  assert(Array.isArray(score.measures) && score.measures.length > 0 && score.measures.length <= 100, '마디 수를 확인할 수 없습니다.');
  const tempo = Math.round(60000000 / score.bpm);
  const conductor = [{ tick: 0, order: 0, bytes: [0xff, 0x51, 3, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255] }];
  const tracks = new Map();
  const pendingTies = new Map();
  let expectedStaves = null;
  let measureStart = 0;
  let previousMeter = '';
  let noteCount = 0;

  for (let index = 0; index < score.measures.length; index++) {
    const measure = score.measures[index];
    const label = `${index + 1}마디`;
    assert(measure && measure.number === index + 1, `${label} 순서가 맞지 않습니다.`);
    assert(typeof measure.uncertain === 'boolean' && typeof measure.issue === 'string', `${label} 판독 상태를 확인할 수 없습니다.`);
    assert(!measure.uncertain && !measure.issue, `${label} 판독이 불확실합니다${measure.issue ? `: ${measure.issue}` : '.'}`);
    const { numerator, denominator } = measure;
    assert(Number.isInteger(numerator) && numerator >= 1 && numerator <= 32 && [1, 2, 4, 8, 16, 32].includes(denominator), `${label} 박자표를 확인할 수 없습니다.`);
    const measureTicks = TICKS_PER_QUARTER * 4 * numerator / denominator;
    const meter = `${numerator}/${denominator}`;
    if (meter !== previousMeter) {
      conductor.push({ tick: measureStart, order: 1, bytes: [0xff, 0x58, 4, numerator, Math.log2(denominator), 24, 8] });
      previousMeter = meter;
    }
    assert(Array.isArray(measure.staves) && measure.staves.length > 0 && measure.staves.length <= 8, `${label} 오선을 확인할 수 없습니다.`);
    const staffIds = measure.staves.map(item => item.staff);
    assert(staffIds.every(id => Number.isInteger(id) && id >= 1 && id <= 8) && new Set(staffIds).size === staffIds.length, `${label} 오선 번호가 잘못되었습니다.`);
    const staffSignature = [...staffIds].sort((a, b) => a - b).join(',');
    if (expectedStaves === null) expectedStaves = staffSignature;
    assert(staffSignature === expectedStaves, `${label} 오선이 누락되었습니다.`);

    for (const staff of measure.staves) {
      if (!tracks.has(staff.staff)) tracks.set(staff.staff, []);
      assert(Array.isArray(staff.voices) && staff.voices.length > 0 && staff.voices.length <= 4, `${label} 성부를 확인할 수 없습니다.`);
      const voiceIds = staff.voices.map(item => item.voice);
      assert(voiceIds.every(id => Number.isInteger(id) && id >= 1 && id <= 4) && new Set(voiceIds).size === voiceIds.length, `${label} 성부 번호가 잘못되었습니다.`);
      for (const voice of staff.voices) {
        assert(Array.isArray(voice.events) && voice.events.length > 0, `${label}에 음표나 쉼표가 없습니다.`);
        let offset = 0;
        const voicePrefix = `${staff.staff}:${voice.voice}:`;
        for (const event of voice.events) {
          assert(event && Array.isArray(event.pitches), `${label} 음표 정보가 잘못되었습니다.`);
          const duration = eventTicks(event);
          const start = measureStart + offset;
          const end = start + duration;
          offset += duration;
          assert(offset <= measureTicks, `${label}의 음표 길이가 박자표보다 깁니다.`);
          if (event.kind === 'rest') {
            assert(event.pitches.length === 0, `${label} 쉼표에 음높이가 있습니다.`);
            assert(![...pendingTies.keys()].some(key => key.startsWith(voicePrefix)), `${label} 붙임줄 뒤에 쉼표가 있습니다.`);
            continue;
          }
          assert(event.kind === 'note' && event.pitches.length > 0, `${label}에 음높이가 빠졌습니다.`);
          const numbers = event.pitches.map(midiPitch);
          const seen = new Set(numbers);
          assert(seen.size === numbers.length, `${label} 화음에 중복된 음이 있습니다.`);
          for (const [key, tied] of pendingTies) {
            if (key.startsWith(voicePrefix)) {
              assert(tied.tick === start && seen.has(Number(key.slice(voicePrefix.length))), `${label} 붙임줄 음높이가 일치하지 않습니다.`);
            }
          }
          for (const pitch of event.pitches) {
            const number = midiPitch(pitch);
            const tieKey = `${voicePrefix}${number}`;
            const tied = pendingTies.get(tieKey);
            if (tied) {
              assert(tied.tick === start, `${label} 붙임줄이 이어지지 않습니다.`);
              tied.off.tick = end;
              pendingTies.delete(tieKey);
            } else {
              const on = { tick: start, order: 2, bytes: [0x90 | ((staff.staff - 1) % 9), number, 96] };
              const off = { tick: end, order: 0, bytes: [0x80 | ((staff.staff - 1) % 9), number, 0] };
              tracks.get(staff.staff).push(on, off);
              if (pitch.tieToNext) pendingTies.set(tieKey, { tick: end, off });
              noteCount++;
              assert(noteCount <= MAX_EVENTS, '악보에 음표가 너무 많습니다.');
              continue;
            }
            if (pitch.tieToNext) pendingTies.set(tieKey, { tick: end, off: tied.off });
          }
        }
        assert(offset === measureTicks, `${label} ${staff.staff}번 오선 ${voice.voice}번 성부의 길이가 ${meter} 박자와 다릅니다.`);
      }
    }
    measureStart += measureTicks;
  }
  assert(pendingTies.size === 0, '마지막 마디에 끝나지 않은 붙임줄이 있습니다.');
  assert(noteCount > 0, '악보에서 음표를 찾지 못했습니다.');
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.size + 1, (TICKS_PER_QUARTER >>> 8) & 255, TICKS_PER_QUARTER & 255]);
  const midi = Buffer.concat([header, buildTrack(conductor, measureStart), ...[...tracks].sort((a, b) => a[0] - b[0]).map(([, events]) => buildTrack(events, measureStart))]);
  return { midi, noteCount, measureCount: score.measures.length, bpm: score.bpm };
}

function fileType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  throw new ScoreError('PNG, JPEG 또는 PDF 악보 파일을 선택해 주세요.', 415);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SCORE_BYTES) throw new ScoreError('악보 파일은 8MB 이하여야 합니다.', 413);
    chunks.push(chunk);
  }
  assert(size > 0, '악보 파일을 선택해 주세요.');
  return Buffer.concat(chunks);
}

export async function transcribe(buffer, mime, { key = process.env.OPENAI_API_KEY, model = process.env.OPENAI_SCORE_MODEL || DEFAULT_SCORE_MODEL, fetchImpl = fetch, secondPass = false } = {}) {
  if (!key) throw new ScoreError('서버에 OPENAI_API_KEY를 설정해 주세요.', 503);
  const fileData = `data:${mime};base64,${buffer.toString('base64')}`;
  const source = mime === 'application/pdf'
    ? { type: 'input_file', filename: 'score.pdf', file_data: fileData, detail: 'high' }
    : { type: 'input_image', image_url: fileData, detail: 'original' };
  const body = {
    model,
    store: false,
    max_output_tokens: 24000,
    reasoning: { effort: 'medium' },
    instructions: [
      'You are a meticulous optical music recognition transcriber. Transcribe every visible measure, staff, voice, note, chord, rest, accidental, dot, tie and tuplet in reading order.',
      'Return written pitches as step, explicit semitone alter (after key signature and local accidentals), and scientific octave (middle C is C4). Carry key signatures forward, reset local accidentals at each barline, and account for clefs and clef changes. Never guess an unreadable pitch or duration.',
      'Each voice must fill its entire measure exactly; include explicit rests for silent spans. Split simultaneous independent rhythmic lines into separate voices. Chord notes share one event.',
      'For a tie, set tieToNext on each tied pitch, including ties across barlines. Do not mark slurs as ties. Set tupletPlayed=1 and tupletInTimeOf=1 for ordinary notes.',
      'Carry the written time signature forward to each measure until it changes. Use the written tempo if clear, otherwise 120 BPM. Number measures from 1. This converter targets concert-pitch keyboard scores. Mark any pickup, cadenza, repeat, volta, da capo, coda, tempo change, swing marking, or transposing-instrument staff as uncertain. If a clef or other notation cannot be read reliably, also set uncertain=true and explain in issue. Do not fabricate omitted measures or notes.',
      secondPass ? 'Independently audit each notehead, ledger line, accidental, beam, dot, tie and rest before answering. Check every measure duration from scratch.' : 'Read the whole score carefully before answering.'
    ].join(' '),
    input: [{ role: 'user', content: [source, { type: 'input_text', text: 'Transcribe this score for an exact MIDI conversion. Check pitch, rhythm and duration note by note.' }] }],
    text: { format: { type: 'json_schema', name: 'score_transcription', strict: true, schema: scoreSchema } }
  };
  let upstream;
  try {
    upstream = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180000)
    });
  } catch (error) {
    throw new ScoreError(error.name === 'TimeoutError' ? 'AI 판독 시간이 초과되었습니다.' : 'AI 서비스에 연결하지 못했습니다.', 502);
  }
  if (!upstream.ok) {
    if (upstream.status === 401 || upstream.status === 403) throw new ScoreError('OpenAI API 키 또는 모델 권한을 확인해 주세요.', 502);
    if (upstream.status === 429) throw new ScoreError('AI 서비스 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 503);
    throw new ScoreError(`AI 판독 요청이 실패했습니다. (${upstream.status})`, 502);
  }
  const result = await upstream.json();
  assert(result.status === 'completed', 'AI 판독이 완료되지 않았습니다. 더 선명한 악보로 다시 시도해 주세요.');
  const output = result.output?.flatMap(item => item.type === 'message' ? item.content || [] : []).find(item => item.type === 'output_text')?.text;
  assert(output, 'AI가 음표 데이터를 반환하지 않았습니다.');
  try { return JSON.parse(output); } catch { throw new ScoreError('AI 음표 데이터를 읽을 수 없습니다.'); }
}

let busy = false;
export async function handleScoreToMidi(request, response) {
  if (request.method !== 'POST') { json(response, 405, { error: 'POST 요청만 지원합니다.' }); return; }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.host !== request.headers.host || !['http:', 'https:'].includes(url.protocol)) { json(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; }
    } catch { json(response, 403, { error: '요청 출처를 확인할 수 없습니다.' }); return; }
  }
  if (busy) { json(response, 429, { error: '다른 악보를 변환 중입니다. 잠시 후 다시 시도해 주세요.' }); return; }
  busy = true;
  try {
    const buffer = await readBody(request);
    const mime = fileType(buffer);
    const first = scoreToMidi(await transcribe(buffer, mime));
    const result = scoreToMidi(await transcribe(buffer, mime, { secondPass: true }));
    if (!first.midi.equals(result.midi)) throw new ScoreError('두 차례 악보 판독 결과가 일치하지 않습니다. 더 선명한 파일로 다시 시도하거나 악보를 나누어 올려 주세요.');
    json(response, 200, { midiBase64: result.midi.toString('base64'), noteCount: result.noteCount, measureCount: result.measureCount, bpm: result.bpm });
  } catch (error) {
    json(response, error.status || 500, { error: error.status ? error.message : '악보 변환 중 서버 오류가 발생했습니다.' });
  } finally {
    busy = false;
  }
}
