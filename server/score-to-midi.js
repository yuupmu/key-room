import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { parseMidi } from 'midi-file';

const TICKS_PER_QUARTER = 6720;
export const DEFAULT_SCORE_MODEL = 'gpt-6-astra';
export const SCORE_REASONING_EFFORT = 'high';
const MAX_SCORE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 12000;
const MAX_MEASURES = 500;
const MAX_SEGMENT_MEASURES = 4;
const MAX_PAGES = 80;
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
    kind: { type: 'string', enum: ['note', 'rest', 'unknown'] },
    pitches: { type: 'array', items: pitchSchema },
    base: { type: 'string', enum: [...Object.keys(BASE_TICKS), 'unknown'] },
    dots: { type: 'integer' },
    tupletPlayed: { type: 'integer', enum: [1, 3, 5, 6, 7] },
    tupletInTimeOf: { type: 'integer', enum: [1, 2, 4] }
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
  assert(Array.isArray(score.measures) && score.measures.length > 0 && score.measures.length <= MAX_MEASURES, '마디 수를 확인할 수 없습니다.');
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
  const header = count => Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, count, (TICKS_PER_QUARTER >>> 8) & 255, TICKS_PER_QUARTER & 255]);
  const conductorTrack = buildTrack(conductor, measureStart);
  const staffTracks = [...tracks].sort((a, b) => a[0] - b[0]).map(([staff, events]) => [staff, buildTrack(events, measureStart)]);
  const midi = Buffer.concat([header(staffTracks.length + 1), conductorTrack, ...staffTracks.map(([, track]) => track)]);
  const midiByStaff = Object.fromEntries(staffTracks.map(([staff, track]) => [staff, Buffer.concat([header(2), conductorTrack, track])]));
  const verify = (bytes, expectedTracks, expectedNotes) => {
    const parsed = parseMidi(bytes);
    assert(parsed.header.ticksPerBeat === TICKS_PER_QUARTER && parsed.tracks.length === expectedTracks, '생성한 MIDI를 다시 읽을 수 없습니다.');
    let actualNotes = 0;
    for (const track of parsed.tracks) {
      let tick = 0;
      for (const event of track) {
        tick += event.deltaTime;
        if (event.type === 'noteOn' && event.velocity > 0) actualNotes++;
      }
      assert(tick === measureStart && track.at(-1)?.type === 'endOfTrack', '생성한 MIDI의 전체 시간이 맞지 않습니다.');
    }
    assert(actualNotes === expectedNotes, '생성한 MIDI의 음표 수가 맞지 않습니다.');
  };
  verify(midi, staffTracks.length + 1, noteCount);
  for (const [staff, bytes] of Object.entries(midiByStaff))
    verify(bytes, 2, tracks.get(Number(staff)).filter(event => (event.bytes[0] & 0xf0) === 0x90).length);
  return { midi, midiByStaff, noteCount, measureCount: score.measures.length, bpm: score.bpm };
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

function imageInput(buffer, mime = 'image/png') {
  return { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}`, detail: 'original' };
}

function aiLog(phase, detail) {
  // Never log the uploaded score, API key, prompt, or model output.
  console.error('[score-to-midi]', JSON.stringify({ phase, ...detail }));
}

async function requestScoreAI(body, { key = process.env.OPENAI_API_KEY, fetchImpl = fetch, sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)), phase = 'transcribe', jobId } = {}) {
  if (!key) throw new ScoreError('서버에 OPENAI_API_KEY를 설정해 주세요.', 503);
  const startedAt = Date.now();
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  async function request(url, options) {
    let upstream;
    try { upstream = await fetchImpl(url, { ...options, headers }); }
    catch (error) {
      aiLog(phase, { jobId, networkError: error?.name, code: error?.cause?.code, elapsedMs: Date.now() - startedAt });
      throw new ScoreError('AI 서비스에 연결하지 못했습니다.', 502);
    }
    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => ({}));
      aiLog(phase, { jobId, httpStatus: upstream.status, apiCode: detail.error?.code, apiType: detail.error?.type, requestId: upstream.headers?.get?.('x-request-id'), elapsedMs: Date.now() - startedAt });
      if (upstream.status === 401 || upstream.status === 403) throw new ScoreError('OpenAI API 키 또는 모델 권한을 확인해 주세요.', 502);
      if (upstream.status === 429) throw new ScoreError('AI 서비스 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 503);
      throw new ScoreError(`AI 판독 요청이 실패했습니다. (${upstream.status})`, 502);
    }
    return upstream.json();
  }
  let result = await request('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ ...body, background: true }) });
  let priorStatus = null;
  let polls = 0;
  while (result.status === 'queued' || result.status === 'in_progress') {
    assert(typeof result.id === 'string' && /^resp_[A-Za-z0-9_-]+$/.test(result.id), 'AI 응답 ID가 올바르지 않습니다.');
    if (result.status !== priorStatus || polls % 12 === 11) aiLog(phase, { jobId, status: result.status, requestId: result.id, elapsedMs: Date.now() - startedAt, polls });
    priorStatus = result.status;
    await sleepImpl(5000);
    polls++;
    result = await request(`https://api.openai.com/v1/responses/${result.id}`, { method: 'GET' });
  }
  aiLog(phase, { jobId, status: result.status, reason: result.incomplete_details?.reason, usage: result.usage, apiCode: result.error?.code, requestId: result.id, elapsedMs: Date.now() - startedAt, polls });
  if (result.status === 'incomplete') {
    throw new ScoreError(result.incomplete_details?.reason === 'max_output_tokens'
      ? phase.startsWith('layout') ? '페이지의 마디 위치 판독이 출력·추론 토큰 한도에 도달했습니다. 페이지를 나누어 다시 시도해 주세요.'
        : 'AI 출력·추론 토큰 한도에 도달했습니다. 구간을 더 작게 나누어 다시 시도해 주세요.'
      : `AI 판독이 완료되지 않았습니다. (${result.incomplete_details?.reason || '원인 미상'})`, 502);
  }
  assert(result.status === 'completed', `AI 판독이 완료되지 않았습니다. (${result.error?.code || result.status || '원인 미상'})`);
  const output = result.output?.flatMap(item => item.type === 'message' ? item.content || [] : []).find(item => item.type === 'output_text')?.text;
  assert(output, 'AI가 음표 데이터를 반환하지 않았습니다.');
  try { return JSON.parse(output); } catch { throw new ScoreError('AI 음표 데이터를 읽을 수 없습니다.'); }
}

