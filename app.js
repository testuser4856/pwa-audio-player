(function(){
'use strict';

window.addEventListener('error', e=>{ alert('JSエラー: '+(e.error?.message||e.message)); });
window.addEventListener('unhandledrejection', e=>{ alert('Promiseエラー: '+(e.reason?.message||e.reason)); });

const DB='pwa-audio-db', VER=8; let db;
const STORES={tracks:{keyPath:'id'},progress:{keyPath:'id'},meta:{keyPath:'key'},playlists:{keyPath:'id'},chunks:{keyPath:'key'}};
function openDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open(DB,VER);
  r.onupgradeneeded=()=>{ const d=r.result; for(const[k,v] of Object.entries(STORES)){ if(!d.objectStoreNames.contains(k)) d.createObjectStore(k,v); } };
  r.onsuccess=()=>{ db=r.result; res(db); }; r.onerror=()=>rej(r.error);
});}
function tx(s,m='readonly'){ return db.transaction(s,m).objectStore(s); }
function put(s,v){ return new Promise((res,rej)=>{ const r=tx(s,'readwrite').put(v); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function del_(s,k){ return new Promise((res,rej)=>{ const r=tx(s,'readwrite').delete(k); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function get_(s,k){ return new Promise((res,rej)=>{ const r=tx(s).get(k); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function all(s){ return new Promise((res,rej)=>{ const r=tx(s).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }

const A=document.getElementById('audio'), T=document.getElementById('title'), S=document.getElementById('seek'), CUR=document.getElementById('cur'), DUR=document.getElementById('dur');
const BTN={ play:document.getElementById('play'), prev:document.getElementById('prev'), next:document.getElementById('next') };
const openLib=document.getElementById('openLib'), sheet=document.getElementById('sheet'), closeLib=document.getElementById('closeLib');
const picker=document.getElementById('picker'), tracksSel=document.getElementById('tracks'), playlistSel=document.getElementById('playlist');
const up=document.getElementById('up'), down=document.getElementById('down'), rm=document.getElementById('rm'), rmLib=document.getElementById('rmLib'), playSel=document.getElementById('playSel');
const sortSel=document.getElementById('sort'), rateLabel=document.getElementById('rateLabel');
// iOS（PWA含む）検出
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
           || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const tracksListDiv = document.getElementById('tracksList');  
const META={ LAST:'last', LAST_PL:'lastPlaylist', SORT:'sort', RATE:'rate' };
const VALL='_all';
const mmss=s=>{ s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60),r=s%60; return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`; };
function isAudioFile(f){ if(!f)return false; if((f.type||'').startsWith('audio/')) return true; return /\.(mp3|m4a|aac|wav|m4b)$/i.test(f.name||''); }
async function toBlobSafe(file){ const type=file.type||'audio/mpeg'; if(file.size<=20*1024*1024){ const buf=await file.arrayBuffer(); return new Blob([buf],{type}); } return file.slice(0,file.size,type); }
function fileIdOf(f){ return `${f.name}__${f.size}__${f.lastModified}`; }

const memoryShadow=new Map();
async function idbSelfTest(){ try{ await put('meta',{key:'__selftest__',value:Date.now()}); const back=await get_('meta','__selftest__'); return !!back; }catch(e){ console.warn('IDB selftest failed',e); return false; } }
async function ensurePersistence(){ if(!('storage'in navigator)||!navigator.storage.persist) return null; try{ return await navigator.storage.persist(); }catch{ return null; } }

async function ensurePlaylist(){ const pls=await all('playlists'); if(!pls.length){ const p={id:`pl_${Date.now()}`,name:'My Playlist',trackIds:[],createdAt:Date.now()}; await put('playlists',p); await put('meta',{key:META.LAST_PL,value:p.id}); } }
async function renderPlaylists(){ const pls=await all('playlists'); const last=(await get_('meta',META.LAST_PL))?.value||VALL;
  playlistSel.innerHTML=''; const o=document.createElement('option'); o.value=VALL; o.textContent='All Tracks'; playlistSel.appendChild(o);
  for(const p of pls.sort((a,b)=>a.createdAt-b.createdAt)){ const e=document.createElement('option'); e.value=p.id; e.textContent=p.name; playlistSel.appendChild(e); }
  playlistSel.value=[...playlistSel.options].some(x=>x.value===last)?last:VALL;
}
async function sortedLibIds(){ const list=[...(await all('tracks')), ...Array.from(memoryShadow.values())];
  const seen=new Set(), uniq=[]; for(const t of list){ if(seen.has(t.id)) continue; seen.add(t.id); uniq.push(t); }
  const sort=(await get_('meta',META.SORT))?.value||'nameAsc'; if(sort==='nameAsc') uniq.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ja')); if(sort==='addedDesc') uniq.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  return uniq.map(t=>t.id);
}
async function currentPlaylist(){ const id=playlistSel.value; if(id===VALL) return {id,name:'All',trackIds:await sortedLibIds()}; return (await get_('playlists',id))||{id,name:'(none)',trackIds:[]}; }
async function renderTracks(){
  const pl = await currentPlaylist();

  // ライブラリ（DB＋影武者）を辞書化
  const lib = [ ...(await all('tracks')), ...Array.from(memoryShadow.values()) ];
  const byId = Object.fromEntries(lib.map(t => [t.id, t]));

  // 直前の選択を記憶
  const prevSel = getSelectedTrackId();

  // --- 標準<select> をクリア・再描画 ---
  tracksSel.innerHTML = '';
  let count = 0;
  for (const id of pl.trackIds || []) {
    const t = byId[id]; if (!t) continue;
    const o = document.createElement('option');
    o.value = id; o.textContent = t.name;
    tracksSel.appendChild(o);
    count++;
  }
  if (!count) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '（曲なし）';
    tracksSel.appendChild(o);
  }

  // --- iOS用 listbox をクリア・再描画 ---
  tracksListDiv.innerHTML = '';
  if (count) {
    for (const id of pl.trackIds || []) {
      const t = byId[id]; if (!t) continue;
      const item = document.createElement('div');
      item.className = 'listitem';
      item.role = 'option';
      item.dataset.id = id;
      item.textContent = t.name;
      item.addEventListener('click', ()=>{
        setSelectedTrackId(id);
      }, { passive: true });
      item.addEventListener('dblclick', async ()=>{
        await loadById(id, { resume: true, autoplay: true });
      }, { passive: true });
      tracksListDiv.appendChild(item);
    }
  } else {
    const item = document.createElement('div');
    item.className = 'listitem';
    item.textContent = '（曲なし）';
    tracksListDiv.appendChild(item);
  }

  // --- 表示切替（iOSはlistbox、PCは<select>） ---
  if (isiOS) {
    tracksListDiv.hidden = false;
    tracksSel.hidden = true;
  } else {
    tracksListDiv.hidden = true;
    tracksSel.hidden = false;
  }

  // 選択を復元（あれば）
  if (prevSel) setSelectedTrackId(prevSel);
  else if (count) setSelectedTrackId((pl.trackIds||[])[0]);
}

async function getImportTargetPlaylistId(){ const sel=playlistSel?.value; if(sel&&sel!==VALL) return sel;
  let last=(await get_('meta',META.LAST_PL))?.value; if(last) return last; const pls=await all('playlists'); if(pls.length) return pls[0].id;
  const p={id:`pl_${Date.now()}`,name:'My Playlist',trackIds:[],createdAt:Date.now()}; await put('playlists',p); await put('meta',{key:META.LAST_PL,value:p.id}); return p.id;
}

const CHUNK=4*1024*1024;
async function saveChunked(file,id,type){ const reader=file.stream().getReader(); let i=0,pending=[],size=0;
  async function flush(){ while(pending.length){ const part=pending.shift(); const key=`${id}#${i++}`; await put('chunks',{key,id,index:i-1,blob:new Blob([part],{type:type||'application/octet-stream'})}); } size=0; }
  while(true){ const {value,done}=await reader.read(); if(done) break; pending.push(value); size+=value.byteLength; if(size>=CHUNK) await flush(); }
  await flush(); await put('tracks',{id,name:file.name,type:file.type||type||'audio/mpeg',size:file.size,chunked:true,chunkSize:CHUNK,addedAt:Date.now()});
}
async function loadBlobForTrack(t){ if(!t?.chunked) return t?.blob; const parts=[]; for(let i=0;;i++){ const rec=await get_('chunks',`${t.id}#${i}`); if(!rec) break; parts.push(rec.blob); } if(!parts.length) throw new Error('chunks missing'); return new Blob(parts,{type:t.type||'audio/mpeg'}); }
async function deleteChunksForTrack(id){ for(let i=0;i<10000;i++){ const key=`${id}#${i}`; const hit=await get_('chunks',key); if(!hit) break; await del_('chunks',key); } }

async function loadById(id,{resume=true,autoplay=false}={}){ if(!id) return; let t=await get_('tracks',id); if(!t) t=memoryShadow.get(id); if(!t) return;
  const blob=t.chunked?await loadBlobForTrack(t):t.blob; const url=URL.createObjectURL(blob); A.src=url;
  const prog=await get_('progress',id); const start=(resume&&prog)?prog.time:0;
  A.currentTime=start||0; setTitleText(t.name || '再生中');CUR.textContent=mmss(start||0); S.value='0'; DUR.textContent='--:--';
  await put('meta',{key:META.LAST,value:id}); if(autoplay) A.play().catch(()=>{});
}
async function playNext(delta){ const order=(await currentPlaylist()).trackIds; if(!order.length) return; const curId=(await get_('meta',META.LAST))?.value || order[0];
  let idx=Math.max(0,order.indexOf(curId)); idx=(idx+delta+order.length)%order.length; await loadById(order[idx],{resume:true,autoplay:true}); }
async function rebuildQueue(){ const pl=await currentPlaylist(); const order=pl.trackIds||[]; if(!order.length) return; const last=(await get_('meta',META.LAST))?.value; if(!last||!order.includes(last)) await put('meta',{key:META.LAST,value:order[0]}); }

const saver=(()=>{ let tid=null,last={id:null,t:0},lastFlush=0; const MS=10000;
  async function flushNow(){ if(!last.id) return; await put('progress',{id:last.id,time:last.t}); lastFlush=Date.now(); }
  return { schedule(id,t){ if(!id) return; last={id,t}; if(tid) return; const wait=Math.max(0,MS-(Date.now()-lastFlush)); tid=setTimeout(async()=>{tid=null; await flushNow();},wait); },
           async flush(){ if(tid){clearTimeout(tid); tid=null;} await flushNow(); } };
})();

async function deleteTrackEverywhere(id){
  if(!id) return;
  const pls=await all('playlists'); for(const p of pls){ const before=p.trackIds.length; p.trackIds=p.trackIds.filter(x=>x!==id); if(p.trackIds.length!==before) await put('playlists',p); }
  await del_('tracks',id).catch(()=>{}); await del_('progress',id).catch(()=>{}); await deleteChunksForTrack(id).catch(()=>{}); memoryShadow.delete(id);
  const last=(await get_('meta','last'))?.value; if(last===id) await put('meta',{key:'last',value:null}); await renderTracks(); await rebuildQueue();
}
async function nukeAllData(){ if(!confirm('⚠ 本当に全データを消しますか？（曲・PL・進捗・キャッシュ）')) return;
  try{ db&&db.close&&db.close(); }catch{} await new Promise((res,rej)=>{ const r=indexedDB.deleteDatabase(DB); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
  if('caches'in window){ const keys=await caches.keys(); await Promise.all(keys.map(k=>caches.delete(k))); }
  if(navigator.serviceWorker){ const regs=await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister())); }
  alert('初期化しました。再読み込みします。'); location.reload();
}
// 追加：速度プリセット
const RATES = [0.75, 1.0, 1.25, 1.5, 2.0];

function applyRate(r){
  A.playbackRate = r;
  rateLabel.textContent = r.toFixed(2).replace(/\.00$/,'') + 'x';
}

function getSelectedTrackId(){
  if (isiOS && !tracksListDiv.hidden) {
    const cur = tracksListDiv.querySelector('.listitem.selected');
    return cur?.dataset.id || '';
  }
  return tracksSel.value || '';
}

function setSelectedTrackId(id){
  if (isiOS && !tracksListDiv.hidden) {
    tracksListDiv.querySelectorAll('.listitem').forEach(el=>{
      el.classList.toggle('selected', el.dataset.id === id);
      if (el.dataset.id === id) el.setAttribute('aria-selected','true'); else el.removeAttribute('aria-selected');
    });
  } else {
    tracksSel.value = id || '';
  }
}

// 追加：任意秒数シーク（範囲安全化）
function seekBy(sec){
const d = isFinite(A.duration) ? A.duration : 0;
if (!d) return;
let t = (A.currentTime || 0) + sec;
t = Math.max(0, Math.min(d - 0.25, t)); // 終端でended誤発を避けて少し手前に
A.currentTime = t;
}

async function importFiles(fileList){
  const files=Array.from(fileList).filter(isAudioFile); if(!files.length) return;
  const pid=await getImportTargetPlaylistId(); let pl=await get_('playlists',pid);
  for(const f of files){
    const id=fileIdOf(f);
    try{
      if(f.size>32*1024*1024) await saveChunked(f,id,f.type);
      else { const blob=await toBlobSafe(f); await put('tracks',{id,name:f.name,type:f.type,size:f.size,blob,addedAt:Date.now()}); }
      if(pl && !pl.trackIds.includes(id)){ pl.trackIds.push(id); await put('playlists',pl); }
    }catch(e){
      console.warn('import failed -> memory fallback', f?.name, e);
      const blob=await toBlobSafe(f); memoryShadow.set(id,{id,name:f.name,type:f.type,size:f.size,blob,addedAt:Date.now()});
    }
  }
  await renderPlaylists(); if(playlistSel.value===VALL) playlistSel.value=pid; await renderTracks(); await rebuildQueue();
}
  
function enableTitleMarqueeIfNeeded(text){
  const el = document.getElementById('title');
  if (!el) return;
  el.classList.remove('marquee','pause');
  el.innerHTML = `<span>${text}</span>`;
  const span = el.querySelector('span');
  // 少し待って幅を判定
  requestAnimationFrame(()=>{
    if (span.scrollWidth > el.clientWidth) {
      const repeat = document.createElement('span');
      repeat.textContent = `  —  ${text}`;
      el.appendChild(repeat);
      el.classList.add('marquee');
      // 長押しで一時停止
      el.addEventListener('pointerdown', ()=> el.classList.add('pause'), {passive:true});
      el.addEventListener('pointerup',   ()=> el.classList.remove('pause'), {passive:true});
    }
  });
}
function setTitleText(text) {
  const el = document.getElementById('title');
  if (!el) return;
  el.textContent = text || '';
  // フルテキストは dataset に持たせておく
  el.dataset.full = text || '';
}

function titleOverflows() {
  const el = document.getElementById('title');
  if (!el) return false;
  // レイアウト確定後に幅判定（Safariでも軽い）
  return el.scrollWidth > el.clientWidth + 1;
}

let peekTid = null;
function showTitlePeek() {
  const el = document.getElementById('title');
  const peek = document.getElementById('titlePeek');
  if (!el || !peek) return;

  // 短いタイトルなら何もしない（省電力）
  if (!titleOverflows()) return;

  peek.textContent = el.dataset.full || el.textContent || '';
  peek.hidden = false;
  // 2.5秒で自動消灯（アニメ無し）
  if (peekTid) clearTimeout(peekTid);
  peekTid = setTimeout(()=> { peek.hidden = true; }, 2500);
}

(async function init(){
  await openDB();
  const ok=await idbSelfTest(); const persisted=await ensurePersistence(); const est=await (navigator.storage?.estimate?.()||Promise.resolve(null));
  console.log('IDB ok:',ok,'persisted:',persisted,'estimate:',est);

  await ensurePlaylist(); await renderPlaylists(); await renderTracks();

  openLib.addEventListener('click', ()=>{ sheet.style.display='block'; sheet.ariaHidden='false'; }, {passive:true});
  closeLib.addEventListener('click', ()=>{ sheet.style.display='none'; sheet.ariaHidden='true'; }, {passive:true});

    // init() 内：プレイリスト描画の前あたりに「保存値の読み込み」を追加
  const savedRate = (await get_('meta', META.RATE))?.value || 1.0;
  applyRate(savedRate);
    
  picker.addEventListener('change', async (e)=>{ const files=Array.from(e.target.files||[]); if(!files.length) return; try{ await importFiles(files); } finally{ e.target.value=''; } }, {passive:true});

  // タイトルをタップしたら一時ポップ表示
  document.getElementById('title')?.addEventListener('click', showTitlePeek, { passive: true });
  document.getElementById('newPl').addEventListener('click', async ()=>{ const name=prompt('プレイリスト名？','New Playlist'); if(!name) return;
    const p={id:`pl_${Date.now()}`,name,trackIds:[],createdAt:Date.now()}; await put('playlists',p); await put('meta',{key:META.LAST_PL,value:p.id});
    await renderPlaylists(); playlistSel.value=p.id; await renderTracks();
  });
  document.getElementById('renPl').addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL) return;
    const p=await get_('playlists',id); const name=prompt('新しい名前？',p.name); if(!name) return; p.name=name; await put('playlists',p); await renderPlaylists(); playlistSel.value=id;
  });
  document.getElementById('delPl').addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL) return;
    if(!confirm('プレイリストを削除しますか？（曲は消えません）')) return; await del_('playlists',id); playlistSel.value=VALL; await renderPlaylists(); await renderTracks(); await rebuildQueue();
  });
  up.addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL) return; const pl=await get_('playlists',id);
    const cur=getSelectedTrackId(); const i=pl.trackIds.indexOf(cur); const j=i-1; if(i<=0) return; [pl.trackIds[i],pl.trackIds[j]]=[pl.trackIds[j],pl.trackIds[i]]; await put('playlists',pl); await renderTracks(); tracksSel.value=cur;
  }, {passive:true});
  down.addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL) return; const pl=await get_('playlists',id);
    const cur=getSelectedTrackId(); const i=pl.trackIds.indexOf(cur); const j=i+1; if(i<0||j>=pl.trackIds.length) return; [pl.trackIds[i],pl.trackIds[j]]=[pl.trackIds[j],pl.trackIds[i]]; await put('playlists',pl); await renderTracks(); tracksSel.value=cur;
  }, {passive:true});
  rm.addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL) return; const pl=await get_('playlists',id);
    const cur=getSelectedTrackId(); pl.trackIds=pl.trackIds.filter(x=>x!==cur); await put('playlists',pl); await renderTracks(); await rebuildQueue();
  }, {passive:true});
  rmLib.addEventListener('click', async ()=>{ const cur=getSelectedTrackId(); if(!cur) return; if(!confirm('この曲をライブラリから完全削除しますか？')) return; await deleteTrackEverywhere(cur);
  }, {passive:true});
  playSel.addEventListener('click', async ()=>{ const id=getSelectedTrackId(); if(id) await loadById(id,{resume:true,autoplay:true}); }, {passive:true});
  sortSel.addEventListener('change', async ()=>{ await put('meta',{key:META.SORT,value:sortSel.value}); await renderTracks(); }, {passive:true});

  BTN.play.addEventListener('click', ()=> A.paused?A.play():A.pause(), {passive:true});
  BTN.prev.addEventListener('click', ()=> playNext(-1), {passive:true});
  BTN.next.addEventListener('click', ()=> playNext(+1), {passive:true});

  S.addEventListener('input', ()=>{ const t=(A.duration||0)*Number(S.value); CUR.textContent=mmss(t); }, {passive:true});
  S.addEventListener('change', ()=>{ const t=(A.duration||0)*Number(S.value); A.currentTime=t; }, {passive:true});

  A.addEventListener('loadedmetadata', ()=>{ if(isFinite(A.duration)) DUR.textContent=mmss(A.duration); }, {passive:true});
  A.addEventListener('timeupdate', async ()=>{ if(isFinite(A.duration)){ S.value=(A.currentTime/A.duration).toFixed(3); CUR.textContent=mmss(A.currentTime); }
    const id=(await get_('meta',META.LAST))?.value; saver.schedule(id,A.currentTime);
  }, {passive:true});
  A.addEventListener('pause', ()=>{ saver.flush(); }, {passive:true});
  A.addEventListener('ended', async ()=>{
    await saver.flush();              // 位置保存
    await playNext(+1);               // ★ 自動で次の曲へ（循環）
  }, {passive:true});
  // init() のイベント登録群に「ラベルタップで速度切替」を追加
  rateLabel.addEventListener('click', async ()=>{
    const cur = A.playbackRate || 1.0;
    const idx = RATES.findIndex(x => Math.abs(x - cur) < 1e-6);
    const next = RATES[(idx + 1) % RATES.length];
    applyRate(next);
    await put('meta', { key: META.RATE, value: next });  // 永続化
  }, {passive:true});
  window.addEventListener('pagehide', ()=>{ saver.flush(); }, {passive:true});

  // タイトルが溢れる時だけ、スクロール表示に切り替え
  function enableTitleMarqueeIfNeeded(text){
    const el = document.getElementById('title');
    if (!el) return;
    el.classList.remove('marquee','pause');
    el.textContent = text || '';
  
    // 一旦描画させて幅を測る
    const need = el.scrollWidth > el.clientWidth;
    if (!need) return;
  
    // スクロール用に内容を2回並べる
    const span = document.createElement('span');
    span.textContent = ` ${text} \u00a0\u00a0\u00a0—\u00a0\u00a0\u00a0 ${text} `;
    el.innerHTML = '';
    el.appendChild(span);
    el.classList.add('marquee');
  
    // 長押しで一時停止（好みで）
    el.addEventListener('pointerdown', ()=> el.classList.add('pause'), {passive:true});
    el.addEventListener('pointerup',   ()=> el.classList.remove('pause'), {passive:true});
  }
  
  // init() 内のイベント登録群に追加
  document.getElementById('back10').addEventListener('click', ()=> seekBy(-10), {passive:true});
  document.getElementById('fwd10').addEventListener('click', ()=> seekBy(+10), {passive:true});
  const last=(await get_('meta',META.LAST))?.value; if(last) await loadById(last,{resume:true});
})().catch(err=>{ alert('初期化エラー: '+(err?.message||err)); });
})();
