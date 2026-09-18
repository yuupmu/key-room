import { parseMidi } from 'midi-file';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notationFont = require.resolve('@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff');

const MODEL = 'gpt-5.6-luna';
const LIMIT = 8 * 1024 * 1024;
const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TYPES = { whole: 4, half: 2, quarter: 1, eighth: .5, sixteenth: .25, thirty_second: .125 };
const pitch = { type: 'object', additionalProperties: false, properties: { step: { type: 'string', enum: Object.keys(STEPS) }, alter: { type: 'integer' }, octave: { type: 'integer' }, tieToNext: { type: 'boolean' } }, required: ['step', 'alter', 'octave', 'tieToNext'] };
const event = { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['note', 'rest'] }, pitches: { type: 'array', items: pitch }, type: { type: 'string', enum: Object.keys(TYPES) }, dots: { type: 'integer' }, tupletPlayed: { type: 'integer' }, tupletInTimeOf: { type: 'integer' } }, required: ['kind', 'pitches', 'type', 'dots', 'tupletPlayed', 'tupletInTimeOf'] };
const measure = { type: 'object', additionalProperties: false, properties: {
  number: { type: 'integer' }, numerator: { type: 'integer' }, denominator: { type: 'integer' }, keyFifths: { type: 'integer' }, keyMode: { type: 'string', enum: ['major', 'minor'] },
  ending: { type: 'array', items: { type: 'integer' } }, repeatStart: { type: 'boolean' }, repeatEnd: { type: 'boolean' },
  segno: { type: 'boolean' }, coda: { type: 'boolean' }, toCoda: { type: 'boolean' }, fine: { type: 'boolean' },
  jump: { type: 'string', enum: ['none', 'dc', 'ds'] }, jumpTarget: { type: 'string', enum: ['end', 'fine', 'coda'] },
  uncertain: { type: 'boolean' }, issue: { type: 'string' },
  parts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { clef: { type: 'string', enum: ['G', 'F', 'C'] }, clefLine: { type: 'integer' }, voices: { type: 'array', items: { type: 'array', items: event } } }, required: ['clef', 'clefLine', 'voices'] } }
}, required: ['number', 'numerator', 'denominator', 'keyFifths', 'keyMode', 'ending', 'repeatStart', 'repeatEnd', 'segno', 'coda', 'toCoda', 'fine', 'jump', 'jumpTarget', 'uncertain', 'issue', 'parts'] };
const schema = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, keyFifths: { type: 'integer' }, keyMode: { type: 'string', enum: ['major', 'minor'] },
  parts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, clef: { type: 'string', enum: ['G', 'F', 'C'] }, clefLine: { type: 'integer' } }, required: ['name', 'clef', 'clefLine'] } },
  measures: { type: 'array', items: measure }
}, required: ['title', 'keyFifths', 'keyMode', 'parts', 'measures'] };
const keySchema = { type: 'object', additionalProperties: false, properties: { fifths: { type: 'integer' }, mode: { type: 'string', enum: ['major', 'minor'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['fifths', 'mode', 'confidence'] };

export class UnfoldError extends Error { constructor(message, status = 422) { super(message); this.status = status; } }
function check(value, message) { if (!value) throw new UnfoldError(message); }
function xml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]); }
function duration(event) { return TYPES[event.type] * (event.dots === 0 ? 1 : event.dots === 1 ? 1.5 : event.dots === 2 ? 1.75 : NaN) * event.tupletInTimeOf / event.tupletPlayed; }

