(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const EXPECTED_COUNT = 1896;
  const EXPECTED_RIYAD_SHA256 = '502e79166ff9ebfb813a6af4dde83760670b0d9ceed552cab72568c4ca0b15af';
  const SETTINGS_KEY = 'mishkat-screen-settings';
  const LEGACY_SETTINGS_KEYS = ['mishkat-screen-v06-settings'];
  const defaults = { duration:20, order:'random', maxChars:0, theme:'ivory', clock:true, autoHide:true, burnInGuard:true };
  const state = { items:[], pool:[], current:null, pages:[], pageIndex:0, itemIndex:-1, history:[], historyPos:-1, started:false, paused:false, transitioning:false, timerId:0, progressId:0, cycleStart:0, cycleMs:20000, elapsedBeforePause:0, controlsTimer:0, clockTimer:0, burnTimer:0, wakeLock:null, resumeAfterModal:false, settings:loadSettings() };

  function loadSettings(){
    try{
      const current=localStorage.getItem(SETTINGS_KEY);
      if(current)return {...defaults,...JSON.parse(current)};
      for(const key of LEGACY_SETTINGS_KEYS){const legacy=localStorage.getItem(key);if(legacy)return {...defaults,...JSON.parse(legacy)}}
    }catch{}
    return {...defaults};
  }
  function saveSettings(){ try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(state.settings))}catch{} }
  function parseParams(){ const p=new URLSearchParams(location.search); if(p.has('duration'))state.settings.duration=Math.max(8,Math.min(90,Number(p.get('duration'))||20)); if(['random','sequential'].includes(p.get('order')))state.settings.order=p.get('order'); if(['ivory','sage','auto','night'].includes(p.get('theme')))state.settings.theme=p.get('theme'); if(p.has('length'))state.settings.maxChars=Math.max(0,Number(p.get('length'))||0); if(p.get('clock')==='0')state.settings.clock=false; return {kiosk:p.get('kiosk')==='1',controls:p.get('controls')!=='0'} }
  const flags=parseParams();

  async function sha256Hex(buffer){
    if(!globalThis.crypto?.subtle)throw new Error('المتصفح لا يدعم التحقق التشفيري SHA-256');
    const digest=await crypto.subtle.digest('SHA-256',buffer);
    return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  async function loadLibrary(){
    const res=await fetch('./riyad.json',{cache:'no-cache'}); if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const buffer=await res.arrayBuffer();
    const actualHash=await sha256Hex(buffer);
    if(actualHash!==EXPECTED_RIYAD_SHA256)throw new Error('بصمة مكتبة رياض الصالحين لا تطابق النسخة المعتمدة');
    let data; try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer))}catch{throw new Error('تعذر قراءة ملف المكتبة كنص UTF-8 صالح')}
    if(!data || !Array.isArray(data.books))throw new Error('بنية المكتبة غير صحيحة');
    const out=[]; const nums=new Set();
    for(const book of data.books){
      if(!book || typeof book.name!=='string' || !Array.isArray(book.items))throw new Error('بنية كتاب غير صحيحة');
      for(const rec of book.items){
        const n=Number(rec?.n); const text=rec?.t;
        if(!Number.isInteger(n)||n<1||n>EXPECTED_COUNT||nums.has(n)||typeof text!=='string'||text.length===0)throw new Error(`سجل غير صالح: ${n}`);
        nums.add(n); out.push(Object.freeze({n,book:book.name,text}));
      }
    }
    if(out.length!==EXPECTED_COUNT||nums.size!==EXPECTED_COUNT)throw new Error(`العدد ${out.length} بدل ${EXPECTED_COUNT}`);
    for(let i=1;i<=EXPECTED_COUNT;i++)if(!nums.has(i))throw new Error(`الحديث ${i} مفقود`);
    out.sort((a,b)=>a.n-b.n); state.items=Object.freeze(out); rebuildPool();
    $('librarySummary').textContent=`تم التحقق تشفيريًا من النسخة المعتمدة، ثم فحص ${EXPECTED_COUNT} سجلًا فريدًا والأرقام 1–${EXPECTED_COUNT} كاملة.`;
    $('sourceIntegrity').textContent=`SHA-256 مطابق · ${actualHash.slice(0,8)}…${actualHash.slice(-5)}`;
    $('startBtn').disabled=false; $('startFullscreenBtn').disabled=!fullscreenSupported(); syncFullscreenUI();
  }

  function rebuildPool(){ const max=Number(state.settings.maxChars)||0; state.pool=state.items.filter(x=>!max||x.text.length<=max); if(!state.pool.length)state.pool=[...state.items]; updateCounter(); }

  function pageTarget(){
    const widthTarget=innerWidth<700?430:innerWidth<1200?720:1100;
    const heightFactor=innerHeight<600?.62:innerHeight<740?.76:innerHeight<900?.9:innerHeight>1200?1.1:1;
    return Math.max(260,Math.min(1180,Math.round(widthTarget*heightFactor)));
  }
  function findNaturalCut(text,target,minRatio=.62,maxRatio=1.08){
    const low=Math.max(1,Math.floor(target*minRatio)); const high=Math.min(text.length-1,Math.ceil(target*maxRatio));
    for(let i=high;i>=low;i--)if(/[.!؟؛\n]/.test(text[i-1]))return i;
    for(let i=high;i>=low;i--)if(/\s/.test(text[i-1]))return i;
    return Math.min(text.length-1,Math.max(1,target));
  }
  function exactPages(text){
    const target=pageTarget();
    if(text.length<=target*1.14)return [text];
    const pages=[]; let start=0;
    while(start<text.length){
      if(text.length-start<=target*1.14){pages.push(text.slice(start));break}
      const rest=text.slice(start); const cut=findNaturalCut(rest,target,.72,1.1);
      pages.push(rest.slice(0,cut)); start+=cut;
    }
    if(pages.join('')!==text)throw new Error('فشل ضمان تطابق أجزاء الحديث مع النص الأصلي');
    return pages;
  }

  function fontClass(len){ return len>850?'long':len>520?'medium':'' }
  function setTextPage(txt,page){txt.className=`hadith-text ${fontClass(page.length)}`;txt.textContent=page;txt.scrollTop=0}
  function fitCurrentPage(txt){
    let guard=0;
    while(txt.clientHeight>0&&txt.scrollHeight>txt.clientHeight+3&&state.pages[state.pageIndex]?.length>45&&guard++<10){
      const current=state.pages[state.pageIndex];
      const ratio=Math.max(.38,Math.min(.78,(txt.clientHeight/txt.scrollHeight)*.9));
      const target=Math.max(36,Math.floor(current.length*ratio));
      const cut=findNaturalCut(current,target,.58,1.02);
      if(cut<=0||cut>=current.length)break;
      state.pages.splice(state.pageIndex,1,current.slice(0,cut),current.slice(cut));
      if(state.pages.join('')!==state.current.text)throw new Error('فشل ضمان تطابق أجزاء الحديث بعد ضبط مساحة العرض');
      setTextPage(txt,state.pages[state.pageIndex]);
    }
    txt.classList.toggle('needs-scroll',txt.scrollHeight>txt.clientHeight+3);
  }
  function renderCurrent(){
    const item=state.current; if(!item)return;
    const txt=$('hadithText'); setTextPage(txt,state.pages[state.pageIndex] ?? ''); fitCurrentPage(txt); const page=state.pages[state.pageIndex] ?? '';
    $('partLabel').textContent=state.pages.length>1?`الحديث ${item.n} · الجزء ${state.pageIndex+1} من ${state.pages.length}`:`الحديث ${item.n}`;
    $('bookName').textContent=item.book; $('hadithNumber').textContent=String(item.n); $('sourceBookName').textContent=item.book; $('sourceHadithNumber').textContent=String(item.n); $('hadithLink').href=`https://sunnah.com/riyadussalihin:${item.n}`;
    $('collectionLabel').textContent=`رياض الصالحين · ${item.book}`; $('stage').classList.remove('is-loading');
    $('announcement').textContent=`رياض الصالحين، الحديث ${item.n}${state.pages.length>1?`، الجزء ${state.pageIndex+1} من ${state.pages.length}`:''}`;
    $('nextBtn').textContent=state.pageIndex<state.pages.length-1?'الجزء التالي':'الحديث التالي'; $('prevBtn').textContent=state.pageIndex>0?'الجزء السابق':'السابق'; updateCounter();
  }

  function setItem(item, pageIndex=0){ state.current=item; state.pages=exactPages(item.text); state.pageIndex=Math.max(0,Math.min(pageIndex,state.pages.length-1)); state.itemIndex=state.pool.findIndex(x=>x.n===item.n); renderCurrent(); restartTimer(); }
  function setItemLast(item){
    state.current=item; state.pages=exactPages(item.text); state.itemIndex=state.pool.findIndex(x=>x.n===item.n); state.pageIndex=state.pages.length-1; renderCurrent();
    let guard=0; while(state.pageIndex<state.pages.length-1&&guard++<10){state.pageIndex=state.pages.length-1;renderCurrent()}
    restartTimer();
  }
  function pickNextItem(direction=1){ if(!state.pool.length)return null; if(state.settings.order==='sequential'){ let i=state.itemIndex; if(i<0)i=-1; i=(i+direction+state.pool.length)%state.pool.length; return state.pool[i]; } let item=state.pool[Math.floor(Math.random()*state.pool.length)]; if(state.pool.length>1&&state.current&&item.n===state.current.n)item=state.pool[(state.pool.indexOf(item)+1)%state.pool.length]; return item; }

  async function transition(fn){ if(state.transitioning)return; state.transitioning=true; clearTimer(); const s=$('stage'); s.classList.add('is-out'); await new Promise(r=>setTimeout(r,250)); fn(); s.classList.remove('is-out'); void s.offsetWidth; s.classList.add('is-in'); setTimeout(()=>{state.transitioning=false},360) }
  function pushHistory(item){ state.history=state.history.slice(0,state.historyPos+1); state.history.push(item.n); if(state.history.length>200)state.history.shift(); state.historyPos=state.history.length-1 }
  function next(manual=false){ if(!state.current)return; if(state.pageIndex<state.pages.length-1){ transition(()=>{state.pageIndex++;renderCurrent();restartTimer()});return } const item=pickNextItem(1); if(!item)return; if(manual||state.settings.order==='random')pushHistory(item); transition(()=>setItem(item,0)); }
  function previous(){ if(!state.current)return; if(state.pageIndex>0){ transition(()=>{state.pageIndex--;renderCurrent();restartTimer()});return } if(state.historyPos>0){state.historyPos--;const n=state.history[state.historyPos];const item=state.pool.find(x=>x.n===n)||state.items.find(x=>x.n===n); if(item)transition(()=>setItemLast(item));return} const item=pickNextItem(-1); if(item)transition(()=>setItemLast(item)); }

  function pageDurationMs(){ const page=state.pages[state.pageIndex]||''; const reading=Math.ceil(page.length/11); return Math.max(Number(state.settings.duration)||20,reading)*1000 }
  function clearTimer(){ if(state.timerId)clearTimeout(state.timerId); if(state.progressId)clearInterval(state.progressId); state.timerId=state.progressId=0 }
  function restartTimer(){ clearTimer(); state.elapsedBeforePause=0; state.cycleMs=pageDurationMs(); state.cycleStart=performance.now(); $('progressBar').style.width='0%'; if(!state.paused&&state.started){state.timerId=setTimeout(()=>next(false),state.cycleMs);state.progressId=setInterval(updateProgress,250)} }
  function updateProgress(){ const elapsed=state.elapsedBeforePause+(state.paused?0:performance.now()-state.cycleStart); $('progressBar').style.width=`${Math.min(100,Math.max(0,elapsed/state.cycleMs*100))}%` }
  function togglePause(){ if(state.paused){state.paused=false;state.cycleStart=performance.now();const remain=Math.max(100,state.cycleMs-state.elapsedBeforePause);state.timerId=setTimeout(()=>next(false),remain);state.progressId=setInterval(updateProgress,250)}else{state.elapsedBeforePause+=performance.now()-state.cycleStart;state.paused=true;clearTimer()} $('pauseBtn').textContent=state.paused?'استئناف':'إيقاف مؤقت'; toast(state.paused?'تم الإيقاف مؤقتًا':'استؤنف العرض') }

  function updateCounter(){ const idx=state.current?state.pool.findIndex(x=>x.n===state.current.n):-1; $('counter').textContent=`${idx>=0?idx+1:0} / ${state.pool.length||0}` }
  function updateClock(){ $('clock').textContent=state.settings.clock?new Intl.DateTimeFormat('ar-EG',{hour:'2-digit',minute:'2-digit'}).format(new Date()):'' }
  function scheduleClock(){clearTimeout(state.clockTimer);updateClock();applyTheme();state.clockTimer=setTimeout(scheduleClock,60000-(Date.now()%60000)+40)}
  function applyTheme(){let t=state.settings.theme;if(t==='auto'){const h=new Date().getHours();t=(h>=21||h<6)?'night':'ivory'}document.body.classList.toggle('theme-sage',t==='sage');document.body.classList.toggle('theme-night',t==='night');document.querySelector('meta[name="theme-color"]').content=t==='night'?'#172638':t==='sage'?'#edf5ea':'#f8f1df'}
  const drift=[[0,0],[4,-3],[-5,3],[3,5],[-4,-4],[6,1]];let driftI=0;function updateBurn(){if(!state.settings.burnInGuard){document.documentElement.style.setProperty('--dx','0px');document.documentElement.style.setProperty('--dy','0px');return}driftI=(driftI+1)%drift.length;document.documentElement.style.setProperty('--dx',`${drift[driftI][0]}px`);document.documentElement.style.setProperty('--dy',`${drift[driftI][1]}px`)}function startBurn(){clearInterval(state.burnTimer);updateBurn();if(state.settings.burnInGuard)state.burnTimer=setInterval(updateBurn,180000)}

  function fillSettings(){ $('durationSelect').value=String(state.settings.duration);$('orderSelect').value=state.settings.order;$('lengthSelect').value=String(state.settings.maxChars);$('themeSelect').value=state.settings.theme;$('clockToggle').checked=state.settings.clock;$('autoHideToggle').checked=state.settings.autoHide;$('burnToggle').checked=state.settings.burnInGuard }
  function readSettings(){state.settings={duration:Number($('durationSelect').value)||20,order:$('orderSelect').value,maxChars:Number($('lengthSelect').value)||0,theme:$('themeSelect').value,clock:$('clockToggle').checked,autoHide:$('autoHideToggle').checked,burnInGuard:$('burnToggle').checked};saveSettings();rebuildPool();applyTheme();scheduleClock();startBurn();const cur=state.current&&state.pool.find(x=>x.n===state.current.n); if(cur)setItem(cur,0); else if(state.pool.length)setItem(state.settings.order==='sequential'?state.pool[0]:state.pool[Math.floor(Math.random()*state.pool.length)],0)}
  function showControls(force=false){if(!flags.controls&&!force)return;$('controls').classList.add('is-visible');$('showControls').classList.remove('is-visible');clearTimeout(state.controlsTimer);if(state.settings.autoHide&&state.started&&!force)state.controlsTimer=setTimeout(()=>{$('controls').classList.remove('is-visible');$('showControls').classList.add('is-visible')},4500)}
  function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200)}
  function openModal(dialog,beforeOpen){
    if(beforeOpen)beforeOpen();
    if(state.started&&!state.paused){
      state.elapsedBeforePause+=performance.now()-state.cycleStart; state.paused=true; state.resumeAfterModal=true; clearTimer(); $('pauseBtn').textContent='استئناف'; updateProgress();
    }
    dialog.showModal();
  }
  function resumeAfterModal(){
    if(!state.resumeAfterModal||$('settingsDialog').open||$('sourceDialog').open)return;
    state.resumeAfterModal=false; state.paused=false; state.cycleStart=performance.now();
    const remain=Math.max(100,state.cycleMs-state.elapsedBeforePause); state.timerId=setTimeout(()=>next(false),remain); state.progressId=setInterval(updateProgress,250); $('pauseBtn').textContent='إيقاف مؤقت';
  }
  async function wake(){try{if('wakeLock'in navigator&&document.visibilityState==='visible')state.wakeLock=await navigator.wakeLock.request('screen')}catch{}}
  function fullscreenSupported(){return Boolean(document.fullscreenEnabled!==false&&document.documentElement.requestFullscreen)}
  function syncFullscreenUI(){
    const supported=fullscreenSupported();
    $('fullscreenBtn').hidden=!supported; $('startFullscreenBtn').hidden=!supported;
    if(supported)$('fullscreenBtn').textContent=document.fullscreenElement?'إنهاء ملء الشاشة':'ملء الشاشة';
  }
  async function full(){
    if(!fullscreenSupported()){toast('ملء الشاشة غير مدعوم في هذا المتصفح');return}
    try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen()}catch{toast('تعذر تشغيل ملء الشاشة من المتصفح')}
    syncFullscreenUI(); wake();
  }
  async function start(goFull=false){if(!state.pool.length)return;state.started=true;$('startOverlay').classList.add('is-hidden');let first=state.settings.order==='sequential'?state.pool[0]:state.pool[Math.floor(Math.random()*state.pool.length)];pushHistory(first);setItem(first,0);if(flags.controls)showControls();else $('controls').classList.remove('is-visible');wake();if(goFull)await full()}

  function bind(){ $('startBtn').onclick=()=>start(false);$('startFullscreenBtn').onclick=()=>start(true);$('nextBtn').onclick=()=>{next(true);showControls()};$('prevBtn').onclick=()=>{previous();showControls()};$('pauseBtn').onclick=()=>{togglePause();showControls()};$('fullscreenBtn').onclick=()=>{full();showControls()};$('settingsBtn').onclick=()=>openModal($('settingsDialog'),fillSettings);$('sourceBtn').onclick=()=>openModal($('sourceDialog'));$('closeSourceBtn').onclick=()=>$('sourceDialog').close();$('showControls').onclick=()=>showControls(true);$('applySettings').onclick=()=>readSettings();$('dismissUpdateBtn').onclick=()=>$('updateBanner').classList.remove('show');$('settingsDialog').addEventListener('close',resumeAfterModal);$('sourceDialog').addEventListener('close',resumeAfterModal);document.addEventListener('fullscreenchange',syncFullscreenUI);document.addEventListener('pointermove',()=>showControls());document.addEventListener('keydown',e=>{if($('settingsDialog').open||$('sourceDialog').open)return;if(['ArrowRight','PageDown','MediaTrackNext'].includes(e.key)){next(true);e.preventDefault()}else if(['ArrowLeft','PageUp','MediaTrackPrevious'].includes(e.key)){previous();e.preventDefault()}else if([' ','Enter','MediaPlayPause'].includes(e.key)){togglePause();e.preventDefault()}else if(e.key==='f'||e.key==='F'){full();e.preventDefault()}else if(e.key==='Escape'){$('controls').classList.remove('force-visible')}});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')wake()});window.addEventListener('resize',()=>{if(state.current){const oldText=state.current.text;const progress=state.pages.slice(0,state.pageIndex).join('').length;state.pages=exactPages(oldText);let acc=0,idx=0;for(;idx<state.pages.length;idx++){if(acc+state.pages[idx].length>progress)break;acc+=state.pages[idx].length}state.pageIndex=Math.min(idx,state.pages.length-1);renderCurrent();restartTimer()}}) }

  let swRegistration=null; let updateReloadArmed=false;
  function showUpdate(reg){
    swRegistration=reg; $('updateBanner').classList.add('show');
    $('updateBtn').onclick=()=>{const waiting=swRegistration?.waiting;if(waiting){updateReloadArmed=true;waiting.postMessage({type:'SKIP_WAITING'})}};
  }
  async function setupServiceWorker(){
    if(!('serviceWorker'in navigator))return;
    try{
      const reg=await navigator.serviceWorker.register('./sw.js'); swRegistration=reg;
      if(reg.waiting&&navigator.serviceWorker.controller)showUpdate(reg);
      reg.addEventListener('updatefound',()=>{const worker=reg.installing;if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdate(reg)})});
      navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updateReloadArmed)location.reload()});
    }catch(err){console.warn('Service worker registration failed',err)}
  }

  async function boot(){bind();syncFullscreenUI();applyTheme();scheduleClock();startBurn();try{await loadLibrary();setupServiceWorker();if(flags.kiosk)start(false)}catch(err){console.error(err);$('librarySummary').textContent=`توقف العرض: ${err.message}. لن تُعرض مكتبة ناقصة.`;toast('فشل فحص سلامة المكتبة') }}
  boot();
})();
