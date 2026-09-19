import * as pdfLib from './pdf-lib.esm.js';
import parseMidi from './midi-parser.js';
import { searchSong } from './song-search.js';
import { arrangeChords, chordMidi } from './chord-offline.js';
import { ScoreProblem, finalizeReview, reviewScore, scoreToMidi } from './score.js';
import { unfoldPdf } from './unfold.js';
import { createMidiScorePdf, guessMidiKey, MidiScoreError, readMidiScore } from './midi-score.js';

const { PDFDocument } = pdfLib;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const scorePitchSchema = { type: 'object', additionalProperties: false, properties: {
  step: { type: 'string', enum: ['C', 'D', 'E', 'F', 'G', 'A', 'B'] }, alter: { type: 'integer' }, octave: { type: 'integer' }, tieToNext: { type: 'boolean' }
}, required: ['step', 'alter', 'octave', 'tieToNext'] };
const scoreEventSchema = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', enum: ['note', 'rest', 'unknown'] }, pitches: { type: 'array', items: scorePitchSchema },
  base: { type: 'string', enum: ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirty_second', 'sixty_fourth', 'unknown'] },
  dots: { type: 'integer' }, tupletPlayed: { type: 'integer', enum: [1, 3, 5, 6, 7] }, tupletInTimeOf: { type: 'integer', enum: [1, 2, 4] }
}, required: ['kind', 'pitches', 'base', 'dots', 'tupletPlayed', 'tupletInTimeOf'] };
const scoreSchema = { type: 'object', additionalProperties: false, properties: {
  bpm: { type: 'integer' }, measures: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    number: { type: 'integer' }, numerator: { type: 'integer' }, denominator: { type: 'integer' }, uncertain: { type: 'boolean' }, issue: { type: 'string' },
    staves: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      staff: { type: 'integer' }, voices: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        voice: { type: 'integer' }, events: { type: 'array', items: scoreEventSchema }
      }, required: ['voice', 'events'] } }
    }, required: ['staff', 'voices'] } }
  }, required: ['number', 'numerator', 'denominator', 'uncertain', 'issue', 'staves'] } }
}, required: ['bpm', 'measures'] };
const chordSchema = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, progression: { type: 'string' }, barsKnown: { type: 'boolean' }, warning: { type: 'string' }
}, required: ['title', 'progression', 'barsKnown', 'warning'] };

