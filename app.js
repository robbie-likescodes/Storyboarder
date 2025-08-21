/* Storyboard — iPhone-friendly Comic view + Board gallery + Presentation
   Fixes:
   - Action sheet higher z-index and locks scroll
   - Empty "Add shot" box opens single picker
   - Board view shows full-size vertical gallery with tap-to-edit meta
   - Presentation modal with prev/next + fullscreen
   - Removed "+ Box" buttons; there is always a trailing blank
*/

(() => {
  // ---------- State ----------
  const state = {
    projectName: "",
    scenes: [], // [{id, name, shots:[Shot|null]}]
    autosaveKey: "sb_comic_v2",
    pendingReplace: null, // {sceneId, shotId}
    flatIndex: [] // for presentation order
  };

  const defaultMeta = () => ({ lens: "50mm", shotType: "MS", notes: "", dialogue: "" });
  const makeShot = ({ type="image", src="", filename="shot.png", meta } = {}) =>
    ({ id: uid(), type, src, filename, meta: meta || defaultMeta() });

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

  const presentBtn = el("#presentBtn");
  const viewToggle = el("#viewToggle");
  const comicView = el("#comicView");
  const boardView = el("#boardView");
  const scenesWrap = el("#scenes");

  const dropzone = el("#dropzone");
  const gallery = el("#gallery");

  const fileMulti = el("#fileMulti");
  const fileSingle = el("#fileSingle");
  const importFile = el("#importFile");

  // Presentation
  const player = el("#player");
  const stageMedia = el(".stage-media", player);
  const ovTL = el("#ovTopLeft");
  const ovTR = el("#ovTopRight");
  const ovB = el("#ovBottom");
  const prevBtn = el("#prevBtn");
  const nextBtn = el("#nextBtn");
  const fsBtn = el("#fsBtn");
  const closePlayer = el("#closePlayer");
  let curIdx = 0;

  // ---------- Init ----------
  bindUI();
  restore();
  if (state.scenes.length === 0) addScene();
  renderAll();

  // ---------- UI ----------
  function bindUI(){
    // Menu sheet
    menuBtn.addEventListener("click", ()=> { sheet.classList.add("show"); document.body.classList.add("sheet-open"); });
    sheet.addEventListener("click", (e)=> { if(e.target.classList.contains("sheet-backdrop")) hideSheet(); });
    closeSheet.addEventListener("click", hideSheet);
    function hideSheet(){ sheet.classList.remove("show"); document.body.classList.remove("sheet-open"); }

    addSceneBtn.addEventListener("click", ()=> { addScene(); renderAll(); persistDebounced(); hideSheet(); });
    addShotsBtn.addEventListener("click", ()=> { state.pendingReplace = null; fileMulti.click(); });
    importBtn.addEventListener("click", ()=> importFile.click());
    exportBtn.addEventListener("click", exportJSON);
    clearBtn.addEventListener("click", clearAll);

    projectName.addEventListener("input", ()=> { state.projectName = projectName.value.trim(); persistDebounced(); });

    // View toggle
    viewToggle.addEventListener("click", ()=>{
      const isComic = !comicView.classList.contains("hidden");
      if(isComic){ comicView.classList.add("hidden"); boardView.classList.remove("hidden"); viewToggle.textContent = "Board ▾"; buildGallery(); }
      else { boardView.classList.add("hidden"); comicView.classList.remove("hidden"); viewToggle.textContent = "Comic ▾"; }
    });

    // Dropzone tap + DnD
    dropzone.addEventListener("click", ()=> { state.pendingReplace = null; fileMulti.click(); });
    dropzone.addEventListener("keydown", (e)=> { if(e.key==="Enter"||e.key===" "){ e.preventDefault(); dropzone.click(); }});
    ["dragenter","dragover"].forEach(ev => dropzone.addEventListener(ev, (e)=> { e.preventDefault(); dropzone.classList.add("dragover"); }));
    ["dragleave","drop"].forEach(ev => dropzone.addEventListener(ev, (e)=> { e.preventDefault(); dropzone.classList.remove("dragover"); }));
    dropzone.addEventListener("drop", (e)=> { const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

    // File inputs
    fileMulti.addEventListener("change", (e)=> addFilesToScene(e.target.files));
    fileSingle.addEventListener("change", (e)=> replaceSingle(e.target.files?.[0]||null));
    importFile.addEventListener("change", (e)=> importJSON(e.target.files?.[0]||null));

    // Presentation
    presentBtn.addEventListener("click", openPresentation);
    prevBtn.addEventListener("click", ()=> showAt(curIdx-1));
    nextBtn.addEventListener("click", ()=> showAt(curIdx+1));
    fsBtn.addEventListener("click", ()=> { if(!document.fullscreenElement) player.requestFullscreen?.(); else document.exitFullscreen?.(); });
    closePlayer.addEventListener("click", closePresentation);
    document.addEventListener("keydown", (e)=>{
      if(!player.classList.contains("open")) return;
      if(e.key==="ArrowRight") showAt(curIdx+1);
      if(e.key==="ArrowLeft") showAt(curIdx-1);
      if(e.key==="Escape") closePresentation();
      if(e.key.toLowerCase()==="f") fsBtn.click();
    });
  }

  // ---------- Scene/Shot ops ----------
  function addScene(){
    const idx = state.scenes.length + 1;
    state.scenes.push({ id: uid(), name: `Scene ${idx}`, shots: [] });
  }

  function ensureTrailingEmpty(scene){
    // Always keep one empty slot at the end
    if(scene.shots.length===0 || scene.shots[scene.shots.length-1] !== null){
      scene.shots.push(null);
    }
  }

  async function addFilesToScene(fileList){
    const files = [...fileList].filter(f=> /^image\/|^video\//.test(f.type));
    if(files.length===0) return;
    const targetScene = state.pendingReplace ? getScene(state.pendingReplace.sceneId) : state.scenes[state.scenes.length-1];
    if(!targetScene) return;

    for(const f of files){
      const dataUrl = await fileToDataURL(f);
      const shot = makeShot({ type: f.type.startsWith("video") ? "video":"image", src:dataUrl, filename: f.name || "shot" });
      const emptyIdx = targetScene.shots.findIndex(s=> s===null);
      if(emptyIdx>=0) targetScene.shots[emptyIdx] = shot;
      else targetScene.shots.push(shot);
      ensureTrailingEmpty(targetScene);
    }
    state.pendingReplace = null;
    renderAll(); persistDebounced(); fileMulti.value = "";
  }

  async function replaceSingle(file){
    if(!file || !state.pendingReplace){ fileSingle.value=""; return; }
    const sc = getScene(state.pendingReplace.sceneId);
    const idx = sc?.shots.findIndex(s=> s && s.id === state.pendingReplace.shotId);
    if(sc && idx>=0){
      const dataUrl = await fileToDataURL(file);
      sc.shots[idx] = makeShot({ type: file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name || "shot" });
      ensureTrailingEmpty(sc);
      renderAll(); persistDebounced();
    }
    state.pendingReplace = null; fileSingle.value = "";
  }

  function deleteShot(sceneId, shotId){
    const sc = getScene(sceneId); if(!sc) return;
    const idx = sc.shots.findIndex(s=> s && s.id===shotId);
    if(idx>=0) sc.shots.splice(idx,1);
    ensureTrailingEmpty(sc); renderAll(); persistDebounced();
  }

  // ---------- Rendering (Comic) ----------
  function renderAll(){
    scenesWrap.innerHTML = "";
    state.scenes.forEach(scene => {
      ensureTrailingEmpty(scene);
      scenesWrap.appendChild(renderScene(scene));
    });
    projectName.value = state.projectName || "";
    if(!boardView.classList.contains("hidden")) buildGallery();
  }

  function renderScene(scene){
    const wrap = div("scene");

    // Head
    const head = div("scene-head");
    const title = div("scene-title", scene.name);
    title.contentEditable = "true"; title.spellcheck = false;
    title.addEventListener("input", debounce(()=> { scene.name = (title.textContent||"").trim() || scene.name; persistDebounced(); }, 300));
    head.appendChild(title);

    // Only “Shots” bulk add button remains (no “+ Box”)
    const actions = div("scene-actions");
    const addMediaBtn = smallBtn("📥 Shots", ()=> { state.pendingReplace = null; fileMulti.click(); });
    actions.appendChild(addMediaBtn);
    head.appendChild(actions);
    wrap.appendChild(head);

    // Strip
    const strip = div("strip");
    scene.shots.forEach((shot, idx)=> strip.appendChild(renderShot(scene, shot, idx)));
    strip.addEventListener("dragover", (e)=> e.preventDefault());
    wrap.appendChild(strip);
    return wrap;
  }

  function renderShot(scene, shot, idx){
    const card = div("shot");
    card.draggable = !!shot; // only draggable when filled

    if(!shot){ // empty box
      card.classList.add("empty");
      card.innerHTML = `<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
      // Tap = pick single file (your request)
      card.addEventListener("click", ()=>{
        state.pendingReplace = { sceneId: scene.id, shotId: "__empty__" }; // marker
        // when selected, fileSingle will be used; we’ll fill first empty in that scene
        fileSingle.click();
        // handle filling when replaceSingle runs (it replaces a real id; for empty, we just addFilesToScene)
        fileSingle.onchange = async (e)=>{
          const f = e.target.files?.[0]; if(!f){ fileSingle.value=""; return; }
          await addFilesToScene([f]); // fills first empty
          state.pendingReplace = null; fileSingle.value="";
        };
      });
      return card;
    }

    // Filled card
    const t = div("thumb");
    if(shot.type==="image"){ const img = new Image(); img.src = shot.src; img.alt = shot.filename; t.appendChild(img); }
    else{
      const v = document.createElement("video");
      v.src = shot.src; v.playsInline = true; v.controls = false; v.muted = true;
      v.addEventListener("mouseenter", ()=> v.play().catch(()=>{}));
      v.addEventListener("mouseleave", ()=> v.pause());
      t.appendChild(v);
    }
    const badge = div("badge", shot.type.toUpperCase()); t.appendChild(badge);

    const meta = div("meta"); meta.innerHTML = `<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;

    const overlay = div("overlay-info");
    overlay.textContent = shot.meta.dialogue || shot.meta.notes || `${shot.meta.lens} · ${shot.meta.shotType}`;
    card.appendChild(overlay);

    card.appendChild(t); card.appendChild(meta);

    // Tap toggle info
    card.addEventListener("click", ()=> card.classList.toggle("show-info"));

    // Long press for Replace/Delete
    longPress(card, 450, ()=>{
      mobilePrompt(["Replace","Delete","Cancel"]).then(opt=>{
        if(opt==="Replace"){ state.pendingReplace = { sceneId: scene.id, shotId: shot.id }; fileSingle.click(); }
        else if(opt==="Delete"){ deleteShot(scene.id, shot.id); }
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
      if(data.sceneId !== scene.id) return;
      const arr = scene.shots.filter(s=> s!==null);
      const from = arr.findIndex(s=> s.id===data.shotId);
      const to = arr.findIndex(s=> s && s.id===shot.id);
      if(from<0 || to<0) return;
      const [item] = arr.splice(from,1);
      arr.splice(to,0,item);
      // rebuild keeping nulls
      const newShots=[], iter=[...arr];
      scene.shots.forEach(s=> newShots.push(s===null? null : iter.shift()));
      scene.shots = newShots;
      renderAll(); persistDebounced();
    });

    return card;
  }

  // ---------- Board (vertical gallery) ----------
  function buildGallery(){
    gallery.innerHTML = "";
    state.scenes.forEach(scene=>{
      scene.shots.filter(Boolean).forEach(shot=>{
        gallery.appendChild(renderGalleryItem(scene, shot));
      });
    });
  }

  function renderGalleryItem(scene, shot){
    const wrap = div("gallery-item");
    const media = div("gallery-media");
    if(shot.type==="image"){ const img=new Image(); img.src=shot.src; img.alt=shot.filename; media.appendChild(img); }
    else{ const v=document.createElement("video"); v.src=shot.src; v.controls=true; v.playsInline=true; media.appendChild(v); }
    wrap.appendChild(media);

    const meta = div("gallery-meta");
    meta.innerHTML = `<div><strong>${esc(scene.name)}</strong> — ${esc(shot.filename)}</div>
      <button class="small-btn" type="button">Edit details</button>
      <div class="meta-panel">
        <div class="row cols-3">
          ${selectField("Lens", ["18mm","24mm","35mm","50mm","85mm","100mm"], shot.meta.lens)}
          ${selectField("Shot", ["WS","MS","CU","ECU","POV","OTS","2S","Establishing"], shot.meta.shotType)}
          <label class="field"><span>Notes</span><input data-k="notes" type="text" value="${esc(shot.meta.notes)}"/></label>
        </div>
        <label class="field"><span>Dialogue / Subtitle</span><input data-k="dialogue" type="text" value="${esc(shot.meta.dialogue)}"/></label>
      </div>`;
    wrap.appendChild(meta);

    const btn = meta.querySelector("button");
    const panel = meta.querySelector(".meta-panel");
    btn.addEventListener("click", ()=> panel.classList.toggle("show"));

    // Wire inputs
    meta.querySelectorAll("select").forEach(sel=>{
      sel.addEventListener("change", e=>{
        const k = e.target.dataset.k; shot.meta[k]= e.target.value; persistDebounced();
        // live update overlays if open
      });
    });
    meta.querySelectorAll("input[data-k]").forEach(inp=>{
      inp.addEventListener("input", e=>{ shot.meta[e.target.dataset.k]= e.target.value; persistDebounced(); });
    });

    return wrap;
  }

  function selectField(label, options, value){
    const opts = options.map(o=> `<option value="${o}" ${o===value?'selected':''}>${o}</option>`).join("");
    return `<label class="field"><span>${label}</span><select data-k="${label==='Lens'?'lens':'shotType'}">${opts}</select></label>`;
  }

  // ---------- Presentation ----------
  function openPresentation(){
    state.flatIndex = flattenShots(); if(state.flatIndex.length===0) return;
    curIdx = 0; player.classList.add("open"); player.setAttribute("aria-hidden","false");
    showAt(0);
  }
  function closePresentation(){
    player.classList.remove("open"); player.setAttribute("aria-hidden","true");
    stageMedia.innerHTML = "";
  }
  function flattenShots(){
    const arr = [];
    state.scenes.forEach(s => s.shots.filter(Boolean).forEach(sh => arr.push({scene:s, shot:sh})));
    return arr;
  }
  function showAt(i){
    const n = state.flatIndex.length; curIdx = (i%n+n)%n;
    stageMedia.innerHTML = "";
    const {scene, shot} = state.flatIndex[curIdx];

    let mediaEl;
    if(shot.type==="image"){ mediaEl = new Image(); mediaEl.src = shot.src; mediaEl.alt = shot.filename; }
    else{ mediaEl = document.createElement("video"); mediaEl.src = shot.src; mediaEl.controls = true; mediaEl.playsInline = true; mediaEl.autoplay = true; }
    stageMedia.appendChild(mediaEl);

    ovTL.textContent = scene.name;
    ovTR.textContent = `${shot.meta.lens} · ${shot.meta.shotType}`;
    ovB.textContent = shot.meta.dialogue || shot.meta.notes || "";
  }

  // ---------- Persistence / I/O ----------
  function persist(){ localStorage.setItem(state.autosaveKey, JSON.stringify({ projectName: state.projectName, scenes: state.scenes })); }
  const persistDebounced = debounce(persist, 300);

  function restore(){
    try{
      const raw = localStorage.getItem(state.autosaveKey); if(!raw) return;
      const data = JSON.parse(raw); state.projectName = data.projectName || ""; state.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    }catch{}
  }

  function exportJSON(){
    const blob = new Blob([JSON.stringify({
      schema:"storyboard_comic_v2",
      exportedAt: new Date().toISOString(),
      projectName: state.projectName || "Untitled",
      scenes: state.scenes
    }, null, 2)], {type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (sanitize(state.projectName)||"storyboard") + ".json";
    a.click(); URL.revokeObjectURL(a.href);
  }

  function importJSON(file){
    if(!file) return; file.text().then(txt=>{
      try{ const data = JSON.parse(txt); if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON");
        state.projectName = data.projectName || "Imported"; state.scenes = data.scenes; renderAll(); persist();
      }catch(err){ alert("Import failed: " + err.message); }
    });
    importFile.value = "";
  }

  function clearAll(){
    if(confirm("Clear all scenes and local save?")){ state.projectName=""; state.scenes=[]; addScene(); renderAll(); persist(); }
  }

  // ---------- Helpers ----------
  function uid(){ return Math.random().toString(36).slice(2,10); }
  function sanitize(s){ return String(s||"").replace(/[^\w\-]+/g,'_').slice(0,60); }
  function esc(s){ return String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
  function fileToDataURL(file){ return new Promise((res, rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
  function div(cls, txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
  function smallBtn(label, onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.addEventListener("click", onClick); return b; }
  function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  function longPress(el, ms, cb){ let t=null;
    el.addEventListener("touchstart", ()=> { t=setTimeout(cb, ms); }, {passive:true});
    el.addEventListener("touchend", ()=> { clearTimeout(t); }, {passive:true});
    el.addEventListener("touchmove", ()=> { clearTimeout(t); }, {passive:true});
    el.addEventListener("mousedown", ()=> { t=setTimeout(cb, ms); });
    el.addEventListener("mouseup", ()=> { clearTimeout(t); });
    el.addEventListener("mouseleave", ()=> { clearTimeout(t); });
  }

  // Build scene helper
  function getScene(id){ return state.scenes.find(s=> s.id===id); }

})();