const TRANSCRIBE_INSTRUCTIONS = `너는 피아노 악보의 지정된 구간을 구조화된 음표 데이터로 전사한다. 응답은 제공된 JSON Schema만 따른다.
대상 이미지와 앞뒤 마디/시스템 참고 이미지가 제공된다. 참고 마디는 중복 출력하지 않는다. measures.number는 이번 구간 안에서 1부터 순서대로 부여한다. 전체 번호 연결은 서버가 한다. 오선 번호는 제공된 식별 정보를 유지하고 음높이로 양손을 바꾸지 않는다. 음표가 없는 대상 마디와 오선도 누락하지 않는다.
음자리표, 조표, 마디 내 임시표를 적용해 step, alter, octave를 기록한다. 가운데 도는 C4이다. 마디선을 넘는 붙임줄 음높이도 확인한다. 음표 머리, 기둥, 빔, 꼬리, 점, 쉼표, 잇단음표를 근거로 base, dots, tupletPlayed, tupletInTimeOf를 기록한다. 일반 음표와 쉼표는 반드시 tupletPlayed=1, tupletInTimeOf=1이다. 실제 잇단음표만 표기된 비율을 쓴다. 0:0은 절대 사용하지 않는다. 가로 간격만으로 음 길이를 결정하지 않는다. 같은 시작 시각과 길이의 화음은 한 이벤트, 독립 리듬은 별도 성부이다. tieToNext는 실제 붙임줄인 개별 음에만 설정하고 이음줄과 구별한다.
박자 합을 맞추기 위해 길이를 바꾸거나 쉼표를 만들지 않는다. 읽을 수 없는 부분은 kind=unknown, base=unknown으로 표시하고 uncertain=true 및 issue에 위치와 기호를 적는다. 읽을 수 있는 이벤트는 보존한다. 비슷한 악구로 추측하지 않는다. 판독 가능하면 uncertain=false, issue=""이다. 숫자 N이 붙은 다중마디쉼표는 한 시각적 기호로 출력하고 issue에 MULTI_REST:N을 정확히 적는다. 각 오선의 이벤트는 unknown으로 두며 서버가 N마디 쉼표로 펼친다. MIDI 번호, 시간, 바이트는 계산하지 않는다. 반복, 도돌이표, 앞꾸밈음, 박자 밖 음표 등 이 변환기가 펼치지 못하는 표기는 uncertain으로 남긴다.`;
const RECHECK_INSTRUCTIONS = `첨부된 원본 대상 이미지와 후보 JSON을 대조하여 지정된 마디 전체를 기존 스키마로 수정한다. 후보에 오류가 있을 수 있으며 후보와 일치시키는 것이 목표가 아니다. 누락/추가 음표 머리, 화음, 음자리표, 보조선, 옥타브, 조표와 임시표, 빔, 꼬리, 점, 쉼표, 잇단음표, 성부, 개별 붙임줄과 앞뒤 경계를 확인한다. 서버 오류는 위치 단서일 뿐이며 박자 합을 맞추려고 기호를 만들어내지 않는다. 원본 근거가 있을 때만 수정한다. 해결되지 않은 부분은 uncertain=true와 구체적인 issue를 유지한다. 참고 마디는 출력하지 않는다.`;

const layoutSchema = { type: 'object', additionalProperties: false, properties: {
  measures: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    system: { type: 'integer' }, density: { type: 'string', enum: ['dense', 'normal', 'simple'] }, box: { type: 'object', additionalProperties: false, properties: {
      left: { type: 'number' }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' }
    }, required: ['left', 'top', 'right', 'bottom'] }
  }, required: ['system', 'density', 'box'] } }
}, required: ['measures'] };

export async function transcribe(buffer, mime, { key, model = process.env.OPENAI_SCORE_TO_MIDI_MODEL || DEFAULT_SCORE_MODEL, fetchImpl, sleepImpl, jobId, secondPass = false, target = null, reference = null, adjacentReferences = [], context = '', candidate = null, errors = [] } = {}) {
  // The legacy direct call is a one-image, one-segment operation; the route below always supplies cropped targets.
  const content = [imageInput(buffer, mime)];
  if (reference) content.push(imageInput(reference));
  for (const adjacent of adjacentReferences) content.push(imageInput(adjacent));
  content.push({ type: 'input_text', text: `${target ? `전체 곡 ${target.start}~${target.end}마디, 이번 응답 1~${target.end - target.start + 1}마디. ` : ''}첫 이미지만 판독 대상이고 나머지 이미지는 시스템/앞뒤 마디 참고 자료이다. staff 1=위 오선(오른손), staff 2=아래 오선(왼손). ${context || '음자리표·조표·박자표가 참고 이미지에도 확인되지 않으면 추측하지 말고 uncertain으로 표시한다.'}${candidate ? `\n후보 JSON: ${JSON.stringify(candidate)}\n서버 검증 오류: ${errors.join('; ')}` : ''}` });
  const body = { model, store: false, max_output_tokens: 28000, reasoning: { effort: SCORE_REASONING_EFFORT },
    instructions: `${TRANSCRIBE_INSTRUCTIONS}\n${candidate || secondPass ? RECHECK_INSTRUCTIONS : ''}`,
    input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'score_transcription', strict: true, schema: scoreSchema } } };
  return requestScoreAI(body, { key, fetchImpl, sleepImpl, jobId, phase: candidate || secondPass ? 'recheck' : 'transcribe' });
}

