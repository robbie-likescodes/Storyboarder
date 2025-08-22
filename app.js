/* Storyboard App — app.js (build10)
   Includes:
   - Stage 1: drag-drop reorder + insert slots, delete voice note, undo/redo, autosave
   - Stage 2: scrubbable timeline seek, background music + auto-duck, transitions, scene collapse
   - Inline sketching sheet + overlay in renders
   - PDF export (jsPDF via CDN)
*/

(() => {
/* ---------------- Helpers ---------------- */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
const uid = (p="p_") => p + Math.random().toString(36).slice(2,10);
const esc = s => String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;" }[m]));
const sanitize = s => String(s||"").replace(/[^\w\-]+/g,"_").slice(0,60);
const debounce = (fn, ms=350)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
const sleep = ms => new Promise(r=>setTimeout(r, ms));
function fileToDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
function loadImage(src){ return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=src; }); }
function downloadBlob(data, filename, type){
  const blob = data instanceof Blob ? data : new Blob([data], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}
function formatTime(s){ s=Math.round(s); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,"0")}`; }
function strToUint8(s){ return new TextEncoder().encode(s); }
function dataURLtoUint8(dataUrl){ const [,b64]=dataUrl.split(','); const bin=atob(b64); const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return bytes; }
function importScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=()=>res(); s.onerror=rej; document.head.appendChild(s); }); }

/* ---------------- Toasts & Progress ---------------- */
function toast(msg, ms=2000){
  let host = $("#toasts");
  if(!host){
    host = document.createElement("div");
    host.id="toasts";
    host.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:20px;display:grid;gap:8px;z-index:22000";
    document.body.appendChild(host);
  }
  const t=document.createElement("div");
  t.textContent=msg;
  t.style.cssText="background:#111826cc;border:1px solid #2a3243;color:#e8ecf3;padding:10px 12px;border-radius:10px;backdrop-filter:blur(8px)";
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .25s"; setTimeout(()=>host.removeChild(t),250); }, ms);
}
let progEl=null;
function progressOpen(title="Working…"){
  if(progEl) return;
  progEl=document.createElement("div");
  progEl.innerHTML=`
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
  $("#xProg").onclick=()=>{ progEl.style.display="none"; };
}
function progressUpdate(step,ratio){
  if(!progEl) return; const s=$("#progStep",progEl), b=$("#progBar",progEl);
  if(s) s.textContent=step; if(b && typeof ratio==="number") b.style.width=Math.round(ratio*100)+"%";
}
function progressClose(){ if(!progEl) return; progEl.remove(); progEl=null; }

/* ---------------- Data Model ---------------- */
const defaultMeta = ()=>({ lens:"50mm", shotType:"MS", movements:[], transition:"Cut", dialogue:"", notes:"", voiceNote:null, sketch:null });
const makeShot = ({type="image", src="", filename="shot", meta}={})=>({ id:uid("s_"), type, src, filename, meta:meta||defaultMeta() });

const state = {
  projectName: "",
  scenes: [],             // [{id,name,shots:[Shot|null], collapsed?:bool}]
  currentProjectId: null,
  editRef: null,
  pendingReplace: null,
  pendingInsert: null,
  flatIndex: [],
  projectBGM: { dataUrl:null, volume:0.8, duck:true }
};

/* ---------------- IndexedDB (projects) ---------------- */
const DB_NAME="sb_vault", DB_VER=1, STORE="projects";
function openDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open(DB_NAME,DB_VER); r.onupgradeneeded=()=>{ const db=r.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:"id"}); }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function dbPut(record){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(record); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });}
async function dbGet(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const q=tx.objectStore(STORE).get(id); q.onsuccess=()=>res(q.result||null); q.onerror=()=>rej(q.error); });}
async function dbDelete(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });}
async function dbList(){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const q=tx.objectStore(STORE).getAll(); q.onsuccess=()=>{ const arr=q.result||[]; arr.sort((a,b)=> (b.updatedAt||0)-(a.updatedAt||0)); res(arr); }; q.onerror=()=>rej(q.error); });}

function emptyProjectRecord(id, name){
  return {
    id, name, createdAt:Date.now(), updatedAt:Date.now(), cover:null,
    data:{ projectName:name, scenes:[ { id:uid("sc_"), name:"Scene 1", shots:[ null ] } ], projectBGM:{ dataUrl:null, volume:0.8, duck:true } }
  };
}

/* ---------------- Elements ---------------- */
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
const exportPdfBtn   = $("#exportPdfBtn"); // optional
const clearBtn       = $("#clearBtn");
const projectNameInp = $("#projectName");

const viewToggle     = $("#viewToggle");
const comicView      = $("#comicView");
const scenesWrap     = $("#scenes");
const boardView      = $("#boardView");
const dropzone       = $("#dropzone");
const gallery        = $("#gallery");

/* Present ▾ dropdown */
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
const delNoteBtn     = $("#delNoteBtn"); // optional

/* Still duration */
const edStillDur       = $("#edStillDur");
const edStillDurLabel  = $("#edStillDurLabel");
const edStillReset     = $("#edStillReset");

/* BGM controls (optional in HTML) */
const bgmFile = $("#bgmFile");
const bgmVol  = $("#bgmVol");
const bgmDuck = $("#bgmDuck");

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

/* Timeline */
const timeline = $("#timeline");
const tlFill   = $("#tlFill");

/* Undo/Redo (optional buttons) */
const undoBtn = $("#undoBtn");
const redoBtn = $("#redoBtn");

/* File inputs */
const fileMulti      = $("#fileMulti");
const fileSingle     = $("#fileSingle");
const importFile     = $("#importFile");

