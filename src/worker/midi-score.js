const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const MINOR_FIFTHS = [-3, 4, -1, 6, 1, -4, 3, -2, 5, 0, -5, 2];

export class MidiScoreError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
function check(condition, message, status) { if (!condition) throw new MidiScoreError(message, status); }
function printable(value, fallback) {
  const clean = String(value || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 75);
  return clean || fallback;
}

export function readMidiScore(bytes, parseMidi) {
  check(bytes.length >= 14 && [77, 84, 104, 100].every((n, i) => bytes[i] === n), 'MIDI 파일을 선택해 주세요.', 415);
  let source;
  try { source = parseMidi(bytes); } catch { throw new MidiScoreError('MIDI 파일을 읽을 수 없습니다.', 415); }
  check([0, 1].includes(source.header.format) && Number.isInteger(source.header.ticksPerBeat) && source.header.ticksPerBeat > 0, '지원하지 않는 MIDI 시간 형식입니다.');
  const tpb = source.header.ticksPerBeat;
  const tracks = [], signatures = [], meters = [];
  let noteCount = 0;
  for (const [index, events] of source.tracks.entries()) {
    let tick = 0, name = `Part ${index + 1}`;
    const active = new Map(), notes = [];
    for (const event of events) {
      tick += event.deltaTime;
      if (event.type === 'trackName' && event.text) name = printable(event.text, name);
      if (event.type === 'keySignature') signatures.push({ tick, fifths: event.key, mode: event.scale ? 'minor' : 'major' });
      if (event.type === 'timeSignature') meters.push({ tick, numerator: event.numerator, denominator: event.denominator });
      if (event.channel === 9 || !Number.isInteger(event.noteNumber)) continue;
      const id = `${event.channel}:${event.noteNumber}`;
      if (event.type === 'noteOn' && event.velocity > 0) {
        const stack = active.get(id) || [];
        stack.push(tick);
        active.set(id, stack);
      } else if (event.type === 'noteOff' || event.type === 'noteOn' && event.velocity === 0) {
        const stack = active.get(id);
        if (stack?.length) {
          const start = stack.shift();
          if (tick > start) notes.push({ start, end: tick, pitch: event.noteNumber });
        }
      }
    }
    if (notes.length) { noteCount += notes.length; tracks.push({ name, notes }); }
  }
  check(noteCount > 0, 'MIDI에서 음표를 찾지 못했습니다.');
  check(noteCount <= 15000, 'MIDI 음표가 너무 많습니다.');
  if (tracks.length === 1) {
    const low = tracks[0].notes.filter(note => note.pitch < 60);
    const high = tracks[0].notes.filter(note => note.pitch >= 60);
    if (low.length >= 4 && high.length >= 4 && Math.min(low.length, high.length) / noteCount >= 0.2) {
      tracks.splice(0, 1, { name: 'Right hand', notes: high }, { name: 'Left hand', notes: low });
    }
  }
  check(tracks.length <= 8, 'MIDI는 음표가 있는 트랙 1~8개를 지원합니다.');
  const meter = meters.filter(item => item.tick === 0).at(-1) || { numerator: 4, denominator: 4 };
  check(!meters.some(item => item.tick > 0), '박자표가 중간에 바뀌는 MIDI는 아직 악보화할 수 없습니다.');
  check(Number.isInteger(meter.numerator) && meter.numerator >= 1 && meter.numerator <= 16 && [2, 4, 8, 16].includes(meter.denominator), 'MIDI 박자표를 확인할 수 없습니다.');
  const beatsPerBar = meter.numerator * 4 / meter.denominator;
  const quantize = tick => Math.round(tick / tpb * 12) / 12;
  for (const track of tracks) {
    track.notes = track.notes.map(note => ({ start: quantize(note.start), end: Math.max(quantize(note.start) + 1 / 12, quantize(note.end)), pitch: note.pitch }));
    track.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const pitches = track.notes.map(note => note.pitch).sort((a, b) => a - b);
    track.clef = pitches[Math.floor(pitches.length / 2)] < 60 ? 'F' : 'G';
  }
  const lastBeat = Math.max(...tracks.flatMap(track => track.notes.map(note => note.end)));
  const barCount = Math.ceil((lastBeat - 1e-8) / beatsPerBar);
  check(barCount >= 1 && barCount <= 120, 'MIDI 악보는 최대 120마디까지 만들 수 있습니다.');
  const keySignature = signatures.filter(item => item.tick === 0).at(-1) || null;
  const keyChanges = signatures.filter(item => item.tick > 0).map(item => ({ ...item, beat: quantize(item.tick) }));
  check(keyChanges.every(item => Math.abs(item.beat / beatsPerBar - Math.round(item.beat / beatsPerBar)) < 1e-7 && Math.abs(item.fifths) <= 7), '마디 중간의 MIDI 조표 변경은 악보화할 수 없습니다.');
  return { tracks, meter, beatsPerBar, barCount, keySignature, keyChanges, noteCount };
}

