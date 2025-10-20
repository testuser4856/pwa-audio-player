// Debug-friendly mini player
(function(){
'use strict';

window.addEventListener('error', (e)=>{
  console.error('window error', e.error || e.message);
  alert('JSエラー: ' + (e.error?.message || e.message));
});
window.addEventListener('unhandledrejection', (e)=>{
  console.error('unhandled', e.reason);
  alert('Promiseエラー: ' + (e.reason?.message || e.reason));
});

// ---- IndexedDB helpers ----
const DB='pwa-audio-db', VER=5; let db;
const STORES={tracks:{keyPath:'id'},progress:{keyPath:'id'},meta:{keyPath:'key'},playlists:{keyPath:'id'}};
function openDB(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(DB,VER);
    r.onupgradeneeded=()=>{
      const d=r.result;
      for(const[k,v] of Object.entries(STORES)){
        if(!d.objectStoreNames.contains(k)) d.createObjectStore(k,v);
      }
    };
    r.onsuccess=()=>{ db=r.result; res(db); };
    r.onerror=()=>rej(r.error);
  });
}
function tx(s,m='readonly'){ return db.transaction(s,m).objectStore(s); }
function put(s,v){ return new Promise((res,rej)=>{ const r=tx(s,'readwrite').put(v); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function del_(s,k){ return new Promise((res,rej)=>{ const r=tx(s,'readwrite').delete(k); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function get_(s,k){ return new Promise((res,rej)=>{ const r=tx(s).get(k); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function all(s){ return new Promise((res,rej)=>{ const r=tx(s).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }

// ---- DOM ----
const A = document.getElementById('audio');
const T = document.getElementById('title');
const S = document.getElementById('seek');
const CUR = document.getElementById('cur');
const DUR = document.getElementById('dur');
const BTN = { play:document.getElementById('play'), prev:document.getElementById('prev'), next:document.getElementById('next') };
const openLib=document.getElementById('openLib'), sheet=document.getElementById('sheet'), closeLib=document.getElementById('closeLib');
const picker=document.getElementById('picker');
const tracksSel=document.getElementById('tracks'), playlistSel=document.getElementById('playlist');
const up=document.getElementById('up'), down=document.getElementById('down'), rm=document.getElementById('rm'), playSel=document.getElementById('playSel');
const sortSel=document.getElementById('sort'), rateLabel=document.getElementById('rateLabel');

const META={ LAST:'last', LAST_PL:'lastPlaylist', SORT:'sort', RATE:'rate' };
const VALL='_all';
const mmss=s=>{ s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60),r=s%60; return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`; };

// === 再生位置保存（10秒ごと & 停止時フラッシュ） ===
const saver = (() => {
  let tid = null, last = { id:null, t:0 }, lastFlush = 0;
  const MS = 10000;
  async function flushNow(){
    if (!last.id) return;
    await put('progress', { id: last.id, time: last.t });
    lastFlush = Date.now();
  }
  return {
    schedule(id, t){
      if (!id) return;
      last = { id, t };
      if (tid) return;
      const wait = Math.max(0, MS - (Date.now() - lastFlush));
      tid = setTimeout(async () => { tid = null; await flushNow(); }, wait);
    },
    async flush(){
      if (tid) { clearTimeout(tid); tid = null; }
      await flushNow();
    }
  };
})();

function isAudioFile(f){
  if (!f) return false;
  if ((f.type || '').startsWith('audio/')) return true;
  return /\.(mp3|m4a|aac|wav|m4b)$/i.test(f.name || '');
}
async function toBlobSafe(file){
  const type = file.type || 'audio/mpeg';
  if (file.size <= 20*1024*1024){
    const buf = await file.arrayBuffer();
    return new Blob([buf], {type});
  }
  return file.slice(0, file.size, type);
}

// ---- library ----
function fileIdOf(f){ return `${f.name}__${f.size}__${f.lastModified}`; }
async function ensurePlaylist(){
  const pls = await all('playlists');
  if (!pls.length){
    const p={id:`pl_${Date.now()}`,name:'My Playlist',trackIds:[],createdAt:Date.now()};
    await put('playlists',p); await put('meta',{key:META.LAST_PL,value:p.id});
  }
}
async function renderPlaylists(){
  const pls=await all('playlists'); const last=(await get_('meta',META.LAST_PL))?.value||VALL;
  playlistSel.innerHTML='';
  const o=document.createElement('option'); o.value=VALL; o.textContent='All Tracks'; playlistSel.appendChild(o);
  for(const p of pls.sort((a,b)=>a.createdAt-b.createdAt)){ const e=document.createElement('option'); e.value=p.id; e.textContent=p.name; playlistSel.appendChild(e); }
  playlistSel.value=[...playlistSel.options].some(x=>x.value===last)?last:VALL;
}
async function sortedLibIds(){
  const list=await all('tracks'); const sort=(await get_('meta',META.SORT))?.value||'nameAsc';
  if(sort==='nameAsc') list.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  if(sort==='addedDesc') list.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  return list.map(t=>t.id);
}
async function currentPlaylist(){
  const id=playlistSel.value;
  if(id===VALL) return {id,name:'All',trackIds:await sortedLibIds()};
  return (await get_('playlists',id))||{id,name:'(none)',trackIds:[]};
}
async function renderTracks(){
  const pl=await currentPlaylist(), lib=await all('tracks'), byId=Object.fromEntries(lib.map(t=>[t.id,t]));
  tracksSel.innerHTML='';
  for(const id of pl.trackIds){ const t=byId[id]; if(!t) continue; const o=document.createElement('option'); o.value=id; o.textContent=t.name; tracksSel.appendChild(o); }
  if(!tracksSel.options.length){ const o=document.createElement('option'); o.value=''; o.textContent='（曲なし）'; tracksSel.appendChild(o); }
}

// ---- player ----
async function loadById(id,{resume=true,autoplay=false}={}){
  if(!id) return;
  const t=await get_('tracks',id); if(!t) return;
  const url=URL.createObjectURL(t.blob); A.src=url;
  const p=await get_('progress',id); const start=(resume&&p)?p.time:0;
  A.currentTime=start||0; T.textContent=t.name||'再生中'; CUR.textContent=mmss(start||0); S.value='0'; DUR.textContent='--:--';
  await put('meta',{key:META.LAST,value:id});
  if(autoplay) A.play().catch(()=>{});
}
async function playNext(delta){
  const order=(await currentPlaylist()).trackIds; if(!order.length) return;
  const curId=(await get_('meta',META.LAST))?.value || order[0];
  let idx=Math.max(0,order.indexOf(curId)); idx=(idx+delta+order.length)%order.length;
  await loadById(order[idx],{resume:true,autoplay:true});
}

// ---- import ----
async function importFiles(fileList){
  const files = Array.from(fileList).filter(isAudioFile);
  if (!files.length){ console.log('no audio'); return; }
  const pid = playlistSel.value;
  let ok=0, ng=0;
  for(const f of files){
    try{
      const id=fileIdOf(f);
      const blob=await toBlobSafe(f);
      await put('tracks',{id,name:f.name,type:f.type,size:f.size,blob,addedAt:Date.now()});
      if (pid && pid!==VALL){
        const pl=await get_('playlists',pid); if(pl && !pl.trackIds.includes(id)){ pl.trackIds.push(id); await put('playlists',pl); }
      }
      ok++;
    }catch(e){ console.warn('import failed', f.name, e); ng++; }
  }
  await renderTracks();
  console.log('import done', ok, 'ok', ng, 'ng');
}

// 選んだ曲をライブラリから完全削除（全PLからも外す）
async function deleteTrackEverywhere(id){
  if(!id) return;

  // 全プレイリストから外す
  const pls = await all('playlists');
  for (const p of pls) {
    const before = p.trackIds.length;
    p.trackIds = p.trackIds.filter(x => x !== id);
    if (p.trackIds.length !== before) await put('playlists', p);
  }

  // 曲データ＆進捗を削除
  await del_('tracks', id).catch(()=>{});
  await del_('progress', id).catch(()=>{});

  // 最後に再生していたIDならクリア
  const last = (await get_('meta','last'))?.value;
  if (last === id) await put('meta', { key:'last', value: null });

  await renderTracks();
  await rebuildQueue();
}

// 危険操作：IndexedDB + SW キャッシュを全消し
async function nukeAllData(){
  if (!confirm('⚠ 本当に全データを消しますか？（曲・PL・進捗・キャッシュ）')) return;

  // IndexedDB 全削除
  try { db && db.close && db.close(); } catch {}
  await new Promise((res,rej)=>{ const r = indexedDB.deleteDatabase('pwa-audio-db'); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });

  // Service Worker キャッシュ削除（このサイト分）
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k))); // 必要なら prefix で絞ってもOK
  }

  // SW も解除（任意）
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
  }

  alert('初期化しました。ページを再読み込みします。');
  location.reload();
}

// ---- queue（簡易） ----
// 現在のプレイリストに "last" が無ければ、先頭を "last" にして整合を取る
async function rebuildQueue(){
  const pl = await currentPlaylist();
  const order = pl.trackIds || [];
  if (!order.length) return;

  const last = (await get_('meta','last'))?.value;
  if (!last || !order.includes(last)) {
    await put('meta', { key:'last', value: order[0] });
  }
  // デバッグ版の playNext は currentPlaylist() を毎回見に行くので、
  // ここではインデックス保持などは不要（no-op的な整合処理だけ）
}

// ---- init ----
(async function init(){
  await openDB();
  await ensurePlaylist();
  await renderPlaylists();
  await renderTracks();

  openLib.addEventListener('click', ()=>{ sheet.style.display='block'; sheet.ariaHidden='false'; }, {passive:true});
  closeLib.addEventListener('click', ()=>{ sheet.style.display='none'; sheet.ariaHidden='true'; }, {passive:true});

  picker.addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files||[]);
    if (!files.length) return;
    await importFiles(files);
    e.target.value='';
  }, {passive:true});

  // ボタン紐付け（init 内のイベント登録群に追加）
  document.getElementById('rmLib')?.addEventListener('click', async ()=>{
    const id = document.getElementById('tracks')?.value;
    if (!id) return;
    if (confirm('この曲をライブラリから完全に削除しますか？（全PLから外れます）')){
      await deleteTrackEverywhere(id);
    }
  }, {passive:true});
  
  document.getElementById('nuke')?.addEventListener('click', nukeAllData, {passive:true});
  
  A.addEventListener('pause', () => { saver.flush(); }, {passive:true});
  A.addEventListener('ended', () => { saver.flush(); }, {passive:true});
  window.addEventListener('pagehide', () => { saver.flush(); }, {passive:true});

  BTN.play.addEventListener('click', ()=> A.paused?A.play():A.pause(), {passive:true});
  BTN.prev.addEventListener('click', ()=> playNext(-1), {passive:true});
  BTN.next.addEventListener('click', ()=> playNext(+1), {passive:true});

  S.addEventListener('input', ()=>{
    const t=(A.duration||0)*Number(S.value); CUR.textContent=mmss(t);
  }, {passive:true});
  S.addEventListener('change', ()=>{
    const t=(A.duration||0)*Number(S.value); A.currentTime=t;
  }, {passive:true});

  A.addEventListener('loadedmetadata', ()=>{ if(isFinite(A.duration)) DUR.textContent=mmss(A.duration); }, {passive:true});
  A.addEventListener('timeupdate', async () => {
    if (isFinite(A.duration)) {
      S.value = (A.currentTime / A.duration).toFixed(3);
      CUR.textContent = mmss(A.currentTime);
    }
    // ★ 追加：現在曲IDで進捗をスケジュール保存
    const id = (await get_('meta','last'))?.value;
    saver.schedule(id, A.currentTime);
  }, {passive:true});


  const last=(await get_('meta',META.LAST))?.value;
  if(last) await loadById(last,{resume:true});
})().catch(err=>{
  console.error('init failed', err);
  alert('初期化エラー: ' + (err?.message || err));
});
})();