export function validateScore(score) {
  check(score && Number.isInteger(score.keyFifths) && Math.abs(score.keyFifths) <= 7 && ['major', 'minor'].includes(score.keyMode), '악보의 조성을 확인할 수 없습니다.');
  check(typeof score.title === 'string' && score.title.length <= 200, '악보 제목을 확인할 수 없습니다.');
  check(Array.isArray(score.parts) && score.parts.length >= 1 && score.parts.length <= 8, '오선 수를 확인할 수 없습니다.');
  check(Array.isArray(score.measures) && score.measures.length >= 1 && score.measures.length <= 120, '마디 수를 확인할 수 없습니다.');
  for (const [i, part] of score.parts.entries()) check(part && typeof part.name === 'string' && part.name.length <= 80 && ['G', 'F', 'C'].includes(part.clef) && Number.isInteger(part.clefLine) && part.clefLine >= 1 && part.clefLine <= 5, `${i + 1}번째 오선의 음자리표를 확인할 수 없습니다.`);
  let nav = { segno: 0, coda: 0, jumps: 0 };
  for (const [i, bar] of score.measures.entries()) {
    const label = `${i + 1}마디`;
    check(bar?.number === i + 1 && bar.uncertain === false && bar.issue === '', `${label} 판독이 불확실합니다${bar?.issue ? `: ${bar.issue}` : '.'}`);
    check(Number.isInteger(bar.numerator) && bar.numerator >= 1 && bar.numerator <= 32 && [1, 2, 4, 8, 16].includes(bar.denominator), `${label} 박자표가 잘못되었습니다.`);
    check(Number.isInteger(bar.keyFifths) && Math.abs(bar.keyFifths) <= 7 && ['major', 'minor'].includes(bar.keyMode), `${label} 조표를 확인할 수 없습니다.`);
    if (i === 0) check(bar.keyFifths === score.keyFifths && bar.keyMode === score.keyMode, '첫 마디 조표가 악보 조성과 맞지 않습니다.');
    check(Array.isArray(bar.ending) && bar.ending.every(n => n === 1 || n === 2) && bar.ending.length <= 2, `${label} 엔딩 번호를 확인할 수 없습니다.`);
    check(['repeatStart', 'repeatEnd', 'segno', 'coda', 'toCoda', 'fine'].every(name => typeof bar[name] === 'boolean'), `${label} 반복·이동 표식을 확인할 수 없습니다.`);
    check(['none', 'dc', 'ds'].includes(bar.jump) && ['end', 'fine', 'coda'].includes(bar.jumpTarget), `${label} 이동 지시를 확인할 수 없습니다.`);
    nav.segno += Number(bar.segno); nav.coda += Number(bar.coda); nav.jumps += Number(bar.jump !== 'none');
    check(Array.isArray(bar.parts) && bar.parts.length === score.parts.length, `${label} 오선 일부가 누락되었습니다.`);
    if (bar.chordLabels !== undefined) check(Array.isArray(bar.chordLabels) && bar.chordLabels.every(item => Number.isInteger(item.eventIndex) && item.eventIndex >= 0 && item.eventIndex < bar.parts[0]?.voices?.[0]?.length && typeof item.text === 'string' && item.text.length <= 40), `${label} 코드 기호가 잘못되었습니다.`);
    for (const [p, part] of bar.parts.entries()) {
      check(['G', 'F', 'C'].includes(part.clef) && Number.isInteger(part.clefLine) && part.clefLine >= 1 && part.clefLine <= 5, `${label} 음자리표를 확인할 수 없습니다.`);
      if (i === 0) check(part.clef === score.parts[p].clef && part.clefLine === score.parts[p].clefLine, '첫 마디 음자리표가 오선 설정과 맞지 않습니다.');
      check(Array.isArray(part.voices) && part.voices.length >= 1 && part.voices.length <= 4, `${label} ${p + 1}번째 오선의 성부를 확인할 수 없습니다.`);
      for (const voice of part.voices) {
        check(Array.isArray(voice) && voice.length <= 64, `${label} 음표가 너무 많습니다.`);
        let sum = 0;
        for (const note of voice) {
          check(note && ['note', 'rest'].includes(note.kind) && Object.hasOwn(TYPES, note.type) && [0, 1, 2].includes(note.dots) && [[1, 1], [3, 2], [5, 4], [6, 4], [7, 4]].some(([a, b]) => note.tupletPlayed === a && note.tupletInTimeOf === b), `${label} 음표 길이를 확인할 수 없습니다.`);
          check(Array.isArray(note.pitches) && (note.kind === 'rest' ? note.pitches.length === 0 : note.pitches.length >= 1 && note.pitches.length <= 12), `${label} 음표 또는 쉼표가 잘못되었습니다.`);
          for (const tone of note.pitches) check(Object.hasOwn(STEPS, tone.step) && Number.isInteger(tone.alter) && Math.abs(tone.alter) <= 2 && Number.isInteger(tone.octave) && tone.octave >= 0 && tone.octave <= 9 && typeof tone.tieToNext === 'boolean', `${label} 음높이를 확인할 수 없습니다.`);
          sum += duration(note);
        }
        check(Math.abs(sum - bar.numerator * 4 / bar.denominator) < 1e-7, `${label} 음표 길이 합계가 박자표와 맞지 않습니다.`);
      }
    }
  }
  check(nav.segno <= 1 && nav.coda <= 1 && nav.jumps <= 1, '여러 개의 세뇨·코다·D.S./D.C.는 자동으로 확정할 수 없습니다.');
  const jump = score.measures.find(m => m.jump !== 'none');
  check(!jump || jump.jump !== 'ds' || nav.segno === 1, 'D.S.의 세뇨 위치를 찾지 못했습니다.');
  check(!jump || jump.jumpTarget !== 'coda' || nav.coda === 1, '코다 위치를 찾지 못했습니다.');
  return score;
}