async function renderPdfPage(buffer, page) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '2800', '-png', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.resume();
    child.on('error', error => reject(new ScoreError(error.code === 'ENOENT' ? 'PDF 판독에 pdftoppm(Poppler)이 필요합니다.' : 'PDF 렌더링을 시작하지 못했습니다.', 503)));
    child.on('close', code => code === 0 && size ? resolve(Buffer.concat(chunks)) : reject(new ScoreError(`PDF ${page}페이지를 이미지로 만들지 못했습니다.`, 422)));
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

function checkedBox(box) {
  assert(box && [box.left, box.top, box.right, box.bottom].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000)
    && box.left < box.right && box.top < box.bottom, '마디 이미지 경계를 확인할 수 없습니다.');
  return box;
}

export function segmentLayout(layout, start = 1) {
  assert(Array.isArray(layout?.measures) && layout.measures.length > 0 && layout.measures.length + start - 1 <= MAX_MEASURES, '페이지의 마디 경계를 확인할 수 없습니다.');
  const bars = layout.measures.map((item, index) => ({ number: start + index, system: item.system,
    density: ['dense', 'normal', 'simple'].includes(item.density) ? item.density : 'simple', box: checkedBox(item.box) }));
  assert(bars.every(item => Number.isInteger(item.system) && item.system >= 1 && item.system <= MAX_MEASURES), '시스템 순서를 확인할 수 없습니다.');
  for (let i = 1; i < bars.length; i++) {
    const before = bars[i - 1], after = bars[i];
    assert(after.system > before.system || after.system === before.system && after.box.left >= before.box.left,
      '마디 이미지가 악보 순서대로 놓이지 않았습니다.');
  }
  const segments = [];
  for (let i = 0; i < bars.length;) {
    const first = bars[i];
    let end = i + 1;
    const limit = first.density === 'dense' ? 1 : first.density === 'normal' ? 2 : MAX_SEGMENT_MEASURES;
    while (end < bars.length && end - i < limit && bars[end].system === first.system && bars[end].density !== 'dense'
      && (bars[end].density !== 'normal' || end - i < 2)) end++;
    segments.push({ start: first.number, end: bars[end - 1].number, bars: bars.slice(i, end), system: first.system,
      referenceBars: bars.filter(bar => bar.system === first.system || bar.number === first.number - 1 || bar.number === bars[end - 1].number + 1) });
    i = end;
  }
  return segments;
}

async function locatePage(image, options) {
  const body = { model: options.model || process.env.OPENAI_SCORE_TO_MIDI_MODEL || DEFAULT_SCORE_MODEL,
    store: false, max_output_tokens: 5000, reasoning: { effort: SCORE_REASONING_EFFORT },
    instructions: 'Locate EVERY written measure on this score page, including all piano staves together. Return boxes in reading order, with one rectangle for both hands per measure, in 0..1000 coordinates relative to the page (top-left origin). Assign system numbers from 1 down the page. Mark density=dense for crowded noteheads, beams, accidentals, tuplets or tiny glyphs; normal for moderate notation; simple for sparse bars. This only chooses a first crop size, not a correctness verdict. Adjacent boxes in the same system must have ordered x positions; top/bottom must include ledger lines, accidentals, and ties with a little margin. Do not transcribe the music or invent invisible measures. If the boundaries cannot be located, return an empty array.',
    input: [{ role: 'user', content: [imageInput(image), { type: 'input_text', text: `Locate bar boundaries on page ${options.page}. Include both staves, barlines, and all visible written measures.` }] }],
    text: { format: { type: 'json_schema', name: 'score_page_layout', strict: true, schema: layoutSchema } } };
  return requestScoreAI(body, { ...options, phase: `layout-page-${options.page}` });
}

function unionBoxes(bars) {
  return bars.reduce((box, bar) => ({ left: Math.min(box.left, bar.box.left), top: Math.min(box.top, bar.box.top),
    right: Math.max(box.right, bar.box.right), bottom: Math.max(box.bottom, bar.box.bottom) }),
  { left: 1000, top: 1000, right: 0, bottom: 0 });
}

function splitSegment(segment) {
  const middle = Math.ceil(segment.bars.length / 2);
  return [segment.bars.slice(0, middle), segment.bars.slice(middle)].map(bars => ({ ...segment,
    start: bars[0].number, end: bars.at(-1).number, bars }));
}

async function cropBars(pageImage, bars, margin = 12) {
  const { width, height } = await sharp(pageImage).metadata();
  assert(width > 0 && height > 0, '악보 이미지 크기를 확인할 수 없습니다.');
  const box = unionBoxes(bars);
  const left = Math.max(0, Math.floor(box.left * width / 1000) - margin);
  const top = Math.max(0, Math.floor(box.top * height / 1000) - margin);
  const right = Math.min(width, Math.ceil(box.right * width / 1000) + margin);
  const bottom = Math.min(height, Math.ceil(box.bottom * height / 1000) + margin);
  return sharp(pageImage).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}

