(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const EXPECTED_COUNT = 1896;
  const SETTINGS_KEY = 'mishkat-screen-v05-settings';
  const defaults = { duration:20, order:'random', maxChars:0, theme:'ivory', clock:true, autoHide:true, burnInGuard:true };
  const state = { items:[], pool:[], current:null, pages:[], pageIndex:0, itemIndex:-1, history:[], historyPos:-1, started:false, paused:false, transitioning:false, timerId:0, progressId:0, cycleStart:0, cycleMs:20000, elapsedBeforePause:0, controlsTimer:0, clockTimer:0, burnTimer:0, wakeLock:null, settings:loadSettings() };

  function loadSettings(){ try{return {...defaults,...JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')}}catch{return {...defaults}} }
  function saveSettings(){ try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(state.settings))}catch{} }
  function safeText(x){ return typeof x === 'string' ? x : String(x ?? ''); }
  function parseParams(){ const p=new URLSearchParams(location.search); if(p.has('duration'))state.settings.duration=Math.max(8,Math.min(90,Number(p.get('duration'))||20)); if(['random','sequential'].includes(p.get('order')))state.settings.order=p.get('order'); if(['ivory','sage','auto','night'].includes(p.get('theme')))state.settings.theme=p.get('theme'); if(p.has('length'))state.settings.maxChars=Math.max(0,Number(p.get('length'))||0); if(p.get('clock')==='0')state.settings.clock=false; return {kiosk:p.get('kiosk')==='1',controls:p.get('controls')!=='0'} }
  const flags=parseParams();

  async function loadLibrary(){
    const res=await fetch('./riyad.json',{cache:'no-cache'}); if(!res.ok)throw new Error(`HTTP ${res.status}`); const data=await res.json();
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
    $('librarySummary').textContent=`تم التحقق: ${EXPECTED_COUNT} سجلًا فريدًا، الأرقام 1–${EXPECTED_COUNT} كاملة، ولا يوجد سجل فارغ.`;
    $('startBtn').disabled=false; $('startFullscreenBtn').disabled=false;
  }

  function rebuildPool(){ const max=Number(state.settings.maxChars)||0; state.pool=state.items.filter(x=>!max||x.text.length<=max); if(!state.pool.length)state.pool=[...state.items]; updateCounter(); }

  function exactPages(text){
    const target = innerWidth < 700 ? 430 : innerWidth < 1200 ? 720 : 1100;
    if(text.length <= target*1.18) return [text];
    const pages=[]; let start=0;
    while(start<text.length){
      if(text.length-start <= target*1.18){ pages.push(text.slice(start)); break; }
      const low=Math.min(text.length,start+Math.floor(target*.72)); const high=Math.min(text.length,start+Math.floor(target*1.12));
      let cut=-1;
      for(let i=high-1;i>=low;i--){ if(/[.!؟؛\n]/.test(text[i])){cut=i+1;break} }
      if(cut<0){ for(let i=high-1;i>=low;i--){ if(/\s/.test(text[i])){cut=i+1;break} } }
      if(cut<=start)cut=Math.min(text.length,start+target);
      pages.push(text.slice(start,cut)); start=cut;
    }
    if(pages.join('')!==text)throw new Error('فشل ضمان تطابق أجزاء الحديث مع النص الأصلي');
    return pages;
  }

  function fontClass(len){ return len>850?'long':len>520?'medium':'' }
  function renderCurrent(){
    const item=state.current; if(!item)return; const page=state.pages[state.pageIndex] ?? '';
    const txt=$('hadithText'); txt.className=`hadith-text ${fontClass(page.length)}`; txt.textContent=page; txt.scrollTop=0;
    $('partLabel').textContent=state.pages.length>1?`الحديث ${item.n} — الجزء ${state.pageIndex+1} من ${state.pages.length}`:`الحديث ${item.n}`;
    $('bookName').textContent=item.book; $('hadithNumber').textContent=String(item.n); $('hadithLink').href=`https://sunnah.com/riyadussalihin:${item.n}`;
    $('collectionLabel').textContent=`رياض الصالحين · ${item.book}`; $('stage').classList.remove('is-loading');
    $('announcement').textContent=`رياض الصالحين، الحديث ${item.n}${state.pages.length>1?`، الجزء ${state.pageIndex+1} من ${state.pages.length}`:''}`;
    $('nextBtn').textContent=state.pageIndex<state.pages.length-1?'الجزء التالي':'الحديث التالي'; $('prevBtn').textContent=state.pageIndex>0?'الجزء السابق':'السابق'; updateCounter();
  }

  function setItem(item, pageIndex=0){ state.current=item; state.pages=exactPages(item.text); state.pageIndex=Math.max(0,Math.min(pageIndex,state.pages.length-1)); state.itemIndex=state.pool.findIndex(x=>x.n===item.n); renderCurrent(); restartTimer(); }
  function pickNextItem(direction=1){ if(!state.pool.length)return null; if(state.settings.order==='sequential'){ let i=state.itemIndex; if(i<0)i=-1; i=(i+direction+state.pool.length)%state.pool.length; return state.pool[i]; } let item=state.pool[Math.floor(Math.random()*state.pool.length)]; if(state.pool.length>1&&state.current&&item.n===state.current.n)item=state.pool[(state.pool.indexOf(item)+1)%state.pool.length]; return item; }

  async function transition(fn){ if(state.transitioning)return; state.transitioning=true; clearTimer(); const s=$('stage'); s.classList.add('is-out'); await new Promise(r=>setTimeout(r,250)); fn(); s.classList.remove('is-out'); void s.offsetWidth; s.classList.add('is-in'); setTimeout(()=>{state.transitioning=false},360) }
  function pushHistory(item){ state.history=state.history.slice(0,state.historyPos+1); state.history.push(item.n); if(state.history.length>200)state.history.shift(); state.historyPos=state.history.length-1 }
  function next(manual=false){ if(!state.current)return; if(state.pageIndex<state.pages.length-1){ transition(()=>{state.pageIndex++;renderCurrent();restartTimer()});return } const item=pickNextItem(1); if(!item)return; if(manual||state.settings.order==='random')pushHistory(item); transition(()=>setItem(item,0)); }
  function previous(){ if(!state.current)return; if(state.pageIndex>0){ transition(()=>{state.pageIndex--;renderCurrent();restartTimer()});return } if(state.historyPos>0){state.historyPos--;const n=state.history[state.historyPos];const item=state.pool.find(x=>x.n===n)||state.items.find(x=>x.n===n); if(item)transition(()=>setItem(item,exactPages(item.text).length-1));return} const item=pickNextItem(-1); if(item)transition(()=>setItem(item,exactPages(item.text).length-1)); }

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
  async function wake(){try{if('wakeLock'in navigator&&document.visibilityState==='visible')state.wakeLock=await navigator.wakeLock.request('screen')}catch{}}
  async function full(){try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen()}catch{toast('المتصفح منع ملء الشاشة')}wake()}
  async function start(goFull=false){if(!state.pool.length)return;state.started=true;$('startOverlay').classList.add('is-hidden');let first=state.settings.order==='sequential'?state.pool[0]:state.pool[Math.floor(Math.random()*state.pool.length)];pushHistory(first);setItem(first,0);if(flags.controls)showControls();else $('controls').classList.remove('is-visible');wake();if(goFull)await full()}

  function bind(){ $('startBtn').onclick=()=>start(false);$('startFullscreenBtn').onclick=()=>start(true);$('nextBtn').onclick=()=>{next(true);showControls()};$('prevBtn').onclick=()=>{previous();showControls()};$('pauseBtn').onclick=()=>{togglePause();showControls()};$('fullscreenBtn').onclick=()=>{full();showControls()};$('settingsBtn').onclick=()=>{fillSettings();$('settingsDialog').showModal()};$('showControls').onclick=()=>showControls(true);$('applySettings').onclick=()=>readSettings();document.addEventListener('pointermove',()=>showControls());document.addEventListener('keydown',e=>{if($('settingsDialog').open)return;if(['ArrowRight','PageDown','MediaTrackNext'].includes(e.key)){next(true);e.preventDefault()}else if(['ArrowLeft','PageUp','MediaTrackPrevious'].includes(e.key)){previous();e.preventDefault()}else if([' ','Enter','MediaPlayPause'].includes(e.key)){togglePause();e.preventDefault()}else if(e.key==='f'||e.key==='F'){full();e.preventDefault()}else if(e.key==='Escape'){$('controls').classList.remove('force-visible')}});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')wake()});window.addEventListener('resize',()=>{if(state.current){const oldText=state.current.text;const progress=state.pages.slice(0,state.pageIndex).join('').length;state.pages=exactPages(oldText);let acc=0,idx=0;for(;idx<state.pages.length;idx++){if(acc+state.pages[idx].length>progress)break;acc+=state.pages[idx].length}state.pageIndex=Math.min(idx,state.pages.length-1);renderCurrent();restartTimer()}}) }

  async function boot(){bind();applyTheme();scheduleClock();startBurn();try{await loadLibrary();if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});if(flags.kiosk)start(true)}catch(err){console.error(err);$('librarySummary').textContent=`توقف العرض: ${err.message}. لن تُعرض مكتبة ناقصة.`;toast('فشل فحص سلامة المكتبة') }}
  boot();
})();
