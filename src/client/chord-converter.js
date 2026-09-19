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
  const rightDownload = document.getElementById('chordRightDownload');
  const leftDownload = document.getElementById('chordLeftDownload');
  const summary = document.getElementById('chordSummary');
  const unknowns = document.getElementById('chordUnknowns');
  const demoButton = document.getElementById('chordDemo');
  const demoFileLabel = document.getElementById('chordDemoFileLabel');
  const demoFileName = '코드악보_for_BYPP_hackathon_demo.jpg';
  const demoProgression = 'F | C/E | Am7/C# | Dm C | Bb | Am7 | A6 | Gm7 | Bb/C | F | C/E | Dm7 | BbM7 | F | C/E | Dm7 | BbM7 | Am7 | BbM7 | Am7 | BbM7 | Am7 | Dm7 | Eb EbM7(#11) Bb/C Fsus4/C';
  let demoMode = false;
  let pdfUrl = null;
  let midiUrls = [];

  function clearOutput() {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    for (const url of midiUrls) URL.revokeObjectURL(url);
    pdfUrl = null;
    midiUrls = [];
    pdfDownload.hidden = true;
    rightDownload.hidden = true;
    leftDownload.hidden = true;
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
    if (!data) throw new Error(response.status === 404 || response.status === 405 ? '악보 판독 기능에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' : `서버 응답을 읽지 못했습니다. (HTTP ${response.status})`);
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

  function unknownSlots(source) {
    const slots = [];
    const explicitBars = /[|\n]/.test(source);
    let bar = 1;
    let chord = 0;
    for (const match of source.matchAll(/\||\n|[^\s|\n]+/g)) {
      if (match[0] === '|' || match[0] === '\n') { bar++; chord = 0; continue; }
      if (!explicitBars && chord) { bar++; chord = 0; }
      chord++;
      if (match[0] === '?') slots.push({ start: match.index, end: match.index + 1, bar, chord });
    }
    return slots;
  }

  function renderUnknowns() {
    const slots = unknownSlots(progressionInput.value);
    unknowns.replaceChildren();
    unknowns.hidden = slots.length === 0;
    if (!slots.length) return 0;
    const heading = document.createElement('h3');
    heading.textContent = `확인 필요 · ? ${slots.length}곳`;
    const hint = document.createElement('p');
    hint.textContent = '오른쪽 칸에 코드를 직접 입력해 반영하세요. 코드와 마디 칸에서 ?를 바로 고쳐도 됩니다.';
    const list = document.createElement('div');
    list.className = 'chord-unknown-list';
    for (const [index, slot] of slots.entries()) {
      const row = document.createElement('div');
      row.className = 'chord-unknown-row';
      const label = document.createElement('label');
      label.htmlFor = `chordUnknown-${index}`;
      label.textContent = `${slot.bar}마디 · ${slot.chord}번째 코드 ?`;
      const input = document.createElement('input');
      input.id = `chordUnknown-${index}`;
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = '예: Cm7b5';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'button button-outline';
      apply.textContent = '반영';
      apply.addEventListener('click', () => {
        const symbol = input.value.trim();
        if (!symbol || /[\s|?]/.test(symbol)) { status.textContent = '코드 한 개를 공백이나 마디선 없이 입력해 주세요.'; input.focus(); return; }
        const current = unknownSlots(progressionInput.value)[index];
        if (!current) return;
        const source = progressionInput.value;
        progressionInput.value = source.slice(0, current.start) + symbol + source.slice(current.end);
        progressionInput.dispatchEvent(new Event('input', { bubbles: true }));
        const remaining = unknownSlots(progressionInput.value).length;
        status.textContent = remaining ? `남은 ? 코드 ${remaining}곳을 입력해 주세요.` : '모든 ? 코드를 입력했습니다. 원본과 대조한 뒤 악보를 생성해 주세요.';
      });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); apply.click(); } });
      row.append(label, input, apply);
      list.append(row);
    }
    unknowns.append(heading, hint, list);
    return slots.length;
  }

  for (const input of [titleInput, bpmInput, ...document.querySelectorAll('input[name="chordPattern"]')]) input.addEventListener('input', clearOutput);
  progressionInput.addEventListener('input', () => { clearOutput(); renderUnknowns(); });
  fileInput.addEventListener('change', () => {
    demoMode = false;
    demoFileLabel.hidden = true;
    clearOutput();
    if (fileInput.files[0]) status.textContent = '파일에서 코드를 읽을 준비가 됐습니다. 파일명을 눌러 다시 다운로드할 수 있습니다.';
  });

  demoButton.addEventListener('click', async () => {
    clearOutput();
    demoButton.disabled = true;
    try {
      const response = await fetch('./assets/demo/코드악보_for_BYPP_hackathon_demo.jpg');
      if (!response.ok) throw new Error('데모 파일을 불러오지 못했습니다.');
      const image = await response.blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([image], demoFileName, { type: 'image/jpeg' }));
      fileInput.files = transfer.files;
      window.dispatchEvent(new CustomEvent('keyroom:file-selected', { detail: { input: fileInput } }));
      demoMode = true;
      demoFileLabel.hidden = false;
      status.textContent = '데모 파일이 선택됐습니다. 파일명을 눌러 다운로드하거나 악보에서 코드 읽기를 눌러 주세요.';
    } catch (error) {
      status.textContent = '데모 파일을 선택하지 못했습니다. 다시 시도해 주세요.';
    } finally { demoButton.disabled = false; }
  });

  readButton.addEventListener('click', async () => {
    if (demoMode) {
      clearOutput();
      readButton.disabled = true;
      readButton.textContent = '코드 판독 중…';
      status.textContent = '데모 악보의 코드를 읽고 있습니다.';
      await new Promise(resolve => setTimeout(resolve, 450));
      titleInput.value = '음악은 참 이상하죠';
      progressionInput.value = demoProgression;
      renderUnknowns();
      status.textContent = '데모 코드의 마디를 읽었습니다. 코드와 마디 배치를 확인한 뒤 악보를 생성해 주세요.';
      readButton.disabled = false;
      readButton.textContent = '악보에서 코드 읽기';
      return;
    }
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
      const unknownCount = renderUnknowns();
      if (chart.title && !titleInput.value.trim()) titleInput.value = chart.title;
      const arrangementHint = chart.barsKnown
        ? `코드 ${chart.progression.split('|').length}마디를 읽었습니다. ${chart.warning || '원본과 코드·마디 배치를 대조한 뒤 생성해 주세요.'}`
        : `마디 배치가 불확실해 코드 하나를 4/4 한 마디로 배치했습니다. ${chart.warning || '원본을 보며 코드 변경 위치를 수정해 주세요.'}`;
      status.textContent = `${unknownCount ? `읽지 못한 코드 ${unknownCount}곳을 오른쪽 ? 칸에 입력해 주세요. ` : ''}${arrangementHint}`;
    } catch (error) { status.textContent = error.message || '코드를 읽지 못했습니다.'; }
    finally { readButton.disabled = false; readButton.textContent = '악보에서 코드 읽기'; }
  });

  makeButton.addEventListener('click', async () => {
    const progression = progressionInput.value.trim();
    if (!progression) { status.textContent = '코드 진행을 입력하거나 악보에서 코드를 읽어 주세요.'; progressionInput.focus(); return; }
    if (unknownSlots(progression).length) { status.textContent = '오른쪽 ? 칸을 모두 입력한 뒤 악보를 생성해 주세요.'; unknowns.querySelector('input')?.focus(); return; }
    const bpm = Number(bpmInput.value);
    if (!Number.isInteger(bpm) || bpm < 30 || bpm > 300) { status.textContent = 'BPM은 30~300으로 입력해 주세요.'; bpmInput.focus(); return; }
    const pattern = document.querySelector('input[name="chordPattern"]:checked')?.value || 'hold';
    clearOutput();
    makeButton.disabled = true;
    makeButton.textContent = '악보 생성 중…';
    status.textContent = '코드 구성음으로 양손 악보와 MIDI를 만들고 있습니다.';
    try {
      const response = await fetch('/api/chord-arrangement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progression, bpm, pattern, title: titleInput.value.trim() }) });
      const offline = (response.status === 404 || response.status === 405) && /\.chatgpt\.site$/.test(location.hostname);
      const result = offline
        ? await (await import('./chord-offline.js')).buildOfflineArrangement({ progression, bpm, pattern, title: titleInput.value.trim() })
        : await responseJson(response);
      const pdf = result.pdfBase64
        ? fromBase64(result.pdfBase64, 'application/pdf')
        : new Blob([await (await import('./chord-engraver.js')).engraveChordPdf({ progression, bpm, pattern, title: titleInput.value.trim() })], { type: 'application/pdf' });
      if (!result.rightMidiBase64 || !result.leftMidiBase64) throw new Error('양손 MIDI를 받지 못했습니다. 다시 시도해 주세요.');
      const right = fromBase64(result.rightMidiBase64, 'audio/midi');
      const left = fromBase64(result.leftMidiBase64, 'audio/midi');
      if (pdf.size < 100 || right.size < 30 || left.size < 30) throw new Error('생성된 파일이 올바르지 않습니다.');
      pdfUrl = URL.createObjectURL(pdf);
      pdfDownload.href = pdfUrl;
      pdfDownload.download = `${filename()}-chords.pdf`;
      pdfDownload.hidden = false;
      for (const [blob, hand, link] of [[right, 'right', rightDownload], [left, 'left', leftDownload]]) {
        const name = `${filename()}-chords-${hand}.mid`;
        const midiFile = new File([blob], name, { type: 'audio/midi' });
        const url = URL.createObjectURL(midiFile);
        midiUrls.push(url);
        link.href = url;
        link.download = name;
        link.hidden = false;
        window.dispatchEvent(new CustomEvent('keyroom:import-midi', { detail: { file: midiFile, hand } }));
      }
      renderSummary(result.summary);
      status.textContent = `${result.measureCount}마디 · ${result.noteCount}개 음표 · ${result.bpm} BPM으로 만들었습니다. 양손 MIDI를 각각 다운로드하고 별도 트랙에서 확인할 수 있습니다. 원본 코드와 마디 배치를 대조해 주세요.`;
    } catch (error) { clearOutput(); status.textContent = error.message || '악보와 MIDI를 만들지 못했습니다.'; }
    finally { makeButton.disabled = false; makeButton.textContent = '악보 · MIDI 생성'; }
  });

  window.addEventListener('beforeunload', clearOutput);
})();
