(() => {
  'use strict';

  // ---- 속력 탐구 ----
  // 같은 40m를 5m×4, 10m×2, 20m×1 왕복으로 달리고 평균속력(40m ÷ 기록)을 비교합니다.
  // 기록은 기존 Records 시트에 activity_type(speed_5x4 / speed_10x2 / speed_20x1)으로 구분해 저장합니다.
  // 기존 장애물달리기(obstacle_run) 화면과 랭킹에는 섞이지 않습니다.
  const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbw5mlmLxwSTXB7q7lsbqlGjWfkU9aTUwmwFSKeiK_Y9OyDX-eqx51AAkayE6qtAkCQS/exec';
  const DISTANCE_M = 40;
  const METHODS = [
    { key: '5x4', type: 'speed_5x4', label: '5m×4', turns: 7 },
    { key: '10x2', type: 'speed_10x2', label: '10m×2', turns: 3 },
    { key: '20x1', type: 'speed_20x1', label: '20m×1', turns: 1 }
  ];
  const METHOD_BY_TYPE = Object.fromEntries(METHODS.map((m) => [m.type, m]));
  const MIN_SEC = 3;
  const CHECK_MAX_SEC = 40;
  const ENTER_STOP_GUARD_MS = 300;
  // 걸음 수(보수)는 시트 구조를 바꾸지 않도록 이 기기에만 저장합니다. {student_id: 걸음 수}
  const STEPS_KEY = 'speed-steps-v1';
  const CLASS_KEY = 'movement-records-selected-class-v1';

  let students = [];
  let records = [];
  const state = {
    screen: 'pick', classNo: null, group: '', studentId: null, method: null,
    timer: 'idle', startedAt: 0, elapsedMs: 0, timerId: null, pending: null, saving: false
  };

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (v) => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const speedOf = (sec) => DISTANCE_M / Number(sec);
  const fmtSpeed = (v) => `${v.toFixed(2)} m/s`;

  function readSteps() {
    try { return JSON.parse(localStorage.getItem(STEPS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeSteps(steps) {
    try { localStorage.setItem(STEPS_KEY, JSON.stringify(steps)); } catch (e) { /* 저장소를 못 쓰면 이번 화면에서만 씀 */ }
  }
  const strideOf = (studentId) => {
    const steps = Number(readSteps()[studentId]);
    return steps > 0 ? 20 / steps : null;
  };

  let toastTimer = null;
  function showToast(message) {
    window.clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3200);
  }

  function setScreen(name) {
    state.screen = name;
    document.querySelectorAll('[data-screen]').forEach((el) => { el.hidden = el.dataset.screen !== name; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const getStudent = (id) => students.find((s) => s.student_id === id);
  const speedRecordsOf = (id) => records.filter((r) => r.student_id === id && METHOD_BY_TYPE[r.activity_type]);

  // 방식별 가장 빠른 평균속력 {5x4: 4.1, ...}
  function bestSpeeds(id) {
    const best = {};
    speedRecordsOf(id).forEach((r) => {
      const m = METHOD_BY_TYPE[r.activity_type];
      const v = speedOf(r.record_seconds);
      if (!best[m.key] || v > best[m.key]) best[m.key] = v;
    });
    return best;
  }

  // ---- 학생 선택 ----
  function groupsOf(classNo) {
    return [...new Set(students.filter((s) => s.class === classNo).map((s) => s.group_or_team))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  }
  function renderPick() {
    const classes = [...new Set(students.map((s) => s.class))].sort((a, b) => a - b);
    $('class-tabs').innerHTML = classes.map((c) => `<button type="button" class="sp-tab${c === state.classNo ? ' is-selected' : ''}" data-class="${c}">${c}반</button>`).join('');
    const groups = groupsOf(state.classNo);
    if (!groups.includes(state.group)) state.group = groups[0] ?? '';
    $('group-tabs').innerHTML = groups.map((g) => `<button type="button" class="sp-tab${g === state.group ? ' is-selected' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
    const list = students.filter((s) => s.class === state.classNo && s.group_or_team === state.group);
    $('pick-empty').hidden = list.length > 0;
    $('pick-empty').textContent = '이 조에는 학생이 없어요.';
    $('students-grid').innerHTML = list.map((s) => {
      const best = bestSpeeds(s.student_id);
      const dots = METHODS.map((m) => `<span class="sp-dot${best[m.key] ? ' is-done' : ''}">${best[m.key] ? '✓ ' : ''}${m.label}</span>`).join('');
      return `<button type="button" class="sp-card" data-student="${escapeHtml(s.student_id)}">
        <h3>${escapeHtml(s.name)}</h3><span class="meta">${escapeHtml(s.number)}번 · ${escapeHtml(s.group_or_team)}</span>
        <div class="sp-dots">${dots}</div></button>`;
    }).join('');
  }

  // ---- 측정 ----
  function renderRun() {
    const student = getStudent(state.studentId);
    if (!student) return;
    const best = bestSpeeds(student.student_id);
    $('run-name').textContent = `${student.name} 달리기`;
    $('methods').innerHTML = METHODS.map((m) => `
      <button type="button" class="sp-method${state.method === m.key ? ' is-selected' : ''}" data-method="${m.key}" ${state.timer === 'running' ? 'disabled' : ''}>
        ${best[m.key] ? '<span class="check">✓</span> ' : ''}${m.label}<small>방향 전환 ${m.turns}번</small></button>`).join('');
    const seconds = state.timer === 'running' ? (performance.now() - state.startedAt) / 1000 : state.elapsedMs / 1000;
    $('digits').innerHTML = `${seconds.toFixed(2)}<small>초</small>`;
    $('start-btn').disabled = state.timer !== 'idle' || !state.method;
    $('stop-btn').disabled = state.timer !== 'running';
    $('run-hint').textContent = state.timer === 'running' ? '도착하면 STOP(또는 Enter)!' : (state.method ? 'START(또는 Enter)를 누르면 출발이에요.' : '먼저 위에서 이번에 뛸 방식을 고르세요.');
  }

  function openRun(studentId) {
    state.studentId = studentId;
    state.method = null;
    state.timer = 'idle';
    state.elapsedMs = 0;
    setScreen('run');
    renderRun();
  }

  function start() {
    if (state.timer !== 'idle' || !state.method) return;
    state.timer = 'running';
    state.startedAt = performance.now();
    window.timerBeep?.('start');
    state.timerId = window.setInterval(renderRun, 40);
    renderRun();
  }

  function stop() {
    if (state.timer !== 'running') return;
    window.clearInterval(state.timerId);
    state.elapsedMs = performance.now() - state.startedAt;
    window.timerBeep?.('stop');
    const sec = Number((state.elapsedMs / 1000).toFixed(2));
    if (sec < MIN_SEC) {
      state.timer = 'idle';
      state.elapsedMs = 0;
      renderRun();
      showToast(`기록이 ${MIN_SEC}초보다 짧아서 인정되지 않았어요. 다시 달려 주세요.`);
      return;
    }
    state.timer = 'stopped';
    const method = METHODS.find((m) => m.key === state.method);
    const student = getStudent(state.studentId);
    state.pending = {
      timestamp: new Date().toISOString(),
      student_id: student.student_id,
      attempt_no: speedRecordsOf(student.student_id).length + 1,
      record_seconds: sec,
      activity_type: method.type
    };
    $('confirm-who').textContent = `${student.name} · ${method.label} (40m)`;
    $('confirm-time').innerHTML = `${sec.toFixed(2)}<small>초</small>`;
    $('confirm-speed').textContent = `평균속력 ${fmtSpeed(speedOf(sec))}`;
    $('steps-box').hidden = method.key !== '20x1';
    $('steps-input').value = readSteps()[student.student_id] || '';
    updateStridePreview();
    $('save-btn').disabled = false;
    setScreen('confirm');
    if (sec > CHECK_MAX_SEC) showToast(`기록이 ${CHECK_MAX_SEC}초보다 길어요. STOP을 늦게 눌렀다면 취소해 주세요.`);
  }

  function updateStridePreview() {
    const steps = Number($('steps-input').value);
    $('stride-preview').textContent = steps > 0 ? `내 평균 보폭은 약 ${(20 / steps).toFixed(2)} m예요.` : '걸음 수를 넣으면 보폭이 계산돼요.';
  }

  async function save() {
    if (state.timer !== 'stopped' || !state.pending || state.saving) return;
    state.saving = true;
    $('save-btn').disabled = true;
    const record = state.pending;
    const steps = Number($('steps-input').value);
    if (!$('steps-box').hidden && steps >= 5 && steps <= 60) {
      const all = readSteps();
      all[record.student_id] = steps;
      writeSteps(all);
    }
    try {
      const res = await postJson({
        type: 'record',
        record: {
          student_id: record.student_id,
          attempt_no: record.attempt_no,
          record_seconds: record.record_seconds,
          activity_type: record.activity_type,
          record_id: `${record.student_id}_${record.activity_type}_${Math.round(record.record_seconds * 100)}_${record.timestamp}`
        }
      });
      if (!res.ok) throw new Error(res.error?.message || '저장 실패');
      records.push(record);
      state.saving = false;
      state.pending = null;
      state.timer = 'idle';
      state.elapsedMs = 0;
      openResult();
      showToast('저장했어요!');
    } catch (error) {
      console.error('속력 기록 저장 실패', error);
      state.saving = false;
      $('save-btn').disabled = false;
      showToast('저장하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
    }
  }

  // ---- 내 결과 ----
  function barsHtml(values) {
    const max = Math.max(...METHODS.map((m) => values[m.key] || 0), 0.01);
    const bestKey = METHODS.reduce((b, m) => ((values[m.key] || 0) > (values[b] || 0) ? m.key : b), METHODS[0].key);
    return METHODS.map((m) => {
      const v = values[m.key];
      return `<div class="sp-bar${v && m.key === bestKey ? ' best' : ''}"><span>${m.label}</span>
        <span class="track"><span class="fill" style="display:block;width:${v ? (v / max) * 100 : 0}%"></span></span>
        <span class="val">${v ? fmtSpeed(v) : '아직 안 뜀'}</span></div>`;
    }).join('');
  }

  function openResult() {
    const student = getStudent(state.studentId);
    if (!student) return;
    $('result-name').textContent = `${student.name}의 결과`;
    $('result-bars').innerHTML = barsHtml(bestSpeeds(student.student_id));
    const stride = strideOf(student.student_id);
    $('result-stride').textContent = stride ? `보폭: 약 ${stride.toFixed(2)} m (20m를 ${readSteps()[student.student_id]}걸음)` : '20m×1을 뛸 때 짝이 걸음 수를 세면 보폭도 나와요.';
    $('coach-box').hidden = true;
    setScreen('result');
  }

  async function coach() {
    const speeds = bestSpeeds(state.studentId);
    if (!speeds['5x4'] && !speeds['10x2'] && !speeds['20x1']) {
      showToast('먼저 한 가지 이상 달려 주세요.');
      return;
    }
    $('coach-btn').disabled = true;
    $('coach-box').hidden = false;
    $('coach-box').textContent = 'AI가 기록을 살펴보는 중이에요...';
    // 이름은 보내지 않고 숫자만 보냅니다.
    const body = { type: 'speed_coach', speeds: roundAll(speeds), stride: strideOf(state.studentId) };
    try {
      const res = await postJson(body);
      if (!res.ok) throw new Error(res.error?.message);
      showCoach('coach-box', res.text, res.source);
    } catch (error) {
      console.warn('AI 코칭 실패, 기본 코칭을 보여 줘요.', error);
      showCoach('coach-box', localCoach(speeds), 'rule');
    } finally {
      $('coach-btn').disabled = false;
    }
  }

  function showCoach(boxId, text, source) {
    $(boxId).innerHTML = `${escapeHtml(text)}<span class="src">${source === 'ai' ? 'AI 코칭' : '기본 코칭 (AI 연결 전)'}</span>`;
  }

  // 서버에 닿지 못할 때 쓰는 기본 코칭 (Code.gs의 규칙과 같은 내용)
  function localCoach(s) {
    if (s['20x1'] && s['5x4']) {
      const loss = Math.round((1 - s['5x4'] / s['20x1']) * 100);
      if (loss >= 20) return `5m 왕복에서 속력이 ${loss}% 떨어졌어요. 방향을 바꾸기 2~3걸음 전부터 보폭을 줄이고 자세를 낮춰 보세요.`;
      return `방향 전환이 많아도 속력을 잘 지켰어요(차이 ${loss}%). 이번엔 출발할 때 몸을 낮추고 짧고 빠른 걸음으로 시작해 보세요.`;
    }
    return '세 가지 방식을 모두 달려 보면 어디에서 속력을 잃는지 비교할 수 있어요.';
  }

  const roundAll = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v.toFixed(2))]));

  // ---- 우리 반 현황 ----
  function classSummary() {
    const list = students.filter((s) => s.class === state.classNo);
    const sums = {}; const counts = {};
    const ranking = [];
    list.forEach((s) => {
      const best = bestSpeeds(s.student_id);
      METHODS.forEach((m) => {
        if (best[m.key]) { sums[m.key] = (sums[m.key] || 0) + best[m.key]; counts[m.key] = (counts[m.key] || 0) + 1; }
      });
      const top = Math.max(0, ...Object.values(best));
      if (top > 0) {
        const topKey = Object.keys(best).find((k) => best[k] === top);
        ranking.push({ name: s.name, group: s.group_or_team, speed: top, method: METHODS.find((m) => m.key === topKey).label });
      }
    });
    const avg = {};
    METHODS.forEach((m) => { if (counts[m.key]) avg[m.key] = sums[m.key] / counts[m.key]; });
    ranking.sort((a, b) => b.speed - a.speed);
    return { avg, counts, ranking, runners: ranking.length };
  }

  function renderBoard() {
    const sum = classSummary();
    $('board-title').textContent = `${state.classNo}반 현황`;
    $('board-bars').innerHTML = barsHtml(sum.avg);
    $('rank-body').innerHTML = sum.ranking.length
      ? sum.ranking.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.name)} <span class="sp-note">${escapeHtml(r.group)}</span></td><td>${r.method}</td><td class="num">${fmtSpeed(r.speed)}</td></tr>`).join('')
      : '<tr><td class="sp-note">아직 기록이 없어요.</td></tr>';
  }

  function openBoard() {
    renderBoard();
    $('class-ai-box').hidden = true;
    setScreen('board');
    // 다른 크롬북에서 저장한 기록도 보이도록 시트에서 다시 불러와 그립니다.
    refreshRecords().then((ok) => { if (ok && state.screen === 'board') renderBoard(); });
  }

  async function classAi() {
    const sum = classSummary();
    if (!sum.runners) { showToast('아직 우리 반 기록이 없어요.'); return; }
    $('class-ai-btn').disabled = true;
    $('class-ai-box').hidden = false;
    $('class-ai-box').textContent = 'AI가 우리 반 기록을 분석하는 중이에요...';
    // 반 전체 평균 숫자만 보냅니다. 이름은 보내지 않습니다.
    const body = { type: 'speed_class', summary: { runners: sum.runners, avg: roundAll(sum.avg), counts: sum.counts } };
    try {
      const res = await postJson(body);
      if (!res.ok) throw new Error(res.error?.message);
      showCoach('class-ai-box', res.text, res.source);
    } catch (error) {
      console.warn('AI 반 분석 실패', error);
      const a = sum.avg;
      const text = a['20x1'] && a['5x4']
        ? `우리 반은 5m×4에서 20m×1보다 평균속력이 ${Math.round((1 - a['5x4'] / a['20x1']) * 100)}% 느렸어요. 방향을 바꿀 때마다 멈췄다가 다시 가속하느라 시간이 들기 때문이에요.`
        : '세 가지 방식 기록이 더 모이면 비교할 수 있어요.';
      showCoach('class-ai-box', text, 'rule');
    } finally {
      $('class-ai-btn').disabled = false;
    }
  }

  // ---- 서버 ----
  async function postJson(body) {
    // Apps Script는 application/json 사전 확인(CORS)을 지원하지 않아 text/plain으로 보냅니다.
    const response = await fetch(SHEETS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    return response.json();
  }

  async function refreshRecords() {
    try {
      const res = await (await fetch(`${SHEETS_ENDPOINT}?action=records`)).json();
      if (!res.ok || !Array.isArray(res.data)) throw new Error('기록 응답 오류');
      records = res.data.filter((r) => METHOD_BY_TYPE[r.activity_type]).map((r) => ({
        timestamp: String(r.timestamp), student_id: String(r.student_id), attempt_no: Number(r.attempt_no),
        record_seconds: Number(r.record_seconds), activity_type: r.activity_type
      }));
      return true;
    } catch (error) {
      console.warn('시트 기록을 불러오지 못했어요.', error);
      return false;
    }
  }

  async function init() {
    try {
      const res = await (await fetch(`${SHEETS_ENDPOINT}?action=students`)).json();
      if (!res.ok) throw new Error(res.error?.message);
      students = res.data.map((r) => ({
        student_id: String(r.student_id), class: Number(r.class), number: Number(r.number),
        name: String(r.name), group_or_team: String(r.group_or_team)
      }));
    } catch (error) {
      console.error(error);
      $('pick-empty').textContent = '학생 명단을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.';
      return;
    }
    const classes = [...new Set(students.map((s) => s.class))].sort((a, b) => a - b);
    const stored = Number(localStorage.getItem(CLASS_KEY));
    state.classNo = classes.includes(stored) ? stored : classes[0];
    renderPick();
    if (await refreshRecords()) renderPick();
  }

  // ---- 입력 ----
  document.addEventListener('click', (event) => {
    const t = event.target.closest('[data-class],[data-group],[data-student],[data-method],[data-action]');
    if (!t) return;
    if (state.timer === 'running' && !t.matches('[data-action="stop"]')) { showToast('측정 중이에요. 먼저 STOP을 눌러 주세요.'); return; }
    if (t.dataset.class) { state.classNo = Number(t.dataset.class); try { localStorage.setItem(CLASS_KEY, String(state.classNo)); } catch (e) { /* 무시 */ } renderPick(); return; }
    if (t.dataset.group !== undefined && !t.dataset.action) { state.group = t.dataset.group; renderPick(); return; }
    if (t.dataset.student) { openRun(t.dataset.student); return; }
    if (t.dataset.method) { state.method = t.dataset.method; renderRun(); return; }
    const action = t.dataset.action;
    if (action === 'start') start();
    else if (action === 'stop') stop();
    else if (action === 'save') save();
    else if (action === 'cancel') { state.timer = 'idle'; state.elapsedMs = 0; state.pending = null; setScreen('run'); renderRun(); showToast('저장하지 않았어요.'); }
    else if (action === 'open-result') openResult();
    else if (action === 'back-run') openRun(state.studentId);
    else if (action === 'coach') coach();
    else if (action === 'go-pick') { setScreen('pick'); renderPick(); }
    else if (action === 'go-board') openBoard();
    else if (action === 'class-ai') classAi();
  });

  $('steps-input').addEventListener('input', updateStridePreview);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.repeat || state.screen !== 'run') return;
    event.preventDefault();
    if (state.timer === 'idle') start();
    else if (state.timer === 'running' && performance.now() - state.startedAt >= ENTER_STOP_GUARD_MS) stop();
  });

  init();
})();
