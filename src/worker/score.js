const TICKS = 6720;
const BASE = { whole: 26880, half: 13440, quarter: 6720, eighth: 3360, sixteenth: 1680, thirty_second: 840, sixty_fourth: 420 };
const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TUPLETS = new Set(['1:1', '3:2', '5:4', '6:4', '7:4']);
const NAMES = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: 'sixteenth', 32: 'thirty_second', 64: 'sixty_fourth' };
const NUMBERS = Object.fromEntries(Object.entries(NAMES).map(([number, name]) => [name, number]));

export class ScoreProblem extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
function check(condition, message) { if (!condition) throw new ScoreProblem(message); }
function numberOf(pitch) {
  check(pitch && Object.hasOwn(STEPS, pitch.step) && Number.isInteger(pitch.alter) && Math.abs(pitch.alter) <= 2 && Number.isInteger(pitch.octave) && typeof pitch.tieToNext === 'boolean', '음높이를 해석할 수 없습니다.');
  const number = (pitch.octave + 1) * 12 + STEPS[pitch.step] + pitch.alter;
  check(number >= 0 && number <= 127, 'MIDI 음역을 벗어난 음표가 있습니다.');
  return number;
}
function duration(event) {
  check(event && Object.hasOwn(BASE, event.base) && Number.isInteger(event.dots) && event.dots >= 0 && event.dots <= 2 && TUPLETS.has(`${event.tupletPlayed}:${event.tupletInTimeOf}`), '음표 길이를 해석할 수 없습니다.');
  const ticks = BASE[event.base] * [1, 1.5, 1.75][event.dots] * event.tupletInTimeOf / event.tupletPlayed;
  check(Number.isInteger(ticks) && ticks > 0, '음표 길이를 MIDI 박자로 표현할 수 없습니다.');
  return ticks;
}
function variableLength(value) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= 0x0fffffff, 'MIDI 시간이 범위를 벗어났습니다.');
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 127) | 128);
  return bytes;
}
function be(value, count) { return Array.from({ length: count }, (_, index) => (value >>> ((count - index - 1) * 8)) & 255); }
function track(events, endTick) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);
  const bytes = [];
  let previous = 0;
  for (const item of events) { bytes.push(...variableLength(item.tick - previous), ...item.bytes); previous = item.tick; }
  bytes.push(...variableLength(endTick - previous), 255, 47, 0);
  return [77, 84, 114, 107, ...be(bytes.length, 4), ...bytes];
}
function midiFile(tracks) { return new Uint8Array([77, 84, 104, 100, 0, 0, 0, 6, 0, 1, ...be(tracks.length, 2), ...be(TICKS, 2), ...tracks.flat()]); }
function base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

