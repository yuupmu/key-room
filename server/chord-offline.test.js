import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMidi } from 'midi-file';
import { arrangeChords, chordMidi } from '../src/client/chord-offline.js';
import { buildChordArrangement } from './chord-to-score.js';
import { scoreToMidi } from './score-to-midi.js';

test('static chord generator matches the server for all three playing patterns', () => {
  const progression = 'F | C/E | Am7/C# | Dm C | BbM7 | EbM7(#11) Bb/C Fsus4/C';
  for (const pattern of ['hold', 'alternate', 'arpeggio']) {
    const options = { progression, pattern, bpm: 92, title: '음악은 참 이상하죠' };
    const bars = arrangeChords(options);
    const output = chordMidi(bars, options.bpm);
    const canonical = scoreToMidi(buildChordArrangement(options).midiScore);
    assert.equal(bars.length, canonical.measureCount);
    assert.equal(output.noteCount, canonical.noteCount);
    for (const [hand, staff] of [['right', 1], ['left', 2]]) {
      const actual = parseMidi(Buffer.from(output[`${hand}MidiBase64`], 'base64'));
      const expected = parseMidi(canonical.midiByStaff[staff]);
      assert.deepEqual(actual, expected);
    }
  }
});

test('static conversion does not turn uncertain or unsupported chords into notes', () => {
  assert.throws(() => arrangeChords({ progression: 'C | ? | G7' }), /\? 코드를 직접 입력/);
  assert.throws(() => arrangeChords({ progression: 'C | H7' }), /읽을 수 없습니다/);
});
