/* Storyboard App — full build
   - Comic / Board / Presentation
   - Editor w/ movements, transitions, dialogue, notes, voice notes
   - Transition chips, trailing add box
   - Multi-Project (IndexedDB) + Project Picker
   - Home / Switch Project hooks
   - Replace / Delete inside Editor and in Board cards
   - MP4 export with ffmpeg.wasm (+ progress UI + voice-note & clip audio mix)
   - WebM fallback with progress
*/

(() => {
  // =========================
  // Small helpers
  // =========================
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const uid = (p="p_") => p + Math.random().toString(36).slice(2,10);
  const sanitize = s => String(s||"").replace(/[^\w\-]+/g,'_').slice(0,60);
  const esc = s => String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const sleep = ms => new Promise(r=>setTimeout(r, ms));
  const debounce = (fn, ms=350)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

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

  // =========================
  // Toasts & Progress modal
  // =========================
  function toast(msg, ms=2000){
    let host = document.getElementById("toasts");
    if(!host){
      host = document.createElement("div");
      host.id = "toasts";
      host.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:20px;display:grid;gap:8px;z-index:22000";
      document.body.appendChild(host);
    }
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "background:#111826cc;border:1px solid #2a3243;color:#e8ecf3;padding:10px 12px;border-radius:10px;backdrop-filter:blur(8px);";
    host.appendChild(t);
    setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .25s"; setTimeout(()=>host.removeChild(t), 250); }, ms);
  }

  let progEl = null;
  function progressOpen(title="Exporting…"){
    if(progEl) return;
    progEl = document.createElement("div");
    progEl.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:21000;display:grid;place-items:center">
        <div style="width:min(520px,92vw);background:#151a22;border:1px solid #2a3243;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="font-size:16px">${title}</strong>
            <button id="xProg" style="border:1px solid #2a3243;background:#0f1420;color:#e8ecf3;border-radius:10px;padding:6px 10px">Hide</button>
          </div>
          <div id="progStep" style="color:#9aa6bd;margin-bottom:8px">Preparing…</div>
          <div style="height:10px;background:#0f1420;border:1px solid #2a3243;border-radius:999px;overflow:hidden">
            <div id="progBar" style="height:100%;width:0%;background:linear-gradient(90deg,#6aa1ff,#87b4ff)"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(progEl);
    $("#xProg").onclick = ()=> { progEl.style.display="none"; };
  }
  function progressUpdate(step, ratio){
    if(!progEl) return;
    const s = progEl.querySelector("#progStep");
    const b = progEl.querySelector("#progBar");
    if(s) s.textContent = step;
    if(b && typeof ratio==="number") b.style.width = Math.round(ratio*100)+"%";
  }
  function progressClose(){ if(!progEl) return; progEl.remove(); progEl=null; }

  // =========================
  // State & Models
  // =========================
  const defaultMeta = () => ({
    lens: "50mm",
    shotType: "MS",
    movements: [],
    transition: "Cut",
    dialogue: "",
    notes: "",
    voiceNote: null // { dataUrl, duration, mime }
  });
  const makeShot = ({ type="image", src="", filename="shot", meta } = {}) =>
    ({ id: uid("s_"), type, src, filename, meta: meta || defaultMeta() });

  const state = {
    projectName: "",
    scenes: [],                  // [{id, name, shots:[Shot|null]}]
    currentProjectId: null,
    editRef: null,               // {sceneId, shotId}
    pendingReplace: null,        // {sceneId, shotId|"__empty__"}
    flatIndex: []
  };

  // =========================
  // IndexedDB Projects
  // =========================
  const DB_NAME="sb_vault", DB_VER=1, STORE="projects";

  function openDB(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = ()=> {
        const db = r.result;
        if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      r.onsuccess = ()=> res(r.result); r.onerror = ()=> rej(r.error);
    });
  }
  async function dbPut(rec){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(rec); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
  async function dbGet(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const q=tx.objectStore(STORE).get(id); q.onsuccess=()=>res(q.result||null); q.onerror=()=>rej(q.error); }); }
  async function dbList(){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const q=tx.objectStore(STORE).getAll(); q.onsuccess=()=>{ const arr=q.result||[]; arr.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)); res(arr); }; q.onerror=()=>rej(q.error); }); }
  async function dbDelete(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
  function emptyProjectRecord(id,name){ return { id, name, createdAt:Date.now(), updatedAt:Date.now(), cover:null, data:{ projectName:name, scenes:[] } }; }
  function firstCoverFrom(data){ for(const s of (data.scenes||[])){ for(const sh of s.shots||[]){ if(sh){ return sh.src; } } } return null; }

  // =========================
  // Elements
  // =========================
  const homeBtn         = $("#homeBtn");
  const menuBtn         = $("#menuBtn");
  const sheet           = $("#sheet");
  const closeSheetBtn   = $("#closeSheet");
  const addSceneBtn     = $("#addSceneBtn");
  const addShotsBtn     = $("#addShotsBtn");
  const switchProjectBtn= $("#switchProjectBtn");
  const renderFilmBtn   = $("#renderFilmBtn");
  const importBtn       = $("#importBtn");
  const exportBtn       = $("#exportBtn");
  const clearBtn        = $("#clearBtn");
  const projectNameInp  = $("#projectName");

  const presentBtn      = $("#presentBtn");
  const viewToggle      = $("#viewToggle");
  const comicView       = $("#comicView");
  const scenesWrap      = $("#scenes");
  const boardView       = $("#boardView");
  const dropzone        = $("#dropzone");
  const gallery         = $("#gallery");

  const editor          = $("#editor");
  const editorTitle     = $("#editorTitle");
  const closeEditor     = $("#closeEditor");
  const edLens          = $("#edLens");
  const edShotType      = $("#edShotType");
  const edTransition    = $("#edTransition");
  const edMoves         = $("#edMoves");
  const edDialogue      = $("#edDialogue");
  const edNotes         = $("#edNotes");
  const recBtn          = $("#recBtn");
  const playNoteBtn     = $("#playNoteBtn");
  const recStatus       = $("#recStatus");
  const edReplace       = $("#edReplace");
  const edDelete        = $("#edDelete");

  const transPicker     = $("#transPicker");
  const transOptions    = $("#transOptions");
  const closeTrans      = $("#closeTrans");

  const player          = $("#player");
  const stage           = player?.querySelector(".stage");
  const stageMedia      = player?.querySelector(".stage-media");
  const ovTL            = $("#ovTopLeft");
  const ovTR            = $("#ovTopRight");
  const ovB             = $("#ovBottom");
  const prevBtn         = $("#prevBtn");
  const nextBtn         = $("#nextBtn");
  const fsBtn           = $("#fsBtn");
  const closePlayer     = $("#closePlayer");

  const fileMulti       = $("#fileMulti");
  const fileSingle      = $("#fileSingle");
  const importFile      = $("#importFile");

  // Project picker overlay (injected by earlier code or HTML); define refs if present
  let picker = $("#picker");
  if(!picker){
    picker = document.createElement("div");
    picker.id="picker";
    picker.style.cssText="position:fixed;inset:0;background:#0f1115;display:none;z-index:15000;color:#e8ecf3";
    picker.innerHTML = `
      <div style="position:sticky;top:0;padding:12px 14px;background:rgba(12,16,22,.9);border-bottom:1px solid #2a3243;backdrop-filter:blur(10px);display:flex;justify-content:space-between;align-items:center">
        <strong>Projects</strong>
        <div>
          <button id="newProjBtn" class="seg">New</button>
          <button id="importProjBtn" class="seg">Import JSON</button>
        </div>
      </div>
      <div id="pickerGrid" style="padding:12px;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))"></div>
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
    // Home/Projects
    on(homeBtn, "click", showPicker);
    on(switchProjectBtn, "click", ()=>{ closeSheet(sheet); showPicker(); });

    // Menu sheet
    on(menuBtn, "click", ()=> openSheet(sheet));
    on(sheet, "click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheet(sheet); });
    on(closeSheetBtn, "click", ()=> closeSheet(sheet));

    on(addSceneBtn, "click", ()=>{ addScene(); renderAll(); persistDebounced(); closeSheet(sheet); });
    on(addShotsBtn, "click", ()=>{ state.pendingReplace=null; fileMulti?.click(); });
    on(renderFilmBtn, "click", async ()=>{ closeSheet(sheet); await exportFilmSmart(); });
    on(importBtn, "click", ()=> importFile?.click());
    on(exportBtn, "click", exportJSONCurrent);
    on(clearBtn, "click", clearAll);
    on(projectNameInp, "input", ()=>{ state.projectName = projectNameInp.value.trim(); persistDebounced(); });

    // Views
    on(viewToggle, "click", ()=>{
      const comic = !comicView.classList.contains("hidden");
      if(comic){ comicView.classList.add("hidden"); boardView.classList.remove("hidden"); viewToggle.textContent="Board ▾"; buildGallery(); }
      else { boardView.classList.add("hidden"); comicView.classList.remove("hidden"); viewToggle.textContent="Comic ▾"; }
    });

    // Dropzone
    on(dropzone,"click", ()=>{ state.pendingReplace=null; fileMulti?.click(); });
    on(dropzone,"keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); dropzone.click(); }});
    ["dragenter","dragover"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.add("dragover"); }));
    ["dragleave","drop"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.remove("dragover"); }));
    on(dropzone,"drop", e=>{ const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

    // Files
    on(fileMulti, "change", e=> addFilesToScene(e.target.files));
    on(fileSingle,"change", e=> replaceSingle(e.target.files?.[0]||null));
    on(importFile,"change", e=> importProjectJSON(e.target.files?.[0]||null));

    // Editor
    on(editor, "click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheet(editor); });
    on(closeEditor,"click", ()=> closeSheet(editor));
    on(edLens, "change", saveEditor);
    on(edShotType,"change", saveEditor);
    on(edTransition,"change", saveEditor);
    on(edDialogue,"input", saveEditor);
    on(edNotes,"input", saveEditor);

    if(edMoves && !edMoves.dataset._init){
      ["Pan","Tilt","Zoom","Dolly","Truck","Pedestal","Handheld","Static","Rack Focus"].forEach(m=>{
        const b=document.createElement("button"); b.type="button"; b.className="tag"; b.textContent=m; b.dataset.mov=m;
        b.onclick = ()=>{ b.classList.toggle("active"); saveEditor(); };
        edMoves.appendChild(b);
      });
      edMoves.dataset._init="1";
    }

    // Editor Replace/Delete
    on(edReplace,"click", ()=>{
      if(!state.editRef) return;
      state.pendingReplace = { sceneId: state.editRef.sceneId, shotId: state.editRef.shotId };
      fileSingle?.click();
    });
    on(edDelete,"click", ()=>{
      if(!state.editRef) return;
      const {sceneId, shotId} = state.editRef;
      deleteShot(sceneId, shotId); closeSheet(editor); toast("Shot deleted");
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
        b.onclick = ()=>{ if(_transTarget) setShotMeta(_transTarget,{transition:t}); closeSheet(transPicker); };
        transOptions.appendChild(b);
      });
      transOptions.dataset._init="1";
    }

    // Presentation
    on(presentBtn,"click", openPresentation);
    on(prevBtn,"click", ()=> showAt(curIdx-1));
    on(nextBtn,"click", ()=> showAt(curIdx+1));
    on(fsBtn,"click", ()=>{ if(!document.fullscreenElement) player?.requestFullscreen?.(); else document.exitFullscreen?.(); });
    on(closePlayer,"click", closePresentation);
    on(stage,"click", ()=>{
      const v = stageMedia?.firstElementChild;
      if(v && v.tagName==="VIDEO" && !v.controls){ if(v.paused) v.play().catch(()=>{}); else v.pause(); }
    });
    document.addEventListener("keydown", e=>{
      if(!player?.classList.contains("open")) return;
      if(e.key==="ArrowRight") showAt(curIdx+1);
      if(e.key==="ArrowLeft")  showAt(curIdx-1);
      if(e.key==="Escape")     closePresentation();
    });

    // Picker
    on(newProjBtn,"click", async ()=>{
      const id = uid("p_"); const rec = emptyProjectRecord(id,"Untitled");
      await dbPut(rec); await openProject(id); hidePicker();
    });
    on(importProjBtn,"click", ()=> pickerImport.click());
    on(pickerImport,"change", async e=>{
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

  // =========================
  // Boot / Picker
  // =========================
  async function boot(){
    const m = location.hash.match(/#p\/([\w\-]+)/);
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
      card.querySelector(".open").onclick   = async ()=>{ await openProject(it.id); hidePicker(); };
      card.querySelector(".rename").onclick = async ()=>{ const nn=prompt("Rename project:", it.name); if(!nn) return; it.name=nn; it.updatedAt=Date.now(); await dbPut(it); showPicker(); };
      card.querySelector(".dup").onclick    = async ()=>{ const id2=uid("p_"); const rec=JSON.parse(JSON.stringify(it)); rec.id=id2; rec.name=it.name+" (copy)"; rec.createdAt=Date.now(); rec.updatedAt=Date.now(); await dbPut(rec); showPicker(); };
      card.querySelector(".export").onclick = ()=> downloadBlob(JSON.stringify(it.data,null,2), sanitize(it.name)+".json", "application/json");
      card.querySelector(".del").onclick    = async ()=>{ if(confirm(`Delete “${it.name}”?`)){ await dbDelete(it.id); showPicker(); } };
    }
    picker.style.display="block"; document.body.classList.add("sheet-open");
  }
  function hidePicker(){ picker.style.display="none"; document.body.classList.remove("sheet-open"); }

  async function openProject(id){
    const rec = await dbGet(id);
    if(!rec){ alert("Project not found"); return; }
    state.currentProjectId = id;
    state.projectName = rec.data.projectName || rec.name || "Untitled";
    state.scenes = Array.isArray(rec.data.scenes) ? rec.data.scenes : [];
    location.hash = "#p/"+id;
    renderAll();
  }

  async function persistProject(){
    if(!state.currentProjectId) return;
    const id=state.currentProjectId;
    const cur = await dbGet(id) || emptyProjectRecord(id, state.projectName||"Untitled");
    cur.name = state.projectName || cur.name;
    cur.updatedAt = Date.now();
    cur.data = { projectName: state.projectName, scenes: state.scenes };
    cur.cover = firstCoverFrom(cur.data) || cur.cover || null;
    await dbPut(cur);
  }
  const persistDebounced = debounce(persistProject, 500);

  // =========================
  // Scene / Shot ops
  // =========================
  function addScene(){ const idx=state.scenes.length+1; state.scenes.push({ id:uid("sc_"), name:`Scene ${idx}`, shots:[] }); }
  function ensureTrailingEmpty(scene){ if(scene.shots.length===0 || scene.shots[scene.shots.length-1]!==null){ scene.shots.push(null); } }
  function getScene(id){ return state.scenes.find(s=> s.id===id); }
  function getShot(sceneId, shotId){ return getScene(sceneId)?.shots.find(s=> s && s.id===shotId) || null; }

  async function addFilesToScene(fileList){
    const files=[...fileList].filter(f=>/^image\/|^video\//.test(f.type));
    if(files.length===0) return;
    const target = state.pendingReplace ? getScene(state.pendingReplace.sceneId) : state.scenes[state.scenes.length-1] || (addScene(), state.scenes[0]);
    for(const f of files){
      const dataUrl = await fileToDataURL(f);
      const shot = makeShot({ type:f.type.startsWith("video")?"video":"image", src:dataUrl, filename:f.name||"shot" });
      const emptyIdx = target.shots.findIndex(s=> s===null);
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
      const sc=getScene(sceneId);
      const idx=sc?.shots.findIndex(s=> s && s.id===shotId);
      if(idx>=0){
        sc.shots[idx]=makeShot({ type:file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name||"shot" });
        ensureTrailingEmpty(sc);
      }
    }else{
      await addFilesToScene([file]);
    }
    state.pendingReplace=null; renderAll(); persistDebounced(); if(fileSingle) fileSingle.value="";
  }

  function deleteShot(sceneId, shotId){
    const sc=getScene(sceneId); if(!sc) return;
    const idx=sc.shots.findIndex(s=> s && s.id===shotId);
    if(idx>=0) sc.shots.splice(idx,1);
    ensureTrailingEmpty(sc); renderAll(); persistDebounced();
  }

  // =========================
  // Render — Comic
  // =========================
  function renderAll(){
    scenesWrap.innerHTML="";
    state.scenes.forEach(scene=>{
      ensureTrailingEmpty(scene);
      scenesWrap.appendChild(renderScene(scene));
    });
    projectNameInp.value = state.projectName || "";
    if(!boardView.classList.contains("hidden")) buildGallery();
  }

  let _transTarget=null;
  function renderScene(scene){
    const wrap = div("scene");

    const head = div("scene-head");
    const title = div("scene-title", scene.name);
    title.contentEditable="true"; title.spellcheck=false;
    on(title,"input", debounce(()=>{ scene.name=(title.textContent||"").trim()||scene.name; persistDebounced(); },250));
    head.appendChild(title);
    const actions = div("scene-actions");
    actions.appendChild(smallBtn("📥 Shots", ()=>{ state.pendingReplace=null; fileMulti?.click(); }));
    head.appendChild(actions);
    wrap.appendChild(head);

    const strip = div("strip");
    scene.shots.forEach((shot, idx)=>{
      if(shot){
        strip.appendChild(renderShot(scene, shot));
        if(idx < scene.shots.length-1){
          const chip=div("trans-chip");
          const b=document.createElement("button"); b.textContent=shot.meta?.transition||"Cut";
          b.onclick=()=>{ _transTarget=shot.id; openSheet(transPicker); };
          chip.appendChild(b); strip.appendChild(chip);
        }
      }else{
        const card=div("shot empty");
        card.innerHTML=`<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
        card.onclick=()=>{ state.pendingReplace={sceneId:scene.id, shotId:"__empty__"}; fileSingle?.click(); };
        strip.appendChild(card);
      }
    });
    on(strip,"dragover", e=> e.preventDefault());
    wrap.appendChild(strip);
    return wrap;
  }

  function renderShot(scene, shot){
    const card=div("shot"); card.draggable=true;

    const t=div("thumb");
    if(shot.type==="image"){ const img=new Image(); img.src=shot.src; img.alt=shot.filename; t.appendChild(img); }
    else{
      const v=document.createElement("video");
      v.src=shot.src; v.playsInline=true; v.muted=true; v.controls=false;
      on(v,"mouseenter",()=>v.play().catch(()=>{})); on(v,"mouseleave",()=>v.pause());
      t.appendChild(v);
    }
    const badge=div("badge", shot.type.toUpperCase()); t.appendChild(badge);

    const meta=div("meta"); meta.innerHTML=`<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;
    const overlay=div("overlay-info"); overlay.textContent=shot.meta.dialogue||shot.meta.notes||`${shot.meta.lens} · ${shot.meta.shotType}`;

    card.appendChild(t); card.appendChild(meta); card.appendChild(overlay);

    card.onclick=(e)=>{ if(e.target.closest(".meta")){ card.classList.toggle("show-info"); return; } openEditor(scene.id, shot.id); };

    longPress(card, 450, async ()=>{
      const opt = await mobilePrompt(["Replace","Duplicate","Delete","Cancel"]);
      if(opt==="Replace"){ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle?.click(); }
      else if(opt==="Duplicate"){ const sc=getScene(scene.id); const idx=sc.shots.findIndex(s=>s&&s.id===shot.id); sc.shots.splice(idx+1,0, JSON.parse(JSON.stringify(shot))); ensureTrailingEmpty(sc); renderAll(); persistDebounced(); }
      else if(opt==="Delete"){ deleteShot(scene.id, shot.id); }
    });

    // DnD within scene
    card.addEventListener("dragstart", e=>{
      e.dataTransfer.setData("text/plain", JSON.stringify({sceneId:scene.id, shotId:shot.id}));
      setTimeout(()=> card.classList.add("dragging"),0);
    });
    card.addEventListener("dragend", ()=> card.classList.remove("dragging"));
    card.addEventListener("drop", e=>{
      e.preventDefault();
      const data = JSON.parse(e.dataTransfer.getData("text/plain")||"{}");
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
  // Board View
  // =========================
  function buildGallery(){
    gallery.innerHTML="";
    state.scenes.forEach(scene=>{
      scene.shots.filter(Boolean).forEach(shot=>{
        const wrap=div("gallery-item");
        const media=div("gallery-media");
        if(shot.type==="image"){ const img=new Image(); img.src=shot.src; media.appendChild(img); }
        else{ const v=document.createElement("video"); v.src=shot.src; v.controls=true; v.playsInline=true; v.style.width="100%"; v.style.height="auto"; v.style.objectFit="contain"; media.appendChild(v); }
        wrap.appendChild(media);

        const meta=div("gallery-meta");
        meta.innerHTML = `<div><strong>${esc(scene.name)}</strong> — ${esc(shot.filename)}</div>`;
        const actions=document.createElement("div");
        actions.style.display="flex"; actions.style.gap="6px"; actions.style.marginTop="8px";
        const editBtn=document.createElement("button"); editBtn.className="small-btn"; editBtn.textContent="Edit details"; editBtn.onclick=()=> openEditor(scene.id, shot.id);
        const repBtn=document.createElement("button"); repBtn.className="small-btn"; repBtn.textContent="Replace"; repBtn.onclick=()=>{ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle?.click(); };
        const delBtn=document.createElement("button"); delBtn.className="small-btn danger"; delBtn.textContent="Delete"; delBtn.onclick=()=> deleteShot(scene.id, shot.id);
        actions.appendChild(editBtn); actions.appendChild(repBtn); actions.appendChild(delBtn);
        meta.appendChild(actions);
        wrap.appendChild(meta);
        gallery.appendChild(wrap);
      });
    });
  }

  // =========================
  // Editor
  // =========================
  function openEditor(sceneId, shotId){
    state.editRef = {sceneId, shotId};
    const shot = getShot(sceneId, shotId); if(!shot) return;
    editorTitle.textContent = `Edit • ${shot.filename}`;
    edLens.value       = shot.meta.lens || "50mm";
    edShotType.value   = shot.meta.shotType || "MS";
    edTransition.value = shot.meta.transition || "Cut";
    edDialogue.value   = shot.meta.dialogue || "";
    edNotes.value      = shot.meta.notes || "";
    [...edMoves.querySelectorAll(".tag")].forEach(b=> b.classList.toggle("active", !!shot.meta.movements?.includes(b.dataset.mov)));
    if(shot.meta.voiceNote){ recStatus.textContent=`Voice note • ${formatTime(shot.meta.voiceNote.duration)}`; playNoteBtn.disabled=false; } else { recStatus.textContent="No voice note"; playNoteBtn.disabled=true; }
    openSheet(editor);
  }
  function saveEditor(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
    shot.meta.lens       = edLens.value;
    shot.meta.shotType   = edShotType.value;
    shot.meta.transition = edTransition.value;
    shot.meta.dialogue   = edDialogue.value;
    shot.meta.notes      = edNotes.value;
    shot.meta.movements  = [...edMoves.querySelectorAll(".tag.active")].map(b=>b.dataset.mov);
    persistDebounced(); renderAll();
  }

  // Voice notes
  let mediaRec=null, recChunks=[], recStart=0;
  async function toggleRecord(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
    if(mediaRec && mediaRec.state==="recording"){ mediaRec.stop(); return; }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      recChunks=[]; mediaRec=new MediaRecorder(stream);
      mediaRec.ondataavailable = e=> { if(e.data.size) recChunks.push(e.data); };
      mediaRec.onstart = ()=>{ recStart=Date.now(); recStatus.textContent="Recording… tap to stop"; recBtn.textContent="⏹ Stop"; };
      mediaRec.onstop = async ()=>{
        const blob = new Blob(recChunks, {type: mediaRec.mimeType || "audio/webm"});
        const dataUrl = await blobToDataURL(blob);
        const dur = (Date.now()-recStart)/1000;
        shot.meta.voiceNote = { dataUrl, duration: dur, mime: blob.type };
        recStatus.textContent=`Saved • ${formatTime(dur)}`; playNoteBtn.disabled=false; recBtn.textContent="🎙 Record";
        persistDebounced();
      };
      mediaRec.start();
    }catch(err){ alert("Mic access failed: "+err.message); }
  }
  function blobToDataURL(blob){ return new Promise((res)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(blob); }); }
  function playVoiceNote(){ const shot=getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot?.meta.voiceNote) return; new Audio(shot.meta.voiceNote.dataUrl).play().catch(()=>{}); }

  function setShotMeta(shotId, patch){ state.scenes.forEach(s=> s.shots.forEach(sh=>{ if(sh && sh.id===shotId) Object.assign(sh.meta, patch); })); persistDebounced(); renderAll(); }

  // =========================
  // Presentation
  // =========================
  let curIdx=0;
  function openPresentation(){ state.flatIndex=flattenShots(); if(state.flatIndex.length===0) return; curIdx=0; player.classList.add("open"); player.setAttribute("aria-hidden","false"); showAt(0); }
  function closePresentation(){ player.classList.remove("open"); player.setAttribute("aria-hidden","true"); stageMedia.innerHTML=""; }
  function flattenShots(){ const arr=[]; state.scenes.forEach(s=> s.shots.filter(Boolean).forEach(sh=> arr.push({scene:s, shot:sh}))); return arr; }
  function showAt(i){
    const n=state.flatIndex.length; curIdx=(i%n+n)%n;
    const {scene, shot} = state.flatIndex[curIdx];
    stageMedia.innerHTML="";
    let el;
    if(shot.type==="image"){ el=new Image(); el.src=shot.src; el.alt=shot.filename; }
    else{
      el=document.createElement("video");
      el.src=shot.src; el.autoplay=true; el.loop=false; el.muted=false; el.controls=false;
      el.setAttribute("playsinline",""); el.setAttribute("webkit-playsinline","");
      el.style.width="100%"; el.style.height="100%"; el.style.objectFit="contain";
      const resume=()=>{ el.play().catch(()=>{}); stage.removeEventListener("click", resume); };
      el.addEventListener("loadeddata", ()=> el.play().catch(()=>{}), {once:true});
      stage.addEventListener("click", resume, {once:true});
    }
    stageMedia.appendChild(el);
    ovTL.textContent=scene.name;
    ovTR.textContent=`${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
    ovB.textContent=shot.meta.dialogue || shot.meta.notes || "";
  }

  // =========================
  // Export (MP4 w/ progress + audio mix) + WebM fallback
  // =========================
  async function exportFilmSmart(){
    toast("Export started");
    if(await ensureFFmpeg()){ await exportFilmMP4(); }
    else{ await exportFilmWebM(); }
  }

  // ffmpeg loader
  let FF=null, ffmpeg=null;
  async function importScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=()=>res(); s.onerror=rej; document.head.appendChild(s); }); }
  async function ensureFFmpeg(){
    if(ffmpeg) return true;
    try{
      if(!window.FFmpeg){
        await importScript("./vendor/ffmpeg/ffmpeg.min.js")
          .catch(()=>importScript("https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js"));
      }
      const { createFFmpeg, fetchFile } = window.FFmpeg || window;
      ffmpeg = createFFmpeg({ log:false, corePath: "./vendor/ffmpeg/ffmpeg-core.js" });
      ffmpeg._fetchFile = fetchFile;
      ffmpeg.setProgress(({ratio})=> progressUpdate("Encoding…", ratio||0));
      if(!ffmpeg.isLoaded()){ progressOpen("Loading encoder…"); await ffmpeg.load(); progressUpdate("Encoder ready", 1); }
      return true;
    }catch(e){ console.warn("ffmpeg load failed", e); toast("Couldn’t load MP4 encoder — falling back to WebM."); return false; }
    finally{ progressClose(); }
  }

  async function exportFilmMP4(){
    const flat=flattenShots(); if(flat.length===0){ toast("Add shots first"); return; }
    progressOpen("Exporting MP4…"); progressUpdate("Preparing parts…", 0);

    const width=1280, height=720, fps=30;
    let idx=0; const parts=[];

    // 1) Picture-only segments
    for(const {shot} of flat){
      idx++;
      if(shot.type==="image"){
        const img=`img_${idx}.jpg`;
        ffmpeg.FS('writeFile', img, dataURLtoUint8(shot.src));
        const dur=Math.max(7, shot.meta.voiceNote?.duration||0);
        const out=`part_${idx}.mp4`;
        progressUpdate(`Image ${idx}: ${dur.toFixed(1)}s`, 0);
        await ffmpeg.run('-loop','1','-t', String(dur), '-i', img,
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', String(fps), '-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline','-an', out);
        parts.push(out);
      }else{
        const inName=`clip_${idx}.mp4`;
        ffmpeg.FS('writeFile', inName, dataURLtoUint8(shot.src));
        const out=`part_${idx}.mp4`;
        progressUpdate(`Video ${idx}: picture re-encode`, 0);
        await ffmpeg.run('-i', inName, '-t','7',
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', String(fps), '-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline','-an', out);
        parts.push(out);
      }
    }

    // 2) Concat picture
    progressUpdate("Concatenating picture…", 0.3);
    ffmpeg.FS('writeFile','concat.txt', strToUint8(parts.map(p=>`file '${p}'`).join('\n')));
    await ffmpeg.run('-f','concat','-safe','0','-i','concat.txt','-c','copy','temp_video.mp4');

    // 3) Audio mix: voice notes + clip audio
    progressUpdate("Mixing audio…", 0.5);
    const wav = await buildFullAudioTrack(flat);
    if(wav){ ffmpeg.FS('writeFile','audio.wav', wav); progressUpdate("Muxing MP4…", 0.8); await ffmpeg.run('-i','temp_video.mp4','-i','audio.wav','-c:v','copy','-c:a','aac','-shortest','out.mp4'); }
    else { await ffmpeg.run('-i','temp_video.mp4','-c','copy','out.mp4'); }

    const mp4 = ffmpeg.FS('readFile','out.mp4');
    const fileName = (sanitize(state.projectName)||"storyboard")+"_film.mp4";
    const blob = new Blob([mp4.buffer], {type:'video/mp4'});

    progressUpdate("Finalizing…", 0.95);
    try{
      if(navigator.canShare && navigator.canShare({ files:[new File([blob], fileName, {type:'video/mp4'})] })){
        await navigator.share({ files:[new File([blob], fileName, {type:'video/mp4'})], title:fileName, text:'Storyboard export' });
        toast("Shared — choose ‘Save Video’ to add to Photos");
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

  // Build stereo WAV track including voice notes and original clip audio
  async function buildFullAudioTrack(flat){
    const sr=48000;
    let total=0;
    for(const {shot} of flat){ total += (shot.type==="image") ? Math.max(7, shot.meta.voiceNote?.duration || 0) : 7; }
    if(total<=0) return null;

    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if(!Offline) return null;
    const ctx = new Offline(2, Math.ceil(total*sr), sr);

    let t=0;
    for(const {shot} of flat){
      const dur = (shot.type==="image") ? Math.max(7, shot.meta.voiceNote?.duration || 0) : 7;

      // voice note
      if(shot.type==="image" && shot.meta.voiceNote?.dataUrl){
        try{
          const ab = await fetch(shot.meta.voiceNote.dataUrl).then(r=>r.arrayBuffer());
          const buf = await ctx.decodeAudioData(ab);
          const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(t);
        }catch{}
      }
      // clip audio (trim natural to ~7s)
      if(shot.type==="video"){
        try{
          const ab = await fetch(shot.src).then(r=>r.arrayBuffer());
          const buf = await ctx.decodeAudioData(ab);
          const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
          src.start(t); // you can src.stop(t+7) if needed
        }catch{}
      }
      t += dur;
    }

    const rendered = await ctx.startRendering();
    return audioBufferToWavBytes(rendered);
  }

  async function exportFilmWebM(){
    const flat=flattenShots(); if(flat.length===0){ toast("Add shots first"); return; }
    progressOpen("Exporting (fallback WebM)…");

    const fps=30, width=1280, height=720;
    const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=height;
    const ctx=canvas.getContext("2d");
    const stream = canvas.captureStream(fps);
    let chunks=[]; let rec;
    try{ rec=new MediaRecorder(stream,{mimeType:"video/webm;codecs=vp9"}); }
    catch{ try{ rec=new MediaRecorder(stream,{mimeType:"video/webm;codecs=vp8"}); } catch{ progressClose(); alert("Recording not supported"); return; } }
    rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
    const done=new Promise(res=> rec.onstop=res);
    rec.start();

    function drawCover(media){
      const iw=media.videoWidth||media.naturalWidth||width, ih=media.videoHeight||media.naturalHeight||height;
      const ir=iw/ih, r=width/height; let dw,dh; if(ir>r){ dh=height; dw=ir*dh; } else { dw=width; dh=dw/ir; }
      const dx=(width-dw)/2, dy=(height-dh)/2; ctx.fillStyle="#000"; ctx.fillRect(0,0,width,height); ctx.drawImage(media,dx,dy,dw,dh);
    }
    function drawOverlays(scene,shot){
      ctx.save(); ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(10,10,320,28); ctx.fillStyle="#e9eef9"; ctx.font="700 16px system-ui"; ctx.fillText(scene.name,18,30); ctx.restore();
      const txt=`${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
      ctx.save(); ctx.font="700 16px system-ui"; const tw=ctx.measureText(txt).width+24; ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(width-tw-10,10,tw,28); ctx.fillStyle="#e9eef9"; ctx.fillText(txt,width-tw+2,30); ctx.restore();
      if(shot.meta.dialogue || shot.meta.notes){
        const text=shot.meta.dialogue||shot.meta.notes;
        ctx.save(); ctx.fillStyle="rgba(0,0,0,.6)"; ctx.fillRect(0,height-80,width,80); ctx.fillStyle="#e9eef9"; ctx.font="700 20px system-ui";
        wrapText(ctx,text,width-60).forEach((ln,i)=> ctx.fillText(ln,30,height-50+i*24)); ctx.restore();
      }
    }
    function wrapText(ctx,text,maxW){ const words=String(text||"").split(/\s+/); const lines=[]; let line=""; ctx.font="700 20px system-ui"; for(const w of words){ const t=line?line+" "+w:w; if(ctx.measureText(t).width>maxW){ if(line) lines.push(line); line=w; } else line=t; } if(line) lines.push(line); return lines; }
    const wait=()=>sleep(1000/fps);

    let processed=0;
    for(const {scene,shot} of flat){
      processed++; progressUpdate(`Rendering ${processed}/${flat.length}`, processed/flat.length*0.9);
      if(shot.type==="image"){
        const img=await loadImage(shot.src);
        const hold=Math.max(7, shot.meta.voiceNote?.duration||0);
        const frames=Math.max(1, Math.round(fps*hold));
        for(let f=0; f<frames; f++){ drawCover(img); drawOverlays(scene,shot); await wait(); }
      }else{
        const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; await v.play().catch(()=>{});
        const endAt=performance.now()+7000;
        while(performance.now()<endAt){ drawCover(v); drawOverlays(scene,shot); await wait(); }
        v.pause();
      }
    }
    rec.stop(); await done; progressUpdate("Preparing download…", 0.98);
    const blob=new Blob(chunks,{type:rec.mimeType||"video/webm"});
    downloadBlob(blob, (sanitize(state.projectName)||"storyboard")+"_film.webm", blob.type);
    progressClose(); toast("WebM downloaded — some apps can’t play WebM; use MP4 when possible.");
  }

  // helpers for ffmpeg
  function strToUint8(s){ return new TextEncoder().encode(s); }
  function dataURLtoUint8(dataUrl){ const [,b64]=dataUrl.split(','); const bin=atob(b64); const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return bytes; }
  function audioBufferToWavBytes(ab){
    const ch=ab.numberOfChannels, sr=ab.sampleRate, len=ab.length, bps=16, bytesPer= bps/8, block= ch*bytesPer;
    const buffer=new ArrayBuffer(44 + len*ch*bytesPer); const view=new DataView(buffer);
    write(0,'RIFF'); view.setUint32(4,36+len*ch*bytesPer,true); write(8,'WAVE'); write(12,'fmt '); view.setUint32(16,16,true);
    view.setUint16(20,1,true); view.setUint16(22,ch,true); view.setUint32(24,sr,true); view.setUint32(28,sr*block,true); view.setUint16(32,block,true); view.setUint16(34,bps,true);
    write(36,'data'); view.setUint32(40,len*ch*bytesPer,true);
    let off=44; const data=[]; for(let c=0;c<ch;c++) data.push(ab.getChannelData(c));
    for(let i=0;i<len;i++){ for(let c=0;c<ch;c++){ let s=Math.max(-1,Math.min(1,data[c][i])); view.setInt16(off, s<0?s*0x8000:s*0x7FFF, true); off+=2; } }
    return new Uint8Array(buffer);
    function write(off,str){ for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i)); }
  }

  function exportJSONCurrent(){ const payload={ schema:"storyboard_v4", exportedAt:new Date().toISOString(), projectName:state.projectName||"Untitled", scenes:state.scenes }; downloadBlob(JSON.stringify(payload,null,2), (sanitize(state.projectName)||"storyboard")+".json", "application/json"); }
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
  function clearAll(){ if(confirm("Clear all scenes in this project?")){ state.projectName=""; state.scenes=[]; addScene(); renderAll(); persistProject(); } }

  // Small DOM helpers & sheets
  function div(cls, txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
  function smallBtn(label, onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.onclick=onClick; return b; }
  function mobilePrompt(options){ return new Promise(resolve=>{ const overlay=document.createElement("div"); overlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:end center;z-index:20000;"; const sheet=document.createElement("div"); sheet.style.cssText="width:100%;max-width:640px;background:#151a22;border-top-left-radius:16px;border-top-right-radius:16px;border:1px solid #2a3243;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:8px;"; options.forEach(opt=>{ const b=document.createElement("button"); b.textContent=opt; b.style.cssText="width:100%;padding:14px 16px;background:#1a2130;border:1px solid #2a3243;color:#e8ecf3;border-radius:12px;margin:6px 8px;font-size:16px"; if(/delete/i.test(opt)) b.style.background="#3b2326"; sheet.appendChild(b); b.onclick=()=>{ document.body.removeChild(overlay); resolve(opt); }; }); overlay.onclick=(e)=>{ if(e.target===overlay){ document.body.removeChild(overlay); resolve("Cancel"); } }; overlay.appendChild(sheet); document.body.appendChild(overlay); }); }
  function openSheet(sh){ sh?.classList.add("show"); document.body.classList.add("sheet-open"); }
  function closeSheet(sh){ sh?.classList.remove("show"); document.body.classList.remove("sheet-open"); }
})();