export function scoreToMidi(score) {
  check(score && Number.isInteger(score.bpm) && score.bpm >= 30 && score.bpm <= 300, 'BPM을 확인할 수 없습니다.');
  check(Array.isArray(score.measures) && score.measures.length > 0 && score.measures.length <= 500, '마디 수를 확인할 수 없습니다.');
  const tempo = Math.round(60000000 / score.bpm);
  const conductor = [{ tick: 0, order: 0, bytes: [255, 81, 3, ...be(tempo, 3)] }];
  const staves = new Map();
  const ties = new Map();
  let measureStart = 0, previousMeter = '', signature = null, noteCount = 0;
  for (const [index, bar] of score.measures.entries()) {
    const label = `${index + 1}마디`;
    check(bar?.number === index + 1 && bar.uncertain === false && !bar.issue, `${label} 판독이 불확실합니다${bar?.issue ? `: ${bar.issue}` : '.'}`);
    check(Number.isInteger(bar.numerator) && bar.numerator >= 1 && bar.numerator <= 32 && [1, 2, 4, 8, 16, 32].includes(bar.denominator), `${label} 박자표를 확인할 수 없습니다.`);
    const barTicks = TICKS * 4 * bar.numerator / bar.denominator;
    const meter = `${bar.numerator}/${bar.denominator}`;
    if (meter !== previousMeter) conductor.push({ tick: measureStart, order: 1, bytes: [255, 88, 4, bar.numerator, Math.log2(bar.denominator), 24, 8] });
    previousMeter = meter;
    check(Array.isArray(bar.staves) && bar.staves.length > 0 && bar.staves.length <= 2, `${label} 오선을 확인할 수 없습니다.`);
    const ids = bar.staves.map(item => item.staff);
    check(ids.every(id => Number.isInteger(id) && id >= 1 && id <= 2) && new Set(ids).size === ids.length, `${label} 오선 번호가 잘못되었습니다.`);
    const currentSignature = [...ids].sort().join(',');
    if (signature === null) signature = currentSignature;
    check(signature === currentSignature, `${label} 오선이 누락되었습니다.`);
    for (const staff of bar.staves) {
      if (!staves.has(staff.staff)) staves.set(staff.staff, []);
      check(Array.isArray(staff.voices) && staff.voices.length >= 1 && staff.voices.length <= 4, `${label} 성부를 확인할 수 없습니다.`);
      const voiceIds = staff.voices.map(voice => voice.voice);
      check(voiceIds.every(id => Number.isInteger(id) && id >= 1 && id <= 4) && new Set(voiceIds).size === voiceIds.length, `${label} 성부 번호가 잘못되었습니다.`);
      for (const voice of staff.voices) {
        check(Array.isArray(voice.events) && voice.events.length > 0, `${label} 성부에 음표나 쉼표가 없습니다.`);
        let offset = 0;
        const prefix = `${staff.staff}:${voice.voice}:`;
        for (const item of voice.events) {
          check(Array.isArray(item?.pitches), `${label} 음표 정보가 잘못되었습니다.`);
          const ticks = duration(item), start = measureStart + offset, end = start + ticks;
          offset += ticks;
          check(offset <= barTicks, `${label}의 음표 길이가 박자표보다 깁니다.`);
          if (item.kind === 'rest') {
            check(item.pitches.length === 0 && ![...ties.keys()].some(key => key.startsWith(prefix)), `${label} 쉼표 또는 붙임줄이 잘못되었습니다.`);
            continue;
          }
          check(item.kind === 'note' && item.pitches.length > 0, `${label}에 음높이가 빠졌습니다.`);
          const pitches = item.pitches.map(numberOf);
          check(new Set(pitches).size === pitches.length, `${label} 화음에 중복된 음이 있습니다.`);
          for (const [key, tie] of ties) if (key.startsWith(prefix)) check(tie.tick === start && pitches.includes(Number(key.slice(prefix.length))), `${label} 붙임줄 음높이가 일치하지 않습니다.`);
          for (const pitch of item.pitches) {
            const number = numberOf(pitch), key = `${prefix}${number}`, tie = ties.get(key);
            if (tie) {
              check(tie.tick === start, `${label} 붙임줄이 이어지지 않습니다.`);
              tie.off.tick = end;
              ties.delete(key);
              if (pitch.tieToNext) ties.set(key, { tick: end, off: tie.off });
            } else {
              const on = { tick: start, order: 2, bytes: [144 | (staff.staff - 1), number, 96] };
              const off = { tick: end, order: 0, bytes: [128 | (staff.staff - 1), number, 0] };
              staves.get(staff.staff).push(on, off);
              if (pitch.tieToNext) ties.set(key, { tick: end, off });
              check(++noteCount <= 12000, '악보에 음표가 너무 많습니다.');
            }
          }
        }
        check(offset === barTicks, `${label} ${staff.staff}번 오선 ${voice.voice}번 성부의 길이가 ${meter} 박자와 다릅니다.`);
      }
    }
    measureStart += barTicks;
  }
  check(ties.size === 0, '마지막 마디에 끝나지 않은 붙임줄이 있습니다.');
  check(noteCount > 0 && staves.has(1), '오른손 오선에서 음표를 찾지 못했습니다.');
  const conductorBytes = track(conductor, measureStart);
  const files = [...staves].sort((a, b) => a[0] - b[0]).map(([staff, events]) => [staff, track(events, measureStart)]);
  return { midiBase64: base64(midiFile([conductorBytes, ...files.map(([, bytes]) => bytes)])),
    rightMidiBase64: base64(midiFile([conductorBytes, files.find(([staff]) => staff === 1)[1]])),
    leftMidiBase64: files.some(([staff]) => staff === 2) ? base64(midiFile([conductorBytes, files.find(([staff]) => staff === 2)[1]])) : null,
    noteCount, measureCount: score.measures.length, bpm: score.bpm };
}

