// 타이머 시작·정지 신호음. 소리 파일 없이 Web Audio로 만들어서 인터넷이 없어도 납니다.
// 시작은 짧고 높은 "삐", 정지는 낮은 "삐삐" 두 번이라 귀로만 들어도 구분돼요.
(function () {
  let ctx = null;

  function tone(at, freq, dur) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    // 딸깍 소리가 나지 않도록 아주 짧게 키웠다가 줄여요.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.setValueAtTime(0.25, at + dur - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  window.timerBeep = function (kind) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      // 브라우저는 키·클릭 같은 사용자 입력 안에서만 소리를 허락해서, 처음 누를 때 만들어요.
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime + 0.01;
      if (kind === 'stop') {
        tone(t, 660, 0.12);
        tone(t + 0.18, 660, 0.12);
      } else {
        tone(t, 1320, 0.15);
      }
    } catch (e) {
      // 소리가 안 나도 타이머는 그대로 동작해야 해요.
    }
  };
})();
