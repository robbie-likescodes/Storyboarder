/* Storyboard Studio — core app
   - Drag/drop + file input for images/videos
   - Per-slide metadata editing
   - Reorder via drag & drop
   - Presentation view with overlays + video audio
   - Auto-save to localStorage; JSON import/export; print
*/

(() => {
  // ---------- State ----------
  const DEFAULT_IMAGE_DURATION = 4; // seconds for images (auto-advance)
  let slides = [];                   // {id,type,src,filename,meta}
  let current = 0;
  let autoAdvance = false;
  let autoTimer = null;

  // ---------- Elements ----------
  const fileInput = qs("#fileInput");
  const importJson = qs("#importJson");
  const addBlankBtn = qs("#addBlankBtn");
  const exportJsonBtn = qs("#exportJsonBtn");
  const printBtn = qs("#printBtn");
  const presentBtn = qs("#presentBtn");
  const clearBtn = qs("#clearBtn");
  const dropzone = qs("#dropzone");
  const container = qs("#slidesContainer");
  const statusMsg = qs("#statusMsg");
  const themeToggle = qs("#themeToggle");

  // Player
  const player = qs("#player");
  const stageMedia = qs(".stage-media");
  const ovTL = qs("#ovTopLeft");
  const ovTR = qs("#ovTopRight");
  const ovB = qs("#ovBottom");
  const prevBtn = qs("#prevBtn");
  const nextBtn = qs("#nextBtn");
  const autoBtn = qs("#autoBtn");
  const fsBtn = qs("#fsBtn");
  const closePlayer = qs("#closePlayer");

  // ---------- Utilities ----------
  const uid = () => Math.random().toString(36).slice(2, 10);
  function qs(sel, el=document){ return el.querySelector(sel); }
  function qsa(sel, el=document){ return [...el.querySelectorAll(sel)]; }
  const debounce = (fn, ms=300) => {
    let t; return (...args) => { clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
  };

  function setStatus(msg){ statusMsg.textContent = msg; }

  function persist(){
    try{
      localStorage.setItem("storyboard_v1", JSON.stringify(slides));
      setStatus(`Saved ${slides.length} slide${slides.length!==1?'s':''}.`);
    }catch(e){
      setStatus("⚠ Could not save to localStorage (too large?). Export JSON instead.");
    }
  }
  const persistDebounced = debounce(persist, 400);

  function restore(){
    try{
      const raw = localStorage.getItem("storyboard_v1");
      if(!raw) return;
      slides = JSON.parse(raw) || [];
      render();
      setStatus(`Loaded ${slides.length} slide${slides.length!==1?'s':''} from localStorage.`);
    }catch(e){
      setStatus("⚠ Failed to load saved storyboard.");
    }
  }

  // ---------- Slide creation ----------
  async function handleFiles(fileList){
    const files = [...fileList];
    for(const f of files){
      if(!/^image\/|^video\//.test(f.type)) continue;
      const dataUrl = await fileToDataURL(f);
      const type = f.type.startsWith("video") ? "video" : "image";
      slides.push({
        id: uid(),
        type,
        src: dataUrl,
        filename: f.name || (type + "-" + Date.now()),
        meta: defaultMeta()
      });
    }
    render();
    persistDebounced();
  }

  function defaultMeta(){
    return {
      scene: "",
      lens: "50mm",
      shotType: "MS",
      movements: [], // e.g., ["Pan","Tilt"]
      transition: "Cut",
      duration: DEFAULT_IMAGE_DURATION, // image only
      dialogue: "",
      description: ""
    };
  }

  function fileToDataURL(file){
    return new Promise((res, rej)=>{
      const reader = new FileReader();
      reader.onload = e => res(e.target.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
  }

  function addBlankSlide(){
    slides.push({
      id: uid(),
      type: "image",
      src: blankCanvasDataUrl(),
      filename: "blank.png",
      meta: defaultMeta()
    });
    render();
    persistDebounced();
  }

  function blankCanvasDataUrl(){
    const c = document.createElement("canvas");
    c.width = 1600; c.height = 900;
    const g = c.getContext("2d");
    g.fillStyle = "#0d0f12"; g.fillRect(0,0,c.width,c.height);
    g.fillStyle = "#2c3b57"; g.fillRect(0, c.height-160, c.width, 160);
    g.fillStyle = "#cfeaff"; g.font = "48px system-ui";
    g.fillText("Blank Slide", 50, c.height-90);
    return c.toDataURL("image/png");
  }

  // ---------- Rendering ----------
  function render(){
    container.innerHTML = "";
    slides.forEach((slide, idx) => {
      container.appendChild(renderCard(slide, idx));
    });
    setStatus(`Slides: ${slides.length}`);
  }

  function renderCard(slide, index){
    const card = el("article", {class:"card", draggable:"true", "data-id":slide.id});

    // Thumb
    const thumb = el("div", {class:"thumb"});
    const badge = el("span", {class:"badge"}, slide.type.toUpperCase());
    const dragIcon = el("div", {class:"drag-handle", title:"Drag to reorder"}, "⋮⋮");
    thumb.appendChild(badge);
    thumb.appendChild(dragIcon);

    if(slide.type === "image"){
      const img = el("img", {src: slide.src, alt: slide.filename});
      thumb.appendChild(img);
    } else {
      const v = el("video", {src: slide.src, muted:"", playsinline:"", loop:""});
      v.addEventListener("mouseenter", ()=> v.play().catch(()=>{}));
      v.addEventListener("mouseleave", ()=> v.pause());
      thumb.appendChild(v);
    }

    // Content / fields
    const content = el("div", {class:"content"});

    const sceneRow = el("div", {class:"row"});
    sceneRow.appendChild(field("Scene / Shot Title", el("input", {
      type:"text", value: slide.meta.scene, placeholder:"E.g., Alley confrontation"
    }, null, (ev)=>{ slide.meta.scene = ev.target.value; persistDebounced(); })));
    content.appendChild(sceneRow);

    const row2 = el("div", {class:"row cols-3"});
    row2.appendChild(selectField("Lens", ["18mm","24mm","35mm","50mm","85mm","100mm"], slide.meta.lens, (v)=>{ slide.meta.lens=v; persistDebounced(); }));
    row2.appendChild(selectField("Shot Type", ["WS","MS","CU","ECU","POV","OTS","2S","Establishing"], slide.meta.shotType, (v)=>{ slide.meta.shotType=v; persistDebounced(); }));
    row2.appendChild(selectField("Transition", ["Cut","Dissolve","Fade","Wipe","Match Cut","Whip Pan"], slide.meta.transition, (v)=>{ slide.meta.transition=v; persistDebounced(); }));
    content.appendChild(row2);

    const movesRow = el("div", {class:"row"});
    movesRow.appendChild(movementField(slide));
    content.appendChild(movesRow);

    const notesRow = el("div", {class:"row cols-2"});
    notesRow.appendChild(field("Dialogue (subtitles)", el("textarea", {}, slide.meta.dialogue, (ev)=>{ slide.meta.dialogue=ev.target.value; persistDebounced(); })));
    notesRow.appendChild(field("Description / Notes", el("textarea", {}, slide.meta.description, (ev)=>{ slide.meta.description=ev.target.value; persistDebounced(); })));
    content.appendChild(notesRow);

    if(slide.type === "image"){
      const durRow = el("div", {class:"row cols-3"});
      durRow.appendChild(field("Duration (sec in slideshow)", el("input", {type:"number", min:"1", max:"60", value: slide.meta.duration}, null,
        (ev)=>{ slide.meta.duration = Math.max(1, Math.min(60, Number(ev.target.value)||DEFAULT_IMAGE_DURATION)); persistDebounced(); })));
      durRow.appendChild(el("div")); durRow.appendChild(el("div"));
      content.appendChild(durRow);
    }

    // Actions
    const actions = el("div", {class:"actions"});
    const left = el("div", {class:"left"});
    const right = el("div", {class:"right"});

    const upBtn = btn("↑", "Move up", () => moveSlide(index, -1));
    const downBtn = btn("↓", "Move down", () => moveSlide(index, +1));
    const delBtn = btn("Delete", "Remove slide", () => removeSlide(slide.id), "danger");

    left.appendChild(upBtn);
    left.appendChild(downBtn);
    right.appendChild(delBtn);
    actions.appendChild(left);
    actions.appendChild(right);

    card.appendChild(thumb);
    card.appendChild(content);
    card.appendChild(actions);

    // Drag sorting
    card.addEventListener("dragstart", (e)=>{
      e.dataTransfer.setData("text/plain", slide.id);
      card.classList.add("drag-ghost");
    });
    card.addEventListener("dragend", ()=> card.classList.remove("drag-ghost"));
    card.addEventListener("dragover", (e)=> e.preventDefault());
    card.addEventListener("drop", (e)=>{
      e.preventDefault();
      const draggedId = e.dataTransfer.getData("text/plain");
      const targetId = slide.id;
      reorderByIds(draggedId, targetId);
    });

    return card;
  }

  function moveSlide(index, delta){
    const newIndex = index + delta;
    if(newIndex < 0 || newIndex >= slides.length) return;
    const [item] = slides.splice(index, 1);
    slides.splice(newIndex, 0, item);
    render();
    persistDebounced();
  }

  function removeSlide(id){
    slides = slides.filter(s => s.id !== id);
    render();
    persistDebounced();
  }

  function reorderByIds(dragId, dropId){
    if(dragId === dropId) return;
    const from = slides.findIndex(s=>s.id===dragId);
    const to = slides.findIndex(s=>s.id===dropId);
    const [item] = slides.splice(from,1);
    slides.splice(to,0,item);
    render();
    persistDebounced();
  }

  // ---------- Field builders ----------
  function el(tag, attrs={}, text=null, onInput){
    const node = document.createElement(tag);
    for(const [k,v] of Object.entries(attrs||{})){
      if(v===null || v===undefined) continue;
      node.setAttribute(k, v);
    }
    if(text!==null && text!==undefined) node.textContent = text;
    if(onInput) node.addEventListener("input", onInput);
    return node;
  }

  function btn(label, title, onClick, style){
    const b = el("button", {class: `btn${style?(" "+style):""}`, title}, label);
    b.addEventListener("click", onClick);
    return b;
  }

  function field(labelText, inputEl){
    const w = el("label", {class:"field"});
    const span = el("span", {}, labelText);
    w.appendChild(span);
    w.appendChild(inputEl);
    return w;
  }

  function selectField(labelText, opts, value, onChange){
    const select = el("select");
    opts.forEach(o=>{
      const opt = el("option", {value:o}, o);
      if(o===value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", (e)=> onChange(e.target.value));
    return field(labelText, select);
  }

  function movementField(slide){
    const wrap = el("div");
    wrap.appendChild(el("div", {class:"tags-label", style:"margin-bottom:6px;color:var(--text-dim);font-size:12px"}, "Camera Movement"));
    const movements = ["Pan","Tilt","Zoom","Dolly","Truck","Pedestal","Handheld","Static"];
    const row = el("div", {class:"tags"});
    movements.forEach(m=>{
      const chip = el("button", {class:"tag", type:"button", "aria-pressed": slide.meta.movements.includes(m)?"true":"false"}, m);
      chip.addEventListener("click", ()=>{
        const list = slide.meta.movements;
        const i = list.indexOf(m);
        (i>=0) ? list.splice(i,1) : list.push(m);
        chip.setAttribute("aria-pressed", String(i<0));
        persistDebounced();
      });
      row.appendChild(chip);
    });
    wrap.appendChild(row);
    return field("", wrap);
  }

  // ---------- Presentation ----------
  function openPlayer(startIdx=0){
    if(slides.length===0) return;
    current = Math.max(0, Math.min(startIdx, slides.length-1));
    player.classList.add("open");
    player.setAttribute("aria-hidden","false");
    renderPlayer();
  }

  function closePlayerView(){
    stopAuto();
    player.classList.remove("open");
    player.setAttribute("aria-hidden","true");
    stageMedia.innerHTML = "";
  }

  function renderPlayer(){
    stopAuto();
    stageMedia.innerHTML = "";
    const s = slides[current];

    let mediaEl;
    if(s.type==="image"){
      mediaEl = el("img", {src:s.src, alt:s.filename});
      stageMedia.appendChild(mediaEl);
      if(autoAdvance) {
        autoTimer = setTimeout(()=> next(), (Number(s.meta.duration)||DEFAULT_IMAGE_DURATION)*1000);
      }
    } else {
      mediaEl = el("video", {src:s.src, controls:"", playsinline:""});
      // Try autoplay after user gesture (clicking Present opens it)
      mediaEl.addEventListener("loadedmetadata", ()=>{
        if(autoAdvance){
          mediaEl.addEventListener("ended", ()=> next());
        }
        mediaEl.play().catch(()=>{/* user can press play */});
      });
      stageMedia.appendChild(mediaEl);
    }

    // Overlays
    ovTL.textContent = s.meta.scene ? s.meta.scene : "Untitled Scene";
    ovTR.innerHTML = `${escapeHtml(s.meta.lens)} · ${escapeHtml(s.meta.shotType)}<br>${escapeHtml(s.meta.movements.join(" + ")||"")}`;
    ovB.textContent = s.meta.dialogue || s.meta.description || "";

    setStatus(`Presenting ${current+1} / ${slides.length}`);
  }

  function prev(){ current = (current-1+slides.length)%slides.length; renderPlayer(); }
  function next(){ current = (current+1)%slides.length; renderPlayer(); }

  function toggleAuto(){
    autoAdvance = !autoAdvance;
    autoBtn.classList.toggle("active", autoAdvance);
    renderPlayer(); // re-enter with timer or event hookup
  }
  function stopAuto(){ autoAdvance=false; clearTimeout(autoTimer); autoTimer=null; autoBtn.classList.remove("active"); }

  // ---------- JSON I/O ----------
  function exportJSON(){
    const payload = {
      schema: "storyboard_studio_v1",
      exportedAt: Date.now(),
      slides
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "storyboard.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Exported JSON. Note: embedded media can make files large.");
  }

  function importJSONFile(file){
    const reader = new FileReader();
    reader.onload = e => {
      try{
        const data = JSON.parse(e.target.result);
        if(!data || !Array.isArray(data.slides)) throw new Error("Invalid format");
        slides = data.slides;
        render();
        persistDebounced();
        setStatus(`Imported ${slides.length} slides from JSON.`);
      }catch(err){
        setStatus("⚠ Import failed: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- Theme ----------
  function applyThemeFromToggle(){
    document.body.classList.toggle("light", themeToggle.checked);
  }

  // ---------- Events ----------
  fileInput.addEventListener("change", (e)=> handleFiles(e.target.files));
  addBlankBtn.addEventListener("click", addBlankSlide);
  exportJsonBtn.addEventListener("click", exportJSON);
  importJson.addEventListener("change", (e)=> {
    const f = e.target.files?.[0];
    if(f) importJSONFile(f);
    e.target.value = "";
  });
  printBtn.addEventListener("click", ()=> window.print());
  presentBtn.addEventListener("click", ()=> openPlayer(0));
  clearBtn.addEventListener("click", ()=>{
    if(confirm("Clear all slides and local save?")) {
      slides = []; render(); persist();
    }
  });

  // Dropzone
  ;["dragenter","dragover"].forEach(ev=>{
    dropzone.addEventListener(ev, e=> { e.preventDefault(); dropzone.classList.add("dragover"); });
  });
  ;["dragleave","drop"].forEach(ev=>{
    dropzone.addEventListener(ev, e=> { e.preventDefault(); dropzone.classList.remove("dragover"); });
  });
  dropzone.addEventListener("drop", (e)=>{
    const dt = e.dataTransfer;
    if(dt?.files?.length) handleFiles(dt.files);
  });

  // Player controls
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);
  autoBtn.addEventListener("click", toggleAuto);
  fsBtn.addEventListener("click", ()=>{
    if(!document.fullscreenElement){ player.requestFullscreen?.(); }
    else{ document.exitFullscreen?.(); }
  });
  closePlayer.addEventListener("click", closePlayerView);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e)=>{
    if(!player.classList.contains("open")) return;
    if(e.key==="ArrowRight") next();
    if(e.key==="ArrowLeft") prev();
    if(e.key===" "){ // play/pause video if present
      e.preventDefault();
      const v = stageMedia.querySelector("video");
      if(v){
        if(v.paused) v.play().catch(()=>{}); else v.pause();
      }else{
        toggleAuto();
      }
    }
    if(e.key.toLowerCase()==="f"){ fsBtn.click(); }
    if(e.key==="Escape"){ closePlayerView(); }
  });

  // Theme toggle
  themeToggle.addEventListener("change", applyThemeFromToggle);
  // Persist theme choice
  const themeSaved = localStorage.getItem("storyboard_theme") || "dark";
  themeToggle.checked = (themeSaved==="light");
  applyThemeFromToggle();
  themeToggle.addEventListener("change", ()=>{
    localStorage.setItem("storyboard_theme", themeToggle.checked?"light":"dark");
  });

  // ---------- Init ----------
  restore();
  if(slides.length===0){
    // (Optional) seed example blank
    // addBlankSlide();
  }

  // ---------- Helpers ----------
  function escapeHtml(s){
    return String(s||"").replace(/[&<>"']/g, ch => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[ch]));
  }
})();