export function unfoldMeasures(score) {
  validateScore(score);
  const bars = score.measures;
  const segno = bars.findIndex(m => m.segno);
  const coda = bars.findIndex(m => m.coda);
  const jumpBar = bars.find(m => m.jump !== 'none');
  const order = [];
  const repeated = new Set();
  let i = 0, repeatStart = 0, repeatPass = 1, jumped = false, codaTaken = false;
  const seen = new Set();
  while (i < bars.length) {
    check(order.length < 500, '반복 구간이 너무 길거나 끝나지 않습니다.');
    const state = `${i}:${repeatStart}:${repeatPass}:${[...repeated].join(',')}:${jumped}:${codaTaken}`;
    check(!seen.has(state), '악보의 이동 지시가 순환합니다.');
    seen.add(state);
    const bar = bars[i];
    if (!jumped && bar.repeatStart && i !== repeatStart) { repeatStart = i; repeatPass = 1; }
    if (bar.ending.length && !bar.ending.includes(repeatPass)) { i++; continue; }
    order.push(i);
    if (jumped && jumpBar?.jumpTarget === 'fine' && bar.fine) break;
    if (jumped && jumpBar?.jumpTarget === 'coda' && bar.toCoda && !codaTaken) { check(coda > i, '코다 위치가 To Coda보다 앞에 있습니다.'); i = coda; codaTaken = true; continue; }
    if (!jumped && bar.repeatEnd && !repeated.has(i)) { repeated.add(i); repeatPass = 2; i = repeatStart; continue; }
    if (!jumped && bar.jump !== 'none') { jumped = true; repeatPass = 2; i = bar.jump === 'dc' ? 0 : segno; continue; }
    i++;
  }
  check(!jumpBar || jumped, 'D.S./D.C. 위치에 도달하지 못했습니다.');
  check(!jumpBar || jumpBar.jumpTarget !== 'coda' || codaTaken, 'To Coda 위치를 찾지 못했습니다.');
  check(!jumpBar || jumpBar.jumpTarget !== 'fine' || bars[order.at(-1)]?.fine, 'Fine 위치를 찾지 못했습니다.');
  return order;
}

async function respondAI(body, key, fetchImpl = fetch) {
  if (!key) throw new UnfoldError('서버에 OPENAI_API_KEY를 설정해 주세요.', 503);
  let response;
  try { response = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) }); }
  catch { throw new UnfoldError('AI 서비스에 연결하지 못했습니다.', 502); }
  if (!response.ok) throw new UnfoldError(response.status === 429 ? 'AI 서비스 요청 한도에 도달했습니다.' : `AI 판독 요청이 실패했습니다. (${response.status})`, response.status === 429 ? 503 : 502);
  const result = await response.json();
  check(result.status === 'completed', 'AI 판독이 완료되지 않았습니다.');
  const output = result.output?.flatMap(item => item.type === 'message' ? item.content || [] : []).find(item => item.type === 'output_text')?.text;
  check(output, 'AI가 악보 데이터를 반환하지 않았습니다.');
  try { return JSON.parse(output); } catch { throw new UnfoldError('AI 악보 데이터를 읽을 수 없습니다.'); }
}

export async function transcribeUnfoldScore(buffer, { key = process.env.OPENAI_API_KEY, fetchImpl = fetch } = {}) {
  const body = { model: MODEL, reasoning: { effort: 'high' }, store: false, max_output_tokens: 32000,
    instructions: 'Read the entire PDF score and return every written measure, staff, voice, pitch, rest, tie, clef, key signature and meter. Preserve the printed key signature (fifths and major/minor mode), carrying it into every measure until any printed key change. Carry each clef into the next measure until a clef change. Transcribe in written order, including first and second endings. Mark repeat starts/ends, segno, coda, To Coda, Fine, D.C. and D.S. precisely. For D.C./D.S. use jumpTarget fine or coda when marked al Fine/al Coda, otherwise end. Give each measure number sequentially from 1. Each voice must fill its bar; include explicit rests. Use concert pitch. Mark any unreadable or ambiguous notation uncertain with issue instead of guessing. Do not expand the repeats yourself. Values of pitch alter must reflect key and local accidentals. Ordinary notes have tupletPlayed=1 and tupletInTimeOf=1.',
    input: [{ role: 'user', content: [{ type: 'input_file', filename: 'score.pdf', file_data: `data:application/pdf;base64,${buffer.toString('base64')}` }, { type: 'input_text', text: 'Transcribe this score with all navigation and exact notes for deterministic unfolding.' }] }],
    text: { format: { type: 'json_schema', name: 'navigable_score', strict: true, schema } } };
  return validateScore(await respondAI(body, key, fetchImpl));
}

