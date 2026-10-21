// 반별 초기화: 시트가 알려 주는 반별 초기화 시각이 바뀌었으면, 이 크롬북에서 그 반 학생의 기록만 지웁니다.
// 성장판(growth.js)과 측정 앱(app.js)이 학생 명단을 불러올 때 함께 씁니다. 다른 반 기록은 그대로 둡니다.
(function () {
  const MARK_KEY = 'movement-records-reset-class-v1';
  const GROWTH_KEY = 'movement-records-growth-v1';
  const OUTBOX_KEY = 'movement-records-growth-outbox-v1';
  const PARTNER_KEY = 'movement-records-partner-v1';
  const RECORDS_KEY = 'movement-records-obstacle-run-v1';

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* 무시 */ }
  }
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function clearStudents(ids) {
    const mine = (id) => ids.has(String(id));
    const runs = read(GROWTH_KEY);
    if (isMap(runs)) { Object.keys(runs).filter(mine).forEach((id) => delete runs[id]); write(GROWTH_KEY, runs); }
    const outbox = read(OUTBOX_KEY);
    if (isMap(outbox)) {
      if (Array.isArray(outbox.records)) outbox.records = outbox.records.filter((r) => !mine(r && r.student_id));
      if (Array.isArray(outbox.growth)) outbox.growth = outbox.growth.filter((id) => !mine(id));
      write(OUTBOX_KEY, outbox);
    }
    const partners = read(PARTNER_KEY);
    if (isMap(partners)) { Object.keys(partners).filter(mine).forEach((id) => delete partners[id]); write(PARTNER_KEY, partners); }
    const records = read(RECORDS_KEY);
    if (Array.isArray(records)) write(RECORDS_KEY, records.filter((r) => !mine(r && r.student_id)));
  }

  // marks: { "1": "2026-10-21T..." }. 지운 것이 있으면 true를 돌려줘요. 그때는 메모리에 읽어 둔 기록도 다시 읽어야 해요.
  window.applyClassResets = function (marks, students) {
    if (!isMap(marks) || !Array.isArray(students)) return false;
    const seen = isMap(read(MARK_KEY)) ? read(MARK_KEY) : {};
    let cleared = false;
    Object.keys(marks).forEach((cls) => {
      if (!marks[cls] || seen[cls] === marks[cls]) return;
      clearStudents(new Set(students.filter((s) => String(s.class) === String(cls)).map((s) => String(s.student_id))));
      seen[cls] = marks[cls];
      cleared = true;
    });
    if (cleared) write(MARK_KEY, seen);
    return cleared;
  };
})();
