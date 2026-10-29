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
  // 교사 현황 잠금: 성장판(growth.js)과 같은 선생님 번호, 같은 잠금 상태를 씁니다.
  const TEACHER_UNLOCK_KEY = 'growth-teacher-unlocked';
  const TEACHER_PIN_SHA256 = 'a1fb4e703a9ef1fa4936801721ff285a97ac85330856674412e054892afe6972';
  const CLASS_KEY = 'movement-records-selected-class-v1';

  let students = [];
  let records = [];
  // 자신감 점수 {student_id: {before, after}} (SpeedConfidence 시트)
  let confidence = {};
  // 단어 구름 질문. SpeedWords 시트의 phase 칸에 질문 이름을 넣어 구분합니다.
  // before·after는 같은 질문(기록 줄이기)을 수업 전·후에 두 번, efficacy·gain은 수업 후에만 묻습니다.
  // 한 화면에 질문을 모두 보여 주고, 저장은 한 번에 보냅니다(통신 한 번).
  const WORD_QUESTIONS = {
    before: { label: '기록 줄이기', q: '같은 40m, 기록을 줄이려면 무엇이 중요할까?' },
    after: { label: '기록 줄이기', q: '같은 40m, 기록을 줄이려면 무엇이 중요할까?', note: '수업 전과 같은 질문이에요' },
    efficacy: { label: '자기효능감', q: '내가 생각하는 자기효능감이란?' },
    gain: { label: '깨달은 것', q: '이번 차시 수업에서 깨달은 것은?' }
  };
  const WORD_FLOW = { before: ['before'], after: ['after', 'efficacy', 'gain'] };
  // 이 화면에서 보낸 단어 {student_id: {before, after, efficacy, gain}}
  const myWords = {};
  const state = {
    screen: 'pick', classNo: null, group: '', studentId: null, method: null,
    timer: 'idle', startedAt: 0, elapsedMs: 0, timerId: null, pending: null, saving: false
  };

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (v) => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const speedOf = (sec) => DISTANCE_M / Number(sec);
  const fmtSpeed = (v) => `${v.toFixed(2)} m/s`;
  // 기록(초)과 평균속력을 같이 보여 줍니다. 한 사람 기록은 초 = 40m ÷ 평균속력이에요.
  const fmtBoth = (v, sec = DISTANCE_M / v) => `${sec.toFixed(2)}초 · ${fmtSpeed(v)}`;

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
    renderJourney();
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

  // ---- 학생 단계 카드 ----
  // 수업 전 자신감 → 세 가지 방식 → 랭킹 도전 → 수업 후 자신감. 성장판과 같은 모양으로 보여 줍니다.
  const JOURNEY_SCREENS = ['confidence', 'run', 'confirm', 'result'];
  function journeySteps(id) {
    const best = bestSpeeds(id);
    const c = confidence[id] || {};
    const allThree = METHODS.every((m) => best[m.key]);
    return [
      { key: 'before', label: '수업 전', sub: '자신감·내 생각', done: c.before !== undefined },
      ...METHODS.map((m) => ({ key: m.key, label: m.label, sub: m.key === '20x1' ? '걸음 수로 보폭' : `방향 전환 ${m.turns}번`, done: !!best[m.key] })),
      { key: 'challenge', label: '랭킹 도전', sub: '한 방식 골라 다시', done: allThree && speedRecordsOf(id).length > METHODS.length },
      { key: 'after', label: '수업 후', sub: '자신감·내 생각', done: !!c.after }
    ];
  }

  function currentStepKey() {
    if (state.screen === 'confidence') return state.confPhase;
    if (state.method) {
      const done = !!bestSpeeds(state.studentId)[state.method];
      const allThree = METHODS.every((m) => bestSpeeds(state.studentId)[m.key]);
      return allThree || (done && state.challenge) ? 'challenge' : state.method;
    }
    return state.challenge ? 'challenge' : null;
  }

  function renderJourney() {
    const student = getStudent(state.studentId);
    const show = !!student && JOURNEY_SCREENS.includes(state.screen);
    $('journey').hidden = !show;
    if (!show) return;
    const steps = journeySteps(student.student_id);
    // 고른 방식이 없으면 아직 안 한 첫 단계를 '지금 단계'로 보여 줍니다.
    const current = currentStepKey() || (steps.find((st) => !st.done) || {}).key;
    $('journey-name').textContent = student.name;
    $('journey-meta').textContent = `${student.class}반 · ${student.group_or_team} · ${student.number}번`;
    $('journey-progress').textContent = `${steps.filter((st) => st.done).length}/${steps.length}단계 완료`;
    const locked = state.timer === 'running' || state.screen === 'confirm';
    $('journey-steps').innerHTML = steps.map((st, i) => `
      <button type="button" data-step="${st.key}" class="${st.done ? 'done' : ''}" ${current === st.key ? 'aria-current="step"' : ''} ${locked ? 'disabled' : ''}>
        <span class="dot">${st.done ? '✓' : (i === 0 ? '전' : i === steps.length - 1 ? '후' : i)}</span>
        <span class="txt"><b>${st.label}</b><small>${st.sub}</small></span>
      </button>`).join('');
  }

  function openStep(key) {
    const id = state.studentId;
    if (key === 'before' || key === 'after') { openConfidence(id, key); return; }
    if (key === 'challenge') {
      openRun(id, true);
      state.challenge = true;
      renderRun();
      renderJourney();
      showToast('가장 자신 있는 방식을 골라 한 번 더 달려 보세요!');
      return;
    }
    openRun(id, true);
    state.method = key;
    renderRun();
    renderJourney();
  }

  // ---- 학생 선택 ----
  function groupsOf(classNo) {
    return [...new Set(students.filter((s) => s.class === classNo).map((s) => s.group_or_team))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  }
  function renderPick() {
    const classes = [...new Set(students.map((s) => s.class))].sort((a, b) => a - b);
    $('class-tabs').innerHTML = classes.map((c) => `<button type="button" class="class-tab${c === state.classNo ? ' is-selected' : ''}" role="tab" aria-selected="${c === state.classNo}" data-class="${c}">${c}반</button>`).join('');
    const groups = groupsOf(state.classNo);
    if (!groups.includes(state.group)) state.group = groups[0] ?? '';
    $('group-tabs').innerHTML = groups.map((g) => `<button type="button" class="group-tab${g === state.group ? ' is-selected' : ''}" role="tab" aria-selected="${g === state.group}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
    const list = students.filter((s) => s.class === state.classNo && s.group_or_team === state.group);
    $('pick-class-caption').textContent = `${state.classNo}반 수업`;
    $('pick-heading').textContent = `${state.classNo}반 ${state.group} 학생`;
    $('pick-count').textContent = list.length;
    $('pick-empty').hidden = list.length > 0;
    $('pick-empty').querySelector('strong').textContent = '아직 이 조에 학생이 없어요.';
    $('students-grid').innerHTML = list.map((s) => {
      const best = bestSpeeds(s.student_id);
      const top = Math.max(0, ...Object.values(best));
      const chips = METHODS.map((m) => `<span class="method-chip${best[m.key] ? ' is-done' : ''}">${best[m.key] ? '✓ ' : ''}${m.label}</span>`).join('');
      return `<article class="student-card">
        <button class="student-select" type="button" data-student="${escapeHtml(s.student_id)}" aria-label="${escapeHtml(s.name)} 학생 달리기">
          <div class="student-card-top">
            <span class="student-avatar" aria-hidden="true">${escapeHtml(s.name.slice(0, 1))}</span>
            <div><h3 class="student-name">${escapeHtml(s.name)}</h3><span class="student-meta">${escapeHtml(s.number)}번 · ${escapeHtml(s.group_or_team)}</span></div>
          </div>
          <dl class="student-stats">
            <div class="student-stat"><dt>뛴 방식</dt><dd>${Object.keys(best).length}<small>/3</small></dd></div>
            <div class="student-stat"><dt>최고 속력</dt><dd>${top ? top.toFixed(2) : '—'}<small>${top ? 'm/s' : ''}</small></dd></div>
          </dl>
          <div class="method-chips">${chips}</div>
        </button>
      </article>`;
    }).join('');
  }

  // ---- 측정 ----
  function renderRun() {
    const student = getStudent(state.studentId);
    if (!student) return;
    const best = bestSpeeds(student.student_id);
    $('methods').innerHTML = METHODS.map((m) => `
      <button type="button" class="method-option${state.method === m.key ? ' is-selected' : ''}" data-method="${m.key}" ${state.timer === 'running' ? 'disabled' : ''}>
        <span><strong>${m.label}</strong> <small>방향 전환 ${m.turns}번</small></span>${best[m.key] ? `<span class="done">✓ ${fmtBoth(best[m.key])}</span>` : ''}</button>`).join('');
    const seconds = state.timer === 'running' ? (performance.now() - state.startedAt) / 1000 : state.elapsedMs / 1000;
    $('digits').innerHTML = `${seconds.toFixed(2).padStart(5, '0')}<small>초</small>`;
    $('timer-card').classList.toggle('is-running', state.timer === 'running');
    $('timer-status-text').textContent = state.timer === 'running' ? '측정 중' : (state.method ? `${METHODS.find((m) => m.key === state.method).label} 준비` : '방식을 골라 주세요');
    $('start-btn').disabled = state.timer !== 'idle' || !state.method;
    $('stop-btn').disabled = state.timer !== 'running';
    $('run-hint').textContent = state.timer === 'running' ? '도착하면 STOP(또는 Enter)!' : (state.method ? 'START(또는 Enter)를 누르면 출발이에요.' : (state.challenge ? '랭킹 도전! 가장 자신 있는 방식을 골라요.' : '먼저 이번에 뛸 방식을 고르세요.'));
  }

  // ---- 자신감 (1~10) + 내 생각 ----
  // 처음 달리기 전에 한 번(before), 수업 끝에 한 번(after). 점수를 고르고 바로 아래 질문에 써서 저장 한 번으로 넘어갑니다.
  function openConfidence(studentId, phase) {
    const student = getStudent(studentId);
    if (!student) return;
    const before = phase === 'before';
    state.studentId = studentId;
    state.confPhase = phase;
    $('conf-eyebrow').textContent = before ? '수업 전 · 자신감과 내 생각' : '수업 후 · 자신감과 내 생각';
    $('conf-title').textContent = `${student.name}, ${before ? '달리기 전에' : '오늘 수업을 마치며'}`;
    $('conf-sub').textContent = before ? '정답은 없어요. 솔직하게 고르고 써 주세요. 수업이 끝나면 한 번 더 물어볼게요.' : '처음에 고른 점수와 쓴 생각을 비교해 볼 거예요.';
    state.confPick = (confidence[studentId] || {})[phase] || null;
    state.confDone = false;
    state.confSaving = false;
    // 이 화면에서 이미 보낸 질문은 빼요.
    state.wordKeys = WORD_FLOW[phase].filter((key) => !(myWords[studentId] || {})[key]);
    $('word-fields').innerHTML = state.wordKeys.map((key, i) => {
      const q = WORD_QUESTIONS[key];
      return `<label class="word-field" data-word-key="${key}">
          <span class="word-q"><b>${i + 2}</b>${q.q}${q.note ? `<small>${q.note}</small>` : ''}</span>
          <input maxlength="20" placeholder="한두 단어로 써요" aria-label="${q.q}" data-word-input="${key}">
          <span class="word-error" role="alert" hidden></span>
        </label>`;
    }).join('');
    $('word-fields').hidden = !state.wordKeys.length;
    $('conf-num').hidden = !state.wordKeys.length;
    $('conf-skip').hidden = true;
    renderConfidence();
    setScreen('confidence');
  }

  const wordValue = (key) => $('word-fields').querySelector(`[data-word-input="${key}"]`).value.replace(/\s+/g, ' ').trim();

  function renderConfidence() {
    $('conf-buttons').innerHTML = Array.from({ length: 10 }, (_, i) => `<button type="button" class="${state.confPick === i + 1 ? 'is-selected' : ''}" data-conf="${i + 1}" ${state.confSaving ? 'disabled' : ''}>${i + 1}</button>`).join('');
    const total = state.wordKeys.length;
    const filled = state.wordKeys.filter((key) => wordValue(key)).length;
    const next = state.confPhase === 'before' ? '저장하고 달리러 가기' : '저장하고 결과 보기';
    $('conf-save').disabled = !state.confPick || filled < total || state.confSaving;
    $('conf-save').innerHTML = state.confSaving ? '저장하는 중...'
      : !state.confPick ? '점수를 먼저 골라 주세요'
      : filled < total ? `${total > 1 ? `${filled}/${total} · ` : ''}질문에도 써 주세요`
      : `<span aria-hidden="true">✓</span> ${next}`;
  }

  function pickConfidence(value) {
    if (state.confSaving) return;
    state.confPick = value;
    renderConfidence();
    const empty = state.wordKeys.find((key) => !wordValue(key));
    if (empty) $('word-fields').querySelector(`[data-word-input="${empty}"]`).focus();
  }

  // 점수와 글을 한 번에 저장합니다. 둘을 동시에 보내고, 실패한 쪽만 다시 보내요.
  async function saveConfidence(event) {
    if (event) event.preventDefault();
    const student = getStudent(state.studentId);
    const phase = state.confPhase;
    const value = state.confPick;
    if (!student || !value || state.confSaving) return;
    const items = state.wordKeys.map((key) => ({ phase: key, word: wordValue(key) }));
    if (items.some((it) => !it.word)) return;
    // 질문마다 바르지 않은 말을 먼저 거르고, 걸린 칸 아래에 안내를 띄웁니다.
    let firstBad = null;
    items.forEach((it) => {
      const field = $('word-fields').querySelector(`[data-word-key="${it.phase}"]`);
      const problem = wordProblem(it.word);
      field.querySelector('.word-error').hidden = !problem;
      field.querySelector('.word-error').textContent = problem || '';
      if (problem && !firstBad) firstBad = field.querySelector('input');
    });
    if (firstBad) { firstBad.select(); return; }
    state.confSaving = true;
    renderConfidence();
    const id = student.student_id;
    const sendConf = state.confDone ? null : postJson({ type: 'speed_confidence', student_id: id, phase, value }).then((res) => {
      if (!res.ok) throw new Error(res.error?.message);
      confidence[id] = { ...(confidence[id] || {}), [phase]: value };
      state.confDone = true;
    });
    const sendWords = !items.length ? null : postJson({ type: 'speed_word', class: student.class, items }).then((res) => {
      if (!res.ok) throw new Error(res.error?.message);
      myWords[id] = { ...(myWords[id] || {}), ...Object.fromEntries(items.map((it) => [it.phase, it.word])) };
    });
    const results = await Promise.allSettled([sendConf, sendWords].filter(Boolean));
    state.confSaving = false;
    // 글이 저장됐으면 그 칸은 다시 보내지 않도록 비웁니다.
    state.wordKeys = state.wordKeys.filter((key) => !(myWords[id] || {})[key]);
    $('word-fields').querySelectorAll('.word-field').forEach((f) => { if (!state.wordKeys.includes(f.dataset.wordKey)) f.remove(); });
    $('word-fields').hidden = !state.wordKeys.length;
    const failed = results.filter((r) => r.status === 'rejected');
    if (!failed.length) {
      finishConfidence();
      showToast('저장했어요! 생각은 우리 반 단어 구름에 모여요.');
      return;
    }
    failed.forEach((r) => console.warn('저장 실패', r.reason));
    renderConfidence();
    $('conf-skip').hidden = false;
    showToast('저장하지 못했어요. 인터넷 연결을 확인하고 저장을 다시 눌러 주세요.');
  }

  // 시트 저장이 계속 안 될 때 수업이 멈추지 않도록, 이 화면에만 점수를 남기고 넘어갑니다.
  function skipConfidence() {
    const studentId = state.studentId;
    const phase = state.confPhase;
    if (state.confPick) confidence[studentId] = { ...(confidence[studentId] || {}), [phase]: state.confPick };
    else if (phase === 'before') confidence[studentId] = { ...(confidence[studentId] || {}), before: 0 };
    finishConfidence();
  }

  function finishConfidence() {
    if (state.confPhase === 'before') openRun(state.studentId, true); else openResult();
  }

  // ---- 바르지 않은 말 거르기 ----
  // 띄어쓰기·숫자·기호를 빼고 비교해서 '시1발', '개 새' 같은 변형도 걸러요. Apps Script(saveSpeedWord_)도 같은 목록으로 한 번 더 거릅니다.
  const BAD_WORDS = [
    '시발', '씨발', '씨바', '시바', '쓰발', '씨빨', '시빨', '씹', '병신', '븅신', '빙신', '병1신', '개새', '개색', '개세', '새끼', '색기', '섀끼', '좆', '존나', '졸라', '지랄', '미친', '미쳤', '닥쳐', '꺼져', '엿먹', '염병', '엠창', '느금', '니애미', '니엄마', '애미', '애비', '등신', '멍청', '바보', '찐따', '틀딱', '죽여', '자살', '섹스', '야동', '똥', '오줌', '방귀',
    'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅅㄲ', 'ㅈㄴ', 'ㅈㄹ', 'ㅁㅊ', 'ㄲㅈ', 'ㄷㅊ',
    'fuck', 'shit', 'bitch', 'sex', 'damn'
  ];
  function wordProblem(word) {
    const bare = word.toLowerCase().replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z]/g, '');
    if (BAD_WORDS.some((b) => bare.includes(b))) return '그 말은 보낼 수 없어요. 내 생각을 바른 말로 써 주세요.';
    if (!/[가-힣a-z]/.test(bare)) return 'ㅋㅋ·ㅠㅠ나 숫자·기호만으로는 보낼 수 없어요. 낱말로 써 주세요.';
    if (/(.)\1\1/.test(bare)) return '같은 글자를 여러 번 이어 쓸 수 없어요. 낱말로 써 주세요.';
    // 친구 이름(성 빼고 이름만 써도)을 쓰는 장난을 막습니다.
    const names = students.filter((st) => st.class === getStudent(state.studentId)?.class).flatMap((st) => [st.name, st.name.length === 3 ? st.name.slice(1) : null]).filter(Boolean);
    if (names.some((n) => bare.includes(n))) return '친구 이름은 쓰지 않아요. 내 생각을 낱말로 써 주세요.';
    return null;
  }

  function confidenceText(studentId) {
    const c = confidence[studentId] || {};
    if (!c.before) return '';
    if (!c.after) return `자신감: 수업 전 ${c.before}점 → 수업이 끝나면 다시 매겨요`;
    const diff = c.after - c.before;
    return `자신감: 수업 전 ${c.before}점 → 수업 후 ${c.after}점 (${diff > 0 ? '+' : ''}${diff})`;
  }

  async function refreshConfidence() {
    try {
      const res = await (await fetch(`${SHEETS_ENDPOINT}?action=speed_confidence`)).json();
      if (!res.ok || !Array.isArray(res.data)) throw new Error('자신감 응답 오류');
      const next = {};
      res.data.forEach((r) => {
        const before = Number(r.confidence_before) || null;
        const after = Number(r.confidence_after) || null;
        next[String(r.student_id)] = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
      });
      // 이 화면에서 방금 고른 점수가 시트보다 먼저일 수 있으니 합쳐 둡니다.
      Object.keys(confidence).forEach((id) => { next[id] = { ...(next[id] || {}), ...confidence[id] }; });
      confidence = next;
    } catch (error) {
      console.warn('자신감 점수를 불러오지 못했어요.', error);
    }
  }

  function openRun(studentId, skipConfidenceCheck) {
    if (!skipConfidenceCheck && (confidence[studentId] || {}).before === undefined) { openConfidence(studentId, 'before'); return; }
    state.studentId = studentId;
    state.method = null;
    state.challenge = false;
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
    renderJourney();
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
      renderJourney();
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
    $('confirm-avatar').textContent = student.name.slice(0, 1);
    $('confirm-who').textContent = `${student.class}반 · ${student.group_or_team} · ${student.number}번`;
    $('confirm-name').textContent = student.name;
    $('confirm-method').textContent = `${method.label} (40m)`;
    $('confirm-time').innerHTML = `${sec.toFixed(2)}<small>초</small>`;
    $('confirm-speed').textContent = fmtSpeed(speedOf(sec));
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
  // secs: 반 평균처럼 초를 따로 구한 경우에만 넘깁니다. 없으면 40m ÷ 평균속력.
  function barsHtml(values, secs = {}) {
    const max = Math.max(...METHODS.map((m) => values[m.key] || 0), 0.01);
    const bestKey = METHODS.reduce((b, m) => ((values[m.key] || 0) > (values[b] || 0) ? m.key : b), METHODS[0].key);
    return METHODS.map((m) => {
      const v = values[m.key];
      return `<div class="bar${v && m.key === bestKey ? ' best' : ''}"><span>${m.label}</span>
        <span class="track"><span class="fill" style="width:${v ? (v / max) * 100 : 0}%"></span></span>
        <span class="val">${v ? `<b>${(secs[m.key] || DISTANCE_M / v).toFixed(2)}초</b><small>${fmtSpeed(v)}</small>` : '아직 안 뜀'}</span></div>`;
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
    $('result-conf').textContent = confidenceText(student.student_id);
    const w = myWords[student.student_id] || {};
    $('result-words').innerHTML = [
      (w.before || w.after) && `<span><b>기록 줄이기</b> ${[w.before && `수업 전 "${escapeHtml(w.before)}"`, w.after && `수업 후 "${escapeHtml(w.after)}"`].filter(Boolean).join(' → ')}</span>`,
      w.efficacy && `<span><b>내가 생각하는 자기효능감</b> "${escapeHtml(w.efficacy)}"</span>`,
      w.gain && `<span><b>이번 차시에서 깨달은 것</b> "${escapeHtml(w.gain)}"</span>`
    ].filter(Boolean).join('');
    // 수업 후 질문까지 마친 학생만 우리 반 단어 구름을 봐요. (먼저 보면 친구 단어를 따라 쓰기 쉬워서)
    $('result-cloud').hidden = !(confidence[student.student_id] || {}).after;
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
    const sums = {}; const counts = {}; const secSums = {};
    const ranking = [];
    list.forEach((s) => {
      const best = bestSpeeds(s.student_id);
      METHODS.forEach((m) => {
        if (best[m.key]) {
          sums[m.key] = (sums[m.key] || 0) + best[m.key];
          secSums[m.key] = (secSums[m.key] || 0) + DISTANCE_M / best[m.key];
          counts[m.key] = (counts[m.key] || 0) + 1;
        }
      });
      const top = Math.max(0, ...Object.values(best));
      if (top > 0) {
        const topKey = Object.keys(best).find((k) => best[k] === top);
        ranking.push({ name: s.name, group: s.group_or_team, speed: top, method: METHODS.find((m) => m.key === topKey).label });
      }
    });
    const avg = {}; const avgSec = {};
    METHODS.forEach((m) => { if (counts[m.key]) { avg[m.key] = sums[m.key] / counts[m.key]; avgSec[m.key] = secSums[m.key] / counts[m.key]; } });
    ranking.sort((a, b) => b.speed - a.speed);
    return { avg, avgSec, counts, ranking, runners: ranking.length };
  }

  function renderBoard() {
    const sum = classSummary();
    $('board-title').textContent = `${state.classNo}반 현황`;
    $('board-bars').innerHTML = barsHtml(sum.avg, sum.avgSec);
    $('rank-body').innerHTML = sum.ranking.length
      ? sum.ranking.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.name)} <span class="muted">${escapeHtml(r.group)}</span></td><td>${r.method}</td><td class="num">${fmtBoth(r.speed)}</td></tr>`).join('')
      : '<tr><td class="muted" colspan="4">아직 기록이 없어요.</td></tr>';
    const scores = students.filter((s) => s.class === state.classNo).map((s) => confidence[s.student_id] || {});
    const mean = (list) => (list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1) : null);
    const before = mean(scores.map((c) => c.before).filter(Boolean));
    const after = mean(scores.map((c) => c.after).filter(Boolean));
    $('board-conf').textContent = before ? `우리 반 자신감 평균: 수업 전 ${before}점${after ? ` → 수업 후 ${after}점` : ''}` : '';
  }

  function openBoard() {
    renderBoard();
    $('class-ai-box').hidden = true;
    setScreen('board');
    // 다른 크롬북에서 저장한 기록도 보이도록 시트에서 다시 불러와 그립니다.
    Promise.all([refreshRecords(), refreshConfidence()]).then(([ok]) => { if (ok && state.screen === 'board') renderBoard(); });
  }

  // ---- 교사 현황 (선생님 번호로 잠금) ----
  // 반 학생마다 수업 전 자신감 → 세 방식 평균속력 → 랭킹 도전 → 수업 후 자신감을 한 줄로 봅니다.
  let teacherUnlocked = (() => { try { return sessionStorage.getItem(TEACHER_UNLOCK_KEY) === '1'; } catch (e) { return false; } })();

  async function sha256(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function teacherRows() {
    return students.filter((s) => s.class === state.classNo).sort((a, b) => a.number - b.number).map((s) => {
      const best = bestSpeeds(s.student_id);
      const c = confidence[s.student_id] || {};
      const steps = journeySteps(s.student_id);
      return { s, best, c, stride: strideOf(s.student_id), runs: speedRecordsOf(s.student_id).length, done: steps.filter((st) => st.done).length, total: steps.length };
    });
  }

  function renderTeacher() {
    $('teacher-lock').hidden = teacherUnlocked;
    $('teacher-body').hidden = !teacherUnlocked;
    if (!teacherUnlocked) return;
    const classes = [...new Set(students.map((s) => s.class))].sort((a, b) => a - b);
    $('teacher-class-tabs').innerHTML = classes.map((c) => `<button type="button" class="class-tab${c === state.classNo ? ' is-selected' : ''}" data-class="${c}">${c}반</button>`).join('');
    $('teacher-title').textContent = `${state.classNo}반 교사 현황`;
    if ($('reset-form').hidden) $('reset-class').innerHTML = classes.map((c) => `<option value="${c}"${c === state.classNo ? ' selected' : ''}>${c}반만</option>`).join('') + '<option value="all">모든 반</option>';
    const rows = teacherRows();
    const mean = (list) => (list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1) : '—');
    const befores = rows.map((r) => r.c.before).filter(Boolean);
    const afters = rows.map((r) => r.c.after).filter(Boolean);
    $('teacher-summary').innerHTML = [
      `참여 <strong>${rows.filter((r) => r.runs).length}</strong>/${rows.length}명`,
      `세 방식 모두 <strong>${rows.filter((r) => METHODS.every((m) => r.best[m.key])).length}</strong>명`,
      `수업 후 자신감까지 <strong>${afters.length}</strong>명`,
      `자신감 평균 <strong>${mean(befores)} → ${mean(afters)}</strong>점`
    ].map((t) => `<span class="t-chip">${t}</span>`).join('');
    const cell = (v) => (v ? `${(DISTANCE_M / v).toFixed(2)}초<small>${v.toFixed(2)} m/s</small>` : '<span class="muted">—</span>');
    $('teacher-rows').innerHTML = rows.length ? rows.map((r) => {
      const diff = r.c.before && r.c.after ? r.c.after - r.c.before : null;
      return `<tr>
        <td>${r.s.number}</td><td><b>${escapeHtml(r.s.name)}</b> <span class="muted">${escapeHtml(r.s.group_or_team)}</span></td>
        <td class="num">${r.c.before || '<span class="muted">—</span>'}</td>
        ${METHODS.map((m) => `<td class="num">${cell(r.best[m.key])}</td>`).join('')}
        <td class="num">${r.stride ? `${r.stride.toFixed(2)}m` : '<span class="muted">—</span>'}</td>
        <td class="num">${r.runs}</td>
        <td class="num">${r.c.after || '<span class="muted">—</span>'}</td>
        <td class="num ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff === null ? '<span class="muted">—</span>' : `${diff > 0 ? '+' : ''}${diff}`}</td>
        <td class="num"><span class="t-progress${r.done === r.total ? ' is-done' : ''}">${r.done}/${r.total}</span></td>
      </tr>`;
    }).join('') : '<tr><td class="muted" colspan="11">이 반 학생이 없어요.</td></tr>';
  }

  function openTeacher() {
    setScreen('teacher');
    $('pin-error').hidden = true;
    renderTeacher();
    if (!teacherUnlocked) { $('pin-input').focus(); return; }
    Promise.all([refreshRecords(), refreshConfidence()]).then(() => { if (state.screen === 'teacher') renderTeacher(); });
  }

  async function unlockTeacher(event) {
    event.preventDefault();
    const pin = $('pin-input').value.trim();
    if (pin && await sha256(pin) === TEACHER_PIN_SHA256) {
      teacherUnlocked = true;
      try { sessionStorage.setItem(TEACHER_UNLOCK_KEY, '1'); } catch (e) { /* 무시 */ }
      $('pin-input').value = '';
      openTeacher();
    } else {
      $('pin-error').hidden = false;
      $('pin-input').select();
    }
  }

  // 2차시 기록 초기화: 속력 탐구 기록(Records의 speed_*)과 자신감·단어 시트만 지웁니다. 1차시 기록은 그대로예요.
  async function resetSpeed(event) {
    event.preventDefault();
    const pin = $('reset-pin').value.trim();
    const target = $('reset-class').value;
    const classNo = target === 'all' ? null : Number(target);
    const fail = (msg) => { $('reset-error').textContent = msg; $('reset-error').hidden = false; };
    if (!pin) { fail('선생님 번호를 넣어 주세요.'); return; }
    let result;
    try {
      // 예전 Apps Script는 scope를 모르고 1차시 기록을 지우므로, 새 배포인지 먼저 확인합니다.
      const info = await (await fetch(SHEETS_ENDPOINT, { cache: 'no-store' })).json();
      if (!(info.features || []).includes('reset_scope')) {
        fail('Apps Script를 새 버전으로 배포한 뒤에 2차시만 따로 지울 수 있어요. 아무것도 지우지 않았어요.');
        return;
      }
      result = await postJson(classNo ? { type: 'reset_class', class: classNo, pin, scope: 'speed' } : { type: 'reset', pin, scope: 'speed' });
    } catch (error) {
      fail('인터넷 연결을 확인하고 다시 눌러 주세요.'); return;
    }
    if (!result.ok) {
      fail(result.error?.code === 'INVALID_PIN' ? '번호가 맞지 않아요.' : '초기화하지 못했어요. 잠시 후 다시 눌러 주세요.');
      return;
    }
    if (result.scope !== 'speed') {
      fail('Apps Script를 새 버전으로 배포해야 2차시만 따로 지울 수 있어요. 시트의 백업 탭을 확인해 주세요.');
      return;
    }
    const inTarget = (id) => !classNo || getStudent(id)?.class === classNo;
    Object.keys(confidence).filter(inTarget).forEach((id) => { delete confidence[id]; });
    Object.keys(myWords).filter(inTarget).forEach((id) => { delete myWords[id]; });
    const steps = readSteps();
    Object.keys(steps).filter(inTarget).forEach((id) => { delete steps[id]; });
    writeSteps(steps);
    $('reset-pin').value = '';
    $('reset-form').hidden = true;
    await Promise.all([refreshRecords(), refreshConfidence()]);
    renderTeacher();
    showToast(`${classNo ? `${classNo}반` : '모든 반'} 2차시 기록을 지웠어요. 지운 내용은 시트의 '백업' 탭에 있어요.`);
  }

  function teacherCsv() {
    const head = ['번호', '이름', '조', '수업 전 자신감', ...METHODS.flatMap((m) => [`${m.label} 기록(초)`, `${m.label} 평균속력(m/s)`]), '보폭(m)', '달린 횟수', '수업 후 자신감', '자신감 변화'];
    const lines = teacherRows().map((r) => [r.s.number, r.s.name, r.s.group_or_team, r.c.before || '', ...METHODS.flatMap((m) => (r.best[m.key] ? [(DISTANCE_M / r.best[m.key]).toFixed(2), r.best[m.key].toFixed(2)] : ['', ''])), r.stride ? r.stride.toFixed(2) : '', r.runs, r.c.after || '', r.c.before && r.c.after ? r.c.after - r.c.before : '']);
    return [head, ...lines].map((row) => row.join('\t')).join('\n');
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
      $('pick-empty').querySelector('strong').textContent = '학생 명단을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.';
      return;
    }
    const classes = [...new Set(students.map((s) => s.class))].sort((a, b) => a - b);
    const stored = Number(localStorage.getItem(CLASS_KEY));
    state.classNo = classes.includes(stored) ? stored : classes[0];
    renderPick();
    const [ok] = await Promise.all([refreshRecords(), refreshConfidence()]);
    if (ok) renderPick();
  }

  // ---- 입력 ----
  document.addEventListener('click', (event) => {
    const t = event.target.closest('[data-class],[data-group],[data-student],[data-method],[data-step],[data-conf],[data-action]');
    if (!t) return;
    if (state.timer === 'running' && !t.matches('[data-action="stop"]')) { showToast('측정 중이에요. 먼저 STOP을 눌러 주세요.'); return; }
    if (t.dataset.class) { state.classNo = Number(t.dataset.class); try { localStorage.setItem(CLASS_KEY, String(state.classNo)); } catch (e) { /* 무시 */ } renderPick(); if (state.screen === 'teacher') renderTeacher(); return; }
    if (t.dataset.group !== undefined && !t.dataset.action) { state.group = t.dataset.group; renderPick(); return; }
    if (t.dataset.student) { openRun(t.dataset.student); return; }
    if (t.dataset.method) { state.method = t.dataset.method; renderRun(); renderJourney(); return; }
    if (t.dataset.step) { openStep(t.dataset.step); return; }
    if (t.dataset.conf) { pickConfidence(Number(t.dataset.conf)); return; }
    const action = t.dataset.action;
    if (action === 'start') start();
    else if (action === 'stop') stop();
    else if (action === 'save') save();
    else if (action === 'cancel') { state.timer = 'idle'; state.elapsedMs = 0; state.pending = null; setScreen('run'); renderRun(); showToast('저장하지 않았어요.'); }
    else if (action === 'open-result') openResult();
    else if (action === 'back-run') openRun(state.studentId);
        else if (action === 'conf-skip') skipConfidence();
    else if (action === 'conf-after') openConfidence(state.studentId, 'after');
    else if (action === 'coach') coach();
    else if (action === 'go-pick') { setScreen('pick'); renderPick(); }
    else if (action === 'go-board') openBoard();
    else if (action === 'go-teacher') openTeacher();
    else if (action === 'reset-open') { $('reset-form').hidden = false; $('reset-error').hidden = true; $('reset-pin').focus(); }
    else if (action === 'reset-close') $('reset-form').hidden = true;
    else if (action === 'lock-teacher') { teacherUnlocked = false; try { sessionStorage.removeItem(TEACHER_UNLOCK_KEY); } catch (e) { /* 무시 */ } renderTeacher(); }
    else if (action === 'teacher-csv') navigator.clipboard.writeText(teacherCsv()).then(() => showToast('복사했어요. 스프레드시트에 붙여 넣으세요.'), () => showToast('복사하지 못했어요.'));
    else if (action === 'class-ai') classAi();
  });

  $('steps-input').addEventListener('input', updateStridePreview);
  // 칸에서 Enter를 누르면 아직 빈 다음 칸으로 넘어가고, 다 쓰면 저장합니다.
  $('word-fields').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const empty = state.wordKeys.find((key) => !wordValue(key));
    if (!empty) return;
    event.preventDefault();
    $('word-fields').querySelector(`[data-word-input="${empty}"]`).focus();
  });
  $('word-fields').addEventListener('input', (event) => {
    const err = event.target.closest('.word-field')?.querySelector('.word-error');
    if (err) err.hidden = true;
    renderConfidence();
  });
  $('conf-form').addEventListener('submit', saveConfidence);
  $('pin-form').addEventListener('submit', unlockTeacher);
  $('reset-form').addEventListener('submit', resetSpeed);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.repeat || state.screen !== 'run') return;
    event.preventDefault();
    if (state.timer === 'idle') start();
    else if (state.timer === 'running' && performance.now() - state.startedAt >= ENTER_STOP_GUARD_MS) stop();
  });

  init();
})();
