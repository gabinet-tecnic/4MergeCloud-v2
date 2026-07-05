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

  let mode        = 'draw';   // 'draw' | 'edit' | 'thickness'
  let active      = false;
  let drawing     = false;    // traç lliure en curs
  let freePts     = [];       // punts mostrejats del traç lliure (món)
  let dragId      = null;     // node que s'arrossega (mode edit)
  let hoverId     = null;
  let planeY      = null;     // alçada fixa del pla (capturada al 1r punt)
  let preview     = null;     // línia de previsualització del traç
  let cloudIdx    = 0;        // 0=100% · 1=35% · 2=ocult
  let selWall     = null;     // paret seleccionada (mode gruix)
  let measuring   = false;    // esperant clics de mesura al núvol
  let measurePts  = [];       // punts de mesura del gruix
  let lastSide    = 0;        // costat del gruix per defecte (0 centrat, ±1 costat)
  let opPick      = null;     // 1a paret triada (empalme/allargar/retallar)
  let opPickPt    = null;     // punt món del 1r clic

  let openings    = [];       // {id, wallId, t (0-1), width (m), type 'door'|'window'}
  let oid         = 1;
  let opType      = 'door';   // tipus per defecte en col·locar
  let opDrag      = null;     // {id, mode: 'slide'|'width'} mentre s'arrossega
  let curOpening  = null;     // id de l'obertura actual (amplada/rotació s'hi apliquen)
  const OP_COL    = 0x00e0ff; // color de les obertures i mànecs
  const DEF_DOOR  = 0.80;     // amplada per defecte porta (m)
  const DEF_WIN   = 1.00;     // amplada per defecte finestra (m)

  const FREE_MIN  = 0.02;     // distància mínima entre punts mostrejats (m)
  const SIMPLIFY  = 0.10;     // epsilon Douglas-Peucker (m) → recte (més alt = menys punts)

  const COL_NODE    = 0xff6b4a;
  const COL_NODE_HL = 0xffffff;
  const COL_WALL    = 0xdddddd;
  const COL_PERIM   = 0x33ccff;   // perímetre (balcons, façanes)
  const COL_SEL     = 0xffdd00;
  const COL_AXIS    = 0x707070;
  const SNAP_PX     = 16;    // radi de captura de nodes en píxels
  const WALL_PX     = 18;    // radi de captura de parets en píxels
  const MERGE_R     = 0.10;  // distància (m) per fusionar nodes en soltar

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

  // direcció i normal (al pla XZ) d'una paret
  function wallDirNormal(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const d = { x: dx / len, z: dz / len };
    return { d, n: { x: -d.z, z: d.x }, len };
  }

  // desplaçaments de les dues cares segons el costat del gruix
  // side 0 = centrat a l'eix · +1 = tot cap a +normal · -1 = tot cap a -normal (l'eix és una cara)
  function faceOffsets(th, side) {
    if (side > 0) return [0, th];
    if (side < 0) return [-th, 0];
    return [th / 2, -th / 2];
  }

  // ── Unió de cantonades (mitra) ──
  // paret veïna amb gruix que comparteix el node (només cantonades netes de 2 parets)
  function adjacentWall(w, nodeId) {
    const f = walls.filter(x => x !== w && x.type !== 'perimeter' && (x.thickness || 0) > 0 && (x.a === nodeId || x.b === nodeId));
    return f.length === 1 ? f[0] : null;
  }
  // línia d'una cara (offset off al llarg de la normal)
  function faceLine(w, off) {
    const a = findNode(w.a), b = findNode(w.b);
    const { n } = wallDirNormal(a, b);
    return { p1: { x: a.x + n.x*off, z: a.z + n.z*off }, p2: { x: b.x + n.x*off, z: b.z + n.z*off } };
  }
  // direcció unitària des del node cap a l'altre extrem de la paret
  function dirAway(w, nodeId) {
    const P = findNode(nodeId);
    const other = findNode(w.a === nodeId ? w.b : w.a);
    const dx = other.x - P.x, dz = other.z - P.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }
  // punt de la cara a l'extrem P: mitra amb la paret veïna, o el punt pla si no n'hi ha
  function mitredPoint(w, P, off) {
    const a = findNode(w.a), b = findNode(w.b);
    const nW = wallDirNormal(a, b).n;
    const base = { x: P.x + nW.x*off, z: P.z + nW.z*off };   // extrem de la cara de w a P
    if (off === 0) return base;   // cara sobre l'eix: ja passa pel node
    const w2 = adjacentWall(w, P.id);
    if (!w2) return base;
    const nW2 = wallDirNormal(findNode(w2.a), findNode(w2.b)).n;
    const dW = dirAway(w, P.id), dW2 = dirAway(w2, P.id);
    const sW = Math.sign(off);
    // ¿la cara de w mira cap a l'interior de la cantonada (cap a l'altra paret)?
    const wInner = (nW.x*sW*dW2.x + nW.z*sW*dW2.z) > 0;
    const [oa, ob] = faceOffsets(w2.thickness || 0, w2.side || 0);
    let matchOff = null;
    for (const o of [oa, ob]) {
      if (o === 0) continue;
      const s2 = Math.sign(o);
      const w2Inner = (nW2.x*s2*dW.x + nW2.z*s2*dW.z) > 0;
      if (w2Inner !== wInner) { matchOff = o; break; }   // emparellament correcte (comprovat empíricament)
    }
    if (matchOff === null) return base;
    const I = lineIntersect(faceLine(w, off).p1, faceLine(w, off).p2, faceLine(w2, matchOff).p1, faceLine(w2, matchOff).p2);
    if (!I) return base;
    const d = Math.hypot(I.x - base.x, I.z - base.z);
    const maxD = 6 * Math.max(w.thickness || 0, w2.thickness || 0, 0.05);
    return d <= maxD ? I : base;
  }
  // les dues cares d'una paret amb gruix, o null
  // NOTA: unió de cantonades (mitra) pendent d'una revisió dedicada — ara cares planes
  function wallFaces(w) {
    const a = findNode(w.a), b = findNode(w.b);
    if (!a || !b) return null;
    const th = w.type === 'perimeter' ? 0 : (w.thickness || 0);
    if (th <= 0) return null;
    const { n } = wallDirNormal(a, b);
    const [o1, o2] = faceOffsets(th, w.side || 0);
    return {
      f1: [{ x: a.x + n.x*o1, z: a.z + n.z*o1 }, { x: b.x + n.x*o1, z: b.z + n.z*o1 }],
      f2: [{ x: a.x + n.x*o2, z: a.z + n.z*o2 }, { x: b.x + n.x*o2, z: b.z + n.z*o2 }],
    };
  }

  // geometria d'una obertura sobre la seva paret amfitriona (o null)
  function openingGeom(op) {
    const w = op.wall;
    if (!w) return null;
    const a = findNode(w.a), b = findNode(w.b);
    if (!a || !b) return null;
    const { d, n, len } = wallDirNormal(a, b);
    const th = w.type === 'perimeter' ? 0 : (w.thickness || 0);
    const [o1, o2] = faceOffsets(th, w.side || 0);
    const t = Math.max(0, Math.min(1, op.t));
    const cx = a.x + t * (b.x - a.x), cz = a.z + t * (b.z - a.z);
    const hw = Math.min(op.width, len) / 2;                    // mitja amplada, limitada
    const e1 = { x: cx - hw * d.x, z: cz - hw * d.z };
    const e2 = { x: cx + hw * d.x, z: cz + hw * d.z };
    return { w, a, b, d, n, len, th, o1, o2, C: { x: cx, z: cz }, e1, e2, hw };
  }

  // paràmetre t (0-1) d'un punt món projectat sobre l'eix d'una paret
  function projectT(w, p) {
    const a = findNode(w.a), b = findNode(w.b);
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  }

  // mànec d'obertura (centre=slide, extrem=amplada) més proper al clic, o null
  function openingHandleAt(cx, cy, maxPx) {
    let best = null, bd = maxPx;
    for (const op of openings) {
      const g = openingGeom(op);
      if (!g) continue;
      const pts = [
        { p: g.C,  mode: 'slide' },
        { p: g.e1, mode: 'width' },
        { p: g.e2, mode: 'width' },
      ];
      for (const h of pts) {
        const s = worldToScreen({ x: h.p.x, y: planeY != null ? planeY : 0, z: h.p.z });
        const dd = Math.hypot(s.x - cx, s.y - cy);
        if (dd < bd) { bd = dd; best = { op, mode: h.mode }; }
      }
    }
    return best;
  }

  function addLine(pts, color, dashed) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.04, gapSize: 0.03, depthTest: false })
      : new THREE.LineBasicMaterial({ color, depthTest: false });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 998;
    group.add(line);
  }

  function rebuild() {
    clearGroup();
    for (const w of walls) {
      const a = findNode(w.a), b = findNode(w.b);
      if (!a || !b) continue;
      const isPerim = w.type === 'perimeter';
      const th  = isPerim ? 0 : (w.thickness || 0);   // el perímetre és sempre línia
      const col = (w === selWall || w === opPick) ? COL_SEL : (isPerim ? COL_PERIM : COL_WALL);
      const A = new THREE.Vector3(a.x, a.y, a.z);
      const B = new THREE.Vector3(b.x, b.y, b.z);
      if (th > 0) {
        const wy = a.y;
        const F = wallFaces(w);
        const P = (p) => new THREE.Vector3(p.x, wy, p.z);
        addLine([P(F.f1[0]), P(F.f1[1])], col);
        addLine([P(F.f2[0]), P(F.f2[1])], col);
        addLine([A, B], COL_AXIS, true);   // eix de referència
      } else {
        addLine([A, B], col);
      }
    }
    // ── Obertures (portes / finestres) ──
    const y = planeY != null ? planeY : 0;
    const V = (p, off, nrm) => new THREE.Vector3(p.x + (nrm ? nrm.x*off : 0), y, p.z + (nrm ? nrm.z*off : 0));
    for (const op of openings) {
      const g = openingGeom(op);
      if (!g) continue;
      const { n, d, o1, o2, e1, e2, th } = g;
      if (th > 0) {
        // brancals de cara a cara a cada extrem
        addLine([V(e1, o1, n), V(e1, o2, n)], OP_COL);
        addLine([V(e2, o1, n), V(e2, o2, n)], OP_COL);
      } else {
        // sense gruix: petites marques perpendiculars a l'eix
        const tk = 0.05;
        addLine([V(e1, tk, n), V(e1, -tk, n)], OP_COL);
        addLine([V(e2, tk, n), V(e2, -tk, n)], OP_COL);
      }
      if (op.type === 'door') {
        // fulla + arc de gir; op.rot (0-3) = costat de frontissa × sentit d'obertura
        const rot = op.rot || 0;
        const hingeE = (rot & 1) ? e2 : e1;
        const otherE = (rot & 1) ? e1 : e2;
        const faceOff = (rot & 2) ? o2 : o1;   // cara on seu la frontissa
        const swing  = (rot & 2) ? -1 : 1;     // sentit del gir al llarg de la normal
        const leafLen = g.hw * 2;
        const hinge = V(hingeE, faceOff, n);
        const tip   = new THREE.Vector3(hinge.x + n.x*leafLen*swing, y, hinge.z + n.z*leafLen*swing);
        addLine([hinge, tip], OP_COL);
        const other = V(otherE, faceOff, n);
        const arcPts = [];
        for (let i = 0; i <= 12; i++) {
          const ang = (i / 12) * (Math.PI / 2);
          const ca = Math.cos(ang), sa = Math.sin(ang);
          arcPts.push(new THREE.Vector3(
            hinge.x + (tip.x - hinge.x)*ca + (other.x - hinge.x)*sa,
            y,
            hinge.z + (tip.z - hinge.z)*ca + (other.z - hinge.z)*sa));
        }
        addLine(arcPts, OP_COL);
      } else {
        // finestra: línia de vidre a mig gruix
        const mid = (o1 + o2) / 2;
        addLine([V(e1, mid, n), V(e2, mid, n)], OP_COL);
      }
    }

    const r = nodeRadius();
    for (const nd of nodes) {
      const geo = new THREE.SphereGeometry(r, 10, 10);
      const mat = new THREE.MeshBasicMaterial({ color: nd.id === hoverId ? COL_NODE_HL : COL_NODE, depthTest: false });
      const m   = new THREE.Mesh(geo, mat);
      m.position.set(nd.x, nd.y, nd.z);
      m.renderOrder = 999;
      group.add(m);
    }
    // mànecs d'obertura (centre = lliscar, extrems = amplada) — només en mode obertura
    if (mode === 'opening') {
      for (const op of openings) {
        const g = openingGeom(op);
        if (!g) continue;
        for (const h of [g.C, g.e1, g.e2]) {
          const geo = new THREE.SphereGeometry(r * 0.9, 8, 8);
          const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: OP_COL, depthTest: false }));
          m.position.set(h.x, y, h.z);
          m.renderOrder = 1000;
          group.add(m);
        }
      }
    }
  }

  // distància (px) d'un punt a un segment
  function distPointSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx*dx + dy*dy || 1;
    let t = ((px - x1)*dx + (py - y1)*dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t*dx), py - (y1 + t*dy));
  }

  function wallAtScreen(cx, cy, maxPx) {
    let best = null, bd = maxPx;
    for (const w of walls) {
      const a = findNode(w.a), b = findNode(w.b);
      if (!a || !b) continue;
      const sa = worldToScreen(a), sb = worldToScreen(b);
      const d = distPointSeg(cx, cy, sa.x, sa.y, sb.x, sb.y);
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  // intersecció (XZ) de les rectes infinites p1-p2 i p3-p4, o null si paral·leles
  function lineIntersect(p1, p2, p3, p4) {
    const den = (p1.x - p2.x) * (p3.z - p4.z) - (p1.z - p2.z) * (p3.x - p4.x);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p1.x - p3.x) * (p3.z - p4.z) - (p1.z - p3.z) * (p3.x - p4.x)) / den;
    return { x: p1.x + t * (p2.x - p1.x), z: p1.z + t * (p2.z - p1.z) };
  }

  // node extrem d'una paret més proper a un punt món
  function nearestEndNode(w, p) {
    const a = findNode(w.a), b = findNode(w.b);
    const da = Math.hypot(a.x - p.x, a.z - p.z);
    const db = Math.hypot(b.x - p.x, b.z - p.z);
    return da <= db ? w.a : w.b;
  }

  function moveNode(id, x, z) {
    const n = findNode(id);
    if (n) { n.x = x; n.z = z; if (planeY != null) n.y = planeY; }
  }

  function emitOp(status) { if (api.onOp) api.onOp(status); }

  function emitThick(status) {
    if (api.onThick) api.onThick({
      selected: !!selWall,
      thickness: selWall ? (selWall.thickness || 0) : null,
      status,
    });
  }

  function removePreview() {
    if (!preview) return;
    scene.remove(preview);
    preview.geometry.dispose();
    preview.material.dispose();
    preview = null;
  }

  // previsualització del traç lliure en curs
  function updateFreePreview() {
    removePreview();
    if (freePts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(freePts.map(p => new THREE.Vector3(p.x, p.y, p.z)));
    preview = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COL_NODE, depthTest: false }));
    preview.renderOrder = 997;
    scene.add(preview);
  }

  // distància perpendicular (XZ) d'un punt a la recta a-b
  function perpDist(p, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / l;
  }

  // Douglas-Peucker: redueix un traç a pocs vèrtexs rectes
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let dmax = 0, idx = 0;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpDist(pts[i], a, b);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) {
      const left  = simplify(pts.slice(0, idx + 1), eps);
      const right = simplify(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  // node existent més proper a un punt món (per enganxar extrems), o null
  function nodeNearWorld(p, maxWorld) {
    let best = null, bd = maxWorld;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
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

    if (mode === 'erase') {
      // esborra una obertura si n'hi ha a prop
      const oh = openingHandleAt(cx, cy, WALL_PX);
      if (oh) { openings = openings.filter(o => o !== oh.op); rebuild(); changed(); return; }
      // esborra un node (i les seves parets) o, si no, una paret
      const n = nodeAtScreen(cx, cy, SNAP_PX);
      if (n) {
        nodes = nodes.filter(x => x.id !== n.id);
        walls = walls.filter(w => w.a !== n.id && w.b !== n.id);
        openings = openings.filter(o => o.wall && o.wall.a !== n.id && o.wall.b !== n.id);
        if (selWall && (selWall.a === n.id || selWall.b === n.id)) selWall = null;
        rebuild(); changed(); return;
      }
      const w = wallAtScreen(cx, cy, WALL_PX);
      if (w) {
        walls = walls.filter(x => x !== w);
        openings = openings.filter(o => o.wall !== w);
        if (selWall === w) selWall = null;
        pruneOrphanNodes();
        rebuild(); changed();
      }
      return;
    }

    if (mode === 'opening') {
      // agafa un mànec (centre = lliscar, extrem = amplada) o crea una obertura nova
      const h = openingHandleAt(cx, cy, SNAP_PX);
      if (h) { opDrag = h; curOpening = h.op.id; try { el().setPointerCapture(e.pointerId); } catch (_) {} return; }
      const w = wallAtScreen(cx, cy, WALL_PX);
      if (!w || w.type === 'perimeter') { emitOp('Clica sobre una paret per posar-hi una obertura'); return; }
      const world = ctx.screenToWorld(cx, cy);
      if (!world) return;
      const t = projectT(w, world);
      const op = { id: oid++, wall: w, t, width: opType === 'door' ? DEF_DOOR : DEF_WIN, type: opType, rot: 0 };
      openings.push(op);
      curOpening = op.id;
      opDrag = { id: op.id, mode: 'width', op };
      rebuild(); changed();
      emitOp((opType === 'door' ? 'Porta' : 'Finestra') + ' posada — arrossega o tria amplada / gira');
      return;
    }

    if (mode === 'thickness') {
      if (measuring) {
        const w = ctx.screenToWorld(cx, cy);
        if (!w) return;
        if (planeY != null) w.y = planeY;
        measurePts.push(w);
        if (measurePts.length >= 2 && selWall) {
          const a = findNode(selWall.a), b = findNode(selWall.b);
          const { n } = wallDirNormal(a, b);
          const dp = { x: measurePts[1].x - measurePts[0].x, z: measurePts[1].z - measurePts[0].z };
          const th = Math.abs(dp.x * n.x + dp.z * n.z);   // component perpendicular a la paret
          selWall.thickness = +th.toFixed(3);
          measuring = false; measurePts = [];
          rebuild();
          emitThick('Gruix mesurat: ' + selWall.thickness.toFixed(2) + ' m');
        } else {
          emitThick('Ara clica la segona cara de la paret…');
        }
        return;
      }
      selWall = wallAtScreen(cx, cy, WALL_PX);
      rebuild();
      emitThick(selWall ? 'Paret seleccionada' : 'Cap paret a prop — torna a provar');
      return;
    }

    if (mode === 'empalme' || mode === 'extend' || mode === 'trim') {
      const w = wallAtScreen(cx, cy, WALL_PX);
      const world = ctx.screenToWorld(cx, cy);
      if (!w) { emitOp('Cap paret aquí — torna a provar'); return; }
      if (!opPick) {
        opPick = w; opPickPt = world; rebuild();
        emitOp(mode === 'trim' ? 'Ara clica la paret a retallar (al tros que vols treure)'
             : mode === 'extend' ? 'Ara clica la paret límit' : 'Ara clica la segona paret');
        return;
      }
      if (w === opPick) { emitOp('Tria una paret diferent'); return; }
      performOp(mode, opPick, opPickPt, w, world);
      opPick = null; opPickPt = null;
      rebuild(); changed();
      return;
    }

    // draw / perimeter: inici del traç lliure
    const w = ctx.screenToWorld(cx, cy);
    if (!w) return;
    if (planeY == null) planeY = w.y; else w.y = planeY;
    drawing = true;
    freePts = [{ x: w.x, y: planeY, z: w.z }];
    try { el().setPointerCapture(e.pointerId); } catch (_) {}
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

    if ((mode === 'draw' || mode === 'perimeter') && drawing) {
      e.preventDefault();
      const w = ctx.screenToWorld(cx, cy);
      if (!w) return;
      const last = freePts[freePts.length - 1];
      if (Math.hypot(w.x - last.x, w.z - last.z) > FREE_MIN) {
        freePts.push({ x: w.x, y: planeY, z: w.z });
        updateFreePreview();
      }
    }

    if (mode === 'opening' && opDrag) {
      e.preventDefault();
      const w = ctx.screenToWorld(cx, cy);
      if (!w) return;
      const op = openings.find(o => o.id === opDrag.id);
      if (!op) return;
      if (opDrag.mode === 'slide') {
        op.t = projectT(op.wall, w);
      } else {
        const a = findNode(op.wall.a), b = findNode(op.wall.b);
        const cxp = a.x + op.t * (b.x - a.x), czp = a.z + op.t * (b.z - a.z);
        op.width = Math.max(0.1, 2 * Math.hypot(w.x - cxp, w.z - czp));   // amplada = 2× dist al centre
      }
      rebuild();
    }
  }

  function onUp() {
    if (!active) return;
    if (mode === 'edit') {
      if (dragId != null) { mergeNodeIfOverlap(dragId); dragId = null; rebuild(); changed(); }
      return;
    }
    if (mode === 'opening' && opDrag) { opDrag = null; changed(); return; }
    if ((mode === 'draw' || mode === 'perimeter') && drawing) {
      drawing = false;
      removePreview();
      finalizeStroke(mode === 'perimeter' ? 'perimeter' : 'wall');
    }
  }

  // en soltar un node a sobre d'un altre, els fusiona en un de sol
  function mergeNodeIfOverlap(id) {
    const n = findNode(id);
    if (!n) return;
    let target = null, bd = MERGE_R;
    for (const o of nodes) {
      if (o.id === id) continue;
      const d = Math.hypot(o.x - n.x, o.z - n.z);
      if (d < bd) { bd = d; target = o; }
    }
    if (!target) return;
    for (const w of walls) { if (w.a === id) w.a = target.id; if (w.b === id) w.b = target.id; }
    walls = walls.filter(w => w.a !== w.b);   // elimina parets degenerades
    // elimina duplicats (mateixa parella de nodes)
    const seen = new Set();
    walls = walls.filter(w => {
      const key = w.a < w.b ? w.a + '-' + w.b : w.b + '-' + w.a;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    nodes = nodes.filter(nd => nd.id !== id);
  }

  // empalme / allargar / retallar sobre la intersecció de dues parets
  function performOp(op, w1, pt1, w2, pt2) {
    const a1 = findNode(w1.a), a2 = findNode(w1.b);
    const b1 = findNode(w2.a), b2 = findNode(w2.b);
    if (!a1 || !a2 || !b1 || !b2) return;
    const I = lineIntersect(a1, a2, b1, b2);
    if (!I) { emitOp('Les parets són paral·leles — no es poden ajustar'); return; }

    if (op === 'empalme') {
      const e1 = nearestEndNode(w1, I); moveNode(e1, I.x, I.z);
      const e2 = nearestEndNode(w2, I); moveNode(e2, I.x, I.z);
      mergeNodeIfOverlap(e1);   // fusiona els dos extrems a la cantonada
      emitOp('✓ Empalme fet');
    } else if (op === 'extend') {
      const e = nearestEndNode(w1, I); moveNode(e, I.x, I.z);   // w1 = paret a allargar
      emitOp('✓ Paret allargada fins al límit');
    } else if (op === 'trim') {
      const e = nearestEndNode(w2, pt2); moveNode(e, I.x, I.z); // treu el tros clicat de w2
      emitOp('✓ Paret retallada');
    }
  }

  // elimina nodes que ja no pertanyen a cap paret
  function pruneOrphanNodes() {
    const used = new Set();
    for (const w of walls) { used.add(w.a); used.add(w.b); }
    nodes = nodes.filter(nd => used.has(nd.id));
  }

  // converteix el traç lliure en línies rectes (nodes + walls)
  function finalizeStroke(type) {
    const raw = freePts;
    freePts = [];
    if (raw.length < 2) return;
    // longitud total mínima per descartar tocs accidentals
    let len = 0;
    for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i].x - raw[i-1].x, raw[i].z - raw[i-1].z);
    if (len < SIMPLIFY * 1.5) return;

    const verts = simplify(raw, SIMPLIFY);
    const snapR = SIMPLIFY * 2.5;
    const ids = verts.map((v, i) => {
      // enganxa els extrems del traç a nodes existents
      if (i === 0 || i === verts.length - 1) {
        const near = nodeNearWorld(v, snapR);
        if (near) return near.id;
      }
      const id = nid++;
      nodes.push({ id, x: v.x, y: planeY, z: v.z });
      return id;
    });
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] !== ids[i-1]) walls.push({ a: ids[i-1], b: ids[i], thickness: 0, type: type || 'wall' });
    }
    rebuild();
    changed();
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { drawing = false; freePts = []; removePreview(); }
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

  // ── DXF (parets → capa PARETS · perímetre → capa PERIMETRE) ───────────────
  function buildDXF() {
    const R = '\r\n';
    let dxf = '';
    dxf += '0'+R+'SECTION'+R+'2'+R+'HEADER'+R+'9'+R+'$ACADVER'+R+'1'+R+'AC1009'+R+'0'+R+'ENDSEC'+R;
    dxf += '0'+R+'SECTION'+R+'2'+R+'TABLES'+R+'0'+R+'TABLE'+R+'2'+R+'LAYER'+R+'70'+R+'3'+R;
    dxf += '0'+R+'LAYER'+R+'2'+R+'PARETS'+R+'70'+R+'0'+R+'62'+R+'1'+R+'6'+R+'CONTINUOUS'+R;
    dxf += '0'+R+'LAYER'+R+'2'+R+'PERIMETRE'+R+'70'+R+'0'+R+'62'+R+'4'+R+'6'+R+'CONTINUOUS'+R;
    dxf += '0'+R+'LAYER'+R+'2'+R+'OBERTURES'+R+'70'+R+'0'+R+'62'+R+'5'+R+'6'+R+'CONTINUOUS'+R;
    dxf += '0'+R+'ENDTAB'+R+'0'+R+'ENDSEC'+R;
    dxf += '0'+R+'SECTION'+R+'2'+R+'ENTITIES'+R;
    const lineDXF = (layer, x1, z1, x2, z2) => {
      dxf += '0'+R+'LINE'+R+'8'+R+layer+R;
      dxf += '10'+R+x1.toFixed(4)+R+'20'+R+z1.toFixed(4)+R+'30'+R+'0.0'+R;
      dxf += '11'+R+x2.toFixed(4)+R+'21'+R+z2.toFixed(4)+R+'31'+R+'0.0'+R;
    };
    for (const w of walls) {
      const a = findNode(w.a), b = findNode(w.b);
      if (!a || !b) continue;
      if (w.type === 'perimeter') { lineDXF('PERIMETRE', a.x, a.z, b.x, b.z); continue; }
      const F = wallFaces(w);
      if (F) {
        lineDXF('PARETS', F.f1[0].x, F.f1[0].z, F.f1[1].x, F.f1[1].z);   // cara 1 (unida)
        lineDXF('PARETS', F.f2[0].x, F.f2[0].z, F.f2[1].x, F.f2[1].z);   // cara 2 (unida)
      } else {
        lineDXF('PARETS', a.x, a.z, b.x, b.z);   // eix
      }
    }
    // obertures → capa OBERTURES (brancals + símbol)
    for (const op of openings) {
      const g = openingGeom(op);
      if (!g) continue;
      const { n, o1, o2, e1, e2, hw } = g;
      lineDXF('OBERTURES', e1.x + n.x*o1, e1.z + n.z*o1, e1.x + n.x*o2, e1.z + n.z*o2);   // brancal 1
      lineDXF('OBERTURES', e2.x + n.x*o1, e2.z + n.z*o1, e2.x + n.x*o2, e2.z + n.z*o2);   // brancal 2
      if (op.type === 'door') {
        const hx = e1.x + n.x*o1, hz = e1.z + n.z*o1;
        lineDXF('OBERTURES', hx, hz, hx + n.x*hw*2, hz + n.z*hw*2);   // fulla
      } else {
        const mid = (o1 + o2) / 2;
        lineDXF('OBERTURES', e1.x + n.x*mid, e1.z + n.z*mid, e2.x + n.x*mid, e2.z + n.z*mid);   // vidre
      }
    }
    dxf += '0'+R+'ENDSEC'+R+'0'+R+'EOF'+R;
    return dxf;
  }
  function exportDXF() {
    if (walls.length === 0) { alert('No hi ha res per exportar. Dibuixa alguna paret o perímetre primer.'); return; }
    const dxf = buildDXF();
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
    onThick:  null,
    onOp:     null,
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
        drawing = false; freePts = []; dragId = null; hoverId = null;
        selWall = null; measuring = false; measurePts = [];
        opPick = null; opPickPt = null; opDrag = null;
        el().style.cursor = 'default';
        cloudIdx = 0; applyCloud();   // restaura el núvol al sortir
      }
    },
    setMode(m) {
      mode = m; drawing = false; freePts = []; hoverId = null;
      if (m !== 'thickness') { selWall = null; measuring = false; measurePts = []; }
      opPick = null; opPickPt = null; opDrag = null;
      removePreview(); rebuild();
      if (m === 'thickness') emitThick(selWall ? 'Paret seleccionada' : 'Selecciona una paret per assignar-li gruix');
      if (m === 'empalme') emitOp('Empalme: clica la primera paret');
      if (m === 'extend')  emitOp('Allargar: clica la paret a allargar');
      if (m === 'trim')    emitOp('Retallar: clica la paret que fa de tall');
      if (m === 'opening') emitOp('Obertura (' + (opType === 'door' ? 'porta' : 'finestra') + '): clica sobre una paret');
    },
    setOpType(t) { opType = t; emitOp('Tipus: ' + (t === 'door' ? 'porta' : 'finestra') + ' — clica sobre una paret'); },
    setOpWidth(w) {
      const op = openings.find(o => o.id === curOpening);
      if (!op) { emitOp('Posa o toca primer una obertura'); return; }
      op.width = w;
      rebuild(); changed();
      emitOp('Amplada: ' + (w >= 1 ? (w === 1.4 ? 'doble' : w.toFixed(2) + ' m') : Math.round(w * 100) + ' cm'));
    },
    rotateOpening() {
      const op = openings.find(o => o.id === curOpening);
      if (!op) { emitOp('Posa o toca primer una obertura'); return; }
      op.rot = ((op.rot || 0) + 1) % 4;
      rebuild(); changed();
      emitOp('Porta girada');
    },
    undo() { const p = walls.pop(); if (p === selWall) selWall = null; rebuild(); changed(); },
    clear() { nodes = []; walls = []; nid = 1; openings = []; oid = 1; selWall = null; rebuild(); changed(); },
    cycleCloud() { cloudIdx = (cloudIdx + 1) % 3; applyCloud(); return ['100%', '35%', 'ocult'][cloudIdx]; },
    applyThickness(v) {
      if (!selWall) { emitThick('Selecciona primer una paret'); return; }
      if (isNaN(v) || v < 0) { emitThick('Valor de gruix no vàlid'); return; }
      selWall.thickness = +v;
      measuring = false; measurePts = [];
      rebuild();
      emitThick('Gruix assignat: ' + (+v).toFixed(2) + ' m');
    },
    setSelSide(s) {
      if (!selWall) { emitThick('Selecciona primer una paret'); return; }
      selWall.side = s;
      lastSide = s;
      rebuild();
      emitThick('Costat: ' + (s === 0 ? 'centrat' : (s > 0 ? 'costat A' : 'costat B')));
    },
    applyThicknessAll(v) {
      if (isNaN(v) || v < 0) { emitThick('Valor de gruix no vàlid'); return; }
      let n = 0;
      for (const w of walls) {
        if (w.type === 'perimeter') continue;
        w.thickness = +v; w.side = lastSide; n++;
      }
      rebuild();
      emitThick('Gruix ' + (+v).toFixed(2) + ' m aplicat a ' + n + ' parets (costat ' + (lastSide === 0 ? 'centrat' : (lastSide > 0 ? 'A' : 'B')) + ')');
    },
    startMeasure() {
      if (!selWall) { emitThick('Selecciona primer una paret'); return; }
      measuring = true; measurePts = [];
      emitThick('Clica la primera cara de la paret al núvol…');
    },
    exportDXF,
    buildDXF,
    count() { return { nodes: nodes.length, walls: walls.length, openings: openings.length }; },
    getState() {
      return {
        nodes: nodes.map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z })),
        walls: walls.map(w => ({ a: w.a, b: w.b, thickness: w.thickness || 0, side: w.side || 0, type: w.type || 'wall' })),
        openings: openings.map(o => ({ wi: walls.indexOf(o.wall), t: o.t, width: o.width, type: o.type, rot: o.rot || 0 })).filter(o => o.wi >= 0),
        planeY, nid,
      };
    },
    setState(s) {
      if (!s) return;
      nodes = (s.nodes || []).map(n => ({ ...n }));
      walls = (s.walls || []).map(w => ({ ...w }));
      openings = (s.openings || []).filter(o => o.wi >= 0 && o.wi < walls.length)
        .map(o => ({ id: oid++, wall: walls[o.wi], t: o.t, width: o.width, type: o.type, rot: o.rot || 0 }));
      if (s.planeY != null) planeY = s.planeY;
      nid = Math.max(nid, s.nid || 1);
      selWall = null; opPick = null; opDrag = null;
      rebuild(); changed();
    },
  };
  return api;
}
