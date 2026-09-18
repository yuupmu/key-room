import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expandMultiMeasureRests, scoreToMidi } from '../server/score-to-midi.js';

const [jobDirectory, outputPrefix, verifiedMeter, verifiedBpm, expectedMeasuresText] = process.argv.slice(2);
if (!jobDirectory || !outputPrefix) {
  console.error('Usage: node scripts/recover-score-to-midi.mjs JOB_DIRECTORY OUTPUT_PREFIX [4/4] [142] [28]');
  process.exit(2);
}

const files = (await readdir(jobDirectory)).filter(name => /^(\d+)-(\d+)-(initial|recheck)\.json$/.test(name));
const groups = new Map();
for (const name of files) {
  const [, startText, endText, pass] = /^(\d+)-(\d+)-(initial|recheck)\.json$/.exec(name);
  const key = `${startText}-${endText}`;
  const group = groups.get(key) || { start: Number(startText), end: Number(endText) };
  group[pass] = JSON.parse(await readFile(join(jobDirectory, name), 'utf8'));
  groups.set(key, group);
}
const ordered = [...groups.values()].sort((a, b) => a.start - b.start);
if (!ordered.length) throw new Error('저장된 판독 구간이 없습니다.');

const visualMeasures = [];
let bpm = null;
for (const group of ordered) {
  if (group.start !== visualMeasures.length + 1 || !group.initial) throw new Error(`${group.start}번째 시각적 마디 앞에 저장되지 않은 구간이 있습니다.`);
  const initialProblems = group.initial.problems?.length ?? Infinity;
  const recheckProblems = group.recheck?.problems?.length ?? Infinity;
  const reading = (recheckProblems <= initialProblems ? group.recheck : group.initial).reading;
  if (!Array.isArray(reading?.measures) || reading.measures.length !== group.end - group.start + 1) throw new Error(`${group.start}-${group.end} 구간의 마디 수가 맞지 않습니다.`);
  if (bpm === null) bpm = reading.bpm;
  for (const [index, bar] of reading.measures.entries()) {
    if (bar.number !== index + 1) throw new Error(`${group.start}-${group.end} 구간의 로컬 번호가 맞지 않습니다.`);
    visualMeasures.push({ ...bar, number: group.start + index });
  }
}

const [meterTop, meterBottom] = verifiedMeter?.split('/').map(Number) || [];
const tempo = Number(verifiedBpm);
if (verifiedMeter && (!Number.isInteger(meterTop) || !Number.isInteger(meterBottom))) throw new Error('검증한 박자표 형식이 잘못되었습니다.');
if (verifiedBpm && (!Number.isInteger(tempo) || tempo < 30 || tempo > 300)) throw new Error('검증한 BPM이 잘못되었습니다.');
for (const bar of visualMeasures) {
  const issue = bar.issue || '';
  const contextOnly = /박자표|BPM/.test(issue) && !/음표|음높이|붙임줄|임시표|쉼표|성부|불명|모호/.test(issue);
  if (contextOnly && bar.numerator === meterTop && bar.denominator === meterBottom && bpm === tempo
    && bar.staves?.every(staff => staff.voices?.every(voice => voice.events?.every(event => event.kind !== 'unknown')))) {
    bar.uncertain = false;
    bar.issue = '';
  }
}

const { measures, expanded } = expandMultiMeasureRests(visualMeasures);
if (expectedMeasuresText && measures.length !== Number(expectedMeasuresText)) throw new Error(`원본은 ${expectedMeasuresText}마디인데 저장된 판독은 ${measures.length}마디입니다.`);
const score = { bpm: verifiedBpm ? tempo : bpm, measures };
const unresolved = measures.filter(bar => bar.uncertain || bar.issue).map(bar => ({ number: bar.number, issue: bar.issue }));
console.log(JSON.stringify({ visualMeasures: visualMeasures.length, actualMeasures: measures.length, expanded, unresolved }, null, 2));
if (unresolved.length) process.exit(2);

const result = scoreToMidi(score);
await mkdir(dirname(outputPrefix), { recursive: true });
await writeFile(`${outputPrefix}.json`, JSON.stringify(score));
await writeFile(`${outputPrefix}.mid`, result.midi);
for (const [staff, bytes] of Object.entries(result.midiByStaff)) await writeFile(`${outputPrefix}-staff-${staff}.mid`, bytes);
console.log(JSON.stringify({ bpm: score.bpm, measures: result.measureCount, notes: result.noteCount, outputPrefix }));
