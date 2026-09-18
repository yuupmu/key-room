(() => {
  'use strict';
  const form = document.getElementById('scoreConvertForm');
  const input = document.getElementById('scoreInput');
  const button = document.getElementById('scoreConvertButton');
  const status = document.getElementById('scoreConvertStatus');
  const rightDownload = document.getElementById('scoreRightDownload');
  const leftDownload = document.getElementById('scoreLeftDownload');
  const reviewPanel = document.getElementById('scoreReview');
  const preview = document.getElementById('scoreReviewPreview');
  const reviewMeasures = document.getElementById('scoreReviewMeasures');
  const bpmInput = document.getElementById('scoreReviewBpm');
  const finalizeButton = document.getElementById('scoreFinalize');
  const demoButton = document.getElementById('scoreDemo');
  const demoScore = './assets/demo/Merry-go-round-score.jpeg';
  const demoMidis = [
    { path: './assets/demo/Merry-go-round-right.mid', name: 'Merry-go-round-right.mid', hand: 'right', link: rightDownload },
    { path: './assets/demo/Merry-go-round-left.mid', name: 'Merry-go-round-left.mid', hand: 'left', link: leftDownload }
  ];
  let downloadUrls = [];
  let previewUrl = null;
  let reviewState = null;
  let demoSelected = false;

  demoButton.addEventListener('click', async () => {
    demoButton.disabled = true;
    try {
      const response = await fetch(demoScore);
      if (!response.ok) throw new Error('데모 악보를 불러오지 못했습니다.');
      const image = await response.blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([image], 'Merry-go-round-score.jpeg', { type: 'image/jpeg' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      demoSelected = true;
      status.textContent = 'Merry-go-round 악보가 선택됐습니다. MIDI 변환을 눌러 주세요.';
    } catch (error) { status.textContent = error.message || '데모 악보를 선택하지 못했습니다.'; }
    finally { demoButton.disabled = false; }
  });

  function clearDownloads() {
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls = [];
    rightDownload.hidden = true;
    leftDownload.hidden = true;
  }

  function midiFile(base64, name) {
    const binary = atob(base64);
    return new File([Uint8Array.from(binary, character => character.charCodeAt(0))], name, { type: 'audio/midi' });
  }

  function offerMidiFile(file, hand, link) {
    if (file.size < 30) throw new Error('생성된 MIDI 파일이 올바르지 않습니다.');
    const url = URL.createObjectURL(file);
    downloadUrls.push(url);
    link.href = url;
    link.download = file.name;
    link.hidden = false;
    window.dispatchEvent(new CustomEvent('keyroom:import-midi', { detail: { file, hand } }));
  }

  function offerMidi(base64, name, hand, link) {
    offerMidiFile(midiFile(base64, name), hand, link);
  }

  async function showDemoMidi() {
    const files = await Promise.all(demoMidis.map(async ({ path, name }) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error('데모 MIDI를 불러오지 못했습니다.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 30 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'MThd') throw new Error('데모 MIDI 파일이 올바르지 않습니다.');
      return new File([bytes], name, { type: 'audio/midi' });
    }));
    clearDownloads();
    files.forEach((file, index) => offerMidiFile(file, demoMidis[index].hand, demoMidis[index].link));
    clearReview();
    status.textContent = '데모 변환 완료: 28마디 · 274개 음표 · 142 BPM. 양손 MIDI를 각각 다운로드하거나 별도 트랙에서 확인할 수 있습니다. 원본 악보와 대조해 주세요.';
  }

  function clearReview() {
    reviewState = null;
    reviewPanel.hidden = true;
    reviewMeasures.replaceChildren();
    preview.removeAttribute('src');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  function showMidi(result, name) {
    clearDownloads();
    if (!result.rightMidiBase64) throw new Error('오른손 MIDI를 받지 못했습니다. 서버를 다시 시작해 주세요.');
    offerMidi(result.rightMidiBase64, `${name}-right.mid`, 'right', rightDownload);
    if (result.leftMidiBase64) offerMidi(result.leftMidiBase64, `${name}-left.mid`, 'left', leftDownload);
    clearReview();
    status.textContent = `${result.measureCount}마디 · ${result.noteCount}개 음표 · ${result.bpm} BPM 변환 완료. ${result.leftMidiBase64 ? '양손 MIDI를 각각 다운로드하고 별도 트랙에서 확인할 수 있습니다.' : '단일 오선이어서 오른손 MIDI만 생성했습니다.'} 원본 악보와 대조해 주세요.`;
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function addVoice(container, staff, voice, value = '') {
    const row = element('div', 'score-review-voice');
    row.dataset.staff = String(staff);
    row.dataset.voice = String(voice);
    const label = element('label', '', `${staff}번 오선 · ${voice}번 성부`);
    const field = element('textarea');
    field.rows = 2;
    field.placeholder = '?  예: C4/4 D4/4 E4/4 R/4';
    field.value = value;
    label.htmlFor = field.id = `score-review-${container.closest('.score-review-measure').dataset.number}-${staff}-${voice}`;
    const remove = element('button', 'score-review-remove', '제거');
    remove.type = 'button'; remove.setAttribute('aria-label', `${staff}번 오선 ${voice}번 성부 제거`);
    remove.addEventListener('click', () => {
      if (container.querySelectorAll('.score-review-voice').length > 1) row.remove();
      else status.textContent = '마디에는 하나 이상의 성부가 필요합니다.';
    });
    row.append(label, field, remove);
    container.append(row);
  }

  function reviewCard(item) {
    const card = element('section', 'score-review-measure');
    card.dataset.number = String(item.number);
    card.append(element('h4', '', `${item.number}마디 · ?`), element('p', '', item.issue || '원본을 보고 모든 음을 입력해 주세요.'));
    const meter = element('div', 'score-review-meter');
    const numeratorLabel = element('label', '', '박자표');
    const numerator = element('input');
    numerator.type = 'number'; numerator.min = '1'; numerator.max = '32'; numerator.value = String(item.numerator || 4);
    numerator.className = 'score-review-numerator'; numerator.setAttribute('aria-label', `${item.number}마디 박자표 분자`);
    const denominator = element('select', 'score-review-denominator');
    denominator.setAttribute('aria-label', `${item.number}마디 박자표 분모`);
    for (const value of [1, 2, 4, 8, 16, 32]) {
      const option = element('option', '', String(value)); option.value = String(value); denominator.append(option);
    }
    denominator.value = String(item.denominator || 4);
    numeratorLabel.append(numerator, document.createTextNode('/'), denominator);
    meter.append(numeratorLabel);
    const voices = element('div', 'score-review-voices');
    card.append(meter, voices);
    const rows = item.voices?.length ? item.voices : [{ staff: 1, voice: 1, text: '' }];
    for (const row of rows) addVoice(voices, row.staff, row.voice, row.text);
    const actions = element('div', 'score-review-small-actions');
    const addPart = element('button', '', '＋ 성부'); addPart.type = 'button';
    addPart.addEventListener('click', () => {
      const staff = Number(voices.querySelector('.score-review-voice')?.dataset.staff || 1);
      const used = [...voices.querySelectorAll(`.score-review-voice[data-staff="${staff}"]`)].map(row => Number(row.dataset.voice));
      const next = [1, 2, 3, 4].find(number => !used.includes(number));
      if (next) addVoice(voices, staff, next);
      else status.textContent = '한 오선에 성부는 최대 4개까지 입력할 수 있습니다.';
    });
    const addStaff = element('button', '', '＋ 오선'); addStaff.type = 'button';
    addStaff.addEventListener('click', () => {
      const used = [...voices.querySelectorAll('.score-review-voice')].map(row => Number(row.dataset.staff));
      const next = [1, 2].find(number => !used.includes(number));
      if (next) addVoice(voices, next, 1);
      else status.textContent = 'MIDI 변환은 최대 2개 오선을 지원합니다.';
    });
    actions.append(addPart, addStaff);
    card.append(actions);
    return card;
  }

  function showReview(result, file) {
    clearReview();
    reviewState = result;
    bpmInput.value = String(result.draft.bpm);
    for (const item of result.review) reviewMeasures.append(reviewCard(item));
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    reviewPanel.hidden = false;
    status.textContent = `${result.review.length}개 마디의 판독을 확인해 주세요. 원본의 전체 마디 수가 맞는지도 확인하고, 빠진 마디는 추가하세요.`;
  }

  async function readResponse(response) {
    const body = await response.text();
    let result;
    try { result = JSON.parse(body); }
    catch {
      if (response.status === 404 || response.status === 405) throw new Error('악보 변환 API가 실행되지 않습니다. 로컬 개발 서버를 다시 시작해 주세요.');
      throw new Error(`서버 응답을 읽지 못했습니다. (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(result.error || '악보를 변환하지 못했습니다.');
    return result;
  }

  async function waitForTranscription(jobId) {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const response = await fetch(`/api/score-to-midi/status?id=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const result = await readResponse(response);
      if (result.status === 'completed') return result;
      const progress = result.progress || {};
      const range = Number.isInteger(progress.visualStart)
        ? `${progress.visualStart}${progress.visualEnd > progress.visualStart ? `~${progress.visualEnd}` : ''}번째 판독 구간 · ` : '';
      const elapsed = Number.isFinite(progress.startedAt) ? ` · 현재 단계 ${Math.floor((Date.now() - progress.startedAt) / 1000)}초` : '';
      status.textContent = progress.phase === 'layout'
        ? `마디 경계 확인 중… ${progress.page}/${progress.pageCount}페이지에서 ${progress.locatedMeasures}마디를 찾았습니다.`
        : progress.phase === 'validate' ? `전체 마디 연결과 MIDI 검증 중… ${progress.completedMeasures || 0}마디${elapsed}`
          : `악보 ${progress.phase === 'recheck' ? '오류 구간 재판독' : '판독'} 중… ${progress.pageCount ? `${progress.page}/${progress.pageCount}페이지 · ` : ''}${range}${progress.completedMeasures || 0}마디, ${progress.completedSegments || 0}개 구간 저장됨${elapsed}.`;
    }
  }

  input.addEventListener('change', () => {
    demoSelected = false;
    status.textContent = input.files[0] ? '악보 파일을 선택했습니다. 파일명을 눌러 다시 다운로드할 수 있습니다.' : 'PNG · JPEG · PDF, 최대 8MB';
    clearDownloads();
    clearReview();
  });

  document.getElementById('scoreAddMeasure').addEventListener('click', () => {
    if (!reviewState) return;
    const measures = reviewState.draft.measures;
    if (measures.length >= 500) { status.textContent = '최대 500마디까지 입력할 수 있습니다.'; return; }
    const last = measures.at(-1);
    const number = measures.length + 1;
    const item = { number, numerator: last?.numerator || 4, denominator: last?.denominator || 4, uncertain: true, issue: '추가한 마디입니다. 박자표와 음표를 확인해 주세요.', staves: [] };
    measures.push(item);
    reviewState.review.push({ ...item, voices: [{ staff: 1, voice: 1, text: '' }] });
    const card = reviewCard(reviewState.review.at(-1));
    reviewMeasures.append(card);
    card.scrollIntoView({ block: 'nearest' });
  });

  finalizeButton.addEventListener('click', async () => {
    if (!reviewState) return;
    const corrections = [];
    for (const card of reviewMeasures.querySelectorAll('.score-review-measure')) {
      const voices = [];
      for (const row of card.querySelectorAll('.score-review-voice')) {
        const field = row.querySelector('textarea');
        if (!field.value.trim() || field.value.includes('?')) {
          status.textContent = `${card.dataset.number}마디에 빈칸 또는 ?가 남아 있습니다. 원본을 보고 입력해 주세요.`;
          field.focus(); return;
        }
        voices.push({ staff: Number(row.dataset.staff), voice: Number(row.dataset.voice), text: field.value.trim() });
      }
      corrections.push({ number: Number(card.dataset.number), numerator: Number(card.querySelector('.score-review-numerator').value), denominator: Number(card.querySelector('.score-review-denominator').value), voices });
    }
    finalizeButton.disabled = true;
    status.textContent = '입력한 음표와 마디별 박자를 검증하고 MIDI를 만들고 있습니다…';
    try {
      const response = await fetch('/api/score-to-midi/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: reviewState.draft, corrections, bpm: Number(bpmInput.value) }) });
      showMidi(await readResponse(response), input.files[0].name.replace(/\.[^.]+$/, ''));
    } catch (error) { status.textContent = error.message || '수정한 악보를 변환하지 못했습니다.'; }
    finally { finalizeButton.disabled = false; }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = input.files[0];
    if (!file) return;
    if (!/\.(png|jpe?g|pdf)$/i.test(file.name) || file.size === 0 || file.size > 8 * 1024 * 1024) {
      status.textContent = 'PNG, JPEG 또는 PDF 파일(8MB 이하)을 선택해 주세요.';
      return;
    }
    button.disabled = true;
    demoButton.disabled = true;
    button.textContent = '악보 판독 중…';
    status.textContent = '음높이, 박자, 음표 길이를 확인하고 있습니다. 잠시 기다려 주세요.';
    clearDownloads();
    clearReview();
    try {
      if (demoSelected) {
        await new Promise(resolve => setTimeout(resolve, 450));
        await showDemoMidi();
        return;
      }
      const response = await fetch('/api/score-to-midi', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const started = await readResponse(response);
      const result = started.jobId ? await waitForTranscription(started.jobId) : started;
      const name = file.name.replace(/\.[^.]+$/, '');
      if (result.reviewRequired) showReview(result, file);
      else showMidi(result, name);
    } catch (error) {
      clearDownloads();
      status.textContent = error.message || '변환 중 오류가 발생했습니다.';
    } finally {
      button.disabled = false;
      demoButton.disabled = false;
      button.textContent = 'MIDI 변환';
    }
  });

  window.addEventListener('beforeunload', () => { clearDownloads(); clearReview(); });
})();
