(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'mishkat-hadith-screen-settings-v2';
  const AUTO_NIGHT_START = 21;
  const AUTO_NIGHT_END = 6;
  const SOURCE_ORDER = ['agreed', 'nawawi', 'riyad'];
  const SOURCE_RANK = { agreed: 3, nawawi: 2, riyad: 1 };
  const LIBRARY_DEFS = [
    { key:'nawawi', file:'nawawi-display.json', countId:'countNawawi', checkbox:'srcNawawi' },
    { key:'riyad', file:'riyad-display.json', countId:'countRiyad', checkbox:'srcRiyad' },
    { key:'agreed', file:'agreed-display.json', countId:'countAgreed', checkbox:'srcAgreed' }
  ];

  const DEFAULTS = {
    sources: { nawawi:true, riyad:true, agreed:true },
    duration: 20,
    order: 'random',
    maxChars: 620,
    theme: 'auto',
    clock: true,
    autoHide: true,
    burnInGuard: true
  };

  const state = {
    libraries: { nawawi:[], riyad:[], agreed:[] },
    availability: { nawawi:false, riyad:false, agreed:false },
    pool: [],
    history: [],
    historyPos: -1,
    sequentialIndex: -1,
    current: null,
    paused: false,
    started: false,
    transitioning: false,
    settings: loadSettings(),
    timerId: 0,
    progressId: 0,
    controlsTimer: 0,
    clockTimer: 0,
    burnTimer: 0,
    cycleStart: 0,
    elapsedBeforePause: 0,
    wakeLock: null,
    flags: { autostart:false, kiosk:false, controls:true, fullscreen:false }
  };

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function loadSettings() {
    try {
      const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!v || typeof v !== 'object') return cloneDefaults();
      return { ...cloneDefaults(), ...v, sources:{ ...DEFAULTS.sources, ...(v.sources || {}) } };
    } catch { return cloneDefaults(); }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
  }

  function boolParam(v, fallback) {
    if (v == null) return fallback;
    return !/^(0|false|no|off)$/i.test(v);
  }

  function applyUrlParams() {
    const p = new URLSearchParams(location.search);
    const duration = Number(p.get('duration'));
    if ([10,15,20,30,45,60].includes(duration)) state.settings.duration = duration;
    const length = Number(p.get('length'));
    if ([0,320,620,1000].includes(length)) state.settings.maxChars = length;
    const order = p.get('order');
    if (['random','sequential'].includes(order)) state.settings.order = order;
    const theme = p.get('theme');
    if (['auto','ivory','sage','night'].includes(theme)) state.settings.theme = theme;
    if (p.has('clock')) state.settings.clock = boolParam(p.get('clock'), true);
    if (p.has('burn')) state.settings.burnInGuard = boolParam(p.get('burn'), true);
    if (p.has('sources')) {
      const allowed = new Set((p.get('sources') || '').split(',').map(x => x.trim()).filter(Boolean));
      if (allowed.size) state.settings.sources = {
        nawawi: allowed.has('nawawi'),
        riyad: allowed.has('riyad'),
        agreed: allowed.has('agreed')
      };
    }
    state.flags.kiosk = boolParam(p.get('kiosk'), false);
    state.flags.autostart = boolParam(p.get('autostart'), state.flags.kiosk);
    state.flags.controls = boolParam(p.get('controls'), !state.flags.kiosk);
    state.flags.fullscreen = boolParam(p.get('fullscreen'), false);
    if (state.flags.kiosk) document.body.classList.add('kiosk-mode');
  }

  function escText(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }

  async function fetchJson(file) {
    const r = await fetch(file, { cache:'no-cache' });
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return r.json();
  }

  async function loadLibraries() {
    const results = await Promise.allSettled(LIBRARY_DEFS.map(d => fetchJson(d.file)));
    const errors = [];
    results.forEach((res, idx) => {
      const def = LIBRARY_DEFS[idx];
      if (res.status === 'fulfilled' && Array.isArray(res.value?.items)) {
        state.libraries[def.key] = res.value.items;
        state.availability[def.key] = true;
        $(def.countId).textContent = `(${res.value.items.length.toLocaleString('ar-EG')})`;
      } else {
        state.libraries[def.key] = [];
        state.availability[def.key] = false;
        $(def.countId).textContent = '(غير متاح)';
        $(def.checkbox).disabled = true;
        state.settings.sources[def.key] = false;
        errors.push(def.key);
        console.error('Library load failed:', def.file, res.status === 'rejected' ? res.reason : 'invalid data');
      }
    });

    const loadedTotal = Object.values(state.libraries).reduce((n, arr) => n + arr.length, 0);
    if (!loadedTotal) throw new Error('No hadith library could be loaded');
    const uniqueAll = dedupeItems(Object.values(state.libraries).flat()).length;
    $('librarySummary').textContent = errors.length
      ? `${loadedTotal.toLocaleString('ar-EG')} سجلًا محليًا؛ ${errors.length} مصدر تعذر تحميله، والباقي يعمل.`
      : `${loadedTotal.toLocaleString('ar-EG')} سجلًا محليًا — ${uniqueAll.toLocaleString('ar-EG')} بعد إزالة التكرار الواضح`;
    $('startBtn').disabled = false;
    $('startFullscreenBtn').disabled = false;
    rebuildPool();
  }

  function dedupeItems(items) {
    const map = new Map();
    for (const original of items) {
      const x = { ...original, alsoIn:[] };
      const key = (x.dedupeKey && x.dedupeKey.length >= 30) ? x.dedupeKey : `${x.collection}:${x.id}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, x);
        continue;
      }
      const exRank = SOURCE_RANK[existing.collection] || 0;
      const newRank = SOURCE_RANK[x.collection] || 0;
      if (newRank > exRank) {
        const also = new Set([...(existing.alsoIn || []), existing.collectionLabel, ...(x.alsoIn || [])].filter(Boolean));
        also.delete(x.collectionLabel);
        x.alsoIn = [...also];
        map.set(key, x);
      } else {
        if (x.collectionLabel && x.collectionLabel !== existing.collectionLabel && !existing.alsoIn.includes(x.collectionLabel)) {
          existing.alsoIn.push(x.collectionLabel);
        }
      }
    }
    return [...map.values()];
  }

  function rebuildPool() {
    const selected = [];
    for (const key of SOURCE_ORDER) {
      if (state.settings.sources[key] && state.availability[key]) selected.push(...state.libraries[key]);
    }
    const max = Number(state.settings.maxChars || 0);
    const filtered = selected.filter(x => !max || escText(x.matn).length <= max);
    state.pool = dedupeItems(filtered.length ? filtered : selected);
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
    } while (state.current && item.id === state.current.id && tries < 14);
    return item;
  }

  function pickSequential(step = 1) {
    if (!state.pool.length) return null;
    state.sequentialIndex = (state.sequentialIndex + step + state.pool.length) % state.pool.length;
    return state.pool[state.sequentialIndex];
  }

  function fontClass(len) {
    if (len <= 130) return 'size-xl';
    if (len <= 280) return 'size-lg';
    if (len <= 520) return 'size-md';
    if (len <= 850) return 'size-sm';
    return 'size-xs';
  }

  function renderQr(payload) {
    const wrap = $('qrWrap');
    const canvas = $('sourceQr');
    if (!payload || !payload.s || !payload.b) {
      wrap.hidden = true;
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(payload.b), c => c.charCodeAt(0));
      const size = Number(payload.s);
      const quiet = 4;
      const module = 5;
      const px = (size + quiet * 2) * module;
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext('2d', { alpha:false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0,0,px,px);
      ctx.fillStyle = '#111111';
      for (let r=0;r<size;r++) {
        for (let c=0;c<size;c++) {
          const i = r * size + c;
          const on = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
          if (on) ctx.fillRect((c+quiet)*module,(r+quiet)*module,module,module);
        }
      }
      wrap.hidden = false;
    } catch (e) {
      console.warn('QR render failed', e);
      wrap.hidden = true;
    }
  }

  function render(item) {
    if (!item) {
      $('hadithText').textContent = 'لا توجد أحاديث تطابق الإعدادات الحالية.';
      $('hadithSourceBook').textContent = '';
      $('hadithMeta').querySelector('strong').textContent = 'افتح الإعدادات واختر مصدرًا واحدًا على الأقل.';
      $('hadithSource').querySelector('strong').textContent = '';
      $('hadithRawi').hidden = true;
      $('qrWrap').hidden = true;
      return;
    }
    state.current = item;
    const matn = escText(item.matn);
    const txt = $('hadithText');
    txt.className = `hadith-text ${fontClass(matn.length)}`;
    txt.textContent = matn;
    $('hadithSourceBook').textContent = item.collection === 'riyad'
      ? 'رياض الصالحين — الإمام النووي'
      : item.collection === 'nawawi'
        ? 'الأربعون النووية — الإمام النووي'
        : 'اللؤلؤ والمرجان فيما اتفق عليه الشيخان';

    const rawi = escText(item.rawi);
    $('hadithRawi').hidden = !rawi;
    $('hadithRawi').querySelector('strong').textContent = rawi;
    $('hadithMeta').querySelector('strong').textContent = escText(item.position || item.book || '');
    $('hadithSource').querySelector('strong').textContent = escText(item.takhrij || 'التخريج مذكور في المصدر');

    const also = Array.isArray(item.alsoIn) ? [...new Set(item.alsoIn)].filter(Boolean) : [];
    $('alsoIn').hidden = !also.length;
    $('alsoIn').textContent = also.length ? `ورد أيضًا في: ${also.join('، ')}` : '';

    const link = $('sourceLink');
    if (item.sourceUrl) {
      link.href = item.sourceUrl;
      link.textContent = `فتح مرجع النص — ${item.sourceDomain || 'المصدر'}`;
      link.hidden = false;
    } else link.hidden = true;

    const commentary = $('commentaryLink');
    if (item.commentaryUrl) {
      commentary.href = item.commentaryUrl;
      commentary.hidden = false;
    } else commentary.hidden = true;

    $('sourceDomain').textContent = item.sourceDomain || '';
    renderQr(item.qr);
    $('collectionLabel').textContent = `${item.collectionLabel}${item.book && item.collection === 'riyad' ? ` · ${item.book}` : ''}`;
    $('announcement').textContent = `حديث جديد من ${item.collectionLabel}`;
    $('stage').classList.remove('is-loading');
    updateCounter();
    if (state.settings.burnInGuard) updateBurnIn();
  }

  function clearCycleTimer() {
    if (state.timerId) clearTimeout(state.timerId);
    state.timerId = 0;
  }

  function cycleDurationMs() {
    return Math.max(5, Number(state.settings.duration || 20)) * 1000;
  }

  function restartCycleTimer() {
    clearCycleTimer();
    state.elapsedBeforePause = 0;
    state.cycleStart = performance.now();
    $('progressBar').style.width = '0%';
    if (!state.paused && state.started && state.current) {
      state.timerId = setTimeout(() => next(false), cycleDurationMs());
    }
  }

  function scheduleRemaining() {
    clearCycleTimer();
    const remaining = Math.max(80, cycleDurationMs() - state.elapsedBeforePause);
    state.cycleStart = performance.now();
    state.timerId = setTimeout(() => next(false), remaining);
  }

  function updateProgress() {
    if (!state.started || !state.current) return;
    const elapsed = state.elapsedBeforePause + (state.paused ? 0 : performance.now() - state.cycleStart);
    const pct = Math.max(0, Math.min(100, elapsed / cycleDurationMs() * 100));
    $('progressBar').style.width = `${pct}%`;
  }

  async function transitionTo(item) {
    if (!item || state.transitioning) return;
    state.transitioning = true;
    clearCycleTimer();
    const stage = $('stage');
    stage.classList.remove('is-in');
    stage.classList.add('is-out');
    await new Promise(r => setTimeout(r, 330));
    render(item);
    stage.classList.remove('is-out');
    void stage.offsetWidth;
    stage.classList.add('is-in');
    restartCycleTimer();
    setTimeout(() => { state.transitioning = false; }, 520);
  }

  function next(manual = false) {
    if (!state.pool.length || state.transitioning) return;
    let item;
    if (manual && state.historyPos < state.history.length - 1) {
      state.historyPos++;
      item = state.history[state.historyPos];
    } else {
      item = state.settings.order === 'sequential' ? pickSequential(1) : pickRandom();
      if (item) {
        state.history = state.history.slice(0, state.historyPos + 1);
        state.history.push(item);
        if (state.history.length > 160) state.history.shift();
        state.historyPos = state.history.length - 1;
      }
    }
    transitionTo(item);
  }

  function previous() {
    if (state.transitioning) return;
    if (state.historyPos > 0) {
      state.historyPos--;
      transitionTo(state.history[state.historyPos]);
    } else if (state.settings.order === 'sequential' && state.pool.length) {
      transitionTo(pickSequential(-1));
    }
  }

  function togglePause(force) {
    const wanted = typeof force === 'boolean' ? force : !state.paused;
    if (wanted === state.paused) return;
    if (wanted) {
      state.elapsedBeforePause += performance.now() - state.cycleStart;
      state.paused = true;
      clearCycleTimer();
    } else {
      state.paused = false;
      scheduleRemaining();
    }
    $('pauseBtn').textContent = state.paused ? 'استئناف' : 'إيقاف مؤقت';
    showToast(state.paused ? 'تم إيقاف التبديل مؤقتًا' : 'استؤنف العرض');
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        state.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }

  async function enterFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch {
      showToast('المتصفح منع ملء الشاشة؛ استخدم زر الشاشة أو F11 إذا كان متاحًا.');
    }
    requestWakeLock();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
    } else await enterFullscreen();
  }

  function updateCounter() {
    $('counter').textContent = state.pool.length ? `${Math.max(1,state.historyPos+1)} / ${state.pool.length}` : '0 / 0';
  }

  function updateClock() {
    $('clock').textContent = state.settings.clock
      ? new Intl.DateTimeFormat('ar-EG', { hour:'2-digit', minute:'2-digit' }).format(new Date())
      : '';
  }

  function scheduleClock() {
    clearTimeout(state.clockTimer);
    updateClock();
    applyTheme();
    const now = Date.now();
    const untilNextMinute = 60_000 - (now % 60_000) + 30;
    state.clockTimer = setTimeout(scheduleClock, untilNextMinute);
  }

  function resolvedTheme() {
    if (state.settings.theme !== 'auto') return state.settings.theme;
    const h = new Date().getHours();
    return (h >= AUTO_NIGHT_START || h < AUTO_NIGHT_END) ? 'night' : 'ivory';
  }

  function applyTheme() {
    const t = resolvedTheme();
    document.body.classList.toggle('theme-sage', t === 'sage');
    document.body.classList.toggle('theme-night', t === 'night');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'night' ? '#172638' : (t === 'sage' ? '#edf5ea' : '#f8f1df');
  }

  const driftSteps = [
    [0,0,0,0],[4,-3,-2,2],[-5,3,2,-2],[3,5,-3,-1],[-4,-4,2,3],[6,1,-2,-3]
  ];
  let driftIndex = 0;
  function updateBurnIn() {
    if (!state.settings.burnInGuard) {
      document.documentElement.style.setProperty('--drift-x','0px');
      document.documentElement.style.setProperty('--drift-y','0px');
      document.documentElement.style.setProperty('--drift-x2','0px');
      document.documentElement.style.setProperty('--drift-y2','0px');
      document.body.dataset.burnPhase = '0';
      return;
    }
    driftIndex = (driftIndex + 1) % driftSteps.length;
    const [x,y,x2,y2] = driftSteps[driftIndex];
    document.documentElement.style.setProperty('--drift-x',`${x}px`);
    document.documentElement.style.setProperty('--drift-y',`${y}px`);
    document.documentElement.style.setProperty('--drift-x2',`${x2}px`);
    document.documentElement.style.setProperty('--drift-y2',`${y2}px`);
    document.body.dataset.burnPhase = String(driftIndex % 4);
  }

  function startBurnTimer() {
    clearInterval(state.burnTimer);
    updateBurnIn();
    if (state.settings.burnInGuard) state.burnTimer = setInterval(updateBurnIn, 180_000);
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
    $('burnToggle').checked = !!state.settings.burnInGuard;
  }

  function readSettingsUI() {
    const nextSources = {
      nawawi: $('srcNawawi').checked && state.availability.nawawi,
      riyad: $('srcRiyad').checked && state.availability.riyad,
      agreed: $('srcAgreed').checked && state.availability.agreed
    };
    if (!Object.values(nextSources).some(Boolean)) {
      showToast('اختر مصدرًا متاحًا واحدًا على الأقل');
      return false;
    }
    state.settings = {
      sources: nextSources,
      duration: Number($('durationSelect').value || 20),
      order: $('orderSelect').value,
      maxChars: Number($('lengthSelect').value || 0),
      theme: ['auto','ivory','sage','night'].includes($('themeSelect').value) ? $('themeSelect').value : 'auto',
      clock: $('clockToggle').checked,
      autoHide: $('autoHideToggle').checked,
      burnInGuard: $('burnToggle').checked
    };
    saveSettings();
    applyTheme();
    scheduleClock();
    startBurnTimer();
    rebuildPool();
    next(true);
    return true;
  }

  function showControls(force = false) {
    if (!state.flags.controls && !force) return;
    $('controls').classList.add('is-visible');
    if (force) $('controls').classList.add('force-visible');
    $('showControls').classList.remove('is-visible');
    clearTimeout(state.controlsTimer);
    if (state.settings.autoHide && state.started && !force) {
      state.controlsTimer = setTimeout(() => {
        $('controls').classList.remove('is-visible');
        $('showControls').classList.add('is-visible');
      }, 4200);
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
    if (!state.current) {
      const first = state.settings.order === 'sequential' ? pickSequential(1) : pickRandom();
      if (first) {
        state.history.push(first);
        state.historyPos = 0;
        render(first);
      }
    }
    restartCycleTimer();
    if (state.flags.controls) showControls();
    else $('controls').classList.remove('is-visible');
    requestWakeLock();
    if (fullscreen) await enterFullscreen();
  }

  function isInteractiveTarget(target) {
    return !!target?.closest?.('button,a,input,select,dialog');
  }

  function bindEvents() {
    $('startBtn').addEventListener('click', () => start(false));
    $('startFullscreenBtn').addEventListener('click', () => start(true));
    $('prevBtn').addEventListener('click', () => { previous(); showControls(); });
    $('nextBtn').addEventListener('click', () => { next(true); showControls(); });
    $('pauseBtn').addEventListener('click', () => { togglePause(); showControls(); });
    $('fullscreenBtn').addEventListener('click', () => { toggleFullscreen(); showControls(); });
    $('settingsBtn').addEventListener('click', () => { fillSettingsUI(); $('settingsDialog').showModal(); });
    $('showControls').addEventListener('click', () => showControls(true));
    $('applySettings').addEventListener('click', (e) => {
      e.preventDefault();
      if (readSettingsUI()) $('settingsDialog').close();
    });
    document.addEventListener('mousemove', () => showControls(), { passive:true });
    document.addEventListener('touchstart', () => showControls(), { passive:true });
    document.addEventListener('keydown', (e) => {
      if ($('settingsDialog').open) return;
      const interactive = isInteractiveTarget(e.target);
      if ((e.code === 'Space' || e.key === 'MediaPlayPause' || (e.key === 'Enter' && !interactive))) {
        e.preventDefault(); togglePause();
      } else if (e.key === 'MediaPlay') { e.preventDefault(); togglePause(false); }
      else if (e.key === 'MediaPause') { e.preventDefault(); togglePause(true); }
      else if (e.key === 'ArrowRight' || e.key === 'MediaTrackNext') { e.preventDefault(); next(true); }
      else if (e.key === 'ArrowLeft' || e.key === 'MediaTrackPrevious') { e.preventDefault(); previous(); }
      else if (e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFullscreen(); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); fillSettingsUI(); $('settingsDialog').showModal(); }
      else if (e.key === 'Escape' && state.flags.kiosk) { showControls(true); }
      showControls();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { requestWakeLock(); scheduleClock(); }
    });
    document.addEventListener('fullscreenchange', () => {
      $('fullscreenBtn').textContent = document.fullscreenElement ? 'خروج من ملء الشاشة' : 'ملء الشاشة';
    });
  }

  async function boot() {
    applyUrlParams();
    applyTheme();
    fillSettingsUI();
    bindEvents();
    scheduleClock();
    startBurnTimer();
    state.progressId = setInterval(updateProgress, 250);
    try {
      await loadLibraries();
      fillSettingsUI();
      if (state.pool.length) {
        const first = state.settings.order === 'sequential' ? pickSequential(1) : pickRandom();
        if (first) {
          state.history = [first];
          state.historyPos = 0;
          render(first);
        }
      }
      if (state.flags.autostart) {
        await start(false);
        if (state.flags.fullscreen) showToast('لملء الشاشة في المتصفح اضغط F أو زر ملء الشاشة؛ المتصفحات تمنع تشغيله تلقائيًا بلا لمسة.');
      }
    } catch (err) {
      console.error(err);
      $('hadithText').textContent = 'تعذر تحميل مكتبة الأحاديث.';
      $('hadithMeta').querySelector('strong').textContent = 'تأكد أن ملفات JSON موجودة مع الصفحة في الـroot.';
      $('librarySummary').textContent = 'تعذر تحميل أي مصدر';
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.warn));
    }
  }

  boot();
})();
