import { scoreToMidi } from './score-to-midi.js';
import { renderUnfoldedScore } from './unfold-score.js';

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BARS = 100;
const BASES = { 1: 'quarter', 2: 'half', 4: 'whole' };
const QUALITIES = {
  '': [[0, 1], [4, 3], [7, 5]], maj: [[0, 1], [4, 3], [7, 5]], M: [[0, 1], [4, 3], [7, 5]],
  m: [[0, 1], [3, 3], [7, 5]], min: [[0, 1], [3, 3], [7, 5]], '-': [[0, 1], [3, 3], [7, 5]],
  '7': [[0, 1], [4, 3], [7, 5], [10, 7]],
  M7: [[0, 1], [4, 3], [7, 5], [11, 7]], maj7: [[0, 1], [4, 3], [7, 5], [11, 7]],
  m7: [[0, 1], [3, 3], [7, 5], [10, 7]], min7: [[0, 1], [3, 3], [7, 5], [10, 7]], '-7': [[0, 1], [3, 3], [7, 5], [10, 7]],
  mM7: [[0, 1], [3, 3], [7, 5], [11, 7]], '-M7': [[0, 1], [3, 3], [7, 5], [11, 7]],
  '6': [[0, 1], [4, 3], [7, 5], [9, 6]], m6: [[0, 1], [3, 3], [7, 5], [9, 6]], '-6': [[0, 1], [3, 3], [7, 5], [9, 6]],
  '9': [[0, 1], [4, 3], [7, 5], [10, 7], [14, 9]],
  M9: [[0, 1], [4, 3], [7, 5], [11, 7], [14, 9]], maj9: [[0, 1], [4, 3], [7, 5], [11, 7], [14, 9]],
  m9: [[0, 1], [3, 3], [7, 5], [10, 7], [14, 9]], '-9': [[0, 1], [3, 3], [7, 5], [10, 7], [14, 9]],
  add9: [[0, 1], [4, 3], [7, 5], [14, 9]], madd9: [[0, 1], [3, 3], [7, 5], [14, 9]],
  sus: [[0, 1], [5, 4], [7, 5]], sus4: [[0, 1], [5, 4], [7, 5]], sus2: [[0, 1], [2, 2], [7, 5]],
  '7sus4': [[0, 1], [5, 4], [7, 5], [10, 7]],
  dim: [[0, 1], [3, 3], [6, 5]], o: [[0, 1], [3, 3], [6, 5]],
  dim7: [[0, 1], [3, 3], [6, 5], [9, 7]], o7: [[0, 1], [3, 3], [6, 5], [9, 7]],
  m7b5: [[0, 1], [3, 3], [6, 5], [10, 7]], '-7b5': [[0, 1], [3, 3], [6, 5], [10, 7]], 'ø7': [[0, 1], [3, 3], [6, 5], [10, 7]],
  aug: [[0, 1], [4, 3], [8, 5]], '+': [[0, 1], [4, 3], [8, 5]],
  '5': [[0, 1], [7, 5]]
};
const ALTERATIONS = { b5: [6, 5], '#5': [8, 5], b9: [13, 9], '#9': [15, 9], '#11': [18, 11], b13: [20, 13] };
const PATTERNS = new Set(['hold', 'alternate', 'arpeggio']);

export class ChordError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
function check(condition, message) { if (!condition) throw new ChordError(message); }
function normalized(value) { return value.trim().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/[−–]/g, '-').replace(/Δ/g, 'M'); }
function pitchFrom(root, octave, semitones, degree) {
  const index = STEPS.indexOf(root.step) + degree - 1;
  const step = STEPS[index % 7];
  const writtenOctave = octave + Math.floor(index / 7);
  const target = (octave + 1) * 12 + SEMITONES[root.step] + root.alter + semitones;
  const alter = target - ((writtenOctave + 1) * 12 + SEMITONES[step]);
  check(Math.abs(alter) <= 2 && target >= 0 && target <= 127, '코드 음높이를 악보에 표기할 수 없습니다.');
  return { step, alter, octave: writtenOctave, tieToNext: false };
}
function label(pitch) { return `${pitch.step}${pitch.alter === 1 ? '♯' : pitch.alter === -1 ? '♭' : pitch.alter === 2 ? '𝄪' : pitch.alter === -2 ? '𝄫' : ''}${pitch.octave}`; }

