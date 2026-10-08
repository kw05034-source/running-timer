(() => {
  'use strict';

  // ---- 성장판: 20m 왕복달리기 자기 개선 과정 ----
  // 한 학생마다 5단계를 기록합니다.
  //   1 기준 기록 → 2 짝 관찰(체크 카드) → 3 약한 전략 하나 + 목표 → 4 연습 후 재측정 → 5 성찰
  // 저장: 이 크롬북(localStorage)에 먼저 저장하고, 구글 시트(Growth 시트)에도 학생당 한 줄로 보냅니다.
  // 시트 연동이 안 되는 배포(옛 Apps Script)에서는 이 크롬북에만 저장하고 안내 문구를 띄웁니다.

  // app.js와 같은 Apps Script Web App 주소
  const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbw5mlmLxwSTXB7q7lsbqlGjWfkU9aTUwmwFSKeiK_Y9OyDX-eqx51AAkayE6qtAkCQS/exec';
  const STORAGE_KEY = 'movement-records-growth-v1';
  const CLASS_STORAGE_KEY = 'movement-records-selected-class-v1';
  const GROUP_STORAGE_KEY = 'movement-records-selected-group-v1';
  const MODE_STORAGE_KEY = 'running-mode'; // 측정 앱 시작 화면에서 고른 모드(웜업 / 기록)
  const RECORD_MIN_SEC = 5; // 기록 측정 모드에서 랭킹(Records 시트)에 들어가는 최소 기록 (측정 앱과 같음)
  const MIN_SEC = 2;       // 이보다 짧으면 잘못 누른 것으로 보고 인정하지 않음
  const CHECK_MAX_SEC = 20; // 이보다 길면 정지를 늦게 눌렀는지 확인 안내

  const STRATS = [
    { key: 'start', name: '출발 자세', color: 'var(--s-start)', checks: [
      '한 발을 앞에 두고 무릎을 굽혀 몸을 앞으로 기울였다',
      '첫 3~4걸음을 짧고 빠르게 밀어냈다',
      '출발 신호에 바로 반응했다'],
      tips: ['준비 자세에서 앞발 쪽으로 체중을 실어 두기', '첫 걸음은 "작게, 빠르게" 소리 내어 세며 연습', '짝이 손뼉 신호를 주고 반응 출발 3회'] },
    { key: 'turn', name: '반환점 회전', color: 'var(--s-turn)', checks: [
      '라인 2~3걸음 전부터 보폭을 줄이고 몸을 낮췄다',
      '바깥발로 라인을 짚고 강하게 밀어냈다',
      '상체를 먼저 돌려 바로 다시 가속했다'],
      tips: ['반환선 앞 3걸음 "다다닥" 짧게 끊기', '라인 짚는 발을 정해 5m 왕복으로 회전만 연습', '돌 때 시선과 어깨를 먼저 출발선 쪽으로'] },
    { key: 'finish', name: '팔치기·끝까지 달리기', color: 'var(--s-finish)', checks: [
      '팔을 앞뒤로 크고 빠르게 흔들었다',
      '결승선 앞에서 속도를 줄이지 않았다',
      '결승선 2~3m 뒤를 목표로 끝까지 달렸다'],
      tips: ['제자리 팔치기 10초, 팔꿈치 90도 유지', '결승선 3m 뒤에 콘을 두고 콘까지 달리기', '마지막 5m는 "더 빠르게"를 외치며 통과'] }
  ];
  const STEPS = [
    { t: '기준 기록', s: '처음 한 번 뛰기' },
    { t: '짝 관찰', s: '체크 카드' },
    { t: '목표 정하기', s: '전략 하나 고르기' },
    { t: '연습·재측정', s: '다시 뛰고 비교' },
    { t: '성찰', s: '한 줄 돌아보기' }
  ];

  const state = {
    mode: 'student', classNo: null, group: '', studentId: null, step: 0,
    timer: 'idle', startedAt: 0, elapsedMs: 0, timerId: null, pending: null,
    sheetSupported: null
  };
  let students = [];
  const recordCounts = {}; // 학생별 Records 시트 obstacle_run 기록 수 (회차 계산용)
  const focusStudentId = new URLSearchParams(window.location.search).get('student');

  function readMode() {
    let mode = null;
    try { mode = sessionStorage.getItem(MODE_STORAGE_KEY); } catch (error) { /* 기본값 사용 */ }
    return mode === 'record' ? 'record' : 'warmup';
  }
  let runs = readRuns();
  let toastTimer = null;
  const sendTimers = {};

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const f2 = (n) => Number(n).toFixed(2);
  const round2 = (n) => Math.round(n * 100) / 100;

  // ---- 저장소 ----
  function readRuns() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) { return {}; }
  }
  function writeRuns() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(runs)); } catch (error) { console.warn('이 기기에 저장하지 못했습니다.', error); }
  }
  function blankRun(studentId) {
    return { student_id: studentId, attempts: [], checks: { start: [0, 0, 0], turn: [0, 0, 0], finish: [0, 0, 0] },
      observed: false, focus: '', goal: null, refl1: '', refl2: '', updated_at: '' };
  }
  function runOf(studentId) {
    if (!runs[studentId]) runs[studentId] = blankRun(studentId);
    return runs[studentId];
  }
  function touch(studentId) {
    runOf(studentId).updated_at = new Date().toISOString();
    writeRuns();
    queueSend(studentId);
  }

  // ---- 구글 시트 연동 (Growth 시트, 학생당 한 줄) ----
  function toRow(run) {
    return {
      student_id: run.student_id,
      updated_at: run.updated_at,
      attempts: run.attempts.map((a) => f2(a.sec)).join(','),
      start_checks: run.checks.start.join(','),
      turn_checks: run.checks.turn.join(','),
      finish_checks: run.checks.finish.join(','),
      observed: run.observed ? 1 : 0,
      focus: run.focus,
      goal_seconds: run.goal == null ? '' : run.goal,
      reflection_good: run.refl1,
      reflection_next: run.refl2
    };
  }
  function fromRow(row) {
    const nums = (text) => String(text ?? '').split(',').map((v) => v.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    const checks = (text) => { const v = nums(text).map((x) => (x ? 1 : 0)); return [v[0] || 0, v[1] || 0, v[2] || 0]; };
    return {
      student_id: String(row.student_id),
      attempts: nums(row.attempts).map((sec) => ({ sec, at: '' })),
      checks: { start: checks(row.start_checks), turn: checks(row.turn_checks), finish: checks(row.finish_checks) },
      observed: Number(row.observed) === 1,
      focus: STRATS.some((s) => s.key === row.focus) ? row.focus : '',
      goal: row.goal_seconds === '' || row.goal_seconds == null ? null : Number(row.goal_seconds),
      refl1: String(row.reflection_good ?? ''),
      refl2: String(row.reflection_next ?? ''),
      updated_at: String(row.updated_at ?? '')
    };
  }
  function queueSend(studentId) {
    if (state.sheetSupported === false) return;
    window.clearTimeout(sendTimers[studentId]);
    sendTimers[studentId] = window.setTimeout(() => sendRun(studentId), 700);
  }
  async function sendRun(studentId) {
    try {
      const response = await fetch(SHEETS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'growth', growth: toRow(runOf(studentId)) })
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error && result.error.message ? result.error.message : '시트 저장 실패');
      setSyncNote();
    } catch (error) {
      console.error('성장판을 시트에 저장하지 못했습니다.', error);
      showToast('시트에 보내지 못했어요. 이 크롬북에는 저장돼 있어요.');
    }
  }
  async function syncFromSheets() {
    try {
      const response = await fetch(`${SHEETS_ENDPOINT}?action=growth`);
      const result = await response.json();
      if (!result.ok || !Array.isArray(result.data)) {
        // 옛 Apps Script 배포는 growth action을 모릅니다. 그때만 시트 전송을 끕니다.
        if (result.error && result.error.code === 'INVALID_ACTION') state.sheetSupported = false;
        return false;
      }
      state.sheetSupported = true;
      result.data.forEach((row) => {
        if (!row || !row.student_id) return;
        const remote = fromRow(row);
        const local = runs[remote.student_id];
        if (!local || String(remote.updated_at) > String(local.updated_at || '')) runs[remote.student_id] = remote;
      });
      writeRuns();
      return true;
    } catch (error) {
      console.error('성장판 시트 기록을 불러오지 못했습니다.', error);
      return false;
    }
  }
  function setSyncNote() {
    const note = $('sync-note');
    if (state.sheetSupported === false) {
      note.className = 'notice';
      note.textContent = '지금은 이 크롬북에만 저장돼요. Apps Script를 새 버전으로 배포하면 구글 시트 Growth 탭에도 함께 저장돼요.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  // ---- 계산 ----
  const baseOf = (r) => (r.attempts.length ? r.attempts[0].sec : null);
  const reOf = (r) => r.attempts.slice(1);
  const bestReOf = (r) => { const a = reOf(r); return a.length ? Math.min(...a.map((x) => x.sec)) : null; };
  const scoreOf = (r, k) => r.checks[k].reduce((sum, v) => sum + (v ? 1 : 0), 0);
  const stratOf = (k) => STRATS.find((s) => s.key === k);
  function weakest(r) {
    // 동점이면 기록 차이가 가장 크게 나는 반환점 회전을 먼저 추천
    let pick = null;
    ['turn', 'start', 'finish'].forEach((k) => { if (pick === null || scoreOf(r, k) < scoreOf(r, pick)) pick = k; });
    return pick;
  }
  function stepDone(r, i) {
    return [r.attempts.length > 0, r.observed, !!r.focus && r.goal != null, reOf(r).length > 0, !!(r.refl1 || r.refl2)][i];
  }
  const getStudent = (id) => students.find((s) => s.student_id === id);

  // ---- 반/조 ----
  function classes() {
    return [...new Set(students.map((s) => Number(s.class)))].filter(Number.isInteger).sort((a, b) => a - b);
  }
  function groupsOf(classNo) {
    return [...new Set(students.filter((s) => Number(s.class) === classNo).map((s) => s.group_or_team))]
      .sort((a, b) => {
        const g = (x) => (x.startsWith('남') ? 0 : x.startsWith('여') ? 1 : 2);
        if (g(a) !== g(b)) return g(a) - g(b);
        return Number.parseInt(a.replace(/\D/g, ''), 10) - Number.parseInt(b.replace(/\D/g, ''), 10);
      });
  }
  function renderTabs() {
    $('class-tabs').innerHTML = classes().map((c) => `<button type="button" role="tab" data-class="${c}" class="${c === state.classNo ? 'is-selected' : ''}" aria-selected="${c === state.classNo}">${c}반</button>`).join('');
    const groups = groupsOf(state.classNo);
    $('group-tabs').hidden = state.mode === 'teacher';
    $('group-tabs').innerHTML = groups.map((g) => `<button type="button" role="tab" data-group="${esc(g)}" class="${g === state.group ? 'is-selected' : ''}" aria-selected="${g === state.group}">${esc(g)}</button>`).join('');
  }

  // ---- 학생 화면 ----
  function renderRoster() {
    const list = students.filter((s) => Number(s.class) === state.classNo && s.group_or_team === state.group);
    $('roster-title').textContent = `${state.classNo}반 ${state.group} · ${list.length}명`;
    $('roster').innerHTML = list.map((s) => {
      const r = runs[s.student_id];
      const dots = STEPS.map((_, i) => `<i class="${r && stepDone(r, i) ? 'on' : ''}"></i>`).join('');
      return `<button type="button" data-student-id="${esc(s.student_id)}" aria-current="${s.student_id === state.studentId}"><span class="no">${esc(s.number)}번</span><span>${esc(s.name)}</span><span class="dots" aria-label="진행 단계">${dots}</span></button>`;
    }).join('');
  }

  function stepper(r) {
    return `<nav class="steps" aria-label="개선 단계">${STEPS.map((s, i) => `<button type="button" data-step="${i}" class="${stepDone(r, i) ? 'done' : ''}" ${i === state.step ? 'aria-current="step"' : ''}><small>${i + 1}단계</small><b>${s.t}</b><small>${s.s}</small></button>`).join('')}</nav>`;
  }

  function watchHtml() {
    if (state.timer === 'stopped' && state.pending) {
      const long = state.pending > CHECK_MAX_SEC;
      return `<div class="confirm"><span>측정 기록</span><strong>${f2(state.pending)}초</strong>
        ${long ? `<span>${CHECK_MAX_SEC}초보다 길어요. 정지를 늦게 눌렀다면 취소하고 다시 재 주세요.</span>` : ''}
        <div class="row"><button type="button" class="primary" data-action="save-attempt">✓ 저장</button><button type="button" class="ghost" data-action="cancel-attempt">취소</button></div></div>`;
    }
    const running = state.timer === 'running';
    return `<div class="watch">
      <div><div class="digits" id="digits">0.00<small>초</small></div>
        <div class="manual"><span>손으로 잰 기록 입력</span><input id="manual-sec" inputmode="decimal" placeholder="예: 6.42" aria-label="기록 직접 입력(초)"><button type="button" class="ghost" data-action="manual">입력</button></div></div>
      <div class="watch-btns"><button type="button" class="go${running ? ' run' : ''}" data-action="toggle-timer">${running ? 'STOP' : 'START'}</button>
        <span class="lead">Enter 키로도 시작·정지할 수 있어요.</span></div>
    </div>`;
  }

  function chartHtml(r) {
    const a = r.attempts;
    if (!a.length) return '';
    const vals = a.map((x) => x.sec).concat(r.goal != null ? [r.goal] : []);
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 0.5) * 2) / 2);
    const hi = Math.ceil((Math.max(...vals) + 0.3) * 2) / 2;
    const W = 660, L = 70, R = 60, rowH = 32, top = 28, H = top + a.length * rowH + 28;
    const x = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
    const ticks = [];
    for (let t = lo; t <= hi + 1e-9; t += 0.5) ticks.push(t);
    const grid = ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - 24}" stroke="#e5eaf2"/><text class="soft" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t.toFixed(1)}</text>`).join('');
    const bars = a.map((at, i) => {
      const y = top + i * rowH;
      const color = i === 0 ? '#758199' : (r.goal != null && at.sec <= r.goal ? '#0f8f72' : '#4f8cff');
      return `<text x="${L - 8}" y="${y + 19}" text-anchor="end">${i === 0 ? '기준' : `${i + 1}차`}</text>
        <rect x="${L}" y="${y + 6}" width="${Math.max(2, x(at.sec) - L)}" height="18" rx="5" fill="${color}"/>
        <text x="${x(at.sec) + 6}" y="${y + 19}" font-weight="700">${f2(at.sec)}</text>`;
    }).join('');
    const goal = r.goal != null ? `<line x1="${x(r.goal)}" x2="${x(r.goal)}" y1="${top - 8}" y2="${H - 24}" stroke="#ffbf3f" stroke-width="3" stroke-dasharray="6 4"/><text x="${x(r.goal)}" y="${top - 12}" text-anchor="middle" font-weight="800">목표 ${f2(r.goal)}</text>` : '';
    return `<div class="chart" role="img" aria-label="시도별 기록(초). 막대가 짧을수록 빠름"><svg viewBox="0 0 ${W} ${H}">${grid}${bars}${goal}</svg><p class="lead">막대가 짧을수록 빨라요. 노란 점선이 목표 기록이에요.</p></div>`;
  }

  function feedbackHtml(r) {
    const base = baseOf(r), best = bestReOf(r);
    if (base == null) return '';
    if (best == null) {
      return `<div class="fb"><b>기준 기록 ${f2(base)}초를 저장했어요.</b><span>이제 짝이 뛰는 모습을 보고 2단계 체크 카드를 채워 주세요.</span></div>`;
    }
    const diff = base - best;
    const strat = stratOf(r.focus);
    const last = reOf(r).slice(-1)[0].sec;
    const missed = strat ? strat.checks.filter((_, i) => !r.checks[strat.key][i]) : [];
    if (r.goal != null && best <= r.goal) {
      return `<div class="fb good"><b>목표 달성! 기준보다 ${f2(diff)}초 빨라졌어요.</b><span>${strat ? `${esc(strat.name)} 연습이 효과가 있었어요. ` : ''}5단계에서 무엇이 달라졌는지 적어 보세요. 시간이 남으면 다른 전략 하나를 더 골라 도전해요.</span></div>`;
    }
    if (diff > 0) {
      const left = r.goal != null ? ` 목표까지 ${f2(best - r.goal)}초 남았어요.` : '';
      return `<div class="fb warn"><b>기준보다 ${f2(diff)}초 줄였어요.${left}</b><span>${missed.length ? `아직 체크되지 않은 포인트: ${missed.map(esc).join(' / ')}. 짝에게 이 부분만 다시 봐 달라고 하세요.` : '같은 전략을 한 번 더 연습하고 다시 재 보세요.'}</span></div>`;
    }
    return `<div class="fb bad"><b>아직 기준 기록(${f2(base)}초)보다 빠르지 않아요${last > base ? ` (방금 ${f2(last)}초)` : ''}.</b><span>${strat ? `${esc(strat.name)} 연습 방법 중 하나만 골라 천천히 3번 해 본 뒤 다시 뛰어요. ` : ''}힘이 빠졌다면 1분 쉬고 재는 것도 방법이에요.</span></div>`;
  }

  function panelHtml(r) {
    const i = state.step;
    if (i === 0) {
      const has = r.attempts.length > 0;
      return `<div class="panel"><h3>1단계 · 기준 기록</h3>
        <p class="lead">전략을 배우기 전에 지금 실력 그대로 한 번 뛰어요. 이 기록이 오늘 개선의 출발점이에요.</p>
        ${has ? `<div class="sentence">나의 기준 기록: <span class="num">${f2(baseOf(r))}</span>초</div>` : watchHtml()}
        ${feedbackHtml(r)}
        ${has ? `<div class="row"><button type="button" class="primary" data-goto="1">2단계 짝 관찰로 →</button>${r.attempts.length === 1 ? '<button type="button" class="ghost" data-action="undo">기준 기록 다시 재기</button>' : ''}</div>` : ''}</div>`;
    }
    if (i === 1) {
      const weak = weakest(r);
      return `<div class="panel"><h3>2단계 · 짝 관찰 체크 카드</h3>
        <p class="lead">짝이 뛰는 모습을 보고 잘 된 포인트에 체크해요. 반환점 회전은 휴대폰 슬로모션으로 찍어 함께 보면 정확해요.</p>
        <div class="strats">${STRATS.map((s) => `<div class="strat${r.observed && s.key === weak ? ' weak' : ''}" style="--c:${s.color}">
          <header><h4>${s.name}</h4><span class="score">${scoreOf(r, s.key)}/3</span></header>
          ${s.checks.map((c, j) => `<label class="chk"><input type="checkbox" id="chk-${s.key}-${j}" data-check="${s.key}:${j}" ${r.checks[s.key][j] ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}
          ${r.observed && s.key === weak ? '<span class="tag">가장 약한 전략</span>' : ''}</div>`).join('')}</div>
        <div class="row"><button type="button" class="primary" data-action="observed">관찰 끝, 약한 전략 찾기</button>
        ${r.observed ? `<span class="lead">체크가 가장 적은 <b>${stratOf(weak).name}</b>부터 고쳐 보길 추천해요.</span><button type="button" class="ghost" data-goto="2">3단계로 →</button>` : ''}</div></div>`;
    }
    if (i === 2) {
      const base = baseOf(r);
      const rec = r.observed ? weakest(r) : '';
      const strat = stratOf(r.focus);
      const value = r.goal != null ? f2(r.goal) : (base != null ? f2(Math.max(0, base - 0.2)) : '');
      return `<div class="panel"><h3>3단계 · 전략 하나 고르고 목표 정하기</h3>
        <p class="lead">세 가지를 한꺼번에 고치기는 어려워요. 하나만 골라 집중해요.</p>
        <div class="pick">${STRATS.map((s) => `<button type="button" style="--c:${s.color}" data-focus="${s.key}" aria-pressed="${r.focus === s.key}"><b>${s.name}${s.key === rec ? ' · 추천' : ''}</b><span>짝 관찰 ${scoreOf(r, s.key)}/3</span></button>`).join('')}</div>
        <div class="row goal"><label for="goal-input"><b>목표 기록</b></label><input id="goal-input" inputmode="decimal" value="${value}"><span>초</span><button type="button" class="primary" data-action="save-goal">목표 저장</button></div>
        <p class="lead">${base != null ? `기준 ${f2(base)}초에서 0.2초 줄인 값을 먼저 넣어 두었어요.` : '1단계 기준 기록을 먼저 재면 목표를 추천해 드려요.'}</p>
        ${strat && r.goal != null ? `<div class="sentence">나는 오늘 <span style="color:${strat.color}">${strat.name}</span>을(를) 고쳐서 <span class="num">${f2(r.goal)}</span>초에 도전한다.</div>
        <div class="fb"><b>${strat.name} 연습 방법</b><ul>${strat.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
        <div class="row"><button type="button" class="primary" data-goto="3">연습했으면 4단계 재측정으로 →</button></div>` : ''}</div>`;
    }
    if (i === 3) {
      return `<div class="panel"><h3>4단계 · 연습하고 다시 재기</h3>
        <p class="lead">고른 전략만 연습한 뒤 다시 뛰어요. 여러 번 재도 돼요. 가장 좋은 기록을 기준 기록과 비교해 피드백을 보여 줘요.</p>
        ${baseOf(r) == null ? '<div class="fb bad"><b>1단계 기준 기록이 없어요.</b><span>먼저 기준 기록을 재 주세요.</span></div>' : watchHtml()}
        ${chartHtml(r)}
        ${feedbackHtml(r)}
        <div class="row">${reOf(r).length ? '<button type="button" class="ghost" data-action="undo">마지막 기록 지우기</button><button type="button" class="primary" data-goto="4">5단계 성찰로 →</button>' : ''}</div></div>`;
    }
    const base = baseOf(r), best = bestReOf(r), strat = stratOf(r.focus);
    const change = base != null && best != null ? `${base - best >= 0 ? '-' : '+'}${f2(Math.abs(base - best))}` : '-';
    return `<div class="panel"><h3>5단계 · 성찰 한 줄</h3>
      <div class="summary"><span>기준 <b class="num">${base != null ? f2(base) : '-'}</b>초</span><span>최고 <b class="num">${best != null ? f2(best) : '-'}</b>초</span><span>변화 <b class="num">${change}</b>초</span><span>집중 전략 <b>${strat ? strat.name : '-'}</b></span></div>
      <label class="q" for="refl1">어떤 전략이 효과가 있었나요? 몸에서 무엇이 달라졌나요?<textarea id="refl1" maxlength="300" placeholder="예: 반환선 앞에서 보폭을 줄이니 덜 미끄러지고 바로 출발할 수 있었다.">${esc(r.refl1)}</textarea></label>
      <label class="q" for="refl2">다음 시간에는 무엇을 바꿔 볼까요?<textarea id="refl2" maxlength="300" placeholder="예: 다음엔 팔치기를 크게 해서 마지막 5m 속도를 유지해 보겠다.">${esc(r.refl2)}</textarea></label>
      <div class="row"><button type="button" class="primary" data-action="save-reflection">성찰 저장</button><span class="saved" id="refl-saved" hidden>저장했어요</span></div></div>`;
  }

  function renderCard() {
    const card = $('card');
    const student = getStudent(state.studentId);
    if (!student) {
      card.innerHTML = '<div class="empty"><h3>왼쪽에서 학생을 고르세요</h3><p>한 학생마다 기준 기록, 짝 관찰, 목표, 재측정, 성찰 다섯 단계가 저장돼요.</p></div>';
      return;
    }
    const r = runOf(student.student_id);
    const mode = readMode();
    const badge = mode === 'record'
      ? `기록 측정 · 타이머로 잰 ${RECORD_MIN_SEC}초 이상 기록은 랭킹에도 들어가요`
      : '웜업 측정 · 성장판에만 저장되고 랭킹에는 들어가지 않아요';
    card.innerHTML = `<div class="who"><h2>${esc(student.name)}</h2><span>${esc(student.class)}반 · ${esc(student.group_or_team)} · ${esc(student.number)}번</span></div><span class="mode-badge" data-mode="${mode}">${badge}</span>${stepper(r)}${panelHtml(r)}`;
    paintDigits();
  }

  // ---- 타이머 (START → STOP → 저장 확인) ----
  function paintDigits() {
    const el = $('digits');
    if (!el) return;
    const ms = state.timer === 'running' ? performance.now() - state.startedAt : state.elapsedMs;
    el.innerHTML = `${f2(ms / 1000)}<small>초</small>`;
  }
  function startTimer() {
    if (state.timer !== 'idle' || !state.studentId) return;
    state.timer = 'running';
    state.startedAt = performance.now();
    renderCard();
    state.timerId = window.setInterval(paintDigits, 40);
  }
  function stopTimer() {
    if (state.timer !== 'running') return;
    window.clearInterval(state.timerId);
    state.timerId = null;
    state.elapsedMs = performance.now() - state.startedAt;
    const sec = round2(state.elapsedMs / 1000);
    if (sec < MIN_SEC) {
      state.timer = 'idle';
      state.elapsedMs = 0;
      renderCard();
      showToast(`${MIN_SEC}초보다 짧아서 인정되지 않았어요. 다시 재 주세요.`);
      return;
    }
    state.timer = 'stopped';
    state.pending = sec;
    renderCard();
  }
  function resetTimer() {
    window.clearInterval(state.timerId);
    Object.assign(state, { timer: 'idle', timerId: null, startedAt: 0, elapsedMs: 0, pending: null });
  }
  function addAttempt(sec, fromTimer) {
    const r = runOf(state.studentId);
    const attempt = { sec: round2(sec), at: new Date().toISOString() };
    if (fromTimer && readMode() === 'record' && attempt.sec >= RECORD_MIN_SEC) {
      attempt.ranked = true;
      sendToRecords(state.studentId, attempt);
    }
    r.attempts.push(attempt);
    touch(state.studentId);
    resetTimer();
    renderCard();
    renderRoster();
    showToast(r.attempts.length === 1 ? '기준 기록을 저장했어요.' : `${r.attempts.length}차 기록을 저장했어요.`);
  }

  // 기록 측정 모드에서는 측정 앱과 같은 방식으로 Records 시트(랭킹)에도 한 줄 추가합니다.
  async function sendToRecords(studentId, attempt) {
    const attemptNo = (recordCounts[studentId] || 0) + 1;
    recordCounts[studentId] = attemptNo;
    const timestamp = attempt.at;
    try {
      const response = await fetch(SHEETS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'record', record: {
          student_id: studentId,
          attempt_no: attemptNo,
          record_seconds: attempt.sec,
          activity_type: 'obstacle_run',
          record_id: `${studentId}_${attemptNo}_${Math.round(attempt.sec * 100)}_${timestamp}`
        } })
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error && result.error.message ? result.error.message : '랭킹 저장 실패');
    } catch (error) {
      recordCounts[studentId] = attemptNo - 1;
      console.error('Records 시트에 저장하지 못했습니다.', error);
      showToast('랭킹 시트에 저장하지 못했어요. 성장판에는 저장돼 있어요.');
    }
  }
  async function loadRecordCounts() {
    try {
      const response = await fetch(`${SHEETS_ENDPOINT}?action=records`);
      const result = await response.json();
      if (!result.ok || !Array.isArray(result.data)) return;
      result.data.forEach((row) => {
        if (row.activity_type !== 'obstacle_run') return;
        const id = String(row.student_id);
        recordCounts[id] = (recordCounts[id] || 0) + 1;
      });
    } catch (error) {
      console.error('Records 시트를 불러오지 못했습니다.', error);
    }
  }

  // ---- 교사 현황 ----
  function renderTeacher() {
    const list = students.filter((s) => Number(s.class) === state.classNo);
    const rows = list.map((s) => ({ s, r: runs[s.student_id] }));
    const started = rows.filter((x) => x.r && x.r.attempts.length);
    const improved = rows.filter((x) => x.r && bestReOf(x.r) != null && bestReOf(x.r) < baseOf(x.r));
    const achieved = rows.filter((x) => x.r && x.r.goal != null && bestReOf(x.r) != null && bestReOf(x.r) <= x.r.goal);
    const gains = improved.map((x) => baseOf(x.r) - bestReOf(x.r));
    const avg = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : null;
    const counts = STRATS.map((st) => ({ st, n: rows.filter((x) => x.r && x.r.focus === st.key).length }));
    const max = Math.max(1, ...counts.map((c) => c.n));
    $('teacher-view').innerHTML = `
      <section class="kpis">
        <div class="kpi"><b>기준 기록 참여</b><strong>${started.length}<em>/ ${list.length}명</em></strong></div>
        <div class="kpi"><b>기록이 줄어든 학생</b><strong>${improved.length}<em>명</em></strong></div>
        <div class="kpi"><b>목표 달성</b><strong>${achieved.length}<em>명</em></strong></div>
        <div class="kpi"><b>평균 단축(줄어든 학생)</b><strong>${avg != null ? f2(avg) : '-'}<em>초</em></strong></div>
      </section>
      <section class="card"><h3>학생들이 고른 집중 전략</h3>
        <div class="bars">${counts.map((c) => `<div style="--c:${c.st.color}"><span>${c.st.name}</span><i style="width:${(c.n / max) * 100}%"></i><span class="num">${c.n}</span></div>`).join('')}</div>
        <div class="row"><button type="button" class="ghost" data-action="refresh">시트에서 다시 불러오기</button><button type="button" class="ghost" data-action="copy-csv">표를 CSV로 복사</button></div></section>
      <section class="tablebox"><table><thead><tr><th>번호</th><th>이름</th><th>조</th><th>기준</th><th>최고(재측정)</th><th>변화</th><th>집중 전략</th><th>목표</th><th>상태</th><th>성찰</th></tr></thead><tbody>
      ${rows.map(({ s, r }) => {
        const base = r ? baseOf(r) : null, best = r ? bestReOf(r) : null, strat = r ? stratOf(r.focus) : null;
        const d = base != null && best != null ? base - best : null;
        let status = '<span class="st none">시작 전</span>';
        if (r && r.attempts.length) status = '<span class="st warn">진행 중</span>';
        if (r && r.goal != null && best != null && best <= r.goal) status = '<span class="st good">목표 달성</span>';
        return `<tr><td class="n">${esc(s.number)}</td><td>${esc(s.name)}</td><td>${esc(s.group_or_team)}</td>
          <td class="n">${base != null ? f2(base) : '-'}</td><td class="n">${best != null ? f2(best) : '-'}</td>
          <td class="n">${d != null ? `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '-' : '+'}${f2(Math.abs(d))}</span>` : '-'}</td>
          <td>${strat ? `<b style="color:${strat.color}">${strat.name}</b>` : '-'}</td><td class="n">${r && r.goal != null ? f2(r.goal) : '-'}</td>
          <td>${status}</td><td class="refl">${r && (r.refl1 || r.refl2) ? esc([r.refl1, r.refl2].filter(Boolean).join(' / ')) : '-'}</td></tr>`;
      }).join('')}
      </tbody></table></section>`;
  }
  function csv() {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['반', '번호', '이름', '조', '기준(초)', '최고 재측정(초)', '변화(초)', '집중 전략', '목표(초)', '출발 체크', '회전 체크', '팔치기 체크', '성찰1', '성찰2'];
    const lines = students.filter((s) => Number(s.class) === state.classNo).map((s) => {
      const r = runs[s.student_id];
      if (!r) return [s.class, s.number, s.name, s.group_or_team].map(q).join(',');
      const b = baseOf(r), be = bestReOf(r);
      return [s.class, s.number, s.name, s.group_or_team, b != null ? f2(b) : '', be != null ? f2(be) : '', b != null && be != null ? f2(b - be) : '',
        stratOf(r.focus)?.name || '', r.goal != null ? f2(r.goal) : '', scoreOf(r, 'start'), scoreOf(r, 'turn'), scoreOf(r, 'finish'), r.refl1, r.refl2].map(q).join(',');
    });
    return [head.map(q).join(','), ...lines].join('\n');
  }

  function render() {
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    renderTabs();
    $('student-view').hidden = state.mode !== 'student';
    $('teacher-view').hidden = state.mode !== 'teacher';
    if (state.mode === 'student') { renderRoster(); renderCard(); } else renderTeacher();
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3200);
  }

  // ---- 이벤트 ----
  document.addEventListener('click', (event) => {
    const b = event.target.closest('button');
    if (!b) return;
    const running = state.timer === 'running';
    if (running && !(b.dataset.action === 'toggle-timer')) { showToast('측정 중에는 다른 버튼을 누를 수 없어요.'); return; }

    if (b.dataset.mode) { state.mode = b.dataset.mode; render(); return; }
    if (b.dataset.class) {
      state.classNo = Number(b.dataset.class);
      state.group = groupsOf(state.classNo)[0] ?? '';
      state.studentId = null;
      try { localStorage.setItem(CLASS_STORAGE_KEY, String(state.classNo)); localStorage.setItem(GROUP_STORAGE_KEY, state.group); } catch (error) { /* 무시 */ }
      resetTimer(); render(); return;
    }
    if (b.dataset.group) {
      state.group = b.dataset.group;
      state.studentId = null;
      try { localStorage.setItem(GROUP_STORAGE_KEY, state.group); } catch (error) { /* 무시 */ }
      resetTimer(); render(); return;
    }
    if (b.dataset.studentId) {
      state.studentId = b.dataset.studentId;
      const r = runOf(state.studentId);
      state.step = STEPS.findIndex((_, i) => !stepDone(r, i));
      if (state.step < 0) state.step = 4;
      resetTimer(); renderRoster(); renderCard(); return;
    }
    if (b.dataset.step) { state.step = Number(b.dataset.step); resetTimer(); renderCard(); return; }
    if (b.dataset.goto) { state.step = Number(b.dataset.goto); resetTimer(); renderCard(); return; }
    const r = state.studentId ? runOf(state.studentId) : null;
    if (b.dataset.focus && r) { r.focus = b.dataset.focus; touch(state.studentId); renderCard(); return; }

    switch (b.dataset.action) {
      case 'toggle-timer': if (running) stopTimer(); else startTimer(); break;
      case 'save-attempt': if (state.pending) addAttempt(state.pending, true); break;
      case 'cancel-attempt': resetTimer(); renderCard(); showToast('기록을 저장하지 않았어요.'); break;
      case 'manual': {
        const v = Number.parseFloat(($('manual-sec').value || '').replace(',', '.'));
        if (v >= MIN_SEC && v <= 60) addAttempt(v); else showToast(`${MIN_SEC}~60초 사이 숫자로 입력해 주세요.`);
        break;
      }
      case 'undo':
        if (r && r.attempts.length) {
          const removed = r.attempts.pop();
          touch(state.studentId); renderCard(); renderRoster();
          showToast(removed.ranked ? '성장판에서 지웠어요. 랭킹 시트의 기록은 선생님이 시트에서 지워 주세요.' : '마지막 기록을 지웠어요.');
        }
        break;
      case 'observed':
        r.observed = true;
        if (!r.focus) r.focus = weakest(r);
        touch(state.studentId); renderCard(); renderRoster(); break;
      case 'save-goal': {
        const v = Number.parseFloat(($('goal-input').value || '').replace(',', '.'));
        if (!(v > 0 && v <= 60)) { showToast('목표 기록을 초 단위 숫자로 입력해 주세요.'); break; }
        if (!r.focus) r.focus = weakest(r);
        r.goal = round2(v);
        touch(state.studentId); renderCard(); renderRoster(); break;
      }
      case 'save-reflection':
        r.refl1 = $('refl1').value.trim();
        r.refl2 = $('refl2').value.trim();
        touch(state.studentId); renderRoster();
        $('refl-saved').hidden = false;
        document.querySelector('.steps').outerHTML = stepper(r);
        break;
      case 'refresh':
        syncFromSheets().then((ok) => { setSyncNote(); render(); showToast(ok ? '시트 기록을 다시 불러왔어요.' : '시트에서 불러오지 못했어요.'); });
        break;
      case 'copy-csv':
        navigator.clipboard.writeText(csv()).then(() => showToast('복사했어요. 스프레드시트에 붙여 넣으세요.'), () => showToast('복사하지 못했어요.'));
        break;
      default: break;
    }
  });
  document.addEventListener('change', (event) => {
    const key = event.target.dataset && event.target.dataset.check;
    if (!key || !state.studentId) return;
    const [k, j] = key.split(':');
    const r = runOf(state.studentId);
    r.checks[k][Number(j)] = event.target.checked ? 1 : 0;
    touch(state.studentId);
    event.target.closest('.strat').querySelector('.score').textContent = `${scoreOf(r, k)}/3`;
  });
  // Enter 키로 시작/정지 (측정 앱과 같은 방식). 시작 직후 0.3초 안의 Enter는 실수로 보고 무시합니다.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.repeat || !$('digits')) return;
    if (event.target.matches('input, textarea')) return;
    event.preventDefault();
    if (state.timer === 'idle') startTimer();
    else if (state.timer === 'running' && performance.now() - state.startedAt > 300) stopTimer();
  });

  // ---- 시작 ----
  async function loadStudents() {
    const response = await fetch(`${SHEETS_ENDPOINT}?action=students`);
    const result = await response.json();
    if (!result.ok) throw new Error('학생 명단을 불러오지 못했습니다.');
    return result.data.map((row) => ({
      student_id: String(row.student_id), grade: Number(row.grade), class: Number(row.class),
      number: Number(row.number), name: String(row.name), group_or_team: String(row.group_or_team)
    }));
  }
  async function init() {
    try {
      students = await loadStudents();
    } catch (error) {
      console.error(error);
      $('card').innerHTML = '<div class="empty"><h3>학생 명단을 불러오지 못했어요</h3><p>인터넷 연결을 확인하고 새로고침해 주세요.</p></div>';
      return;
    }
    const cls = classes();
    const storedClass = Number.parseInt(localStorage.getItem(CLASS_STORAGE_KEY), 10);
    state.classNo = cls.includes(storedClass) ? storedClass : (cls[0] ?? 1);
    const groups = groupsOf(state.classNo);
    const storedGroup = localStorage.getItem(GROUP_STORAGE_KEY);
    state.group = groups.includes(storedGroup) ? storedGroup : (groups[0] ?? '');
    const focus = focusStudentId ? getStudent(focusStudentId) : null;
    if (focus) {
      // 측정 앱에서 이름을 눌러 들어온 경우: 그 학생 화면만 보여 줍니다.
      document.body.classList.add('is-focus');
      state.classNo = Number(focus.class);
      state.group = focus.group_or_team;
      state.studentId = focus.student_id;
      const r = runOf(focus.student_id);
      state.step = STEPS.findIndex((_, i) => !stepDone(r, i));
      if (state.step < 0) state.step = 4;
    } else {
      $('back-link').textContent = '🏠 측정 앱으로';
      if (window.location.hash === '#teacher') state.mode = 'teacher';
    }
    render();
    if (focus && readMode() === 'record') loadRecordCounts();
    await syncFromSheets();
    if (focus) {
      // 시트에서 더 최근 내용을 받아왔다면 단계 위치를 다시 맞춥니다.
      const r = runOf(focus.student_id);
      if (state.timer === 'idle') { state.step = STEPS.findIndex((_, i) => !stepDone(r, i)); if (state.step < 0) state.step = 4; }
    }
    setSyncNote();
    if (state.timer !== 'running' && !document.activeElement?.matches('input, textarea')) render();
  }
  init();
})();