const DIVISIONS = 10080;
const keyOrder = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const flatOrder = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
function keyAlter(step, fifths) { return fifths > 0 ? Number(keyOrder.slice(0, fifths).includes(step)) : fifths < 0 ? -Number(flatOrder.slice(0, -fifths).includes(step)) : 0; }
function noteNumber(tone) { return (tone.octave + 1) * 12 + STEPS[tone.step] + tone.alter; }
function spell(number, fifths) {
  const matches = [];
  for (const step of Object.keys(STEPS)) for (let alter = -2; alter <= 2; alter++) {
    const octave = (number - STEPS[step] - alter) / 12 - 1;
    if (Number.isInteger(octave) && octave >= 0 && octave <= 9) matches.push({ step, alter, octave, cost: Math.abs(alter - keyAlter(step, fifths)) * 4 + Math.abs(alter) + (fifths < 0 ? Math.max(0, alter) : Math.max(0, -alter)) });
  }
  check(matches.length, 'MIDI 음높이를 악보에 표시할 수 없습니다.');
  return matches.sort((a, b) => a.cost - b.cost)[0];
}
function pitchXml(tone) { return `<pitch><step>${tone.step}</step>${tone.alter ? `<alter>${tone.alter}</alter>` : ''}<octave>${tone.octave}</octave></pitch>`; }
function eventXml(event, voice, tieStops = [], tupletStart = false, tupletStop = false, accidentals = []) {
  const durationValue = Math.round(duration(event) * DIVISIONS);
  check(Number.isInteger(durationValue) && durationValue > 0, '악보 음표 길이를 조판할 수 없습니다.');
  const timing = `<voice>${voice}</voice><type>${event.type.replace('_', '-')}</type>${'<dot/>'.repeat(event.dots)}`;
  const modification = event.tupletPlayed !== 1 ? `<time-modification><actual-notes>${event.tupletPlayed}</actual-notes><normal-notes>${event.tupletInTimeOf}</normal-notes></time-modification>` : '';
  if (event.kind === 'rest') {
    const markings = `${tupletStart ? '<tuplet type="start" number="1" bracket="no" show-number="actual"/>' : ''}${tupletStop ? '<tuplet type="stop" number="1"/>' : ''}`;
    return `<note><rest/><duration>${durationValue}</duration>${timing}${modification}${markings ? `<notations>${markings}</notations>` : ''}</note>`;
  }
  return event.pitches.map((tone, index) => {
    const stop = tieStops[index];
    const ties = `${stop ? '<tie type="stop"/>' : ''}${tone.tieToNext ? '<tie type="start"/>' : ''}`;
    const markings = `${stop ? '<tied type="stop"/>' : ''}${tone.tieToNext ? '<tied type="start"/>' : ''}${index === 0 && tupletStart ? '<tuplet type="start" number="1" bracket="no" show-number="actual"/>' : ''}${index === 0 && tupletStop ? '<tuplet type="stop" number="1"/>' : ''}`;
    const notation = markings ? `<notations>${markings}</notations>` : '';
    return `<note>${index ? '<chord/>' : ''}${pitchXml(tone)}<duration>${durationValue}</duration>${ties}${timing}${accidentals[index] ? `<accidental>${accidentals[index]}</accidental>` : ''}${modification}${notation}</note>`;
  }).join('');
}
function tupletMarks(events) {
  const marks = new Map();
  for (let i = 0; i < events.length;) {
    const first = events[i];
    if (first.tupletPlayed === 1) { i++; continue; }
    let last = i;
    while (last + 1 < events.length && last - i + 1 < first.tupletPlayed && events[last + 1].tupletPlayed === first.tupletPlayed && events[last + 1].tupletInTimeOf === first.tupletInTimeOf) last++;
    marks.set(i, { ...marks.get(i), start: true });
    marks.set(last, { ...marks.get(last), stop: true });
    i = last + 1;
  }
  return marks;
}
function scoreXml(score, order) {
  const parts = score.parts.map((part, i) => `<score-part id="P${i + 1}"><part-name>${xml(part.name || `Part ${i + 1}`)}</part-name></score-part>`).join('');
  const rendered = score.parts.map((part, partIndex) => {
    let previousMeter = '', previousKey = '', previousClef = '', pending = new Map();
    const measures = order.map((sourceIndex, outputIndex) => {
      const bar = score.measures[sourceIndex];
      const meter = `${bar.numerator}/${bar.denominator}`;
      const key = `${bar.keyFifths}/${bar.keyMode}`;
      const staff = bar.parts[partIndex];
      const clef = `${staff.clef}/${staff.clefLine}`;
      const attributes = outputIndex === 0 || previousMeter !== meter || previousKey !== key || previousClef !== clef ? `<attributes><divisions>${DIVISIONS}</divisions>${previousKey !== key ? `<key><fifths>${bar.keyFifths}</fifths><mode>${bar.keyMode}</mode></key>` : ''}${previousMeter !== meter ? `<time><beats>${bar.numerator}</beats><beat-type>${bar.denominator}</beat-type></time>` : ''}${previousClef !== clef ? `<clef><sign>${staff.clef}</sign><line>${staff.clefLine}</line></clef>` : ''}</attributes>` : '';
      previousMeter = meter;
      previousKey = key;
      previousClef = clef;
      const voiceXml = staff.voices.map((events, voiceIndex) => {
        let content = '';
        const marks = tupletMarks(events);
        const localAccidentals = new Map();
        for (const [eventIndex, event] of events.entries()) {
          if (partIndex === 0 && voiceIndex === 0) for (const chord of bar.chordLabels || []) if (chord.eventIndex === eventIndex) content += `<direction placement="above"><direction-type><words font-size="8" font-weight="bold">${xml(chord.text)}</words></direction-type></direction>`;
          const current = pending.get(voiceIndex) || new Set();
          const stops = event.kind === 'note' ? event.pitches.map(tone => current.has(noteNumber(tone))) : [];
          check(!current.size || event.kind === 'note' && stops.filter(Boolean).length === current.size, '붙임줄이 펼친 악보에서 이어지지 않습니다.');
          pending.delete(voiceIndex);
          const accidentals = event.pitches.map((tone, index) => {
            const id = `${tone.step}:${tone.octave}`;
            const previous = localAccidentals.has(id) ? localAccidentals.get(id) : keyAlter(tone.step, bar.keyFifths);
            if (stops[index]) return '';
            localAccidentals.set(id, tone.alter);
            return tone.alter === previous ? '' : ({ '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' })[tone.alter];
          });
          content += eventXml(event, voiceIndex + 1, stops, !!marks.get(eventIndex)?.start, !!marks.get(eventIndex)?.stop, accidentals);
          const next = event.pitches.filter(tone => tone.tieToNext).map(noteNumber);
          if (next.length) pending.set(voiceIndex, new Set(next));
        }
        return `${voiceIndex ? `<backup><duration>${bar.numerator * 4 / bar.denominator * DIVISIONS}</duration></backup>` : ''}${content}`;
      }).join('');
      const systemBreak = score.systemBars && outputIndex > 0 && outputIndex % score.systemBars === 0 ? '<print new-system="yes"/>' : '';
      return `<measure number="${outputIndex + 1}">${systemBreak}${attributes}${voiceXml}</measure>`;
    }).join('');
    check(pending.size === 0, '마지막 마디의 붙임줄이 끝나지 않습니다.');
    return `<part id="P${partIndex + 1}">${measures}</part>`;
  }).join('');
  return `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE score-partwise  PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise version="4.0"><work><work-title>${xml(score.title || '펼친 악보')}</work-title></work><movement-title>${xml(score.title || '펼친 악보')}</movement-title><identification><creator type="software">Keyroom</creator></identification><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults><part-list>${parts}</part-list>${rendered}</score-partwise>`;
}