function manualPitch(token) {
  const match = /^([A-G])([#b]{0,2})(-?\d)(~?)$/.exec(token.replaceAll('♯', '#').replaceAll('♭', 'b'));
  check(match, `음높이 ${token}을(를) 읽을 수 없습니다. C4, F#4처럼 적어 주세요.`);
  return { step: match[1], alter: [...match[2]].reduce((sum, sign) => sum + (sign === '#' ? 1 : -1), 0), octave: Number(match[3]), tieToNext: match[4] === '~' };
}
function parseVoice(text) {
  check(typeof text === 'string' && text.trim() && text.length <= 4000, '빈 성부가 있습니다.');
  return text.trim().split(/\s+/).map(token => {
    const match = /^(\[[^\]]+\]|R|[A-G][#b♯♭]{0,2}-?\d~?)\/(1|2|4|8|16|32|64)(\.{0,2})(?:@([3567]):([24]))?$/.exec(token);
    check(match, `${token} 표기를 읽을 수 없습니다. 예: C4/4 D4/8 R/8 [C4,E4,G4]/2`);
    const pitches = match[1] === 'R' ? [] : (match[1].startsWith('[') ? match[1].slice(1, -1).split(',') : [match[1]]).map(manualPitch);
    return { kind: pitches.length ? 'note' : 'rest', pitches, base: NAMES[match[2]], dots: match[3].length, tupletPlayed: Number(match[4] || 1), tupletInTimeOf: Number(match[5] || 1) };
  });
}
function voiceText(events) {
  if (!Array.isArray(events)) return '';
  return events.map(event => {
    if (!event || !NUMBERS[event.base] || !['note', 'rest'].includes(event.kind)) return '?';
    const pitches = event.kind === 'rest' ? 'R' : event.pitches?.map(pitch => {
      if (!pitch || !Object.hasOwn(STEPS, pitch.step) || !Number.isInteger(pitch.alter) || Math.abs(pitch.alter) > 2 || !Number.isInteger(pitch.octave)) return '?';
      return `${pitch.step}${pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter)}${pitch.octave}${pitch.tieToNext ? '~' : ''}`;
    });
    if (!pitches || Array.isArray(pitches) && (!pitches.length || pitches.includes('?'))) return '?';
    const chord = Array.isArray(pitches) ? pitches.length === 1 ? pitches[0] : `[${pitches.join(',')}]` : pitches;
    return `${chord}/${NUMBERS[event.base]}${'.'.repeat(event.dots || 0)}${event.tupletPlayed === 1 ? '' : `@${event.tupletPlayed}:${event.tupletInTimeOf}`}`;
  }).join(' ');
}
export function reviewScore(score) {
  check(score && Array.isArray(score.measures) && score.measures.length > 0 && score.measures.length <= 500, 'AI 판독 마디 수를 확인할 수 없습니다.');
  const draft = structuredClone(score);
  if (!Number.isInteger(draft.bpm) || draft.bpm < 30 || draft.bpm > 300) draft.bpm = 120;
  for (const [index, bar] of draft.measures.entries()) {
    bar.number = index + 1;
    if (!Array.isArray(bar.staves) || !bar.staves.length) { bar.uncertain = true; bar.issue ||= '오선을 읽지 못했습니다.'; }
    if (bar.uncertain || bar.issue) continue;
    try {
      check(Number.isInteger(bar.numerator) && bar.numerator >= 1 && bar.numerator <= 32 && [1, 2, 4, 8, 16, 32].includes(bar.denominator), '박자표를 확인할 수 없습니다.');
      const expected = TICKS * 4 * bar.numerator / bar.denominator;
      for (const staff of bar.staves) for (const voice of staff.voices || []) {
        let sum = 0;
        for (const item of voice.events || []) {
          sum += duration(item);
          if (item.kind === 'note') { check(item.pitches?.length, '음높이가 빠졌습니다.'); item.pitches.forEach(numberOf); }
          else check(item.kind === 'rest' && item.pitches?.length === 0, '음표 또는 쉼표를 확인할 수 없습니다.');
        }
        check(sum === expected, `${staff.staff}번 오선 ${voice.voice}번 성부의 길이가 박자표와 다릅니다.`);
      }
    }
    catch (error) { bar.uncertain = true; bar.issue = error.message; }
  }
  if (!draft.measures.some(bar => bar.uncertain || bar.issue)) {
    try { scoreToMidi(draft); }
    catch (error) {
      const number = Number(/(\d+)마디/.exec(error.message)?.[1]);
      const affected = number >= 1 && number <= draft.measures.length ? [draft.measures[number - 1]] : draft.measures;
      for (const bar of affected) { bar.uncertain = true; bar.issue = error.message; }
    }
  }
  const review = draft.measures.filter(bar => bar.uncertain || bar.issue).map(bar => {
    const voices = (bar.staves || []).flatMap(staff => (staff.voices || []).map(voice => ({ staff: staff.staff, voice: voice.voice, text: voiceText(voice.events) })));
    return { number: bar.number, issue: bar.issue || '원본을 확인해 주세요.', numerator: bar.numerator, denominator: bar.denominator, voices: voices.length ? voices : [{ staff: 1, voice: 1, text: '' }] };
  });
  return { draft, review };
}
export function finalizeReview({ draft, corrections, bpm }) {
  check(draft && Array.isArray(draft.measures) && draft.measures.length > 0 && draft.measures.length <= 500, '수정할 마디를 확인할 수 없습니다.');
  check(Array.isArray(corrections) && corrections.length <= 500, '수정한 마디를 확인할 수 없습니다.');
  const score = structuredClone(draft);
  score.bpm = bpm;
  const seen = new Set();
  for (const correction of corrections) {
    const number = correction?.number;
    check(Number.isInteger(number) && number >= 1 && number <= score.measures.length && !seen.has(number), '수정한 마디 번호가 잘못되었습니다.');
    seen.add(number);
    check(Array.isArray(correction.voices) && correction.voices.length > 0 && correction.voices.length <= 32, `${number}마디의 성부를 입력해 주세요.`);
    const groups = new Map();
    for (const row of correction.voices) {
      check(Number.isInteger(row?.staff) && row.staff >= 1 && row.staff <= 2 && Number.isInteger(row.voice) && row.voice >= 1 && row.voice <= 4, `${number}마디 오선/성부 번호를 확인해 주세요.`);
      if (!groups.has(row.staff)) groups.set(row.staff, new Map());
      check(!groups.get(row.staff).has(row.voice), `${number}마디에 같은 성부가 중복되었습니다.`);
      groups.get(row.staff).set(row.voice, parseVoice(row.text));
    }
    const bar = score.measures[number - 1];
    bar.numerator = correction.numerator;
    bar.denominator = correction.denominator;
    bar.staves = [...groups].sort((a, b) => a[0] - b[0]).map(([staff, voices]) => ({ staff, voices: [...voices].sort((a, b) => a[0] - b[0]).map(([voice, events]) => ({ voice, events })) }));
    bar.uncertain = false;
    bar.issue = '';
  }
  check(score.measures.every(bar => !bar.uncertain && !bar.issue), '판독하지 못한 마디가 남아 있습니다.');
  return scoreToMidi(score);
}
