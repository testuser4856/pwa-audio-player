const VERSION='v9';
const CACHE=`pwa-audio-mini-${VERSION}`;
const ASSETS=[
  './','./index.html','./app.js','./manifest.webmanifest',
  './icons/icon-192.png','./icons/icon-512.png'
];
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate',e=>{ e.waitUntil((async()=>{ const ks=await caches.keys(); await Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))); await self.clients.claim(); })()); });
self.addEventListener('fetch',e=>{
  const req=e.request;
  if (req.headers.get('range')) return; // let browser handle media ranges
  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    const hit=await c.match(req,{ignoreSearch:true});
    if(hit) return hit;
    try{
      const res=await fetch(req);
      if(req.method==='GET' && new URL(req.url).origin===location.origin){ c.put(req,res.clone()); }
      return res;
    }catch{ return hit || Response.error(); }
  })());
});
