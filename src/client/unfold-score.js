(() => {
  'use strict';
  const form = document.getElementById('unfoldForm');
  const input = document.getElementById('unfoldInput');
  const button = document.getElementById('unfoldButton');
  const status = document.getElementById('unfoldStatus');
  const download = document.getElementById('unfoldDownload');
  let url = null;
  function clear() { if (url) URL.revokeObjectURL(url); url = null; download.hidden = true; }
  input.addEventListener('change', () => { clear(); status.textContent = input.files[0]?.name || 'PDF · MIDI, 최대 8MB'; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = input.files[0];
    if (!file) return;
    if (!/\.(pdf|mid|midi)$/i.test(file.name) || file.size === 0 || file.size > 8 * 1024 * 1024) { status.textContent = 'PDF 또는 MIDI 파일(8MB 이하)을 선택해 주세요.'; return; }
    clear(); button.disabled = true; button.textContent = '악보 생성 중…';
    status.textContent = file.name.toLowerCase().endsWith('.pdf') ? '악보의 음표와 이동 표식을 판독해 펼치는 중입니다.' : 'MIDI 조성을 분석하고 오선 악보를 조판하는 중입니다.';
    try {
      const response = await fetch('/api/unfold-score', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Score-Filename': encodeURIComponent(file.name) }, body: file });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `PDF 생성에 실패했습니다. (HTTP ${response.status})`); }
      const pdf = await response.blob();
      if (pdf.type !== 'application/pdf' || pdf.size < 100) throw new Error('서버가 올바른 PDF를 반환하지 않았습니다.');
      url = URL.createObjectURL(pdf);
      download.href = url;
      download.download = `${file.name.replace(/\.[^.]+$/, '')}-unfolded.pdf`;
      download.hidden = false;
      const source = response.headers.get('X-Source-Measures'), output = response.headers.get('X-Output-Measures');
      status.textContent = source && output ? `${source}마디를 연주 순서 ${output}마디로 조판했습니다. PDF를 다운로드해 원본과 대조해 주세요.` : '펼친 악보 PDF가 준비되었습니다. 원본과 대조해 주세요.';
    } catch (error) { status.textContent = error.message || '악보를 만들지 못했습니다.'; }
    finally { button.disabled = false; button.textContent = '악보 펼치기'; }
  });
  window.addEventListener('beforeunload', clear);
})();
