import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseMidi } from 'midi-file';
import { buildChordArrangement, extractChordChart, handleChordArrangement, parseChord, parseProgression, reviewExtractedProgression } from './chord-to-score.js';
import { scoreToMidi } from './score-to-midi.js';
import { renderUnfoldedScore } from './unfold-score.js';

function pitchedEvents(midi) {
  return parseMidi(midi).tracks.flatMap(track => {
    let tick = 0;
    return track.flatMap(event => {
      tick += event.deltaTime;
      return event.type === 'noteOn' || event.type === 'noteOff' ? [{ tick, type: event.type, note: event.noteNumber, channel: event.channel }] : [];
    });
  });
}

test('reads the chord spellings visible in the supplied 음악은 참 이상하죠 chart', () => {
  const sample = 'F | C/E | A7/C# Dm | Bb | Am7 | Am6 | Gm7 | Bb/C | Dm7 | BbM7 | Eb | EbM7(#11) | Fsus4/C';
  const bars = parseProgression(sample);
  assert.equal(bars.length, 13);
  assert.deepEqual(bars[0][0].tones, ['F4', 'A4', 'C5']);
  assert.equal(bars[1][0].bass, 'E2');
  assert.deepEqual(parseChord('A-7').tones, ['A4', 'C5', 'E5', 'G5']);
  assert.deepEqual(parseChord('B♭M7').tones, ['B♭4', 'D5', 'F5', 'A5']);
  assert.deepEqual(parseChord('E♭M7(#11)').tones, ['E♭4', 'G4', 'B♭4', 'D5', 'A5']);
  assert.equal(bars[12][0].bass, 'C2');
});

test('reads Connect chart diminished and flat-root chord spellings', () => {
  const progression = 'BbM7 | C | Am7 | Dm7 | Dm/A | BbM7 | C | Dsus4 | D | CbM7 | Db | Bbm7 | Ebm7 | Cm7-5 | Cb | Dbsus4 | Ebsus4 Eb | AbM7 | Bb | Bbsus4 Bb | Gm7 | Cm7 | Bb | G7/B | Am7-5';
  const bars = parseProgression(progression);
  assert.equal(bars.length, 25);
  assert.deepEqual(bars[13][0].tones, ['C4', 'E♭4', 'G♭4', 'B♭4']);
  assert.deepEqual(bars[24][0].tones, ['A4', 'C5', 'E♭5', 'G5']);
  assert.equal(bars[4][0].bass, 'A2');
  assert.equal(bars[16].length, 2);
});

test('preserves uncertain positions for manual correction and blocks unresolved arrangements', () => {
  const reviewed = reviewExtractedProgression('F | ? C | Cm7-5 | H7 | G7/B');
  assert.deepEqual(reviewed, { progression: 'F | ? C | Cm7-5 | ? | G7/B', unknownCount: 2 });
  assert.throws(() => buildChordArrangement({ progression: reviewed.progression }), /\? 코드를 직접 입력/);
  assert.equal(parseProgression('F | Dm7 C | Cm7-5 | Bb | G7/B').length, 5);
});

test('three playing choices place the left bass and right chord at the intended beats', () => {
  const hold = pitchedEvents(scoreToMidi(buildChordArrangement({ progression: 'C', pattern: 'hold' }).midiScore).midi);
  assert.equal(hold.filter(event => event.type === 'noteOn' && event.tick === 0).length, 4);
  assert.equal(hold.filter(event => event.type === 'noteOff' && event.tick === 26880).length, 4);

  const alternate = pitchedEvents(scoreToMidi(buildChordArrangement({ progression: 'C', pattern: 'alternate' }).midiScore).midi);
  assert.deepEqual(alternate.filter(event => event.type === 'noteOn' && event.channel === 1).map(event => event.tick), [0, 13440]);
  assert.deepEqual([...new Set(alternate.filter(event => event.type === 'noteOn' && event.channel === 0).map(event => event.tick))], [6720, 20160]);

  const arpeggio = pitchedEvents(scoreToMidi(buildChordArrangement({ progression: 'C', pattern: 'arpeggio' }).midiScore).midi);
  assert.deepEqual(arpeggio.filter(event => event.type === 'noteOn' && event.channel === 0).map(event => event.note), [60, 64, 67, 64]);
  assert.deepEqual(arpeggio.filter(event => event.type === 'noteOn' && event.channel === 1).map(event => event.note), [36]);
});

