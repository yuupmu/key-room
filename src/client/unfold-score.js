(() => {
  'use strict';
  const form = document.getElementById('unfoldForm');
  const input = document.getElementById('unfoldInput');
  const button = document.getElementById('unfoldButton');
  const status = document.getElementById('unfoldStatus');
  const download = document.getElementById('unfoldDownload');
  const demo = document.getElementById('unfoldDemo');
  const demoOutput = './assets/demo/Merry-go-round-unfolded.pdf';
  let demoSelected = false;
  demo.addEventListener('click', async () => {
    demo.disabled = true;
    try {
      const response = await fetch('./assets/demo/Merry-go-round.pdf');
      if (!response.ok) throw new Error('데모 원본 PDF를 불러오지 못했습니다.');
      const pdf = await response.blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([pdf], 'Merry-go-round.pdf', { type: 'application/pdf' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      demoSelected = true;
      status.textContent = 'Merry-go-round.pdf 파일이 선택됐습니다. 악보 펼치기를 눌러 주세요.';
    } catch (error) { status.textContent = error.message; }
    finally { demo.disabled = false; }
  });
  let url = null;
  function clear() { if (url) URL.revokeObjectURL(url); url = null; download.hidden = true; download.href = '#'; download.textContent = 'PDF 다운로드'; }
  input.addEventListener('change', () => { clear(); demoSelected = false; status.textContent = input.files[0] ? '파일을 선택했습니다. 파일명을 눌러 다시 다운로드할 수 있습니다.' : 'PDF · MIDI, 최대 8MB'; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = input.files[0];
    if (!file) return;
    if (!/\.(pdf|mid|midi)$/i.test(file.name) || file.size === 0 || file.size > 8 * 1024 * 1024) { status.textContent = 'PDF 또는 MIDI 파일(8MB 이하)을 선택해 주세요.'; return; }
    const isDemo = demoSelected;
    clear(); button.disabled = true; demo.disabled = true; input.disabled = true; button.textContent = '악보 생성 중…';
    status.textContent = isDemo ? 'Merry-go-round.pdf의 연주 순서 악보를 만드는 중입니다…' : file.name.toLowerCase().endsWith('.pdf') ? '마디 위치와 이동 표식을 찾고 원본 악보를 재배치하는 중입니다.' : 'MIDI 조성을 분석하고 오선 악보를 조판하는 중입니다.';
    try {
      if (isDemo) {
        const [result] = await Promise.all([
          fetch(demoOutput, { method: 'HEAD' }),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
        if (!result.ok) throw new Error('데모 결과 PDF를 불러오지 못했습니다.');
        download.href = demoOutput;
        download.download = 'Merry-go-round-unfolded.pdf';
        download.textContent = '데모 결과 PDF 다운로드';
        download.hidden = false;
        status.textContent = '연주 순서 악보가 준비되었습니다. PDF를 다운로드해 원본과 대조해 주세요.';
        return;
      }
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
    finally { button.disabled = false; demo.disabled = false; input.disabled = false; button.textContent = '악보 펼치기'; }
  });
  window.addEventListener('beforeunload', clear);
})();