function multiRestCount(bar) {
  const issue = bar?.issue || '';
  const match = /MULTI_REST:(\d{1,2})\b/i.exec(issue) || /(\d{1,2})\s*마디\s*다중(?:마디)?쉼표/.exec(issue);
  const count = Number(match?.[1]);
  if (!bar?.uncertain || !Number.isInteger(count) || count < 2 || count > 32
    || !Number.isInteger(bar.numerator) || bar.numerator < 1 || bar.numerator > 32
    || ![1, 2, 4, 8, 16, 32].includes(bar.denominator)
    || /추정|확인 필요|불명|모호|BPM|박자표|음자리표|조표|음높이|붙임줄|더블스탑/.test(issue)
    || !Array.isArray(bar.staves) || !bar.staves.length) return 0;
  const staffIds = bar.staves.map(staff => staff?.staff);
  if (new Set(staffIds).size !== staffIds.length || staffIds.some(id => !Number.isInteger(id) || id < 1 || id > 8)) return 0;
  if (!bar.staves.every(staff => Array.isArray(staff.voices) && staff.voices.length > 0 && staff.voices.every(voice =>
    Number.isInteger(voice.voice) && Array.isArray(voice.events) && voice.events.length === 1
    && voice.events[0].kind === 'unknown' && Array.isArray(voice.events[0].pitches) && voice.events[0].pitches.length === 0))) return 0;
  return count;
}

function fullMeasureRestEvents(numerator, denominator) {
  let remaining = TICKS_PER_QUARTER * 4 * numerator / denominator;
  const events = [];
  for (const [base, ticks] of Object.entries(BASE_TICKS)) {
    while (remaining >= ticks) {
      events.push({ kind: 'rest', pitches: [], base, dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 });
      remaining -= ticks;
    }
  }
  assert(remaining === 0 && events.length > 0, '다중쉼표의 박자표를 MIDI로 표현할 수 없습니다.');
  return events;
}

export function expandMultiMeasureRests(visualMeasures) {
  const measures = [];
  const locations = new Map();
  const expanded = [];
  for (const bar of visualMeasures) {
    const start = measures.length + 1;
    const count = multiRestCount(bar) || 1;
    assert(start + count - 1 <= MAX_MEASURES, '다중쉼표를 펼치면 전체 500마디를 초과합니다.');
    for (let index = 0; index < count; index++) {
      measures.push(count === 1 ? { ...bar, number: measures.length + 1 } : {
        number: measures.length + 1, numerator: bar.numerator, denominator: bar.denominator, uncertain: false, issue: '',
        staves: bar.staves.map(staff => ({ staff: staff.staff, voices: staff.voices.map(voice => ({
          voice: voice.voice, events: fullMeasureRestEvents(bar.numerator, bar.denominator)
        })) }))
      });
    }
    locations.set(bar.number, { start, end: measures.length });
    if (count > 1) expanded.push({ visualMeasure: bar.number, actualStart: start, count });
  }
  return { measures, locations, expanded };
}

function segmentProblems(reading, count) {
  const problems = [];
  if (!Array.isArray(reading?.measures) || reading.measures.length !== count) return ['대상 마디 수가 맞지 않습니다.'];
  for (let index = 0; index < count; index++) {
    const bar = reading.measures[index];
    if (bar?.number !== index + 1) problems.push(`${index + 1}번째 마디 번호가 빠지거나 중복되었습니다.`);
    if (multiRestCount(bar)) continue;
    if (bar?.uncertain || bar?.issue) problems.push(`${index + 1}번째 마디: ${bar.issue || '판독 불확실'}`);
    if (!Number.isInteger(bar?.numerator) || ![1, 2, 4, 8, 16, 32].includes(bar?.denominator)) { problems.push(`${index + 1}번째 마디 박자표 오류`); continue; }
    const expected = TICKS_PER_QUARTER * 4 * bar.numerator / bar.denominator;
    if (!Array.isArray(bar.staves) || !bar.staves.length) { problems.push(`${index + 1}번째 마디 오선 누락`); continue; }
    for (const staff of bar.staves) for (const voice of staff.voices || []) {
      try {
        let sum = 0;
        for (const event of voice.events || []) {
          sum += eventTicks(event);
          if (event.kind === 'note') {
            assert(event.pitches?.length, '음높이가 빠졌습니다.');
            for (const pitch of event.pitches) midiPitch(pitch);
          } else assert(event.kind === 'rest' && event.pitches?.length === 0, '음표 또는 쉼표를 확인할 수 없습니다.');
        }
        assert(sum === expected, '성부의 박자 합이 박자표와 다릅니다.');
      } catch (error) { problems.push(`${index + 1}번째 마디 ${staff.staff}번 오선 ${voice.voice}번 성부: ${error.message}`); }
    }
  }
  return problems;
}

function normalizeSegment(reading, segment, firstNumber = segment.start) {
  assert(Array.isArray(reading?.measures) && reading.measures.length === segment.end - segment.start + 1,
    `${segment.start}~${segment.end}마디 판독 개수가 맞지 않습니다.`);
  return reading.measures.map((bar, index) => {
    assert(bar?.number === index + 1, `${segment.start + index}마디 구간 번호가 잘못되었습니다.`);
    return { ...bar, number: firstNumber + index };
  });
}

