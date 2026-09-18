import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi } from 'midi-file';
import { finalizeReview, reviewScore, scoreToMidi } from '../src/worker/score.js';

const note = (step, octave, tieToNext = false) => ({ kind: 'note', pitches: [{ step, alter: 0, octave, tieToNext }], base: 'whole', dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 });
const rest = () => ({ kind: 'rest', pitches: [], base: 'whole', dots: 0, tupletPlayed: 1, tupletInTimeOf: 1 });

test('worker conversion exports both hands and joins a cross-bar tie', () => {
  const score = { bpm: 120, measures: [
    { number: 1, numerator: 4, denominator: 4, uncertain: false, issue: '', staves: [
      { staff: 1, voices: [{ voice: 1, events: [note('C', 4, true)] }] },
      { staff: 2, voices: [{ voice: 1, events: [note('C', 3)] }] }
    ] },
    { number: 2, numerator: 4, denominator: 4, uncertain: false, issue: '', staves: [
      { staff: 1, voices: [{ voice: 1, events: [note('C', 4)] }] },
      { staff: 2, voices: [{ voice: 1, events: [rest()] }] }
    ] }
  ] };
  assert.equal(reviewScore(score).review.length, 0);
  const result = scoreToMidi(score);
  assert.equal(result.noteCount, 2);
  const midi = parseMidi(Buffer.from(result.rightMidiBase64, 'base64'));
  const noteOff = midi.tracks[1].find(event => event.type === 'noteOff');
  assert.equal(noteOff.deltaTime, 8 * 6720);
  assert.ok(result.leftMidiBase64);
});

test('uncertain worker transcription stays editable and manual corrections are validated', () => {
  const draft = { bpm: 100, measures: [{ number: 1, numerator: 4, denominator: 4, uncertain: true, issue: '한 음이 불명확함', staves: [] }] };
  const reviewed = reviewScore(draft);
  assert.equal(reviewed.review.length, 1);
  const result = finalizeReview({ draft: reviewed.draft, bpm: 100, corrections: [{ number: 1, numerator: 4, denominator: 4, voices: [{ staff: 1, voice: 1, text: 'C4/1' }] }] });
  assert.equal(result.measureCount, 1);
  assert.throws(() => finalizeReview({ draft, bpm: 100, corrections: [{ number: 1, numerator: 4, denominator: 4, voices: [{ staff: 1, voice: 1, text: 'C4/4' }] }] }), /박자/);
});