const noteValues = [
  { ticks: 60480, type: 'whole', dots: 1 }, { ticks: 30240, type: 'half', dots: 1 },
  { ticks: 40320, type: 'whole', dots: 0 }, { ticks: 20160, type: 'half', dots: 0 },
  { ticks: 15120, type: 'quarter', dots: 1 }, { ticks: 10080, type: 'quarter', dots: 0 },
  { ticks: 7560, type: 'eighth', dots: 1 }, { ticks: 5040, type: 'eighth', dots: 0 },
  { ticks: 2520, type: 'sixteenth', dots: 0 },
  { ticks: 6720, type: 'quarter', dots: 0, tupletPlayed: 3, tupletInTimeOf: 2 },
  { ticks: 3360, type: 'eighth', dots: 0, tupletPlayed: 3, tupletInTimeOf: 2 },
  { ticks: 1680, type: 'sixteenth', dots: 0, tupletPlayed: 3, tupletInTimeOf: 2 },
  { ticks: 840, type: 'thirty_second', dots: 0, tupletPlayed: 3, tupletInTimeOf: 2 }
].sort((a, b) => b.ticks - a.ticks);
function chunks(ticks) {
  check(ticks >= 0 && ticks % 840 === 0, 'MIDI 음표 길이를 표현할 수 없습니다.');
  const answer = [];
  while (ticks) { const item = noteValues.find(value => value.ticks <= ticks); check(item, '음표 길이를 표현할 수 없습니다.'); answer.push(item); ticks -= item.ticks; }
  return answer;
}
function midiData(buffer) {
  let midi;
  try { midi = parseMidi(buffer); } catch { throw new UnfoldError('MIDI 파일을 읽을 수 없습니다.', 415); }
  check([0, 1].includes(midi.header.format) && midi.header.ticksPerBeat, '지원하지 않는 MIDI 시간 형식입니다.');
  const tpb = midi.header.ticksPerBeat;
  const tracks = [];
  const meta = { signatures: [], meters: [] };
  for (const [trackIndex, track] of midi.tracks.entries()) {
    let tick = 0, name = `Track ${trackIndex + 1}`;
    const active = new Map(), notes = [];
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type === 'trackName' && event.text) name = event.text.slice(0, 80);
      if (event.type === 'keySignature') meta.signatures.push({ ...event, tick });
      if (event.type === 'timeSignature') meta.meters.push({ ...event, tick });
      if (event.channel === 9) continue;
      const id = `${event.channel}:${event.noteNumber}`;
      if (event.type === 'noteOn' && event.velocity > 0) { const stack = active.get(id) || []; stack.push(tick); active.set(id, stack); }
      if (event.type === 'noteOff' || event.type === 'noteOn' && event.velocity === 0) {
        const stack = active.get(id);
        if (stack?.length) { const start = stack.shift(); if (tick > start) notes.push({ start, end: tick, pitch: event.noteNumber }); }
      }
    }
    if (notes.length) tracks.push({ name, notes });
  }
  if (tracks.length === 1) {
    const low = tracks[0].notes.filter(n => n.pitch < 60), high = tracks[0].notes.filter(n => n.pitch >= 60);
    if (low.length >= 4 && high.length >= 4 && Math.min(low.length, high.length) / tracks[0].notes.length >= .2) {
      const sourceName = tracks[0].name;
      tracks.splice(0, 1, { name: `${sourceName} 오른손`, notes: high }, { name: `${sourceName} 왼손`, notes: low });
    }
  }
  check(tracks.length > 0 && tracks.length <= 8, 'MIDI는 음표가 있는 트랙 1~8개를 지원합니다.');
  check(tracks.reduce((total, track) => total + track.notes.length, 0) <= 15000, 'MIDI 음표가 너무 많습니다.');
  const meters = meta.meters.filter(m => m.tick === 0);
  const meter = meters.at(-1) || { numerator: 4, denominator: 4 };
  check(!meta.meters.some(m => m.tick > 0), '박자표가 중간에 바뀌는 MIDI는 아직 악보화할 수 없습니다.');
  check(Number.isInteger(meter.numerator) && meter.numerator >= 1 && meter.numerator <= 16 && [2, 4, 8, 16].includes(meter.denominator), 'MIDI 박자표를 확인할 수 없습니다.');
  return { tracks, tpb, meter, keySignature: meta.signatures.filter(m => m.tick === 0).at(-1), keyChanges: meta.signatures.filter(m => m.tick > 0) };
}
export async function inferMidiKey(midi, filename, { key = process.env.OPENAI_API_KEY, fetchImpl = fetch } = {}) {
  const histogram = Array(12).fill(0);
  for (const track of midi.tracks) for (const note of track.notes) histogram[note.pitch % 12] += Math.min(note.end - note.start, midi.tpb * 4) / midi.tpb;
  const name = filename.replace(/\.[^.]+$/, '').slice(0, 100);
  const hasTitle = name.length > 3 && !/^(track|score|midi|untitled|recording|export)[ _-]*\d*$/i.test(name);
  const body = { model: MODEL, reasoning: { effort: 'high' }, store: false, max_output_tokens: 1500,
    instructions: 'Infer the most defensible notated key signature for this MIDI. Use the MIDI key meta event if musically consistent, the pitch-class duration distribution, and the likely tonic/mode. If a recognizable song title exists, web search for reliable score/key evidence; do not trust a filename alone. Never choose C major merely to avoid a key signature. Return circle-of-fifths count (-7 to 7), major/minor, and confidence. Do not invent evidence.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ filename: name, pitchClassDuration: histogram.map(value => Math.round(value * 10) / 10), midiKeySignature: midi.keySignature ? { fifths: midi.keySignature.key, mode: midi.keySignature.scale ? 'minor' : 'major' } : null, meter: `${midi.meter.numerator}/${midi.meter.denominator}` }) }] }],
    ...(hasTitle ? { tools: [{ type: 'web_search' }] } : {}),
    text: { format: { type: 'json_schema', name: 'midi_key', strict: true, schema: keySchema } } };
  const result = await respondAI(body, key, fetchImpl);
  check(Number.isInteger(result.fifths) && Math.abs(result.fifths) <= 7 && ['major', 'minor'].includes(result.mode), 'MIDI 조성을 추론할 수 없습니다.');
  return result;
}

