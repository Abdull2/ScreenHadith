const CACHE='mishkat-hadith-screen-v05-20260822';
const PREFIX='mishkat-hadith-screen-';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./riyad.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(async c=>{for(const url of ASSETS){const r=await fetch(url,{cache:'reload'});if(!r.ok)throw new Error(`Precache failed ${url}: ${r.status}`);await c.put(url,r)}}).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const url=new URL(e.request.url);if(url.origin!==self.location.origin)return;e.respondWith((async()=>{const cached=await caches.match(e.request);if(cached)return cached;try{const r=await fetch(e.request);if(r.ok){const c=await caches.open(CACHE);c.put(e.request,r.clone()).catch(()=>{})}return r}catch(err){if(e.request.mode==='navigate'){const fallback=await caches.match('./index.html');if(fallback)return fallback}throw err}})())});