/* Project picker (injected if missing) */
let picker=$("#picker");
if(!picker){
  picker=document.createElement("div");
  picker.id="picker";
  picker.innerHTML=`
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
const pickerGrid=$("#pickerGrid",picker);
const newProjBtn=$("#newProjBtn",picker);
const importProjBtn=$("#importProjBtn",picker);
const pickerImport=$("#pickerImport",picker);

/* Sketcher (inject if absent) */
let skSheet=$("#sketcher");
if(!skSheet){
  skSheet=document.createElement("div");
  skSheet.id="sketcher";
  skSheet.className="sheet";
  skSheet.innerHTML=`
    <div class="sheet-backdrop"></div>
    <div class="sheet-body" style="max-height:92dvh">
      <div class="sheet-grabber"></div>
      <h2>Sketch</h2>
      <div style="display:flex; gap:10px; align-items:center; margin-bottom:8px">
        <input type="color" id="skColor" value="#ff3b3b" />
        <input type="range" id="skSize" min="2" max="24" value="6" />
        <button id="skUndo" class="small-btn">Undo</button>
        <button id="skClear" class="small-btn danger">Clear</button>
        <span class="muted">Draw on top of the image</span>
      </div>
      <div style="background:#0b0e13; display:grid; place-items:center; border:1px solid #2a3243; border-radius:12px; overflow:auto">
        <canvas id="skCanvas" style="touch-action:none; max-width:100%;"></canvas>
      </div>
      <button id="skSave" class="close-btn">Save</button>
    </div>`;
  document.body.appendChild(skSheet);
}
const skCanvas=$("#skCanvas"), skColor=$("#skColor"), skSize=$("#skSize"), skUndo=$("#skUndo"), skClear=$("#skClear"), skSave=$("#skSave");

/* ---------------- Init ---------------- */
bindUI();
boot();
setInterval(()=>{ persistProject(); }, 30000); // autosave snapshot

/* ---------------- History (Undo/Redo) ---------------- */
const historyStack=[], redoStack=[];
function pushHistory(evt){ historyStack.push(evt); redoStack.length=0; updateUndoUI(); }
function updateUndoUI(){ if(undoBtn) undoBtn.disabled=!historyStack.length; if(redoBtn) redoBtn.disabled=!redoStack.length; }
function applyUndo(){
  const evt=historyStack.pop(); if(!evt) return; redoStack.push(evt);
  if(evt.type==="move"){
    moveShot(evt.toSceneId, evt.shotId, evt.fromSceneId, evt.fromIndex, {record:false});
  }else if(evt.type==="insert"){
    const sc=getScene(evt.sceneId); const i=sc?.shots.findIndex(s=>s&&s.id===evt.shotId);
    if(i>=0){ sc.shots.splice(i,1); ensureTrailingEmpty(sc); renderAll(); persistDebounced(); }
  }else if(evt.type==="delNote"){
    const sh=getShot(evt.sceneId, evt.shotId); if(sh) sh.meta.voiceNote = evt.prevNote || null; renderAll(); persistDebounced();
  }else if(evt.type==="deleteShot"){
    const sc=getScene(evt.sceneId); if(sc) { const clean=sc.shots.filter(Boolean); clean.splice(evt.index,0,evt.shot); sc.shots=clean; ensureTrailingEmpty(sc); renderAll(); persistDebounced(); }
  }else if(evt.type==="replaceShot"){
    const sc=getScene(evt.sceneId); if(sc){ const idx=sc.shots.findIndex(s=>s&&s.id===evt.newShotId); if(idx>=0){ sc.shots[idx]=evt.oldShot; renderAll(); persistDebounced(); } }
  }
  updateUndoUI();
}
function applyRedo(){
  const evt=redoStack.pop(); if(!evt) return; historyStack.push(evt);
  if(evt.type==="move"){
    moveShot(evt.fromSceneId, evt.shotId, evt.toSceneId, evt.toIndex, {record:false});
  }else if(evt.type==="insert"){
    const sc=getScene(evt.sceneId); if(sc){ const clean=sc.shots.filter(Boolean); clean.splice(evt.index,0,evt.shot); sc.shots=clean; ensureTrailingEmpty(sc); renderAll(); persistDebounced(); }
  }else if(evt.type==="delNote"){
    const sh=getShot(evt.sceneId, evt.shotId); if(sh) { sh.meta.voiceNote=null; renderAll(); persistDebounced(); }
  }else if(evt.type==="deleteShot"){
    const sc=getScene(evt.sceneId); if(sc){ const idx=sc.shots.findIndex(s=>s&&s.id===evt.shot.id); if(idx>=0){ sc.shots.splice(idx,1); ensureTrailingEmpty(sc); renderAll(); persistDebounced(); } }
  }else if(evt.type==="replaceShot"){
    const sc=getScene(evt.sceneId); if(sc){ const idx=sc.shots.findIndex(s=>s&&s.id===evt.oldShot.id); if(idx>=0){ sc.shots[idx]=evt.newShot; renderAll(); persistDebounced(); } }
  }
  updateUndoUI();
}

/* ---------------- Bindings ---------------- */
function bindUI(){
  on(homeBtn,"click",showPicker);

  // Undo/Redo buttons
  on(undoBtn,"click",applyUndo);
  on(redoBtn,"click",applyRedo);
  document.addEventListener("keydown",e=>{
    if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==="z"){ e.preventDefault(); e.shiftKey?applyRedo():applyUndo(); }
  });

  // Actions sheet
  on(menuBtn,"click",()=>openSheet(sheet));
  on(sheet,"click",e=>{ if(e.target.classList.contains("sheet-backdrop")) closeSheet(sheet); });
  on(closeSheetBtn,"click",()=>closeSheet(sheet));

  on(addSceneBtn,"click",()=>{ addScene(); renderAll(); persistDebounced(); closeSheet(sheet); });
  on(addShotsBtn,"click",()=>{ state.pendingReplace=null; state.pendingInsert=null; fileMulti?.click(); });
  on(switchProjectBtn,"click",()=>{ closeSheet(sheet); showPicker(); });

  on(renderFilmBtn,"click",async()=>{ closeSheet(sheet); await exportFilmSmart(); });
  on(importBtn,()=>importFile?.click());
  on(exportBtn,exportJSONCurrent);
  on(exportPdfBtn,exportPDF);
  on(clearBtn,clearAll);
  on(projectNameInp,"input",()=>{ state.projectName=projectNameInp.value.trim(); persistDebounced(); });

  // Views
  on(viewToggle,"click",()=>{
    const showingComic=!comicView.classList.contains("hidden");
    if(showingComic){
      comicView.classList.add("hidden"); boardView.classList.remove("hidden");
      viewToggle.textContent="Board ▾"; buildGallery();
    }else{
      boardView.classList.add("hidden"); comicView.classList.remove("hidden");
      viewToggle.textContent="Comic ▾";
    }
  });

  // Dropzone
  on(dropzone,"click",()=>{ state.pendingReplace=null; state.pendingInsert=null; fileMulti?.click(); });
  on(dropzone,"keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); dropzone.click(); }});
  ["dragenter","dragover"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave","drop"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.remove("dragover"); }));
  on(dropzone,"drop",e=>{ const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

  // Files
  on(fileMulti,"change",e=> addFilesToScene(e.target.files));
  on(fileSingle,"change",e=> replaceSingle(e.target.files?.[0]||null));
  on(importFile,"change",e=> importProjectJSON(e.target.files?.[0]||null));

  // Editor
  on(editor,"click",e=>{ if(e.target.classList.contains("sheet-backdrop")) closeSheet(editor); });
  on(closeEditor,"click",()=>closeSheet(editor));
  on(edLens,"change",saveEditor);
  on(edShotType,"change",saveEditor);
  on(edTransition,"change",saveEditor);
  on(edDialogue,"input",saveEditor);
  on(edNotes,"input",saveEditor);
  if(edMoves && !edMoves.dataset._init){
    ["Pan","Tilt","Zoom","Dolly","Truck","Pedestal","Handheld","Static","Rack Focus"].forEach(m=>{
      const b=document.createElement("button"); b.type="button"; b.className="tag"; b.textContent=m; b.dataset.mov=m;
      b.onclick=()=>{ b.classList.toggle("active"); saveEditor(); };
      edMoves.appendChild(b);
    });
    edMoves.dataset._init="1";
  }
  on(edReplace,"click",()=>{
    if(!state.editRef) return;
    state.pendingReplace={sceneId:state.editRef.sceneId, shotId:state.editRef.shotId};
    fileSingle?.click();
  });
  on(edDelete,"click",()=>{
    if(!state.editRef) return;
    const {sceneId,shotId}=state.editRef;
    const sc=getScene(sceneId); const idx=sc?.shots.findIndex(s=>s&&s.id===shotId);
    if(idx>=0){ const removed=sc.shots[idx]; sc.shots.splice(idx,1); ensureTrailingEmpty(sc);
      renderAll(); persistDebounced();
      pushHistory({type:"deleteShot", sceneId, index:idx, shot:removed});
      toast("Shot deleted");
    }
    closeSheet(editor);
  });
  if(delNoteBtn){
    on(delNoteBtn,"click",()=>{
      const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
      if(!shot.meta.voiceNote){ toast("No voice note"); return; }
      const prev=shot.meta.voiceNote;
      delete shot.meta.voiceNote;
      if(recStatus) recStatus.textContent="No voice note";
      if(playNoteBtn) playNoteBtn.disabled=true;
      persistDebounced();
      pushHistory({type:"delNote", sceneId:state.editRef.sceneId, shotId:shot.id, prevNote:prev});
      toast("Voice note deleted");
    });
  }

  // Still duration
  if(edStillDur && edStillDurLabel){
    on(edStillDur,"input", ()=> edStillDurLabel.textContent = `${edStillDur.value}s (manual)`);
    on(edStillDur,"change", saveEditor);
  }
  if(edStillReset){
    on(edStillReset,"click", ()=>{
      const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId);
      if(!shot) return;
      delete shot.meta.stillDuration;
      if(edStillDur) edStillDur.value = "7";
      if(edStillDurLabel) edStillDurLabel.textContent = "Auto (≥ 7s or voice‑note length)";
      persistDebounced();
    });
  }

  // Voice notes
  on(recBtn,"click",toggleRecord);
  on(playNoteBtn,"click",playVoiceNote);

  // Transition picker
  on(transPicker,"click",e=>{ if(e.target.classList.contains("sheet-backdrop")) closeSheet(transPicker); });
  on(closeTrans,"click",()=>closeSheet(transPicker));
  if(transOptions && !transOptions.dataset._init){
    ["Cut","Dissolve","Fade","Wipe","Match Cut","Whip Pan","J-Cut","L-Cut"].forEach(t=>{
      const b=document.createElement("button"); b.className="tag"; b.textContent=t;
      b.onclick=()=>{ if(_transTarget) setShotMeta(_transTarget,{transition:t}); closeSheet(transPicker); };
      transOptions.appendChild(b);
    });
    transOptions.dataset._init="1";
  }

  // Present ▾ dropdown
  on(playToggle,"click",()=>{
    if(!playMenu) return;
    const open=playMenu.classList.contains("hidden");
    document.querySelectorAll(".dropdown").forEach(d=>d.classList.add("hidden"));
    playMenu.classList.toggle("hidden",!open);
    playToggle.setAttribute("aria-expanded",String(open));
  });
  on(document,"click",(e)=>{
    if(!e.target.closest("#playToggle") && !e.target.closest("#playMenu")){
      playMenu?.classList.add("hidden");
      playToggle?.setAttribute("aria-expanded","false");
    }
  });
  on(menuPresent,"click",()=>{ playMenu?.classList.add("hidden"); openPresentation(); });
  on(menuPlay,"click",()=>{ playMenu?.classList.add("hidden"); startAutoPlay(); });

  // Player controls
  on(prevBtn,"click",(e)=>{ e.stopPropagation(); showAt(curIdx-1); });
  on(nextBtn,"click",(e)=>{ e.stopPropagation(); showAt(curIdx+1); });
  on(fsBtn,"click",async(e)=>{ e.stopPropagation(); if(document.fullscreenElement){ await document.exitFullscreen?.(); } else { await goFullscreen(player); } });
  on(closePlayer,"click",(e)=>{ e.stopPropagation(); closePresentation(); });

  // Stage tap toggles video pause/play
  on(stage,"click",()=>{
    const v=stageMedia?.firstElementChild;
    if(v && v.tagName==="VIDEO" && !v.controls){ if(v.paused) v.play().catch(()=>{}); else v.pause(); }
  });
  document.addEventListener("keydown",e=>{
    if(!player?.classList.contains("open")) return;
    if(e.key==="ArrowRight") showAt(curIdx+1);
    if(e.key==="ArrowLeft") showAt(curIdx-1);
    if(e.key==="Escape") closePresentation();
  });

  // BGM controls
  if(bgmFile){
    on(bgmFile,"change",async e=>{ const f=e.target.files?.[0]; if(!f) return;
      state.projectBGM.dataUrl = await fileToDataURL(f); persistDebounced(); toast("Music loaded");
    });
  }
  if(bgmVol){ on(bgmVol,"input",()=>{ state.projectBGM.volume = Number(bgmVol.value||0.8); persistDebounced(); }); }
  if(bgmDuck){ on(bgmDuck,"change",()=>{ state.projectBGM.duck = !!bgmDuck.checked; persistDebounced(); }); }

  // Timeline scrubbing
  if(timeline){
    timeline.style.touchAction="none";
    let scrubbing=false;
    const posToTime=(e)=>{ const rect=timeline.getBoundingClientRect(); const x=Math.max(0, Math.min((e.clientX??(e.touches?.[0]?.clientX||0))-rect.left, rect.width)); const ratio=rect.width?(x/rect.width):0; return (totalDur||0)*ratio; };
    timeline.addEventListener("pointerdown", e=>{
      if (!player.classList.contains("auto")) return;
      scrubbing=true; timeline.setPointerCapture(e.pointerId);
      audioCtx?.resume?.();
      const t=posToTime(e); if(tlFill) tlFill.style.width=((t/totalDur)*100).toFixed(2)+"%";
      seekToAbsoluteTime(t);
    });
    timeline.addEventListener("pointermove", e=>{
      if(!scrubbing) return; const t=posToTime(e); if(tlFill) tlFill.style.width=((t/totalDur)*100).toFixed(2)+"%";
      // (Optional live preview): seekToAbsoluteTime(t);
    });
    timeline.addEventListener("pointerup", e=>{
      if(!scrubbing) return; scrubbing=false; timeline.releasePointerCapture(e.pointerId);
      const t=posToTime(e); if(tlFill) tlFill.style.width=((t/totalDur)*100).toFixed(2)+"%"; seekToAbsoluteTime(t);
    });
    timeline.addEventListener("pointercancel", ()=>{ scrubbing=false; });
  }

  // Picker
  on(newProjBtn,"click",async()=>{
    const id=uid("p_"); const rec=emptyProjectRecord(id,"Untitled");
    await dbPut(rec); await openProject(id); hidePicker();
  });
  on(importProjBtn,"click",()=>pickerImport.click());
  on(pickerImport,"change",async e=>{
    const file=e.target.files?.[0]; if(!file) return;
    try{
      const data=JSON.parse(await file.text());
      if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
      const id=uid("p_"); const name=data.projectName||"Imported";
      const rec={ id, name, createdAt:Date.now(), updatedAt:Date.now(), cover:firstCoverFrom(data)||null, data };
      await dbPut(rec); await openProject(id); hidePicker();
    }catch(err){ alert("Import failed: "+err.message); }
    pickerImport.value="";
  });
}

/* ---------------- Boot / Picker ---------------- */
async function boot(){
  const m=location.hash.match(/#p\/([\w\-]+)/);
  if(m && await dbGet(m[1])){ await openProject(m[1]); return; }
  await showPicker();
}
async function showPicker(){
  const items=await dbList();
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
    card.querySelector(".open").onclick=async()=>{ await openProject(it.id); hidePicker(); };
    card.querySelector(".rename").onclick=async()=>{ const nn=prompt("Rename project:",it.name); if(!nn) return; it.name=nn; it.updatedAt=Date.now(); await dbPut(it); showPicker(); };
    card.querySelector(".dup").onclick=async()=>{ const id2=uid("p_"); const rec=JSON.parse(JSON.stringify(it)); rec.id=id2; rec.name=it.name+" (copy)"; rec.createdAt=Date.now(); rec.updatedAt=Date.now(); await dbPut(rec); showPicker(); };
    card.querySelector(".export").onclick=()=> downloadBlob(JSON.stringify(it.data,null,2), sanitize(it.name)+".json", "application/json");
    card.querySelector(".del").onclick=async()=>{ if(confirm(`Delete “${it.name}”?`)){ await dbDelete(it.id); showPicker(); } };
  }
  picker.classList.add("open");
  document.body.classList.add("sheet-open");
}
function hidePicker(){ picker.classList.remove("open"); document.body.classList.remove("sheet-open"); }

/* ---------------- Fullscreen helper ---------------- */
async function goFullscreen(target=player){
  try{
    if(document.fullscreenElement) return true;
    if(target?.requestFullscreen){ await target.requestFullscreen(); return true; }
  }catch{}
  try{
    const v=target?.querySelector?.("video");
    if(v && v.webkitEnterFullscreen){ v.webkitEnterFullscreen(); return true; }
  }catch{}
  return false;
}

/* ---------------- Persist ---------------- */
async function openProject(id){
  const rec=await dbGet(id);
  if(!rec){ alert("Project not found."); return; }
  state.currentProjectId=id;
  state.projectName=rec.data.projectName || rec.name || "Untitled";
  state.scenes=Array.isArray(rec.data.scenes)? rec.data.scenes : [];
  state.projectBGM = rec.data.projectBGM || state.projectBGM;
  if(state.scenes.length===0){ state.scenes.push({id:uid("sc_"),name:"Scene 1",shots:[null]}); await persistProject(); }
  location.hash="#p/"+id;
  renderAll();
}
async function persistProject(){
  if(!state.currentProjectId) return;
  const id=state.currentProjectId;
  const rec=await dbGet(id) || emptyProjectRecord(id, state.projectName||"Untitled");
  rec.name=state.projectName || rec.name;
  rec.updatedAt=Date.now();
  rec.data={ projectName:state.projectName, scenes:state.scenes, projectBGM:state.projectBGM };
  rec.cover=firstCoverFrom(rec.data) || rec.cover || null;
  await dbPut(rec);
}
const persistDebounced=debounce(persistProject,500);
function firstCoverFrom(data){ for(const s of (data.scenes||[])){ for(const sh of s.shots||[]){ if(sh && (sh.type==="image"||sh.type==="video")) return sh.src; } } return null; }

/* ---------------- Scenes / Shots ---------------- */
function addScene(){ const idx=state.scenes.length+1; state.scenes.push({id:uid("sc_"), name:`Scene ${idx}`, shots:[null], collapsed:false}); }
function ensureTrailingEmpty(scene){ if(scene.shots.length===0 || scene.shots[scene.shots.length-1]!==null) scene.shots.push(null); }
function getScene(id){ return state.scenes.find(s=>s.id===id); }
function getShot(sceneId,shotId){ return getScene(sceneId)?.shots.find(s=>s && s.id===shotId) || null; }

async function addFilesToScene(fileList){
  const files=[...fileList].filter(f=>/^image\/|^video\//.test(f.type)); if(files.length===0) return;
  const target = state.pendingReplace ? getScene(state.pendingReplace.sceneId) : state.scenes[state.scenes.length-1] || (addScene(), state.scenes[0]);
  for(const f of files){
    const dataUrl=await fileToDataURL(f);
    const shot=makeShot({ type:f.type.startsWith("video")?"video":"image", src:dataUrl, filename:f.name||"shot" });
    const emptyIdx=target.shots.findIndex(s=>s===null);
    if(emptyIdx>=0) target.shots[emptyIdx]=shot; else target.shots.push(shot);
    ensureTrailingEmpty(target);
    pushHistory({type:"insert", sceneId:target.id, index:emptyIdx>=0?emptyIdx:target.shots.length-2, shotId:shot.id, shot});
  }
  state.pendingReplace=null; state.pendingInsert=null;
  renderAll(); persistDebounced(); if(fileMulti) fileMulti.value="";
}
async function replaceSingle(file){
  if(!file){ if(fileSingle) fileSingle.value=""; return; }
  const dataUrl=await fileToDataURL(file);

  if (state.pendingInsert){
    const {sceneId,index}=state.pendingInsert;
    const sc=getScene(sceneId);
    if(sc){
      const shot = makeShot({ type:file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name||"shot" });
      const clean=sc.shots.filter(Boolean);
      const clamped=Math.max(0,Math.min(index,clean.length));
      clean.splice(clamped,0,shot);
      sc.shots=clean; ensureTrailingEmpty(sc);
      renderAll(); persistDebounced();
      pushHistory({type:"insert", sceneId, index:clamped, shotId:shot.id, shot});
    }
    state.pendingInsert=null; if(fileSingle) fileSingle.value=""; return;
  }

  if(state.pendingReplace && state.pendingReplace.shotId && state.pendingReplace.shotId!=="__empty__"){
    const {sceneId,shotId}=state.pendingReplace;
    const sc=getScene(sceneId); const idx=sc?.shots.findIndex(s=>s&&s.id===shotId);
    if(idx>=0){
      const oldShot=sc.shots[idx];
      const newShot = makeShot({ type:file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name||"shot" });
      sc.shots[idx]=newShot; ensureTrailingEmpty(sc);
      renderAll(); persistDebounced();
      pushHistory({type:"replaceShot", sceneId, oldShot, newShot, newShotId:newShot.id});
    }
  }else{
    await addFilesToScene([file]);
  }
  state.pendingReplace=null; renderAll(); persistDebounced(); if(fileSingle) fileSingle.value="";
}
function deleteShot(sceneId,shotId){
  const sc=getScene(sceneId); if(!sc) return; const idx=sc.shots.findIndex(s=>s&&s.id===shotId);
  if(idx>=0){ const removed=sc.shots[idx]; sc.shots.splice(idx,1); ensureTrailingEmpty(sc); renderAll(); persistDebounced(); pushHistory({type:"deleteShot", sceneId, index:idx, shot:removed}); }
}

/* Move across scenes to exact index */
function moveShot(fromSceneId, shotId, toSceneId, insertIndex, opts={}){
  const from=getScene(fromSceneId), to=getScene(toSceneId); if(!from||!to) return;
  const fromIdx=from.shots.findIndex(s=>s&&s.id===shotId); if(fromIdx<0) return;
  const item=from.shots[fromIdx];
  from.shots.splice(fromIdx,1); ensureTrailingEmpty(from);

  const clean=to.shots.filter(Boolean);
  const clamped=Math.max(0,Math.min(insertIndex, clean.length));
  clean.splice(clamped,0,item);
  to.shots=clean; ensureTrailingEmpty(to);

  renderAll(); persistDebounced();
  if(opts.record!==false){
    pushHistory({type:"move", fromSceneId, toSceneId, shotId, fromIndex:fromIdx, toIndex:clamped});
  }
}

/* ---------------- Render — Comic ---------------- */
function renderAll(){
  scenesWrap.innerHTML="";
  state.scenes.forEach(scene=>{ ensureTrailingEmpty(scene); scenesWrap.appendChild(renderScene(scene)); });
  projectNameInp && (projectNameInp.value = state.projectName||"");
  if(!boardView.classList.contains("hidden")) buildGallery();
  updateUndoUI();
}
let _transTarget=null;
function renderScene(scene){
  const wrap=div("scene");
  const head=div("scene-head");
  const title=div("scene-title",scene.name); title.contentEditable="true"; title.spellcheck=false;
  on(title,"input",debounce(()=>{ scene.name=(title.textContent||"").trim()||scene.name; persistDebounced(); },250));
  head.appendChild(title);

  const toggle=smallBtn(scene.collapsed?"▸":"▾",()=>{ scene.collapsed=!scene.collapsed; renderAll(); persistDebounced(); });
  head.appendChild(toggle);

  const actions=div("scene-actions");
  actions.appendChild(smallBtn("📥 Shots",()=>{ state.pendingReplace=null; state.pendingInsert=null; fileMulti?.click(); }));
  head.appendChild(actions); wrap.appendChild(head);

  if(scene.collapsed){ return wrap; }

  const strip=div("strip");
  strip.appendChild(makeInsertSlot(scene, 0));
  scene.shots.forEach((shot,idx)=>{
    if(shot){
      strip.appendChild(renderShot(scene,shot));
      // transition chip
      const chip=div("trans-chip"); const b=document.createElement("button"); b.textContent=shot.meta?.transition||"Cut";
      b.onclick=()=>{ _transTarget=shot.id; openSheet(transPicker); }; chip.appendChild(b); strip.appendChild(chip);
      // slot after shot
      strip.appendChild(makeInsertSlot(scene, idx + 1));
    }else{
      const card=div("shot empty");
      card.innerHTML=`<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
      card.onclick=()=>{ state.pendingInsert={sceneId:scene.id, index:scene.shots.filter(Boolean).length}; fileSingle?.click(); };
      strip.appendChild(card);
      strip.appendChild(makeInsertSlot(scene, idx + 1));
    }
  });
  wrap.appendChild(strip);
  return wrap;
}
function makeInsertSlot(scene, index){
  const slot = div("slot");
  slot.dataset.sceneId = scene.id;
  slot.dataset.index = String(index);
  const plus = document.createElement("button");
  plus.className = "slot-plus"; plus.type="button"; plus.textContent="＋"; plus.title="Insert here";
  plus.onclick = () => { state.pendingInsert = { sceneId: scene.id, index }; fileSingle?.click(); };
  slot.appendChild(plus);
  slot.addEventListener("dragover", e=>{ e.preventDefault(); slot.classList.add("slot-over"); });
  slot.addEventListener("dragleave", ()=> slot.classList.remove("slot-over"));
  slot.addEventListener("drop", e=>{
    e.preventDefault(); slot.classList.remove("slot-over");
    const data=JSON.parse(e.dataTransfer.getData("text/plain")||"{}");
    if(!data.sceneId || !data.shotId) return;
    moveShot(data.sceneId, data.shotId, scene.id, index);
  });
  return slot;
}

