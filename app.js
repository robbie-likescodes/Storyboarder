/* Storyboard App — Comic + Board + Editor + Presentation + MP4 Export + Multi‑Project
   - MP4 export (ffmpeg.wasm) with WebM fallback
   - iPhone-friendly video sizing (playsinline, no controls mini-player)
   - IndexedDB multi-project storage with Project Picker (New/Open/Rename/Duplicate/Delete/Export/Import)
   - Voice notes per shot; transitions chips; always-trailing empty add box
*/

(() => {
  // =========================
  // Utils
  // =========================
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const uid = (p="p_") => p + Math.random().toString(36).slice(2,10);
  const sanitize = s => String(s||"").replace(/[^\w\-]+/g,'_').slice(0,60);
  const esc = s => String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const sleep = ms => new Promise(r=>setTimeout(r, ms));
  const debounce = (fn, ms=350)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

  function fileToDataURL(file){
    return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); });
  }
  function loadImage(src){ return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=src; }); }
  function longPress(el, ms, cb){ let t=null; on(el,"touchstart",()=>{ t=setTimeout(cb,ms); },{passive:true}); on(el,"touchend",()=>clearTimeout(t),{passive:true}); on(el,"touchmove",()=>clearTimeout(t),{passive:true}); on(el,"mousedown",()=>{ t=setTimeout(cb,ms); }); on(el,"mouseup",()=>clearTimeout(t)); on(el,"mouseleave",()=>clearTimeout(t)); }
  function downloadBlob(data, filename, type){
    const blob = data instanceof Blob ? data : new Blob([data], {type});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1200);
  }
  function formatTime(s){ s=Math.round(s); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,"0")}`; }

  // Simple prompt-like action picker (mobile friendly)
  function mobilePrompt(options){
    return new Promise(resolve=>{
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:end center;z-index:20000;";
      const sheet = document.createElement("div");
      sheet.style.cssText = "width:100%;max-width:640px;background:#151a22;border-top-left-radius:16px;border-top-right-radius:16px;border:1px solid #2a3243;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:8px;";
      options.forEach(opt=>{
        const b=document.createElement("button");
        b.textContent=opt; b.style.cssText="width:100%;padding:14px 16px;background:#1a2130;border:1px solid #2a3243;color:#e8ecf3;border-radius:12px;margin:6px 8px;font-size:16px";
        if(/delete/i.test(opt)) b.style.background="#3b2326";
        sheet.appendChild(b);
        b.onclick=()=>{ document.body.removeChild(overlay); resolve(opt); };
      });
      overlay.onclick=(e)=>{ if(e.target===overlay){ document.body.removeChild(overlay); resolve("Cancel"); } };
      overlay.appendChild(sheet); document.body.appendChild(overlay);
    });
  }

  // =========================
  // State
  // =========================
  const defaultMeta = () => ({
    lens: "50mm",
    shotType: "MS",
    movements: [],     // ["Pan","Tilt","Zoom",...]
    transition: "Cut",
    dialogue: "",
    notes: "",
    voiceNote: null    // { dataUrl, duration, mime }
  });
  const makeShot = ({ type="image", src="", filename="shot", meta } = {}) =>
    ({ id: uid("s_"), type, src, filename, meta: meta || defaultMeta() });

  const state = {
    projectName: "",
    scenes: [],              // [{id, name, shots:[Shot|null]}]
    autosaveKey: "sb_unused",// replaced by project system
    currentProjectId: null,
    editRef: null,           // {sceneId, shotId}
    pendingReplace: null,    // {sceneId, shotId|"__empty__"}
    flatIndex: []
  };

  // =========================
  // IndexedDB Project Vault
  // =========================
  const DB_NAME = "sb_vault";
  const DB_VER  = 1;
  const STORE   = "projects";

  function openDB(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if(!db.objectStoreNames.contains(STORE)){
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      r.onsuccess = ()=> res(r.result);
      r.onerror   = ()=> rej(r.error);
    });
  }
  async function dbPut(record){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = ()=> res();
      tx.onerror = ()=> rej(tx.error);
    });
  }
  async function dbGet(id){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = ()=> res(req.result||null);
      req.onerror = ()=> rej(req.error);
    });
  }
  async function dbDelete(id){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = ()=> res();
      tx.onerror = ()=> rej(tx.error);
    });
  }
  async function dbList(){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = ()=> {
        const arr = req.result||[];
        arr.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
        res(arr);
      };
      req.onerror = ()=> rej(req.error);
    });
  }

  // =========================
  // Elements (existing HTML + picker dynamically injected if missing)
  // =========================
  const menuBtn        = $("#menuBtn");
  const sheet          = $("#sheet");
  const closeSheetBtn  = $("#closeSheet");
  const addSceneBtn    = $("#addSceneBtn");
  const addShotsBtn    = $("#addShotsBtn");
  const renderFilmBtn  = $("#renderFilmBtn");
  const importBtn      = $("#importBtn");
  const exportBtn      = $("#exportBtn");
  const clearBtn       = $("#clearBtn");
  const projectNameInp = $("#projectName");

  const presentBtn     = $("#presentBtn");
  const viewToggle     = $("#viewToggle");
  const comicView      = $("#comicView");
  const scenesWrap     = $("#scenes");
  const boardView      = $("#boardView");
  const dropzone       = $("#dropzone");
  const gallery        = $("#gallery");

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

  const fileMulti      = $("#fileMulti");
  const fileSingle     = $("#fileSingle");
  const importFile     = $("#importFile");

  // Project Picker overlay (inject if missing; full screen)
  let picker = $("#picker");
  if(!picker){
    picker = document.createElement("div");
    picker.id = "picker";
    picker.style.cssText = "position:fixed;inset:0;background:#0f1115;display:none;z-index:15000;color:#e8ecf3";
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
    // Menu sheet
    on(menuBtn, "click", ()=> openSheet(sheet));
    on(sheet, "click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheet(sheet); });
    on(closeSheetBtn, "click", ()=> closeSheet(sheet));

    on(addSceneBtn, "click", ()=> { addScene(); renderAll(); persistDebounced(); closeSheet(sheet); });
    on(addShotsBtn, "click", ()=> { state.pendingReplace=null; fileMulti?.click(); });
    on(renderFilmBtn, "click", async ()=> { closeSheet(sheet); await exportFilmSmart(); });
    on(importBtn, "click", ()=> importFile?.click());
    on(exportBtn, "click", exportJSONCurrent);
    on(clearBtn, "click", clearAll);
    on(projectNameInp, "input", ()=> { state.projectName = projectNameInp.value.trim(); persistDebounced(); });

    // Views
    on(viewToggle, "click", ()=>{
      const comic = !comicView.classList.contains("hidden");
      if(comic){
        comicView.classList.add("hidden");
        boardView.classList.remove("hidden");
        viewToggle.textContent = "Board ▾";
        buildGallery();
      } else {
        boardView.classList.add("hidden");
        comicView.classList.remove("hidden");
        viewToggle.textContent = "Comic ▾";
      }
    });

    // Dropzone
    on(dropzone, "click", ()=> { state.pendingReplace=null; fileMulti?.click(); });
    on(dropzone, "keydown", e=> { if(e.key==="Enter"||e.key===" "){ e.preventDefault(); dropzone.click(); }});
    ["dragenter","dragover"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.add("dragover"); }));
    ["dragleave","drop"].forEach(ev=> on(dropzone,ev,e=>{ e.preventDefault(); dropzone.classList.remove("dragover"); }));
    on(dropzone,"drop", e=>{ const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

    // Files
    on(fileMulti, "change", e=> addFilesToScene(e.target.files));
    on(fileSingle, "change", e=> replaceSingle(e.target.files?.[0]||null));
    on(importFile, "change", e=> importProjectJSON(e.target.files?.[0]||null));

    // Editor
    on(editor, "click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheet(editor); });
    on(closeEditor, "click", ()=> closeSheet(editor));
    on(edLens, "change", saveEditor);
    on(edShotType, "change", saveEditor);
    on(edTransition, "change", saveEditor);
    on(edDialogue, "input", saveEditor);
    on(edNotes, "input", saveEditor);

    if(edMoves && !edMoves.dataset._init){
      ["Pan","Tilt","Zoom","Dolly","Truck","Pedestal","Handheld","Static","Rack Focus"].forEach(m=>{
        const b=document.createElement("button"); b.type="button"; b.className="tag"; b.textContent=m; b.dataset.mov=m;
        b.onclick = ()=> { b.classList.toggle("active"); saveEditor(); };
        edMoves.appendChild(b);
      });
      edMoves.dataset._init="1";
    }

    // Voice notes
    on(recBtn, "click", toggleRecord);
    on(playNoteBtn, "click", playVoiceNote);

    // Transition picker
    on(transPicker, "click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheet(transPicker); });
    on(closeTrans, "click", ()=> closeSheet(transPicker));
    if(transOptions && !transOptions.dataset._init){
      ["Cut","Dissolve","Fade","Wipe","Match Cut","Whip Pan","J-Cut","L-Cut"].forEach(t=>{
        const b=document.createElement("button"); b.className="tag"; b.textContent=t;
        b.onclick = ()=> { if(_transTarget) setShotMeta(_transTarget,{transition:t}); closeSheet(transPicker); };
        transOptions.appendChild(b);
      });
      transOptions.dataset._init="1";
    }

    // Presentation
    on(presentBtn, "click", openPresentation);
    on(prevBtn, "click", ()=> showAt(curIdx-1));
    on(nextBtn, "click", ()=> showAt(curIdx+1));
    on(fsBtn, "click", ()=> { if(!document.fullscreenElement) player?.requestFullscreen?.(); else document.exitFullscreen?.(); });
    on(closePlayer, "click", closePresentation);
    on(stage, "click", ()=>{
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
    on(newProjBtn, "click", async ()=> {
      const id = uid("p_"); const rec = emptyProjectRecord(id, "Untitled");
      await dbPut(rec); await openProject(id);
      hidePicker();
    });
    on(importProjBtn, "click", ()=> pickerImport.click());
    on(pickerImport, "change", async e=>{
      const file = e.target.files?.[0]; if(!file) return;
      const text = await file.text();
      try{
        const data = JSON.parse(text);
        if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
        const id = uid("p_"); const name = data.projectName || "Imported";
        const rec = {
          id, name, createdAt: Date.now(), updatedAt: Date.now(),
          cover: firstCoverFrom(data) || null, data
        };
        await dbPut(rec); await openProject(id); hidePicker();
      }catch(err){ alert("Import failed: " + err.message); }
      pickerImport.value="";
    });
  }

  // =========================
  // Boot / Projects
  // =========================
  async function boot(){
    // If URL has #p/<id> try open, else show picker
    const m = location.hash.match(/#p\/([\w\-]+)/);
    if(m && await dbGet(m[1])){ await openProject(m[1]); return; }
    await showPicker();
  }

  function emptyProjectRecord(id, name){
    return { id, name, createdAt: Date.now(), updatedAt: Date.now(), cover: null, data: { projectName:name, scenes: [] } };
  }

  async function showPicker(){
    // render grid
    const items = await dbList();
    pickerGrid.innerHTML = items.length? "" : `<div class="muted">No projects yet — tap “New”.</div>`;
    for(const it of items){
      const card = document.createElement("div");
      card.style.cssText = "border:1px solid #2a3243;border-radius:14px;overflow:hidden;background:#151a22";
      card.innerHTML = `
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
        </div>
      `;
      pickerGrid.appendChild(card);
      card.querySelector(".open").onclick    = async ()=>{ await openProject(it.id); hidePicker(); };
      card.querySelector(".rename").onclick  = async ()=>{
        const nn = prompt("Rename project:", it.name); if(!nn) return;
        it.name = nn; it.updatedAt = Date.now(); await dbPut(it); showPicker();
      };
      card.querySelector(".dup").onclick     = async ()=>{
        const id2 = uid("p_");
        const rec = JSON.parse(JSON.stringify(it));
        rec.id = id2; rec.name = it.name+" (copy)"; rec.createdAt=Date.now(); rec.updatedAt=Date.now();
        await dbPut(rec); showPicker();
      };
      card.querySelector(".export").onclick  = ()=> downloadBlob(JSON.stringify(it.data,null,2), sanitize(it.name)+".json", "application/json");
      card.querySelector(".del").onclick     = async ()=>{
        if(confirm(`Delete “${it.name}”? This cannot be undone.`)){ await dbDelete(it.id); showPicker(); }
      };
    }
    picker.style.display = "block";
    document.body.classList.add("sheet-open"); // lock scroll
  }
  function hidePicker(){ picker.style.display = "none"; document.body.classList.remove("sheet-open"); }

  async function openProject(id){
    const rec = await dbGet(id);
    if(!rec){ alert("Project not found."); return; }
    state.currentProjectId = id;
    state.projectName = rec.data.projectName || rec.name || "Untitled";
    state.scenes = Array.isArray(rec.data.scenes) ? rec.data.scenes : [];
    location.hash = "#p/" + id;
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

  function firstCoverFrom(data){
    for(const s of (data.scenes||[])){
      for(const sh of s.shots||[]){
        if(sh && sh.type==="image") return sh.src;
        if(sh && sh.type==="video") return sh.src;
      }
    }
    return null;
  }

  // =========================
  // Scene / Shot operations
  // =========================
  function addScene(){
    const idx = state.scenes.length + 1;
    state.scenes.push({ id: uid("sc_"), name: `Scene ${idx}`, shots: [] });
  }
  function ensureTrailingEmpty(scene){
    if(scene.shots.length===0 || scene.shots[scene.shots.length-1] !== null){
      scene.shots.push(null);
    }
  }
  function getScene(id){ return state.scenes.find(s=> s.id===id); }
  function getShot(sceneId, shotId){ return getScene(sceneId)?.shots.find(s=> s && s.id===shotId) || null; }

  async function addFilesToScene(fileList){
    const files = [...fileList].filter(f=>/^image\/|^video\//.test(f.type));
    if(files.length===0) return;
    const targetScene = state.pendingReplace ? getScene(state.pendingReplace.sceneId) : state.scenes[state.scenes.length-1] || (addScene(), state.scenes[0]);
    for(const f of files){
      const dataUrl = await fileToDataURL(f);
      const shot = makeShot({ type: f.type.startsWith("video")?"video":"image", src:dataUrl, filename: f.name||"shot" });
      const emptyIdx = targetScene.shots.findIndex(s=> s===null);
      if(emptyIdx>=0) targetScene.shots[emptyIdx] = shot;
      else targetScene.shots.push(shot);
      ensureTrailingEmpty(targetScene);
    }
    state.pendingReplace=null;
    renderAll(); persistDebounced(); if(fileMulti) fileMulti.value="";
  }

  async function replaceSingle(file){
    if(!file){ if(fileSingle) fileSingle.value=""; return; }
    const dataUrl = await fileToDataURL(file);
    if(state.pendingReplace && state.pendingReplace.shotId && state.pendingReplace.shotId!=="__empty__"){
      const {sceneId, shotId} = state.pendingReplace;
      const sc = getScene(sceneId);
      const idx = sc?.shots.findIndex(s=> s && s.id===shotId);
      if(idx>=0){
        sc.shots[idx] = makeShot({ type:file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name||"shot" });
        ensureTrailingEmpty(sc);
      }
    } else {
      await addFilesToScene([file]); // fills first empty
    }
    state.pendingReplace=null; renderAll(); persistDebounced(); if(fileSingle) fileSingle.value="";
  }

  function deleteShot(sceneId, shotId){
    const sc = getScene(sceneId); if(!sc) return;
    const idx = sc.shots.findIndex(s=> s && s.id===shotId);
    if(idx>=0) sc.shots.splice(idx,1);
    ensureTrailingEmpty(sc); renderAll(); persistDebounced();
  }

  // =========================
  // Render — Comic
  // =========================
  function renderAll(){
    // Comic view
    scenesWrap.innerHTML = "";
    state.scenes.forEach(scene=>{
      ensureTrailingEmpty(scene);
      scenesWrap.appendChild(renderScene(scene));
    });
    projectNameInp.value = state.projectName || "";
    // Board
    if(!boardView.classList.contains("hidden")) buildGallery();
  }

  let _transTarget = null;
  function renderScene(scene){
    const wrap = div("scene");

    const head = div("scene-head");
    const title = div("scene-title", scene.name);
    title.contentEditable="true"; title.spellcheck=false;
    on(title, "input", debounce(()=>{ scene.name=(title.textContent||"").trim()||scene.name; persistDebounced(); }, 250));
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
          const chip = div("trans-chip");
          const b = document.createElement("button");
          b.textContent = shot.meta?.transition || "Cut";
          b.onclick = ()=>{ _transTarget = shot.id; openSheet(transPicker); };
          chip.appendChild(b); strip.appendChild(chip);
        }
      } else {
        const card = div("shot empty");
        card.innerHTML = `<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
        card.onclick = ()=>{ state.pendingReplace={sceneId:scene.id, shotId:"__empty__"}; fileSingle?.click(); };
        strip.appendChild(card);
      }
    });
    on(strip, "dragover", e=> e.preventDefault());
    wrap.appendChild(strip);
    return wrap;
  }

  function renderShot(scene, shot){
    const card = div("shot"); card.draggable = true;

    const t = div("thumb");
    if(shot.type==="image"){
      const img=new Image(); img.src=shot.src; img.alt=shot.filename; t.appendChild(img);
    }else{
      const v=document.createElement("video");
      v.src=shot.src; v.playsInline=true; v.muted=true; v.controls=false;
      on(v,"mouseenter",()=>v.play().catch(()=>{})); on(v,"mouseleave",()=>v.pause());
      t.appendChild(v);
    }
    const badge = div("badge", shot.type.toUpperCase()); t.appendChild(badge);

    const meta = div("meta"); meta.innerHTML = `<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;
    const overlay = div("overlay-info"); overlay.textContent = shot.meta.dialogue || shot.meta.notes || `${shot.meta.lens} · ${shot.meta.shotType}`;

    card.appendChild(t); card.appendChild(meta); card.appendChild(overlay);

    card.onclick = (e)=>{
      if(e.target.closest(".meta")){ card.classList.toggle("show-info"); return; }
      openEditor(scene.id, shot.id);
    };

    longPress(card, 450, async ()=>{
      const opt = await mobilePrompt(["Replace","Duplicate","Delete","Cancel"]);
      if(opt==="Replace"){ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle?.click(); }
      else if(opt==="Duplicate"){ const sc=getScene(scene.id); const idx=sc.shots.findIndex(s=>s&&s.id===shot.id); sc.shots.splice(idx+1,0, JSON.parse(JSON.stringify(shot))); ensureTrailingEmpty(sc); renderAll(); persistDebounced(); }
      else if(opt==="Delete"){ deleteShot(scene.id, shot.id); }
    });

    // Drag within scene
    card.addEventListener("dragstart", e=>{
      e.dataTransfer.setData("text/plain", JSON.stringify({sceneId: scene.id, shotId: shot.id}));
      setTimeout(()=> card.classList.add("dragging"),0);
    });
    card.addEventListener("dragend", ()=> card.classList.remove("dragging"));
    card.addEventListener("drop", e=>{
      e.preventDefault();
      const data = JSON.parse(e.dataTransfer.getData("text/plain")||"{}");
      if(data.sceneId !== scene.id) return;
      const arr = scene.shots.filter(s=> s!==null);
      const from = arr.findIndex(s=> s.id===data.shotId);
      const to   = arr.findIndex(s=> s.id===shot.id);
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
    gallery.innerHTML = "";
    state.scenes.forEach(scene=>{
      scene.shots.filter(Boolean).forEach(shot=>{
        const wrap = div("gallery-item");
        const media = div("gallery-media");
        if(shot.type==="image"){ const img=new Image(); img.src=shot.src; media.appendChild(img); }
        else{ const v=document.createElement("video"); v.src=shot.src; v.controls=true; v.playsInline=true; v.style.width="100%"; v.style.height="auto"; v.style.objectFit="contain"; media.appendChild(v); }
        wrap.appendChild(media);

        const meta = div("gallery-meta");
        const editBtn = document.createElement("button"); editBtn.className="small-btn"; editBtn.textContent="Edit details";
        editBtn.onclick = ()=> openEditor(scene.id, shot.id);
        meta.innerHTML = `<div><strong>${esc(scene.name)}</strong> — ${esc(shot.filename)}</div>`;
        meta.appendChild(editBtn);
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
    [...edMoves.querySelectorAll(".tag")].forEach(b=>{
      const mv=b.dataset.mov; b.classList.toggle("active", !!shot.meta.movements?.includes(mv));
    });
    if(shot.meta.voiceNote){ recStatus.textContent = `Voice note • ${formatTime(shot.meta.voiceNote.duration)}`; playNoteBtn.disabled=false; }
    else { recStatus.textContent = "No voice note"; playNoteBtn.disabled=true; }
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

  // Voice notes (store as dataURL for persistence)
  let mediaRec = null, recChunks=[], recStart=0;
  async function toggleRecord(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
    if(mediaRec && mediaRec.state==="recording"){ mediaRec.stop(); return; }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      recChunks=[]; mediaRec=new MediaRecorder(stream);
      mediaRec.ondataavailable = e=>{ if(e.data.size) recChunks.push(e.data); };
      mediaRec.onstart = ()=> { recStart=Date.now(); recStatus.textContent="Recording… tap to stop"; recBtn.textContent="⏹ Stop"; };
      mediaRec.onstop = async ()=>{
        const blob = new Blob(recChunks, { type: mediaRec.mimeType || "audio/webm" });
        const dataUrl = await blobToDataURL(blob);
        const dur = (Date.now()-recStart)/1000;
        shot.meta.voiceNote = { dataUrl, duration: dur, mime: blob.type };
        recStatus.textContent = `Saved • ${formatTime(dur)}`; playNoteBtn.disabled=false; recBtn.textContent="🎙 Record";
        persistDebounced();
      };
      mediaRec.start();
    }catch(err){ alert("Mic access failed: "+err.message); }
  }
  function blobToDataURL(blob){ return new Promise((res)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(blob); }); }
  function playVoiceNote(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot?.meta.voiceNote) return;
    const a = new Audio(shot.meta.voiceNote.dataUrl); a.play().catch(()=>{});
  }

  // Transition
  function setShotMeta(shotId, patch){
    state.scenes.forEach(s=> s.shots.forEach(sh=>{ if(sh && sh.id===shotId) Object.assign(sh.meta, patch); }));
    persistDebounced(); renderAll();
  }

  // =========================
  // Presentation
  // =========================
  let curIdx = 0;
  function openPresentation(){
    state.flatIndex = flattenShots(); if(state.flatIndex.length===0) return;
    curIdx=0; player.classList.add("open"); player.setAttribute("aria-hidden","false");
    showAt(0);
  }
  function closePresentation(){
    player.classList.remove("open"); player.setAttribute("aria-hidden","true");
    stageMedia.innerHTML = "";
  }
  function flattenShots(){
    const arr=[]; state.scenes.forEach(s=> s.shots.filter(Boolean).forEach(sh=> arr.push({scene:s, shot:sh})));
    return arr;
  }
  function showAt(i){
    const n = state.flatIndex.length; curIdx = (i%n + n)%n;
    const {scene, shot} = state.flatIndex[curIdx];

    stageMedia.innerHTML = "";
    let el;
    if(shot.type==="image"){
      el = new Image(); el.src = shot.src; el.alt = shot.filename;
    }else{
      el = document.createElement("video");
      el.src = shot.src; el.autoplay = true; el.loop=false; el.muted=false; el.controls=false;
      el.setAttribute("playsinline",""); el.setAttribute("webkit-playsinline","");
      el.style.width="100%"; el.style.height="100%"; el.style.objectFit="contain";
      const resume = () => { el.play().catch(()=>{}); stage.removeEventListener("click", resume); };
      el.addEventListener("loadeddata", ()=> el.play().catch(()=>{}), {once:true});
      stage.addEventListener("click", resume, {once:true});
    }
    stageMedia.appendChild(el);

    ovTL.textContent = scene.name;
    ovTR.textContent = `${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
    ovB.textContent  = shot.meta.dialogue || shot.meta.notes || "";
  }

  // =========================
  // Export Film (MP4 via ffmpeg.wasm; fallback to WebM)
  // =========================
  async function exportFilmSmart(){
    try{
      const ok = await ensureFFmpeg();
      if(!ok) throw new Error("ffmpeg unavailable");
      await exportFilmMP4();
    }catch{
      await exportFilmWebM();
    }
  }

  // --- ffmpeg loader
  let FF = null, ffmpeg = null;
  async function ensureFFmpeg(){
    if(ffmpeg) return true;
    try{
      if(!window.FFmpeg){
        // Try local vendor build first; then CDN
        await importScript("./vendor/ffmpeg/ffmpeg.min.js").catch(()=>importScript("https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js"));
      }
      FF = window.FFmpeg || window.FFmpegWASM || window.FFmpegModule || window;
      const { createFFmpeg, fetchFile } = FF;
      ffmpeg = createFFmpeg({ log:false, corePath: "./vendor/ffmpeg/ffmpeg-core.js" });
      if(!ffmpeg.isLoaded()) await ffmpeg.load();
      ffmpeg._fetchFile = fetchFile; // save helper
      return true;
    }catch(e){ console.warn("ffmpeg load failed", e); return false; }
  }
  function importScript(src){
    return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=()=>res(); s.onerror=rej; document.head.appendChild(s); });
  }

  async function exportFilmMP4(){
    const flat = flattenShots(); if(flat.length===0){ alert("Add shots first."); return; }
    const width=1280, height=720, fps=30;

    // Build clip parts
    const parts = [];
    let idx = 0;
    for(const {scene, shot} of flat){
      if(shot.type==="image"){
        const imgBytes = dataURLtoUint8(shot.src);
        const imgName = `img_${++idx}.jpg`;
        ffmpeg.FS('writeFile', imgName, imgBytes);
        const dur = Math.max(7, shot.meta.voiceNote?.duration || 0);
        const outName = `part_${idx}.mp4`;
        await ffmpeg.run(
          '-loop','1','-t', String(dur), '-i', imgName,
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', String(fps),
          '-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline',
          '-an', outName
        );
        parts.push(outName);
      } else {
        const vidBytes = dataURLtoUint8(shot.src);
        const inName = `clip_${++idx}.mp4`;
        ffmpeg.FS('writeFile', inName, vidBytes);
        const outName = `part_${idx}.mp4`;
        await ffmpeg.run(
          '-i', inName,
          '-t','7',
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', String(fps),
          '-c:v','libx264','-pix_fmt','yuv420p','-profile:v','baseline',
          '-an', outName
        );
        parts.push(outName);
      }
    }

    // Concat parts
    const listTxt = parts.map(p=>`file '${p}'`).join('\n');
    ffmpeg.FS('writeFile','concat.txt', strToUint8(listTxt));
    await ffmpeg.run('-f','concat','-safe','0','-i','concat.txt','-c','copy','temp_video.mp4');

    // Audio mix from voice notes via WebAudio → WAV → mux
    const wavBytes = await buildVoiceTrackWav(flat);
    if(wavBytes){
      ffmpeg.FS('writeFile','audio.wav', wavBytes);
      await ffmpeg.run('-i','temp_video.mp4','-i','audio.wav','-c:v','copy','-c:a','aac','-shortest','out.mp4');
    }else{
      // No voice notes; add silent track (optional) or just keep video
      await ffmpeg.run('-i','temp_video.mp4','-c','copy','out.mp4');
    }

    const mp4 = ffmpeg.FS('readFile','out.mp4');
    downloadBlob(mp4.buffer, sanitize(state.projectName||"storyboard")+"_film.mp4", 'video/mp4');
    alert("MP4 rendered and downloaded.");
  }

  async function buildVoiceTrackWav(flat){
    const sr = 48000;
    // compute total length (images 7s or voice duration; videos 7s)
    let total = 0;
    for(const {shot} of flat){
      if(shot.type==="image") total += Math.max(7, shot.meta.voiceNote?.duration || 0);
      else total += 7;
    }
    if(total<=0) return null;

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if(!OfflineCtx) return null;

    const ctx = new OfflineCtx(1, Math.ceil(total*sr), sr);
    let t = 0;
    for(const {shot} of flat){
      let dur = 7;
      if(shot.type==="image") dur = Math.max(7, shot.meta.voiceNote?.duration || 0);
      if(shot.meta.voiceNote?.dataUrl){
        try{
          const buf = await fetch(shot.meta.voiceNote.dataUrl).then(r=>r.arrayBuffer()).then(ab=>ctx.decodeAudioData(ab));
          const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(t);
        }catch{}
      }
      t += dur;
    }
    const rendered = await ctx.startRendering();
    return audioBufferToWavBytes(rendered);
  }

  async function exportFilmWebM(){
    // Basic fallback — canvas capture + MediaRecorder (no video-clip audio mix)
    const flat = flattenShots(); if(flat.length===0){ alert("Add shots first."); return; }
    const fps=30, width=1280, height=720;
    const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=height;
    const ctx=canvas.getContext("2d");
    const stream = canvas.captureStream(fps);
    let chunks=[]; let rec;
    try{ rec = new MediaRecorder(stream, {mimeType:"video/webm;codecs=vp9"}); }
    catch{ try{ rec = new MediaRecorder(stream, {mimeType:"video/webm;codecs=vp8"}); } catch{ alert("Recording not supported on this device."); return; } }
    rec.ondataavailable = e=>{ if(e.data.size) chunks.push(e.data); };
    const done = new Promise(res=> rec.onstop=res);
    rec.start();

    function drawCover(media){
      const iw=media.videoWidth||media.naturalWidth||width, ih=media.videoHeight||media.naturalHeight||height;
      const ir=iw/ih, r=width/height; let dw,dh; if(ir>r){ dh=height; dw=ir*dh; } else { dw=width; dh=dw/ir; }
      const dx=(width-dw)/2, dy=(height-dh)/2; ctx.fillStyle="#000"; ctx.fillRect(0,0,width,height); ctx.drawImage(media,dx,dy,dw,dh);
    }
    function drawOverlays(scene, shot){
      ctx.save(); ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(10,10,320,28);
      ctx.fillStyle="#e9eef9"; ctx.font="700 16px system-ui"; ctx.fillText(scene.name,18,30); ctx.restore();
      const txt = `${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
      ctx.save(); ctx.font="700 16px system-ui"; const tw=ctx.measureText(txt).width+24;
      ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(width-tw-10,10,tw,28); ctx.fillStyle="#e9eef9"; ctx.fillText(txt,width-tw+2,30); ctx.restore();
      if(shot.meta.dialogue || shot.meta.notes){
        const text = shot.meta.dialogue || shot.meta.notes;
        ctx.save(); ctx.fillStyle="rgba(0,0,0,.6)"; ctx.fillRect(0,height-80,width,80);
        ctx.fillStyle="#e9eef9"; ctx.font="700 20px system-ui";
        wrapText(ctx,text,width-60).forEach((ln,i)=> ctx.fillText(ln,30,height-50+i*24));
        ctx.restore();
      }
    }
    function wrapText(ctx, text, maxWidth){ const words=String(text||"").split(/\s+/); const lines=[]; let line=""; ctx.font="700 20px system-ui"; for(const w of words){ const t=line?line+" "+w:w; if(ctx.measureText(t).width>maxWidth){ if(line) lines.push(line); line=w; } else line=t; } if(line) lines.push(line); return lines; }
    const waitFrame = ()=> sleep(1000/fps);

    for(const {scene,shot} of flat){
      if(shot.type==="image"){
        const img = await loadImage(shot.src);
        const hold = Math.max(7, shot.meta.voiceNote?.duration || 0);
        const frames = Math.max(1, Math.round(fps*hold));
        for(let f=0; f<frames; f++){ drawCover(img); drawOverlays(scene,shot); await waitFrame(); }
      }else{
        const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; await v.play().catch(()=>{});
        const endAt = performance.now() + 7000;
        while(performance.now() < endAt){ drawCover(v); drawOverlays(scene,shot); await waitFrame(); }
        v.pause();
      }
    }
    rec.stop(); await done;
    const blob = new Blob(chunks, {type: rec.mimeType || "video/webm"});
    downloadBlob(blob, sanitize(state.projectName||"storyboard")+"_film.webm", blob.type);
    alert("WebM rendered and downloaded (fallback).");
  }

  // helpers for ffmpeg
  function strToUint8(s){ return new TextEncoder().encode(s); }
  function dataURLtoUint8(dataUrl){
    const [meta, b64] = dataUrl.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return bytes;
  }
  function audioBufferToWavBytes(ab){
    const numOfChan = ab.numberOfChannels, btw=16, sampleRate=ab.sampleRate, samples=ab.length;
    const bytesPerSample = btw/8, blockAlign = numOfChan * bytesPerSample;
    const buffer = new ArrayBuffer(44 + samples*numOfChan*bytesPerSample);
    const view = new DataView(buffer);
    // RIFF header
    writeString(view,0,'RIFF');
    view.setUint32(4, 36 + samples*numOfChan*bytesPerSample, true);
    writeString(view,8,'WAVE');
    // fmt
    writeString(view,12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true);
    view.setUint16(22,numOfChan,true); view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*blockAlign,true); view.setUint16(32,blockAlign,true); view.setUint16(34,btw,true);
    // data
    writeString(view,36,'data'); view.setUint32(40, samples*numOfChan*bytesPerSample, true);
    // PCM
    let offset=44, chData=[]; for(let ch=0; ch<numOfChan; ch++) chData.push(ab.getChannelData(ch));
    for(let i=0;i<samples;i++){ for(let ch=0; ch<numOfChan; ch++){ let s = Math.max(-1, Math.min(1, chData[ch][i])); view.setInt16(offset, s<0?s*0x8000:s*0x7FFF, true); offset+=2; } }
    return new Uint8Array(buffer);
    function writeString(dataview, offset, str){ for (let i = 0; i < str.length; i++) dataview.setUint8(offset+i, str.charCodeAt(i)); }
  }

  // =========================
  // Import/Export JSON for current project
  // =========================
  function exportJSONCurrent(){
    const payload = { schema:"storyboard_v4", exportedAt:new Date().toISOString(), projectName: state.projectName||"Untitled", scenes: state.scenes };
    downloadBlob(JSON.stringify(payload,null,2), (sanitize(state.projectName)||"storyboard")+".json", "application/json");
  }
  async function importProjectJSON(file){
    if(!file) return;
    try{
      const data = JSON.parse(await file.text());
      if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
      // Store as a new project
      const id = uid("p_"); const name = data.projectName || "Imported";
      const rec = { id, name, createdAt: Date.now(), updatedAt: Date.now(), cover: firstCoverFrom(data) || null, data };
      await dbPut(rec); await openProject(id);
    }catch(e){ alert("Import failed: " + e.message); }
    importFile.value="";
  }

  // =========================
  // Clear
  // =========================
  function clearAll(){
    if(confirm("Clear all scenes in this project?")){
      state.projectName = "";
      state.scenes = [];
      addScene();
      renderAll(); persistProject();
    }
  }

  // =========================
  // Small DOM helpers
  // =========================
  function div(cls, txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
  function smallBtn(label, onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.onclick=onClick; return b; }

  // =========================
  // Sheet open/close
  // =========================
  function openSheet(sh){ sh?.classList.add("show"); document.body.classList.add("sheet-open"); }
  function closeSheet(sh){ sh?.classList.remove("show"); document.body.classList.remove("sheet-open"); }
})();
