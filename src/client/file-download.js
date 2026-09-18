(() => {
  'use strict';
  const links = new Map();

  function show(input) {
    const link = links.get(input);
    if (!link) return;
    if (link.href) URL.revokeObjectURL(link.href);
    const file = input.files?.[0];
    link.removeAttribute('href');
    link.hidden = !file;
    if (!file) return;
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.textContent = file.name;
    link.title = `${file.name} 다운로드`;
    link.setAttribute('aria-label', `${file.name} 다운로드`);
  }

  for (const id of ['scoreInput', 'chordChartInput', 'unfoldInput']) {
    const input = document.getElementById(id);
    const link = document.createElement('a');
    link.className = 'source-file-download';
    link.hidden = true;
    input.insertAdjacentElement('afterend', link);
    input.classList.add('source-file-input');
    links.set(input, link);
    input.addEventListener('change', () => show(input));
  }
  window.addEventListener('keyroom:file-selected', event => show(event.detail.input));
  window.addEventListener('beforeunload', () => {
    for (const link of links.values()) if (link.href) URL.revokeObjectURL(link.href);
  });
})();