function midiToScore(midi, filename, inferred) {
  const quantize = tick => Math.round(tick / midi.tpb * DIVISIONS / 840) * 840;
  const barTicks = DIVISIONS * 4 * midi.meter.numerator / midi.meter.denominator;
  check(Number.isInteger(barTicks) && barTicks % 840 === 0, 'MIDI 박자표를 악보로 나타낼 수 없습니다.');
  const keyChanges = midi.keyChanges.map(change => ({ tick: quantize(change.tick), fifths: change.key, mode: change.scale ? 'minor' : 'major' })).sort((a, b) => a.tick - b.tick);
  check(keyChanges.every(change => change.tick % barTicks === 0 && Math.abs(change.fifths) <= 7), '마디 중간의 MIDI 조표 변경은 악보화할 수 없습니다.');
  const layers = midi.tracks.map(track => {
    const groups = new Map();
    for (const note of track.notes) {
      const start = quantize(note.start), end = Math.max(start + 840, quantize(note.end));
      const id = `${start}:${end}`;
      if (!groups.has(id)) groups.set(id, { start, end, pitches: [] });
      groups.get(id).pitches.push(note.pitch);
    }
    const voices = [];
    for (const group of [...groups.values()].sort((a, b) => a.start - b.start || b.end - a.end)) {
      let voice = voices.find(items => items.at(-1).end <= group.start);
      if (!voice) { voice = []; voices.push(voice); }
      voice.push(group);
    }
    check(voices.length <= 4, 'MIDI에 겹치는 성부가 너무 많습니다. 트랙을 나누어 다시 저장해 주세요.');
    return voices;
  });
  const maxEnd = Math.max(...layers.flat(2).map(note => note.end));
  const barCount = Math.ceil(maxEnd / barTicks);
  check(barCount >= 1 && barCount <= 120, '펼친 악보는 최대 120마디까지 만들 수 있습니다.');
  const scoreParts = midi.tracks.map(track => { const sorted = track.notes.map(n => n.pitch).sort((a, b) => a - b); const bass = sorted[Math.floor(sorted.length / 2)] < 60; return { name: track.name, clef: bass ? 'F' : 'G', clefLine: bass ? 4 : 2 }; });
  const makeEvent = (kind, pitches, value, tie, fifths) => ({ kind, pitches: kind === 'rest' ? [] : pitches.map(number => ({ ...spell(number, fifths), tieToNext: tie })), type: value.type, dots: value.dots, tupletPlayed: value.tupletPlayed || 1, tupletInTimeOf: value.tupletInTimeOf || 1 });
  const measures = Array.from({ length: barCount }, (_, barIndex) => {
    const from = barIndex * barTicks, to = from + barTicks;
    const currentKey = keyChanges.filter(change => change.tick <= from).at(-1) || { fifths: inferred.fifths, mode: inferred.mode };
    const parts = layers.map((voices, partIndex) => ({ clef: scoreParts[partIndex].clef, clefLine: scoreParts[partIndex].clefLine, voices: voices.map(groups => {
      const events = [];
      let cursor = from;
      for (const group of groups) {
        if (group.end <= from || group.start >= to) continue;
        const start = Math.max(group.start, from), end = Math.min(group.end, to);
        for (const value of chunks(start - cursor)) events.push(makeEvent('rest', [], value, false, currentKey.fifths));
        const values = chunks(end - start);
        for (const [index, value] of values.entries()) events.push(makeEvent('note', group.pitches, value, index < values.length - 1 || end < group.end, currentKey.fifths));
        cursor = end;
      }
      for (const value of chunks(to - cursor)) events.push(makeEvent('rest', [], value, false, currentKey.fifths));
      return events;
    }) }));
    return { number: barIndex + 1, numerator: midi.meter.numerator, denominator: midi.meter.denominator, keyFifths: currentKey.fifths, keyMode: currentKey.mode, ending: [], repeatStart: false, repeatEnd: false, segno: false, coda: false, toCoda: false, fine: false, jump: 'none', jumpTarget: 'end', uncertain: false, issue: '', parts };
  });
  const score = { title: filename.replace(/\.[^.]+$/, '').slice(0, 100) || 'MIDI 펼친 악보', keyFifths: inferred.fifths, keyMode: inferred.mode, parts: scoreParts, measures };
  validateScore(score);
  return score;
}

