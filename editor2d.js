// editor2d.js — Editor 2D estructurat de planta (Fase 1: nodes + parets)
//
// Mòdul AÏLLAT: es carrega amb import() dinàmic des de main.js. Si peta aquí,
// no arrossega la resta de l'app. Rep tota la infraestructura per `ctx`.
//
// Model de dades:
//   nodes: [{ id, x, y, z }]   — cantonades (y = alçada del pla de treball)
//   walls: [{ a, b }]          — aresta entre dos nodes (ids)
// Moure un node → totes les parets que hi toquen es mouen amb ell.

export function createEditor2D(ctx) {
  const { THREE, scene, renderer } = ctx;

  const group = new THREE.Group();
  group.renderOrder = 998;
  scene.add(group);

  let nodes = [];
  let walls = [];
  let nid   = 1;

  let mode       = 'draw';   // 'draw' | 'edit'
  let active     = false;
  let chainLast  = null;     // node id on continua la cadena de parets
  let dragId     = null;     // node que s'arrossega (mode edit)
  let hoverId    = null;
  let planeY     = null;     // alçada fixa del pla (capturada al 1r clic)
  let preview    = null;     // línia elàstica mentre dibuixes
  let cloudIdx   = 0;        // 0=100% · 1=35% · 2=ocult

  const COL_NODE    = 0xff6b4a;
  const COL_NODE_HL = 0xffffff;
  const COL_WALL    = 0xdddddd;
  const SNAP_PX     = 16;    // radi de captura de nodes en píxels

  const el = () => renderer.domElement;
  const findNode = (id) => nodes.find(n => n.id === id);

  function worldToScreen(n) {
    const cam  = ctx.getActiveCamera();
    const v    = new THREE.Vector3(n.x, n.y, n.z).project(cam);
    const rect = el().getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
             y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
  }

  function nodeAtScreen(cx, cy, maxPx) {
    let best = null, bd = maxPx;
    for (const n of nodes) {
      const s = worldToScreen(n);
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function nodeRadius() {
    const cam = ctx.getActiveCamera();
    let h = 2;
    if (cam.isOrthographicCamera) h = (cam.top - cam.bottom) / (cam.zoom || 1);
    return Math.max(h * 0.008, 0.01);
  }

  function clearGroup() {
    while (group.children.length) {
      const c = group.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  function rebuild() {
    clearGroup();
    for (const w of walls) {
      const a = findNode(w.a), b = findNode(w.b);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COL_WALL, depthTest: false }));
      line.renderOrder = 998;
      group.add(line);
    }
    const r = nodeRadius();
    for (const n of nodes) {
      const geo = new THREE.SphereGeometry(r, 10, 10);
      const mat = new THREE.MeshBasicMaterial({ color: n.id === hoverId ? COL_NODE_HL : COL_NODE, depthTest: false });
      const m   = new THREE.Mesh(geo, mat);
      m.position.set(n.x, n.y, n.z);
      m.renderOrder = 999;
      group.add(m);
    }
  }

  function removePreview() {
    if (!preview) return;
    scene.remove(preview);
    preview.geometry.dispose();
    preview.material.dispose();
    preview = null;
  }

  function updatePreview(cx, cy) {
    removePreview();
    if (mode !== 'draw' || chainLast == null) return;
    const a = findNode(chainLast);
    if (!a) return;
    const w = ctx.screenToWorld(cx, cy);
    if (!w) return;
    if (planeY != null) w.y = planeY;
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, a.y, a.z), w]);
    preview = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: COL_NODE, dashSize: 0.05, gapSize: 0.03, depthTest: false }));
    preview.computeLineDistances();
    preview.renderOrder = 997;
    scene.add(preview);
  }

  function changed() { if (api.onChange) api.onChange(); }

  // ── Pointer handlers ──────────────────────────────────────────────────────
  function onDown(e) {
    if (!active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const cx = e.clientX, cy = e.clientY;

    if (mode === 'edit') {
      const n = nodeAtScreen(cx, cy, SNAP_PX);
      dragId = n ? n.id : null;
      if (n) { try { el().setPointerCapture(e.pointerId); } catch (_) {} }
      return;
    }

    // draw: afegeix node (o enganxa a un existent) i encadena paret
    const w = ctx.screenToWorld(cx, cy);
    if (!w) return;
    if (planeY == null) planeY = w.y; else w.y = planeY;

    const snap = nodeAtScreen(cx, cy, SNAP_PX);
    let id;
    if (snap) { id = snap.id; }
    else { id = nid++; nodes.push({ id, x: w.x, y: w.y, z: w.z }); }

    if (chainLast != null && chainLast !== id) walls.push({ a: chainLast, b: id });
    chainLast = id;
    removePreview();
    rebuild();
    changed();
  }

  function onMove(e) {
    if (!active) return;
    const cx = e.clientX, cy = e.clientY;

    if (mode === 'edit') {
      if (dragId != null) {
        e.preventDefault();
        const w = ctx.screenToWorld(cx, cy);
        if (!w) return;
        const n = findNode(dragId);
        if (!n) return;
        n.x = w.x; if (planeY != null) n.y = planeY; n.z = w.z;
        rebuild();
      } else {
        const n = nodeAtScreen(cx, cy, SNAP_PX);
        const h = n ? n.id : null;
        if (h !== hoverId) { hoverId = h; rebuild(); el().style.cursor = h ? 'grab' : 'default'; }
      }
      return;
    }
    updatePreview(cx, cy);
  }

  function onUp() {
    if (!active) return;
    if (mode === 'edit' && dragId != null) dragId = null;
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { chainLast = null; removePreview(); }
  }

  el().addEventListener('pointerdown', onDown, { capture: true });
  el().addEventListener('pointermove', onMove, { capture: true });
  el().addEventListener('pointerup',   onUp,   { capture: true });
  window.addEventListener('keydown', onKey);

  // ── Núvol com a referència (opacitat) ─────────────────────────────────────
  function applyCloud() {
    const op  = [1, 0.35, 0][cloudIdx];
    const vis = cloudIdx !== 2;
    for (const c of ctx.getClouds()) {
      c.visible = vis;
      if (c.material) { c.material.transparent = op < 1; c.material.opacity = op; }
    }
  }

  // ── DXF (parets → LINE, capa PARETS) ──────────────────────────────────────
  function exportDXF() {
    if (walls.length === 0) { alert('No hi ha parets per exportar. Dibuixa alguna paret primer.'); return; }
    const R = '\r\n';
    let dxf = '';
    dxf += '0'+R+'SECTION'+R+'2'+R+'HEADER'+R+'9'+R+'$ACADVER'+R+'1'+R+'AC1009'+R+'0'+R+'ENDSEC'+R;
    dxf += '0'+R+'SECTION'+R+'2'+R+'TABLES'+R+'0'+R+'TABLE'+R+'2'+R+'LAYER'+R+'70'+R+'1'+R;
    dxf += '0'+R+'LAYER'+R+'2'+R+'PARETS'+R+'70'+R+'0'+R+'62'+R+'1'+R+'6'+R+'CONTINUOUS'+R;
    dxf += '0'+R+'ENDTAB'+R+'0'+R+'ENDSEC'+R;
    dxf += '0'+R+'SECTION'+R+'2'+R+'ENTITIES'+R;
    for (const w of walls) {
      const a = findNode(w.a), b = findNode(w.b);
      if (!a || !b) continue;
      dxf += '0'+R+'LINE'+R+'8'+R+'PARETS'+R;
      dxf += '10'+R+a.x.toFixed(4)+R+'20'+R+a.z.toFixed(4)+R+'30'+R+'0.0'+R;
      dxf += '11'+R+b.x.toFixed(4)+R+'21'+R+b.z.toFixed(4)+R+'31'+R+'0.0'+R;
    }
    dxf += '0'+R+'ENDSEC'+R+'0'+R+'EOF'+R;
    const blob = new Blob([dxf], { type: 'application/dxf' });
    const url  = URL.createObjectURL(blob);
    const a2   = document.createElement('a');
    a2.href = url; a2.download = 'planta_' + new Date().toISOString().slice(0, 10) + '.dxf';
    document.body.appendChild(a2); a2.click(); document.body.removeChild(a2);
    URL.revokeObjectURL(url);
  }

  // ── API pública ───────────────────────────────────────────────────────────
  const api = {
    onChange: null,
    setActive(b) {
      active = b;
      if (b) {
        ctx.setTopView();
        ctx.setControlsEnabled(false);
        group.visible = true;
        if (!nodes.length) planeY = null;   // conserva l'alçada del pla entre sessions
        rebuild();
      } else {
        ctx.setControlsEnabled(true);
        removePreview();
        chainLast = null; dragId = null; hoverId = null;
        el().style.cursor = 'default';
        cloudIdx = 0; applyCloud();   // restaura el núvol al sortir
      }
    },
    setMode(m) { mode = m; chainLast = null; hoverId = null; removePreview(); rebuild(); },
    newChain() { chainLast = null; removePreview(); },
    undo() { if (walls.length) walls.pop(); chainLast = null; rebuild(); changed(); },
    clear() { nodes = []; walls = []; nid = 1; chainLast = null; rebuild(); changed(); },
    cycleCloud() { cloudIdx = (cloudIdx + 1) % 3; applyCloud(); return ['100%', '35%', 'ocult'][cloudIdx]; },
    exportDXF,
    count() { return { nodes: nodes.length, walls: walls.length }; },
  };
  return api;
}