export async function transcribeScore(buffer, mime, options = {}) {
  if (!(options.key || process.env.OPENAI_API_KEY)) throw new ScoreError('서버에 OPENAI_API_KEY를 설정해 주세요.', 503);
  let pageCount;
  try { pageCount = mime === 'application/pdf' ? (await PDFDocument.load(buffer)).getPageCount() : 1; }
  catch { throw new ScoreError('PDF 페이지를 읽을 수 없습니다. 파일을 확인해 주세요.'); }
  assert(pageCount > 0 && pageCount <= MAX_PAGES, `악보는 최대 ${MAX_PAGES}페이지까지 판독할 수 있습니다.`);
  const jobId = options.jobId || randomUUID();
  const directory = join(options.transcriptionDir || process.env.SCORE_TRANSCRIPTION_DIR || join(tmpdir(), 'keyroom-score-transcriptions'), jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  aiLog('job-started', { jobId, mime, bytes: buffer.length, pages: pageCount, model: options.model || process.env.OPENAI_SCORE_TO_MIDI_MODEL || DEFAULT_SCORE_MODEL });
  const pageSegments = [];
  let locatedMeasures = 0;
  for (let page = 1; page <= pageCount; page++) {
    const image = mime === 'application/pdf' ? await renderPdfPage(buffer, page) : await sharp(buffer).resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const layout = await locatePage(image, { ...options, jobId, page });
    pageSegments.push(segmentLayout(layout, locatedMeasures + 1));
    locatedMeasures += layout.measures.length;
    options.onProgress?.({ phase: 'layout', page, pageCount, completedMeasures: 0, locatedMeasures, completedSegments: 0 });
  }
  const all = []; const segmentRecords = []; let bpm = null;
  let previousPageReference = null;
  for (let page = 1; page <= pageCount; page++) {
    const image = mime === 'application/pdf' ? await renderPdfPage(buffer, page) : await sharp(buffer).resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const segments = pageSegments[page - 1];
    for (let segmentIndex = 0; segmentIndex < segments.length;) {
      const segment = segments[segmentIndex];
      options.onProgress?.({ phase: 'transcribe', page, pageCount, completedMeasures: all.length,
        completedSegments: segmentRecords.length, visualStart: segment.start, visualEnd: segment.end, startedAt: Date.now() });
      aiLog('segment-started', { jobId, page, visualStart: segment.start, visualEnd: segment.end });
      try {
        const target = await cropBars(image, segment.bars, 16);
        const reference = await cropBars(image, segment.referenceBars, 28);
        const previous = all.at(-1);
        const inheritedMeter = previous && (!previous.uncertain || multiRestCount(previous))
          ? `${previous.numerator}/${previous.denominator}` : '';
        const context = `페이지 ${page}, 시스템 ${segment.system}. 제공한 시스템 참고 이미지에서 음자리표·조표·박자표를 확인하라. 검증되지 않은 값을 추측하지 말라. ${inheritedMeter ? `앞 구간에서 읽은 박자표=${inheritedMeter}. 새 박자표가 없다면 이 박자표가 계속 적용된다.` : ''} ${bpm ? `앞 구간에서 읽은 BPM=${bpm}. 새 템포 표시가 없다면 유지한다.` : ''}`;
        const params = { ...options, jobId, target: segment, reference, context,
          adjacentReferences: segmentIndex === 0 && previousPageReference ? [previousPageReference] : [] };
        let reading = await transcribe(target, 'image/png', params);
        let problems = segmentProblems(reading, segment.end - segment.start + 1);
        await writeFile(join(directory, `${segment.start}-${segment.end}-initial.json`), JSON.stringify({ page, problems, reading }));
        if (problems.length) {
          options.onProgress?.({ phase: 'recheck', page, pageCount, completedMeasures: all.length,
            completedSegments: segmentRecords.length, visualStart: segment.start, visualEnd: segment.end, startedAt: Date.now() });
          const revised = await transcribe(target, 'image/png', { ...params, candidate: reading, errors: problems });
          const revisedProblems = segmentProblems(revised, segment.end - segment.start + 1);
          if (revisedProblems.length <= problems.length) { reading = revised; problems = revisedProblems; }
          await writeFile(join(directory, `${segment.start}-${segment.end}-recheck.json`), JSON.stringify({ page, problems: revisedProblems, reading: revised }));
        }
        const bars = normalizeSegment(reading, segment);
        if (problems.length) for (const bar of bars) {
          const relevant = problems.filter(problem => !/^\d+번째/.test(problem) || problem.startsWith(`${bar.number - segment.start + 1}번째`));
          if (relevant.length) { bar.uncertain = true; bar.issue = [bar.issue, ...relevant].filter(Boolean).join(' ').slice(0, 1000); }
        }
        if (!Number.isInteger(reading.bpm) || reading.bpm < 30 || reading.bpm > 300) {
          bars[0].uncertain = true;
          bars[0].issue = `${bars[0].issue ? `${bars[0].issue} ` : ''}이 구간의 BPM을 확인해 주세요.`;
        }
        if (bpm === null) bpm = reading.bpm;
        else if (reading.bpm !== bpm) { bars[0].uncertain = true; bars[0].issue = `${bars[0].issue ? `${bars[0].issue} ` : ''}구간별 BPM이 다릅니다.`; }
        all.push(...bars);
        segmentRecords.push({ page, segment });
        aiLog('segment-saved', { jobId, page, visualStart: segment.start, visualEnd: segment.end, problems: problems.length });
        options.onProgress?.({ page, pageCount, completedMeasures: all.length, completedSegments: segmentRecords.length });
        segmentIndex++;
      } catch (error) {
        if (segment.bars.length > 1 && /토큰 한도/.test(error.message)) {
          aiLog('split', { jobId, page, start: segment.start, end: segment.end });
          segments.splice(segmentIndex, 1, ...splitSegment(segment));
        } else throw error;
      }
    }
    previousPageReference = await cropBars(image, segments.at(-1).referenceBars, 28);
  }
  assert(all.length > 0, '악보에서 마디를 찾지 못했습니다.');
  const expandedRests = expandMultiMeasureRests(all);
  all.splice(0, all.length, ...expandedRests.measures);
  for (const item of expandedRests.expanded) aiLog('multi-rest-expanded', { jobId, ...item });
  for (const record of segmentRecords) {
    record.actualStart = expandedRests.locations.get(record.segment.start)?.start;
    record.actualEnd = expandedRests.locations.get(record.segment.end)?.end;
  }
  options.onProgress?.({ phase: 'validate', page: pageCount, pageCount, completedMeasures: all.length,
    completedSegments: segmentRecords.length, startedAt: Date.now() });
  const score = { bpm: Number.isInteger(bpm) && bpm >= 30 && bpm <= 300 ? bpm : 120, measures: all };
  // Validate only after joining all bars: a tie at a crop boundary is not a song-ending tie.
  if (all.every(bar => !bar.uncertain && !bar.issue)) {
    try { scoreToMidi(score); }
    catch (error) {
      const number = Number(/(\d+)마디/.exec(error.message)?.[1]) || all.length;
      const record = segmentRecords.find(item => number >= item.actualStart && number <= item.actualEnd);
      if (record && record.actualEnd - record.actualStart === record.segment.end - record.segment.start) {
        const image = mime === 'application/pdf' ? await renderPdfPage(buffer, record.page) : await sharp(buffer).resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        const target = await cropBars(image, record.segment.bars, 16);
        const reference = await cropBars(image, record.segment.referenceBars, 28);
        const candidate = { bpm: score.bpm, measures: all.slice(record.actualStart - 1, record.actualEnd).map((bar, index) => ({ ...bar, number: index + 1 })) };
        const revised = await transcribe(target, 'image/png', { ...options, jobId, target: record.segment, reference, candidate, errors: [error.message],
          context: `페이지 ${record.page}, 시스템 ${record.segment.system}. 앞뒤 마디 경계의 붙임줄을 원본에서 확인하라.` });
        const problems = segmentProblems(revised, record.segment.end - record.segment.start + 1);
        await writeFile(join(directory, `${record.segment.start}-${record.segment.end}-boundary-recheck.json`), JSON.stringify({ problems, reading: revised }));
        if (!problems.length) all.splice(record.actualStart - 1, candidate.measures.length, ...normalizeSegment(revised, record.segment, record.actualStart));
        try { scoreToMidi(score); }
        catch (remaining) {
          const affected = Number(/(\d+)마디/.exec(remaining.message)?.[1]) || number;
          all[affected - 1].uncertain = true;
          all[affected - 1].issue = remaining.message;
        }
      } else {
        all[number - 1].uncertain = true;
        all[number - 1].issue = error.message;
      }
    }
  }
  await writeFile(join(directory, 'merged.json'), JSON.stringify(score));
  aiLog('saved', { jobId, pages: pageCount, measures: all.length, segments: segmentRecords.length });
  return { score, jobId };
}

const MANUAL_BASE = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: 'sixteenth', 32: 'thirty_second', 64: 'sixty_fourth' };
const BASE_NUMBER = Object.fromEntries(Object.entries(MANUAL_BASE).map(([number, name]) => [name, number]));

