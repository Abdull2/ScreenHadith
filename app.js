(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'mishkat-hadith-screen-settings-v1';
  const DEFAULTS = {
    sources: { nawawi: true, riyad: true, agreed: true },
    duration: 20,
    order: 'random',
    maxChars: 620,
    theme: 'night',
    clock: true,
    autoHide: true
  };

  const state = {
    libraries: { nawawi: [], riyad: [], agreed: [] },
    pool: [],
    history: [],
    historyPos: -1,
    sequentialIndex: -1,
    current: null,
    paused: false,
    started: false,
    transitioning: false,
    settings: loadSettings(),
    startedAt: 0,
    elapsedBeforePause: 0,
    raf: 0,
    controlsTimer: 0,
    wakeLock: null
  };

  function loadSettings() {
    try {
      const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!v || typeof v !== 'object') return structuredClone(DEFAULTS);
      return {
        ...structuredClone(DEFAULTS),
        ...v,
        sources: { ...DEFAULTS.sources, ...(v.sources || {}) }
      };
    } catch { return structuredClone(DEFAULTS); }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function escText(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }

  function riyadSourceHint(text) {
    const s = escText(text);
    const matches = [...s.matchAll(/\(\(([^()]{2,180})\)\)/g)].map(m => m[1].trim());
    return matches.length ? matches.slice(-2).join(' — ') : '';
  }

  function normalizeNawawi(data) {
    return (data.items || []).map(x => ({
      id: `nawawi-${x.n}`,
      collection: 'nawawi',
      collectionLabel: 'الأربعون النووية',
      book: 'الأربعون النووية',
      n: Number(x.n || 0),
      title: escText(x.title),
      text: escText(x.text),
      meta: `الحديث ${x.n}${x.title ? ` — ${x.title}` : ''}`,
      source: escText(x.takhrij || 'الأربعون النووية')
    })).filter(x => x.text);
  }

  function normalizeRiyad(data) {
    const out = [];
    for (const book of (data.books || [])) {
      for (const x of (book.items || [])) {
        const raw = escText(x.t);
        if (!raw) continue;
        out.push({
          id: `riyad-${x.n}`,
          collection: 'riyad',
          collectionLabel: 'رياض الصالحين',
          book: escText(book.name),
          n: Number(x.n || 0),
          title: '',
          text: raw,
          meta: `${escText(book.name)} — الحديث ${x.n}`,
          source: riyadSourceHint(raw) || 'رياض الصالحين — الإمام النووي'
        });
      }
    }
    return out;
  }

  function normalizeAgreed(data) {
    return (data.items || []).map((x, i) => ({
      id: x.id || `agreed-${i+1}`,
      collection: 'agreed',
      collectionLabel: 'مختارات المتفق عليه',
      book: 'اللؤلؤ والمرجان فيما اتفق عليه الشيخان',
      n: i + 1,
      title: escText(x.title),
      text: escText(x.text),
      meta: `${escText(x.narrator)}${x.title ? ` — ${escText(x.title)}` : ''}`,
      source: `متفق عليه${x.bukhari ? ` — البخاري ${x.bukhari}` : ''}${x.muslim ? ` — مسلم ${x.muslim}` : ''}`
    })).filter(x => x.text);
  }

  async function loadLibraries() {
    const [nawawi, riyad, agreed] = await Promise.all([
      fetch('nawawi40.json').then(r => { if(!r.ok) throw new Error('nawawi'); return r.json(); }),
      fetch('riyad.json').then(r => { if(!r.ok) throw new Error('riyad'); return r.json(); }),
      fetch('agreed-hadith.json').then(r => { if(!r.ok) throw new Error('agreed'); return r.json(); })
    ]);
    state.libraries.nawawi = normalizeNawawi(nawawi);
    state.libraries.riyad = normalizeRiyad(riyad);
    state.libraries.agreed = normalizeAgreed(agreed);
    $('countNawawi').textContent = `(${state.libraries.nawawi.length})`;
    $('countRiyad').textContent = `(${state.libraries.riyad.length})`;
    $('countAgreed').textContent = `(${state.libraries.agreed.length})`;
    const total = Object.values(state.libraries).reduce((n, arr) => n + arr.length, 0);
    $('librarySummary').textContent = `${total.toLocaleString('ar-EG')} نصًا متاحًا محليًا للتجربة`;
    $('startBtn').disabled = false;
    $('startFullscreenBtn').disabled = false;
    rebuildPool();
  }

  function rebuildPool() {
    const max = Number(state.settings.maxChars || 0);
    const selected = [];
    for (const key of ['nawawi','riyad','agreed']) {
      if (state.settings.sources[key]) selected.push(...state.libraries[key]);
    }
    state.pool = selected.filter(x => !max || x.text.length <= max);
    if (!state.pool.length && selected.length) state.pool = selected;
    state.sequentialIndex = -1;
    state.history = [];
    state.historyPos = -1;
    updateCounter();
  }

  function pickRandom() {
    if (!state.pool.length) return null;
    if (state.pool.length === 1) return state.pool[0];
    let item, tries = 0;
    do {
      item = state.pool[Math.floor(Math.random() * state.pool.length)];
      tries++;
    } while (state.current && item.id === state.current.id && tries < 12);
    return item;
  }

  function pickSequential(step = 1) {
    if (!state.pool.length) return null;
    state.sequentialIndex = (state.sequentialIndex + step + state.pool.length) % state.pool.length;
    return state.pool[state.sequentialIndex];
  }

  function fontClass(len) {
    if (len <= 150) return 'size-xl';
    if (len <= 320) return 'size-lg';
    if (len <= 620) return 'size-md';
    return 'size-sm';
  }

  function render(item) {
    if (!item) {
      $('hadithText').textContent = 'لا توجد أحاديث تطابق الإعدادات الحالية.';
      $('hadithMeta').textContent = 'افتح الإعدادات واختر مصدرًا واحدًا على الأقل.';
      $('hadithSource').textContent = '';
      $('collectionLabel').textContent = '';
      return;
    }
    state.current = item;
    const txt = $('hadithText');
    txt.className = `hadith-text ${fontClass(item.text.length)}`;
    txt.textContent = item.text;
    $('hadithMeta').textContent = item.meta;
    $('hadithSource').textContent = item.source;
    $('collectionLabel').textContent = `${item.collectionLabel}${item.book && item.book !== item.collectionLabel ? ` · ${item.book}` : ''}`;
    $('stage').classList.remove('is-loading');
    updateCounter();
  }

  async function transitionTo(item) {
    if (!item || state.transitioning) return;
    state.transitioning = true;
    const stage = $('stage');
    stage.classList.remove('is-in');
    stage.classList.add('is-out');
    await new Promise(r => setTimeout(r, 520));
    render(item);
    stage.classList.remove('is-out');
    void stage.offsetWidth;
    stage.classList.add('is-in');
    restartTimer();
    setTimeout(() => { state.transitioning = false; }, 700);
  }

  function next(manual = false) {
    if (!state.pool.length) return;
    let item;
    if (state.historyPos < state.history.length - 1 && manual) {
      state.historyPos++;
      item = state.history[state.historyPos];
    } else {
      item = state.settings.order === 'sequential' ? pickSequential(1) : pickRandom();
      if (item) {
        state.history = state.history.slice(0, state.historyPos + 1);
        state.history.push(item);
        if (state.history.length > 120) state.history.shift();
        state.historyPos = state.history.length - 1;
      }
    }
    transitionTo(item);
  }

  function previous() {
    if (state.historyPos > 0) {
      state.historyPos--;
      transitionTo(state.history[state.historyPos]);
      return;
    }
    if (state.settings.order === 'sequential' && state.pool.length) {
      transitionTo(pickSequential(-1));
    }
  }

  function restartTimer() {
    state.startedAt = performance.now();
    state.elapsedBeforePause = 0;
    $('progressBar').style.width = '0%';
  }

  function tick(now) {
    if (state.started && !state.paused && state.current) {
      const durationMs = Math.max(5, Number(state.settings.duration || 20)) * 1000;
      const elapsed = state.elapsedBeforePause + (now - state.startedAt);
      const pct = Math.min(100, (elapsed / durationMs) * 100);
      $('progressBar').style.width = `${pct}%`;
      if (elapsed >= durationMs && !state.transitioning) next(false);
    }
    state.raf = requestAnimationFrame(tick);
  }

  function togglePause(force) {
    const wanted = typeof force === 'boolean' ? force : !state.paused;
    if (wanted === state.paused) return;
    if (wanted) {
      state.elapsedBeforePause += performance.now() - state.startedAt;
      state.paused = true;
    } else {
      state.startedAt = performance.now();
      state.paused = false;
    }
    $('pauseBtn').textContent = state.paused ? 'استئناف' : 'إيقاف مؤقت';
    showToast(state.paused ? 'تم إيقاف التبديل مؤقتًا' : 'استؤنف العرض');
  }

  async function enterFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch { showToast('المتصفح منع ملء الشاشة. استخدم F11 إن لزم.'); }
    requestWakeLock();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
    } else await enterFullscreen();
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        state.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* optional */ }
  }

  function updateCounter() {
    $('counter').textContent = state.pool.length ? `${Math.max(1,state.historyPos+1)} / ${state.pool.length}` : '0 / 0';
  }

  function updateClock() {
    if (!state.settings.clock) { $('clock').textContent = ''; return; }
    $('clock').textContent = new Intl.DateTimeFormat('ar-EG', { hour:'2-digit', minute:'2-digit' }).format(new Date());
  }

  function applyTheme() {
    document.body.classList.toggle('theme-paper', state.settings.theme === 'paper');
  }

  function fillSettingsUI() {
    $('srcNawawi').checked = !!state.settings.sources.nawawi;
    $('srcRiyad').checked = !!state.settings.sources.riyad;
    $('srcAgreed').checked = !!state.settings.sources.agreed;
    $('durationSelect').value = String(state.settings.duration);
    $('orderSelect').value = state.settings.order;
    $('lengthSelect').value = String(state.settings.maxChars);
    $('themeSelect').value = state.settings.theme;
    $('clockToggle').checked = !!state.settings.clock;
    $('autoHideToggle').checked = !!state.settings.autoHide;
  }

  function readSettingsUI() {
    const nextSources = {
      nawawi: $('srcNawawi').checked,
      riyad: $('srcRiyad').checked,
      agreed: $('srcAgreed').checked
    };
    if (!Object.values(nextSources).some(Boolean)) {
      showToast('اختر مصدرًا واحدًا على الأقل');
      return false;
    }
    state.settings = {
      sources: nextSources,
      duration: Number($('durationSelect').value || 20),
      order: $('orderSelect').value,
      maxChars: Number($('lengthSelect').value || 0),
      theme: $('themeSelect').value,
      clock: $('clockToggle').checked,
      autoHide: $('autoHideToggle').checked
    };
    saveSettings();
    applyTheme();
    updateClock();
    rebuildPool();
    next(true);
    return true;
  }

  function showControls() {
    $('controls').classList.add('is-visible');
    $('showControls').classList.remove('is-visible');
    clearTimeout(state.controlsTimer);
    if (state.settings.autoHide && state.started) {
      state.controlsTimer = setTimeout(() => {
        $('controls').classList.remove('is-visible');
        $('showControls').classList.add('is-visible');
      }, 4500);
    }
  }

  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2300);
  }

  async function start(fullscreen = false) {
    if (!state.pool.length) return;
    state.started = true;
    $('startOverlay').classList.add('is-hidden');
    if (!state.current) next(false);
    restartTimer();
    showControls();
    requestWakeLock();
    if (fullscreen) await enterFullscreen();
  }

  function bindEvents() {
    $('startBtn').addEventListener('click', () => start(false));
    $('startFullscreenBtn').addEventListener('click', () => start(true));
    $('prevBtn').addEventListener('click', () => { previous(); showControls(); });
    $('nextBtn').addEventListener('click', () => { next(true); showControls(); });
    $('pauseBtn').addEventListener('click', () => { togglePause(); showControls(); });
    $('fullscreenBtn').addEventListener('click', () => { toggleFullscreen(); showControls(); });
    $('settingsBtn').addEventListener('click', () => { fillSettingsUI(); $('settingsDialog').showModal(); });
    $('showControls').addEventListener('click', showControls);
    $('applySettings').addEventListener('click', (e) => {
      e.preventDefault();
      if (readSettingsUI()) $('settingsDialog').close();
    });
    document.addEventListener('mousemove', showControls, { passive:true });
    document.addEventListener('touchstart', showControls, { passive:true });
    document.addEventListener('keydown', (e) => {
      if ($('settingsDialog').open) return;
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      else if (e.key === 'ArrowRight') next(true);
      else if (e.key === 'ArrowLeft') previous();
      else if (e.key.toLowerCase() === 'f') toggleFullscreen();
      else if (e.key.toLowerCase() === 's') { fillSettingsUI(); $('settingsDialog').showModal(); }
      showControls();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWakeLock(); });
    document.addEventListener('fullscreenchange', () => {
      $('fullscreenBtn').textContent = document.fullscreenElement ? 'خروج من ملء الشاشة' : 'ملء الشاشة';
    });
  }

  async function boot() {
    applyTheme();
    fillSettingsUI();
    bindEvents();
    updateClock();
    setInterval(updateClock, 20_000);
    requestAnimationFrame(tick);
    try {
      await loadLibraries();
      if (state.pool.length) render(state.settings.order === 'sequential' ? pickSequential(1) : pickRandom());
    } catch (err) {
      console.error(err);
      $('hadithText').textContent = 'تعذر تحميل مكتبة الأحاديث.';
      $('hadithMeta').textContent = 'تأكد أن ملفات الأحاديث JSON مرفوعة مع الصفحة في الـroot.';
      $('librarySummary').textContent = 'حدث خطأ أثناء تحميل المكتبة';
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.warn));
    }
  }

  boot();
})();
