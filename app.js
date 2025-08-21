/* Storyboard — Comic + Board + Editor + Presentation + WebM "Quick Film"
   - Action sheet z-index & scroll lock fixed
   - Always-trailing empty box (tap to add)
   - Transition chip between shots
   - Editor sheet with movements, lens, shot type, transition, dialogue, notes
   - Per-shot voice note record/play (MediaRecorder)
   - Board view: full-size vertical gallery w/ Edit button
   - Presentation modal
   - Render Film: images get 7s; if voice note exists, image stays until note ends
*/

(() => {
  // ---------- State ----------
  const state = {
    projectName: "",
    scenes: [],            // [{id, name, shots:[Shot|null]}]
    autosaveKey: "sb_v3",
    pendingReplace: null,  // {sceneId, shotId}
    flatIndex: [],         // flattened order for presentation/export
    editRef: null          // {sceneId, shotId}
  };

  const defaultMeta = () => ({
    lens: "50mm",
    shotType: "MS",
    movements: [],     // ["Pan","Tilt",...]
    transition: "Cut", // transition leaving this shot
    dialogue: "",
    notes: "",
    voiceNote: null    // {url, duration}
  });
  const makeShot = ({ type="image", src="", filename="shot.png", meta } = {}) =>
    ({ id: uid(), type, src, filename, meta: meta || defaultMeta() });

  // ---------- Elements ----------
  const $ = (s, r=document) => r.querySelector(s);

  // top/menu
  const menuBtn = $("#menuBtn");
  const sheet = $("#sheet");
  const closeSheet = $("#closeSheet");
  const addSceneBtn = $("#addSceneBtn");
  const addShotsBtn = $("#addShotsBtn");
  const renderFilmBtn = $("#renderFilmBtn");
  const importBtn = $("#importBtn");
  const exportBtn = $("#exportBtn");
  const clearBtn = $("#clearBtn");
  const projectName = $("#projectName");

  const presentBtn = $("#presentBtn");
  const viewToggle = $("#viewToggle");
  const comicView = $("#comicView");
  const boardView = $("#boardView");
  const scenesWrap = $("#scenes");

  const dropzone = $("#dropzone");
  const gallery = $("#gallery");

  const fileMulti = $("#fileMulti");
  const fileSingle = $("#fileSingle");
  const importFile = $("#importFile");

  // editor
  const editor = $("#editor");
  const closeEditor = $("#closeEditor");
  const edLens = $("#edLens");
  const edShotType = $("#edShotType");
  const edTransition = $("#edTransition");
  const edMoves = $("#edMoves");
  const edDialogue = $("#edDialogue");
  const edNotes = $("#edNotes");
  const recBtn = $("#recBtn");
  const playNoteBtn = $("#playNoteBtn");
  const recStatus = $("#recStatus");
  const editorTitle = $("#editorTitle");

  // transition picker
  const transPicker = $("#transPicker");
  const transOptions = $("#transOptions");
  const closeTrans = $("#closeTrans");
  let transTarget = null; // shot id

  // presentation
  const player = $("#player");
  const stageMedia = $(".stage-media", player);
  const ovTL = $("#ovTopLeft");
  const ovTR = $("#ovTopRight");
  const ovB  = $("#ovBottom");
  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  const fsBtn   = $("#fsBtn");
  const closePlayer = $("#closePlayer");
  let curIdx = 0;

  // audio recording
  let mediaRec = null;
  let recChunks = [];
  let recStart = 0;

  // ---------- Init ----------
  bindUI();
  restore();
  if (state.scenes.length === 0) addScene();
  renderAll();

  // ---------- UI / Bindings ----------
  function bindUI(){
    // action sheet
    menuBtn.addEventListener("click", ()=> { openSheet(sheet); });
    sheet.addEventListener("click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheetFn(sheet); });
    closeSheet.addEventListener("click", ()=> closeSheetFn(sheet));

    addSceneBtn.addEventListener("click", ()=> { addScene(); renderAll(); persistDebounced(); closeSheetFn(sheet); });
    addShotsBtn.addEventListener("click", ()=> { state.pendingReplace = null; fileMulti.click(); });
    renderFilmBtn.addEventListener("click", ()=> { closeSheetFn(sheet); exportWebM(); });
    importBtn.addEventListener("click", ()=> importFile.click());
    exportBtn.addEventListener("click", exportJSON);
    clearBtn.addEventListener("click", clearAll);
    projectName.addEventListener("input", ()=> { state.projectName = projectName.value.trim(); persistDebounced(); });

    // view toggle
    viewToggle.addEventListener("click", ()=>{
      const comic = !comicView.classList.contains("hidden");
      if(comic){ comicView.classList.add("hidden"); boardView.classList.remove("hidden"); viewToggle.textContent = "Board ▾"; buildGallery(); }
      else { boardView.classList.add("hidden"); comicView.classList.remove("hidden"); viewToggle.textContent = "Comic ▾"; }
    });

    // dropzone
    dropzone.addEventListener("click", ()=> { state.pendingReplace = null; fileMulti.click(); });
    dropzone.addEventListener("keydown", e=> { if(e.key==="Enter"||e.key===" ") { e.preventDefault(); dropzone.click(); }});
    ["dragenter","dragover"].forEach(ev => dropzone.addEventListener(ev, e=> { e.preventDefault(); dropzone.classList.add("dragover"); }));
    ["dragleave","drop"].forEach(ev => dropzone.addEventListener(ev, e=> { e.preventDefault(); dropzone.classList.remove("dragover"); }));
    dropzone.addEventListener("drop", e=> { const dt=e.dataTransfer; if(dt?.files?.length) addFilesToScene(dt.files); });

    // files
    fileMulti.addEventListener("change", e=> addFilesToScene(e.target.files));
    fileSingle.addEventListener("change", e=> replaceSingle(e.target.files?.[0]||null));
    importFile.addEventListener("change", e=> importJSON(e.target.files?.[0]||null));

    // editor
    editor.addEventListener("click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheetFn(editor); });
    closeEditor.addEventListener("click", ()=> closeSheetFn(editor));
    edLens.addEventListener("change", saveEditor);
    edShotType.addEventListener("change", saveEditor);
    edTransition.addEventListener("change", saveEditor);
    edDialogue.addEventListener("input", saveEditor);
    edNotes.addEventListener("input", saveEditor);

    // movements chips
    ["Pan","Tilt","Zoom","Dolly","Truck","Pedestal","Handheld","Static","Rack Focus"].forEach(m=>{
      const b = document.createElement("button");
      b.type = "button"; b.className="tag"; b.textContent = m; b.dataset.mov = m;
      b.addEventListener("click", ()=> { b.classList.toggle("active"); saveEditor(); });
      edMoves.appendChild(b);
    });

    // audio buttons
    recBtn.addEventListener("click", toggleRecord);
    playNoteBtn.addEventListener("click", playVoiceNote);

    // transition picker
    transPicker.addEventListener("click", e=> { if(e.target.classList.contains("sheet-backdrop")) closeSheetFn(transPicker); });
    closeTrans.addEventListener("click", ()=> closeSheetFn(transPicker));
    ["Cut","Dissolve","Fade","Wipe","Match Cut","Whip Pan","J-Cut","L-Cut"].forEach(t=>{
      const b = document.createElement("button");
      b.className="tag"; b.textContent = t;
      b.addEventListener("click", ()=> { setShotMeta(transTarget, { transition:t }); closeSheetFn(transPicker); });
      transOptions.appendChild(b);
    });

    // presentation
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
    });
  }

  // ---------- Scene / Shot ops ----------
  function addScene(){
    const idx = state.scenes.length + 1;
    state.scenes.push({ id: uid(), name: `Scene ${idx}`, shots: [] });
  }

  function ensureTrailingEmpty(scene){
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
      const shot = makeShot({ type: f.type.startsWith("video") ? "video" : "image", src: dataUrl, filename: f.name || "shot" });
      const emptyIdx = targetScene.shots.findIndex(s=> s===null);
      if(emptyIdx>=0) targetScene.shots[emptyIdx] = shot;
      else targetScene.shots.push(shot);
      ensureTrailingEmpty(targetScene);
    }
    state.pendingReplace = null;
    renderAll(); persistDebounced(); fileMulti.value="";
  }

  async function replaceSingle(file){
    if(!file) { fileSingle.value=""; return; }
    const dataUrl = await fileToDataURL(file);
    if(state.pendingReplace && state.pendingReplace.shotId && state.pendingReplace.shotId !== "__empty__"){
      const {sceneId, shotId} = state.pendingReplace;
      const sc = getScene(sceneId);
      const idx = sc?.shots.findIndex(s=> s && s.id===shotId);
      if(idx>=0){
        sc.shots[idx] = makeShot({ type:file.type.startsWith("video")?"video":"image", src:dataUrl, filename:file.name||"shot" });
        ensureTrailingEmpty(sc);
      }
    } else {
      await addFilesToScene([file]); // fills first empty by design
    }
    state.pendingReplace = null;
    renderAll(); persistDebounced(); fileSingle.value="";
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
    state.scenes.forEach(scene=>{
      ensureTrailingEmpty(scene);
      scenesWrap.appendChild(renderScene(scene));
    });
    projectName.value = state.projectName || "";
    if(!boardView.classList.contains("hidden")) buildGallery();
  }

  function renderScene(scene){
    const wrap = div("scene");

    // header
    const head = div("scene-head");
    const title = div("scene-title", scene.name);
    title.contentEditable = "true"; title.spellcheck=false;
    title.addEventListener("input", debounce(()=> { scene.name=(title.textContent||"").trim()||scene.name; persistDebounced(); }, 250));
    head.appendChild(title);

    const actions = div("scene-actions");
    const addMediaBtn = smallBtn("📥 Shots", ()=> { state.pendingReplace=null; fileMulti.click(); });
    actions.appendChild(addMediaBtn);
    head.appendChild(actions);

    wrap.appendChild(head);

    // strip
    const strip = div("strip");
    scene.shots.forEach((shot, idx)=>{
      if(shot){ // filled shot
        strip.appendChild(renderShot(scene, shot));
        // transition chip after filled shot (except last empty)
        if(idx < scene.shots.length-1){
          const chip = div("trans-chip");
          const b = document.createElement("button");
          b.textContent = shot.meta?.transition || "Cut";
          b.addEventListener("click", ()=> { transTarget = shot.id; openSheet(transPicker); });
          chip.appendChild(b); strip.appendChild(chip);
        }
      } else { // empty last box
        const card = div("shot empty");
        card.innerHTML = `<div class="thumb"><div class="add-box"><div class="plus">＋</div><div>Tap to add</div></div></div><div class="meta">Empty</div>`;
        card.addEventListener("click", ()=>{
          state.pendingReplace = { sceneId: scene.id, shotId: "__empty__" };
          fileSingle.click();
        });
        strip.appendChild(card);
      }
    });

    strip.addEventListener("dragover", e=> e.preventDefault());
    wrap.appendChild(strip);
    return wrap;
  }

  function renderShot(scene, shot){
    const card = div("shot"); card.draggable = true;

    const t = div("thumb");
    if(shot.type==="image"){ const img=new Image(); img.src=shot.src; img.alt=shot.filename; t.appendChild(img); }
    else{ const v=document.createElement("video"); v.src=shot.src; v.playsInline=true; v.muted=true; v.addEventListener("mouseenter",()=>v.play().catch(()=>{})); v.addEventListener("mouseleave",()=>v.pause()); t.appendChild(v); }
    const badge = div("badge", shot.type.toUpperCase()); t.appendChild(badge);

    const meta = div("meta"); meta.innerHTML = `<strong>${esc(scene.name)}</strong><br><span>${esc(shot.meta.lens)} · ${esc(shot.meta.shotType)}</span>`;
    const overlay = div("overlay-info"); overlay.textContent = shot.meta.dialogue || shot.meta.notes || `${shot.meta.lens} · ${shot.meta.shotType}`;

    card.appendChild(t); card.appendChild(meta); card.appendChild(overlay);

    // tap to edit (also toggles info by tapping meta area)
    card.addEventListener("click", (e)=>{
      if(e.target.closest(".meta")){ card.classList.toggle("show-info"); return; }
      openEditor(scene.id, shot.id);
    });

    // long-press: replace/delete
    longPress(card, 450, ()=>{
      mobilePrompt(["Replace","Delete","Cancel"]).then(opt=>{
        if(opt==="Replace"){ state.pendingReplace={sceneId:scene.id, shotId:shot.id}; fileSingle.click(); }
        else if(opt==="Delete"){ deleteShot(scene.id, shot.id); }
      });
    });

    // DnD within scene
    card.addEventListener("dragstart", e=>{
      e.dataTransfer.setData("text/plain", JSON.stringify({sceneId: scene.id, shotId: shot.id}));
      setTimeout(()=> card.classList.add("dragging"),0);
    });
    card.addEventListener("dragend", ()=> card.classList.remove("dragging"));
    card.addEventListener("drop", e=>{
      e.preventDefault();
      const data = JSON.parse(e.dataTransfer.getData("text/plain")||"{}");
      if(data.sceneId !== scene.id) return;
      const arr = scene.shots.filter(s=>s!==null);
      const from = arr.findIndex(s=>s.id===data.shotId);
      const to   = arr.findIndex(s=>s.id===shot.id);
      if(from<0||to<0) return;
      const [item]=arr.splice(from,1); arr.splice(to,0,item);
      const newShots=[], iter=[...arr]; scene.shots.forEach(s=> newShots.push(s===null?null:iter.shift()));
      scene.shots = newShots; renderAll(); persistDebounced();
    });

    return card;
  }

  // ---------- Board (vertical gallery) ----------
  function buildGallery(){
    gallery.innerHTML = "";
    state.scenes.forEach(scene=>{
      scene.shots.filter(Boolean).forEach(shot=>{
        const wrap = div("gallery-item");
        const media = div("gallery-media");
        if(shot.type==="image"){ const img=new Image(); img.src=shot.src; img.alt=shot.filename; media.appendChild(img); }
        else{ const v=document.createElement("video"); v.src=shot.src; v.controls=true; v.playsInline=true; media.appendChild(v); }
        wrap.appendChild(media);

        const meta = div("gallery-meta");
        const editBtn = document.createElement("button"); editBtn.className="small-btn"; editBtn.textContent="Edit details";
        editBtn.addEventListener("click", ()=> openEditor(scene.id, shot.id));
        meta.innerHTML = `<div><strong>${esc(scene.name)}</strong> — ${esc(shot.filename)}</div>`;
        meta.appendChild(editBtn);
        wrap.appendChild(meta);
        gallery.appendChild(wrap);
      });
    });
  }

  // ---------- Editor ----------
  function openEditor(sceneId, shotId){
    state.editRef = {sceneId, shotId};
    const shot = getShot(sceneId, shotId); if(!shot) return;
    editorTitle.textContent = `Edit • ${shot.filename}`;
    edLens.value = shot.meta.lens || "50mm";
    edShotType.value = shot.meta.shotType || "MS";
    edTransition.value = shot.meta.transition || "Cut";
    edDialogue.value = shot.meta.dialogue || "";
    edNotes.value = shot.meta.notes || "";
    // movements
    [...edMoves.querySelectorAll(".tag")].forEach(b=>{
      const mv = b.dataset.mov; b.classList.toggle("active", !!shot.meta.movements?.includes(mv));
    });
    // voice note status
    if(shot.meta.voiceNote){ recStatus.textContent = `Voice note • ${formatTime(shot.meta.voiceNote.duration)}`; playNoteBtn.disabled=false; }
    else { recStatus.textContent = "No voice note"; playNoteBtn.disabled=true; }
    openSheet(editor);
  }

  function saveEditor(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
    shot.meta.lens = edLens.value;
    shot.meta.shotType = edShotType.value;
    shot.meta.transition = edTransition.value;
    shot.meta.dialogue = edDialogue.value;
    shot.meta.notes = edNotes.value;
    const moves = [...edMoves.querySelectorAll(".tag.active")].map(b=> b.dataset.mov);
    shot.meta.movements = moves;
    persistDebounced(); renderAll(); // keep views in sync
  }

  // voice notes
  async function toggleRecord(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot) return;
    if(mediaRec && mediaRec.state==="recording"){ mediaRec.stop(); return; }

    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      recChunks = []; mediaRec = new MediaRecorder(stream);
      mediaRec.ondataavailable = e=> { if(e.data.size) recChunks.push(e.data); };
      mediaRec.onstart = ()=> { recStart = Date.now(); recStatus.textContent="Recording… tap to stop"; recBtn.textContent="⏹ Stop"; };
      mediaRec.onstop = ()=>{
        const blob = new Blob(recChunks, {type: mediaRec.mimeType || "audio/webm"});
        const url = URL.createObjectURL(blob);
        const dur = (Date.now()-recStart)/1000;
        shot.meta.voiceNote = { url, duration: dur, mime: blob.type };
        recStatus.textContent = `Saved • ${formatTime(dur)}`;
        playNoteBtn.disabled = false;
        recBtn.textContent = "🎙 Record";
        persistDebounced();
      };
      mediaRec.start();
    }catch(err){
      alert("Mic access failed: " + err.message);
    }
  }

  function playVoiceNote(){
    const shot = getShot(state.editRef?.sceneId, state.editRef?.shotId); if(!shot?.meta.voiceNote) return;
    const a = new Audio(shot.meta.voiceNote.url); a.play().catch(()=>{});
  }

  // ---------- Transition (chip) ----------
  function setShotMeta(shotId, patch){
    state.scenes.forEach(s=>{
      s.shots.forEach(sh=>{
        if(sh && sh.id===shotId) Object.assign(sh.meta, patch);
      });
    });
    persistDebounced(); renderAll();
  }

  // ---------- Presentation ----------
  function openPresentation(){
    state.flatIndex = flattenShots(); if(state.flatIndex.length===0) return;
    curIdx = 0; player.classList.add("open"); player.setAttribute("aria-hidden","false"); showAt(0);
  }
  function closePresentation(){
    player.classList.remove("open"); player.setAttribute("aria-hidden","true"); stageMedia.innerHTML="";
  }
  function flattenShots(){
    const arr=[]; state.scenes.forEach(s=> s.shots.filter(Boolean).forEach(sh=> arr.push({scene:s, shot:sh}))); return arr;
  }
  function showAt(i){
    const n=state.flatIndex.length; curIdx=(i%n+n)%n;
    const {scene, shot} = state.flatIndex[curIdx];
    stageMedia.innerHTML="";
    let el;
    if(shot.type==="image"){ el=new Image(); el.src=shot.src; el.alt=shot.filename; }
    else{ el=document.createElement("video"); el.src=shot.src; el.controls=true; el.playsInline=true; el.autoplay=true; }
    stageMedia.appendChild(el);
    ovTL.textContent = scene.name;
    ovTR.textContent = `${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
    ovB.textContent = shot.meta.dialogue || shot.meta.notes || "";
  }

  // ---------- Export WebM (images + voice notes) ----------
  async function exportWebM(){
    const flat = flattenShots(); if(flat.length===0){ alert("Add shots first."); return; }

    const fps = 30, width=1280, height=720;
    const canvas = document.createElement("canvas"); canvas.width=width; canvas.height=height;
    const ctx = canvas.getContext("2d");

    // audio mixing for voice notes
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();

    // capture canvas as video stream
    const vstream = canvas.captureStream(fps);
    // combine canvas video with audio graph
    const mixed = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

    // recorder
    let chunks=[]; let rec;
    try{ rec = new MediaRecorder(mixed, { mimeType: "video/webm;codecs=vp9" }); }
    catch{ try{ rec = new MediaRecorder(mixed, { mimeType:"video/webm;codecs=vp8" }); } catch(e){ alert("WebM recording not supported."); return; } }
    rec.ondataavailable = e=> { if(e.data.size) chunks.push(e.data); };
    const done = new Promise(res=> rec.onstop = res);
    rec.start();

    // helpers
    function drawCover(media){
      const iw = media.videoWidth || media.naturalWidth || width;
      const ih = media.videoHeight || media.naturalHeight || height;
      const ir = iw/ih, r = width/height;
      let dw, dh; if(ir>r){ dh=height; dw=ir*dh; } else { dw=width; dh=dw/ir; }
      const dx=(width-dw)/2, dy=(height-dh)/2;
      ctx.fillStyle="#000"; ctx.fillRect(0,0,width,height);
      ctx.drawImage(media, dx, dy, dw, dh);
    }
    function drawOverlays(scene, shot){
      // TL
      ctx.save();
      ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(10,10,320,28);
      ctx.fillStyle="#e9eef9"; ctx.font="700 16px system-ui";
      ctx.fillText(`${scene.name}`, 18, 30);
      ctx.restore();
      // TR
      const txt = `${shot.meta.lens} · ${shot.meta.shotType} • ${shot.meta.transition||"Cut"}`;
      const tw = ctx.measureText(txt).width + 24;
      ctx.save();
      ctx.fillStyle="rgba(0,0,0,.55)"; ctx.fillRect(width - tw - 10, 10, tw, 28);
      ctx.fillStyle="#e9eef9"; ctx.font="700 16px system-ui";
      ctx.fillText(txt, width - tw + 2, 30);
      ctx.restore();
      // Bottom dialogue
      if(shot.meta.dialogue || shot.meta.notes){
        const text = shot.meta.dialogue || shot.meta.notes;
        ctx.save();
        ctx.fillStyle="rgba(0,0,0,.6)"; ctx.fillRect(0, height-80, width, 80);
        ctx.fillStyle="#e9eef9"; ctx.font="700 20px system-ui";
        wrapText(ctx, text, width-60).forEach((ln,i)=> ctx.fillText(ln, 30, height-50 + i*24));
        ctx.restore();
      }
    }
    function waitFrames(n){ return new Promise(res=> setTimeout(res, (1000/fps)*n)); }

    // schedule voice notes in audio graph
    let audioTime = ac.currentTime;
    for(const {shot} of flat){
      if(shot.type==="image"){
        const base = Math.max(7, shot.meta.voiceNote?.duration || 0);
        // play voice note if exists
        if(shot.meta.voiceNote?.url){
          const buf = await fetch(shot.meta.voiceNote.url).then(r=>r.arrayBuffer()).then(b=> ac.decodeAudioData(b.slice(0)));
          const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest);
          src.start(audioTime);
        }
        audioTime += base;
      } else {
        // skip mixing video audio for now (keeps compatibility)
        audioTime += (7); // placeholder duration, visual only; actual frames below
      }
    }

    // visual rendering pass
    for(const {scene, shot} of flat){
      if(shot.type==="image"){
        const img = await loadImage(shot.src);
        const hold = Math.max(7, shot.meta.voiceNote?.duration || 0);
        const frames = Math.max(1, Math.round(fps*hold));
        for(let f=0; f<frames; f++){
          drawCover(img); drawOverlays(scene, shot);
          await waitFrames(1);
        }
      } else {
        // draw frames from video for ~7s
        const v = document.createElement("video");
        v.src = shot.src; v.playsInline = true; await v.play().catch(()=>{});
        const endAt = performance.now() + 7000;
        while(performance.now() < endAt){
          drawCover(v); drawOverlays(scene, shot);
          await waitFrames(1);
        }
        v.pause();
      }
    }

    rec.stop(); await done;
    const blob = new Blob(chunks, {type: rec.mimeType || "video/webm"});
    downloadBlob(blob, sanitize(state.projectName||"storyboard")+"_quickfilm.webm", blob.type);
    alert("Film rendered. If audio is quiet, raise device volume; video-clip audio not mixed (by design for compatibility).");
  }

  // ---------- Persistence / I/O ----------
  function persist(){ localStorage.setItem(state.autosaveKey, JSON.stringify({ projectName: state.projectName, scenes: state.scenes })); }
  const persistDebounced = debounce(persist, 300);
  function restore(){ try{ const raw=localStorage.getItem(state.autosaveKey); if(!raw) return; const data=JSON.parse(raw); state.projectName=data.projectName||""; state.scenes=Array.isArray(data.scenes)?data.scenes:[]; }catch{} }

  function exportJSON(){
    const blob = new Blob([JSON.stringify({ schema:"storyboard_v3", exportedAt:new Date().toISOString(), projectName: state.projectName||"Untitled", scenes: state.scenes }, null, 2)], {type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (sanitize(state.projectName)||"storyboard")+".json"; a.click(); URL.revokeObjectURL(a.href);
  }
  function importJSON(file){
    if(!file) return; file.text().then(txt=>{
      try{ const data=JSON.parse(txt); if(!Array.isArray(data.scenes)) throw new Error("Invalid JSON"); state.projectName=data.projectName||"Imported"; state.scenes=data.scenes; renderAll(); persist(); }
      catch(err){ alert("Import failed: "+err.message); }
    }); importFile.value="";
  }
  function clearAll(){ if(confirm("Clear all scenes and local save?")){ state.projectName=""; state.scenes=[]; addScene(); renderAll(); persist(); } }

  // ---------- Helpers ----------
  function getScene(id){ return state.scenes.find(s=> s.id===id); }
  function getShot(sceneId, shotId){ return getScene(sceneId)?.shots.find(s=> s && s.id===shotId) || null; }
  function uid(){ return Math.random().toString(36).slice(2,10); }
  function sanitize(s){ return String(s||"").replace(/[^\w\-]+/g,'_').slice(0,60); }
  function esc(s){ return String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
  function fileToDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
  function div(cls, txt){ const d=document.createElement("div"); d.className=cls; if(txt!=null) d.textContent=txt; return d; }
  function smallBtn(label, onClick){ const b=document.createElement("button"); b.className="small-btn"; b.textContent=label; b.addEventListener("click", onClick); return b; }
  function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
  function longPress(el, ms, cb){ let t=null; el.addEventListener("touchstart",()=>{ t=setTimeout(cb,ms); },{passive:true}); el.addEventListener("touchend",()=>{ clearTimeout(t); },{passive:true}); el.addEventListener("touchmove",()=>{ clearTimeout(t); },{passive:true}); el.addEventListener("mousedown",()=>{ t=setTimeout(cb,ms); }); el.addEventListener("mouseup",()=>{ clearTimeout(t); }); el.addEventListener("mouseleave",()=>{ clearTimeout(t); }); }
  function openSheet(sh){ sh.classList.add("show"); document.body.classList.add("sheet-open"); }
  function closeSheetFn(sh){ sh.classList.remove("show"); document.body.classList.remove("sheet-open"); }
  function loadImage(src){ return new Promise((res,rej)=>{ const img=new Image(); img.onload=()=>res(img); img.onerror=rej; img.src=src; }); }
  function wrapText(ctx, text, maxWidth){ const words=String(text||"").split(/\s+/); const lines=[]; let line=""; ctx.font="700 20px system-ui"; for(const w of words){ const t=line?line+" "+w:w; if(ctx.measureText(t).width>maxWidth){ if(line) lines.push(line); line=w; } else line=t; } if(line) lines.push(line); return lines; }
  function downloadBlob(data, filename, type){ const blob = data instanceof Blob? data : new Blob([data],{type}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 1500); }
  function formatTime(s){ s=Math.round(s); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,"0")}`; }
})();