export function guessMidiKey(midi) {
  if (midi.keySignature && Number.isInteger(midi.keySignature.fifths) && Math.abs(midi.keySignature.fifths) <= 7) return midi.keySignature;
  const histogram = Array(12).fill(0);
  for (const track of midi.tracks) for (const note of track.notes) histogram[note.pitch % 12] += Math.min(note.end - note.start, 4);
  let best = { score: -Infinity, fifths: 0, mode: 'major' };
  for (let tonic = 0; tonic < 12; tonic++) for (const [mode, profile, fifths] of [['major', MAJOR_PROFILE, MAJOR_FIFTHS], ['minor', MINOR_PROFILE, MINOR_FIFTHS]]) {
    const score = histogram.reduce((sum, value, pitchClass) => sum + value * profile[(pitchClass - tonic + 12) % 12], 0);
    if (score > best.score) best = { score, fifths: fifths[tonic], mode };
  }
  return { fifths: best.fifths, mode: best.mode };
}

function keyAlter(step, fifths) {
  return fifths > 0 ? Number(SHARP_ORDER.slice(0, fifths).includes(step)) : fifths < 0 ? -Number(FLAT_ORDER.slice(0, -fifths).includes(step)) : 0;
}
function spell(number, fifths) {
  let best;
  for (let stepIndex = 0; stepIndex < 7; stepIndex++) for (let alter = -2; alter <= 2; alter++) {
    const octave = (number - SEMITONES[stepIndex] - alter) / 12 - 1;
    if (!Number.isInteger(octave) || octave < 0 || octave > 9) continue;
    const step = STEPS[stepIndex];
    const cost = Math.abs(alter - keyAlter(step, fifths)) * 4 + Math.abs(alter) + (fifths < 0 ? Math.max(0, alter) : Math.max(0, -alter));
    if (!best || cost < best.cost) best = { step, stepIndex, alter, octave, cost };
  }
  check(best, 'MIDI 음높이를 악보에 표시할 수 없습니다.');
  return best;
}

function drawStaff(page, pdfLib, x1, x2, bottom) {
  const ink = pdfLib.rgb(0.15, 0.18, 0.22);
  for (let line = 0; line < 5; line++) page.drawLine({ start: { x: x1, y: bottom + line * 8 }, end: { x: x2, y: bottom + line * 8 }, color: ink, thickness: 0.65 });
}
function drawRest(page, pdfLib, x, bottom) {
  const ink = pdfLib.rgb(0.13, 0.16, 0.2);
  page.drawRectangle({ x: x - 4, y: bottom + 15, width: 8, height: 3, color: ink });
  page.drawLine({ start: { x, y: bottom + 15 }, end: { x: x - 1, y: bottom + 8 }, color: ink, thickness: 1.3 });
}
function drawNote(page, pdfLib, font, note, x, bottom, clef, fifths, duration, tieIn, tieOut, accidental) {
  const ink = pdfLib.rgb(0.1, 0.13, 0.17);
  const pitch = spell(note.pitch, fifths);
  const base = clef === 'F' ? 18 : 30; // G2 or E4, the bottom staff line.
  const position = pitch.octave * 7 + pitch.stepIndex - base;
  const y = bottom + position * 4;
  for (let step = -2; step >= position; step -= 2) page.drawLine({ start: { x: x - 7, y: bottom + step * 4 }, end: { x: x + 7, y: bottom + step * 4 }, color: ink, thickness: 0.7 });
  for (let step = 10; step <= position; step += 2) page.drawLine({ start: { x: x - 7, y: bottom + step * 4 }, end: { x: x + 7, y: bottom + step * 4 }, color: ink, thickness: 0.7 });
  const open = duration >= 2;
  page.drawEllipse({ x, y, xScale: 4.3, yScale: 2.8, color: open ? pdfLib.rgb(1, 1, 1) : ink, borderColor: ink, borderWidth: 0.9, rotate: pdfLib.degrees(-20) });
  if (duration < 4) {
    const down = position >= 4;
    const stemX = x + (down ? -3.6 : 3.6), stemEnd = y + (down ? -27 : 27);
    page.drawLine({ start: { x: stemX, y }, end: { x: stemX, y: stemEnd }, color: ink, thickness: 0.8 });
    if (duration < 1) {
      const flags = duration < 0.5 ? 2 : 1;
      for (let i = 0; i < flags; i++) page.drawLine({ start: { x: stemX, y: stemEnd + (down ? i * 4 : -i * 4) }, end: { x: stemX + (down ? -7 : 7), y: stemEnd + (down ? 10 + i * 4 : -10 - i * 4) }, color: ink, thickness: 1.3 });
    }
  }
  if (accidental) page.drawText(accidental, { x: x - 15, y: y - 4, size: 10, font, color: ink });
  if (tieIn || tieOut) {
    const direction = position >= 4 ? 1 : -1;
    page.drawLine({ start: { x: x + 5, y: y + direction * 5 }, end: { x: x + 14, y: y + direction * 7 }, color: ink, thickness: 0.65 });
  }
}

