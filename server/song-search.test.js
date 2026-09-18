import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSong, SONG_SEARCH_MODEL } from './song-search.js';

test('search uses the requested model and high reasoning, exposing only sourced links and facts', async () => {
  let requestBody;
  const fakeResult = {
    song: '예시곡', artist: '예시아티스트',
    bpm: { value: '120', detail: '원곡', sourceUrl: 'https://example.com/tempo' },
    vocalRange: { value: 'C3–G4', detail: '추정', sourceUrl: 'https://bad.example/range' },
    scores: [
      { title: '판매 악보', url: 'https://scores.example/song', detail: '피아노' },
      { title: '없는 악보', url: 'https://bad.example/score', detail: '출처 없음' }
    ],
    videos: [{ title: '연주 영상', url: 'https://www.youtube.com/watch?v=abcd', detail: '라이브' }],
    note: '원곡 기준'
  };
  const result = await searchSong('예시아티스트 예시곡', {
    key: 'test-key',
    fetchImpl: async (_, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'completed', output: [
        { type: 'web_search_call', action: { sources: [
          { url: 'https://example.com/tempo' }, { url: 'https://scores.example/song' },
          { url: 'https://www.youtube.com/watch?v=abcd' }
        ] } },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fakeResult), annotations: [] }] }
      ] }) };
    }
  });
  assert.equal(requestBody.model, SONG_SEARCH_MODEL);
  assert.equal(requestBody.reasoning.effort, 'high');
  assert.equal(requestBody.tool_choice, 'required');
  assert.deepEqual(result.scores.map(item => item.title), ['판매 악보']);
  assert.equal(result.videos.length, 1);
  assert.equal(result.bpm.value, '120');
  assert.equal(result.vocalRange.value, '');
});

test('rejects empty queries before contacting the API', async () => {
  await assert.rejects(searchSong(' ', { key: 'test-key', fetchImpl: () => { throw Error('called'); } }), { status: 400 });
});