class ApiProblem extends Error { constructor(message, status = 422) { super(message); this.status = status; } }
function check(value, message, status) { if (!value) throw new ApiProblem(message, status); }
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } }); }
function failure(error) { return reply({ error: error?.status ? error.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, error?.status || 500); }
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
async function readBytes(request, max = MAX_FILE_BYTES) {
  const length = Number(request.headers.get('content-length'));
  check(!Number.isFinite(length) || length <= max, '파일 또는 입력이 너무 큽니다.', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  check(bytes.length > 0, '파일 또는 입력을 선택해 주세요.');
  check(bytes.length <= max, '파일 또는 입력이 너무 큽니다.', 413);
  return bytes;
}
function typeOf(bytes) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([37, 80, 68, 70, 45].every((value, index) => bytes[index] === value)) return 'application/pdf';
  throw new ApiProblem('PNG, JPEG 또는 PDF 악보 파일을 선택해 주세요.', 415);
}
function base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
function outputText(result) {
  const text = result.output?.flatMap(item => item.type === 'message' ? item.content || [] : []).find(item => item.type === 'output_text')?.text;
  check(text, 'AI 판독 결과가 비어 있습니다.');
  try { return JSON.parse(text); } catch { throw new ApiProblem('AI 판독 결과를 읽을 수 없습니다.'); }
}
function aiError(status, detail) {
  if ([401, 403].includes(status)) return new ApiProblem('OpenAI API 키 또는 모델 사용 권한을 확인해 주세요.', 502);
  if (status === 429) return new ApiProblem('AI 서비스 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 503);
  console.error('[keyroom-ai]', JSON.stringify({ status, code: detail?.error?.code, type: detail?.error?.type }));
  return new ApiProblem(`AI 판독 요청이 실패했습니다. (${status})`, 502);
}
async function aiRequest(env, path, init) {
  check(env.OPENAI_API_KEY, '사이트에 OPENAI_API_KEY 비밀 설정이 필요합니다.', 503);
  let response;
  try { response = await fetch(`https://api.openai.com/v1/responses${path}`, { ...init, headers: {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {})
  } }); }
  catch { throw new ApiProblem('AI 서비스에 연결하지 못했습니다.', 502); }
  if (!response.ok) throw aiError(response.status, await response.json().catch(() => ({})));
  return response.json();
}
async function completeAI(env, body, deadlineMs = 180000) {
  let result = await aiRequest(env, '', { method: 'POST', body: JSON.stringify({ ...body, background: true, store: false }) });
  const deadline = Date.now() + deadlineMs;
  while (['queued', 'in_progress'].includes(result.status)) {
    check(Date.now() < deadline, 'AI 판독 시간이 초과되었습니다. 다시 시도해 주세요.', 504);
    await new Promise(resolve => setTimeout(resolve, 4000));
    result = await aiRequest(env, `/${encodeURIComponent(result.id)}`, { method: 'GET' });
  }
  check(result.status === 'completed', result.status === 'incomplete' ? 'AI 판독 결과가 길이 제한에 걸렸습니다. 악보를 나누어 올려 주세요.' : 'AI 판독이 완료되지 않았습니다.');
  return outputText(result);
}
async function jobToken(id, key) {
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(id)));
  return `${id}.${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
async function verifiedJob(token, key) {
  const match = /^(resp_[A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(token || '');
  check(match, '판독 작업을 찾지 못했습니다.', 404);
  check(await jobToken(match[1], key) === token, '판독 작업을 찾지 못했습니다.', 404);
  return match[1];
}
async function scoreStart(request, env) {
  check(request.method === 'POST', 'POST 요청만 지원합니다.', 405);
  const bytes = await readBytes(request), mime = typeOf(bytes);
  if (mime === 'application/pdf') {
    let pdf;
    try { pdf = await PDFDocument.load(bytes); } catch { throw new ApiProblem('PDF 악보를 읽을 수 없습니다.'); }
    check(pdf.getPageCount() <= 12, '사이트에서 PDF 악보는 12페이지 이하로 나누어 올려 주세요.');
  }
  const source = mime === 'application/pdf'
    ? { type: 'input_file', filename: 'score.pdf', file_data: `data:${mime};base64,${base64(bytes)}`, detail: 'high' }
    : { type: 'input_image', image_url: `data:${mime};base64,${base64(bytes)}`, detail: 'original' };
  const body = { model: env.OPENAI_SCORE_TO_MIDI_MODEL || 'gpt-6-astra', reasoning: { effort: 'high' }, max_output_tokens: 48000,
    instructions: 'Transcribe every written measure of this piano score in reading order into the given JSON schema. Staff 1 is the upper/right-hand staff and staff 2 is the lower/left-hand staff. Do not omit blank staves or measures. Apply clefs, key signatures and local accidentals to pitch spelling. Read noteheads, beams, flags, dots, rests, tuplets, independent voices and ties from the notation, not from horizontal spacing. Use tupletPlayed=1 and tupletInTimeOf=1 for ordinary notes. Each voice must fill its meter exactly. Set measures.number to consecutive values beginning at 1. Use the printed tempo as bpm, or 120 if absent and mark the first measure uncertain with an issue explaining the assumed tempo. Never invent missing notes or rests to force a rhythm sum. If anything is unclear, use kind=unknown/base=unknown where necessary, set uncertain=true and describe the location in issue. Do not silently guess. Do not expand repeat signs; mark them uncertain for manual checking. Return only the schema.',
    input: [{ role: 'user', content: [source, { type: 'input_text', text: 'Read the entire score and return all measures, both hands, pitches, rhythms and uncertainty flags. Do not skip later systems or pages.' }] }],
    text: { format: { type: 'json_schema', name: 'score_transcription', strict: true, schema: scoreSchema } } };
  const result = await aiRequest(env, '', { method: 'POST', body: JSON.stringify({ ...body, background: true, store: false }) });
  check(result.id && /^resp_[A-Za-z0-9_-]+$/.test(result.id), 'AI 판독 작업을 시작하지 못했습니다.', 502);
  return reply({ jobId: await jobToken(result.id, env.OPENAI_API_KEY), status: 'running' }, 202);
}
async function scoreStatus(request, env) {
  check(request.method === 'GET', 'GET 요청만 지원합니다.', 405);
  check(env.OPENAI_API_KEY, '사이트에 OPENAI_API_KEY 비밀 설정이 필요합니다.', 503);
  const id = await verifiedJob(new URL(request.url).searchParams.get('id'), env.OPENAI_API_KEY);
  const result = await aiRequest(env, `/${encodeURIComponent(id)}`, { method: 'GET' });
  if (['queued', 'in_progress'].includes(result.status)) return reply({ status: 'running', progress: { phase: 'transcribe' } }, 202);
  check(result.status === 'completed', result.status === 'incomplete' ? 'AI 출력 한도에 도달했습니다. 악보를 더 작은 파일로 나누어 주세요.' : 'AI 판독이 완료되지 않았습니다.', 502);
  const { draft, review } = reviewScore(outputText(result));
  return reply(review.length ? { status: 'completed', reviewRequired: true, draft, review } : { status: 'completed', ...scoreToMidi(draft) });
}
async function scoreReview(request) {
  check(request.method === 'POST', 'POST 요청만 지원합니다.', 405);
  const body = JSON.parse(new TextDecoder().decode(await readBytes(request, 4 * 1024 * 1024)));
  return reply(finalizeReview(body));
}
function reviewChords(progression) {
  check(typeof progression === 'string' && progression.trim() && progression.length <= 4000, '코드 진행을 읽을 수 없습니다.');
  const bars = progression.trim().split(/[|\n]/).map(value => value.trim()).filter(Boolean);
  check(bars.length <= 100, '코드 악보는 100마디 이하로 나누어 올려 주세요.');
  let unknownCount = 0;
  return { progression: bars.map(bar => bar.split(/\s+/).map(symbol => {
    try {
      if (symbol === '?') throw Error();
      arrangeChords({ progression: symbol, bpm: 120 });
      return symbol;
    } catch { unknownCount++; return '?'; }
  }).join(' ')).join(' | '), unknownCount };
}
async function chordChart(request, env) {
  check(request.method === 'POST', 'POST 요청만 지원합니다.', 405);
  const bytes = await readBytes(request), mime = typeOf(bytes);
  const source = mime === 'application/pdf' ? { type: 'input_file', filename: 'chord-chart.pdf', file_data: `data:${mime};base64,${base64(bytes)}` }
    : { type: 'input_image', image_url: `data:${mime};base64,${base64(bytes)}`, detail: 'original' };
  const chart = await completeAI(env, { model: env.OPENAI_SCORE_MODEL || 'gpt-5.6-luna', reasoning: { effort: 'high' }, max_output_tokens: 12000,
    instructions: 'Read every printed chord symbol in musical reading order across the entire image or PDF. Ignore melody and lyrics except for alignment. Preserve slash bass and extensions. If barlines are visible, separate measures with | and place up to four chords in each measure. Otherwise put each chord in its own measure separated by |, set barsKnown=false and explain that timing is assumed. Replace every illegible or ambiguous chord with ? in its original position. Do not guess, omit later systems, or invent chords.',
    input: [{ role: 'user', content: [source, { type: 'input_text', text: 'Extract the full chord progression for a keyboard accompaniment draft.' }] }],
    text: { format: { type: 'json_schema', name: 'chord_chart', strict: true, schema: chordSchema } } });
  check(typeof chart.title === 'string' && typeof chart.warning === 'string' && typeof chart.barsKnown === 'boolean', '코드 판독 결과가 올바르지 않습니다.');
  const reviewed = reviewChords(chart.progression);
  return reply({ ...chart, ...reviewed, warning: [chart.warning, reviewed.unknownCount ? `확인 필요한 코드 ${reviewed.unknownCount}곳을 ?로 표시했습니다.` : ''].filter(Boolean).join(' ') });
}
async function chordArrangement(request) {
  check(request.method === 'POST', 'POST 요청만 지원합니다.', 405);
  const options = JSON.parse(new TextDecoder().decode(await readBytes(request, 16000)));
  let bars;
  try { bars = arrangeChords(options); }
  catch (error) { throw new ApiProblem(error?.message || '코드 입력을 확인해 주세요.'); }
  const midi = chordMidi(bars, options.bpm);
  return reply({ ...midi, scoreRenderer: 'verovio', measureCount: bars.length, bpm: options.bpm,
    summary: bars.map(bar => ({ measure: bar.number, chords: bar.chords })) });
}
async function songSearch(request, env) {
  check(request.method === 'POST', 'POST 요청만 지원합니다.', 405);
  check(env.OPENAI_API_KEY, '사이트에 OPENAI_API_KEY 비밀 설정이 필요합니다.', 503);
  const body = JSON.parse(new TextDecoder().decode(await readBytes(request, 1024)));
  check(typeof body?.query === 'string' && body.query.length <= 160, '곡명은 160자 이하로 입력해 주세요.', 400);
  return reply(await searchSong(body.query, { key: env.OPENAI_API_KEY }));
}
async function unfold(request, env) {
  check(request.method === 'POST', 'POST 요청만 지원합니다.', 405);
  const bytes = await readBytes(request);
  let result;
  if ([77, 84, 104, 100].every((value, index) => bytes[index] === value)) {
    let filename;
    try { filename = decodeURIComponent(request.headers.get('x-score-filename') || 'MIDI Score.mid').slice(0, 300); }
    catch { throw new ApiProblem('MIDI 파일명을 읽을 수 없습니다.', 400); }
    const midi = readMidiScore(bytes, parseMidi);
    let key = guessMidiKey(midi);
    if (!midi.keySignature && env.OPENAI_API_KEY) {
      const histogram = Array(12).fill(0);
      for (const track of midi.tracks) for (const note of track.notes) histogram[note.pitch % 12] += Math.min(note.end - note.start, 4);
      try {
        const inferred = await completeAI(env, {
          model: env.OPENAI_SCORE_MODEL || 'gpt-5.6-luna', reasoning: { effort: 'medium' }, max_output_tokens: 1000,
          instructions: 'Infer the most defensible notated key signature for this MIDI pitch-class duration profile. Do not force C major. Return only the requested JSON schema.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ filename: filename.slice(0, 100), histogram: histogram.map(value => Math.round(value * 10) / 10), meter: midi.meter, guessedKey: key }) }] }],
          text: { format: { type: 'json_schema', name: 'midi_key', strict: true, schema: { type: 'object', additionalProperties: false, properties: { fifths: { type: 'integer' }, mode: { type: 'string', enum: ['major', 'minor'] } }, required: ['fifths', 'mode'] } } }
        }, 90000);
        if (Number.isInteger(inferred.fifths) && Math.abs(inferred.fifths) <= 7 && ['major', 'minor'].includes(inferred.mode)) key = inferred;
      } catch (error) { console.error('[midi-key-inference]', error?.status || error?.name || 'unknown'); }
    }
    result = await createMidiScorePdf(midi, filename, key, pdfLib);
  } else {
    check(typeOf(bytes) === 'application/pdf', 'PDF 악보 또는 MIDI 파일을 선택해 주세요.', 415);
    result = await unfoldPdf(bytes, body => completeAI(env, body, 12 * 60 * 1000), PDFDocument);
  }
  return new Response(result.pdf, { status: 200, headers: { ...headers, 'Content-Type': 'application/pdf', 'X-Source-Measures': String(result.sourceMeasures), 'X-Output-Measures': String(result.outputMeasures), ...(result.keyFifths === undefined ? {} : { 'X-Key-Fifths': String(result.keyFifths), 'X-Key-Mode': result.keyMode }) } });
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') return reply({ status: 'ok', mode: 'sites', scoreApi: true, chordArrangementApi: true, songSearchApi: true, unfoldScoreApi: true, midiScoreApi: true, apiKeyConfigured: !!env.OPENAI_API_KEY });
    if (!pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (!sameOrigin(request)) return reply({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }, 403);
    try {
      if (pathname === '/api/score-to-midi') return await scoreStart(request, env);
      if (pathname === '/api/score-to-midi/status') return await scoreStatus(request, env);
      if (pathname === '/api/score-to-midi/review') return await scoreReview(request);
      if (pathname === '/api/chord-chart') return await chordChart(request, env);
      if (pathname === '/api/chord-arrangement') return await chordArrangement(request);
      if (pathname === '/api/song-search') return await songSearch(request, env);
      if (pathname === '/api/unfold-score') return await unfold(request, env);
      return reply({ error: '요청한 기능을 찾지 못했습니다.' }, 404);
    } catch (error) {
      if (!(error instanceof ApiProblem) && !(error instanceof ScoreProblem) && !(error instanceof MidiScoreError) && error?.status == null) console.error('[keyroom-api]', error?.name || 'UnknownError');
      return failure(error);
    }
  }
};