export async function createMidiScorePdf(midi, filename, key, pdfLib) {
  check(key && Number.isInteger(key.fifths) && Math.abs(key.fifths) <= 7 && ['major', 'minor'].includes(key.mode), 'MIDI 조성을 확인할 수 없습니다.');
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const title = printable(filename.replace(/\.[^.]+$/, ''), 'MIDI Score');
  document.setTitle(title);
  const ink = rgb(0.1, 0.13, 0.17), muted = rgb(0.38, 0.43, 0.49);
  const notesPerBar = Array(midi.barCount).fill(0);
  for (const track of midi.tracks) for (const note of track.notes) notesPerBar[Math.min(midi.barCount - 1, Math.floor(note.start / midi.beatsPerBar))]++;
  const density = Math.max(...notesPerBar);
  const barsPerSystem = density > 18 ? 1 : density > 9 ? 2 : 4;
  const systemHeight = 45 + midi.tracks.length * 70;
  const usableHeight = 730;
  const systemsPerPage = Math.max(1, Math.floor(usableHeight / systemHeight));
  const systemCount = Math.ceil(midi.barCount / barsPerSystem);
  const pageCount = Math.ceil(systemCount / systemsPerPage);
  check(pageCount <= 80, '악보 PDF 페이지 수가 너무 많습니다. MIDI를 나누어 올려 주세요.');
  const keyAt = beat => midi.keyChanges.filter(item => item.beat <= beat).at(-1) || key;
  for (let system = 0; system < systemCount; system++) {
    const pageIndex = Math.floor(system / systemsPerPage);
    const page = document.getPages()[pageIndex] || document.addPage([595.28, 841.89]);
    if (system % systemsPerPage === 0) {
      page.drawText(title, { x: 38, y: 804, size: 16, font: bold, color: ink, maxWidth: 520 });
      page.drawText(`${midi.meter.numerator}/${midi.meter.denominator}  |  ${key.mode}  |  ${key.fifths === 0 ? 'no accidentals' : `${Math.abs(key.fifths)} ${key.fifths > 0 ? 'sharps' : 'flats'}`}`, { x: 38, y: 785, size: 8, font, color: muted });
      page.drawText(`${pageIndex + 1} / ${pageCount}`, { x: 524, y: 28, size: 8, font, color: muted });
    }
    const top = 756 - system % systemsPerPage * systemHeight;
    const startBar = system * barsPerSystem;
    const endBar = Math.min(midi.barCount, startBar + barsPerSystem);
    const width = 486 / barsPerSystem;
    page.drawText(`Measures ${startBar + 1}-${endBar}`, { x: 76, y: top + 9, size: 8, font, color: muted });
    for (const [trackIndex, track] of midi.tracks.entries()) {
      const bottom = top - 40 - trackIndex * 70;
      drawStaff(page, pdfLib, 76, 562, bottom);
      page.drawText(track.clef, { x: 47, y: bottom + 8, size: 18, font: bold, color: ink });
      page.drawText(printable(track.name, `Part ${trackIndex + 1}`).slice(0, 9), { x: 12, y: bottom - 12, size: 7, font, color: muted });
      for (let barIndex = startBar; barIndex < endBar; barIndex++) {
        const left = 76 + (barIndex - startBar) * width;
        const right = left + width;
        page.drawLine({ start: { x: right, y: bottom }, end: { x: right, y: bottom + 32 }, color: ink, thickness: 0.9 });
        if (trackIndex === 0) page.drawText(String(barIndex + 1), { x: left + 3, y: top - 11, size: 7, font, color: muted });
        const from = barIndex * midi.beatsPerBar, to = from + midi.beatsPerBar;
        const fifths = keyAt(from).fifths;
        const accidentals = new Map();
        const shown = [];
        for (const note of track.notes) {
          if (note.end <= from || note.start >= to) continue;
          const begin = Math.max(note.start, from), end = Math.min(note.end, to);
          const x = left + 9 + (begin - from) / midi.beatsPerBar * (width - 20);
          const pitch = spell(note.pitch, fifths), accidentalId = `${pitch.step}:${pitch.octave}`;
          const previous = accidentals.has(accidentalId) ? accidentals.get(accidentalId) : keyAlter(pitch.step, fifths);
          const tieIn = note.start < from, tieOut = note.end > to;
          const accidental = tieIn || previous === pitch.alter ? '' : ({ '-2': 'bb', '-1': 'b', 0: 'n', 1: '#', 2: 'x' })[pitch.alter];
          accidentals.set(accidentalId, pitch.alter);
          drawNote(page, pdfLib, font, note, x, bottom, track.clef, fifths, end - begin, tieIn, tieOut, accidental);
          shown.push(note);
        }
        if (!shown.length) drawRest(page, pdfLib, left + width / 2, bottom);
      }
    }
  }
  return { pdf: await document.save(), sourceMeasures: midi.barCount, outputMeasures: midi.barCount, keyFifths: key.fifths, keyMode: key.mode };
}
