// Keep the chord spellings and three patterns in sync with server/chord-to-score.js.
// This browser fallback also keeps manual chord entry usable if the hosted API is unavailable.
const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const TICKS_PER_BEAT = 6720;
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
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

function check(condition, message) { if (!condition) throw new Error(message); }
function normalize(value) { return value.trim().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/[−–]/g, '-').replace(/Δ/g, 'M').replace(/(m7|-7)-5(?=\/|\(|$)/gi, '$1b5'); }
function pitch(root, octave, semitones, degree) {
  const index = STEPS.indexOf(root.step) + degree - 1;
  const step = STEPS[index % 7];
  const writtenOctave = octave + Math.floor(index / 7);
  const midi = (octave + 1) * 12 + SEMITONES[root.step] + root.alter + semitones;
  const alter = midi - ((writtenOctave + 1) * 12 + SEMITONES[step]);
  check(Math.abs(alter) <= 2 && midi >= 0 && midi <= 127, '코드 음높이를 악보에 표기할 수 없습니다.');
  return { step, alter, octave: writtenOctave, midi };
}
function label(note) { return `${note.step}${note.alter === 1 ? '♯' : note.alter === -1 ? '♭' : note.alter === 2 ? '𝄪' : note.alter === -2 ? '𝄫' : ''}${note.octave}`; }
function parseChord(symbol) {
  const match = /^([A-G])([#b]?)([^/]*?)(?:\/([A-G])([#b]?))?$/i.exec(normalize(symbol));
  check(match, `코드 「${symbol}」를 읽을 수 없습니다.`);
  const root = { step: match[1].toUpperCase(), alter: match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0 };
  const bass = match[4] ? { step: match[4].toUpperCase(), alter: match[5] === '#' ? 1 : match[5] === 'b' ? -1 : 0 } : root;
  const modifier = /\(([^()]*)\)$/.exec(match[3]);
  const quality = modifier ? match[3].slice(0, modifier.index) : match[3];
  check(Object.hasOwn(QUALITIES, quality), `지원하지 않는 코드 「${symbol}」입니다. 코드를 확인해 주세요.`);
  const intervals = QUALITIES[quality].map(item => [...item]);
  if (modifier) for (const token of modifier[1].split(',')) {
    const alteration = ALTERATIONS[token.trim()];
    check(alteration, `코드 「${symbol}」의 변형음을 읽을 수 없습니다.`);
    const index = intervals.findIndex(([, degree]) => degree === alteration[1]);
    if (index >= 0) intervals[index] = alteration;
    else intervals.push(alteration);
  }
  const right = intervals.map(([semitones, degree]) => pitch(root, 4, semitones, degree));
  const left = pitch(bass, 2, 0, 1);
  return { symbol: symbol.trim(), right, left, tones: right.map(label), bass: label(left) };
}

export function arrangeChords({ progression, pattern = 'hold', bpm = 120, title = '' }) {
  check(['hold', 'alternate', 'arpeggio'].includes(pattern), '연주 방식을 선택해 주세요.');
  check(Number.isInteger(bpm) && bpm >= 30 && bpm <= 300, 'BPM은 30~300으로 입력해 주세요.');
  check(typeof title === 'string' && title.length <= 100, '제목은 100자 이하로 입력해 주세요.');
  check(typeof progression === 'string' && progression.trim() && progression.length <= 4000, '코드 진행을 입력해 주세요.');
  const source = progression.trim().replace(/([A-G][#b]?)\s+(sus2|sus4|sus|add9)/gi, '$1$2');
  const pieces = /[|\n]/.test(source) ? source.split(/[|\n]/).map(value => value.trim()).filter(Boolean) : source.split(/\s+/);
  check(pieces.length >= 1 && pieces.length <= 100, '코드는 1~100마디까지 입력할 수 있습니다.');
  const bars = pieces.map((part, index) => {
    const tokens = part.split(/\s+/).filter(Boolean);
    check(tokens.length >= 1 && tokens.length <= 4, `${index + 1}마디에는 코드 1~4개를 입력해 주세요.`);
    return tokens.map(token => { check(token !== '?', `${index + 1}마디의 ? 코드를 직접 입력해 주세요.`); return parseChord(token); });
  });
  return bars.map((chords, index) => {
    const lengths = chords.length === 1 ? [4] : chords.length === 2 ? [2, 2] : chords.length === 3 ? [1, 1, 2] : [1, 1, 1, 1];
    const right = [], left = [], symbols = [];
    let beat = 0;
    chords.forEach((chord, slot) => {
      const length = lengths[slot];
      symbols.push({ beat, text: normalize(chord.symbol) });
      if (pattern === 'hold') {
        left.push({ beat, length, notes: [chord.left] });
        right.push({ beat, length, notes: chord.right });
      } else if (pattern === 'alternate') {
        for (let offset = 0; offset < length; offset++) {
          const leftBeat = (beat + offset) % 2 === 0;
          left.push({ beat: beat + offset, length: 1, notes: leftBeat ? [chord.left] : [] });
          right.push({ beat: beat + offset, length: 1, notes: leftBeat ? [] : chord.right });
        }
      } else {
        left.push({ beat, length, notes: [chord.left] });
        for (let offset = 0; offset < length; offset++)
          right.push({ beat: beat + offset, length: 1, notes: [chord.right[[0, 1, 2, 1][offset % 4] % chord.right.length]] });
      }
      beat += length;
    });
    return { number: index + 1, right, left, symbols, chords: chords.map(chord => ({ symbol: chord.symbol, tones: chord.tones, bass: chord.bass })) };
  });
}

function variableLength(value) {
  const result = [value & 127];
  while ((value = Math.floor(value / 128)) > 0) result.unshift((value & 127) | 128);
  return result;
}
function bigEndian(value, width) { return Array.from({ length: width }, (_, index) => (value >>> ((width - 1 - index) * 8)) & 255); }
function track(events, endTick) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);
  const bytes = [];
  let previous = 0;
  for (const item of events) { bytes.push(...variableLength(item.tick - previous), ...item.bytes); previous = item.tick; }
  bytes.push(...variableLength(endTick - previous), 255, 47, 0);
  return [77, 84, 114, 107, ...bigEndian(bytes.length, 4), ...bytes];
}
function midiFile(tracks) {
  const header = [77, 84, 104, 100, 0, 0, 0, 6, 0, 1, ...bigEndian(tracks.length, 2), ...bigEndian(TICKS_PER_BEAT, 2)];
  return new Uint8Array([...header, ...tracks.flat()]);
}
function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function chordMidi(bars, bpm) {
  const tempo = Math.round(60000000 / bpm);
  const endTick = bars.length * 4 * TICKS_PER_BEAT;
  const conductor = track([
    { tick: 0, order: 0, bytes: [255, 81, 3, ...bigEndian(tempo, 3)] },
    { tick: 0, order: 1, bytes: [255, 88, 4, 4, 2, 24, 8] }
  ], endTick);
  const staffTracks = [0, 1].map((channel) => {
    const events = [];
    for (const [index, bar] of bars.entries()) for (const item of channel === 0 ? bar.right : bar.left) {
      for (const note of item.notes) {
        const start = (index * 4 + item.beat) * TICKS_PER_BEAT;
        events.push({ tick: start, order: 2, bytes: [144 | channel, note.midi, 96] });
        events.push({ tick: start + item.length * TICKS_PER_BEAT, order: 0, bytes: [128 | channel, note.midi, 0] });
      }
    }
    return { bytes: track(events, endTick), count: events.length / 2 };
  });
  return {
    rightMidiBase64: base64(midiFile([conductor, staffTracks[0].bytes])),
    leftMidiBase64: base64(midiFile([conductor, staffTracks[1].bytes])),
    noteCount: staffTracks[0].count + staffTracks[1].count
  };
}

function drawNote(ctx, note, x, bottom, staffBottomStep, length) {
  const step = note.octave * 7 + STEPS.indexOf(note.step);
  const y = bottom - (step - staffBottomStep) * 9;
  for (let ledger = bottom + 18; ledger <= y; ledger += 18) {
    ctx.beginPath(); ctx.moveTo(x - 17, ledger); ctx.lineTo(x + 17, ledger); ctx.stroke();
  }
  for (let ledger = bottom - 90; ledger >= y; ledger -= 18) {
    ctx.beginPath(); ctx.moveTo(x - 17, ledger); ctx.lineTo(x + 17, ledger); ctx.stroke();
  }
  ctx.save(); ctx.translate(x, y); ctx.rotate(-0.32);
  ctx.beginPath(); ctx.ellipse(0, 0, 11, 7, 0, 0, Math.PI * 2);
  if (length >= 2) ctx.stroke(); else ctx.fill();
  ctx.restore();
  if (length < 4) { ctx.beginPath(); ctx.moveTo(x + 10, y); ctx.lineTo(x + 10, y - 44); ctx.stroke(); }
  if (note.alter) {
    ctx.font = '27px serif';
    ctx.fillText(note.alter === 1 ? '♯' : note.alter === -1 ? '♭' : note.alter === 2 ? '𝄪' : '𝄫', x - 32, y + 9);
  }
}
function drawStaff(ctx, y) {
  ctx.strokeStyle = '#28313c'; ctx.lineWidth = 1.5;
  for (const top of [y + 80, y + 220]) for (let line = 0; line < 5; line++) {
    ctx.beginPath(); ctx.moveTo(83, top + line * 18); ctx.lineTo(1163, top + line * 18); ctx.stroke();
  }
  ctx.font = '70px "Apple Symbols", "Noto Music", serif';
  ctx.fillText('𝄞', 89, y + 153); ctx.fillText('𝄢', 92, y + 290);
  ctx.font = 'bold 28px sans-serif'; ctx.fillText('4', 120, y + 115); ctx.fillText('4', 120, y + 147);
  ctx.fillText('4', 120, y + 255); ctx.fillText('4', 120, y + 287);
}
async function scorePdf(bars, bpm, title) {
  check(globalThis.PDFLib?.PDFDocument && typeof document !== 'undefined', 'PDF 생성 도구를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  const pdf = await globalThis.PDFLib.PDFDocument.create();
  const pageCount = Math.ceil(bars.length / 12);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const canvas = document.createElement('canvas');
    canvas.width = 1240; canvas.height = 1754;
    const ctx = canvas.getContext('2d');
    check(ctx, '악보를 그릴 수 없습니다.');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#17212a';
    ctx.font = 'bold 46px "Noto Sans KR", sans-serif';
    ctx.fillText(pageIndex ? `${title || '코드 연주 예시'} · ${pageIndex + 1}` : (title || '코드 연주 예시'), 83, 90, 1070);
    ctx.font = '24px sans-serif'; ctx.fillText(`4/4  ·  ${bpm} BPM`, 85, 131);
    const pageBars = bars.slice(pageIndex * 12, (pageIndex + 1) * 12);
    for (let line = 0; line < Math.ceil(pageBars.length / 4); line++) {
      const y = 195 + line * 485;
      drawStaff(ctx, y);
      for (let column = 0; column < 4; column++) {
        const bar = pageBars[line * 4 + column];
        if (!bar) break;
        const left = 83 + column * 270;
        ctx.font = '20px sans-serif'; ctx.fillStyle = '#68717a'; ctx.fillText(String(bar.number), left + 11, y + 35);
        ctx.fillStyle = '#17212a';
        for (const symbol of bar.symbols) {
          ctx.font = 'bold 23px sans-serif';
          ctx.fillText(symbol.text, left + 68 + symbol.beat * 46, y + 63, 120);
        }
        for (const [events, bottom, base] of [[bar.right, y + 152, 30], [bar.left, y + 292, 18]]) {
          for (const event of events) {
            const x = left + 68 + event.beat * 46;
            if (!event.notes.length) { ctx.font = '26px serif'; ctx.fillText('𝄽', x - 10, bottom - 26); continue; }
            for (const note of event.notes) drawNote(ctx, note, x, bottom, base, event.length);
          }
        }
        ctx.beginPath(); ctx.moveTo(left + 270, y + 80); ctx.lineTo(left + 270, y + 292); ctx.stroke();
      }
    }
    ctx.font = '20px sans-serif'; ctx.fillText(`${pageIndex + 1} / ${pageCount}`, 1080, 1690);
    const image = await pdf.embedPng(canvas.toDataURL('image/png'));
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  return pdf.save();
}

export async function buildOfflineArrangement(options) {
  const bars = arrangeChords(options);
  const midi = chordMidi(bars, options.bpm);
  const pdf = await scorePdf(bars, options.bpm, options.title);
  return { ...midi, pdf, measureCount: bars.length, bpm: options.bpm,
    summary: bars.map(bar => ({ measure: bar.number, chords: bar.chords })) };
}