function renderShot(scene,shot){
  const card=div("shot"); card.draggable=true;
  const t=div("thumb");
  if(shot.type==="image"){ const img=new Image(); img.src=shot.src; img.alt=shot.filename; t.appendChild(img); }
  else { const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; v.muted=true; v.controls=false; on(v,"mouseenter",()=>v.play().catch(()=>{})); on(v,"mouseleave",()=>v.pause()); t.appendChild(v); }
  const badge=div("badge",shot.type.toUpperCase()); t.appendChild(badge);

  // Sketch overlay if present
  if(shot.meta.sketch){ const ov=new Image(); ov.src=shot.meta.sketch; ov.className="sketch"; t.appendChild(ov); }

  const meta=div("meta"); meta.innerHTML=`<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;
  const overlay=div("overlay-info"); overlay.textContent=shot.meta.dialogue || shot.meta.notes || `${shot.meta.lens} · ${shot.meta.shotType}`;
  card.appendChild(t); card.appendChild(meta); card.appendChild(overlay);

  card.onclick=(e)=>{ if(e.target.closest(".meta")){ card.classList.toggle("show-info"); return; } openEditor(scene.id,shot.id); };

  // Drag data
  card.addEventListener("dragstart", e=>{
    e.dataTransfer.setData("text/plain", JSON.stringify({sceneId:scene.id, shotId:shot.id}));
    setTimeout(()=> card.classList.add("dragging"),0);
  });
  card.addEventListener("dragend", ()=> card.classList.remove("dragging"));

  return card;
}

/* ---------------- Board view ---------------- */
function buildGallery(){
  gallery.innerHTML="";
  state.scenes.forEach(scene=>{
    scene.shots.filter(Boolean).forEach(shot=>{
      const wrap=div("gallery-item");
      const media=div("gallery-media"); media.style.position="relative";
      if(shot.type==="image"){ const img=new Image(); img.src=shot.src; media.appendChild(img); }
      else { const v=document.createElement("video"); v.src=shot.src; v.controls=true; v.playsInline=true; v.style.width="100%"; v.style.height="auto"; v.style.objectFit="contain"; media.appendChild(v); }
      // Sketch overlay
      if(shot.meta.sketch){ const ov=new Image(); ov.src=shot.meta.sketch; ov.className="sketch"; media.appendChild(ov); }

      wrap.appendChild(media);

      const meta=div("gallery-meta");
      meta.innerHTML=`<div><strong>${esc(scene.name)}</strong> — ${esc(shot.filename)}</div>`;
      const actions=document.createElement("div"); actions.style.display="flex"; actions.style.gap="6px"; actions.style.marginTop="8px";
      const editBtn=document.createElement("button"); editBtn.className="small-btn"; editBtn.textContent="Edit details"; editBtn.onclick=()=>openEditor(scene.id,shot.id);
      const repBtn=document.createElement("button"); repBtn.className="small-btn"; repBtn.textContent="Replace"; repBtn.onclick=()=>{ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle?.click(); };
      const delBtn=document.createElement("button"); delBtn.className="small-btn danger"; delBtn.textContent="Delete"; delBtn.onclick=()=> deleteShot(scene.id,shot.id);
      const sketchBtn=document.createElement("button"); sketchBtn.className="small-btn"; sketchBtn.textContent="✏️ Sketch"; sketchBtn.onclick=()=>openSketcher(scene.id, shot.id);
      actions.append(editBtn,repBtn,delBtn,sketchBtn); meta.appendChild(actions);

      wrap.appendChild(meta); gallery.appendChild(wrap);
    });
  });
}

/* ---------------- Editor ---------------- */
function openEditor(sceneId,shotId){
  state.editRef={sceneId,shotId};
  const shot=getShot(sceneId,shotId); if(!shot) return;
  editorTitle && (editorTitle.textContent=`Edit • ${shot.filename}`);
  if(edLens) edLens.value=shot.meta.lens||"50mm";
  if(edShotType) edShotType.value=shot.meta.shotType||"MS";
  if(edTransition) edTransition.value=shot.meta.transition||"Cut";
  if(edDialogue) edDialogue.value=shot.meta.dialogue||"";
  if(edNotes) edNotes.value=shot.meta.notes||"";
  if(edMoves) [...edMoves.querySelectorAll(".tag")].forEach(b=> b.classList.toggle("active", !!shot.meta.movements?.includes(b.dataset.mov)));

  // Populate still duration controls (optional)
  const dur = Number(shot.meta.stillDuration);
  if(edStillDur && edStillDurLabel){
    if (Number.isFinite(dur)){
      edStillDur.value = String(Math.max(1, Math.min(30, Math.round(dur))));
      edStillDurLabel.textContent = `${edStillDur.value}s (manual)`;
    } else {
      edStillDur.value = "7";
      edStillDurLabel.textContent = "Auto (≥ 7s or voice‑note length)";
    }
  }

  if(recStatus) {
    if(shot.meta.voiceNote){ recStatus.textContent=`Voice note • ${formatTime(shot.meta.voiceNote.duration)}`; if(playNoteBtn) playNoteBtn.disabled=false; }
    else { recStatus.textContent="No voice note"; if(playNoteBtn) playNoteBtn.disabled=true; }
  }
  openSheet(editor);
}
function saveEditor(){
  const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
  if(edLens) shot.meta.lens=edLens.value;
  if(edShotType) shot.meta.shotType=edShotType.value;
  if(edTransition) shot.meta.transition=edTransition.value;
  if(edDialogue) shot.meta.dialogue=edDialogue.value;
  if(edNotes) shot.meta.notes=edNotes.value;
  if(edMoves) shot.meta.movements=[...edMoves.querySelectorAll(".tag.active")].map(b=>b.dataset.mov);
  if(edStillDur && edStillDurLabel){
    if(edStillDurLabel.textContent.includes("(manual)")){
      const manual = Number(edStillDur.value);
      shot.meta.stillDuration = Math.max(1, Math.min(30, isFinite(manual) ? manual : 7));
    }else{
      delete shot.meta.stillDuration;
    }
  }
  persistDebounced(); renderAll();
}
let mediaRec=null, recChunks=[], recStart=0;
async function toggleRecord(){
  const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
  if(mediaRec && mediaRec.state==="recording"){ mediaRec.stop(); return; }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    recChunks=[]; mediaRec=new MediaRecorder(stream);
    mediaRec.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
    mediaRec.onstart=()=>{ recStart=Date.now(); if(recStatus) recStatus.textContent="Recording… tap to stop"; if(recBtn) recBtn.textContent="⏹ Stop"; };
    mediaRec.onstop=async ()=>{
      const blob=new Blob(recChunks,{type:mediaRec.mimeType||"audio/webm"});
      const dataUrl=await blobToDataURL(blob); const dur=(Date.now()-recStart)/1000;
      shot.meta.voiceNote={ dataUrl, duration:dur, mime:blob.type };
      if(recStatus) recStatus.textContent=`Saved • ${formatTime(dur)}`; if(playNoteBtn) playNoteBtn.disabled=false; if(recBtn) recBtn.textContent="🎙 Record";
      persistDebounced();
    };
    mediaRec.start();
  }catch(err){ alert("Mic access failed: "+err.message); }
}
function blobToDataURL(blob){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(blob); }); }
function playVoiceNote(){ const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot?.meta.voiceNote) return; new Audio(shot.meta.voiceNote.dataUrl).play().catch(()=>{}); }
function setShotMeta(shotId, patch){ state.scenes.forEach(s=> s.shots.forEach(sh=>{ if(sh && sh.id===shotId) Object.assign(sh.meta, patch); })); persistDebounced(); renderAll(); }

/* ---------------- Presentation (manual) ---------------- */
let curIdx=0;
function openPresentation(){
  state.flatIndex=flattenShots(); if(state.flatIndex.length===0) return;
  curIdx=0; player.classList.add("open"); player.classList.remove("auto");
  player.setAttribute("aria-hidden","false");
  prevBtn && (prevBtn.disabled=false); nextBtn && (nextBtn.disabled=false);
  if(tlFill) tlFill.style.width="0%";
  showAt(0);
}
function closePresentation(){
  player.classList.remove("open","auto");
  player.setAttribute("aria-hidden","true");
  stageMedia.innerHTML="";
  stopAutoPlay();
  prevBtn && (prevBtn.disabled=false); nextBtn && (nextBtn.disabled=false);
  if(tlFill) tlFill.style.width="0%";
}
function flattenShots(){ const arr=[]; state.scenes.forEach(s=> s.shots.filter(Boolean).forEach(sh=> arr.push({scene:s, shot:sh}))); return arr; }
function showAt(i){
  state.flatIndex=state.flatIndex.length?state.flatIndex:flattenShots();
  const n=state.flatIndex.length; curIdx=(i%n + n)%n;
  const {scene,shot}=state.flatIndex[curIdx];
  stageMedia.innerHTML="";
  let el;
  if(shot.type==="image"){ el=new Image(); el.src=shot.src; el.alt=shot.filename; }
  else { el=document.createElement("video"); el.src=shot.src; el.autoplay=true; el.loop=false; el.muted=false; el.controls=false; el.setAttribute("playsinline",""); el.setAttribute("webkit-playsinline",""); el.style.width="100%"; el.style.height="100%"; el.style.objectFit="contain"; const resume=()=>{ el.play().catch(()=>{}); stage.removeEventListener("click", resume); }; el.addEventListener("loadeddata", ()=> el.play().catch(()=>{}), {once:true}); stage.addEventListener("click", resume, {once:true}); }
  stageMedia.appendChild(el);
  ovTL.textContent=scene.name;
  ovTR.textContent=`${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
  ovB.textContent=shot.meta.dialogue || shot.meta.notes || "";
}

/* ---------------- Auto movie + seekable timeline ---------------- */
let autoTimer=null, autoAudio=null, autoAbort=false, tlInterval=null;
let segStart=0, segDur=0, durations=[], totalDur=0, elapsedBeforeSeg=0;
let cumStarts=[]; // cumulative segment starts

/* Web Audio for voice notes and BGM */
let audioCtx=null;
let voiceSource=null; // current note
let bgmGain=null;

function buildCumStarts(durs){ cumStarts=new Array(durs.length); let t=0; for(let i=0;i<durs.length;i++){ cumStarts[i]=t; t+=durs[i]; } }
function findSegmentAt(t){ let i=0; for(; i<cumStarts.length-1; i++){ if(t < cumStarts[i+1]) break; } return Math.max(0, Math.min(i, cumStarts.length-1)); }

function stopAutoPlay(){
  autoAbort=true;
  if(autoTimer){ clearTimeout(autoTimer); autoTimer=null; }
  if(autoAudio){ try{ autoAudio.pause(); }catch{} autoAudio=null; }
  if(tlInterval){ clearInterval(tlInterval); tlInterval=null; }
  if(voiceSource){ try{ voiceSource.stop(); }catch{} voiceSource=null; }
  if(audioCtx){ try{ audioCtx.close(); }catch{} audioCtx=null; }
  bgmGain=null;
}
function getVideoDuration(src){
  return new Promise(resolve=>{
    const v=document.createElement("video");
    v.preload="metadata"; v.src=src;
    v.onloadedmetadata=()=> resolve(Number.isFinite(v.duration) ? Math.min(7,v.duration) : 7);
    v.onerror=()=> resolve(7);
  });
}
async function computeDurations(seq){
  return Promise.all(seq.map(({shot})=>{
    if(shot.type==="image"){
      const manual = Number(shot.meta.stillDuration);
      const base   = Number.isFinite(manual) ? manual : 7;
      return Math.max(base, shot.meta.voiceNote?.duration || 0);
    }
    return getVideoDuration(shot.src);
  }));
}
function startTimelineWatcher(){
  if(!tlFill) return;
  if(tlInterval) clearInterval(tlInterval);
  tlInterval=setInterval(()=>{
    const now=performance.now();
    const segElapsed=Math.min((now - segStart)/1000, segDur);
    const elapsed=elapsedBeforeSeg + segElapsed;
    const ratio = totalDur ? Math.max(0, Math.min(1, elapsed/totalDur)) : 0;
    tlFill.style.width=(ratio*100).toFixed(2)+"%";
  },150);
}

async function startBGM(){
  if(!state.projectBGM?.dataUrl || !audioCtx) return;
  try{
    const ab = await fetch(state.projectBGM.dataUrl).then(r=>r.arrayBuffer());
    const buf = await audioCtx.decodeAudioData(ab);
    const src = audioCtx.createBufferSource(); src.buffer=buf; src.loop=true;
    bgmGain = audioCtx.createGain(); bgmGain.gain.value = state.projectBGM.volume || 0.8;
    src.connect(bgmGain).connect(audioCtx.destination);
    src.start(0);
  }catch{}
}
function setDuck(active){
  if(!bgmGain) return;
  const full = state.projectBGM.volume || 0.8;
  const low  = Math.max(0, full*0.25);
  const target = active && state.projectBGM.duck ? low : full;
  bgmGain.gain.cancelScheduledValues(audioCtx.currentTime);
  bgmGain.gain.linearRampToValueAtTime(target, audioCtx.currentTime + 0.15);
}

function startAutoPlay(startAtSec=0){
  const seq=flattenShots(); if(seq.length===0){ toast("Add shots first"); return; }
  player.classList.add("open","auto");
  player.setAttribute("aria-hidden","false");
  prevBtn && (prevBtn.disabled=true); nextBtn && (nextBtn.disabled=true);

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume().catch(()=>{});

  (async ()=>{
    durations=await computeDurations(seq);
    totalDur=durations.reduce((a,b)=>a+b,0);
    buildCumStarts(durations);

    const t0 = Math.max(0, Math.min(startAtSec, Math.max(0,totalDur-0.001)));
    let i = findSegmentAt(t0);
    let offsetInSeg = t0 - cumStarts[i];
    elapsedBeforeSeg = cumStarts[i];
    tlFill && (tlFill.style.width = ((t0/totalDur)*100).toFixed(2) + "%");

    await startBGM();
    goFullscreen(player);

    autoAbort=false;

    const playStep = async (segOffset=0) => {
      if(autoAbort) return;
      if(i>=seq.length){ closePresentation(); return; }

      const {scene,shot}=seq[i];
      segDur=durations[i]||7; segStart=performance.now() - segOffset*1000;
      startTimelineWatcher();

      const prevEl = stageMedia.firstElementChild || null;

      // Setup next element
      let nextEl;
      ovTL.textContent=scene.name;
      ovTR.textContent=`${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
      ovB.textContent=shot.meta.dialogue || shot.meta.notes || "";

      const remaining = Math.max(0.05, segDur - segOffset);

      if(voiceSource){ try{ voiceSource.stop(); }catch{} voiceSource=null; }

      if(shot.type==="image"){
        nextEl=new Image(); nextEl.src=shot.src; stageMedia.appendChild(nextEl);

        // voice note
        if(shot.meta.voiceNote?.dataUrl && audioCtx){
          setDuck(true);
          try{
            const ab=await fetch(shot.meta.voiceNote.dataUrl).then(r=>r.arrayBuffer());
            const buf=await audioCtx.decodeAudioData(ab);
            voiceSource=audioCtx.createBufferSource(); voiceSource.buffer=buf;
            voiceSource.connect(audioCtx.destination);
            const startAt=Math.min(segOffset, buf.duration-0.01);
            voiceSource.start(0, Math.max(0,startAt));
            voiceSource.stop(audioCtx.currentTime + remaining + 0.05);
          }catch{}
        }else{
          setDuck(false);
        }

        await runTransition(shot.meta.transition||"Cut", prevEl, nextEl, 350);

        autoTimer=setTimeout(()=>{ elapsedBeforeSeg += remaining; i++; playStep(0); }, remaining*1000);

      }else{
        setDuck(true);
        nextEl=document.createElement("video");
        nextEl.src=shot.src; nextEl.autoplay=true; nextEl.controls=false; nextEl.muted=false;
        nextEl.playsInline=true; nextEl.setAttribute("playsinline",""); nextEl.setAttribute("webkit-playsinline","");
        nextEl.style.width="100%"; nextEl.style.height="100%"; nextEl.style.objectFit="cover";
        stageMedia.appendChild(nextEl);

        await runTransition(shot.meta.transition||"Cut", prevEl, nextEl, 350);

        nextEl.addEventListener("loadedmetadata", ()=>{
          try{ nextEl.currentTime = Math.min(nextEl.duration-0.05, segOffset); }catch{}
          nextEl.play().catch(()=>{});
        }, {once:true});

        goFullscreen(nextEl);
        let advanced=false; const advance=()=>{ if(advanced) return; advanced=true; elapsedBeforeSeg += remaining; i++; playStep(0); };
        nextEl.onended=advance;
        autoTimer=setTimeout(advance, remaining*1000);
      }
    };

    const origClose=closePlayer?.onclick;
    if(closePlayer) closePlayer.onclick=()=>{ stopAutoPlay(); closePresentation(); closePlayer.onclick=origClose; };
    playStep(offsetInSeg);
  })();
}

function seekToAbsoluteTime(absSec){
  if (!player.classList.contains("auto")) return;
  if(autoTimer){ clearTimeout(autoTimer); autoTimer=null; }
  if(voiceSource){ try{ voiceSource.stop(); }catch{} voiceSource=null; }
  const vid = stageMedia?.querySelector("video"); if(vid){ try{ vid.pause(); }catch{} }
  // keep UI open
  player.classList.add("open","auto");
  player.setAttribute("aria-hidden","false");
  // restart from absSec
  stopAutoPlay();
  startAutoPlay(absSec);
}

/* Transitions */
async function runTransition(type, fromEl, toEl, durMs=350){
  const stage = stageMedia;
  if(!fromEl){ return; }
  if(!toEl || type==="Cut"){ try{ stage.removeChild(fromEl); }catch{} return; }

  toEl.style.position="absolute"; toEl.style.inset="0"; toEl.style.opacity="0";
  // keep toEl in stage if not already
  if(toEl.parentNode!==stage) stage.appendChild(toEl);

  if(type==="Dissolve" || type==="Fade"){
    fromEl.style.transition = toEl.style.transition = `opacity ${durMs}ms ease`;
    fromEl.style.opacity="0"; toEl.style.opacity="1";
  }else if(type==="Wipe"){
    toEl.style.clipPath="inset(0 100% 0 0)"; toEl.style.opacity="1";
    toEl.style.transition=`clip-path ${durMs}ms ease`;
    requestAnimationFrame(()=> toEl.style.clipPath="inset(0 0 0 0)");
  }else if(type==="Whip Pan"){
    fromEl.style.transition = `transform ${durMs}ms cubic-bezier(.2,.8,.2,1)`;
    toEl.style.transition   = `transform ${durMs}ms cubic-bezier(.2,.8,.2,1)`;
    toEl.style.transform="translateX(100%)"; toEl.style.opacity="1";
    requestAnimationFrame(()=>{
      fromEl.style.transform="translateX(-100%)";
      toEl.style.transform="translateX(0)";
    });
  }else if(type==="Match Cut"){ // quick dissolve variant
    fromEl.style.transition = toEl.style.transition = `opacity ${Math.round(durMs*0.7)}ms ease`;
    fromEl.style.opacity="0.2"; toEl.style.opacity="1";
  }
  await sleep(durMs+30);
  try{ stage.removeChild(fromEl); }catch{}
  toEl.style.position=""; toEl.style.inset=""; toEl.style.opacity="";
  toEl.style.transform=""; toEl.style.clipPath=""; toEl.style.transition="";
}

/* ---------------- Export (MP4 + WebM) with BGM mix ---------------- */
let ffmpeg=null;
async function ensureFFmpeg(){
  if(ffmpeg) return true;
  try{
    await importScript("https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js");
    const { createFFmpeg } = window.FFmpeg;
    ffmpeg = createFFmpeg({
      log:false,
      corePath:"https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js"
    });
    ffmpeg.setProgress(({ratio})=> progressUpdate("Encoding…", ratio||0));
    progressOpen("Loading encoder…");
    await ffmpeg.load();
    progressClose();
    return true;
  }catch(e){
    console.warn("ffmpeg load failed",e);
    toast("Couldn’t load MP4 encoder — falling back to WebM.");
    progressClose();
    return false;
  }
}
async function exportFilmSmart(){ toast("Export started"); if(await ensureFFmpeg()){ await exportFilmMP4(); } else { await exportFilmWebM(); } }

async function exportFilmMP4(){
  const flat=flattenShots(); if(flat.length===0){ toast("Add shots first"); return; }
  progressOpen("Exporting MP4…"); progressUpdate("Preparing parts…",0);
  const width=1280, height=720, fps=30; let idx=0; const parts=[];
  for(const {shot} of flat){
    idx++;
    if(shot.type==="image"){
      const imgName=`img_${idx}.jpg`; ffmpeg.FS('writeFile', imgName, dataURLtoUint8(shot.src));
      const manual = Number(shot.meta.stillDuration);
      const base   = Number.isFinite(manual) ? manual : 7;
      const dur    = Math.max(base, shot.meta.voiceNote?.duration || 0);
      const out=`part_${idx}.mp4`;
      progressUpdate(`Image ${idx}: ${dur.toFixed(1)}s`,0.05);
      await ffmpeg.run('-loop','1','-t',String(dur),'-i',imgName,'-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-r',String(fps),'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline','-an',out);
      parts.push(out);
    }else{
      const inName=`clip_${idx}.mp4`; ffmpeg.FS('writeFile', inName, dataURLtoUint8(shot.src));
      const out=`part_${idx}.mp4`;
      progressUpdate(`Video ${idx}: re-encoding`,0.05);
      await ffmpeg.run('-i',inName,'-t','7','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-r',String(fps),'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline','-an',out);
      parts.push(out);
    }
  }
  progressUpdate("Concatenating picture…",0.2);
  const listTxt=parts.map(p=>`file '${p}'`).join('\n'); ffmpeg.FS('writeFile','concat.txt', strToUint8(listTxt));
  await ffmpeg.run('-f','concat','-safe','0','-i','concat.txt','-c','copy','temp_video.mp4');

  progressUpdate("Mixing audio…",0.5);
  const wavBytes=await buildFullAudioTrack(flat);
  if(wavBytes){
    ffmpeg.FS('writeFile','audio.wav', wavBytes);
    progressUpdate("Muxing MP4…",0.8);
    await ffmpeg.run('-i','temp_video.mp4','-i','audio.wav','-c:v','copy','-c:a','aac','-shortest','out.mp4');
  }else{
    await ffmpeg.run('-i','temp_video.mp4','-c','copy','out.mp4');
  }

  const mp4=ffmpeg.FS('readFile','out.mp4');
  progressUpdate("Finalizing…",0.95);

  const fileName=(sanitize(state.projectName)||"storyboard")+"_film.mp4";
  const blob=new Blob([mp4.buffer],{type:'video/mp4'});

  try{
    if(navigator.canShare && navigator.canShare({files:[new File([blob],fileName,{type:'video/mp4'})]})){
      await navigator.share({ files:[new File([blob],fileName,{type:'video/mp4'})], title:fileName, text:'Storyboard export' });
      toast("Shared — choose “Save Video” to add to Photos");
    }else{
      downloadBlob(blob,fileName,'video/mp4');
      toast("Downloaded MP4 — Share → Save Video");
    }
  }catch{
    downloadBlob(blob,fileName,'video/mp4');
    toast("Downloaded MP4 — Share → Save Video");
  }finally{
    progressClose();
  }
}

async function buildFullAudioTrack(flat){
  const sr=48000; let total=0; const starts=[]; let t=0;
  for(const {shot} of flat){
    const dur=(shot.type==="image")
      ? Math.max(Number.isFinite(Number(shot.meta.stillDuration))?Number(shot.meta.stillDuration):7, shot.meta.voiceNote?.duration||0)
      : 7;
    starts.push(t); t+=dur; total+=dur;
  }
  if(total<=0) return null;
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext; if(!Offline) return null;
  const ctx=new Offline(2, Math.ceil(total*sr), sr);
  const mixGain = ctx.createGain(); mixGain.connect(ctx.destination);

  // BGM (loop + duck)
  if(state.projectBGM?.dataUrl){
    try{
      const ab=await fetch(state.projectBGM.dataUrl).then(r=>r.arrayBuffer());
      const buf=await ctx.decodeAudioData(ab);
      const src=ctx.createBufferSource(); src.buffer=buf; src.loop=true;
      const g=ctx.createGain(); const loud=state.projectBGM.volume||0.8; const low=Math.max(0,loud*0.25);
      g.gain.value=loud; src.connect(g).connect(mixGain); src.start(0);
      if(state.projectBGM.duck){
        for(let i=0;i<flat.length;i++){
          const shot=flat[i].shot, start=starts[i];
          const dur=(shot.type==="image")
            ? Math.max((Number(shot.meta.stillDuration)||7), shot.meta.voiceNote?.duration||0)
            : 7;
          const hasFg = (shot.type==="video") || !!shot.meta.voiceNote;
          const a=0.12;
          if(hasFg){
            g.gain.setValueAtTime(g.gain.value, start);
            g.gain.linearRampToValueAtTime(low, start+a);
            g.gain.setValueAtTime(low, start+dur-a);
            g.gain.linearRampToValueAtTime(loud, start+dur);
          }
        }
      }
    }catch{}
  }

  // Voice notes & video audio
  let cursor=0;
  for(const {shot} of flat){
    const dur=(shot.type==="image")
      ? Math.max(Number.isFinite(Number(shot.meta.stillDuration))?Number(shot.meta.stillDuration):7, shot.meta.voiceNote?.duration||0)
      : 7;
    if(shot.type==="image" && shot.meta.voiceNote?.dataUrl){
      try{
        const ab=await fetch(shot.meta.voiceNote.dataUrl).then(r=>r.arrayBuffer());
        const buf=await ctx.decodeAudioData(ab);
        const src=ctx.createBufferSource(); src.buffer=buf; src.connect(mixGain); src.start(cursor);
      }catch{}
    }
    if(shot.type==="video"){
      try{
        const ab=await fetch(shot.src).then(r=>r.arrayBuffer());
        const buf=await ctx.decodeAudioData(ab);
        const src=ctx.createBufferSource(); src.buffer=buf; src.connect(mixGain); src.start(cursor);
      }catch{}
    }
    cursor+=dur;
  }
  const rendered=await ctx.startRendering();
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
  for(let i=0;i<samples;i++){ for(let ch=0; ch<numCh; ch++){ let s=Math.max(-1,Math.min(1,chData[ch][i])); view.setInt16(off, s<0?s*0x8000:s*0x7FFF, true); off+=2; } }
  return new Uint8Array(buffer);
  function writeStr(v,o,s){ for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); }
}

/* Fallback WebM recorder */
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
      const img=await loadImage(shot.src);
      const manual = Number(shot.meta.stillDuration);
      const base   = Number.isFinite(manual) ? manual : 7;
      const hold   = Math.max(base, shot.meta.voiceNote?.duration||0);
      const frames=Math.max(1, Math.round(fps*hold));
      for(let f=0; f<frames; f++){
        drawCover(img); // sketch overlay
        if(shot.meta.sketch){ const ov=await loadImage(shot.meta.sketch); drawCover(ov); }
        drawOverlays(scene,shot); await waitFrame();
      }
    }else{
      const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; await v.play().catch(()=>{}); v.pause();
      const endAt=performance.now()+7000;
      while(performance.now()<endAt){
        drawCover(v);
        if(shot.meta.sketch){ const ov=await loadImage(shot.meta.sketch); drawCover(ov); }
        drawOverlays(scene,shot); await waitFrame();
      }
    }
  }
  rec.stop(); await done;
  progressUpdate("Finalizing…",0.98);
  const blob=new Blob(chunks,{type: rec.mimeType||"video/webm"});
  downloadBlob(blob,(sanitize(state.projectName)||"storyboard")+"_film.webm", blob.type);
  progressClose();
  toast("WebM downloaded — some apps can’t play WebM; use MP4 when possible.");
}

/* ---------------- Import/Export JSON ---------------- */
function exportJSONCurrent(){
  const payload={ schema:"storyboard_v5", exportedAt:new Date().toISOString(), projectName:state.projectName||"Untitled", scenes:state.scenes, projectBGM:state.projectBGM };
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

/* ---------------- Clear ---------------- */
function clearAll(){
  if(confirm("Clear all scenes in this project?")){
    state.projectName=""; state.scenes=[]; addScene(); renderAll(); persistProject();
  }
}

/* ---------------- DOM & Sheets ---------------- */
function div(cls,txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
function smallBtn(label,onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.onclick=onClick; return b; }
function openSheet(sh){ sh?.classList.add("show"); document.body.classList.add("sheet-open"); }
function closeSheet(sh){ sh?.classList.remove("show"); document.body.classList.remove("sheet-open"); }

/* ---------------- Sketcher ---------------- */
let skCtx=null, skStack=[], skRef=null, skImg=null;
function openSketcher(sceneId, shotId){
  skRef={sceneId, shotId};
  const shot=getShot(sceneId, shotId);
  skImg=new Image(); skImg.src=shot.src;
  skImg.onload=()=>{
    const W=Math.min(1280, skImg.naturalWidth||1280), H=Math.round(W*(skImg.naturalHeight/skImg.naturalWidth||9/16));
    skCanvas.width=W; skCanvas.height=H; skCtx=skCanvas.getContext("2d");
    skCtx.drawImage(skImg,0,0,W,H);
    if(shot.meta.sketch){ const ov=new Image(); ov.src=shot.meta.sketch; ov.onload=()=>{ skCtx.drawImage(ov,0,0,W,H); }; }
  };
  bindSketchTools(); openSheet(skSheet);
}
function bindSketchTools(){
  if(!skCanvas) return;
  let drawing=false, last=null;
  const pos=(e)=>{ const r=skCanvas.getBoundingClientRect(); const cx=(e.touches?e.touches[0].clientX:e.clientX)-r.left, cy=(e.touches?e.touches[0].clientY:e.clientY)-r.top; return {x: cx*(skCanvas.width/r.width), y: cy*(skCanvas.height/r.height)}; };
  const begin=(e)=>{ e.preventDefault(); drawing=true; last=pos(e); skCtx.strokeStyle=skColor.value; skCtx.lineWidth=Number(skSize.value); skCtx.lineCap="round"; skCtx.lineJoin="round"; skStack.push(skCanvas.toDataURL()); };
  const move=(e)=>{ if(!drawing) return; const p=pos(e); skCtx.beginPath(); skCtx.moveTo(last.x,last.y); skCtx.lineTo(p.x,p.y); skCtx.stroke(); last=p; };
  const end=()=>{ drawing=false; };
  skCanvas.onpointerdown=begin; skCanvas.onpointermove=move; skCanvas.onpointerup=end; skCanvas.onpointercancel=end; skCanvas.onpointerleave=end;
  if(skUndo) skUndo.onclick=()=>{ const prev=skStack.pop(); if(!prev) return; const img=new Image(); img.src=prev; img.onload=()=>{ skCtx.clearRect(0,0,skCanvas.width,skCanvas.height); skCtx.drawImage(img,0,0); }; };
  if(skClear) skClear.onclick=()=>{ skCtx.drawImage(skImg,0,0,skCanvas.width,skCanvas.height); skStack=[]; };
  if(skSave) skSave.onclick=()=>{ const shot=getShot(skRef.sceneId, skRef.shotId); shot.meta.sketch = skCanvas.toDataURL("image/png"); persistDebounced(); renderAll(); closeSheet(skSheet); toast("Sketch saved"); };
}

/* ---------------- PDF Export ---------------- */
async function ensureJsPDF(){
  if(window.jspdf?.jsPDF) return true;
  try{ await importScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"); return !!window.jspdf?.jsPDF; }
  catch{ return false; }
}
async function exportPDF(){
  if(!(await ensureJsPDF())){ alert("PDF library not loaded"); return; }
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation:"landscape", unit:"pt", format:"letter" }); // 792x612pt
  const pageW=pdf.internal.pageSize.getWidth(), pageH=pdf.internal.pageSize.getHeight();
  const margin=36, colGap=18, cols=2, cellW=(pageW - margin*2 - colGap)/cols, cellH=220, lineH=14;

  let x=margin, y=margin;

  pdf.setFont("helvetica","bold"); pdf.setFontSize(16);
  pdf.text(state.projectName||"Storyboard", margin, y); y += 18;

  for(const scene of state.scenes){
    const shots=scene.shots.filter(Boolean);
    if(shots.length===0) continue;

    pdf.setFont("helvetica","bold"); pdf.setFontSize(14);
    if(y+cellH+60 > pageH - margin){ pdf.addPage(); x=margin; y=margin; }
    pdf.text(scene.name, margin, y); y += 14;

    pdf.setFont("helvetica","normal"); pdf.setFontSize(11);

    for(let i=0;i<shots.length;i++){
      const shot=shots[i];

      if(y+cellH+60 > pageH - margin){
        pdf.addPage(); x=margin; y=margin;
        pdf.setFont("helvetica","bold"); pdf.setFontSize(14);
        pdf.text(scene.name+" (cont.)", margin, y); y+=14;
        pdf.setFont("helvetica","normal"); pdf.setFontSize(11);
      }

      const bmp = await shotBitmap(shot, cellW, cellH);
      pdf.addImage(bmp, "JPEG", x, y, cellW, cellH, undefined, "FAST");

      const metaTop = y + cellH + 12;
      const meta1 = `Lens: ${shot.meta.lens}  •  Type: ${shot.meta.shotType}`;
      const meta2 = `Transition: ${shot.meta.transition || "Cut"}  •  Movements: ${(shot.meta.movements||[]).join(", ")||"—"}`;
      pdf.text(meta1, x, metaTop);
      pdf.text(meta2, x, metaTop + lineH);

      const desc = (shot.meta.dialogue || shot.meta.notes || "").trim();
      if(desc){
        const wrapped = pdf.splitTextToSize(desc, cellW);
        pdf.text(wrapped, x, metaTop + lineH*2);
      }

      if((i%cols)===0){ x += cellW + colGap; } else { x = margin; y += cellH + 60; }
    }
    if(x !== margin){ x = margin; y += cellH + 60; }
  }

  pdf.save((sanitize(state.projectName)||"storyboard") + ".pdf");

  async function shotBitmap(shot, w, h){
    const cn=document.createElement("canvas"); cn.width=Math.round(w); cn.height=Math.round(h);
    const ctx=cn.getContext("2d"); ctx.fillStyle="#000"; ctx.fillRect(0,0,cn.width,cn.height);

    if(shot.type==="image"){
      const img=await loadImage(shot.src);
      drawCover(ctx,img,cn.width,cn.height);
      if(shot.meta.sketch){ try{ const ov=await loadImage(shot.meta.sketch); drawCover(ctx,ov,cn.width,cn.height); }catch{} }
    }else{
      // Try to draw first frame
      try{
        const v=document.createElement("video"); v.src=shot.src; await v.play().catch(()=>{}); v.pause();
        drawCover(ctx,v,cn.width,cn.height);
      }catch{
        // placeholder
        ctx.fillStyle="#111"; ctx.fillRect(0,0,cn.width,cn.height);
      }
    }
    return cn.toDataURL("image/jpeg",0.82);
  }
  function drawCover(ctx,media,w,h){
    const iw=media.videoWidth||media.naturalWidth||w, ih=media.videoHeight||media.naturalHeight||h;
    const ir=iw/ih, r=w/h; let dw,dh;
    if(ir>r){ dh=h; dw=ir*dh; } else { dw=w; dh=dw/ir; }
    const dx=(w-dw)/2, dy=(h-dh)/2; ctx.drawImage(media,dx,dy,dw,dh);
  }
}

/* ---------------- Utility ---------------- */
function div(cls,txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }

})(); // end IIFE
