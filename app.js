(function () {
  'use strict';

  // Utilities
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const formatTime = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  };

  // Persistence
  class StorageService {
    constructor(namespace) { this.ns = namespace; }
    get(key, fallback) {
      try { const v = localStorage.getItem(`${this.ns}:${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    }
    set(key, value) { try { localStorage.setItem(`${this.ns}:${key}`, JSON.stringify(value)); } catch {} }
  }

  // Sound feedback
  class SoundService {
    constructor() { this.enabled = true; this.ctx = null; }
    setEnabled(flag) { this.enabled = !!flag; }
    ensureCtx() { if (!this.ctx) { const Ctx = window.AudioContext || window.webkitAudioContext; this.ctx = new Ctx(); } }
    beep(freq = 880, durMs = 120, type = 'sine', gain = 0.02) {
      if (!this.enabled) return;
      this.ensureCtx();
      const { ctx } = this; const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = gain; o.connect(g); g.connect(ctx.destination);
      const now = ctx.currentTime; o.start(now); o.stop(now + durMs / 1000);
    }
    chime() { this.beep(660, 120, 'sine', 0.03); setTimeout(() => this.beep(990, 120, 'sine', 0.03), 140); }
    tick() { this.beep(420, 40, 'square', 0.01); }
  }

  // Abductive Suggestion Engine (rule-based heuristics)
  class SuggestionEngine {
    constructor(storage) { this.storage = storage; }
    suggest(task, sliders, history) {
      const energy = sliders.energy || 3; // 1-5
      const distraction = sliders.distraction || 3; // 1-5
      const tag = (task && task.tag) || 'generic';

      // Baseline pulse length: shorter, flexible for ADHD
      let focusMin = 8; // minutes
      if (['coding','writing','study'].includes(tag)) focusMin = 12;
      if (['admin','chores'].includes(tag)) focusMin = 7;

      // Adjust by energy and distraction
      focusMin += Math.round((energy - 3) * 1.5);
      focusMin -= Math.round((distraction - 3) * 1.0);
      focusMin = clamp(focusMin, 5, 18);

      // Micro-break and macro-break
      let microSec = 40 + (distraction - 3) * 10; // seconds
      microSec = clamp(microSec, 20, 90);
      let macroMin = energy >= 4 ? 6 : 8;

      // Pulses per set influenced by tag and history
      const last = history?.lastSession || {};
      let pulsesPerSet = ['coding','writing','study'].includes(tag) ? 4 : 3;
      if (last.tag === tag && last.completedPulses >= pulsesPerSet) pulsesPerSet = clamp(pulsesPerSet + 1, 3, 6);

      const why = this.makeWhy(task, energy, distraction, tag);
      return {
        focusSeconds: focusMin * 60,
        microBreakSeconds: microSec,
        macroBreakSeconds: macroMin * 60,
        pulsesPerSet,
        tag,
        rationale: why,
      };
    }
    makeWhy(task, energy, distraction, tag) {
      const parts = [];
      if (task?.title) parts.push(`Focus on ?${task.title}?`);
      parts.push(`Energy ${energy}/5, distraction ${distraction}/5`);
      const tagPhrase = {
        coding: 'Deep build', writing: 'Generate words', study: 'Active recall', admin: 'Quick admin sweep', chores: 'Momentum burst'
      }[tag] || 'Momentum pulse';
      parts.push(tagPhrase);
      return parts.join(' ? ');
    }
  }

  // Timer Engine: focus pulse -> micro-break; after set -> macro-break.
  class TimerEngine {
    constructor(onUpdate, onPhase, onEvent) {
      this.onUpdate = onUpdate; this.onPhase = onPhase; this.onEvent = onEvent;
      this.reset();
    }
    configure(plan) { this.plan = plan; }
    reset() {
      this.phase = 'idle'; // idle|focus|micro|macro
      this.remaining = 0; this.total = 0; this.timerId = null; this.startTs = 0; this.pulsesDone = 0; this.paused = false;
    }
    startFocus() {
      if (!this.plan) return;
      this.setPhase('focus', this.plan.focusSeconds);
    }
    setPhase(phase, seconds) {
      this.phase = phase; this.total = seconds; this.remaining = seconds; this.startTs = performance.now(); this.paused = false;
      this.onPhase?.(phase, seconds, this.pulsesDone);
      this.tickLoop();
    }
    tickLoop() {
      cancelAnimationFrame(this.timerId);
      const loop = () => {
        if (this.paused || this.phase === 'idle') return;
        const now = performance.now();
        const elapsed = Math.floor((now - this.startTs) / 1000);
        const remain = clamp(this.total - elapsed, 0, this.total + 999999);
        this.remaining = remain;
        this.onUpdate?.(this.phase, remain, this.total, this.pulsesDone);
        if (remain <= 0) {
          this.advance();
          return;
        }
        this.timerId = requestAnimationFrame(loop);
      };
      this.timerId = requestAnimationFrame(loop);
    }
    pause() { this.paused = true; cancelAnimationFrame(this.timerId); }
    resume() { if (this.phase === 'idle') return; this.paused = false; this.total = this.remaining; this.startTs = performance.now(); this.tickLoop(); }
    adjust(deltaSec) { this.total = clamp(this.total + deltaSec, 10, 3600); this.remaining = clamp(this.remaining + deltaSec, 0, this.total); this.startTs = performance.now(); }
    skip() { this.advance(true); }
    advance(skipped = false) {
      if (this.phase === 'focus') {
        this.pulsesDone += 1;
        const setCompleted = this.pulsesDone % (this.plan.pulsesPerSet || 4) === 0;
        this.onEvent?.({ type: 'pulse_complete', skipped, pulsesDone: this.pulsesDone });
        if (setCompleted) {
          this.setPhase('macro', this.plan.macroBreakSeconds);
        } else {
          this.setPhase('micro', this.plan.microBreakSeconds);
        }
      } else if (this.phase === 'micro' || this.phase === 'macro') {
        this.onEvent?.({ type: this.phase + '_complete', skipped });
        this.startFocus();
      } else {
        this.startFocus();
      }
    }
  }

  // App State and UI
  const storage = new StorageService('tomato-clues');
  const sound = new SoundService();
  const suggest = new SuggestionEngine(storage);

  const state = {
    tasks: storage.get('tasks', []),
    currentTag: null,
    sliders: storage.get('sliders', { energy: 3, distraction: 3 }),
    plan: storage.get('plan', null),
    stats: storage.get('stats', { points: 0, streak: 0, lastDay: null, pulses: 0, lastSession: null }),
    settings: storage.get('settings', { dark: true, sound: true }),
    intent: storage.get('intent', ''),
  };

  function save() {
    storage.set('tasks', state.tasks);
    storage.set('sliders', state.sliders);
    storage.set('plan', state.plan);
    storage.set('stats', state.stats);
    storage.set('settings', state.settings);
    storage.set('intent', state.intent);
  }

  // DOM elements
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    intent: $('#intentText'),
    taskInput: $('#taskInput'),
    addTaskBtn: $('#addTaskBtn'),
    chips: $all('.chip'),
    energy: $('#energy'),
    distraction: $('#distraction'),
    suggestionText: $('#suggestionText'),
    acceptSuggestion: $('#acceptSuggestion'),
    refreshSuggestion: $('#refreshSuggestion'),
    taskList: $('#taskList'),
    // Timer
    progressRing: $('#progressRing'),
    phaseLabel: $('#phaseLabel'),
    timeLabel: $('#timeLabel'),
    pulseCount: $('#pulseCount'),
    startPauseBtn: $('#startPauseBtn'),
    skipBtn: $('#skipBtn'),
    minusBtn: $('#minusBtn'),
    plusBtn: $('#plusBtn'),
    // Stats
    points: $('#points'), streak: $('#streak'), completed: $('#completed'),
    rewardCard: $('#rewardCard'), rewardText: $('#rewardText'),
    eventLog: $('#eventLog'),
    darkModeToggle: $('#darkModeToggle'),
    soundToggle: $('#soundToggle'),
  };

  // Initialize settings
  function applyTheme() {
    document.body.classList.toggle('theme-dark', !!state.settings.dark);
    el.darkModeToggle.textContent = state.settings.dark ? 'Dark' : 'Light';
    el.darkModeToggle.setAttribute('aria-pressed', String(!!state.settings.dark));
  }
  function applySound() {
    sound.setEnabled(!!state.settings.sound);
    el.soundToggle.textContent = state.settings.sound ? '??' : '??';
    el.soundToggle.setAttribute('aria-pressed', String(!!state.settings.sound));
  }

  // Task rendering
  function renderTasks() {
    el.taskList.innerHTML = '';
    state.tasks.forEach((t, i) => {
      const li = document.createElement('li'); li.className = 'task-item';
      const title = document.createElement('div'); title.className = 'title'; title.textContent = t.title;
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${t.tag} ? E${t.energy} ? D${t.distraction}`;
      const left = document.createElement('div'); left.appendChild(title); left.appendChild(meta);
      const right = document.createElement('div');
      const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Use';
      btn.addEventListener('click', () => { state.currentTag = t.tag; proposePlan(t); });
      right.appendChild(btn);
      li.appendChild(left); li.appendChild(right);
      el.taskList.appendChild(li);
    });
  }

  // Suggestion and plan
  function proposePlan(task) {
    const plan = suggest.suggest(task, state.sliders, state.stats);
    state.plan = plan; save();
    el.suggestionText.textContent = `${plan.rationale} ? Focus ${Math.round(plan.focusSeconds/60)}m, micro ${plan.microBreakSeconds}s, macro ${Math.round(plan.macroBreakSeconds/60)}m, ${plan.pulsesPerSet} pulses`;
    el.acceptSuggestion.disabled = false;
  }

  // Timer visuals
  const CIRCUMFERENCE = 2 * Math.PI * 90; // r=90
  el.progressRing.style.strokeDasharray = `${CIRCUMFERENCE}`;
  function setProgress(fraction) {
    const offset = CIRCUMFERENCE * (1 - fraction);
    el.progressRing.style.strokeDashoffset = String(offset);
  }

  // Stats & rewards
  function ensureStreak() {
    const today = new Date().toISOString().slice(0,10);
    if (state.stats.lastDay !== today) {
      state.stats.streak = (state.stats.lastDay && ((new Date(today) - new Date(state.stats.lastDay)) === 86400000)) ? (state.stats.streak + 1) : (state.stats.lastDay ? 1 : 1);
      state.stats.lastDay = today; save();
    }
  }
  function rewardPulse() {
    ensureStreak();
    state.stats.points += 10; state.stats.pulses += 1; save();
    el.points.textContent = String(state.stats.points);
    el.completed.textContent = String(state.stats.pulses);
    el.streak.textContent = String(state.stats.streak);
    el.rewardText.textContent = '+10 points ? Keep going ??';
    el.rewardCard.hidden = false; setTimeout(() => el.rewardCard.hidden = true, 3200);
  }
  function logEvent(text) {
    const li = document.createElement('li'); li.textContent = text; el.eventLog.prepend(li);
  }

  // Timer engine wiring
  const engine = new TimerEngine(
    (phase, remain, total, pulsesDone) => {
      el.phaseLabel.textContent = phase === 'focus' ? 'Focus' : phase === 'micro' ? 'Micro break' : phase === 'macro' ? 'Macro break' : 'Idle';
      el.timeLabel.textContent = formatTime(remain);
      setProgress(total > 0 ? (1 - remain / total) : 0);
      el.pulseCount.textContent = `${pulsesDone} pulses`;
      if (phase === 'focus' && remain % 60 === 0 && remain > 0) sound.tick();
      // Hyperfocus guard nudge
      if (phase === 'focus' && remain <= 0) {
        // handled in advance
      }
    },
    (phase) => {
      if (phase === 'focus') { sound.chime(); logEvent('Focus pulse started'); }
      if (phase === 'micro') { sound.chime(); logEvent('Micro-break started'); }
      if (phase === 'macro') { sound.chime(); logEvent('Macro-break started'); }
      updateStartBtn();
    },
    (evt) => {
      if (evt.type === 'pulse_complete') { rewardPulse(); logEvent('Pulse completed'); }
      if (evt.type === 'micro_complete') { logEvent('Micro-break complete'); }
      if (evt.type === 'macro_complete') { logEvent('Macro-break complete'); }
      save();
    }
  );

  // Controls
  function updateStartBtn() {
    if (engine.phase === 'idle') { el.startPauseBtn.textContent = 'Start'; return; }
    el.startPauseBtn.textContent = engine.paused ? 'Resume' : 'Pause';
  }

  el.acceptSuggestion.addEventListener('click', () => {
    if (!state.plan) return;
    engine.configure(state.plan);
    engine.reset();
    engine.startFocus();
  });
  el.refreshSuggestion.addEventListener('click', () => {
    const task = state.tasks[0] || { title: 'Generic pulse', tag: state.currentTag || 'generic', energy: state.sliders.energy, distraction: state.sliders.distraction };
    proposePlan(task);
  });
  el.startPauseBtn.addEventListener('click', () => {
    if (engine.phase === 'idle') {
      if (!state.plan) {
        const t = state.tasks[0] || { title: 'Generic pulse', tag: 'generic', energy: state.sliders.energy, distraction: state.sliders.distraction };
        proposePlan(t);
        engine.configure(state.plan);
      }
      engine.startFocus();
    } else {
      if (engine.paused) engine.resume(); else engine.pause();
    }
    updateStartBtn();
  });
  el.skipBtn.addEventListener('click', () => engine.skip());
  el.plusBtn.addEventListener('click', () => engine.adjust(+30));
  el.minusBtn.addEventListener('click', () => engine.adjust(-30));

  // Inputs & settings
  el.intent.value = state.intent || '';
  el.intent.addEventListener('input', (e) => { state.intent = e.target.value; save(); });
  el.energy.value = state.sliders.energy;
  el.distraction.value = state.sliders.distraction;
  el.energy.addEventListener('input', (e) => { state.sliders.energy = Number(e.target.value); save(); });
  el.distraction.addEventListener('input', (e) => { state.sliders.distraction = Number(e.target.value); save(); });

  el.chips.forEach((c) => {
    c.addEventListener('click', () => {
      el.chips.forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      state.currentTag = c.dataset.tag; save();
    });
  });

  el.addTaskBtn.addEventListener('click', () => {
    const title = (el.taskInput.value || '').trim();
    if (!title) return;
    const task = {
      id: Date.now(), title,
      tag: state.currentTag || 'generic',
      energy: state.sliders.energy, distraction: state.sliders.distraction,
    };
    state.tasks.unshift(task); save(); el.taskInput.value = '';
    renderTasks(); proposePlan(task); sound.chime();
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && e.key !== 'Escape') return;
    if (e.code === 'Space') { e.preventDefault(); el.startPauseBtn.click(); }
    if (e.key.toLowerCase() === 'n') { engine.skip(); }
    if (e.key === '+') { engine.adjust(+30); }
    if (e.key === '-') { engine.adjust(-30); }
    if (e.key.toLowerCase() === 'd') { state.settings.dark = !state.settings.dark; save(); applyTheme(); }
  });

  // Theme & sound toggles
  el.darkModeToggle.addEventListener('click', () => { state.settings.dark = !state.settings.dark; save(); applyTheme(); });
  el.soundToggle.addEventListener('click', () => { state.settings.sound = !state.settings.sound; save(); applySound(); sound.chime(); });

  // Initial render
  applyTheme(); applySound(); renderTasks();
  el.points.textContent = String(state.stats.points);
  el.completed.textContent = String(state.stats.pulses);
  el.streak.textContent = String(state.stats.streak);

  // Initial suggestion (if any)
  if (state.tasks[0]) proposePlan(state.tasks[0]);
})();
