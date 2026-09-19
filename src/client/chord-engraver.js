import { arrangeChords } from './chord-offline.js';

const DIVISIONS = 10080;
const NOTE_TYPES = { 1: 'quarter', 2: 'half', 4: 'whole' };
let verovioModulePromise;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function pitchXml(note) {
  return `<pitch><step>${note.step}</step>${note.alter ? `<alter>${note.alter}</alter>` : ''}<octave>${note.octave}</octave></pitch>`;
}

function eventXml(event, accidentals) {
  const type = NOTE_TYPES[event.length];
  check(type, '악보 음표 길이를 조판할 수 없습니다.');
  const timing = `<duration>${event.length * DIVISIONS}</duration><voice>1</voice><type>${type}</type>`;
  if (!event.notes.length) return `<note><rest/>${timing}</note>`;
  return event.notes.map((note, index) => {
    const id = `${note.step}:${note.octave}`;
    const previous = accidentals.has(id) ? accidentals.get(id) : 0;
    const accidental = note.alter === previous ? '' : ({
      '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp'
    })[note.alter];
    accidentals.set(id, note.alter);
    return `<note>${index ? '<chord/>' : ''}${pitchXml(note)}${timing}${accidental ? `<accidental>${accidental}</accidental>` : ''}</note>`;
  }).join('');
}

function partXml(bars, partIndex) {
  const clef = partIndex === 0 ? ['G', 2] : ['F', 4];
  return `<part id="P${partIndex + 1}">${bars.map((bar, index) => {
    const attributes = index === 0
      ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>0</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>${clef[0]}</sign><line>${clef[1]}</line></clef></attributes>`
      : '';
    const systemBreak = index > 0 && index % 4 === 0 ? '<print new-system="yes"/>' : '';
    const accidentals = new Map();
    const events = partIndex === 0 ? bar.right : bar.left;
    const notation = events.map(event => {
      const labels = partIndex === 0
        ? bar.symbols.filter(symbol => symbol.beat === event.beat).map(symbol => `<direction placement="above"><direction-type><words font-size="8" font-weight="bold">${xml(symbol.text)}</words></direction-type></direction>`).join('')
        : '';
      return `${labels}${eventXml(event, accidentals)}`;
    }).join('');
    return `<measure number="${index + 1}">${systemBreak}${attributes}${notation}</measure>`;
  }).join('')}</part>`;
}

export function chordMusicXml(options) {
  const bars = arrangeChords(options);
  const title = xml(options.title?.trim() || '코드 연주 예시');
  return `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE score-partwise  PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise version="4.0"><work><work-title>${title}</work-title></work><movement-title>${title}</movement-title><identification><creator type="software">Keyroom</creator></identification><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults><part-list><score-part id="P1"><part-name>오른손</part-name></score-part><score-part id="P2"><part-name>왼손</part-name></score-part></part-list>${partXml(bars, 0)}${partXml(bars, 1)}</score-partwise>`;
}

async function verovioToolkit() {
  const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
    import('./verovio-module.mjs'), import('./verovio.mjs')
  ]);
  if (!verovioModulePromise) verovioModulePromise = createVerovioModule();
  return new VerovioToolkit(await verovioModulePromise);
}

async function svgPng(svg) {
  await document.fonts?.ready;
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('조판된 악보 페이지를 PDF에 넣지 못했습니다.'));
      image.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 1488;
    canvas.height = 2105;
    const context = canvas.getContext('2d');
    check(context, '악보 PDF 페이지를 만들 수 없습니다.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    check(blob, '악보 PDF 페이지를 저장하지 못했습니다.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function engraveChordPdf(options) {
  check(globalThis.PDFLib?.PDFDocument && typeof document !== 'undefined', '악보 PDF 도구를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  const toolkit = await verovioToolkit();
  try {
    toolkit.setOptions({ inputFrom: 'musicxml', pageWidth: 2100, pageHeight: 2970, scale: 40, breaks: 'line', footer: 'none' });
    check(toolkit.loadData(chordMusicXml(options)), '오선지 조판 도구가 악보를 읽지 못했습니다.');
    const count = toolkit.getPageCount();
    check(count >= 1 && count <= 80, '악보 PDF 페이지 수가 너무 많습니다.');
    const pdf = await globalThis.PDFLib.PDFDocument.create();
    pdf.setTitle(options.title?.trim() || '코드 연주 예시');
    pdf.setCreator('Keyroom · Verovio');
    for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
      const image = await pdf.embedPng(await svgPng(toolkit.renderToSVG(pageNumber)));
      const page = pdf.addPage([595.28, 841.89]);
      page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }
    return pdf.save();
  } finally {
    toolkit.destroy();
  }
}