test('chord arrangement API returns separate left and right MIDI files', async () => {
  const options = { progression: 'C | F', pattern: 'alternate', bpm: 108 };
  const request = Readable.from([Buffer.from(JSON.stringify(options))]);
  request.method = 'POST';
  request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handleChordArrangement(request, response);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(response.body.pdfBase64, 'base64').toString('ascii', 0, 4), '%PDF');
  const combined = scoreToMidi(buildChordArrangement(options).midiScore);
  assert.deepEqual(Buffer.from(response.body.rightMidiBase64, 'base64'), combined.midiByStaff[1]);
  assert.deepEqual(Buffer.from(response.body.leftMidiBase64, 'base64'), combined.midiByStaff[2]);
  const right = pitchedEvents(Buffer.from(response.body.rightMidiBase64, 'base64'));
  const left = pitchedEvents(Buffer.from(response.body.leftMidiBase64, 'base64'));
  assert.deepEqual([...new Set(right.filter(event => event.type === 'noteOn').map(event => event.tick))], [6720, 20160, 33600, 47040]);
  assert.deepEqual(left.filter(event => event.type === 'noteOn').map(event => event.tick), [0, 13440, 26880, 40320]);
  assert.ok(right.every(event => event.channel === 0));
  assert.ok(left.every(event => event.channel === 1));
});

test('a split measure keeps its two chord changes and generates a real notation PDF', async () => {
  const arrangement = buildChordArrangement({ progression: 'F C/E | Dm7 G7', pattern: 'hold', bpm: 92, title: '테스트 악보' });
  assert.deepEqual(arrangement.pdfScore.measures[0].chordLabels, [{ eventIndex: 0, text: 'F' }, { eventIndex: 1, text: 'C/E' }]);
  assert.equal(scoreToMidi(arrangement.midiScore).measureCount, 2);
  const pdf = await renderUnfoldedScore(arrangement.pdfScore);
  assert.equal(pdf.toString('ascii', 0, 4), '%PDF');
  assert.ok(pdf.length > 1000);
});

test('the bundled chart demo creates a PDF with its Korean title', async () => {
  const client = await readFile(new URL('../src/client/chord-converter.js', import.meta.url), 'utf8');
  const progression = client.match(/const demoProgression = '([^']+)'/)[1];
  const title = client.match(/titleInput\.value = '([^']+)'/)[1];
  const arrangement = buildChordArrangement({ progression, title });
  assert.equal(arrangement.pdfScore.measures.length, 24);
  assert.equal(title, '음악은 참 이상하죠');
  const pdf = await renderUnfoldedScore(arrangement.pdfScore);
  const source = pdf.toString('latin1');
  assert.ok((source.match(/\/Type \/Page\b/g) || []).length >= 1);
  assert.match(source, /\/BaseFont \/[^\s]*NotoSansKR/);
});

test('OCR request preserves chart order but never invents timing when bars are missing', async () => {
  const image = await readFile(new URL('../test-fixtures/코드악보_for_BYPP_hackathon_demo.jpg', import.meta.url));
  assert.equal(image.subarray(0, 3).toString('hex'), 'ffd8ff');
  const chart = await extractChordChart(image, 'image/jpeg', { key: 'test-key', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.instructions, /barlines are not visible/);
    assert.match(body.instructions, /Replace each illegible or ambiguous printed chord with exactly \?/);
    assert.equal(body.input[0].content[0].detail, 'original');
    assert.ok(body.input[0].content[0].image_url.endsWith(image.toString('base64')));
    const result = { title: '음악은 참 이상하죠', progression: 'F | C/E | Dm7 | BbM7', barsKnown: false, warning: '마디선이 없어 위치 확인 필요' };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });
  } });
  assert.equal(chart.barsKnown, false);
  assert.equal(chart.unknownCount, 0);
  assert.equal(parseProgression(chart.progression).length, 4);
});

test('OCR returns question marks instead of rejecting unsupported or unreadable chords', async () => {
  const chart = await extractChordChart(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', { key: 'test-key', fetchImpl: async () => {
    const result = { title: '확인 필요', progression: 'F | ? C | H7 | Gm7', barsKnown: true, warning: '둘째 마디 첫 코드를 읽을 수 없음' };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });
  } });
  assert.equal(chart.progression, 'F | ? C | ? | Gm7');
  assert.equal(chart.unknownCount, 2);
  assert.match(chart.warning, /확인 필요한 코드 2곳/);
});
