(() => {
  'use strict';
  const button = document.getElementById('fateFlowerExample');
  const assets = [
    { path: './assets/example/Im-Here-example.mp3', name: 'Im-Here.mp3', type: 'audio/mpeg', key: 'audio' },
    { path: './assets/example/Im-Here-right.mid', name: 'Im-Here-right.mid', type: 'audio/midi', key: 'right' },
    { path: './assets/example/Im-Here-left.mid', name: 'Im-Here-left.mid', type: 'audio/midi', key: 'left' }
  ];

  button.addEventListener('click', async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'loading…';
    button.setAttribute('aria-busy', 'true');
    try {
      const entries = await Promise.all(assets.map(async asset => {
        const response = await fetch(asset.path);
        if (!response.ok) throw new Error('예제 파일을 불러오지 못했습니다.');
        return [asset.key, new File([await response.blob()], asset.name, { type: asset.type })];
      }));
      const files = Object.fromEntries(entries);
      await new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent('keyroom:load-practice-example', {
        detail: { ...files, leadIn: 0.75, label: '운명의 꽃', resolve, reject }
      })));
    } catch (error) {
      window.alert(error.message || '예제를 불러오지 못했습니다.');
    } finally {
      button.disabled = false;
      button.textContent = label;
      button.removeAttribute('aria-busy');
    }
  });
})();
