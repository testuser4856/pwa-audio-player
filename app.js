// ==== 軽量IndexedDBラッパ ====
const DB='pwa-audio-db', VER=4; let db;
const STORES={tracks:{keyPath:'id'},progress:{keyPath:'id'},meta:{keyPath:'key'},playlists:{keyPath:'id'}};
const openDB=()=>new Promise((res,rej)=>{const r=indexedDB.open(DB,VER);r.onupgradeneeded=()=>{const d=r.result;for(const[k,v]of Object.entries(STORES))if(!d.objectStoreNames.contains(k))d.createObjectStore(k,v)};r.onsuccess=()=>{db=r.result;res(db)};r.onerror=()=>rej(r.error)});
const tx=(s,m='readonly')=>db.transaction(s,m).objectStore(s);
const put=(s,v)=>new Promise((res,rej)=>{const r=tx(s,'readwrite').put(v);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)});
const del=(s,k)=>new Promise((res,rej)=>{const r=tx(s,'readwrite').delete(k);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)});
const get=(s,k)=>new Promise((res,rej)=>{const r=tx(s).get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const all=(s)=>new Promise((res,rej)=>{const r=tx(s).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)});

// ==== 要素 ====
const A=document.getElementById('audio');
const T=document.getElementById('title');
const S=document.getElementById('seek');
const CUR=document.getElementById('cur');
const DUR=document.getElementById('dur');
const BTN={play:document.getElementById('play'),prev:document.getElementById('prev'),next:document.getElementById('next')};
const openLib=document.getElementById('openLib'), sheet=document.getElementById('sheet'), closeLib=document.getElementById('closeLib');
const picker=document.getElementById('picker'), importBtn=document.getElementById('import');
const tracksSel=document.getElementById('tracks'), playlistSel=document.getElementById('playlist');
const up=document.getElementById('up'), down=document.getElementById('down'), rm=document.getElementById('rm'), playSel=document.getElementById('playSel');
const sortSel=document.getElementById('sort'), rateSel=document.getElementById('rate'), rateLabel=document.getElementById('rateLabel');
const toggleRemain=document.getElementById('toggleRemain'), toggleMarquee=document.getElementById('toggleMarquee');

const META={LAST:'last',LAST_PL:'lastPlaylist',SORT:'sort',RATE:'rate',REMAIN:'remain',MARQ:'marquee'};
const VALL='_all';
const mmss=s=>{s=Math.max(0,Math.floor(s||0));const m=Math.floor(s/60),r=s%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`};
let pageVisible=true; addEventListener('visibilitychange',()=>{pageVisible=!document.hidden; if(!pageVisible) saver.flush();},{passive:true});

// ==== Media Session（1Hz） ====
let msWired=false,lastMS=0;
function msMeta(title){ if(!('mediaSession'in navigator))return;
  navigator.mediaSession.metadata=new MediaMetadata({title:title||'再生中',artist:'PWA Audio',album:'Local',artwork:[{src:'./icons/icon-192.png',sizes:'192x192',type:'image/png'}]});
}
function msWire(){ if(msWired||!('mediaSession'in navigator))return; msWired=true;
  navigator.mediaSession.setActionHandler('play', ()=>A.play());
  navigator.mediaSession.setActionHandler('pause',()=>A.pause());
  navigator.mediaSession.setActionHandler('previoustrack',()=>playNext(-1));
  navigator.mediaSession.setActionHandler('nexttrack',()=>playNext(+1));
  navigator.mediaSession.setActionHandler('seekbackward',({seekOffset=10})=>A.currentTime=Math.max(0,A.currentTime-seekOffset));
  navigator.mediaSession.setActionHandler('seekforward', ({seekOffset=30})=>A.currentTime=Math.min(A.duration||Infinity,A.currentTime+seekOffset));
}
function msPos1Hz(){ if(!('mediaSession'in navigator)||typeof navigator.mediaSession.setPositionState!=='function')return;
  const now=performance.now(); if(now-lastMS<1000)return; lastMS=now;
  if(!isFinite(A.duration))return;
  navigator.mediaSession.setPositionState({duration:Math.max(0,Number(A.duration)||0),playbackRate:Number(A.playbackRate)||1,position:Math.max(0,Number(A.currentTime)||0)});
}

// ==== 進捗保存（10秒間隔＋確定） ====
const saver=(()=>{let tid=null,last={id:null,t:0},lastFlush=0;const MS=10000;
  async function flushNow(){ if(!last.id)return; await put('progress',{id:last.id,time:last.t}); lastFlush=Date.now(); }
  return { schedule(id,t){ if(!id)return; last={id,t}; if(tid) return;
    const wait=Math.max(0,MS-(Date.now()-lastFlush));
    tid=setTimeout(async()=>{tid=null; await flushNow();},wait);
  }, async flush(){ if(tid){clearTimeout(tid); tid=null;} await flushNow(); } };
})();

// 置き換え：大量ファイルを逐次で安全に取り込み＋進捗表示
async function importFiles(fileList){
  const files = Array.from(fileList).filter(f => (f.type||'').startsWith('audio/'));
  if (!files.length) return;

  // 簡易進捗（タイトル欄を一時利用）
  const titleEl = document.getElementById('title');
  const origTitle = titleEl.textContent;

  const pid = document.getElementById('playlist').value;
  let done = 0;

  for (const f of files) {
    // 進捗表示（1/N）
    done++;
    titleEl.textContent = `取り込み中… ${done}/${files.length} : ${f.name}`;

    // 連続処理で固まらないように少しだけ譲る
    await new Promise(r => setTimeout(r, 0));

    try {
      const id = `${f.name}__${f.size}__${f.lastModified}`;
      const buf = await f.arrayBuffer();           // 読み込み
      const blob = new Blob([buf], { type: f.type || 'audio/mpeg' });

      // 曲データを保存
      await put('tracks', {
        id, name: f.name, type: f.type, size: f.size, blob,
        addedAt: Date.now()
      });

      // 選択中プレイリストに自動追加（All Tracksは除外）
      if (pid && pid !== '_all') {
        const pl = await get('playlists', pid);
        if (pl && !pl.trackIds.includes(id)) {
          pl.trackIds.push(id);
          await put('playlists', pl);
        }
      }
    } catch (e) {
      // 失敗はスキップ（で止めない）
      console.warn('import failed:', f.name, e);
    }
  }

  // 後片付け
  titleEl.textContent = origTitle;
  await renderTracks();
  await rebuildQueue();
}
async function ensurePlaylist(){
  const pls=await all('playlists');
  if(!pls.length){ const p={id:`pl_${Date.now()}`,name:'My Playlist',trackIds:[],createdAt:Date.now()}; await put('playlists',p); await put('meta',{key:META.LAST_PL,value:p.id}); }
}
async function renderPlaylists(){
  const pls=await all('playlists'); const last=(await get('meta',META.LAST_PL))?.value||VALL;
  playlistSel.innerHTML='';
  const o=document.createElement('option'); o.value=VALL; o.textContent='All Tracks'; playlistSel.appendChild(o);
  for(const p of pls.sort((a,b)=>a.createdAt-b.createdAt)){ const e=document.createElement('option'); e.value=p.id; e.textContent=p.name; playlistSel.appendChild(e); }
  playlistSel.value=[...playlistSel.options].some(x=>x.value===last)?last:VALL;
}
async function sortedLibIds(){
  const list=await all('tracks'); const sort=(await get('meta',META.SORT))?.value||'nameAsc';
  if(sort==='nameAsc') list.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  if(sort==='addedDesc') list.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  return list.map(t=>t.id);
}
async function currentPlaylist(){
  const id=playlistSel.value;
  if(id===VALL) return {id,name:'All',trackIds:await sortedLibIds()};
  return (await get('playlists',id))||{id,name:'(none)',trackIds:[]};
}
async function renderTracks(){
  const pl=await currentPlaylist(), lib=await all('tracks'), byId=Object.fromEntries(lib.map(t=>[t.id,t]));
  tracksSel.innerHTML='';
  for(const id of pl.trackIds){ const t=byId[id]; if(!t) continue; const o=document.createElement('option'); o.value=id; o.textContent=t.name; tracksSel.appendChild(o); }
  if(!tracksSel.options.length){ const o=document.createElement('option'); o.value=''; o.textContent='（曲なし）'; tracksSel.appendChild(o); }
}
async function reorder(dir){
  const pid=playlistSel.value; if(pid===VALL) return;
  const pl=await get('playlists',pid); const id=tracksSel.value; const i=pl.trackIds.indexOf(id);
  const j=dir==='up'?i-1:i+1; if(i<0||j<0||j>=pl.trackIds.length) return;
  [pl.trackIds[i],pl.trackIds[j]]=[pl.trackIds[j],pl.trackIds[i]];
  await put('playlists',pl); await renderTracks(); tracksSel.value=id; await rebuildQueue();
}
async function removeFromPl(){
  const pid=playlistSel.value; if(pid===VALL) return;
  const pl=await get('playlists',pid); pl.trackIds=pl.trackIds.filter(x=>x!==tracksSel.value);
  await put('playlists',pl); await renderTracks(); await rebuildQueue();
}

// ==== 再生キュー（前後3曲だけ持つ考え方の軽量版: 実装は現在曲のindexだけ保持） ====
const Q={ order:[], index:0 };
async function rebuildQueue(){
  const pl=await currentPlaylist();
  Q.order = pl.trackIds;
  const curId = (await get('meta',META.LAST))?.value || Q.order[0];
  Q.index = Math.max(0, Q.order.indexOf(curId));
}
function neighbor(delta){
  if(!Q.order.length) return null;
  let i=(Q.index+delta+Q.order.length)%Q.order.length;
  return Q.order[i]||null;
}

// ==== 再生制御 ====
async function loadById(id,{resume=true,autoplay=false}={}){
  if(!id) return;
  const t=await get('tracks',id); if(!t) return;
  const url=URL.createObjectURL(t.blob); A.src=url;

  const prog=await get('progress',id); const start=(resume&&prog)?prog.time:0;
  A.currentTime=start||0;
  await put('meta',{key:META.LAST,value:id});
  await rebuildQueue();

  // タイトル（既定はスクロールOFF／ON時のみDOM2倍に）
  const marq = (await get('meta',META.MARQ))?.value === true;
  if (marq) {
    T.classList.add('marquee');
    const safe = (t.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    T.innerHTML = `<span>${safe}　</span><span>${safe}　</span>`;
  } else {
    T.classList.remove('marquee');
    T.textContent = t.name || '再生中';
  }

  CUR.textContent=mmss(start||0); S.value='0'; DUR.textContent='--:--';
  msMeta(t.name); msWire();

  if(autoplay) A.play().catch(()=>{});
}
async function playNext(delta){
  if(!Q.order.length) return;
  Q.index = (Q.index + delta + Q.order.length) % Q.order.length;
  const nextId = Q.order[Q.index];
  await loadById(nextId,{resume:true,autoplay:true});
}

// ==== 初期化 ====
(async function init(){
  await openDB(); await ensurePlaylist(); await renderPlaylists(); await renderTracks(); await rebuildQueue();

  // 設定復元
  const r=Number((await get('meta',META.RATE))?.value||'1'); A.playbackRate=r; rateSel.value=String(r); rateLabel.textContent=`${r.toFixed(2).replace(/\.00$/,'')}x`;
  const remain=(await get('meta',META.REMAIN))?.value===true; toggleRemain.textContent=remain?'残り':'経過';
  const marq=(await get('meta',META.MARQ))?.value===true; toggleMarquee.textContent=marq?'スクロールON':'スクロールOFF';

  const last=(await get('meta',META.LAST))?.value; if(last) await loadById(last,{resume:true});

  // ミニ操作
  BTN.play.addEventListener('click',()=>A.paused?A.play():A.pause(),{passive:true});
  BTN.prev.addEventListener('click',()=>playNext(-1),{passive:true});
  BTN.next.addEventListener('click',()=>playNext(+1),{passive:true});

import JSZip from "jszip";
const zip = new JSZip();

// 例：プレイリスト
const playlists = [
  { id: "pl_123", name: "All Tracks", trackIds: tracks.map(t=>`${t.name}__${t.size}`), createdAt: Date.now() }
];
zip.file("playlists.json", JSON.stringify(playlists));

// さらに曲ファイルを追加
for (const t of tracks) {
  zip.file(`tracks/${t.name}`, t.blob);
}

const blob = await zip.generateAsync({ type: "blob" });
saveAs(blob, "library_01.zip");

picker.addEventListener('change', async e => {
  if (!e.target.files.length) return;
  await importFiles(e.target.files); // 既存の importFiles() を使用
  e.target.value = '';
});

const pickerJSON = document.getElementById('pickerJSON');
pickerJSON.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const arr = JSON.parse(text);
  for (const t of arr) {
    const blob = new Blob([new Uint8Array(t.blob)], { type: t.type });
    await put('tracks', { id: t.id, name: t.name, type: t.type, blob });
  }
  await renderTracks(); // 既存関数で画面に反映
  alert('曲を読み込みました！');
});


// 曲をJSONとして書き出す
document.getElementById('exportTracks').addEventListener('click', async () => {
  const tracks = await all('tracks'); // all() は既存IndexedDB関数
  const exportData = await Promise.all(tracks.map(async t => ({
    id: t.id,
    name: t.name,
    type: t.type,
    blob: Array.from(new Uint8Array(await t.blob.arrayBuffer()))
  })));
  const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tracks.json';
  a.click();
});

import JSZip from "jszip";

// ZIP読み込みボタン
document.getElementById("importZip").addEventListener("click", () => {
  document.getElementById("zipInput").click();
});

document.getElementById("zipInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  const titleEl = document.getElementById('title');
  const origTitle = titleEl.textContent;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    titleEl.textContent = `読み込み中… ${i+1}/${files.length} : ${file.name}`;
    
    try {
      const zip = await JSZip.loadAsync(file);

      // JSZip内の全ファイルを順次展開
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;

        if (path.endsWith(".mp3")) {
          const blob = await entry.async("blob");
          const id = `${path}__${blob.size}`;
          await put("tracks", { id, name: path, blob, addedAt: Date.now() });
        } 
        if (path.endsWith(".json")) {
          const text = await entry.async("text");
          const data = JSON.parse(text);

          if (Array.isArray(data)) {
            for (const pl of data) await put("playlists", pl);
          } else {
            await put("playlists", data);
          }
        }
      }

    } catch (err) {
      console.error("ZIP読み込み失敗:", file.name, err);
    }

    await renderPlaylists();
    await renderTracks();
  }

  titleEl.textContent = origTitle;
  alert("全てのZIPを読み込みました！");
});
  
  // シーク
  let scrubbing=false;
  S.addEventListener('input',()=>{scrubbing=true; const t=(A.duration||0)*Number(S.value); CUR.textContent=mmss(t);},{passive:true});
  S.addEventListener('change',()=>{const t=(A.duration||0)*Number(S.value); A.currentTime=t; scrubbing=false;},{passive:true});

  // 音声イベント
  A.addEventListener('loadedmetadata',()=>{ if(isFinite(A.duration)) DUR.textContent=mmss(A.duration); msPos1Hz();},{passive:true});
  A.addEventListener('timeupdate',async ()=>{
    if(pageVisible && isFinite(A.duration)){
      requestAnimationFrame(()=>{
        S.value=(A.currentTime/A.duration).toFixed(3);
        const showRemain = toggleRemain.textContent==='残り';
        CUR.textContent = showRemain ? `-${mmss((A.duration||0)-(A.currentTime||0))}` : mmss(A.currentTime);
      });
    }
    const id=(await get('meta',META.LAST))?.value; saver.schedule(id, A.currentTime);
    msPos1Hz();
  });
  A.addEventListener('play', ()=>{ BTN.play.textContent='⏸'; if('mediaSession'in navigator) navigator.mediaSession.playbackState='playing'; msPos1Hz(); },{passive:true});
  A.addEventListener('pause',()=>{ BTN.play.textContent='▶️'; if('mediaSession'in navigator) navigator.mediaSession.playbackState='paused'; saver.flush(); msPos1Hz(); },{passive:true});
  A.addEventListener('ended',()=>{ saver.flush(); },{passive:true});
  addEventListener('pagehide',()=>saver.flush(),{passive:true});

  // シート
  openLib.addEventListener('click', async ()=>{ sheet.style.display='block'; sheet.ariaHidden='false'; await renderPlaylists(); await renderTracks(); });
  closeLib.addEventListener('click', ()=>{ sheet.style.display='none'; sheet.ariaHidden='true'; });

  // 取り込み/並べ替え/PL操作
  importBtn.addEventListener('click', ()=>picker.click());
  picker.addEventListener('change', async e=>{ await importFiles(e.target.files); e.target.value=''; });
  up.addEventListener('click', ()=>reorder('up'));
  down.addEventListener('click', ()=>reorder('down'));
  rm.addEventListener('click', removeFromPl);
  playSel.addEventListener('click', async ()=>{ const id=tracksSel.value; if(id) await loadById(id,{resume:true,autoplay:true}); });

  playlistSel.addEventListener('change', async ()=>{ await put('meta',{key:META.LAST_PL,value:playlistSel.value}); await renderTracks(); await rebuildQueue(); });
  sortSel.addEventListener('change', async ()=>{ await put('meta',{key:META.SORT,value:sortSel.value}); if(playlistSel.value===VALL) await renderTracks(); await rebuildQueue(); });

  document.getElementById('newPl').addEventListener('click', async ()=>{ const name=prompt('プレイリスト名？','New Playlist'); if(!name)return; const p={id:`pl_${Date.now()}`,name,trackIds:[],createdAt:Date.now()}; await put('playlists',p); await renderPlaylists(); playlistSel.value=p.id; await renderTracks(); await rebuildQueue(); });
  document.getElementById('renPl').addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL)return; const p=await get('playlists',id); const name=prompt('新しい名前？',p.name); if(!name)return; p.name=name; await put('playlists',p); await renderPlaylists(); playlistSel.value=id; });
  document.getElementById('delPl').addEventListener('click', async ()=>{ const id=playlistSel.value; if(id===VALL)return; if(!confirm('プレイリストを削除しますか？（曲は消えません）'))return; await del('playlists',id); playlistSel.value=VALL; await renderPlaylists(); await renderTracks(); await rebuildQueue(); });

  // 倍速
  rateSel.addEventListener('change', async ()=>{ const r=Number(rateSel.value); A.playbackRate=r; await put('meta',{key:META.RATE,value:r}); rateLabel.textContent=`${r.toFixed(2).replace(/\.00$/,'')}x`; msPos1Hz(); });

  // トグル
  toggleRemain.addEventListener('click', async ()=>{
    const now = toggleRemain.textContent==='経過';
    toggleRemain.textContent = now ? '残り' : '経過';
    await put('meta',{key:META.REMAIN,value:now});
  });
  toggleMarquee.addEventListener('click', async ()=>{
    const next = toggleMarquee.textContent==='スクロールOFF';
    toggleMarquee.textContent = next ? 'スクロールON' : 'スクロールOFF';
    await put('meta',{key:META.MARQ,value:next});
    // 現在曲のタイトルを再適用
    const last=(await get('meta',META.LAST))?.value; if(last){ const t=await get('tracks',last); if(t){
      if(next){ T.classList.add('marquee'); const safe=(t.name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;'); T.innerHTML=`<span>${safe}　</span><span>${safe}　</span>`; }
      else { T.classList.remove('marquee'); T.textContent=t.name||'再生中'; }
    }}
  });
})();
