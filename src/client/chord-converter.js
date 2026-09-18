(() => {
  'use strict';
  const fileInput = document.getElementById('chordChartInput');
  const readButton = document.getElementById('readChordChart');
  const titleInput = document.getElementById('chordTitle');
  const progressionInput = document.getElementById('chordProgression');
  const bpmInput = document.getElementById('chordBpm');
  const makeButton = document.getElementById('makeChordArrangement');
  const status = document.getElementById('chordStatus');
  const pdfDownload = document.getElementById('chordPdfDownload');
  const midiDownload = document.getElementById('chordMidiDownload');
  const summary = document.getElementById('chordSummary');
  let pdfUrl = null;
  let midiUrl = null;

  function clearOutput() {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    if (midiUrl) URL.revokeObjectURL(midiUrl);
    pdfUrl = null;
    midiUrl = null;
    pdfDownload.hidden = true;
    midiDownload.hidden = true;
    summary.hidden = true;
    summary.replaceChildren();
  }
  function fromBase64(value, type) {
    const binary = atob(value);
    return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type });
  }
  function filename() {
    return (titleInput.value.trim() || 'chord-arrangement').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
  }
  async function responseJson(response) {
    const data = await response.json().catch(() => null);
    if (!data) throw new Error(response.status === 404 || response.status === 405 ? '서버를 다시 시작해 새 변환 기능을 적용해 주세요.' : `서버 응답을 읽지 못했습니다. (HTTP ${response.status})`);
    if (!response.ok) throw new Error(data.error || `요청에 실패했습니다. (HTTP ${response.status})`);
    return data;
  }
  function renderSummary(bars) {
    const heading = document.createElement('h3');
    heading.textContent = '마디별 코드 구성음';
    const list = document.createElement('div');
    list.className = 'chord-summary-list';
    for (const bar of bars) {
      const item = document.createElement('div');
      item.className = 'chord-summary-item';
      const name = document.createElement('strong');
      name.textContent = `${bar.measure}마디 · ${bar.chords.map(chord => chord.symbol).join(' → ')}`;
      const tones = document.createElement('span');
      tones.textContent = bar.chords.map(chord => `왼손 ${chord.bass} / 오른손 ${chord.tones.join('·')}`).join('  ·  ');
      item.append(name, tones);
      list.append(item);
    }
    summary.replaceChildren(heading, list);
    summary.hidden = false;
  }

  for (const input of [titleInput, progressionInput, bpmInput, ...document.querySelectorAll('input[name="chordPattern"]')]) input.addEventListener('input', clearOutput);
  fileInput.addEventListener('change', () => { clearOutput(); if (fileInput.files[0]) status.textContent = `${fileInput.files[0].name}에서 코드를 읽을 준비가 됐습니다.`; });

  readButton.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) { status.textContent = '코드 악보 파일을 먼저 선택해 주세요.'; return; }
    if (!/\.(png|jpe?g|pdf)$/i.test(file.name) || file.size === 0 || file.size > 8 * 1024 * 1024) { status.textContent = 'PNG, JPEG 또는 PDF 파일(8MB 이하)을 선택해 주세요.'; return; }
    clearOutput();
    readButton.disabled = true;
    readButton.textContent = '코드 판독 중…';
    status.textContent = '악보의 코드를 읽고 있습니다. 결과의 마디 배치를 확인해 주세요.';
    try {
      const response = await fetch('/api/chord-chart', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const chart = await responseJson(response);
      progressionInput.value = chart.progression;
      if (chart.title && !titleInput.value.trim()) titleInput.value = chart.title;
      status.textContent = chart.barsKnown
        ? `코드 ${chart.progression.split('|').length}마디를 읽었습니다. ${chart.warning || '원본과 코드·마디 배치를 대조한 뒤 생성해 주세요.'}`
        : `마디선이 없어 코드 하나를 4/4 한 마디로 배치했습니다. ${chart.warning || '원본을 보며 코드 변경 위치를 수정해 주세요.'}`;
    } catch (error) { status.textContent = error.message || '코드를 읽지 못했습니다.'; }
    finally { readButton.disabled = false; readButton.textContent = '악보에서 코드 읽기'; }
  });

  makeButton.addEventListener('click', async () => {
    const progression = progressionInput.value.trim();
    if (!progression) { status.textContent = '코드 진행을 입력하거나 악보에서 코드를 읽어 주세요.'; progressionInput.focus(); return; }
    const bpm = Number(bpmInput.value);
    if (!Number.isInteger(bpm) || bpm < 30 || bpm > 300) { status.textContent = 'BPM은 30~300으로 입력해 주세요.'; bpmInput.focus(); return; }
    const pattern = document.querySelector('input[name="chordPattern"]:checked')?.value || 'hold';
    clearOutput();
    makeButton.disabled = true;
    makeButton.textContent = '악보 생성 중…';
    status.textContent = '코드 구성음으로 양손 악보와 MIDI를 만들고 있습니다.';
    try {
      const response = await fetch('/api/chord-arrangement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progression, bpm, pattern, title: titleInput.value.trim() }) });
      const result = await responseJson(response);
      const pdf = fromBase64(result.pdfBase64, 'application/pdf');
      const midi = fromBase64(result.midiBase64, 'audio/midi');
      if (pdf.size < 100 || midi.size < 30) throw new Error('생성된 파일이 올바르지 않습니다.');
      pdfUrl = URL.createObjectURL(pdf);
      midiUrl = URL.createObjectURL(midi);
      pdfDownload.href = pdfUrl;
      pdfDownload.download = `${filename()}-chords.pdf`;
      pdfDownload.hidden = false;
      midiDownload.href = midiUrl;
      midiDownload.download = `${filename()}-chords.mid`;
      midiDownload.hidden = false;
      renderSummary(result.summary);
      const midiFile = new File([midi], midiDownload.download, { type: 'audio/midi' });
      window.dispatchEvent(new CustomEvent('keyroom:import-midi', { detail: { file: midiFile } }));
      status.textContent = `${result.measureCount}마디 · ${result.noteCount}개 음표 · ${result.bpm} BPM으로 만들었습니다. MIDI 트랙에도 불러왔습니다. 원본 코드와 마디 배치를 대조해 주세요.`;
    } catch (error) { status.textContent = error.message || '악보와 MIDI를 만들지 못했습니다.'; }
    finally { makeButton.disabled = false; makeButton.textContent = '악보 · MIDI 생성'; }
  });

  window.addEventListener('beforeunload', clearOutput);
})();