function manualPitch(token) {
  const match = /^([A-G])([#b]{0,2})(-?\d)(~?)$/.exec(token.replaceAll('♯', '#').replaceAll('♭', 'b'));
  assert(match, `음높이 ${token}을(를) 읽을 수 없습니다. C4, F#4처럼 적어 주세요.`);
  return { step: match[1], alter: [...match[2]].reduce((sum, sign) => sum + (sign === '#' ? 1 : -1), 0), octave: Number(match[3]), tieToNext: match[4] === '~' };
}

export function parseManualVoice(value) {
  assert(typeof value === 'string' && value.trim() && value.length <= 4000, '빈 성부가 있습니다. 음표와 쉼표를 마디 전체에 입력해 주세요.');
  return value.trim().split(/\s+/).map(token => {
    const match = /^(\[[^\]]+\]|R|[A-G][#b♯♭]{0,2}-?\d~?)\/(1|2|4|8|16|32|64)(\.{0,2})(?:@([3567]):([24]))?$/.exec(token);
    assert(match, `${token} 표기를 읽을 수 없습니다. 예: C4/4 D4/8 R/8 [C4,E4,G4]/2`);
    const pitches = match[1] === 'R' ? [] : (match[1].startsWith('[') ? match[1].slice(1, -1).split(',') : [match[1]]).map(manualPitch);
    return { kind: pitches.length ? 'note' : 'rest', pitches, base: MANUAL_BASE[match[2]], dots: match[3].length, tupletPlayed: Number(match[4] || 1), tupletInTimeOf: Number(match[5] || 1) };
  });
}

function manualVoiceText(events) {
  if (!Array.isArray(events)) return '';
  return events.map(event => {
    if (!event || !BASE_NUMBER[event.base] || !['note', 'rest'].includes(event.kind)) return '?';
    const pitches = event.kind === 'rest' ? 'R' : event.pitches?.map(pitch => {
      if (!Object.hasOwn(STEP_SEMITONES, pitch?.step) || !Number.isInteger(pitch.alter) || Math.abs(pitch.alter) > 2 || !Number.isInteger(pitch.octave)) return '?';
      return `${pitch.step}${pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter)}${pitch.octave}${pitch.tieToNext ? '~' : ''}`;
    });
    if (!Number.isInteger(event.dots) || event.dots < 0 || event.dots > 2 || !pitches || pitches === '?' || (Array.isArray(pitches) && (!pitches.length || pitches.includes('?')))) return '?';
    const chord = Array.isArray(pitches) ? (pitches.length === 1 ? pitches[0] : `[${pitches.join(',')}]`) : pitches;
    const tuplet = event.tupletPlayed === 1 && event.tupletInTimeOf === 1 ? '' : `@${event.tupletPlayed}:${event.tupletInTimeOf}`;
    return `${chord}/${BASE_NUMBER[event.base]}${'.'.repeat(event.dots || 0)}${tuplet}`;
  }).join(' ');
}

function blankMeasure(number) {
  return { number, numerator: 4, denominator: 4, uncertain: true, issue: 'AI가 마디를 읽지 못했습니다. 마디 수와 박자표부터 원본으로 확인해 주세요.', staves: [] };
}

function reviewItem(measure) {
  const voices = Array.isArray(measure.staves) ? measure.staves.flatMap(staff =>
    Array.isArray(staff?.voices) ? staff.voices.map(voice => ({ staff: staff.staff, voice: voice.voice, text: manualVoiceText(voice.events) })) : []) : [];
  if (!voices.length) voices.push({ staff: 1, voice: 1, text: '' });
  return { number: measure.number, issue: measure.issue, numerator: measure.numerator, denominator: measure.denominator, voices };
}

function musicalMeasure(measure) {
  // Array order for chord tones, staves, and numbered voices is not musical time.
  // Written spelling and ties still matter, so do not collapse enharmonic pitches.
  return JSON.stringify({ numerator: measure.numerator, denominator: measure.denominator,
    staves: [...(measure.staves || [])].map(staff => ({ staff: staff.staff,
      voices: [...(staff.voices || [])].map(voice => ({ voice: voice.voice,
        events: (voice.events || []).map(event => ({ kind: event.kind, base: event.base, dots: event.dots,
          tupletPlayed: event.tupletPlayed, tupletInTimeOf: event.tupletInTimeOf,
          pitches: [...(event.pitches || [])].map(p => [p.step, p.alter, p.octave, p.tieToNext]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
      })).sort((a, b) => a.voice - b.voice) })).sort((a, b) => a.staff - b.staff) });
}

export function prepareScoreReview(first, second) {
  const left = Array.isArray(first?.measures) ? first.measures : [];
  const right = Array.isArray(second?.measures) ? second.measures : [];
  const count = Math.max(left.length, right.length, 1);
  assert(count <= MAX_MEASURES, 'AI 판독 마디 수가 너무 많습니다. 악보를 나누어 올려 주세요.');
  const bpm = Number.isInteger(first?.bpm) && first.bpm >= 30 && first.bpm <= 300 ? first.bpm :
    Number.isInteger(second?.bpm) && second.bpm >= 30 && second.bpm <= 300 ? second.bpm : 120;
  const measures = Array.from({ length: count }, (_, index) => {
    const a = left[index]; const b = right[index];
    const measure = structuredClone(a && typeof a === 'object' ? a : b && typeof b === 'object' ? b : blankMeasure(index + 1));
    measure.number = index + 1;
    let issue = '';
    if (!a || !b) issue = '두 차례 판독의 마디 수가 다릅니다. 원본과 대조해 주세요.';
    else if (a.uncertain || a.issue || b.uncertain || b.issue) issue = a.issue || b.issue || '음표 판독이 불확실합니다.';
    else if (musicalMeasure(a) !== musicalMeasure(b)) issue = '두 차례 음표 판독이 다릅니다. 원본을 보고 이 마디를 입력해 주세요.';
    if (issue) { measure.uncertain = true; measure.issue = issue; }
    return measure;
  });
  const score = { bpm, measures };
  if (first?.bpm !== second?.bpm) {
    measures[0].uncertain = true;
    measures[0].issue = `${measures[0].issue ? `${measures[0].issue} ` : ''}두 차례 BPM 판독이 다릅니다. BPM도 확인해 주세요.`;
  }
  return collectScoreReview(score);
}

function collectScoreReview(score) {
  const measures = score.measures;
  const count = measures.length;
  if (!measures.some(item => item.uncertain || item.issue)) {
    try { scoreToMidi(score); }
    catch (error) {
      const number = Number(/(\d+)마디/.exec(error.message)?.[1]);
      const affected = number >= 1 && number <= count ? [measures[number - 1]] : measures;
      for (const measure of affected) { measure.uncertain = true; measure.issue = error.message; }
    }
  }
  return { score, review: measures.filter(item => item.uncertain || item.issue).map(reviewItem) };
}

export function finalizeReviewedScore(draft, corrections, bpm) {
  assert(draft && Array.isArray(draft.measures) && draft.measures.length > 0 && draft.measures.length <= MAX_MEASURES, '수정할 마디를 확인할 수 없습니다.');
  assert(Array.isArray(corrections) && corrections.length <= MAX_MEASURES, '수정한 마디를 확인할 수 없습니다.');
  const score = structuredClone(draft);
  score.bpm = bpm;
  const seen = new Set();
  for (const correction of corrections) {
    const number = correction?.number;
    assert(Number.isInteger(number) && number >= 1 && number <= score.measures.length && !seen.has(number), '수정한 마디 번호가 잘못되었습니다.');
    seen.add(number);
    const measure = score.measures[number - 1];
    assert(Array.isArray(correction.voices) && correction.voices.length > 0 && correction.voices.length <= 32, `${number}마디의 성부를 입력해 주세요.`);
    measure.numerator = correction.numerator;
    measure.denominator = correction.denominator;
    const staves = new Map();
    for (const row of correction.voices) {
      assert(Number.isInteger(row?.staff) && row.staff >= 1 && row.staff <= 8 && Number.isInteger(row.voice) && row.voice >= 1 && row.voice <= 4, `${number}마디 오선/성부 번호를 확인해 주세요.`);
      if (!staves.has(row.staff)) staves.set(row.staff, new Map());
      assert(!staves.get(row.staff).has(row.voice), `${number}마디에 같은 성부가 중복되었습니다.`);
      staves.get(row.staff).set(row.voice, parseManualVoice(row.text));
    }
    measure.staves = [...staves].sort((a, b) => a[0] - b[0]).map(([staff, voices]) => ({ staff, voices: [...voices].sort((a, b) => a[0] - b[0]).map(([voice, events]) => ({ voice, events })) }));
    measure.uncertain = false;
    measure.issue = '';
  }
  assert(score.measures.every(item => !item.uncertain && !item.issue), '판독하지 못한 마디가 남아 있습니다. 빈칸을 채워 주세요.');
  return scoreToMidi(score);
}

function midiPayload(result) {
  assert(Object.keys(result.midiByStaff).every(staff => ['1', '2'].includes(staff)) && result.midiByStaff[1], '오른손 1번, 왼손 2번 오선으로 된 악보만 변환할 수 있습니다.');
  return { midiBase64: result.midi.toString('base64'), rightMidiBase64: result.midiByStaff[1].toString('base64'), leftMidiBase64: result.midiByStaff[2]?.toString('base64') ?? null, noteCount: result.noteCount, measureCount: result.measureCount, bpm: result.bpm };
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const url = new URL(origin); return url.host === request.headers.host && ['http:', 'https:'].includes(url.protocol); }
  catch { return false; }
}

let busy = false;
const jobs = new Map();
export async function handleScoreToMidi(request, response) {
  if (request.method !== 'POST') { json(response, 405, { error: 'POST 요청만 지원합니다.' }); return; }
  if (!sameOrigin(request)) { json(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; }
  if (busy) { json(response, 429, { error: '다른 악보를 변환 중입니다. 잠시 후 다시 시도해 주세요.' }); return; }
  busy = true;
  try {
    const buffer = await readBody(request);
    const mime = fileType(buffer);
    if (!process.env.OPENAI_API_KEY) throw new ScoreError('서버에 OPENAI_API_KEY를 설정해 주세요.', 503);
    const jobId = randomUUID();
    const job = { status: 'running', progress: { page: 0, pageCount: 0, completedMeasures: 0, completedSegments: 0 } };
    jobs.set(jobId, job);
    void transcribeScore(buffer, mime, { jobId, onProgress: progress => { job.progress = progress; } })
      .then(({ score }) => {
        const { review } = collectScoreReview(score);
        job.result = review.length ? { reviewRequired: true, transcriptionId: jobId, draft: score, review }
          : { ...midiPayload(scoreToMidi(score)), transcriptionId: jobId };
        job.status = 'completed';
      }).catch(error => {
        aiLog('job-failed', { jobId, errorType: error?.name, status: error?.status, reason: error?.message });
        job.status = 'failed'; job.httpStatus = error?.status || 500;
        job.error = error?.status ? error.message : '악보 변환 중 서버 오류가 발생했습니다.';
      }).finally(() => {
        busy = false;
        setTimeout(() => jobs.delete(jobId), 60 * 60 * 1000).unref();
      });
    json(response, 202, { jobId, status: 'running' });
  } catch (error) {
    busy = false;
    json(response, error.status || 500, { error: error.status ? error.message : '악보 변환 중 서버 오류가 발생했습니다.' });
  }
}

export function handleScoreStatus(request, response) {
  if (request.method !== 'GET') { json(response, 405, { error: 'GET 요청만 지원합니다.' }); return; }
  if (!sameOrigin(request)) { json(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; }
  const jobId = new URL(request.url, 'http://localhost').searchParams.get('id');
  const job = jobId && jobs.get(jobId);
  if (!job) { json(response, 404, { error: '판독 작업을 찾지 못했습니다. 만료되었으면 악보를 다시 올려 주세요.' }); return; }
  if (job.status === 'failed') { json(response, job.httpStatus, { status: 'failed', error: job.error }); return; }
  if (job.status === 'completed') { json(response, 200, { status: 'completed', ...job.result }); return; }
  json(response, 202, { status: 'running', progress: job.progress });
}

export async function handleScoreReview(request, response) {
  if (request.method !== 'POST') { json(response, 405, { error: 'POST 요청만 지원합니다.' }); return; }
  if (!sameOrigin(request)) { json(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; }
  try {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    json(response, 200, midiPayload(finalizeReviewedScore(body.draft, body.corrections, body.bpm)));
  } catch (error) {
    json(response, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status ? error.message : error instanceof SyntaxError ? '수정 데이터를 읽을 수 없습니다.' : '악보 변환 중 서버 오류가 발생했습니다.' });
  }
}
