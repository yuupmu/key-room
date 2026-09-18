(() => {
  'use strict';
  const launcher = document.getElementById('songAssistantLauncher');
  const panel = document.getElementById('songAssistantPanel');
  const closeButton = document.getElementById('songAssistantClose');
  const form = document.getElementById('songAssistantForm');
  const input = document.getElementById('songAssistantInput');
  const submit = document.getElementById('songAssistantSubmit');
  const content = document.getElementById('songAssistantContent');
  let focusBeforeOpen = null;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  }

  function link(url, title, className = '') {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      const anchor = element('a', className, title);
      anchor.href = parsed.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      return anchor;
    } catch { return null; }
  }

  function open() {
    focusBeforeOpen = document.activeElement;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  function close() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    (focusBeforeOpen?.isConnected ? focusBeforeOpen : launcher).focus();
  }

  function fact(label, item) {
    const card = element('div', 'song-assistant-fact');
    card.append(element('span', '', label), element('strong', '', item?.value || '정보 없음'));
    if (item?.value) {
      if (item.detail) card.append(element('small', '', item.detail));
      const source = link(item.sourceUrl, '근거 보기 ↗');
      if (source) card.append(source);
    } else card.append(element('small', '', '확인된 정보가 없습니다.'));
    return card;
  }

  function section(title, items, fallbackUrl, fallbackLabel) {
    const area = element('section', 'song-assistant-section');
    area.append(element('h3', '', title));
    for (const item of items || []) {
      const anchor = link(item.url, '', 'song-assistant-link');
      if (!anchor) continue;
      anchor.append(element('strong', '', `${item.title} ↗`));
      if (item.detail) anchor.append(element('small', '', item.detail));
      area.append(anchor);
    }
    if (!area.querySelector('.song-assistant-link')) area.append(element('p', 'song-assistant-empty', '확인된 직접 링크가 없습니다.'));
    const fallback = link(fallbackUrl, fallbackLabel, 'song-assistant-fallback');
    if (fallback) area.append(fallback);
    return area;
  }

  function render(result, query) {
    const title = result.song || query;
    const heading = element('h3', 'song-assistant-result-title', title);
    const artist = element('p', 'song-assistant-artist', result.artist || '아티스트 정보 미확인');
    const facts = element('div', 'song-assistant-facts');
    facts.append(fact('BPM', result.bpm), fact('보컬 음역', result.vocalRange));
    const scoreSearch = `https://www.google.com/search?q=${encodeURIComponent(`${query} 악보 구매 판매`)}`;
    const videoSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${query} 악보 연주`)}`;
    content.replaceChildren(heading, artist, facts,
      section('악보 판매처', result.scores, scoreSearch, '악보 판매 검색 결과 보기 ↗'),
      section('연주 · 악보 영상', result.videos, videoSearch, '유튜브 검색 결과 보기 ↗'));
    if (result.note) content.append(element('p', 'song-assistant-note', result.note));
    content.scrollTop = 0;
  }

  launcher.addEventListener('click', () => panel.hidden ? open() : close());
  closeButton.addEventListener('click', close);
  document.getElementById('drawerSongSearch').addEventListener('click', () => {
    document.getElementById('closeResources').click();
    open();
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (query.length < 2) { content.replaceChildren(element('p', 'song-assistant-error', '곡명을 두 글자 이상 입력해 주세요.')); return; }
    submit.disabled = true;
    submit.textContent = '찾는 중';
    content.replaceChildren(element('p', 'song-assistant-loading', '악보와 영상, 연습 정보를 웹에서 찾고 있어요…'));
    try {
      const response = await fetch('/api/song-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query })
      });
      let result;
      try { result = await response.json(); }
      catch { throw new Error('검색 API에 연결할 수 없습니다. 서버 설정을 확인해 주세요.'); }
      if (!response.ok) throw new Error(result.error || '검색에 실패했습니다. 다시 시도해 주세요.');
      render(result, query);
    } catch (error) {
      content.replaceChildren(element('p', 'song-assistant-error', error.message || '검색에 실패했습니다. 다시 시도해 주세요.'));
    } finally {
      submit.disabled = false;
      submit.textContent = '찾기';
    }
  });
})();
