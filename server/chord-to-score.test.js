import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseMidi } from 'midi-file';
import { buildChordArrangement, extractChordChart, parseChord, parseProgression } from './chord-to-score.js';
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

test('a split measure keeps its two chord changes and generates a real notation PDF', async () => {
  const arrangement = buildChordArrangement({ progression: 'F C/E | Dm7 G7', pattern: 'hold', bpm: 92, title: '테스트 악보' });
  assert.deepEqual(arrangement.pdfScore.measures[0].chordLabels, [{ eventIndex: 0, text: 'F' }, { eventIndex: 1, text: 'C/E' }]);
  assert.equal(scoreToMidi(arrangement.midiScore).measureCount, 2);
  const pdf = await renderUnfoldedScore(arrangement.pdfScore);
  assert.equal(pdf.toString('ascii', 0, 4), '%PDF');
  assert.ok(pdf.length > 1000);
});

test('OCR request preserves chart order but never invents timing when bars are missing', async () => {
  const image = await readFile(new URL('../test-fixtures/코드악보_for_BYPP_hackathon_demo.jpg', import.meta.url));
  assert.equal(image.subarray(0, 3).toString('hex'), 'ffd8ff');
  const chart = await extractChordChart(image, 'image/jpeg', { key: 'test-key', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.instructions, /barlines are not visible/);
    assert.equal(body.input[0].content[0].detail, 'original');
    assert.ok(body.input[0].content[0].image_url.endsWith(image.toString('base64')));
    const result = { title: '음악은 참 이상하죠', progression: 'F | C/E | Dm7 | BbM7', barsKnown: false, warning: '마디선이 없어 위치 확인 필요' };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });
  } });
  assert.equal(chart.barsKnown, false);
  assert.equal(parseProgression(chart.progression).length, 4);
});
