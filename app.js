/* Storyboard App — full JS (Present ▾ + Play movie + timeline + fixes)
   - Multi‑project (IndexedDB) + scrollable Project Picker
   - Comic / Board / Presentation
   - Editor (lens, type, moves, transition, dialogue, notes) + voice notes
   - Replace/Delete from Editor
   - Transitions between shots
   - Export MP4 (ffmpeg.wasm via CDN) with full audio mix, progress UI + toasts
   - WebM fallback with progress
   - iPhone-friendly presentation/video
   - Present ▾ dropdown (Manual Present + Auto “Play movie”)
   - NEW: Present button fixes; auto mode fullscreen + hidden arrows + timeline + full-frame video
*/

(()=>{

// =========================
// Small helpers
// =========================
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
const uid = (p="p_") => p + Math.random().toString(36).slice(2,10);
const esc = s => String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
const sanitize = s => String(s||"").replace(/[^\w\-]+/g,"_").slice(0,60);
const debounce = (fn, ms=350)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
const sleep = ms => new Promise(r=>setTimeout(r, ms));
function fileToDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
function loadImage(src){ return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=src; }); }
function downloadBlob(data, filename, type){
  const blob = data instanceof Blob ? data : new Blob([data], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1200);
}
function longPress(el, ms, cb){ let t=null; on(el,"touchstart",()=>{ t=setTimeout(cb,ms); },{passive:true}); on(el,"touchend",()=>clearTimeout(t),{passive:true}); on(el,"touchmove",()=>clearTimeout(t),{passive:true}); on(el,"mousedown",()=>{ t=setTimeout(cb,ms); }); on(el,"mouseup",()=>clearTimeout(t)); on(el,"mouseleave",()=>clearTimeout(t)); }
function formatTime(s){ s=Math.round(s); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,"0")}`; }
function importScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=()=>res(); s.onerror=rej; document.head.appendChild(s); }); }
function strToUint8(s){ return new TextEncoder().encode(s); }
function dataURLtoUint8(dataUrl){ const [,b64]=dataUrl.split(','); const bin=atob(b64); const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return bytes; }

// =========================
// Toasts + Progress modal
// =========================
function toast(msg, ms=2000){
  let host = $("#toasts");
  if(!host){
    host = document.createElement("div");
    host.id = "toasts";
    host.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:20px;display:grid;gap:8px;z-index:22000";
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = "background:#111826cc;border:1px solid #2a3243;color:#e8ecf3;padding:10px 12px;border-radius:10px;backdrop-filter:blur(8px)";
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .25s"; setTimeout(()=>host.removeChild(t),250); }, ms);
}
let progEl=null;
function progressOpen(title="Working…"){
  if(progEl) return;
  progEl = document.createElement("div");
  progEl.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:21000;display:grid;place-items:center">
      <div style="width:min(520px,92vw);background:#151a22;border:1px solid #2a3243;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:16px" id="progTitle">${title}</strong>
          <button id="xProg" style="border:1px solid #2a3243;background:#0f1420;color:#e8ecf3;border-radius:10px;padding:6px 10px">Hide</button>
        </div>
        <div id="progStep" style="color:#9aa6bd;margin-bottom:8px">Preparing…</div>
        <div style="height:10px;background:#0f1420;border:1px solid #2a3243;border-radius:999px;overflow:hidden">
          <div id="progBar" style="height:100%;width:0%;background:linear-gradient(90deg,#6aa1ff,#87b4ff)"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(progEl);
  $("#xProg").onclick = ()=>{ progEl.style.display="none"; };
}
function progressUpdate(step, ratio){
  if(!progEl) return;
  const s = $("#progStep", progEl);
  const b = $("#progBar", progEl);
  if(s) s.textContent = step;
  if(b && typeof ratio==="number") b.style.width = Math.round(ratio*100)+"%";
}
function progressClose(){ if(!progEl) return; progEl.remove(); progEl=null; }

// =========================
// Data model & state
// =========================
const defaultMeta = ()=>({ lens:"50mm", shotType:"MS", movements:[], transition:"Cut", dialogue:"", notes:"", voiceNote:null });
const makeShot = ({type="image", src="", filename="shot", meta}={})=>({ id:uid("s_"), type, src, filename, meta:meta||defaultMeta() });

const state = {
  projectName: "",
  scenes: [],             // [{id,name,shots:[Shot|null]}]
  currentProjectId: null,
  editRef: null,
  pendingReplace: null,
  flatIndex: []
};

// =========================
// IndexedDB (projects)
// =========================
const DB_NAME="sb_vault", DB_VER=1, STORE="projects";
function openDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open(DB_NAME,DB_VER); r.onupgradeneeded=()=>{ const db=r.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:"id"}); }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function dbPut(record){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(record); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });}
async function dbGet(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const q=tx.objectStore(STORE).get(id); q.onsuccess=()=>res(q.result||null); q.onerror=()=>rej(q.error); });}
async function dbDelete(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });}
async function dbList(){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const q=tx.objectStore(STORE).getAll(); q.onsuccess=()=>{ const arr=q.result||[]; arr.sort((a,b)=> (b.updatedAt||0)-(a.updatedAt||0)); res(arr); }; q.onerror=()=>rej(q.error); });}

function emptyProjectRecord(id, name){
  return {
    id, name, createdAt:Date.now(), updatedAt:Date.now(), cover:null,
    data:{ projectName:name, scenes:[ { id:uid("sc_"), name:"Scene 1", shots:[ null ] } ] }
  };
}

// =========================
// Element refs (match index.html)
// =========================
const homeBtn        = $("#homeBtn");
const menuBtn        = $("#menuBtn");
const sheet          = $("#sheet");
const closeSheetBtn  = $("#closeSheet");
const addSceneBtn    = $("#addSceneBtn");
const addShotsBtn    = $("#addShotsBtn");
const switchProjectBtn = $("#switchProjectBtn");
const renderFilmBtn  = $("#renderFilmBtn");
const importBtn      = $("#importBtn");
const exportBtn      = $("#exportBtn");
const clearBtn       = $("#clearBtn");
const projectNameInp = $("#projectName");

const viewToggle     = $("#viewToggle");
const comicView      = $("#comicView");
const scenesWrap     = $("#scenes");
const boardView      = $("#boardView");
const dropzone       = $("#dropzone");
const gallery        = $("#gallery");

/* Present ▾ dropdown elements */
const playToggle   = $("#playToggle");
const playMenu     = $("#playMenu");
const menuPresent  = $("#menuPresent");
const menuPlay     = $("#menuPlay");

const editor         = $("#editor");
const editorTitle    = $("#editorTitle");
const closeEditor    = $("#closeEditor");
const edLens         = $("#edLens");
const edShotType     = $("#edShotType");
const edTransition   = $("#edTransition");
const edMoves        = $("#edMoves");
const edDialogue     = $("#edDialogue");
const edNotes        = $("#edNotes");
const recBtn         = $("#recBtn");
const playNoteBtn    = $("#playNoteBtn");
const recStatus      = $("#recStatus");
const edReplace      = $("#edReplace");
const edDelete       = $("#edDelete");

const transPicker    = $("#transPicker");
const transOptions   = $("#transOptions");
const closeTrans     = $("#closeTrans");

const player         = $("#player");
const stage          = player?.querySelector(".stage");
const stageMedia     = player?.querySelector(".stage-media");
const ovTL           = $("#ovTopLeft");
const ovTR           = $("#ovTopRight");
const ovB            = $("#ovBottom");
const prevBtn        = $("#prevBtn");
const nextBtn        = $("#nextBtn");
const fsBtn          = $("#fsBtn");
const closePlayer    = $("#closePlayer");

/* Timeline (auto movie mode) */
const timeline = $("#timeline");
const tlFill   = $("#tlFill");

const fileMulti      = $("#fileMulti");
const fileSingle     = $("#fileSingle");
const importFile     = $("#importFile");

// --- Project Picker (injected, scrollable) ---
let picker = $("#picker");
if(!picker){
  picker = document.createElement("div");
  picker.id = "picker";
  picker.innerHTML = `
    <div class="picker-header" style="position:sticky;top:0;padding:12px 14px;background:rgba(12,16,22,.9);border-bottom:1px solid #2a3243;backdrop-filter:blur(10px);display:flex;justify-content:space-between;align-items:center">
      <strong>Projects</strong>
      <div>
        <button id="newProjBtn" class="seg">New</button>
        <button id="importProjBtn" class="seg">Import JSON</button>
      </div>
    </div>
    <div class="picker-scroll"><div id="pickerGrid" class="picker-grid"></div></div>
    <input id="pickerImport" type="file" accept="application/json" hidden />
  `;
  document.body.appendChild(picker);
}
const pickerGrid = $("#pickerGrid", picker);
const newProjBtn = $("#newProjBtn", picker);
const importProjBtn = $("#importProjBtn", picker);
const pickerImport = $("#pickerImport", picker);

// =========================
// Init
// =========================
bindUI();
boot();

// =========================
// Bindings
// =========================
function bindUI(){
  on(homeBtn, "click", showPicker);

  // Menu sheet
  on(menuBtn, "click", ()=> openSheet(sheet));
  on(sheet, "click", e=>{ if(e.target.classList.contains("sheet-backdrop")) closeSheet(sheet); });
  on(closeSheetBtn,"click", ()=> closeSheet(sheet));

  on(addSceneBtn,"click", ()=>{ addScene(); renderAll(); persistDebounced(); closeSheet(sheet); });
  on(addShotsBtn,"click", ()=>{ state.pendingReplace=null; fileMulti?.click(); });
  on(switchProjectBtn,"click", ()=>{ closeSheet(sheet); showPicker(); });

  on(renderFilmBtn, "click", async ()=>{ closeSheet(sheet); await exportFilmSmart(); });
  on(importBtn, ()=> importFile?.click());
  on(exportBtn, exportJSONCurrent);
  on(clearBtn, clearAll);
  on(projectNameInp,"input", ()=>{ state.projectName=projectNameInp.value.trim(); persistDebounced(); });

  // Views
  on(viewToggle,"click", ()=>{
    const showBoard = comicView.classList.contains("hidden") ? false : true;
    if(showBoard){
      comicView.classList.add("hidden");
      boardView.classList.remove("hidden");
      viewToggle.textContent = "Board ▾";
      buildGallery();
    }else{
      boardView.classList.add("hidden");
      comicView.classList.remove("hidden");
      viewToggle.textContent = "Comic ▾";
    }
  });

  // Dropzone
  on(dropzone,"click", ()=>{ state.pendingReplace=null; fileMulti?.click(); });
  on(dropzone,"keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); dropzone.click(); }});
  ["dragenter","dragover"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave","drop"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.remove("dragover"); }));
  on(dropzone,"drop", e=>{ const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

  // Files
  on(fileMulti,"change", e=> addFilesToScene(e.target.files));
  on(fileSingle,"change", e=> replaceSingle(e.target.files?.[0]||null));
  on(importFile,"change", e=> importProjectJSON(e.target.files?.[0]||null));

  // Editor
  on(editor,"click", e=>{ if(e.target.classList.contains("sheet-backdrop")) closeSheet(editor); });
  on(closeEditor,"click", ()=> closeSheet(editor));
  on(edLens,"change", saveEditor);
  on(edShotType,"change", saveEditor);
  on(edTransition,"change", saveEditor);
  on(edDialogue,"input", saveEditor);
  on(edNotes,"input", saveEditor);
  if(edMoves && !edMoves.dataset._init){
    ["Pan","Tilt","Zoom","Dolly","Truck","Pedestal","Handheld","Static","Rack Focus"].forEach(m=>{
      const b=document.createElement("button"); b.type="button"; b.className="tag"; b.textContent=m; b.dataset.mov=m;
      b.onclick=()=>{ b.classList.toggle("active"); saveEditor(); };
      edMoves.appendChild(b);
    });
    edMoves.dataset._init="1";
  }
  // Replace/Delete from editor
  on(edReplace,"click", ()=>{
    if(!state.editRef) return;
    state.pendingReplace={sceneId:state.editRef.sceneId, shotId:state.editRef.shotId};
    fileSingle?.click();
  });
  on(edDelete,"click", ()=>{
    if(!state.editRef) return;
    const {sceneId, shotId} = state.editRef;
    deleteShot(sceneId, shotId);
    closeSheet(editor);
    toast("Shot deleted");
  });

  // Voice notes
  on(recBtn,"click", toggleRecord);
  on(playNoteBtn,"click", playVoiceNote);

  // Transition picker
  on(transPicker,"click", e=>{ if(e.target.classList.contains("sheet-backdrop")) closeSheet(transPicker); });
  on(closeTrans,"click", ()=> closeSheet(transPicker));
  if(transOptions && !transOptions.dataset._init){
    ["Cut","Dissolve","Fade","Wipe","Match Cut","Whip Pan","J-Cut","L-Cut"].forEach(t=>{
      const b=document.createElement("button"); b.className="tag"; b.textContent=t;
      b.onclick=()=>{ if(_transTarget) setShotMeta(_transTarget,{transition:t}); closeSheet(transPicker); };
      transOptions.appendChild(b);
    });
    transOptions.dataset._init="1";
  }

  // Legacy Present button (if still in HTML)
  const presentBtn = $("#presentBtn");
  on(presentBtn, "click", openPresentation);

  // Present ▾ dropdown
  on(playToggle, "click", ()=>{
    if(!playMenu) return;
    const open = playMenu.classList.contains("hidden");
    document.querySelectorAll(".dropdown").forEach(d=>d.classList.add("hidden"));
    playMenu.classList.toggle("hidden", !open);
    playToggle.setAttribute("aria-expanded", String(open));
  });
  on(document, "click", (e)=>{
    if(!e.target.closest("#playToggle") && !e.target.closest("#playMenu")){
      playMenu?.classList.add("hidden");
      playToggle?.setAttribute("aria-expanded","false");
    }
  });
  on(menuPresent, "click", ()=>{
    playMenu?.classList.add("hidden");
    openPresentation(); // manual mode
  });
  on(menuPlay, "click", ()=>{
    playMenu?.classList.add("hidden");
    startAutoPlay();   // auto slideshow
  });

  // Player UI — make handlers robust
  on(prevBtn, "click", (e)=>{ e.stopPropagation(); showAt(curIdx-1); });
  on(nextBtn, "click", (e)=>{ e.stopPropagation(); showAt(curIdx+1); });
  on(fsBtn,   "click", async (e)=>{ e.stopPropagation();
    if(document.fullscreenElement){ await document.exitFullscreen?.(); }
    else { await goFullscreen(player); }
  });
  on(closePlayer, "click", (e)=>{ e.stopPropagation(); closePresentation(); });

  on(stage,"click", ()=>{
    const v = stageMedia?.firstElementChild;
    if(v && v.tagName==="VIDEO" && !v.controls){ if(v.paused) v.play().catch(()=>{}); else v.pause(); }
  });
  document.addEventListener("keydown", e=>{
    if(!player?.classList.contains("open")) return;
    if(e.key==="ArrowRight") showAt(curIdx+1);
    if(e.key==="ArrowLeft") showAt(curIdx-1);
    if(e.key==="Escape") closePresentation();
  });

  // Picker
  on(newProjBtn,"click", async ()=>{
    const id = uid("p_"); const rec = emptyProjectRecord(id, "Untitled");
    await dbPut(rec); await openProject(id); hidePicker();
  });
  on(importProjBtn,"click", ()=> pickerImport.click());
  on(pickerImport,"change", async e=>{
    const file=e.target.files?.[0]; if(!file) return;
    try{
      const data = JSON.parse(await file.text());
      if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
      const id=uid("p_"); const name=data.projectName||"Imported";
      const rec={ id, name, createdAt:Date.now(), updatedAt:Date.now(), cover:firstCoverFrom(data)||null, data };
      await dbPut(rec); await openProject(id); hidePicker();
    }catch(err){ alert("Import failed: "+err.message); }
    pickerImport.value="";
  });
}

// =========================
// Boot / Picker
// =========================
async function boot(){
  const m = location.hash.match(/#p\/([\w\-]+)/);
  if(m && await dbGet(m[1])){ await openProject(m[1]); return; }
  await showPicker();
}

async function showPicker(){
  const items = await dbList();
  pickerGrid.innerHTML = items.length? "" : `<div class="muted">No projects yet — tap “New”.</div>`;
  for(const it of items){
    const card=document.createElement("div");
    card.style.cssText="border:1px solid #2a3243;border-radius:14px;overflow:hidden;background:#151a22";
    card.innerHTML=`
      <div style="background:#0b0e13;aspect-ratio:16/9;display:grid;place-items:center;overflow:hidden">
        ${ it.cover ? `<img src="${it.cover}" style="width:100%;height:100%;object-fit:cover">` : `<div class="muted">No cover</div>` }
      </div>
      <div style="padding:10px 12px;display:grid;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}</strong>
          <button class="small-btn open">Open</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          <button class="small-btn rename">Rename</button>
          <button class="small-btn dup">Duplicate</button>
          <button class="small-btn export">Export JSON</button>
          <button class="small-btn danger del">Delete</button>
        </div>
      </div>`;
    pickerGrid.appendChild(card);
    card.querySelector(".open").onclick = async()=>{ await openProject(it.id); hidePicker(); };
    card.querySelector(".rename").onclick = async()=>{ const nn=prompt("Rename project:", it.name); if(!nn) return; it.name=nn; it.updatedAt=Date.now(); await dbPut(it); showPicker(); };
    card.querySelector(".dup").onclick = async()=>{ const id2=uid("p_"); const rec=JSON.parse(JSON.stringify(it)); rec.id=id2; rec.name=it.name+" (copy)"; rec.createdAt=Date.now(); rec.updatedAt=Date.now(); await dbPut(rec); showPicker(); };
    card.querySelector(".export").onclick = ()=> downloadBlob(JSON.stringify(it.data,null,2), sanitize(it.name)+".json", "application/json");
    card.querySelector(".del").onclick = async()=>{ if(confirm(`Delete “${it.name}”?`)){ await dbDelete(it.id); showPicker(); } };
  }
  picker.classList.add("open");
  document.body.classList.add("sheet-open");
}
function hidePicker(){ picker.classList.remove("open"); document.body.classList.remove("sheet-open"); }

// =========================
/* Present helpers */
// =========================
async function goFullscreen(target = player){
  try{
    if(document.fullscreenElement) return true;
    if(target?.requestFullscreen){ await target.requestFullscreen(); return true; }
  }catch{}
  try{
    // iOS best-effort fallback: enter video fullscreen if available
    const v = target?.querySelector?.("video");
    if(v && v.webkitEnterFullscreen){ v.webkitEnterFullscreen(); return true; }
  }catch{}
  return false;
}

// =========================
// Persist
// =========================
async function openProject(id){
  const rec = await dbGet(id);
  if(!rec){ alert("Project not found."); return; }
  state.currentProjectId = id;
  state.projectName = rec.data.projectName || rec.name || "Untitled";
  state.scenes = Array.isArray(rec.data.scenes) ? rec.data.scenes : [];
  if(state.scenes.length===0){ state.scenes.push({id:uid("sc_"), name:"Scene 1", shots:[null]}); await persistProject(); }
  location.hash = "#p/"+id;
  renderAll();
}
async function persistProject(){
  if(!state.currentProjectId) return;
  const id = state.currentProjectId;
  const rec = await dbGet(id) || emptyProjectRecord(id, state.projectName||"Untitled");
  rec.name = state.projectName || rec.name;
  rec.updatedAt = Date.now();
  rec.data = { projectName: state.projectName, scenes: state.scenes };
  rec.cover = firstCoverFrom(rec.data) || rec.cover || null;
  await dbPut(rec);
}
const persistDebounced = debounce(persistProject, 500);
function firstCoverFrom(data){ for(const s of (data.scenes||[])){ for(const sh of s.shots||[]){ if(sh && (sh.type==="image"||sh.type==="video")) return sh.src; } } return null; }

// =========================
// Scenes / Shots
// =========================
function addScene(){ const idx=state.scenes.length+1; state.scenes.push({id:uid("sc_"), name:`Scene ${idx}`, shots:[null]}); }
function ensureTrailingEmpty(scene){ if(scene.shots.length===0 || scene.shots[scene.shots.length-1]!==null) scene.shots.push(null); }
function getScene(id){ return state.scenes.find(s=>s.id===id); }
function getShot(sceneId, shotId){ return getScene(sceneId)?.shots.find(s=>s && s.id===shotId) || null; }

async function addFilesToScene(fileList){
  const files=[...fileList].filter(f=>/^image\/|^video\//.test(f.type)); if(files.length===0) return;
  const target = state.pendingReplace ? getScene(state.pendingReplace.sceneId) : state.scenes[state.scenes.length-1] || (addScene(), state.scenes[0]);
  for(const f of files){
    const dataUrl = await fileToDataURL(f);
    const shot = makeShot({ type:f.type.startsWith("video")?"video":"image", src:dataUrl, filename:f.name||"shot" });
    const emptyIdx = target.shots.findIndex(s=>s===null);
    if(emptyIdx>=0) target.shots[emptyIdx]=shot; else target.shots.push(shot);
    ensureTrailingEmpty(target);
  }
  state.pendingReplace=null; renderAll(); persistDebounced(); if(fileMulti) fileMulti.value="";
}
async function replaceSingle(file){
  if(!file){ if(fileSingle) fileSingle.value=""; return; }
  const dataUrl = await fileToDataURL(file);
  if(state.pendingReplace && state.pendingReplace.shotId && state.pendingReplace.shotId!=="__empty__"){
    const {sceneId, shotId} = state.pendingReplace;
    const sc=getScene(sceneId); const idx=sc?.shots.findIndex(s=>s&&s.id===shotId);
    if(idx>=0){ sc.shots[idx]=makeShot({ type:file.type.startsWith("video")?"video":"image", src=dataUrl, filename:file.name||"shot" }); ensureTrailingEmpty(sc); }
  }else{
    await addFilesToScene([file]);
  }
  state.pendingReplace=null; renderAll(); persistDebounced(); if(fileSingle) fileSingle.value="";
}
function deleteShot(sceneId, shotId){
  const sc=getScene(sceneId); if(!sc) return; const idx=sc.shots.findIndex(s=>s&&s.id===shotId);
  if(idx>=0) sc.shots.splice(idx,1);
  ensureTrailingEmpty(sc); renderAll(); persistDebounced();
}

// =========================
// Render — Comic
// =========================
function renderAll(){
  scenesWrap.innerHTML="";
  state.scenes.forEach(scene=>{ ensureTrailingEmpty(scene); scenesWrap.appendChild(renderScene(scene)); });
  projectNameInp.value = state.projectName||"";
  if(!boardView.classList.contains("hidden")) buildGallery();
}
let _transTarget=null;
function renderScene(scene){
  const wrap=div("scene");
  const head=div("scene-head");
  const title=div("scene-title", scene.name); title.contentEditable="true"; title.spellcheck=false;
  on(title,"input", debounce(()=>{ scene.name=(title.textContent||"").trim()||scene.name; persistDebounced(); },250));
  head.appendChild(title);
  const actions=div("scene-actions");
  actions.appendChild(smallBtn("📥 Shots", ()=>{ state.pendingReplace=null; fileMulti?.click(); }));
  head.appendChild(actions); wrap.appendChild(head);

  const strip=div("strip");
  scene.shots.forEach((shot,idx)=>{
    if(shot){
      strip.appendChild(renderShot(scene,shot));
      if(idx<scene.shots.length-1){
        const chip=div("trans-chip"); const b=document.createElement("button"); b.textContent=shot.meta?.transition||"Cut";
        b.onclick=()=>{ _transTarget=shot.id; openSheet(transPicker); }; chip.appendChild(b); strip.appendChild(chip);
      }
    }else{
      const card=div("shot empty");
      card.innerHTML=`<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
      card.onclick=()=>{ state.pendingReplace={sceneId:scene.id, shotId:"__empty__"}; fileSingle?.click(); };
      strip.appendChild(card);
    }
  });
  wrap.appendChild(strip);
  return wrap;
}
function renderShot(scene, shot){
  const card=div("shot"); card.draggable=true;
  const t=div("thumb");
  if(shot.type==="image"){ const img=new Image(); img.src=shot.src; img.alt=shot.filename; t.appendChild(img); }
  else { const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; v.muted=true; v.controls=false; on(v,"mouseenter",()=>v.play().catch(()=>{})); on(v,"mouseleave",()=>v.pause()); t.appendChild(v); }
  const badge=div("badge", shot.type.toUpperCase()); t.appendChild(badge);

  const meta=div("meta"); meta.innerHTML=`<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;
  const overlay=div("overlay-info"); overlay.textContent= shot.meta.dialogue || shot.meta.notes || `${shot.meta.lens} · ${shot.meta.shotType}`;
  card.appendChild(t); card.appendChild(meta); card.appendChild(overlay);

  card.onclick=(e)=>{ if(e.target.closest(".meta")){ card.classList.toggle("show-info"); return; } openEditor(scene.id, shot.id); };

  longPress(card,450, async ()=>{
    const opt = await mobilePrompt(["Replace","Duplicate","Delete","Cancel"]);
    if(opt==="Replace"){ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle?.click(); }
    else if(opt==="Duplicate"){ const sc=getScene(scene.id); const idx=sc.shots.findIndex(s=>s&&s.id===shot.id); sc.shots.splice(idx+1,0, JSON.parse(JSON.stringify(shot))); ensureTrailingEmpty(sc); renderAll(); persistDebounced(); }
    else if(opt==="Delete"){ deleteShot(scene.id, shot.id); }
  });

  // Reorder within scene
  card.addEventListener("dragstart", e=>{
    e.dataTransfer.setData("text/plain", JSON.stringify({sceneId:scene.id, shotId:shot.id}));
    setTimeout(()=> card.classList.add("dragging"),0);
  });
  card.addEventListener("dragend", ()=> card.classList.remove("dragging"));
  card.addEventListener("drop", e=>{
    e.preventDefault();
    const data=JSON.parse(e.dataTransfer.getData("text/plain")||"{}");
    if(data.sceneId!==scene.id) return;
    const arr=scene.shots.filter(s=>s!==null);
    const from=arr.findIndex(s=>s.id===data.shotId);
    const to=arr.findIndex(s=>s.id===shot.id);
    if(from<0||to<0) return;
    const [item]=arr.splice(from,1); arr.splice(to,0,item);
    const newShots=[], iter=[...arr]; scene.shots.forEach(s=> newShots.push(s===null?null:iter.shift()));
    scene.shots=newShots; renderAll(); persistDebounced();
  });

  return card;
}

// =========================
// Board view
// =========================
function buildGallery(){
  gallery.innerHTML="";
  state.scenes.forEach(scene=>{
    scene.shots.filter(Boolean).forEach(shot=>{
      const wrap=div("gallery-item");
      const media=div("gallery-media");
      if(shot.type==="image"){ const img=new Image(); img.src=shot.src; media.appendChild(img); }
      else { const v=document.createElement("video"); v.src=shot.src; v.controls=true; v.playsInline=true; v.style.width="100%"; v.style.height="auto"; v.style.objectFit="contain"; media.appendChild(v); }
      wrap.appendChild(media);

      const meta=div("gallery-meta");
      meta.innerHTML = `<div><strong>${esc(scene.name)}</strong> — ${esc(shot.filename)}</div>`;
      const actions=document.createElement("div"); actions.style.display="flex"; actions.style.gap="6px"; actions.style.marginTop="8px";
      const editBtn=document.createElement("button"); editBtn.className="small-btn"; editBtn.textContent="Edit details"; editBtn.onclick=()=>openEditor(scene.id, shot.id);
      const repBtn=document.createElement("button"); repBtn.className="small-btn"; repBtn.textContent="Replace"; repBtn.onclick=()=>{ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle?.click(); };
      const delBtn=document.createElement("button"); delBtn.className="small-btn danger"; delBtn.textContent="Delete"; delBtn.onclick=()=> deleteShot(scene.id, shot.id);
      actions.append(editBtn,repBtn,delBtn); meta.appendChild(actions);

      wrap.appendChild(meta); gallery.appendChild(wrap);
    });
  });
}

// =========================
// Editor
// =========================
function openEditor(sceneId, shotId){
  state.editRef={sceneId, shotId};
  const shot=getShot(sceneId, shotId); if(!shot) return;
  editorTitle.textContent=`Edit • ${shot.filename}`;
  edLens.value=shot.meta.lens||"50mm";
  edShotType.value=shot.meta.shotType||"MS";
  edTransition.value=shot.meta.transition||"Cut";
  edDialogue.value=shot.meta.dialogue||"";
  edNotes.value=shot.meta.notes||"";
  [...edMoves.querySelectorAll(".tag")].forEach(b=> b.classList.toggle("active", !!shot.meta.movements?.includes(b.dataset.mov)));
  if(shot.meta.voiceNote){ recStatus.textContent=`Voice note • ${formatTime(shot.meta.voiceNote.duration)}`; playNoteBtn.disabled=false; }
  else { recStatus.textContent="No voice note"; playNoteBtn.disabled=true; }
  openSheet(editor);
}
function saveEditor(){
  const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
  shot.meta.lens=edLens.value; shot.meta.shotType=edShotType.value; shot.meta.transition=edTransition.value;
  shot.meta.dialogue=edDialogue.value; shot.meta.notes=edNotes.value;
  shot.meta.movements=[...edMoves.querySelectorAll(".tag.active")].map(b=>b.dataset.mov);
  persistDebounced(); renderAll();
}
let mediaRec=null, recChunks=[], recStart=0;
async function toggleRecord(){
  const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
  if(mediaRec && mediaRec.state==="recording"){ mediaRec.stop(); return; }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    recChunks=[]; mediaRec=new MediaRecorder(stream);
    mediaRec.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
    mediaRec.onstart=()=>{ recStart=Date.now(); recStatus.textContent="Recording… tap to stop"; recBtn.textContent="⏹ Stop"; };
    mediaRec.onstop=async ()=>{
      const blob=new Blob(recChunks,{type:mediaRec.mimeType||"audio/webm"});
      const dataUrl=await blobToDataURL(blob); const dur=(Date.now()-recStart)/1000;
      shot.meta.voiceNote={ dataUrl, duration:dur, mime:blob.type };
      recStatus.textContent=`Saved • ${formatTime(dur)}`; playNoteBtn.disabled=false; recBtn.textContent="🎙 Record"; persistDebounced();
    };
    mediaRec.start();
  }catch(err){ alert("Mic access failed: "+err.message); }
}
function blobToDataURL(blob){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(blob); }); }
function playVoiceNote(){ const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot?.meta.voiceNote) return; new Audio(shot.meta.voiceNote.dataUrl).play().catch(()=>{}); }
function setShotMeta(shotId, patch){ state.scenes.forEach(s=> s.shots.forEach(sh=>{ if(sh && sh.id===shotId) Object.assign(sh.meta, patch); })); persistDebounced(); renderAll(); }

// =========================
// Presentation (manual)
// =========================
let curIdx=0;
function openPresentation(){
  state.flatIndex=flattenShots(); if(state.flatIndex.length===0) return;
  curIdx=0; player.classList.add("open"); player.classList.remove("auto");
  player.setAttribute("aria-hidden","false");
  prevBtn.disabled=false; nextBtn.disabled=false;
  if(tlFill) tlFill.style.width="0%";
  showAt(0);
}
function closePresentation(){
  player.classList.remove("open","auto");
  player.setAttribute("aria-hidden","true");
  stageMedia.innerHTML="";
  stopAutoPlay();
  prevBtn.disabled=false; nextBtn.disabled=false;
  if(tlFill) tlFill.style.width="0%";
}
function flattenShots(){ const arr=[]; state.scenes.forEach(s=> s.shots.filter(Boolean).forEach(sh=> arr.push({scene:s, shot:sh}))); return arr; }
function showAt(i){
  const n=state.flatIndex.length; curIdx=(i%n + n)%n;
  const {scene, shot}=state.flatIndex[curIdx];
  stageMedia.innerHTML="";
  let el;
  if(shot.type==="image"){ el=new Image(); el.src=shot.src; el.alt=shot.filename; }
  else { el=document.createElement("video"); el.src=shot.src; el.autoplay=true; el.loop=false; el.muted=false; el.controls=false; el.setAttribute("playsinline",""); el.setAttribute("webkit-playsinline",""); el.style.width="100%"; el.style.height="100%"; el.style.objectFit="contain"; const resume=()=>{ el.play().catch(()=>{}); stage.removeEventListener("click", resume); }; el.addEventListener("loadeddata", ()=> el.play().catch(()=>{}), {once:true}); stage.addEventListener("click", resume, {once:true}); }
  stageMedia.appendChild(el);
  ovTL.textContent=scene.name;
  ovTR.textContent=`${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
  ovB.textContent=shot.meta.dialogue || shot.meta.notes || "";
}

// =========================
// Auto‑play slideshow (“Play movie”) with timeline + fullscreen
// =========================
let autoTimer = null;
let autoAudio = null;
let autoAbort = false;
let tlInterval = null;
let segStart = 0, segDur = 0, durations = [], totalDur = 0, elapsedBeforeSeg = 0;

function stopAutoPlay(){
  autoAbort = true;
  if(autoTimer){ clearTimeout(autoTimer); autoTimer=null; }
  if(autoAudio){ try{ autoAudio.pause(); }catch{} autoAudio=null; }
  if(tlInterval){ clearInterval(tlInterval); tlInterval=null; }
}

function getVideoDuration(src){
  return new Promise(resolve=>{
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = src;
    v.onloadedmetadata = ()=> resolve(Number.isFinite(v.duration) ? Math.min(7, v.duration) : 7);
    v.onerror = ()=> resolve(7);
  });
}

async function computeDurations(seq){
  return Promise.all(seq.map(({shot})=>{
    if(shot.type==="image"){
      return Math.max(7, shot.meta.voiceNote?.duration || 0);
    }else{
      return getVideoDuration(shot.src); // cap at 7s for consistency
    }
  }));
}
function startTimelineWatcher(){
  if(!tlFill) return;
  if(tlInterval) clearInterval(tlInterval);
  tlInterval = setInterval(()=>{
    const now = performance.now();
    const segElapsed = Math.min((now - segStart)/1000, segDur);
    const elapsed = elapsedBeforeSeg + segElapsed;
    const ratio = totalDur ? Math.max(0, Math.min(1, elapsed / totalDur)) : 0;
    tlFill.style.width = (ratio*100).toFixed(2) + "%";
  }, 150);
}

function startAutoPlay(){
  const seq = flattenShots();
  if(seq.length===0){ toast("Add shots first"); return; }

  player.classList.add("open","auto");
  player.setAttribute("aria-hidden","false");
  prevBtn.disabled = true; nextBtn.disabled = true;

  (async ()=>{
    durations = await computeDurations(seq);
    totalDur = durations.reduce((a,b)=> a+b, 0);
    elapsedBeforeSeg = 0;
    tlFill && (tlFill.style.width="0%");

    // try fullscreen (desktop); iOS may need video element later
    goFullscreen(player);

    autoAbort = false;
    let i = 0;

    const playStep = async () => {
      if(autoAbort){ return; }
      if(i >= seq.length){ closePresentation(); return; }

      const {scene, shot} = seq[i];
      segDur = durations[i] || 7;
      segStart = performance.now();
      startTimelineWatcher();

      stageMedia.innerHTML = "";
      if(autoAudio){ try{ autoAudio.pause(); }catch{} autoAudio=null; }

      ovTL.textContent = scene.name;
      ovTR.textContent = `${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
      ovB.textContent  = shot.meta.dialogue || shot.meta.notes || "";

      if(shot.type === "image"){
        const img = new Image(); img.src = shot.src;
        stageMedia.appendChild(img);

        if(shot.meta.voiceNote?.dataUrl){
          autoAudio = new Audio(shot.meta.voiceNote.dataUrl);
          autoAudio.play().catch(()=>{});
        }
        autoTimer = setTimeout(()=>{ 
          elapsedBeforeSeg += segDur; 
          i++; playStep(); 
        }, segDur*1000);

      }else{
        const v = document.createElement("video");
        v.src = shot.src;
        v.autoplay = true; v.controls = false; v.muted = false;
        v.playsInline = true; v.setAttribute("playsinline",""); v.setAttribute("webkit-playsinline","");
        v.style.width="100%"; v.style.height="100%"; v.style.objectFit="cover"; // fill screen
        stageMedia.appendChild(v);

        // iOS fallback: once a video exists, try video fullscreen
        goFullscreen(v);

        let advanced = false;
        const advance = ()=>{ if(advanced) return; advanced=true;
          elapsedBeforeSeg += segDur; i++; playStep();
        };
        v.onended = advance;
        v.addEventListener("loadeddata", ()=> v.play().catch(()=>{}), { once:true });

        autoTimer = setTimeout(advance, segDur*1000); // safety cap
      }
    };

    const origClose = closePlayer.onclick;
    closePlayer.onclick = ()=>{ stopAutoPlay(); closePresentation(); closePlayer.onclick = origClose; };

    playStep();
  })();
}

// =========================
// Export — MP4 via ffmpeg (CDN) with audio mix; WebM fallback
// =========================
let ffmpeg=null;
async function ensureFFmpeg(){
  if(ffmpeg) return true;
  try{
    await importScript("https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js");
    const { createFFmpeg } = window.FFmpeg;
    ffmpeg = createFFmpeg({
      log:false,
      corePath: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js"
    });
    ffmpeg.setProgress(({ratio})=> progressUpdate("Encoding…", ratio||0));
    progressOpen("Loading encoder…");
    await ffmpeg.load();
    progressClose();
    return true;
  }catch(e){
    console.warn("ffmpeg load failed", e);
    toast("Couldn’t load MP4 encoder — falling back to WebM.");
    progressClose();
    return false;
  }
}
async function exportFilmSmart(){ toast("Export started"); if(await ensureFFmpeg()){ await exportFilmMP4(); } else { await exportFilmWebM(); } }

async function exportFilmMP4(){
  const flat=flattenShots(); if(flat.length===0){ toast("Add shots first"); return; }
  progressOpen("Exporting MP4…"); progressUpdate("Preparing parts…", 0);

  const width=1280, height=720, fps=30; let idx=0; const parts=[];
  for(const {shot} of flat){
    idx++;
    if(shot.type==="image"){
      const imgName=`img_${idx}.jpg`; ffmpeg.FS('writeFile', imgName, dataURLtoUint8(shot.src));
      const dur=Math.max(7, shot.meta.voiceNote?.duration || 0); const out=`part_${idx}.mp4`;
      progressUpdate(`Image ${idx}: rendering ${dur.toFixed(1)}s`, 0.05);
      await ffmpeg.run('-loop','1','-t',String(dur),'-i',imgName,'-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-r',String(fps),'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline','-an',out);
      parts.push(out);
    }else{
      const inName=`clip_${idx}.mp4`; ffmpeg.FS('writeFile', inName, dataURLtoUint8(shot.src));
      const out=`part_${idx}.mp4`;
      progressUpdate(`Video ${idx}: re-encoding picture`, 0.05);
      await ffmpeg.run('-i',inName,'-t','7','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-r',String(fps),'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline','-an',out);
      parts.push(out);
    }
  }
  progressUpdate("Concatenating picture…", 0.2);
  const listTxt = parts.map(p=>`file '${p}'`).join('\n'); ffmpeg.FS('writeFile','concat.txt', strToUint8(listTxt));
  await ffmpeg.run('-f','concat','-safe','0','-i','concat.txt','-c','copy','temp_video.mp4');

  progressUpdate("Mixing audio…", 0.5);
  const wavBytes = await buildFullAudioTrack(flat);
  if(wavBytes){
    ffmpeg.FS('writeFile','audio.wav', wavBytes);
    progressUpdate("Muxing MP4…", 0.8);
    await ffmpeg.run('-i','temp_video.mp4','-i','audio.wav','-c:v','copy','-c:a','aac','-shortest','out.mp4');
  }else{
    await ffmpeg.run('-i','temp_video.mp4','-c','copy','out.mp4');
  }

  const mp4 = ffmpeg.FS('readFile','out.mp4');
  progressUpdate("Finalizing…", 0.95);

  const fileName=(sanitize(state.projectName)||"storyboard")+"_film.mp4";
  const blob=new Blob([mp4.buffer], {type:'video/mp4'});

  try{
    if(navigator.canShare && navigator.canShare({ files:[new File([blob], fileName, {type:'video/mp4'})] })){
      await navigator.share({ files:[new File([blob], fileName, {type:'video/mp4'})], title:fileName, text:'Storyboard export' });
      toast("Shared — choose “Save Video” to add to Photos");
    }else{
      downloadBlob(blob, fileName, 'video/mp4');
      toast("Downloaded MP4 — Share → Save Video");
    }
  }catch{
    downloadBlob(blob, fileName, 'video/mp4');
    toast("Downloaded MP4 — Share → Save Video");
  }finally{
    progressClose();
  }
}

// Build one WAV track: voice notes for images + original audio of each video (trimmed to 7s)
async function buildFullAudioTrack(flat){
  const sr=48000;
  let total=0; for(const {shot} of flat){ total += (shot.type==="image") ? Math.max(7, shot.meta.voiceNote?.duration||0) : 7; }
  if(total<=0) return null;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext; if(!Offline) return null;
  const ctx = new Offline(2, Math.ceil(total*sr), sr);
  let t=0;
  for(const {shot} of flat){
    const dur=(shot.type==="image") ? Math.max(7, shot.meta.voiceNote?.duration||0) : 7;

    // voice note
    if(shot.type==="image" && shot.meta.voiceNote?.dataUrl){
      try{
        const ab=await fetch(shot.meta.voiceNote.dataUrl).then(r=>r.arrayBuffer());
        const buf=await ctx.decodeAudioData(ab);
        const src=ctx.createBufferSource(); src.buffer=buf; src.connect(ctx.destination); src.start(t);
      }catch{}
    }
    // clip audio
    if(shot.type==="video"){
      try{
        const ab=await fetch(shot.src).then(r=>r.arrayBuffer());
        const buf=await ctx.decodeAudioData(ab);
        const src=ctx.createBufferSource(); src.buffer=buf; src.connect(ctx.destination); src.start(t); // could stop at t+7
      }catch{}
    }
    t += dur;
  }
  const rendered = await ctx.startRendering();
  return audioBufferToWavBytes(rendered);
}
function audioBufferToWavBytes(ab){
  const numCh=ab.numberOfChannels, btw=16, sampleRate=ab.sampleRate, samples=ab.length;
  const bytesPerSample=btw/8, blockAlign=numCh*bytesPerSample;
  const buffer=new ArrayBuffer(44 + samples*numCh*bytesPerSample);
  const view=new DataView(buffer);
  writeStr(view,0,'RIFF'); view.setUint32(4,36 + samples*numCh*bytesPerSample, true);
  writeStr(view,8,'WAVE'); writeStr(view,12,'fmt '); view.setUint32(16,16,true);
  view.setUint16(20,1,true); view.setUint16(22,numCh,true); view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*blockAlign,true); view.setUint16(32,blockAlign,true); view.setUint16(34,btw,true);
  writeStr(view,36,'data'); view.setUint32(40,samples*numCh*bytesPerSample,true);
  let off=44, chData=[]; for(let ch=0; ch<numCh; ch++) chData.push(ab.getChannelData(ch));
  for(let i=0;i<samples;i++){ for(let ch=0; ch<numCh; ch++){ let s = Math.max(-1, Math.min(1, chData[ch][i])); view.setInt16(off, s<0?s*0x8000:s*0x7FFF, true); off+=2; } }
  return new Uint8Array(buffer);
  function writeStr(v,o,s){ for(let i=0; i<s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); }
}

// Fallback renderer with progress
async function exportFilmWebM(){
  const flat=flattenShots(); if(flat.length===0){ toast("Add shots first"); return; }
  progressOpen("Exporting (fallback WebM)…"); progressUpdate("Rendering 0/"+flat.length,0);
  const fps=30, width=1280, height=720;
  const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext("2d");
  const stream=canvas.captureStream(fps);
  let chunks=[]; let rec;
  try{ rec=new MediaRecorder(stream,{mimeType:"video/webm;codecs=vp9"}); }
  catch{ try{ rec=new MediaRecorder(stream,{mimeType:"video/webm;codecs=vp8"}); } catch{ progressClose(); alert("Recording not supported on this device."); return; } }
  rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  const done=new Promise(res=> rec.onstop=res);
  rec.start();

  function drawCover(media){
    const iw=media.videoWidth||media.naturalWidth||width, ih=media.videoHeight||media.naturalHeight||height;
    const ir=iw/ih, r=width/height; let dw,dh; if(ir>r){ dh=height; dw=ir*dh; } else { dw=width; dh=dw/ir; }
    const dx=(width-dw)/2, dy=(height-dh)/2; ctx.fillStyle="#000"; ctx.fillRect(0,0,width,height); ctx.drawImage(media,dx,dy,dw,dh);
  }
  function drawOverlays(scene,shot){
    ctx.save(); ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(10,10,320,28);
    ctx.fillStyle="#e9eef9"; ctx.font="700 16px system-ui"; ctx.fillText(scene.name,18,30); ctx.restore();
    const txt=`${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
    ctx.save(); ctx.font="700 16px system-ui"; const tw=ctx.measureText(txt).width+24;
    ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(width-tw-10,10,tw,28); ctx.fillStyle="#e9eef9"; ctx.fillText(txt,width-tw+2,30); ctx.restore();
    if(shot.meta.dialogue || shot.meta.notes){
      const text=shot.meta.dialogue || shot.meta.notes; ctx.save(); ctx.fillStyle="rgba(0,0,0,.6)"; ctx.fillRect(0,0,width,80);
      ctx.fillStyle="#e9eef9"; ctx.font="700 20px system-ui"; wrapText(ctx,text,width-60).forEach((ln,i)=> ctx.fillText(ln,30,50+i*24)); ctx.restore();
    }
  }
  function wrapText(ctx,text,maxWidth){ const words=String(text||"").split(/\s+/); const lines=[]; let line=""; ctx.font="700 20px system-ui"; for(const w of words){ const t=line?line+" "+w:w; if(ctx.measureText(t).width>maxWidth){ if(line) lines.push(line); line=w; } else line=t; } if(line) lines.push(line); return lines; }
  const waitFrame=()=> sleep(1000/fps);

  let idx=0;
  for(const {scene,shot} of flat){
    idx++; progressUpdate(`Rendering ${idx}/${flat.length}`, idx/flat.length*0.95);
    if(shot.type==="image"){
      const img=await loadImage(shot.src); const hold=Math.max(7, shot.meta.voiceNote?.duration||0); const frames=Math.max(1, Math.round(fps*hold));
      for(let f=0; f<frames; f++){ drawCover(img); drawOverlays(scene,shot); await waitFrame(); }
    }else{
      const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; await v.play().catch(()=>{}); const endAt=performance.now()+7000;
      while(performance.now()<endAt){ drawCover(v); drawOverlays(scene,shot); await waitFrame(); } v.pause();
    }
  }
  rec.stop(); await done;
  progressUpdate("Finalizing…", 0.98);
  const blob=new Blob(chunks,{type: rec.mimeType||"video/webm"});
  downloadBlob(blob, (sanitize(state.projectName)||"storyboard")+"_film.webm", blob.type);
  progressClose();
  toast("WebM downloaded — some apps can’t play WebM; use MP4 when possible.");
}

// =========================
// Import/Export JSON
// =========================
function exportJSONCurrent(){
  const payload={ schema:"storyboard_v4", exportedAt:new Date().toISOString(), projectName: state.projectName||"Untitled", scenes: state.scenes };
  downloadBlob(JSON.stringify(payload,null,2), (sanitize(state.projectName)||"storyboard")+".json", "application/json");
}
async function importProjectJSON(file){
  if(!file) return;
  try{
    const data=JSON.parse(await file.text()); if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
    const id=uid("p_"); const name=data.projectName||"Imported";
    const rec={ id, name, createdAt:Date.now(), updatedAt:Date.now(), cover:firstCoverFrom(data)||null, data };
    await dbPut(rec); await openProject(id);
  }catch(e){ alert("Import failed: "+e.message); }
  importFile.value="";
}

// =========================
// Clear
// =========================
function clearAll(){
  if(confirm("Clear all scenes in this project?")){
    state.projectName=""; state.scenes=[]; addScene(); renderAll(); persistProject();
  }
}

// =========================
// DOM helpers & sheets
// =========================
function div(cls, txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
function smallBtn(label, onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.onclick=onClick; return b; }
function mobilePrompt(options){ return new Promise(resolve=>{ const overlay=document.createElement("div"); overlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:end center;z-index:20000"; const sheet=document.createElement("div"); sheet.style.cssText="width:100%;max-width:640px;background:#151a22;border-top-left-radius:16px;border-top-right-radius:16px;border:1px solid #2a3243;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:8px"; options.forEach(opt=>{ const b=document.createElement("button"); b.textContent=opt; b.style.cssText="width:100%;padding:14px 16px;background:#1a2130;border:1px solid #2a3243;color:#e8ecf3;border-radius:12px;margin:6px 8px;font-size:16px"; if(/delete/i.test(opt)) b.style.background="#3b2326"; sheet.appendChild(b); b.onclick=()=>{ document.body.removeChild(overlay); resolve(opt); }; }); overlay.onclick=(e)=>{ if(e.target===overlay){ document.body.removeChild(overlay); resolve("Cancel"); } }; overlay.appendChild(sheet); document.body.appendChild(overlay); }); }
function openSheet(sh){ sh?.classList.add("show"); document.body.classList.add("sheet-open"); }
function closeSheet(sh){ sh?.classList.remove("show"); document.body.classList.remove("sheet-open"); }

})();
