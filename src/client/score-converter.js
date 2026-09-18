(() => {
  'use strict';
  const form = document.getElementById('scoreConvertForm');
  const input = document.getElementById('scoreInput');
  const button = document.getElementById('scoreConvertButton');
  const status = document.getElementById('scoreConvertStatus');
  const download = document.getElementById('scoreDownload');
  let downloadUrl = null;

  input.addEventListener('change', () => {
    status.textContent = input.files[0]?.name || 'PNG · JPEG · PDF, 최대 8MB';
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    download.hidden = true;
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
    button.textContent = '악보 판독 중…';
    status.textContent = '음높이, 박자, 음표 길이를 확인하고 있습니다. 잠시 기다려 주세요.';
    download.hidden = true;
    try {
      const response = await fetch('/api/score-to-midi', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const body = await response.text();
      let result;
      try { result = JSON.parse(body); }
      catch {
        if (response.status === 404 || response.status === 405) throw new Error('악보 변환 API가 실행되지 않습니다. 로컬 개발 서버를 다시 시작해 주세요.');
        throw new Error(`서버 응답을 읽지 못했습니다. (HTTP ${response.status})`);
      }
      if (!response.ok) throw new Error(result.error || '악보를 변환하지 못했습니다.');
      const binary = atob(result.midiBase64);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const name = file.name.replace(/\.[^.]+$/, '') + '.mid';
      const midiFile = new File([bytes], name, { type: 'audio/midi' });
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(midiFile);
      download.href = downloadUrl;
      download.download = name;
      download.hidden = false;
      window.dispatchEvent(new CustomEvent('keyroom:import-midi', { detail: { file: midiFile } }));
      status.textContent = `${result.measureCount}마디 · ${result.noteCount}개 음표 · ${result.bpm} BPM 변환 완료. MIDI 트랙에 불러왔습니다. 피아노롤에서 원본 악보와 대조해 주세요.`;
    } catch (error) {
      status.textContent = error.message || '변환 중 오류가 발생했습니다.';
    } finally {
      button.disabled = false;
      button.textContent = 'MIDI 변환';
    }
  });

  window.addEventListener('beforeunload', () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
})();