export function parseChord(symbol) {
  const value = normalized(symbol);
  const match = /^([A-G])([#b]?)([^/]*?)(?:\/([A-G])([#b]?))?$/i.exec(value);
  check(match, `코드 「${symbol}」를 읽을 수 없습니다.`);
  const root = { step: match[1].toUpperCase(), alter: match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0 };
  const bass = match[4] ? { step: match[4].toUpperCase(), alter: match[5] === '#' ? 1 : match[5] === 'b' ? -1 : 0 } : root;
  const suffix = match[3];
  const modifier = /\(([^()]*)\)$/.exec(suffix);
  const quality = modifier ? suffix.slice(0, modifier.index) : suffix;
  check(Object.hasOwn(QUALITIES, quality), `지원하지 않는 코드 「${symbol}」입니다. 코드를 확인해 주세요.`);
  const intervals = QUALITIES[quality].map(item => [...item]);
  if (modifier) {
    for (const token of modifier[1].split(',')) {
      const alteration = ALTERATIONS[token.trim()];
      check(alteration, `코드 「${symbol}」의 변형음을 읽을 수 없습니다.`);
      const index = intervals.findIndex(([, degree]) => degree === alteration[1]);
      if (index >= 0) intervals[index] = alteration;
      else intervals.push(alteration);
    }
  }
  const right = intervals.map(([semitones, degree]) => pitchFrom(root, 4, semitones, degree));
  const left = pitchFrom(bass, 2, 0, 1);
  return { symbol: symbol.trim(), right, left, tones: right.map(label), bass: label(left) };
}

export function parseProgression(input) {
  check(typeof input === 'string' && input.trim() && input.length <= 4000, '코드 진행을 입력해 주세요.');
  const source = input.trim().replace(/([A-G][#b]?)\s+(sus2|sus4|sus|add9)/gi, '$1$2');
  const explicitBars = /[|\n]/.test(source);
  const pieces = explicitBars ? source.split(/[|\n]/).map(part => part.trim()).filter(Boolean) : source.split(/\s+/);
  check(pieces.length >= 1 && pieces.length <= MAX_BARS, `코드는 1~${MAX_BARS}마디까지 입력할 수 있습니다.`);
  return pieces.map((piece, index) => {
    const tokens = piece.split(/\s+/).filter(Boolean);
    check(tokens.length >= 1 && tokens.length <= 4, `${index + 1}마디에는 코드 1~4개를 입력해 주세요.`);
    return tokens.map(parseChord);
  });
}

function event(pitches, beats) {
  const base = BASES[beats];
  check(base, '한 마디의 코드 길이를 표기할 수 없습니다.');
  return { kind: pitches.length ? 'note' : 'rest', pitches: pitches.map(pitch => ({ ...pitch })), base, dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 };
}
function spans(chords) { return chords.length === 1 ? [4] : chords.length === 2 ? [2, 2] : chords.length === 3 ? [1, 1, 2] : [1, 1, 1, 1]; }
function toPdfEvent(item) { const { base, ...rest } = item; return { ...rest, type: base }; }

export function buildChordArrangement({ progression, pattern = 'hold', bpm = 120, title = '코드 연주 예시' }) {
  check(PATTERNS.has(pattern), '연주 방식을 선택해 주세요.');
  check(Number.isInteger(bpm) && bpm >= 30 && bpm <= 300, 'BPM은 30~300으로 입력해 주세요.');
  check(typeof title === 'string' && title.length <= 100, '제목은 100자 이하로 입력해 주세요.');
  const bars = parseProgression(progression);
  const midiMeasures = [];
  const pdfMeasures = [];
  const summary = [];
  for (const [barIndex, chords] of bars.entries()) {
    const left = [], right = [];
    const chordLabels = [];
    let beat = 0;
    for (const [chordIndex, chord] of chords.entries()) {
      const length = spans(chords)[chordIndex];
      chordLabels.push({ eventIndex: right.length, text: normalized(chord.symbol) });
      if (pattern === 'hold') {
        left.push(event([chord.left], length));
        right.push(event(chord.right, length));
      } else if (pattern === 'alternate') {
        for (let offset = 0; offset < length; offset++) {
          const leftBeat = (beat + offset) % 2 === 0;
          left.push(event(leftBeat ? [chord.left] : [], 1));
          right.push(event(leftBeat ? [] : chord.right, 1));
        }
      } else {
        left.push(event([chord.left], length));
        for (let offset = 0; offset < length; offset++) {
          const order = [0, 1, 2, 1][offset % 4] % chord.right.length;
          right.push(event([chord.right[order]], 1));
        }
      }
      beat += length;
    }
    const number = barIndex + 1;
    midiMeasures.push({ number, numerator: 4, denominator: 4, uncertain: false, issue: '', staves: [
      { staff: 1, voices: [{ voice: 1, events: right }] },
      { staff: 2, voices: [{ voice: 1, events: left }] }
    ] });
    pdfMeasures.push({ number, numerator: 4, denominator: 4, keyFifths: 0, keyMode: 'major', ending: [], repeatStart: false, repeatEnd: false, segno: false, coda: false, toCoda: false, fine: false, jump: 'none', jumpTarget: 'end', uncertain: false, issue: '', chordLabels, parts: [
      { clef: 'G', clefLine: 2, voices: [right.map(toPdfEvent)] },
      { clef: 'F', clefLine: 4, voices: [left.map(toPdfEvent)] }
    ] });
    summary.push({ measure: number, chords: chords.map(chord => ({ symbol: chord.symbol, tones: chord.tones, bass: chord.bass })) });
  }
  return {
    midiScore: { bpm, measures: midiMeasures },
    pdfScore: { title: title.trim() || '코드 연주 예시', keyFifths: 0, keyMode: 'major', systemBars: 4, parts: [
      { name: '오른손', clef: 'G', clefLine: 2 }, { name: '왼손', clef: 'F', clefLine: 4 }
    ], measures: pdfMeasures },
    summary
  };
}

const extractionSchema = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, progression: { type: 'string' }, barsKnown: { type: 'boolean' }, warning: { type: 'string' }
}, required: ['title', 'progression', 'barsKnown', 'warning'] };

export async function extractChordChart(buffer, mime, { key = process.env.OPENAI_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw new ChordError('악보 파일을 읽으려면 서버에 OPENAI_API_KEY를 설정해 주세요. 코드는 직접 입력할 수 있습니다.', 503);
  const source = mime === 'application/pdf'
    ? { type: 'input_file', filename: 'chord-chart.pdf', file_data: `data:${mime};base64,${buffer.toString('base64')}` }
    : { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}`, detail: 'original' };
  const body = { model: process.env.OPENAI_SCORE_MODEL || 'gpt-5.6-luna', reasoning: { effort: 'high' }, store: false, max_output_tokens: 12000,
    instructions: 'Read chord symbols in musical reading order. Ignore melody notes and lyrics except to locate chord symbols. Include intro, verse and later systems; do not stop at the first line. Preserve every printed chord change, including slash bass and extensions. Use symbols like Bb, Am7, Dm7, EbM7(#11), Fsus4/C. Convert printed minus after root to minor notation m (A-7 to Am7). If a later symbol is only a slash bass such as /C, carry the preceding chord root and quality forward, e.g. Dm followed by /C becomes Dm/C. If barlines are visible, separate measures with | and put multiple chord symbols in the same measure separated by spaces, no more than four per measure. If barlines are not visible or chord-to-measure alignment is uncertain, put each chord symbol in its own measure separated by |, set barsKnown=false, and explain that timing is assumed. Do not invent chords or timing. If a symbol cannot be read, explain it in warning and leave it out rather than guessing. Return no prose outside JSON.',
    input: [{ role: 'user', content: [source, { type: 'input_text', text: 'Extract the full chord progression from this chart for a keyboard accompaniment draft.' }] }],
    text: { format: { type: 'json_schema', name: 'chord_chart', strict: true, schema: extractionSchema } } };
  let response;
  try { response = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) }); }
  catch { throw new ChordError('악보 판독 서비스에 연결하지 못했습니다.', 502); }
  if (!response.ok) throw new ChordError(response.status === 429 ? '악보 판독 요청 한도에 도달했습니다.' : `악보 판독 요청이 실패했습니다. (${response.status})`, response.status === 429 ? 503 : 502);
  const result = await response.json();
  check(result.status === 'completed', '코드 판독이 완료되지 않았습니다.');
  const output = result.output?.flatMap(item => item.type === 'message' ? item.content || [] : []).find(item => item.type === 'output_text')?.text;
  check(output, '악보에서 코드를 찾지 못했습니다.');
  let chart;
  try { chart = JSON.parse(output); } catch { throw new ChordError('코드 판독 결과를 읽을 수 없습니다.'); }
  check(typeof chart.title === 'string' && typeof chart.barsKnown === 'boolean' && typeof chart.warning === 'string', '코드 판독 결과가 올바르지 않습니다.');
  parseProgression(chart.progression);
  return chart;
}

function mimeType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  throw new ChordError('PNG, JPEG 또는 PDF 악보를 선택해 주세요.', 415);
}
function respond(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.host === request.headers.host; }
  catch { return false; }
}
async function readChart(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new ChordError('악보 파일은 8MB 이하여야 합니다.', 413);
    chunks.push(chunk);
  }
  check(size > 0, '악보 파일을 선택해 주세요.');
  return Buffer.concat(chunks);
}

export async function handleChordChart(request, response) {
  if (request.method !== 'POST') { respond(response, 405, { error: 'POST 요청만 지원합니다.' }); return; }
  if (!sameOrigin(request)) { respond(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; }
  try { const buffer = await readChart(request); respond(response, 200, await extractChordChart(buffer, mimeType(buffer))); }
  catch (error) { respond(response, error.status || 500, { error: error.status ? error.message : '악보 판독 중 서버 오류가 발생했습니다.' }); }
}

export async function handleChordArrangement(request, response) {
  if (request.method !== 'POST') { respond(response, 405, { error: 'POST 요청만 지원합니다.' }); return; }
  if (!sameOrigin(request)) { respond(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16000) throw new ChordError('코드 입력이 너무 깁니다.', 413);
      chunks.push(chunk);
    }
    let options;
    try { options = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ChordError('코드 입력 형식이 올바르지 않습니다.', 400); }
    const arrangement = buildChordArrangement(options);
    const midi = scoreToMidi(arrangement.midiScore);
    const pdf = await renderUnfoldedScore(arrangement.pdfScore);
    respond(response, 200, { midiBase64: midi.midi.toString('base64'), pdfBase64: pdf.toString('base64'), measureCount: midi.measureCount, noteCount: midi.noteCount, bpm: midi.bpm, summary: arrangement.summary });
  } catch (error) { respond(response, error.status || 500, { error: error.status ? error.message : '코드 악보 생성 중 서버 오류가 발생했습니다.' }); }
}