let verovioPromise;
async function engrave(xmlSource, { encodedBreaks = false } = {}) {
  if (!verovioPromise) verovioPromise = createVerovioModule();
  const toolkit = new VerovioToolkit(await verovioPromise);
  toolkit.setOptions({ inputFrom: 'musicxml', pageWidth: 2100, pageHeight: 2970, scale: 40, breaks: encodedBreaks ? 'encoded' : 'auto', footer: 'none' });
  check(toolkit.loadData(xmlSource), '오선지 조판 도구가 악보를 읽지 못했습니다.');
  const count = toolkit.getPageCount();
  check(count >= 1 && count <= 80, '악보 PDF 페이지 수가 너무 많습니다.');
  const pdf = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, compress: true });
  pdf.registerFont('NotoSansKR', notationFont);
  const buffers = [];
  pdf.on('data', chunk => buffers.push(chunk));
  const finished = new Promise((resolve, reject) => { pdf.once('end', () => resolve(Buffer.concat(buffers))); pdf.once('error', reject); });
  for (let page = 1; page <= count; page++) {
    pdf.addPage();
    pdf.rect(0, 0, 595.28, 841.89).fill('#ffffff');
    const svg = toolkit.renderToSVG(page);
    SVGtoPDF(pdf, svg, 0, 0, { width: 595.28, height: 841.89, preserveAspectRatio: 'xMidYMin meet', fontCallback: (_family, bold, italic, fontOptions) => { fontOptions.fauxBold = bold; fontOptions.fauxItalic = italic; return 'NotoSansKR'; } });
  }
  pdf.end();
  return finished;
}

