(() => {
  'use strict';

  // ---- 단어 구름 ----
  // 수업 처음과 끝에 같은 질문을 하고, 학생들이 낸 단어를 구름으로 보여 줍니다.
  // 단원 탐구 진술(동작의 개선은 기능 발달을 가져오고 자기효능감에 영향을 준다)과 가까운 단어는 색으로 강조합니다.
  // 단어는 SpeedWords 시트에 한 줄씩 저장하고, 오늘 낸 단어만 보여 줍니다.
  const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbw5mlmLxwSTXB7q7lsbqlGjWfkU9aTUwmwFSKeiK_Y9OyDX-eqx51AAkayE6qtAkCQS/exec';
  const QUESTION = '같은 거리를 더 빨리 달리려면 무엇이 중요할까요?';
  const PHASES = [
    { key: 'before', label: '수업 처음' },
    { key: 'after', label: '수업 끝' },
    { key: 'compare', label: '처음 ↔ 끝 비교' }
  ];
  // 탐구 진술의 세 부분과 가까운 단어. 띄어쓰기를 뺀 단어에 아래 말이 들어 있으면 그 묶음으로 셉니다.
  const GROUPS = [
    { key: 'move', cls: 'g-move', color: 'var(--blue-500)', label: '동작 개선', sub: '출발·방향 전환·보폭·효율',
      keys: ['동작', '자세', '개선', '효율', '출발', '전환', '방향', '턴', '회전', '낮추', '낮게', '숙이', '기울', '보폭', '보수', '걸음', '팔치기', '팔', '리듬', '기술', '감속', '가속', '멈추', '멈춤', '브레이크', '코너', '반환'] },
    { key: 'skill', cls: 'g-skill', color: '#0eae89', label: '기능 발달', sub: '속력·기록·페이스',
      // '빨리'·'빠르게'는 질문에 이미 있는 말이라 세지 않습니다.
      keys: ['속력', '속도', '기록', '향상', '발달', '성장', '페이스', '꾸준', '일정', '유지', '지구력', '스피드'] },
    { key: 'self', cls: 'g-self', color: '#f07b2f', label: '자기효능감', sub: '자신감·할 수 있다',
      keys: ['자신감', '효능감', '할수있', '해낼', '믿음', '성취', '뿌듯', '용기', '도전', '포기하지', '자신'] }
  ];
  const POLL_MS = 5000;
  const CLASS_KEY = 'movement-records-selected-class-v1';
  const PHASE_KEY = 'speed-words-phase-v1';

  let words = [];
  // 시트에 아직 안 들어간 단어(보내기 실패)는 이 화면에만 보여 줍니다.
  let pending = [];
  // highlight: 탐구 진술 단어만 색으로 (끄면 멘티미터처럼 모든 단어가 여러 색)
  const state = { classNo: 1, classes: [1], phase: 'before', sending: false, highlight: false };

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (v) => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const normalize = (w) => String(w).replace(/\s+/g, ' ').trim();
  const compact = (w) => normalize(w).replace(/ /g, '').toLowerCase();

  let toastTimer = null;
  function showToast(message) {
    window.clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3200);
  }

  function groupOf(word) {
    const c = compact(word);
    return GROUPS.find((g) => g.keys.some((k) => c.includes(k))) || null;
  }

  const isToday = (iso) => {
    const d = new Date(iso);
    return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString();
  };

  function wordsFor(phase) {
    return [...words, ...pending].filter((w) => Number(w.class) === state.classNo && w.phase === phase && isToday(w.created_at));
  }

  // 같은 단어(띄어쓰기 무시)를 묶어 개수를 셉니다.
  function tally(list) {
    const map = new Map();
    list.forEach((w) => {
      const key = compact(w.word);
      if (!key) return;
      const item = map.get(key) || { word: normalize(w.word), count: 0, group: groupOf(w.word) };
      item.count += 1;
      map.set(key, item);
    });
    return [...map.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'ko'));
  }

  function statsOf(list) {
    const byGroup = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
    list.forEach((w) => { const g = groupOf(w.word); if (g) byGroup[g.key] += 1; });
    const keyCount = Object.values(byGroup).reduce((a, b) => a + b, 0);
    return { total: list.length, keyCount, byGroup, pct: list.length ? Math.round((keyCount / list.length) * 100) : 0 };
  }

  // ---- 구름 그리기 ----
  // 멘티미터처럼 가장 많이 나온 단어를 가운데 두고, 나머지는 나선을 따라 바깥으로 빈자리를 찾아 놓습니다.
  // 일부 짧은 단어는 세로로 세웁니다. 위치는 단어로 정해져서 새로고침해도 그대로예요.
  const PALETTE = ['#4f8cff', '#13b98f', '#ff8a4c', '#9b6bff', '#ff5d8f', '#e0a300', '#1fa8c9', '#6c7cff', '#e5534b', '#3fa34d'];
  const MUTED = '#c3cad6';
  const hashOf = (text) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

  function colorOf(item, highlight) {
    if (highlight) return item.group ? item.group.color : MUTED;
    return PALETTE[hashOf(item.word) % PALETTE.length];
  }

  function findSpot(placed, w, h, W, H, seed, gap) {
    const cx = W / 2;
    const cy = H / 2;
    const stretch = Math.min(2.4, Math.max(1, W / H));
    const turn = (seed % 628) / 100;
    for (let t = 0; t < 900; t += 0.18) {
      const r = 3.2 * t;
      const x = cx + r * Math.cos(t + turn) * stretch - w / 2;
      const y = cy + r * Math.sin(t + turn) - h / 2;
      if (x < 0 || y < 0 || x + w > W || y + h > H) {
        if (r > Math.max(W, H)) return null;
        continue;
      }
      const hit = placed.some((p) => x < p.x + p.w + gap && x + w + gap > p.x && y < p.y + p.h + gap && y + h + gap > p.y);
      if (!hit) return { x, y };
    }
    return null;
  }

  function drawCloud(el, list, highlight) {
    const items = tally(list);
    const W = el.clientWidth;
    const H = el.clientHeight;
    const sig = JSON.stringify([items.map((it) => [it.word, it.count]), highlight, W, H]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const seen = el._seen || new Set();
    el.innerHTML = '';
    if (!items.length) {
      el.innerHTML = '<p class="cloud-empty">아직 단어가 없어요. 첫 단어를 보내 보세요!</p>';
      return;
    }
    const max = items[0].count;
    // 단어가 많을수록 조금씩 작게 그립니다.
    const top = Math.min(W * 0.16, H * 0.3) * (items.length > 30 ? 0.8 : 1);
    const low = Math.max(15, top * 0.3);
    const placed = [];
    items.forEach((it, i) => {
      const span = document.createElement('span');
      span.textContent = it.word;
      span.title = `${it.word} · ${it.count}명`;
      span.style.color = colorOf(it, highlight);
      if (highlight && it.group) span.classList.add('is-key');
      // 띄어쓰기 없는 2~4글자 단어 일부만 세로로 세웁니다.
      if (i > 0 && !it.word.includes(' ') && [...it.word].length >= 2 && [...it.word].length <= 4 && hashOf(it.word) % 10 < 3) span.classList.add('v');
      if (!seen.has(it.word)) span.classList.add('is-new');
      el.appendChild(span);
      let size = max > 1 ? low + (top - low) * Math.sqrt((it.count - 1) / (max - 1)) : (i === 0 ? top * 0.7 : low + (top - low) * 0.35);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        span.style.fontSize = `${Math.round(size)}px`;
        const spot = findSpot(placed, span.offsetWidth, span.offsetHeight, W, H, hashOf(it.word), Math.max(5, size * 0.08));
        if (spot) {
          span.style.left = `${spot.x}px`;
          span.style.top = `${spot.y}px`;
          placed.push({ x: spot.x, y: spot.y, w: span.offsetWidth, h: span.offsetHeight });
          return;
        }
        size *= 0.8;
      }
      span.remove();
    });
    el._seen = new Set(items.map((it) => it.word));
  }

  function statsHtml(list) {
    const s = statsOf(list);
    return `<span class="stat-chip">모인 단어 <strong>${s.total}</strong>개</span>
      <span class="stat-chip stat-chip--key">탐구 진술 단어 <strong>${s.keyCount}</strong>개 (${s.pct}%)</span>`;
  }

  const legendHtml = () => GROUPS.map((g) => `<span><i style="background:${g.color}"></i>${g.label} <small>(${g.sub})</small></span>`).join('')
    + '<span><i style="background:#8a96ab"></i>그 밖의 단어</span>';

  function render() {
    $('class-tabs').innerHTML = state.classes.map((c) => `<button type="button" class="class-tab${c === state.classNo ? ' is-selected' : ''}" role="tab" aria-selected="${c === state.classNo}" data-class="${c}">${c}반</button>`).join('');
    $('phase-tabs').innerHTML = PHASES.map((p) => `<button type="button" class="group-tab${p.key === state.phase ? ' is-selected' : ''}" role="tab" aria-selected="${p.key === state.phase}" data-phase="${p.key}">${p.label}</button>`).join('');
    const compare = state.phase === 'compare';
    $('ask-view').hidden = compare;
    $('compare-view').hidden = !compare;
    if (compare) {
      const before = wordsFor('before');
      const after = wordsFor('after');
      drawCloud($('before-cloud'), before, true);
      drawCloud($('after-cloud'), after, true);
      $('before-stats').innerHTML = statsHtml(before);
      $('after-stats').innerHTML = statsHtml(after);
      const b = statsOf(before);
      const a = statsOf(after);
      $('growth-row').innerHTML = GROUPS.map((g) => `<div class="growth-card">
          <b style="color:${g.color}">${g.label}</b><small>${g.sub}</small>
          <div class="nums">${b.byGroup[g.key]}<em> → </em>${a.byGroup[g.key]}<em>개</em></div>
        </div>`).join('');
      $('legend-compare').innerHTML = legendHtml();
      return;
    }
    const phase = PHASES.find((p) => p.key === state.phase);
    const list = wordsFor(state.phase);
    $('phase-label').textContent = `${state.classNo}반 · ${phase.label}`;
    $('question-text').textContent = QUESTION;
    $('cloud-title').textContent = `${state.classNo}반 ${phase.label} 단어 구름`;
    drawCloud($('cloud'), list, state.highlight);
    $('highlight-btn').textContent = state.highlight ? '🎨 모든 단어 색으로 보기' : '🔍 탐구 진술 단어 찾기';
    $('highlight-btn').classList.toggle('is-on', state.highlight);
    $('legend').hidden = !state.highlight;
    $('cloud-stats').innerHTML = statsHtml(list);
    $('legend').innerHTML = legendHtml();
    $('send-btn').disabled = state.sending;
  }

  // ---- 서버 ----
  async function refresh() {
    try {
      const res = await (await fetch(`${SHEETS_ENDPOINT}?action=speed_words`, { cache: 'no-store' })).json();
      if (!res.ok || !Array.isArray(res.data)) throw new Error('단어 응답 오류');
      words = res.data;
      render();
    } catch (error) {
      console.warn('단어를 불러오지 못했어요.', error);
    }
  }

  async function send(word) {
    const body = { type: 'speed_word', class: state.classNo, phase: state.phase, word };
    const response = await fetch(SHEETS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    return response.json();
  }

  async function submitWord(event) {
    event.preventDefault();
    const word = normalize($('word-input').value);
    if (!word || state.sending) return;
    state.sending = true;
    render();
    const local = { created_at: new Date().toISOString(), class: state.classNo, phase: state.phase, word };
    try {
      const res = await send(word);
      if (!res.ok) throw new Error(res.error?.message || '저장 실패');
      words.push(local);
      $('word-input').value = '';
      const g = groupOf(word);
      showToast(g ? `보냈어요! "${word}" → 탐구 진술의 ${g.label} 단어예요.` : '보냈어요! 다음 친구에게 넘겨 주세요.');
    } catch (error) {
      console.warn('단어 저장 실패', error);
      pending.push(local);
      $('word-input').value = '';
      showToast('시트에 저장하지 못해서 이 화면에만 보여요. 인터넷 연결을 확인해 주세요.');
    } finally {
      state.sending = false;
      render();
      $('word-input').focus();
    }
  }

  async function loadClasses() {
    try {
      const res = await (await fetch(`${SHEETS_ENDPOINT}?action=students`)).json();
      if (!res.ok) throw new Error(res.error?.message);
      const classes = [...new Set(res.data.map((r) => Number(r.class)).filter(Boolean))].sort((a, b) => a - b);
      if (classes.length) state.classes = classes;
    } catch (error) {
      console.warn('반 목록을 불러오지 못했어요.', error);
    }
    let stored = null;
    try { stored = Number(localStorage.getItem(CLASS_KEY)); } catch (e) { /* 무시 */ }
    state.classNo = state.classes.includes(stored) ? stored : state.classes[0];
  }

  // ---- 입력 ----
  document.addEventListener('click', (event) => {
    const t = event.target.closest('[data-class],[data-phase],[data-action]');
    if (!t) return;
    if (t.dataset.class) {
      state.classNo = Number(t.dataset.class);
      try { localStorage.setItem(CLASS_KEY, String(state.classNo)); } catch (e) { /* 무시 */ }
    } else if (t.dataset.phase) {
      state.phase = t.dataset.phase;
      try { localStorage.setItem(PHASE_KEY, state.phase); } catch (e) { /* 무시 */ }
    } else if (t.dataset.action === 'toggle-show') {
      setShow(!document.body.classList.contains('is-show'));
    } else if (t.dataset.action === 'toggle-highlight') {
      state.highlight = !state.highlight;
    }
    render();
  });
  $('send-form').addEventListener('submit', submitWord);

  function setShow(on) {
    document.body.classList.toggle('is-show', on);
    $('show-btn').textContent = on ? '✏️ 입력 화면으로' : '📺 화면에 띄우기';
  }

  // 화면 크기가 바뀌면 구름을 다시 배치합니다.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(render, 200);
  });

  async function init() {
    // 교사 현황의 '단어 구름 열기'는 ?show=1 로 열어 바로 크게 보여 줍니다.
    if (new URLSearchParams(window.location.search).get('show') === '1') setShow(true);
    try {
      const stored = localStorage.getItem(PHASE_KEY);
      if (PHASES.some((p) => p.key === stored)) state.phase = stored;
    } catch (e) { /* 무시 */ }
    render();
    await loadClasses();
    render();
    await refresh();
    // 다른 크롬북에서 보낸 단어도 보이도록 주기적으로 다시 불러옵니다.
    window.setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  init();
})();
