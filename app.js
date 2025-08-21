/* Storyboard — iPhone-friendly Comic Strip view
   - Scenes (rows) each with horizontally scrollable shots
   - Tap empty box to add; tap shot to toggle info overlay
   - Reorder by drag within a scene
   - Dropzone is tappable (opens picker) and drag-drop enabled
   - Autosave to localStorage; JSON import/export
*/

(() => {

  // ---------- State ----------
  const state = {
    projectName: "",
    scenes: [], // [{id, name, shots:[Shot]}]
    autosaveKey: "sb_comic_v1",
    pendingReplace: null // {sceneId, shotId} when user taps to replace
  };

  // Shot object factory
  const defaultMeta = () => ({
    lens: "50mm",
    shotType: "MS",
    notes: "",
    dialogue: ""
  });
  const makeShot = ({ type="image", src="", filename="shot.png", meta } = {}) => ({
    id: uid(),
    type,       // 'image' | 'video'
    src,        // dataURL
    filename,
    meta: meta || defaultMeta()
  });

  // ---------- Elements ----------
  const el = (s, root=document) => root.querySelector(s);

  const menuBtn = el("#menuBtn");
  const sheet = el("#sheet");
  const closeSheet = el("#closeSheet");
  const addSceneBtn = el("#addSceneBtn");
  const addShotsBtn = el("#addShotsBtn");
  const importBtn = el("#importBtn");
  const exportBtn = el("#exportBtn");
  const clearBtn = el("#clearBtn");
  const projectName = el("#projectName");

  const viewToggle = el("#viewToggle");
  const comicView = el("#comicView");
  const boardView = el("#boardView");
  const scenesWrap = el("#scenes");

  const dropzone = el("#dropzone");
  const boardList = el("#boardList");

  const fileMulti = el("#fileMulti");   // add many
  const fileSingle = el("#fileSingle"); // add/replace one
  const importFile = el("#importFile");

  // ---------- Init ----------
  bindUI();
  restore();
  if (state.scenes.length === 0) {
    addScene(); // start with one scene
  }
  renderAll();

  // ---------- UI Bindings ----------
  function bindUI(){
    // Menu sheet
    menuBtn.addEventListener("click", ()=> sheet.classList.add("show"));
    sheet.addEventListener("click", (e)=> {
      if(e.target.classList.contains("sheet-backdrop")) sheet.classList.remove("show");
    });
    closeSheet.addEventListener("click", ()=> sheet.classList.remove("show"));

    // Actions
    addSceneBtn.addEventListener("click", ()=> { addScene(); renderAll(); sheet.classList.remove("show"); persistDebounced(); });
    addShotsBtn.addEventListener("click", ()=>{
      state.pendingReplace = null; // bulk add to last scene
      fileMulti.click();
    });
    importBtn.addEventListener("click", ()=> importFile.click());
    exportBtn.addEventListener("click", exportJSON);
    clearBtn.addEventListener("click", clearAll);

    // Project name
    projectName.addEventListener("input", ()=>{
      state.projectName = projectName.value.trim();
      persistDebounced();
    });

    // View toggle
    viewToggle.addEventListener("click", ()=>{
      const isComic = !comicView.classList.contains("hidden");
      if(isComic){
        comicView.classList.add("hidden"); boardView.classList.remove("hidden");
        viewToggle.textContent = "Board ▾";
      }else{
        boardView.classList.add("hidden"); comicView.classList.remove("hidden");
        viewToggle.textContent = "Comic ▾";
      }
    });

    // Dropzone: tap-to-open + DnD
    dropzone.addEventListener("click", ()=> { state.pendingReplace = null; fileMulti.click(); });
    dropzone.addEventListener("keydown", (e)=> { if(e.key==="Enter"||e.key===" "){ e.preventDefault(); dropzone.click(); }});
    ["dragenter","dragover"].forEach(ev => dropzone.addEventListener(ev, (e)=> { e.preventDefault(); dropzone.classList.add("dragover"); }));
    ["dragleave","drop"].forEach(ev => dropzone.addEventListener(ev, (e)=> { e.preventDefault(); dropzone.classList.remove("dragover"); }));
    dropzone.addEventListener("drop", (e)=> { const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

    // File inputs
    fileMulti.addEventListener("change", (e)=> addFilesToScene(e.target.files));
    fileSingle.addEventListener("change", (e)=> replaceSingle(e.target.files?.[0]||null));
    importFile.addEventListener("change", (e)=> importJSON(e.target.files?.[0]||null));
  }

  // ---------- Scene/Shot operations ----------
  function addScene(){
    const idx = state.scenes.length + 1;
    state.scenes.push({
      id: uid(),
      name: `Scene ${idx}`,
      shots: []
    });
  }

  function addShotBox(sceneId){
    const sc = getScene(sceneId);
    if(!sc) return;
    sc.shots.push(null); // empty slot
  }

  async function addFilesToScene(fileList){
    const files = [...fileList].filter(f=> /^image\/|^video\//.test(f.type));
    if(files.length===0) return;

    const targetScene = state.pendingReplace ? getScene(state.pendingReplace.sceneId) : state.scenes[state.scenes.length-1];
    if(!targetScene) return;

    for(const f of files){
      const dataUrl = await fileToDataURL(f);
      const shot = makeShot({ type: f.type.startsWith("video") ? "video":"image", src:dataUrl, filename: f.name || "shot" });
      // If there is an empty box waiting -> fill first
      const emptyIdx = targetScene.shots.findIndex(s=> s===null);
      if(emptyIdx>=0){
        targetScene.shots[emptyIdx] = shot;
      }else{
        targetScene.shots.push(shot);
      }
    }
    state.pendingReplace = null;
    renderAll();
    persistDebounced();
    fileMulti.value = "";
  }

  async function replaceSingle(file){
    if(!file || !state.pendingReplace){ fileSingle.value=""; return; }
    const sc = getScene(state.pendingReplace.sceneId);
    const idx = sc?.shots.findIndex(s=> s && s.id === state.pendingReplace.shotId);
    if(sc && idx>=0){
      const dataUrl = await fileToDataURL(file);
      sc.shots[idx] = makeShot({ type: file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name || "shot" });
      renderAll();
      persistDebounced();
    }
    state.pendingReplace = null;
    fileSingle.value = "";
  }

  function deleteShot(sceneId, shotId){
    const sc = getScene(sceneId); if(!sc) return;
    const idx = sc.shots.findIndex(s=> s && s.id===shotId);
    if(idx>=0) sc.shots.splice(idx,1);
    renderAll(); persistDebounced();
  }

  // ---------- Rendering ----------
  function renderAll(){
    // Comic view
    scenesWrap.innerHTML = "";
    state.scenes.forEach(scene => {
      scenesWrap.appendChild(renderScene(scene));
    });

    // Board view (simple flat list preview)
    boardList.innerHTML = "";
    state.scenes.forEach(scene => {
      scene.shots.forEach(shot=>{
        const li = document.createElement("li");
        li.textContent = shot ? `${scene.name} — ${shot.filename}` : `${scene.name} — (empty)`;
        boardList.appendChild(li);
      });
    });

    projectName.value = state.projectName || "";
  }

  function renderScene(scene){
    const wrap = div("scene");

    // Head
    const head = div("scene-head");
    const title = div("scene-title", scene.name);
    title.contentEditable = "true";
    title.spellcheck = false;
    title.addEventListener("input", debounce(()=> { scene.name = (title.textContent||"").trim() || scene.name; persistDebounced(); }, 300));
    head.appendChild(title);

    const actions = div("scene-actions");
    const addBoxBtn = btn("＋ Box", ()=> { addShotBox(scene.id); renderAll(); persistDebounced(); });
    const addMediaBtn = btn("📥 Shots", ()=> { state.pendingReplace = null; fileMulti.click(); });
    actions.append(addBoxBtn, addMediaBtn);
    head.appendChild(actions);
    wrap.appendChild(head);

    // Strip
    const strip = div("strip");
    // Ensure at least one empty box
    if(scene.shots.length === 0) scene.shots.push(null);

    scene.shots.forEach((shot, idx)=>{
      strip.appendChild(renderShot(scene, shot, idx));
    });

    // trailing + box always available
    const plus = div("shot add-box");
    plus.innerHTML = `<div class="thumb"><div class="plus">＋</div></div><div class="meta" style="text-align:center">Add shot</div>`;
    plus.addEventListener("click", ()=> { addShotBox(scene.id); renderAll(); persistDebounced(); });
    strip.appendChild(plus);

    // Drag sort within scene
    strip.addEventListener("dragover", (e)=> e.preventDefault());

    wrap.appendChild(strip);
    return wrap;
  }

  function renderShot(scene, shot, idx){
    const card = div("shot");
    card.draggable = true;

    if(!shot){ // empty box
      card.classList.add("empty");
      card.innerHTML = `<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
      card.addEventListener("click", ()=>{
        // fill this empty slot with a single file
        state.pendingReplace = null;
        // When a file is chosen, we fill first empty (this one)
        scene.shots[idx] = null; // ensure it stays empty
        fileMulti.click();
      });
      return card;
    }

    // Filled shot
    const t = div("thumb");
    if(shot.type==="image"){
      const img = new Image(); img.src = shot.src; img.alt = shot.filename;
      t.appendChild(img);
    }else{
      const v = document.createElement("video");
      v.src = shot.src; v.playsInline = true; v.controls = false; v.muted = true;
      v.addEventListener("mouseenter", ()=> v.play().catch(()=>{}));
      v.addEventListener("mouseleave", ()=> v.pause());
      t.appendChild(v);
    }
    const badge = div("badge", shot.type.toUpperCase());
    t.appendChild(badge);

    const meta = div("meta");
    meta.innerHTML = `<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;

    // overlay info (tap to toggle)
    const overlay = div("overlay-info");
    overlay.textContent = shot.meta.dialogue || shot.meta.notes || `${shot.meta.lens} · ${shot.meta.shotType}`;
    card.appendChild(overlay);

    card.appendChild(t);
    card.appendChild(meta);

    // Tap to toggle info
    card.addEventListener("click", ()=>{
      card.classList.toggle("show-info");
    });

    // Hold to replace / delete (mobile-friendly long press)
    longPress(card, 450, ()=>{
      const choice = mobilePrompt(["Replace","Delete","Cancel"]);
      choice.then(opt=>{
        if(opt==="Replace"){
          state.pendingReplace = { sceneId: scene.id, shotId: shot.id };
          fileSingle.click();
        }else if(opt==="Delete"){
          deleteShot(scene.id, shot.id);
        }
      });
    });

    // Drag within scene
    card.addEventListener("dragstart", (e)=>{
      e.dataTransfer.setData("text/plain", JSON.stringify({sceneId: scene.id, shotId: shot.id}));
      setTimeout(()=> card.classList.add("dragging"), 0);
    });
    card.addEventListener("dragend", ()=> card.classList.remove("dragging"));
    card.addEventListener("drop", (e)=>{
      e.preventDefault();
      const data = JSON.parse(e.dataTransfer.getData("text/plain")||"{}");
      if(data.sceneId !== scene.id) return; // only within same scene
      const arr = scene.shots.filter(Boolean);
      const from = arr.findIndex(s=> s.id===data.shotId);
      const to = arr.findIndex(s=> s.id===shot.id);
      if(from<0 || to<0) return;
      const [item] = arr.splice(from,1);
      arr.splice(to,0,item);
      // rebuild scene.shots keeping nulls at their spots
      const newShots = [];
      scene.shots.forEach(s=>{
        if(s===null) newShots.push(null);
        else newShots.push(arr.shift());
      });
      scene.shots = newShots;
      renderAll(); persistDebounced();
    });

    return card;
  }

  // ---------- Board list (simple) ----------
  // (Already rendered from renderAll — flat text list for quick audit)

  // ---------- Persistence ----------
  function persist(){
    const light = {
      projectName: state.projectName,
      scenes: state.scenes
    };
    localStorage.setItem(state.autosaveKey, JSON.stringify(light));
  }
  const persistDebounced = debounce(persist, 350);

  function restore(){
    try{
      const raw = localStorage.getItem(state.autosaveKey);
      if(!raw) return;
      const data = JSON.parse(raw);
      state.projectName = data.projectName || "";
      state.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    }catch{}
  }

  // ---------- Import/Export ----------
  function exportJSON(){
    const blob = new Blob([JSON.stringify({
      schema:"storyboard_comic_v1",
      exportedAt: new Date().toISOString(),
      projectName: state.projectName || "Untitled",
      scenes: state.scenes
    }, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (sanitize(state.projectName)||"storyboard") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJSON(file){
    if(!file) return;
    file.text().then(txt=>{
      try{
        const data = JSON.parse(txt);
        if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
        state.projectName = data.projectName || "Imported";
        state.scenes = data.scenes;
        renderAll(); persist();
      }catch(err){
        alert("Import failed: " + err.message);
      }
    });
    importFile.value = "";
  }

  function clearAll(){
    if(confirm("Clear all scenes and local save?")){
      state.projectName = "";
      state.scenes = [];
      addScene();
      renderAll(); persist();
    }
  }

  // ---------- Helpers ----------
  function uid(){ return Math.random().toString(36).slice(2,10); }
  function sanitize(s){ return String(s||"").replace(/[^\w\-]+/g,'_').slice(0,60); }
  function esc(s){ return String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }

  function fileToDataURL(file){
    return new Promise((res, rej)=>{
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  function div(cls, txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
  function btn(label, onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.addEventListener("click", onClick); return b; }
  function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  // Mobile long press helper
  function longPress(el, ms, cb){
    let t=null;
    el.addEventListener("touchstart", ()=> { t=setTimeout(cb, ms); }, {passive:true});
    el.addEventListener("touchend", ()=> { clearTimeout(t); }, {passive:true});
    el.addEventListener("touchmove", ()=> { clearTimeout(t); }, {passive:true});
    el.addEventListener("mousedown", ()=> { t=setTimeout(cb, ms); });
    el.addEventListener("mouseup", ()=> { clearTimeout(t); });
    el.addEventListener("mouseleave", ()=> { clearTimeout(t); });
  }

  // Simple mobile action picker (prompt-like)
  function mobilePrompt(options){
    return new Promise(resolve=>{
      // very lightweight overlay
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:end center;z-index:30;";
      const sheet = document.createElement("div");
      sheet.style.cssText = "width:100%;max-width:600px;background:#151a22;border-top-left-radius:16px;border-top-right-radius:16px;border:1px solid #2a3243;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:8px;";
      options.forEach(opt=>{
        const b = document.createElement("button");
        b.textContent = opt;
        b.style.cssText = "width:100%;padding:14px 16px;background:#1a2130;border:1px solid #2a3243;color:#e8ecf3;border-radius:12px;margin:6px 8px;font-size:16px";
        if(opt==="Delete") b.style.background="#3b2326";
        if(opt==="Cancel") b.style.background="#0f1420";
        b.onclick = ()=> { document.body.removeChild(overlay); resolve(opt); };
        sheet.appendChild(b);
      });
      overlay.onclick = (e)=>{ if(e.target===overlay){ document.body.removeChild(overlay); resolve("Cancel"); } };
      overlay.appendChild(sheet);
      document.body.appendChild(overlay);
    });
  }
})();