export async function renderUnfoldedScore(score) { return engrave(scoreXml(score, unfoldMeasures(score)), { encodedBreaks: !!score.systemBars && score.measures.length > score.systemBars }); }

export async function createUnfoldedPdf(buffer, filename, options = {}) {
  const isPdf = buffer.subarray(0, 5).toString() === '%PDF-';
  const isMidi = buffer.subarray(0, 4).toString() === 'MThd';
  check(isPdf || isMidi, 'PDF 악보 또는 MIDI 파일을 선택해 주세요.');
  const score = isPdf ? await transcribeUnfoldScore(buffer, options) : await (async () => {
    const midi = midiData(buffer);
    return midiToScore(midi, filename, await inferMidiKey(midi, filename, options));
  })();
  const order = unfoldMeasures(score);
  const pdf = await engrave(scoreXml(score, order));
  return { pdf, sourceMeasures: score.measures.length, outputMeasures: order.length, keyFifths: score.keyFifths, keyMode: score.keyMode };
}

function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(data)); }
let busy = false;
export async function handleUnfoldScore(request, response) {
  if (request.method !== 'POST') { json(response, 405, { error: 'POST 요청만 지원합니다.' }); return; }
  const origin = request.headers.origin;
  if (origin) {
    try { const url = new URL(origin); if (url.host !== request.headers.host || !['http:', 'https:'].includes(url.protocol)) { json(response, 403, { error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }); return; } }
    catch { json(response, 403, { error: '요청 출처를 확인할 수 없습니다.' }); return; }
  }
  if (busy) { json(response, 429, { error: '다른 악보를 펼치는 중입니다. 잠시 후 다시 시도해 주세요.' }); return; }
  busy = true;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > LIMIT) throw new UnfoldError('파일은 8MB 이하여야 합니다.', 413); chunks.push(chunk); }
    check(size > 0, '파일을 선택해 주세요.');
    const filename = decodeURIComponent(String(request.headers['x-score-filename'] || '악보').slice(0, 300));
    const result = await createUnfoldedPdf(Buffer.concat(chunks), filename);
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': result.pdf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Source-Measures': result.sourceMeasures, 'X-Output-Measures': result.outputMeasures, 'X-Key-Fifths': result.keyFifths, 'X-Key-Mode': result.keyMode });
    response.end(result.pdf);
  } catch (error) { json(response, error.status || 500, { error: error.status ? error.message : '악보 PDF 생성 중 서버 오류가 발생했습니다.' }); }
  finally { busy = false; }
}
