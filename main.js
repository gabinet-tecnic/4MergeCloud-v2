// main.js — 4 Merge Cloud viewer
import * as THREE from './three/three.module.js';
import { OrbitControls } from './jsm/controls/OrbitControls.js';
import { TransformControls } from './jsm/controls/TransformControls.js';
import { loadPLY, loadXYZ } from './loaders/pointcloud_loaders.js';

// ── Versió i feature flags ────────────────────────────────────────────────────
const APP_VERSION = '2.1.0';
const FEATURES = {
  segmentacioSemantica: false,  // RANSAC + classificació per tipus
  completatBuits:       false,  // omplir forats basant-se en semàntica
};

// ── Parsers OBJ i GLB ────────────────────────────────────────────────────────
async function loadOBJ(file) {
  const text = await file.text();
  const positions = [], colors = [];
  for (const raw of text.split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] !== 'v' || p.length < 4) continue;
    positions.push(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
    if (p.length >= 7) {
      const r = parseFloat(p[4]), g = parseFloat(p[5]), b = parseFloat(p[6]);
      colors.push(isNaN(r)?1:r, isNaN(g)?1:g, isNaN(b)?1:b);
    }
  }
  if (positions.length === 0) throw new Error('Cap vèrtex trobat al fitxer OBJ');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const hasCol = colors.length === positions.length;
  if (hasCol) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  const mat = new THREE.PointsMaterial({ size: 0.025, vertexColors: hasCol, color: hasCol ? 0xffffff : 0xcccccc });
  const cloud = new THREE.Points(geo, mat);
  cloud.name = file.name;
  return cloud;
}

async function loadGLB(file) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('No és un fitxer GLB vàlid');
  let offset = 12, jsonBuf = null, binBuf = null;
  while (offset < buf.byteLength - 8) {
    const chunkLen  = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    offset += 8;
    if      (chunkType === 0x4E4F534A) jsonBuf = buf.slice(offset, offset + chunkLen);
    else if (chunkType === 0x004E4942) binBuf  = buf.slice(offset, offset + chunkLen);
    offset += chunkLen;
  }
  if (!jsonBuf) throw new Error('Chunk JSON no trobat al GLB');
  const gltf = JSON.parse(new TextDecoder().decode(jsonBuf));
  const allPos = [], allCol = [];
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const posAcc = gltf.accessors?.[prim.attributes?.POSITION];
      if (!posAcc || !binBuf) continue;
      const bv  = gltf.bufferViews[posAcc.bufferView];
      const off = (bv.byteOffset || 0) + (posAcc.byteOffset || 0);
      const arr = new Float32Array(binBuf.slice(off, off + posAcc.count * 12));
      for (let i = 0; i < arr.length; i++) allPos.push(arr[i]);
      const colAcc = gltf.accessors?.[prim.attributes?.COLOR_0];
      if (colAcc) {
        const cbv  = gltf.bufferViews[colAcc.bufferView];
        const cOff = (cbv.byteOffset || 0) + (colAcc.byteOffset || 0);
        const comp = colAcc.type === 'VEC4' ? 4 : 3;
        const ct   = colAcc.componentType;
        const bytes = ct === 5121 ? 1 : ct === 5123 ? 2 : 4;
        const raw   = binBuf.slice(cOff, cOff + colAcc.count * comp * bytes);
        const cArr  = ct === 5126 ? new Float32Array(raw) : ct === 5121 ? new Uint8Array(raw) : new Uint16Array(raw);
        const scale = ct === 5126 ? 1 : ct === 5121 ? 255 : 65535;
        for (let i = 0; i < colAcc.count; i++)
          allCol.push(cArr[i*comp]/scale, cArr[i*comp+1]/scale, cArr[i*comp+2]/scale);
      }
    }
  }
  if (allPos.length === 0) throw new Error('Cap geometria trobada al GLB');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allPos), 3));
  const hasCol = allCol.length === allPos.length;
  if (hasCol) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(allCol), 3));
  const mat = new THREE.PointsMaterial({ size: 0.025, vertexColors: hasCol, color: hasCol ? 0xffffff : 0xcccccc });
  const cloud = new THREE.Points(geo, mat);
  cloud.name = file.name;
  return cloud;
}

// ── Textos UI (CA / EN) ──────────────────────────────────────────────────────
const T = (window.APP_LANG === 'en') ? {
  noCloudLoaded:  'Load a cloud first.',
  noBoxCreated:   'Create a clipping box first.',
  unsupported:    ext  => `Unsupported format: ${ext}`,
  loadError:      (n, m) => `Error loading ${n}: ${m}`,
  noClouds:       'No clouds loaded.',
  resetConfirm:   'Delete all clouds, clipping boxes and measurements?',
  alignPick:      n    => `${n}-point alignment — click the cloud to move · ESC to cancel`,
  alignSrc:       (c, t) => `SOURCE point ${c}/${t} — click the selected cloud · ESC to cancel`,
  alignTgt:       (c, t) => `TARGET point ${c}/${t} — click the reference cloud · ESC to cancel`,
  needTwoClouds:  'Load at least 2 clouds to use alignment.',
} : {
  noCloudLoaded:  'Primer carrega un núvol.',
  noBoxCreated:   'Primer crea una caixa de tall.',
  unsupported:    ext  => `Format no suportat: ${ext}`,
  loadError:      (n, m) => `Error carregant ${n}: ${m}`,
  noClouds:       'No hi ha núvols carregats.',
  resetConfirm:   'Esborrar tots els núvols, caixes de tall i cotes?',
  alignPick:      n    => `Alineació ${n}pt — fes clic al núvol que vols moure · ESC per cancel·lar`,
  alignSrc:       (c, t) => `Punt ORIGEN ${c}/${t} — fes clic al núvol seleccionat · ESC per cancel·lar`,
  alignTgt:       (c, t) => `Punt DESTÍ ${c}/${t} — fes clic al núvol de referència · ESC per cancel·lar`,
  needTwoClouds:  'Cal tenir almenys 2 núvols carregats per alinear.',
};

let scene, camera, renderer, controls, transformControls;

// Càmera ortogràfica (vistes planes)
let orthoCamera = null;
let orthoControls = null;
let useOrtho = false;

const clouds = [];
let selectedCloud = null;
let cloudTCMode = 'translate';

// ── State machine ─────────────────────────────────────────────────────────────
// MODE: 'none' | 'translate' | 'rotate' | 'clipbox_translate' | 'clipbox_rotate' | 'align' | 'measure'
let appMode = 'none';

function setMode(newMode) {
  appMode = newMode;
  updateModeBadge();
}

function updateModeBadge() {
  const badge = document.getElementById('modeBadge');
  if (!badge) return;
  const labels = {
    'none': '',
    'translate': window.APP_LANG === 'en' ? 'MOVE CLOUD' : 'MOURE NÚVOL',
    'rotate': window.APP_LANG === 'en' ? 'ROTATE CLOUD' : 'ROTAR NÚVOL',
    'clipbox_translate': window.APP_LANG === 'en' ? 'MOVE CLIPPING BOX' : 'MOURE CAIXA DE TALL',
    'clipbox_rotate': window.APP_LANG === 'en' ? 'ROTATE CLIPPING BOX' : 'ROTAR CAIXA DE TALL',
    'align': '',   // el badge d'alineació ja ho gestiona
    'measure': '', // el badge de mesura ja ho gestiona
  };
  const label = labels[appMode] || '';
  badge.textContent = label;
  badge.style.display = label ? 'block' : 'none';
}
// ─────────────────────────────────────────────────────────────────────────────

// Clipping en temps real
const LOCAL_CLIP_PLANES = [
  new THREE.Plane(new THREE.Vector3( 1, 0, 0), 0.5),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.5),
  new THREE.Plane(new THREE.Vector3( 0, 1, 0), 0.5),
  new THREE.Plane(new THREE.Vector3( 0,-1, 0), 0.5),
  new THREE.Plane(new THREE.Vector3( 0, 0, 1), 0.5),
  new THREE.Plane(new THREE.Vector3( 0, 0,-1), 0.5),
];

const selectableObjects = [];
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.1 };

const mouse = new THREE.Vector2();

let measuring = false;
let currentMeasurePoints = [];
let currentMeasureMarkers = [];
let measurements = [];

// Desfer (undo)
const undoStack = [];
const MAX_UNDO = 20;

function pushUndo(cloud, saveGeometry = false) {
  if (!cloud) return;
  undoStack.push({
    cloud,
    position: cloud.position.clone(),
    quaternion: cloud.quaternion.clone(),
    geometry: saveGeometry ? cloud.geometry : null  // referència (no còpia)
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoBtn();
}

function doUndo() {
  if (!undoStack.length) return;
  const state = undoStack.pop();
  const cloud = state.cloud;
  cloud.position.copy(state.position);
  cloud.quaternion.copy(state.quaternion);
  if (state.geometry && state.geometry !== cloud.geometry) {
    cloud.geometry.dispose();
    cloud.geometry = state.geometry;
  }
  cloud.updateMatrixWorld(true);
  const box = cloud.userData.clipBox;
  if (box && cloud.userData.boxRelMatrix) {
    const m = new THREE.Matrix4().multiplyMatrices(cloud.matrixWorld, cloud.userData.boxRelMatrix);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    box.position.copy(p); box.quaternion.copy(q); box.scale.copy(s);
    box.updateMatrixWorld(true);
  }
  if (selectedCloud === cloud) {
    transformControls.attach(cloud);
    syncNumericInputs(cloud);
  }
  updateUndoBtn();
}

function updateUndoBtn() {
  const btn = document.getElementById('btnUndo');
  if (!btn) return;
  btn.disabled = undoStack.length === 0;
  btn.style.color = undoStack.length > 0 ? '#ddd' : '#888';
  btn.style.background = undoStack.length > 0 ? '#333' : '#2a2a2a';
}

// Alineació
let alignMode  = 0;       // 0=off, 2=2pt, 3=3pt
let alignPhase = 'src';   // 'src' | 'tgt'
let alignSrcPts = [];
let alignTgtPts = [];
let alignMarkers = [];
let alignSrcCloud = null;

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
function init() {
  const container = document.getElementById('viewer');
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1117);
  scene.add(new THREE.AxesHelper(1));

  camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1e7);
  camera.position.set(0, 0, 5);

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.update();

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSize(0.7);
  transformControls.setMode('translate');
  scene.add(transformControls);

  transformControls.addEventListener('dragging-changed', (e) => {
    if (e.value) {
      const obj = transformControls.object;
      if (obj && clouds.includes(obj)) pushUndo(obj);
    }
    if (!e.value) {
      const obj = transformControls.object;
      if (obj && obj.userData.parentCloud) {
        const pc = obj.userData.parentCloud;
        pc.updateMatrixWorld(true);
        obj.updateMatrixWorld(true);
        pc.userData.boxRelMatrix = new THREE.Matrix4()
          .copy(pc.matrixWorld).invert()
          .multiply(obj.matrixWorld);
      }
      // Feedback visual breu quan es confirma el moviment
      if (obj && clouds.includes(obj)) _flashConfirmBadge();
    }
    if (useOrtho) {
      if (orthoControls) orthoControls.enabled = !e.value;
    } else {
      controls.enabled = !e.value;
    }
  });

  transformControls.addEventListener('change', () => {
    const obj = transformControls.object;
    if (!obj || !clouds.includes(obj)) return;
    const box = obj.userData.clipBox;
    if (!box || !obj.userData.boxRelMatrix) return;
    obj.updateMatrixWorld(true);
    const m = new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, obj.userData.boxRelMatrix);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    box.position.copy(p);
    box.quaternion.copy(q);
    box.scale.copy(s);
    box.updateMatrixWorld(true);
  });

  // Càmera ortogràfica
  const aspect = width / height;
  orthoCamera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -1e6, 1e6);
  orthoControls = new OrbitControls(orthoCamera, renderer.domElement);
  orthoControls.enableDamping = false;
  orthoControls.enabled = false;

  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('wheel', onMouseWheel, { passive: false });
}

// ─────────────────────────────────────────────
// Resize
// ─────────────────────────────────────────────
function _viewerSize() {
  const v = document.getElementById('viewer');
  return v ? { w: v.clientWidth, h: v.clientHeight } : { w: window.innerWidth, h: window.innerHeight };
}

function onWindowResize() {
  const { w, h } = _viewerSize();
  const a = w / h;

  camera.aspect = a;
  camera.updateProjectionMatrix();

  if (orthoCamera) {
    const hH = (orthoCamera.top - orthoCamera.bottom) / 2;
    orthoCamera.left   = -hH * a;
    orthoCamera.right  =  hH * a;
    orthoCamera.updateProjectionMatrix();
  }

  renderer.setSize(w, h);
}

// ─────────────────────────────────────────────
// Mida adaptativa de punts
// ─────────────────────────────────────────────
function adaptPointSize(cloud) {
  cloud.material.sizeAttenuation = false;
  cloud.material.size = 3;
  cloud.material.needsUpdate = true;
}

// ─────────────────────────────────────────────
// Clipping en temps real
// ─────────────────────────────────────────────
function updateClipPlanes() {
  clouds.forEach(cloud => {
    const box = cloud.userData.clipBox;
    if (!box) { cloud.material.clippingPlanes = []; return; }
    box.updateMatrixWorld(true);
    cloud.material.clippingPlanes = LOCAL_CLIP_PLANES.map(p =>
      p.clone().applyMatrix4(box.matrixWorld)
    );
    cloud.material.needsUpdate = true;
  });
}

function removeClipBox() {
  const cloud = selectedCloud || clouds.find(c => c.userData.clipBox);
  if (!cloud || !cloud.userData.clipBox) return;
  const box = cloud.userData.clipBox;
  scene.remove(box);
  box.geometry.dispose(); box.material.dispose();
  const si = selectableObjects.indexOf(box);
  if (si >= 0) selectableObjects.splice(si, 1);
  cloud.userData.clipBox = null;
  cloud.userData.boxRelMatrix = null;
  cloud.material.clippingPlanes = [];
  cloud.material.needsUpdate = true;
  if (selectedCloud) transformControls.attach(selectedCloud);
  else transformControls.detach();
  // Torna al mode del núvol
  if (appMode === 'clipbox_translate' || appMode === 'clipbox_rotate') {
    setMode(cloudTCMode);
  }
}

function getActiveClipBox() {
  return selectedCloud?.userData.clipBox ?? null;
}

function syncClipBox(cloud) {
  if (!cloud) return;
  const box = cloud.userData.clipBox;
  if (!box || !cloud.userData.boxRelMatrix) return;
  cloud.updateMatrixWorld(true);
  const m = new THREE.Matrix4().multiplyMatrices(cloud.matrixWorld, cloud.userData.boxRelMatrix);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  box.position.copy(p); box.quaternion.copy(q); box.scale.copy(s);
  box.updateMatrixWorld(true);
}

function resetAll() {
  if (!confirm(T.resetConfirm)) return;

  clouds.forEach(cloud => {
    if (cloud.userData.clipBox) {
      const box = cloud.userData.clipBox;
      scene.remove(box);
      box.geometry.dispose(); box.material.dispose();
      const si = selectableObjects.indexOf(box);
      if (si >= 0) selectableObjects.splice(si, 1);
    }
  });

  [...clouds].forEach(cloud => {
    scene.remove(cloud);
    cloud.geometry.dispose(); cloud.material.dispose();
    const si = selectableObjects.indexOf(cloud);
    if (si >= 0) selectableObjects.splice(si, 1);
  });
  clouds.length = 0;

  clearAllMeasurements();
  clearAlignMarkers();

  selectedCloud = null;
  measuring = false;
  alignMode = 0;
  alignPhase = 'src';
  undoStack.length = 0;
  if (lassoErasing) stopLassoErase();

  transformControls.detach();
  setMode('none');

  const measureBadge = document.getElementById('measureBadge');
  if (measureBadge) measureBadge.style.display = 'none';
  const alignBadge = document.getElementById('alignBadge');
  if (alignBadge) alignBadge.style.display = 'none';

  updateCloudList();
  updateUndoBtn();
  updateMeasureList();
}

// ─────────────────────────────────────────────
// Vistes ortogràfiques
// ─────────────────────────────────────────────
function getSceneBounds() {
  const box = new THREE.Box3();
  clouds.forEach(c => { c.updateMatrixWorld(true); box.expandByObject(c); });
  if (box.isEmpty()) box.set(new THREE.Vector3(-10,-10,-10), new THREE.Vector3(10,10,10));
  return box;
}

function setOrthoView(dir, up) {
  const box    = getSceneBounds();
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 10;
  const { w: W, h: H } = _viewerSize();
  const aspect = W / H;
  const hH = maxDim * 0.6;
  const hW = hH * aspect;

  orthoCamera.left   = -hW;  orthoCamera.right  =  hW;
  orthoCamera.top    =  hH;  orthoCamera.bottom = -hH;
  orthoCamera.near   = -maxDim * 200;
  orthoCamera.far    =  maxDim * 200;
  orthoCamera.updateProjectionMatrix();

  orthoCamera.position.copy(center).addScaledVector(dir.clone().normalize(), maxDim * 2);
  orthoCamera.up.copy(up);
  orthoCamera.lookAt(center);
  orthoControls.target.copy(center);
  orthoControls.update();

  useOrtho = true;
  controls.enabled = false;
  orthoControls.enabled = true;
  transformControls.camera = orthoCamera;

  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('ortho-active'));
}

function activate3DView() {
  useOrtho = false;
  controls.enabled = true;
  orthoControls.enabled = false;
  transformControls.camera = camera;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('ortho-active'));
}

// ─────────────────────────────────────────────
// Alineació estil AutoCAD (2 i 3 punts)
// ─────────────────────────────────────────────
function startAlign(n) {
  if (measuring) return;
  if (clouds.length < 2) { alert(T.needTwoClouds); return; }
  alignMode  = n;
  alignPhase = 'pickCloud';
  alignSrcPts = []; alignTgtPts = [];
  alignSrcCloud = null;
  clearAlignMarkers();
  transformControls.detach();
  setMode('align');
  updateAlignBadge();
}

function cancelAlign() {
  alignMode = 0;
  alignSrcCloud = null;
  clearAlignMarkers();
  updateAlignBadge();
  if (selectedCloud) transformControls.attach(selectedCloud);
  setMode(cloudTCMode);
}

function clearAlignMarkers() {
  alignMarkers.forEach(m => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
  alignMarkers = [];
}

function updateAlignBadge() {
  const badge = document.getElementById('alignBadge');
  if (!badge) return;
  if (!alignMode) { badge.style.display = 'none'; return; }
  badge.style.display = 'block';

  if (alignPhase === 'pickCloud') {
    badge.textContent = T.alignPick(alignMode);
    return;
  }
  if (alignPhase === 'src') {
    const cur = alignSrcPts.length + 1;
    badge.textContent = T.alignSrc(cur, alignMode);
    return;
  }
  const cur = alignTgtPts.length + 1;
  badge.textContent = T.alignTgt(cur, alignMode);
}

function handleAlignClick(pWorld, cloud) {
  if (alignPhase === 'pickCloud') {
    alignSrcCloud = cloud;
    alignPhase = 'src';
    selectCloud(cloud);
    updateAlignBadge();
    return;
  }

  const markerR = getCloudMarkerSize();

  if (alignPhase === 'src') {
    if (cloud !== alignSrcCloud) {
      const badge = document.getElementById('alignBadge');
      if (badge) {
        const prev = badge.style.background;
        badge.style.background = 'rgba(180,0,0,0.95)';
        setTimeout(() => { badge.style.background = prev; }, 350);
      }
      return;
    }
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(markerR * 2, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff4400, depthTest: false })
    );
    m.position.copy(pWorld);
    scene.add(m); alignMarkers.push(m);
    alignSrcPts.push(pWorld.clone());
    if (alignSrcPts.length === alignMode) alignPhase = 'tgt';
    updateAlignBadge();
    return;
  }

  if (cloud === alignSrcCloud) {
    const badge = document.getElementById('alignBadge');
    if (badge) {
      const prev = badge.style.background;
      badge.style.background = 'rgba(180,0,0,0.95)';
      setTimeout(() => { badge.style.background = prev; }, 350);
    }
    return;
  }
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(markerR * 2, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x00cc44, depthTest: false })
  );
  m.position.copy(pWorld);
  scene.add(m); alignMarkers.push(m);
  alignTgtPts.push(pWorld.clone());

  if (alignTgtPts.length === alignMode) {
    pushUndo(alignSrcCloud);
    if (alignMode === 2) applyAlign2pt(alignSrcCloud, alignSrcPts, alignTgtPts);
    else                 applyAlign3pt(alignSrcCloud, alignSrcPts, alignTgtPts);
    cancelAlign();
  } else {
    updateAlignBadge();
  }
}

// Alineació 2D (Kabsch XZ) — força rotació entorn l'eix Y vertical.
// Evita el bug del producte vectorial 3D que podia generar reflexions
// quan l'ordre dels punts és diferent entre núvols.

function applyAlign2pt(srcCloud, sp, tp) {
  if (!srcCloud) return;

  // Translació: sp[0] → tp[0]
  const tr = tp[0].clone().sub(sp[0]);

  // Rotació entorn Y: alinear la projecció XZ de sp[0]→sp[1] amb tp[0]→tp[1]
  const sdx = sp[1].x - sp[0].x, sdz = sp[1].z - sp[0].z;
  const tdx = tp[1].x - tp[0].x, tdz = tp[1].z - tp[0].z;
  const sl = Math.sqrt(sdx*sdx + sdz*sdz);
  const tl = Math.sqrt(tdx*tdx + tdz*tdz);

  let q = new THREE.Quaternion();
  if (sl > 1e-4 && tl > 1e-4) {
    const su = sdx/sl, sv = sdz/sl;
    const tu = tdx/tl, tv = tdz/tl;
    // Angle Kabsch: de (su,sv) a (tu,tv); rotació Three.js Y = -theta
    const phi = -Math.atan2(su*tv - sv*tu, su*tu + sv*tv);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), phi);
  }

  // Translació → rotació entorn tp[0]
  srcCloud.position.add(tr);
  srcCloud.position.sub(tp[0]);
  srcCloud.position.applyQuaternion(q);
  srcCloud.position.add(tp[0]);
  srcCloud.quaternion.premultiply(q);

  srcCloud.updateMatrixWorld(true);
  syncClipBox(srcCloud);
  selectCloud(srcCloud);
}

function applyAlign3pt(srcCloud, sp, tp) {
  if (!srcCloud) return;

  const n = sp.length;

  // Centroids en XZ
  let scx=0, scz=0, tcx=0, tcz=0;
  for (let i=0; i<n; i++) { scx+=sp[i].x; scz+=sp[i].z; tcx+=tp[i].x; tcz+=tp[i].z; }
  scx/=n; scz/=n; tcx/=n; tcz/=n;

  // Kabsch 2D: rotació òptima mínims quadrats en el pla XZ
  let num=0, den=0;
  for (let i=0; i<n; i++) {
    const su=sp[i].x-scx, sv=sp[i].z-scz;
    const tu=tp[i].x-tcx, tv=tp[i].z-tcz;
    num += su*tv - sv*tu;
    den += su*tu + sv*tv;
  }
  // rotació Three.js entorn Y = -theta_Kabsch
  const phi = -Math.atan2(num, den);
  const q   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), phi);

  // Translació: tc - R·sc
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const trX = tcx - (scx*cosP + scz*sinP);
  const trZ = tcz - (-scx*sinP + scz*cosP);
  let trY = 0;
  for (let i=0; i<n; i++) trY += tp[i].y - sp[i].y;
  trY /= n;

  // Aplica al núvol
  srcCloud.position.applyQuaternion(q);
  srcCloud.quaternion.premultiply(q);
  srcCloud.position.x += trX;
  srcCloud.position.y += trY;
  srcCloud.position.z += trZ;

  srcCloud.updateMatrixWorld(true);
  syncClipBox(srcCloud);
  selectCloud(srcCloud);
}

// ─────────────────────────────────────────────
// Auto-align per color i coordenades (v2 — cel·les locals + RANSAC)
// ─────────────────────────────────────────────
// ── ICP (Iterative Closest Point) ────────────────────────────────────────────
//
// Pipeline:
//  1. Mostreig aleatori dels dos núvols (≤5000 pts cadascun)
//  2. Hash espacial del núvol objectiu per cerca ràpida del veí més proper
//  3. Per cada iteració:
//      a. Correspondències per veí més proper
//      b. Rebuig d'outliers (> 2.5× mediana de distàncies)
//      c. Kabsch (SVD 3×3) → R, t òptims
//      d. Aplica R,t al mostreig font, acumula transform total
//  4. Al final, aplica el transform total al núvol sencer (amb Undo)
// ─────────────────────────────────────────────────────────────────────────────

// ── Àlgebra 3×3 ──────────────────────────────────────────────────────────────
function _m3mul(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i=0;i<3;i++) for (let k=0;k<3;k++) if (A[i][k]!==0)
    for (let j=0;j<3;j++) C[i][j] += A[i][k]*B[k][j];
  return C;
}
function _m3T(A) {
  return [[A[0][0],A[1][0],A[2][0]],[A[0][1],A[1][1],A[2][1]],[A[0][2],A[1][2],A[2][2]]];
}
function _m3det(A) {
  return A[0][0]*(A[1][1]*A[2][2]-A[1][2]*A[2][1])
       - A[0][1]*(A[1][0]*A[2][2]-A[1][2]*A[2][0])
       + A[0][2]*(A[1][0]*A[2][1]-A[1][1]*A[2][0]);
}

// Jacobi eigendecomposition per matriu simètrica 3×3
// Retorna { values:[λ0,λ1,λ2], vectors:V } on A ≈ V diag(λ) V^T
function _jacobiEig3(Ain) {
  const a = [Ain[0].slice(), Ain[1].slice(), Ain[2].slice()];
  const V = [[1,0,0],[0,1,0],[0,0,1]];
  for (let sweep=0; sweep<30; sweep++) {
    let maxOff=0;
    for (let i=0;i<3;i++) for (let j=i+1;j<3;j++) maxOff=Math.max(maxOff,Math.abs(a[i][j]));
    if (maxOff < 1e-14) break;
    for (let p=0;p<2;p++) for (let q=p+1;q<3;q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const tau = (a[q][q]-a[p][p])/(2*a[p][q]);
      const t   = (tau>=0?1:-1)/(Math.abs(tau)+Math.sqrt(1+tau*tau));
      const c   = 1/Math.sqrt(1+t*t), s = t*c;
      const app=a[p][p], aqq=a[q][q], apq=a[p][q];
      a[p][p]=app-t*apq; a[q][q]=aqq+t*apq; a[p][q]=a[q][p]=0;
      for (let r=0;r<3;r++) {
        if (r===p||r===q) continue;
        const arp=a[r][p],arq=a[r][q];
        a[r][p]=a[p][r]=c*arp-s*arq;
        a[r][q]=a[q][r]=s*arp+c*arq;
      }
      for (let r=0;r<3;r++) {
        const vrp=V[r][p],vrq=V[r][q];
        V[r][p]=c*vrp-s*vrq; V[r][q]=s*vrp+c*vrq;
      }
    }
  }
  return { values:[a[0][0],a[1][1],a[2][2]], vectors:V };
}

// SVD 3×3: H = U diag(S) V^T
function _svd3(H) {
  const HT  = _m3T(H);
  const HtH = _m3mul(HT, H);
  const { values:s2, vectors:V } = _jacobiEig3(HtH);
  // Ordena per valor singular descendent
  const idx = [0,1,2].sort((a,b)=>s2[b]-s2[a]);
  const S   = idx.map(i=>Math.sqrt(Math.max(0,s2[i])));
  const Vs  = [[V[0][idx[0]],V[0][idx[1]],V[0][idx[2]]],
                [V[1][idx[0]],V[1][idx[1]],V[1][idx[2]]],
                [V[2][idx[0]],V[2][idx[1]],V[2][idx[2]]]];
  // U = H V S^{-1}  (columnes on S>0, les altres ortogonalitzem via det)
  const HV = _m3mul(H, Vs);
  const U  = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i=0;i<3;i++) for (let j=0;j<3;j++)
    U[i][j] = S[j]>1e-10 ? HV[i][j]/S[j] : 0;
  // Si U és quasi-singular, corregim l'última columna amb el producte vectorial
  if (Math.abs(_m3det(U)) < 0.5) {
    for (let i=0;i<3;i++) {
      U[i][2] = (i===0) ? U[1][0]*U[2][1]-U[2][0]*U[1][1]
              : (i===1) ? U[2][0]*U[0][1]-U[0][0]*U[2][1]
                        : U[0][0]*U[1][1]-U[1][0]*U[0][1];
    }
  }
  return { U, S, V:Vs };
}

// Algoritme de Kabsch: transform rígid òptim (R,t) que minimitza Σ|R·aᵢ+t−bᵢ|²
function _kabsch(srcPts, tgtPts) {
  const n = srcPts.length;
  let cSx=0,cSy=0,cSz=0, cTx=0,cTy=0,cTz=0;
  for (let i=0;i<n;i++) {
    cSx+=srcPts[i].x; cSy+=srcPts[i].y; cSz+=srcPts[i].z;
    cTx+=tgtPts[i].x; cTy+=tgtPts[i].y; cTz+=tgtPts[i].z;
  }
  cSx/=n; cSy/=n; cSz/=n; cTx/=n; cTy/=n; cTz/=n;
  // Matriu de cross-covariança H = Aᵀ B
  const H = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i=0;i<n;i++) {
    const ax=srcPts[i].x-cSx, ay=srcPts[i].y-cSy, az=srcPts[i].z-cSz;
    const bx=tgtPts[i].x-cTx, by=tgtPts[i].y-cTy, bz=tgtPts[i].z-cTz;
    H[0][0]+=ax*bx; H[0][1]+=ax*by; H[0][2]+=ax*bz;
    H[1][0]+=ay*bx; H[1][1]+=ay*by; H[1][2]+=ay*bz;
    H[2][0]+=az*bx; H[2][1]+=az*by; H[2][2]+=az*bz;
  }
  const {U,V} = _svd3(H);
  let R = _m3mul(V, _m3T(U));
  // Corregeix reflexió (det(R) ha de ser +1)
  if (_m3det(R) < 0) {
    const Vc = V.map(r=>r.slice());
    for (let i=0;i<3;i++) Vc[i][2]=-Vc[i][2];
    R = _m3mul(Vc, _m3T(U));
  }
  // t = centroid_tgt − R · centroid_src
  const t = [
    cTx-(R[0][0]*cSx+R[0][1]*cSy+R[0][2]*cSz),
    cTy-(R[1][0]*cSx+R[1][1]*cSy+R[1][2]*cSz),
    cTz-(R[2][0]*cSx+R[2][1]*cSy+R[2][2]*cSz),
  ];
  return { R, t };
}

// ── Hash espacial per a cerca del veí més proper ──────────────────────────────
function _buildHash(pts, cell) {
  const h = new Map();
  for (let i=0;i<pts.length;i++) {
    const k=`${Math.floor(pts[i].x/cell)},${Math.floor(pts[i].y/cell)},${Math.floor(pts[i].z/cell)}`;
    if (!h.has(k)) h.set(k,[]);
    h.get(k).push(i);
  }
  return h;
}

function _nearest(p, pts, hash, cell) {
  const kx=Math.floor(p.x/cell), ky=Math.floor(p.y/cell), kz=Math.floor(p.z/cell);
  let best=Infinity, bi=-1;
  for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++) {
    const bucket=hash.get(`${kx+dx},${ky+dy},${kz+dz}`);
    if (!bucket) continue;
    for (const i of bucket) {
      const d=(pts[i].x-p.x)**2+(pts[i].y-p.y)**2+(pts[i].z-p.z)**2;
      if (d<best){best=d;bi=i;}
    }
  }
  return {dist:Math.sqrt(best),idx:bi};
}

// ── Loop ICP principal ────────────────────────────────────────────────────────
async function runICP(srcCloud, tgtCloud, maxIter=50, onProgress=null) {
  srcCloud.updateMatrixWorld(true);
  tgtCloud.updateMatrixWorld(true);
  const srcPos=srcCloud.geometry.getAttribute('position'), srcMW=srcCloud.matrixWorld;
  const tgtPos=tgtCloud.geometry.getAttribute('position'), tgtMW=tgtCloud.matrixWorld;
  const MAX=5000;
  const sStep=Math.max(1,Math.floor(srcPos.count/MAX));
  const tStep=Math.max(1,Math.floor(tgtPos.count/MAX));
  const v=new THREE.Vector3();
  const srcS=[], tgtS=[];
  for (let i=0;i<srcPos.count;i+=sStep){
    v.fromBufferAttribute(srcPos,i).applyMatrix4(srcMW);
    srcS.push({x:v.x,y:v.y,z:v.z});
  }
  for (let i=0;i<tgtPos.count;i+=tStep){
    v.fromBufferAttribute(tgtPos,i).applyMatrix4(tgtMW);
    tgtS.push({x:v.x,y:v.y,z:v.z});
  }
  // Estima cell size des del bounding box del target (~1/50 de la diagonal)
  const bb=new THREE.Box3().setFromObject(tgtCloud);
  let cell=bb.max.clone().sub(bb.min).length()/50;
  if (cell<0.001) cell=0.1;

  // Transform acumulat (comença com identitat)
  let Rtot=[[1,0,0],[0,1,0],[0,0,1]], ttot=[0,0,0];
  let srcW=srcS.map(p=>({...p})); // còpia de treball
  let prevErr=Infinity;

  for (let it=0;it<maxIter;it++) {
    const hash=_buildHash(tgtS,cell);
    const sC=[],tC=[],dists=[];
    for (const p of srcW){
      const {dist,idx}=_nearest(p,tgtS,hash,cell);
      if(idx>=0){sC.push(p);tC.push(tgtS[idx]);dists.push(dist);}
    }
    if(sC.length<6) break;
    // Rebuig outliers: > 2.5× la mediana
    const ds=[...dists].sort((a,b)=>a-b);
    const thresh=ds[Math.floor(ds.length/2)]*2.5;
    const sF=[],tF=[];
    for(let i=0;i<sC.length;i++) if(dists[i]<thresh){sF.push(sC[i]);tF.push(tC[i]);}
    if(sF.length<6) break;
    // Error RMS
    let err=0;
    for(let i=0;i<sF.length;i++){
      err+=(sF[i].x-tF[i].x)**2+(sF[i].y-tF[i].y)**2+(sF[i].z-tF[i].z)**2;
    }
    err=Math.sqrt(err/sF.length);
    if(onProgress) onProgress(it+1,maxIter,err);
    if(Math.abs(prevErr-err)<1e-7) break;
    prevErr=err;
    // Kabsch
    const {R,t}=_kabsch(sF,tF);
    // Aplica als punts de treball
    for(const p of srcW){
      const {x,y,z}=p;
      p.x=R[0][0]*x+R[0][1]*y+R[0][2]*z+t[0];
      p.y=R[1][0]*x+R[1][1]*y+R[1][2]*z+t[1];
      p.z=R[2][0]*x+R[2][1]*y+R[2][2]*z+t[2];
    }
    // Acumula: Rtot = R·Rtot,  ttot = R·ttot + t
    Rtot=_m3mul(R,Rtot);
    ttot=[
      R[0][0]*ttot[0]+R[0][1]*ttot[1]+R[0][2]*ttot[2]+t[0],
      R[1][0]*ttot[0]+R[1][1]*ttot[1]+R[1][2]*ttot[2]+t[1],
      R[2][0]*ttot[0]+R[2][1]*ttot[1]+R[2][2]*ttot[2]+t[2],
    ];
    // Redueix cell size a mesura que convergim
    if(it>5) cell=Math.max(bb.max.clone().sub(bb.min).length()/500, cell*0.92);
    // Cedeix al browser cada 5 iteracions
    if(it%5===4) await new Promise(r=>setTimeout(r,0));
  }
  return {R:Rtot,t:ttot,error:prevErr};
}

// ── Aplica ICP al núvol seleccionat ──────────────────────────────────────────
async function applyICP() {
  if(clouds.length<2){alert(window.APP_LANG==='en'?'Load at least 2 clouds first.':'Cal tenir almenys 2 núvols carregats.');return;}
  const src=selectedCloud;
  const tgt=clouds.find(c=>c!==src&&c.visible);
  if(!src||!tgt){alert(window.APP_LANG==='en'?'Select source cloud (the one to move).':'Selecciona el núvol font (el que es mourà).');return;}

  const badge=document.getElementById('loadingBadge');
  badge.style.display='block';
  badge.textContent='⏳ ICP — preparant...';

  try {
    const {R,t,error}=await runICP(src,tgt,60,(it,max,err)=>{
      if(isFinite(err)) badge.textContent=`⏳ ICP iteració ${it}/${max} — error: ${err.toFixed(4)} m`;
    });

    badge.style.display='none';
    badge.textContent='⏳ Loading file...';

    // Valida que R i t no continguin NaN/Infinity
    const vals=[R[0][0],R[0][1],R[0][2],R[1][0],R[1][1],R[1][2],R[2][0],R[2][1],R[2][2],t[0],t[1],t[2]];
    if(vals.some(v=>!isFinite(v))){
      alert(window.APP_LANG==='en'
        ?'ICP failed: clouds are too far apart or not enough overlapping points. Try manual alignment first.'
        :'ICP fallat: els núvols estan massa separats o no hi ha prou punts en comú. Fes una alineació manual prèvia.');
      return;
    }

    pushUndo(src);
    const mat=new THREE.Matrix4().set(
      R[0][0],R[0][1],R[0][2],t[0],
      R[1][0],R[1][1],R[1][2],t[1],
      R[2][0],R[2][1],R[2][2],t[2],
      0,0,0,1
    );
    src.applyMatrix4(mat);
    src.updateMatrixWorld(true);
    selectCloud(src);

    const errTxt = isFinite(error) ? error.toFixed(4) : '—';
    const msg=window.APP_LANG==='en'
      ?`ICP finished.\nFinal error: ${errTxt} m\n(Undo available)`
      :`ICP acabat.\nError final: ${errTxt} m\n(Undo disponible)`;
    alert(msg);

  } catch(err) {
    badge.style.display='none';
    badge.textContent='⏳ Loading file...';
    console.error('ICP error:', err);
    alert(window.APP_LANG==='en'
      ?`ICP error: ${err.message}. Try manual alignment first.`
      :`Error ICP: ${err.message}. Fes una alineació manual prèvia.`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// ── Transform confirm badge ───────────────────────────────────────────────────
let _confirmTimer = null;
function _flashConfirmBadge() {
  const b = document.getElementById('confirmBadge');
  if (!b) return;
  b.style.display = 'block';
  b.style.opacity = '1';
  clearTimeout(_confirmTimer);
  _confirmTimer = setTimeout(() => {
    b.style.opacity = '0';
    setTimeout(() => { b.style.display = 'none'; b.style.opacity = '1'; }, 420);
  }, 1200);
}
// ─────────────────────────────────────────────────────────────────────────────
// ── Annotation / Drawing overlay ─────────────────────────────────────────────
//
// Canvas persistent (#annotateCanvas) sempre visible per sobre del núvol.
// Modes: freehand (traç lliure), line (segment), arrow (fletxa).
// Els traços es guarden a `_annStrokes` i es redibuixen si cal.
// Els events van al #viewer quan el mode anotació és actiu.
// ─────────────────────────────────────────────────────────────────────────────

let _annActive  = false;
let _annMode    = 'free';   // 'free' | 'line' | 'arrow'
let _annColor   = '#ff4444';
let _annWidth   = 2;
let _annStrokes = [];       // [{mode, color, width, pts:[{x,y}]}]
let _annCurrent = null;     // traç en curs
let _annDrawing = false;

function _annCanvas()  { return document.getElementById('annotateCanvas'); }
function _annCtx()     { return _annCanvas().getContext('2d'); }

function _annResize() {
  const lc = _annCanvas();
  const viewer = document.getElementById('viewer');
  const w = viewer.offsetWidth  || window.innerWidth;
  const h = viewer.offsetHeight || window.innerHeight;
  if (lc.width === w && lc.height === h) return;
  lc.width = w; lc.height = h;
  _annRedraw();
}

function _annRedraw() {
  const lc = _annCanvas();
  const ctx = _annCtx();
  ctx.clearRect(0, 0, lc.width, lc.height);
  for (const s of _annStrokes) _annDrawStroke(ctx, s, false);
}

function _annDrawStroke(ctx, s, isPreview) {
  if (!s.pts || s.pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth   = s.width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.setLineDash([]);

  if (s.mode === 'free') {
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x, s.pts[0].y);
    for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
    ctx.stroke();
  } else {
    // line o arrow: primer i últim punt
    const p0 = s.pts[0], p1 = s.pts[s.pts.length - 1];
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    if (s.mode === 'arrow') {
      // Cap de fletxa
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const al  = Math.max(10, s.width * 4);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p1.x - al * Math.cos(ang - 0.4), p1.y - al * Math.sin(ang - 0.4));
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p1.x - al * Math.cos(ang + 0.4), p1.y - al * Math.sin(ang + 0.4));
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Events d'anotació ─────────────────────────────────────────────────────────
function _annVP(e) {
  const r = document.getElementById('viewer').getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX - r.left, y: src.clientY - r.top };
}

function _annDown(e) {
  if (!_annActive || (e.target.closest && e.target.closest('#controls,#lassoCancel'))) return;
  e.preventDefault(); e.stopPropagation();
  _annDrawing = true;
  const p = _annVP(e);
  _annCurrent = { mode: _annMode, color: _annColor, width: _annWidth, pts: [p] };
}
function _annMove(e) {
  if (!_annActive || !_annDrawing) return;
  e.preventDefault(); e.stopPropagation();
  const p = _annVP(e);
  if (_annMode === 'free') {
    _annCurrent.pts.push(p);
  } else {
    _annCurrent.pts = [_annCurrent.pts[0], p]; // only start+end for line/arrow
  }
  _annRedraw();
  _annDrawStroke(_annCtx(), _annCurrent, true);
}
function _annUp(e) {
  if (!_annActive || !_annDrawing) return;
  e.preventDefault(); e.stopPropagation();
  _annDrawing = false;
  if (_annCurrent && _annCurrent.pts.length >= 2) {
    _annStrokes.push(_annCurrent);
    _annRedraw();
  }
  _annCurrent = null;
}
function _annTStart(e) {
  if (!_annActive || (e.target.closest && e.target.closest('#controls'))) return;
  e.preventDefault();
  _annDrawing = true;
  _annCurrent = { mode:_annMode, color:_annColor, width:_annWidth, pts:[_annVP(e)] };
}
function _annTMove(e) {
  if (!_annActive || !_annDrawing) return;
  e.preventDefault();
  const p = _annVP(e);
  if (_annMode==='free') _annCurrent.pts.push(p);
  else _annCurrent.pts = [_annCurrent.pts[0], p];
  _annRedraw(); _annDrawStroke(_annCtx(), _annCurrent, true);
}
function _annTEnd(e) {
  if (!_annActive || !_annDrawing) return;
  e.preventDefault();
  _annDrawing = false;
  if (_annCurrent && _annCurrent.pts.length>=2) { _annStrokes.push(_annCurrent); _annRedraw(); }
  _annCurrent = null;
}

function startAnnotate() {
  _annActive = true;
  _annResize();
  const viewer = document.getElementById('viewer');
  viewer.classList.add('annotate-active');
  if (renderer) renderer.domElement.style.pointerEvents = 'none';
  viewer.addEventListener('pointerdown', _annDown,   { passive:false });
  viewer.addEventListener('pointermove', _annMove,   { passive:false });
  viewer.addEventListener('pointerup',   _annUp,     { passive:false });
  viewer.addEventListener('touchstart',  _annTStart, { passive:false });
  viewer.addEventListener('touchmove',   _annTMove,  { passive:false });
  viewer.addEventListener('touchend',    _annTEnd,   { passive:false });
  document.getElementById('btnAnnotate').classList.add('active');
  document.getElementById('annotatePanel').style.display = 'block';
}

function stopAnnotate() {
  _annActive  = false;
  _annDrawing = false;
  const viewer = document.getElementById('viewer');
  viewer.classList.remove('annotate-active');
  if (renderer) renderer.domElement.style.pointerEvents = 'auto';
  viewer.removeEventListener('pointerdown', _annDown);
  viewer.removeEventListener('pointermove', _annMove);
  viewer.removeEventListener('pointerup',   _annUp);
  viewer.removeEventListener('touchstart',  _annTStart);
  viewer.removeEventListener('touchmove',   _annTMove);
  viewer.removeEventListener('touchend',    _annTEnd);
  document.getElementById('btnAnnotate').classList.remove('active');
  // Panel queda visible per canviar colors/esborrar traços
}
// ─────────────────────────────────────────────────────────────────────────────
// ── DXF Overlay import ────────────────────────────────────────────────────────

const dxfOverlays = [];

const DXF_LAYER_COLORS = [
  0x00ccff, 0xff9900, 0x00ff88, 0xff4488,
  0xffff00, 0x88ffff, 0xff8800, 0xaaffaa,
];

function parseDXF(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2)
    pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);

  const entities = [];
  let inEntities = false;
  let i = 0;

  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val === 'SECTION') {
      inEntities = (pairs[i + 1]?.[1] === 'ENTITIES');
      i += 2; continue;
    }
    if (code === 0 && val === 'ENDSEC') { inEntities = false; i++; continue; }
    if (!inEntities || code !== 0 || val === 'EOF') { i++; continue; }

    const type = val; i++;
    const raw = {};
    while (i < pairs.length && pairs[i][0] !== 0) {
      const [c, v] = pairs[i];
      if (!raw[c]) raw[c] = [];
      raw[c].push(v);
      i++;
    }

    const ent = { type, layer: raw[8]?.[0] || '0', pts: [], closed: false };

    if (type === 'POINT') {
      ent.pts = [{ x: +raw[10]?.[0]||0, y: +raw[20]?.[0]||0, z: +raw[30]?.[0]||0 }];
    } else if (type === 'LINE') {
      ent.pts = [
        { x: +raw[10]?.[0]||0, y: +raw[20]?.[0]||0, z: +raw[30]?.[0]||0 },
        { x: +raw[11]?.[0]||0, y: +raw[21]?.[0]||0, z: +raw[31]?.[0]||0 },
      ];
    } else if (type === 'LWPOLYLINE') {
      const xs = raw[10]||[], ys = raw[20]||[];
      const elev = +raw[38]?.[0]||0;
      ent.pts = xs.map((x,k) => ({ x:+x, y:+ys[k]||0, z:elev }));
      ent.closed = (parseInt(raw[70]?.[0]||0) & 1) === 1;
    } else if (type === 'POLYLINE') {
      ent.pts = []; ent._poly = true;
      ent.closed = (parseInt(raw[70]?.[0]||0) & 1) === 1;
    } else if (type === 'VERTEX') {
      ent.pts = [{ x:+raw[10]?.[0]||0, y:+raw[20]?.[0]||0, z:+raw[30]?.[0]||0 }];
    } else if (type === 'CIRCLE') {
      const cx=+raw[10]?.[0]||0, cy=+raw[20]?.[0]||0, cz=+raw[30]?.[0]||0, r=+raw[40]?.[0]||0;
      ent.pts = Array.from({length:48},(_,k)=>({
        x: cx+r*Math.cos(2*Math.PI*k/48), y: cy+r*Math.sin(2*Math.PI*k/48), z:cz }));
      ent.closed = true;
    } else if (type === 'ARC') {
      const cx=+raw[10]?.[0]||0, cy=+raw[20]?.[0]||0, cz=+raw[30]?.[0]||0, r=+raw[40]?.[0]||0;
      let a0=(+raw[50]?.[0]||0)*Math.PI/180, a1=(+raw[51]?.[0]||0)*Math.PI/180;
      if (a1<=a0) a1+=2*Math.PI;
      const N=Math.max(8,Math.round((a1-a0)/(Math.PI/24)));
      ent.pts = Array.from({length:N+1},(_,k)=>{
        const a=a0+(a1-a0)*k/N; return {x:cx+r*Math.cos(a),y:cy+r*Math.sin(a),z:cz};});
    }
    entities.push(ent);
  }

  // Uneix VERTEX amb el POLYLINE pare
  const merged = [];
  for (let k = 0; k < entities.length; k++) {
    if (entities[k]._poly) {
      const poly = {...entities[k], pts:[]};
      k++;
      while (k<entities.length && (entities[k].type==='VERTEX'||entities[k].type==='SEQEND')) {
        if (entities[k].type==='VERTEX') poly.pts.push(entities[k].pts[0]);
        k++;
      }
      k--;
      merged.push(poly);
    } else if (entities[k].type!=='VERTEX' && entities[k].type!=='SEQEND') {
      merged.push(entities[k]);
    }
  }
  return merged;
}

function loadDXFFile(text, filename) {
  const entities = parseDXF(text);
  if (!entities.length) { alert('DXF buit o format no reconegut.'); return; }

  // Offset: centra respecte al primer núvol o al centroide del DXF
  let ox=0, oy=0, oz=0;
  let sx=0, sy=0, sz=0, np=0;
  for (const e of entities) for (const p of e.pts) { sx+=p.x; sy+=p.y; sz+=p.z; np++; }
  if (np>0) {
    sx/=np; sy/=np; sz/=np;
    if (clouds.length>0) {
      const c=new THREE.Box3().setFromObject(clouds[0]).getCenter(new THREE.Vector3());
      ox=sx-c.x; oy=sy-c.y; oz=sz-c.z;
    } else { ox=sx; oy=sy; oz=sz; }
  }

  const group = new THREE.Group(); group.name = filename;
  const layerMap = new Map(); let colorIdx=0;

  for (const ent of entities) {
    if (!layerMap.has(ent.layer))
      layerMap.set(ent.layer, { color:DXF_LAYER_COLORS[colorIdx++%DXF_LAYER_COLORS.length], lv:[], pv:[] });
    const L = layerMap.get(ent.layer);

    if (ent.type==='POINT') {
      const p=ent.pts[0];
      L.pv.push(p.x-ox, p.z-oz, -(p.y-oy));
    } else if (ent.pts.length>=2) {
      const m=ent.pts.length;
      for (let j=0;j<m-1;j++) {
        const a=ent.pts[j],b=ent.pts[j+1];
        L.lv.push(a.x-ox,a.z-oz,-(a.y-oy), b.x-ox,b.z-oz,-(b.y-oy));
      }
      if (ent.closed && m>2) {
        const a=ent.pts[m-1],b=ent.pts[0];
        L.lv.push(a.x-ox,a.z-oz,-(a.y-oy), b.x-ox,b.z-oz,-(b.y-oy));
      }
    }
  }

  const colors=[];
  for (const [,L] of layerMap) {
    colors.push(L.color);
    if (L.lv.length) {
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(L.lv,3));
      group.add(new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:L.color})));
    }
    if (L.pv.length) {
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(L.pv,3));
      group.add(new THREE.Points(g,new THREE.PointsMaterial({color:L.color,size:0.05})));
    }
  }

  scene.add(group);
  dxfOverlays.push({group, name:filename, visible:true, colors});
  updateDXFList();
}

function updateDXFList() {
  const panel = document.getElementById('dxfListPanel');
  if (!panel) return;
  panel.innerHTML='';
  dxfOverlays.forEach((ov,idx) => {
    const div = document.createElement('div');
    div.className='dxf-item';
    const hex='#'+ov.colors[0].toString(16).padStart(6,'0');
    div.innerHTML=`<span class="dxf-color" style="background:${hex}"></span>`
      +`<span class="dxf-name" title="${ov.name}">${ov.name}</span>`
      +`<span class="dxf-eye">${ov.visible?'👁':'🚫'}</span>`
      +`<span class="dxf-del">✕</span>`;
    div.querySelector('.dxf-eye').onclick=()=>{
      ov.visible=!ov.visible; ov.group.visible=ov.visible; updateDXFList();};
    div.querySelector('.dxf-del').onclick=()=>{
      scene.remove(ov.group);
      ov.group.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});
      dxfOverlays.splice(idx,1); updateDXFList();};
    panel.appendChild(div);
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// ── Statistical Outlier Removal ───────────────────────────────────────────────

async function removeNoiseFromCloud(cloud, K=10, sigmaMultiplier=2.0) {
  cloud.updateMatrixWorld(true);
  const pos=cloud.geometry.getAttribute('position');
  const col=cloud.geometry.getAttribute('color');
  const n=pos.count;
  if (n<K+1) return 0;

  const bb=new THREE.Box3().setFromObject(cloud);
  const cell=Math.max(0.001,(bb.max.clone().sub(bb.min).length()/Math.cbrt(n))*3);

  const pts=[];
  const v=new THREE.Vector3();
  for (let i=0;i<n;i++) { v.fromBufferAttribute(pos,i); pts.push({x:v.x,y:v.y,z:v.z}); }

  // Hash espacial
  const hash=new Map();
  for (let i=0;i<n;i++) {
    const key=`${Math.floor(pts[i].x/cell)},${Math.floor(pts[i].y/cell)},${Math.floor(pts[i].z/cell)}`;
    if(!hash.has(key)) hash.set(key,[]);
    hash.get(key).push(i);
  }

  function knnDist(idx) {
    const p=pts[idx];
    const kx=Math.floor(p.x/cell),ky=Math.floor(p.y/cell),kz=Math.floor(p.z/cell);
    const ds=[];
    for (let r=1;r<=3&&ds.length<K;r++) {
      for (let dx=-r;dx<=r;dx++) for (let dy=-r;dy<=r;dy++) for (let dz=-r;dz<=r;dz++) {
        if (Math.abs(dx)<r&&Math.abs(dy)<r&&Math.abs(dz)<r) continue;
        const bucket=hash.get(`${kx+dx},${ky+dy},${kz+dz}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j===idx) continue;
          ds.push(Math.sqrt((pts[j].x-p.x)**2+(pts[j].y-p.y)**2+(pts[j].z-p.z)**2));
        }
      }
      if (r===1&&ds.length>=K) break;
    }
    ds.sort((a,b)=>a-b);
    const take=ds.slice(0,K);
    return take.length ? take.reduce((s,d)=>s+d,0)/take.length : Infinity;
  }

  // Estadística sobre mostreig (màx 20k)
  const step=Math.max(1,Math.floor(n/20000));
  const sample=[];
  for (let i=0;i<n;i+=step) sample.push(knnDist(i));
  const mu=sample.reduce((s,d)=>s+d,0)/sample.length;
  const std=Math.sqrt(sample.reduce((s,d)=>s+(d-mu)**2,0)/sample.length);
  const thr=mu+sigmaMultiplier*std;

  // Filtre complet amb progress
  const newPos=[],newCol=[];
  const CHUNK=30000;
  for (let i=0;i<n;i++) {
    if (knnDist(i)<=thr) {
      newPos.push(pos.getX(i),pos.getY(i),pos.getZ(i));
      if (col) newCol.push(col.getX(i),col.getY(i),col.getZ(i));
    }
    if (i%CHUNK===CHUNK-1) {
      document.getElementById('loadingBadge').textContent=
        `⏳ Noise filter… ${Math.round(i/n*100)}%`;
      await new Promise(r=>setTimeout(r,0));
    }
  }

  const removed=n-newPos.length/3;
  if (!removed) return 0;

  pushUndo(cloud,true);
  const ng=new THREE.BufferGeometry();
  ng.setAttribute('position',new THREE.Float32BufferAttribute(newPos,3));
  if (newCol.length) ng.setAttribute('color',new THREE.Float32BufferAttribute(newCol,3));
  ng.computeBoundingBox(); ng.computeBoundingSphere();
  cloud.geometry.dispose();
  cloud.geometry=ng;
  cloud.material.needsUpdate=true;
  updateRaycasterThreshold();
  return removed;
}
// ─────────────────────────────────────────────────────────────────────────────

// Detecta cel·les locals de 50cm amb color distintiu.
// Cada cel·la és un punt de referència precís (radi ~25cm vs metres d'un centroide global).
function detectLocalColorFeatures(cloud, cellSize = 0.5, maxSamples = 40000) {
  cloud.updateMatrixWorld(true);
  const mw = cloud.matrixWorld;
  const pos = cloud.geometry.getAttribute('position');
  const col = cloud.geometry.getAttribute('color');
  if (!pos || !col) return [];

  const n = pos.count, step = Math.max(1, Math.floor(n / maxSamples));
  const cells = new Map(), v = new THREE.Vector3();

  for (let i = 0; i < n; i += step) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    const cx = Math.round(v.x / cellSize);
    const cy = Math.round(v.y / cellSize);
    const cz = Math.round(v.z / cellSize);
    const key = `${cx},${cy},${cz}`;
    let c = cells.get(key);
    if (!c) { c = { r: 0, g: 0, b: 0, n: 0, sx: 0, sy: 0, sz: 0 }; cells.set(key, c); }
    c.r += col.getX(i); c.g += col.getY(i); c.b += col.getZ(i);
    c.sx += v.x; c.sy += v.y; c.sz += v.z; c.n++;
  }

  const feats = [];
  for (const [, c] of cells) {
    if (c.n < 3) continue;
    const r = c.r / c.n, g = c.g / c.n, b = c.b / c.n;
    const avg = (r + g + b) / 3;
    const cf = Math.sqrt((r - avg) ** 2 + (g - avg) ** 2 + (b - avg) ** 2);
    if (cf < 0.08) continue; // descarta cel·les grises/blanques
    feats.push({
      centroid: new THREE.Vector3(c.sx / c.n, c.sy / c.n, c.sz / c.n),
      r, g, b, cf
    });
  }
  // Limita a les 300 cel·les més colorides per rendiment
  feats.sort((a, b) => b.cf - a.cf);
  return feats.slice(0, 300);
}

// RANSAC sobre correspondències de color:
// prova parells aleatoris i compta quantes altres correspondències
// són geomètricament consistents (distàncies semblants en src i tgt).
function matchFeaturesRANSAC(srcFeats, tgtFeats, maxIter = 400) {
  const colorDist = (a, b) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
  const COLOR_THRESH = 0.15;
  const GEO_THRESH   = 0.5;  // metres — tolerància geomètrica
  const MIN_SEP      = 1.0;  // separació mínima entre ancoratges (metres)

  // Per cada feature src, trobem la millor correspondència tgt per color
  const cands = [];
  for (const s of srcFeats) {
    let bestD = COLOR_THRESH, bestT = null;
    for (const t of tgtFeats) {
      const d = colorDist(s, t);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    if (bestT) cands.push({ src: s, tgt: bestT, cd: bestD });
  }
  if (cands.length < 2) return [];

  // RANSAC
  let bestInliers = [];
  const n = cands.length;
  const iters = Math.min(maxIter, n * (n - 1) / 2);

  for (let it = 0; it < iters; it++) {
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * (n - 1));
    if (j >= i) j++;

    const a = cands[i], b = cands[j];
    const dSrc = a.src.centroid.distanceTo(b.src.centroid);
    const dTgt = a.tgt.centroid.distanceTo(b.tgt.centroid);
    if (dSrc < MIN_SEP || dTgt < MIN_SEP) continue;
    if (Math.abs(dSrc - dTgt) / Math.max(dSrc, dTgt) > 0.3) continue;

    const inliers = [a, b];
    for (let k = 0; k < n; k++) {
      if (k === i || k === j) continue;
      const ck = cands[k];
      const d0s = a.src.centroid.distanceTo(ck.src.centroid);
      const d0t = a.tgt.centroid.distanceTo(ck.tgt.centroid);
      const d1s = b.src.centroid.distanceTo(ck.src.centroid);
      const d1t = b.tgt.centroid.distanceTo(ck.tgt.centroid);
      if (Math.abs(d0s - d0t) < GEO_THRESH && Math.abs(d1s - d1t) < GEO_THRESH) {
        inliers.push(ck);
      }
    }
    if (inliers.length > bestInliers.length) bestInliers = [...inliers];
  }

  // Retorna els 3 millors inliers (els de menor distància de color)
  bestInliers.sort((a, b) => a.cd - b.cd);
  return bestInliers.slice(0, 3);
}

// ─────────────────────────────────────────────
// Aplicar tall permanent (crop)
// ─────────────────────────────────────────────
// ── Erase tools: rectangle + freehand lasso ──────────────────────────────────
//
// eraseMode: null | 'rect' | 'lasso'
// Canvas (#lassoCanvas) és purament visual (pointer-events:none sempre).
// Els events pointer/touch es registren al #viewer quan un mode és actiu.
// El canvas WebGL (renderer.domElement) rep pointer-events:none mentre dura.
// ─────────────────────────────────────────────────────────────────────────────

let lassoErasing = false; // true quan qualsevol mode esborrat és actiu
let _eraseMode   = null;  // 'rect' | 'lasso'
let _eraseW = 1, _eraseH = 1; // mida del viewer en el moment d'activar

// Estat rectangle
let _rStart = null, _rEnd = null;

// Estat lasso lliure
let _lPath    = [];
let _lDrawing = false;

// ── Helpers comuns ────────────────────────────────────────────────────────────
function _vp(clientX, clientY) {
  const r = document.getElementById('viewer').getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function _eraseCanvas() { return document.getElementById('lassoCanvas'); }

function _clearCanvas() {
  const lc = _eraseCanvas();
  lc.getContext('2d').clearRect(0, 0, lc.width, lc.height);
}

function _isControlTarget(e) {
  return e.target && e.target.closest && e.target.closest('#controls, #lassoCancel');
}

// ── Activació / desactivació ──────────────────────────────────────────────────
function _startErase(mode) {
  // Si ja hi ha un mode actiu, el parem primer
  if (lassoErasing) _stopErase();

  lassoErasing = true;
  _eraseMode   = mode;
  _rStart = _rEnd = null;
  _lPath = []; _lDrawing = false;

  measuring = false;
  document.getElementById('measureBadge').style.display = 'none';
  transformControls.detach();

  const viewer = document.getElementById('viewer');
  _eraseW = viewer.offsetWidth  || window.innerWidth;
  _eraseH = viewer.offsetHeight || window.innerHeight;

  // Canvas visual
  const lc = _eraseCanvas();
  lc.width  = _eraseW;
  lc.height = _eraseH;
  lc.style.display = 'block';

  // UI
  const badge = document.getElementById('lassoBadge');
  badge.textContent = mode === 'rect'
    ? '⬜ Rectangle erase — drag to select, release to delete'
    : '✏ Freehand erase — draw around area, release to delete';
  badge.style.display = 'block';
  document.getElementById('lassoCancel').style.display = 'block';
  document.getElementById('btnRectErase').classList.toggle('active', mode === 'rect');
  document.getElementById('btnLassoErase').classList.toggle('active', mode === 'lasso');
  viewer.classList.add('lasso-active');

  // Bloquejar canvas Three.js — els events cauen al viewer
  if (renderer) renderer.domElement.style.pointerEvents = 'none';

  // Registrar events
  viewer.addEventListener('pointerdown',   _onEraseDown,   { passive: false });
  viewer.addEventListener('pointermove',   _onEraseMove,   { passive: false });
  viewer.addEventListener('pointerup',     _onEraseUp,     { passive: false });
  viewer.addEventListener('pointercancel', _onEraseCancel, { passive: false });
  viewer.addEventListener('touchstart',    _onEraseTStart, { passive: false });
  viewer.addEventListener('touchmove',     _onEraseTMove,  { passive: false });
  viewer.addEventListener('touchend',      _onEraseTEnd,   { passive: false });
}

function _stopErase() {
  lassoErasing = false;
  _eraseMode   = null;
  _rStart = _rEnd = null;
  _lPath = []; _lDrawing = false;

  const viewer = document.getElementById('viewer');
  viewer.removeEventListener('pointerdown',   _onEraseDown);
  viewer.removeEventListener('pointermove',   _onEraseMove);
  viewer.removeEventListener('pointerup',     _onEraseUp);
  viewer.removeEventListener('pointercancel', _onEraseCancel);
  viewer.removeEventListener('touchstart',    _onEraseTStart);
  viewer.removeEventListener('touchmove',     _onEraseTMove);
  viewer.removeEventListener('touchend',      _onEraseTEnd);

  if (renderer) renderer.domElement.style.pointerEvents = 'auto';
  document.getElementById('viewer').classList.remove('lasso-active');

  const lc = _eraseCanvas();
  lc.style.display = 'none';
  _clearCanvas();
  document.getElementById('lassoBadge').style.display   = 'none';
  document.getElementById('lassoCancel').style.display  = 'none';
  document.getElementById('btnRectErase').classList.remove('active');
  document.getElementById('btnLassoErase').classList.remove('active');
}

// Mantenim l'alias que usa la resta del codi (reset, etc.)
function startLassoErase() { _startErase('rect'); }
function stopLassoErase()   { _stopErase(); }

// ── Handlers d'events ─────────────────────────────────────────────────────────
function _onEraseDown(e) {
  if (!lassoErasing || _isControlTarget(e)) return;
  e.preventDefault(); e.stopPropagation();
  const p = _vp(e.clientX, e.clientY);
  if (_eraseMode === 'rect') {
    _rStart = p; _rEnd = { ...p };
  } else {
    _lDrawing = true; _lPath = [p];
  }
}

function _onEraseMove(e) {
  if (!lassoErasing) return;
  e.preventDefault(); e.stopPropagation();
  const p = _vp(e.clientX, e.clientY);
  if (_eraseMode === 'rect' && _rStart) {
    _rEnd = p; _drawRect();
  } else if (_eraseMode === 'lasso' && _lDrawing) {
    _lPath.push(p); _drawLasso();
  }
}

function _onEraseUp(e) {
  if (!lassoErasing) return;
  e.preventDefault(); e.stopPropagation();
  const p = _vp(e.clientX, e.clientY);
  if (_eraseMode === 'rect' && _rStart) {
    _rEnd = p; _applyErase();
  } else if (_eraseMode === 'lasso' && _lDrawing) {
    _lDrawing = false; _applyErase();
  }
}

function _onEraseCancel() { if (lassoErasing) _stopErase(); }

// Touch fallbacks
function _onEraseTStart(e) {
  if (!lassoErasing || _isControlTarget(e)) return;
  e.preventDefault();
  const p = _vp(e.touches[0].clientX, e.touches[0].clientY);
  if (_eraseMode === 'rect') {
    _rStart = p; _rEnd = { ...p };
  } else {
    _lDrawing = true; _lPath = [p];
  }
}
function _onEraseTMove(e) {
  if (!lassoErasing) return;
  e.preventDefault();
  const p = _vp(e.touches[0].clientX, e.touches[0].clientY);
  if (_eraseMode === 'rect' && _rStart) {
    _rEnd = p; _drawRect();
  } else if (_eraseMode === 'lasso' && _lDrawing) {
    _lPath.push(p); _drawLasso();
  }
}
function _onEraseTEnd(e) {
  if (!lassoErasing) return;
  e.preventDefault();
  if (_eraseMode === 'rect' && _rStart)      _applyErase();
  else if (_eraseMode === 'lasso' && _lDrawing) { _lDrawing = false; _applyErase(); }
}

// ── Dibuix visual ─────────────────────────────────────────────────────────────
function _drawRect() {
  if (!_rStart || !_rEnd) return;
  const lc = _eraseCanvas(), ctx = lc.getContext('2d');
  ctx.clearRect(0, 0, lc.width, lc.height);
  const x = Math.min(_rStart.x, _rEnd.x), y = Math.min(_rStart.y, _rEnd.y);
  const w = Math.abs(_rEnd.x - _rStart.x), h = Math.abs(_rEnd.y - _rStart.y);
  ctx.fillStyle = 'rgba(255,60,60,0.15)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 2;
  ctx.setLineDash([6, 3]); ctx.strokeRect(x, y, w, h);
}

function _drawLasso() {
  if (_lPath.length < 2) return;
  const lc = _eraseCanvas(), ctx = lc.getContext('2d');
  ctx.clearRect(0, 0, lc.width, lc.height);
  ctx.beginPath();
  ctx.moveTo(_lPath[0].x, _lPath[0].y);
  for (let i = 1; i < _lPath.length; i++) ctx.lineTo(_lPath[i].x, _lPath[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,60,60,0.15)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]); ctx.stroke();
}

// ── Test de contenció ─────────────────────────────────────────────────────────
function _inRect(sx, sy) {
  const x1 = Math.min(_rStart.x, _rEnd.x), x2 = Math.max(_rStart.x, _rEnd.x);
  const y1 = Math.min(_rStart.y, _rEnd.y), y2 = Math.max(_rStart.y, _rEnd.y);
  return sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2;
}

function _inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ── Aplicar esborrat ──────────────────────────────────────────────────────────
function _applyErase() {
  // Validació mínima
  if (_eraseMode === 'rect') {
    if (!_rStart || !_rEnd) { _stopErase(); return; }
    if (Math.abs(_rEnd.x - _rStart.x) < 5 || Math.abs(_rEnd.y - _rStart.y) < 5) { _stopErase(); return; }
  } else {
    if (_lPath.length < 6) { _stopErase(); return; } // mínim ~6 punts per un traç útil
  }

  const W = _eraseW, H = _eraseH;
  const activeCam = (useOrtho && orthoCamera) ? orthoCamera : camera;
  const targets   = selectedCloud ? [selectedCloud] : clouds.filter(c => c.visible);
  if (targets.length === 0) { _stopErase(); return; }

  document.getElementById('loadingBadge').style.display = 'block';
  document.getElementById('lassoBadge').style.display   = 'none';

  // Capturem aquí perquè _stopErase() els esborra
  const mode  = _eraseMode;
  const rS = _rStart ? { ..._rStart } : null;
  const rE = _rEnd   ? { ..._rEnd }   : null;
  const lP = [..._lPath];

  _stopErase(); // tanquem el mode visualment mentre processem

  setTimeout(() => {
    const vProj = new THREE.Vector3();
    for (const cloud of targets) {
      cloud.updateMatrixWorld(true);
      const mw  = cloud.matrixWorld;
      const pos = cloud.geometry.getAttribute('position');
      const col = cloud.geometry.getAttribute('color');
      if (!pos) continue;

      const newPos = [], newCol = [];
      for (let i = 0; i < pos.count; i++) {
        vProj.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mw).project(activeCam);
        // Punt darrere la càmera → conservar sempre
        if (vProj.z > 1) {
          newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          if (col) newCol.push(col.getX(i), col.getY(i), col.getZ(i));
          continue;
        }
        const sx = (vProj.x + 1) / 2 * W;
        const sy = (1 - vProj.y) / 2 * H;
        const inside = mode === 'rect'
          ? (sx >= Math.min(rS.x,rE.x) && sx <= Math.max(rS.x,rE.x) &&
             sy >= Math.min(rS.y,rE.y) && sy <= Math.max(rS.y,rE.y))
          : _inPolygon(sx, sy, lP);
        if (inside) continue; // esborrar
        newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (col) newCol.push(col.getX(i), col.getY(i), col.getZ(i));
      }

      if (newPos.length === pos.count * 3) continue; // res eliminat

      pushUndo(cloud, true);
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
      if (newCol.length) ng.setAttribute('color', new THREE.Float32BufferAttribute(newCol, 3));
      ng.computeBoundingBox(); ng.computeBoundingSphere();
      cloud.geometry.dispose();
      cloud.geometry = ng;
      cloud.material.needsUpdate = true;
    }

    updateRaycasterThreshold();
    document.getElementById('loadingBadge').style.display = 'none';
  }, 20);
}

// Alias per a applyLassoErase (usat externament)
function applyLassoErase() { _applyErase(); }

// Escape per cancel·lar
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && lassoErasing) _stopErase();
});
// ─────────────────────────────────────────────────────────────────────────────

function applyAndKeepClip() {
  const cloud = selectedCloud || clouds.find(c => c.userData.clipBox);
  if (!cloud || !cloud.userData.clipBox) { alert(T.noBoxCreated); return; }

  const box = cloud.userData.clipBox;
  box.updateMatrixWorld(true);
  const planes = LOCAL_CLIP_PLANES.map(p => p.clone().applyMatrix4(box.matrixWorld));

  cloud.updateMatrixWorld(true);
  const mw   = cloud.matrixWorld;
  const pos  = cloud.geometry.getAttribute('position');
  const col  = cloud.geometry.getAttribute('color');
  if (!pos) return;

  const v = new THREE.Vector3();
  const newPos = [], newCol = [];

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    if (!planes.every(p => p.distanceToPoint(v) >= 0)) continue;
    newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (col) newCol.push(col.getX(i), col.getY(i), col.getZ(i));
  }

  if (newPos.length === 0) { alert('La caixa no conté cap punt.'); return; }

  // Guardem geometria anterior per poder fer undo
  pushUndo(cloud, true);

  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  if (newCol.length) newGeom.setAttribute('color', new THREE.Float32BufferAttribute(newCol, 3));
  newGeom.computeBoundingBox();
  newGeom.computeBoundingSphere();

  // Substituïm la geometria (l'antiga queda guardada a l'undo stack)
  cloud.geometry = newGeom;
  cloud.material.clippingPlanes = [];
  cloud.material.needsUpdate = true;

  // Eliminem la caixa
  removeClipBox();
  updateRaycasterThreshold();
  selectCloud(cloud);

  const kept = newPos.length / 3;
  console.log(`Crop aplicat: ${kept.toLocaleString()} punts conservats`);
}

// ─────────────────────────────────────────────
// Exportar secció de la caixa de tall com a DXF
// ─────────────────────────────────────────────
function exportClipSectionDXF() {
  const cloud = selectedCloud || clouds.find(c => c.userData.clipBox);
  if (!cloud || !cloud.userData.clipBox) { alert(T.noBoxCreated); return; }

  // Determina els eixos de projecció segons la vista actual
  const cam = useOrtho ? orthoCamera : camera;
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  let a0, a1, viewName;
  if (ay >= ax && ay >= az) { a0 = 'x'; a1 = 'z'; viewName = 'TOP'; }
  else if (az >= ax && az >= ay) { a0 = 'x'; a1 = 'y'; viewName = 'FRONT'; }
  else { a0 = 'y'; a1 = 'z'; viewName = 'SIDE'; }

  const box = cloud.userData.clipBox;
  box.updateMatrixWorld(true);
  const planes = LOCAL_CLIP_PLANES.map(p => p.clone().applyMatrix4(box.matrixWorld));

  cloud.updateMatrixWorld(true);
  const mw = cloud.matrixWorld;
  const pos = cloud.geometry.getAttribute('position');
  if (!pos) return;

  const badge = document.getElementById('loadingBadge');
  if (badge) badge.style.display = 'block';

  setTimeout(() => {
    const v = new THREE.Vector3();
    const grid = new Map();
    const RES = 0.02; // cel·la 2cm

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      if (!planes.every(p => p.distanceToPoint(v) >= 0)) continue;
      const gx = Math.round(v[a0] / RES), gy = Math.round(v[a1] / RES);
      const k = `${gx},${gy}`;
      if (!grid.has(k)) grid.set(k, [v[a0], v[a1]]);
    }

    if (grid.size === 0) {
      if (badge) badge.style.display = 'none';
      alert('Cap punt dins la caixa de tall.');
      return;
    }

    const pts = [...grid.values()].slice(0, 100000);
    // $PDMODE=3 → punts visibles com a creu; $PDSIZE negatiu = % viewport
    let dxf  = '0\nSECTION\n2\nHEADER\n';
    dxf += '9\n$ACADVER\n1\nAC1015\n';
    dxf += '9\n$PDMODE\n70\n3\n';
    dxf += '9\n$PDSIZE\n40\n-1.0\n';
    dxf += '0\nENDSEC\n';
    dxf += '0\nSECTION\n2\nENTITIES\n';
    for (const [x, y] of pts) {
      dxf += `0\nPOINT\n8\nSECCIO\n10\n${x.toFixed(4)}\n20\n${y.toFixed(4)}\n30\n0.0\n`;
    }
    dxf += '0\nENDSEC\n0\nEOF\n';

    const blob = new Blob([dxf], { type: 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `seccio_${viewName}.dxf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    if (badge) badge.style.display = 'none';
    console.log(`DXF: ${pts.length} punts (vista ${viewName})`);
  }, 20);
}

// ─────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────
function setupUI() {
  const fileInput = document.getElementById('fileInput');

  // ── Càrrega de fitxers ──
  fileInput.value = '';
  let _loading = false;

  async function handleFiles(files) {
    if (_loading || !files || files.length === 0) return;
    _loading = true;
    const badge = document.getElementById('loadingBadge');
    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        let cloud = null;
        if (badge) badge.style.display = 'block';
        try {
          if      (ext === 'ply')                cloud = await loadPLY(file);
          else if (ext === 'xyz' || ext === 'txt') cloud = await loadXYZ(file);
          else if (ext === 'obj')                cloud = await loadOBJ(file);
          else if (ext === 'glb' || ext === 'gltf') cloud = await loadGLB(file);
          else { alert(T.unsupported(ext)); continue; }
        } catch (err) {
          console.error('Error carregant núvol:', err);
          alert(T.loadError(file.name, err.message));
          continue;
        } finally {
          if (badge) badge.style.display = 'none';
        }

        adaptPointSize(cloud);
        scene.add(cloud);
        clouds.push(cloud);
        selectableObjects.push(cloud);

        selectCloud(cloud);
        onWindowResize();
        fitCameraToObject(cloud);
        updateRaycasterThreshold();
      }
    } finally {
      _loading = false;
      fileInput.value = '';
    }
  }

  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  // ── Drag & Drop al loadArea i al viewer ──
  ['loadArea', 'viewer'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });
  });

  // ── Transformació numèrica ──
  document.getElementById('toggleNumeric').onclick = () => {
    const div = document.getElementById('numericTransform');
    const visible = div.style.display === 'block';
    div.style.display = visible ? 'none' : 'block';
    if (!visible && selectedCloud) syncNumericInputs(selectedCloud);
  };

  document.getElementById('applyTransform').onclick = () => {
    const target = selectedCloud || clouds[clouds.length - 1];
    if (!target) return;
    pushUndo(target);
    target.position.set(
      parseFloat(document.getElementById('tx').value) || 0,
      parseFloat(document.getElementById('ty').value) || 0,
      parseFloat(document.getElementById('tz').value) || 0
    );
    target.rotation.set(
      degToRad(document.getElementById('rx').value),
      degToRad(document.getElementById('ry').value),
      degToRad(document.getElementById('rz').value)
    );
    target.updateMatrixWorld();
    syncClipBox(target);
    transformControls.attach(target);
  };

  // ── Caixa de tall (live, per núvol) ──
  document.getElementById('createClipBox').onclick = createClippingBoxAroundSelected;

  function setClipBoxBtnActive(mode) {
    document.getElementById('moveClipBox').classList.toggle('active', mode === 'translate');
    document.getElementById('rotateClipBox').classList.toggle('active', mode === 'rotate');
  }

  function withClipBox(mode) {
    const box = getActiveClipBox();
    if (!box) { alert(T.noBoxCreated); return; }
    transformControls.attach(box);
    transformControls.setMode(mode);
    setClipBoxBtnActive(mode);
    setMode(mode === 'translate' ? 'clipbox_translate' : 'clipbox_rotate');
  }

  function exitClipBoxMode() {
    setClipBoxBtnActive(null);
    if (selectedCloud) transformControls.attach(selectedCloud);
    else transformControls.detach();
    transformControls.setMode(cloudTCMode);
    setMode(cloudTCMode);
  }

  document.getElementById('modeTranslate').onclick = () => {
    cloudTCMode = 'translate';
    exitClipBoxMode();
    if (selectedCloud) transformControls.attach(selectedCloud);
    transformControls.setMode('translate');
    setMode('translate');
  };
  document.getElementById('modeRotate').onclick = () => {
    cloudTCMode = 'rotate';
    exitClipBoxMode();
    if (selectedCloud) transformControls.attach(selectedCloud);
    transformControls.setMode('rotate');
    setMode('rotate');
  };

  document.getElementById('moveClipBox').onclick   = () => withClipBox('translate');
  document.getElementById('rotateClipBox').onclick = () => withClipBox('rotate');
  document.getElementById('applyClipBox').onclick  = applyAndKeepClip;
  document.getElementById('removeClipBox').onclick = () => { removeClipBox(); setClipBoxBtnActive(null); };
  document.getElementById('btnUndo').onclick = doUndo;

  // ── Exportar secció DXF ──
  document.getElementById('btnExportSection').onclick = exportClipSectionDXF;

  // ── Alineació ──
  document.getElementById('align2pt').onclick = () => startAlign(2);
  document.getElementById('align3pt').onclick = () => startAlign(3);

  // ── Auto-align per color ──
  let _autoAlignPending = null;

  document.getElementById('btnAutoAlign').onclick = () => {
    if (!selectedCloud || clouds.length < 2) { alert(T.needTwoClouds); return; }
    const src = selectedCloud;
    const panel = document.getElementById('autoAlignPanel');
    const res   = document.getElementById('autoAlignResult');
    panel.style.display = 'block';
    res.textContent = 'Analitzant colors...';
    document.getElementById('btnApplyAutoAlign').style.display = 'none';

    setTimeout(() => {
      const srcF = detectLocalColorFeatures(src);
      const tgtF = clouds.filter(c => c !== src).flatMap(c => detectLocalColorFeatures(c));
      res.textContent = `${srcF.length} + ${tgtF.length} punts de color... cercant RANSAC`;

      setTimeout(() => {
        const matches = matchFeaturesRANSAC(srcF, tgtF);
        _autoAlignPending = matches.length >= 2 ? { src, matches } : null;

        if (!_autoAlignPending) {
          res.innerHTML = '<span style="color:#f88">No s\'han trobat prou coincidències.<br>'
            + '<small>Assegura\'t que els dos núvols comparteixen zones de color distintiu.</small></span>';
          return;
        }

        document.getElementById('btnApplyAutoAlign').style.display = '';
        let html = `<b>${matches.length} coincidències geomètriques:</b><br>`;
        for (const m of matches) {
          const rv = Math.round(m.src.r * 255), gv = Math.round(m.src.g * 255), bv = Math.round(m.src.b * 255);
          const d0 = m.src.centroid.distanceTo(m.tgt.centroid).toFixed(2);
          html += `<span style="display:inline-block;width:10px;height:10px;background:rgb(${rv},${gv},${bv});`
                + `border:1px solid #888;margin-right:3px;vertical-align:middle"></span>Δ${d0}m&nbsp; `;
        }
        res.innerHTML = html;
      }, 20);
    }, 20);
  };

  document.getElementById('btnApplyAutoAlign').onclick = () => {
    if (!_autoAlignPending) return;
    const { src, matches } = _autoAlignPending;
    const sp = matches.map(m => m.src.centroid.clone());
    const tp = matches.map(m => m.tgt.centroid.clone());
    pushUndo(src);
    if (matches.length >= 3) applyAlign3pt(src, sp, tp);
    else                     applyAlign2pt(src, sp, tp);
    document.getElementById('autoAlignPanel').style.display = 'none';
    _autoAlignPending = null;
  };

  document.getElementById('btnCancelAutoAlign').onclick = () => {
    document.getElementById('autoAlignPanel').style.display = 'none';
    _autoAlignPending = null;
  };

  document.getElementById('btnICP').onclick = () => { applyICP(); };

  // ── DXF import ──
  document.getElementById('dxfInput').onchange = (e) => {
    for (const file of e.target.files) {
      const reader = new FileReader();
      reader.onload = ev => loadDXFFile(ev.target.result, file.name);
      reader.readAsText(file, 'utf-8');
    }
    e.target.value = '';
  };

  // ── Noise filter ──
  const sigmaNoise = document.getElementById('noiseSigma');
  const sigmaVal   = document.getElementById('noiseSigmaVal');
  if (sigmaNoise) sigmaNoise.oninput = () => { sigmaVal.textContent = (+sigmaNoise.value).toFixed(1); };

  // btnNoiseFilter only exists in v1 (v2 shows panel directly in accordion)
  const _btnNF = document.getElementById('btnNoiseFilter');
  if (_btnNF) {
    _btnNF.onclick = () => {
      const panel = document.getElementById('noiseFilterPanel');
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
  }

  document.getElementById('btnApplyNoise').onclick = async () => {
    const target = selectedCloud ? [selectedCloud] : clouds.filter(c => c.visible);
    if (!target.length) { alert(T.noClouds); return; }
    const K      = parseInt(document.getElementById('noiseK').value) || 10;
    const sigma  = parseFloat(document.getElementById('noiseSigma').value) || 2.0;
    const badge  = document.getElementById('loadingBadge');
    badge.style.display = 'block';
    badge.textContent   = '⏳ Noise filter…';
    let totalRemoved = 0;
    for (const cloud of target) {
      totalRemoved += await removeNoiseFromCloud(cloud, K, sigma);
    }
    badge.style.display = 'none';
    badge.textContent   = '⏳ Loading file...';
    alert(`Noise filter done.\n${totalRemoved.toLocaleString()} points removed.`);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (alignMode) cancelAlign();
      if (measuring) {
        measuring = false;
        clearCurrentMeasure();
        updateMeasureList();
        const badge = document.getElementById('measureBadge');
        if (badge) badge.style.display = 'none';
        setMode(cloudTCMode);
      }
    }
  });

  // ── Annotate / Draw ──
  document.getElementById('btnAnnotate').onclick = () => {
    if (_annActive) { stopAnnotate(); return; }
    if (lassoErasing) _stopErase();
    startAnnotate();
  };

  // Selecció de color
  document.querySelectorAll('.ann-color').forEach(el => {
    el.onclick = () => {
      document.querySelectorAll('.ann-color').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      _annColor = el.dataset.color;
    };
  });

  // Modes
  ['Free','Line','Arrow'].forEach(m => {
    const btn = document.getElementById('annMode' + m);
    if (btn) btn.onclick = () => {
      _annMode = m.toLowerCase();
      ['Free','Line','Arrow'].forEach(x =>
        document.getElementById('annMode'+x)?.classList.toggle('active', x===m));
    };
  });

  // Amplada del traç
  const annWidthEl = document.getElementById('annWidth');
  if (annWidthEl) annWidthEl.oninput = () => { _annWidth = +annWidthEl.value; };

  // Undo últim traç
  document.getElementById('annUndo').onclick = () => {
    if (_annStrokes.length) { _annStrokes.pop(); _annRedraw(); }
  };

  // Esborra tot
  document.getElementById('annClear').onclick = () => {
    _annStrokes = []; _annRedraw();
  };

  // Redimensiona el canvas d'anotació quan la finestra canvia de mida
  window.addEventListener('resize', () => { if (_annStrokes.length) _annResize(); });

  // ── Erase tools ──
  document.getElementById('btnRectErase').onclick = () => {
    if (lassoErasing && _eraseMode === 'rect') { _stopErase(); return; }
    cancelAlign();
    _startErase('rect');
  };
  document.getElementById('btnLassoErase').onclick = () => {
    if (lassoErasing && _eraseMode === 'lasso') { _stopErase(); return; }
    cancelAlign();
    _startErase('lasso');
  };
  document.getElementById('lassoCancel').onclick = _stopErase;

  // ── Mode mesura ──
  document.getElementById('toggleMeasure').onclick = () => {
    cancelAlign();
    measuring = !measuring;
    if (measuring) {
      transformControls.detach();
      setMode('measure');
    } else {
      setMode(cloudTCMode);
    }
    clearCurrentMeasure();
    updateMeasureList();
    const badge = document.getElementById('measureBadge');
    if (badge) badge.style.display = measuring ? 'block' : 'none';
    if (measuring) updateRaycasterThreshold();
  };

  document.getElementById('clearMeasures').onclick = () => {
    clearAllMeasurements();
    updateMeasureList();
  };

  // ── Merge / descàrrega ──
  document.getElementById('merge').onclick = () => {
    if (clouds.length === 0) { alert(T.noClouds); return; }
    const pts = mergeCloudsToXYZPoints(clouds);
    downloadXYZ(pts);
  };

  document.getElementById('btnReset').onclick = resetAll;

  // ── Vistes A (ortogràfiques) ──
  function orthoBtn(id, dir, up) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.onclick = () => {
      setOrthoView(dir, up);
      btn.classList.add('ortho-active');
    };
  }
  const btn3d = document.getElementById('viewA_3d');
  if (btn3d) btn3d.onclick = () => {
    activate3DView();
    btn3d.classList.add('ortho-active');
  };
  orthoBtn('viewA_top',   new THREE.Vector3( 0, 1, 0), new THREE.Vector3(0, 0,-1));
  orthoBtn('viewA_front', new THREE.Vector3( 0, 0, 1), new THREE.Vector3(0, 1, 0));
  orthoBtn('viewA_back',  new THREE.Vector3( 0, 0,-1), new THREE.Vector3(0, 1, 0));
  orthoBtn('viewA_right', new THREE.Vector3( 1, 0, 0), new THREE.Vector3(0, 1, 0));
  orthoBtn('viewA_left',  new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0));

  // ── Traçat 2D → DXF ──
  ['traceWall','traceDoor','traceWindow'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.onclick = () => {
      document.querySelectorAll('.trace-btn').forEach(b => b.classList.remove('trace-active'));
      btn.classList.add('trace-active');
      const layerMap = { traceWall:'PARETS', traceDoor:'PORTES', traceWindow:'FINESTRES' };
      setTraceLayer(layerMap[id]);
    };
  });
  const _btnTraceToggle = document.getElementById('traceToggle');
  if (_btnTraceToggle) _btnTraceToggle.onclick = toggleTracing;
  const _btnTraceUndo = document.getElementById('traceUndoPt');
  if (_btnTraceUndo) _btnTraceUndo.onclick = traceUndoPoint;
  const _btnTraceClear = document.getElementById('traceClearAll');
  if (_btnTraceClear) _btnTraceClear.onclick = traceClearAll;
  const _btnTraceExport = document.getElementById('traceExportDXF');
  if (_btnTraceExport) _btnTraceExport.onclick = traceExportDXF;
}

// ─────────────────────────────────────────────
// Selecció i gestió de núvols
// ─────────────────────────────────────────────
function selectCloud(cloud) {
  selectedCloud = cloud;
  if (cloud) transformControls.attach(cloud);
  else       transformControls.detach();
  updateCloudList();
  syncNumericInputs(cloud);
}

function deleteCloud(cloud) {
  const idx = clouds.indexOf(cloud);
  if (idx < 0) return;

  if (cloud.userData.clipBox) {
    const box = cloud.userData.clipBox;
    scene.remove(box);
    box.geometry.dispose(); box.material.dispose();
    const bi = selectableObjects.indexOf(box);
    if (bi >= 0) selectableObjects.splice(bi, 1);
  }

  scene.remove(cloud);
  cloud.geometry.dispose();
  cloud.material.dispose();
  clouds.splice(idx, 1);

  const si = selectableObjects.indexOf(cloud);
  if (si >= 0) selectableObjects.splice(si, 1);

  undoStack.splice(0, undoStack.length, ...undoStack.filter(s => s.cloud !== cloud));
  updateUndoBtn();

  if (alignSrcCloud === cloud) cancelAlign();

  if (clouds.length === 0 && measuring) {
    measuring = false;
    const badge = document.getElementById('measureBadge');
    if (badge) badge.style.display = 'none';
    clearCurrentMeasure();
    updateMeasureList();
    setMode('none');
  }

  if (selectedCloud === cloud) {
    selectCloud(clouds.length > 0 ? clouds[clouds.length - 1] : null);
  }
  updateCloudList();
}

function updateCloudList() {
  const panel = document.getElementById('cloudListPanel');
  if (!panel) return;
  panel.innerHTML = '';

  clouds.forEach((cloud) => {
    const item = document.createElement('div');
    item.className = 'cloud-item' + (cloud === selectedCloud ? ' selected' : '');

    const name = document.createElement('span');
    name.className = 'cloud-name';
    const posCount = cloud.geometry.getAttribute('position')?.count ?? 0;
    name.textContent = cloud.name || 'Núvol';
    name.title = `${cloud.name} — ${posCount.toLocaleString()} punts`;

    const pts = document.createElement('span');
    pts.className = 'cloud-pts';
    pts.textContent = posCount.toLocaleString() + ' pts';

    const eye = document.createElement('span');
    eye.className = 'cloud-eye';
    eye.textContent = cloud.visible ? '👁' : '◌';
    eye.title = cloud.visible ? 'Ocultar' : 'Mostrar';
    eye.onclick = (e) => { e.stopPropagation(); cloud.visible = !cloud.visible; updateCloudList(); };

    const del = document.createElement('span');
    del.className = 'cloud-del';
    del.textContent = '✕';
    del.title = 'Eliminar';
    del.onclick = (e) => { e.stopPropagation(); deleteCloud(cloud); };

    item.appendChild(name);
    item.appendChild(pts);
    item.appendChild(eye);
    item.appendChild(del);
    item.onclick = () => selectCloud(cloud);
    panel.appendChild(item);
  });

  updateStatsPanel();
  updateWelcomeScreen();
}

function updateStatsPanel() {
  const panel = document.getElementById('statsPanel');
  const branding = document.getElementById('branding');
  if (!panel) return;

  if (clouds.length === 0) {
    panel.style.display = 'none';
    if (branding) branding.style.display = 'block';
    return;
  }

  panel.style.display = 'block';
  if (branding) branding.style.display = 'none';

  // Total points
  const totalPts = clouds.reduce((s, c) => s + (c.geometry.getAttribute('position')?.count ?? 0), 0);
  const ptsEl = document.getElementById('statsTotalPts');
  if (ptsEl) ptsEl.textContent = totalPts.toLocaleString() + ' pts';

  // Combined bounding box
  const bb = new THREE.Box3();
  clouds.forEach(c => { if (c.visible) bb.expandByObject(c); });
  if (!bb.isEmpty()) {
    const size = new THREE.Vector3();
    bb.getSize(size);
    const fmt = v => v.toFixed(3) + ' m';
    const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = fmt(v); };
    el('statsDimX', size.x);
    el('statsDimY', size.y);
    el('statsDimZ', size.z);
  }
}

function updateWelcomeScreen() {
  const ws = document.getElementById('welcomeScreen');
  if (!ws) return;
  ws.style.display = clouds.length === 0 ? 'flex' : 'none';
}

function syncNumericInputs(cloud) {
  if (!cloud) return;
  const p = cloud.position;
  const r = cloud.rotation;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v.toFixed(4); };
  set('tx', p.x); set('ty', p.y); set('tz', p.z);
  set('rx', THREE.MathUtils.radToDeg(r.x));
  set('ry', THREE.MathUtils.radToDeg(r.y));
  set('rz', THREE.MathUtils.radToDeg(r.z));
}

// ─────────────────────────────────────────────
// Pointer / raycaster
// ─────────────────────────────────────────────
function onPointerDown(event) {
  const ctrl = document.getElementById('controls');
  if (ctrl && (event.target === ctrl || ctrl.contains(event.target))) return;
  if (event.button !== 0) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ny = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  mouse.set(nx, ny);

  const activeCam = useOrtho ? orthoCamera : camera;

  // ── Mode alineació ──
  if (alignMode) {
    raycaster.setFromCamera(mouse, activeCam);
    const hits = raycaster.intersectObjects(clouds, false);
    if (hits.length === 0) return;
    const hit = hits[0];
    let pWorld;
    if (hit.index != null && hit.object.geometry?.attributes?.position) {
      pWorld = new THREE.Vector3()
        .fromBufferAttribute(hit.object.geometry.attributes.position, hit.index)
        .applyMatrix4(hit.object.matrixWorld);
    } else {
      pWorld = hit.point.clone();
    }
    handleAlignClick(pWorld, hit.object);
    return;
  }

  // ── Mode mesura ──
  if (measuring) {
    raycaster.setFromCamera(mouse, activeCam);
    const hits = raycaster.intersectObjects(clouds, false);
    if (hits.length === 0) return;
    const hit = hits[0];
    let pWorld;
    if (hit.index != null && hit.object.geometry?.attributes?.position) {
      pWorld = new THREE.Vector3()
        .fromBufferAttribute(hit.object.geometry.attributes.position, hit.index)
        .applyMatrix4(hit.object.matrixWorld);
    } else {
      pWorld = hit.point.clone();
    }
    handleMeasureClick(pWorld);
    return;
  }

  // ── Mode caixa de tall activa: clic fora de la caixa torna al núvol ──
  if (appMode === 'clipbox_translate' || appMode === 'clipbox_rotate') {
    raycaster.setFromCamera(mouse, activeCam);
    const box = getActiveClipBox();
    if (box) {
      const hitsBox = raycaster.intersectObject(box, false);
      if (hitsBox.length === 0) {
        // Clic fora de la caixa → torna al mode núvol
        transformControls.attach(selectedCloud);
        transformControls.setMode(cloudTCMode);
        setMode(cloudTCMode);
        document.getElementById('moveClipBox')?.classList.remove('active');
        document.getElementById('rotateClipBox')?.classList.remove('active');
      }
    }
    return;
  }

  // ── Selecció normal ──
  if (transformControls.dragging) return;
  if (transformControls.object && transformControls.object.userData.parentCloud) return;

  raycaster.setFromCamera(mouse, activeCam);
  const hits = raycaster.intersectObjects(selectableObjects, false);
  if (!hits.length) { selectCloud(null); return; }

  for (const h of hits) {
    const boxCloud = clouds.find(c => c.userData.clipBox === h.object);
    if (boxCloud) { selectCloud(boxCloud); return; }
    if (clouds.includes(h.object)) { selectCloud(h.object); return; }
  }
}

// ─────────────────────────────────────────────
// Mesures
// ─────────────────────────────────────────────
function handleMeasureClick(pWorld) {
  const markerR = getCloudMarkerSize();

  const sphereGeom = new THREE.SphereGeometry(markerR, 8, 8);
  const sphereMat  = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  const marker     = new THREE.Mesh(sphereGeom, sphereMat);
  marker.position.copy(pWorld);
  scene.add(marker);
  currentMeasureMarkers.push(marker);
  currentMeasurePoints.push(pWorld.clone());

  if (currentMeasurePoints.length === 2) {
    const p1 = currentMeasurePoints[0];
    const p2 = currentMeasurePoints[1];
    const dist = p1.distanceTo(p2);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;

    const lineGeom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const lineMat  = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
    const line     = new THREE.Line(lineGeom, lineMat);
    scene.add(line);

    const mid    = p1.clone().add(p2).multiplyScalar(0.5);
    const label  = createLabelSprite(`${dist.toFixed(3)} m`, markerR);
    label.position.copy(mid);
    scene.add(label);

    measurements.push({ p1, p2, dx, dy, dz, dist, line, markers: [...currentMeasureMarkers], label });

    currentMeasurePoints  = [];
    currentMeasureMarkers = [];
    updateMeasureList();
  }
}

function clearCurrentMeasure() {
  for (const m of currentMeasureMarkers) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  currentMeasureMarkers = [];
  currentMeasurePoints  = [];
}

function clearAllMeasurements() {
  for (const m of measurements) {
    if (m.line)  { scene.remove(m.line);  m.line.geometry.dispose();  m.line.material.dispose(); }
    if (m.label) { scene.remove(m.label); m.label.material.map?.dispose(); m.label.material.dispose(); }
    for (const mk of m.markers ?? []) { scene.remove(mk); mk.geometry.dispose(); mk.material.dispose(); }
  }
  measurements = [];
  clearCurrentMeasure();
}

function updateMeasureList() {
  const div = document.getElementById('measureList');
  if (!div) return;

  if (!measuring && measurements.length === 0) {
    div.style.display = 'none';
    div.textContent = '';
    return;
  }

  div.style.display = 'block';
  let txt = measuring ? 'MODE MESURA ACTIU\n' : 'Mides guardades:\n';

  if (measurements.length === 0) {
    txt += '(cap mida)';
  } else {
    measurements.forEach((m, i) => {
      txt += `#${i + 1}: ${m.dist.toFixed(3)} m  `
           + `ΔX=${m.dx.toFixed(3)}  ΔY=${m.dy.toFixed(3)}  ΔZ=${m.dz.toFixed(3)}\n`;
    });
  }
  div.textContent = txt;
}

function createLabelSprite(text, markerR = 0.05) {
  const fontSize = 64;
  const pad = 10;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  ctx.font = `bold ${fontSize}px sans-serif`;
  const tw = ctx.measureText(text).width;
  canvas.width  = tw + pad * 2;
  canvas.height = fontSize + pad * 2;

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);

  const tex  = new THREE.CanvasTexture(canvas);
  const mat  = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
  const spr  = new THREE.Sprite(mat);

  const scale = markerR * 5;
  spr.scale.set((canvas.width / canvas.height) * scale, scale, 1);
  return spr;
}

// ─────────────────────────────────────────────
// Helpers geomètrics
// ─────────────────────────────────────────────
function degToRad(v) { return (parseFloat(v) || 0) * Math.PI / 180; }

function getCloudBounds(cloud) {
  if (!cloud) return { center: new THREE.Vector3(), maxDim: 1 };
  const box  = new THREE.Box3().setFromObject(cloud);
  const size = box.getSize(new THREE.Vector3());
  return { center: box.getCenter(new THREE.Vector3()), maxDim: Math.max(size.x, size.y, size.z) || 1 };
}

function getCloudMarkerSize() {
  const obj = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  const { maxDim } = getCloudBounds(obj);
  return maxDim * 0.004;
}

function updateRaycasterThreshold() {
  const obj = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  const { maxDim } = getCloudBounds(obj);
  raycaster.params.Points = { threshold: maxDim * 0.004 };
}

function fitCameraToObject(object, offset = 1.8) {
  const box    = new THREE.Box3().setFromObject(object);
  const size   = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSz  = Math.max(size.x, size.y, size.z) || 1;

  const fitH   = maxSz / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const fitW   = fitH / camera.aspect;
  const dist   = Math.max(fitH, fitW) * offset;

  camera.position.copy(center).addScalar(dist * 0.6);
  camera.position.y += dist * 0.4;
  camera.near = dist / 100;
  camera.far  = dist * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

// ─────────────────────────────────────────────
// Caixa de tall
// ─────────────────────────────────────────────
function createClippingBoxAroundSelected() {
  const cloud = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  if (!cloud) { alert(T.noCloudLoaded); return; }

  if (cloud.userData.clipBox) removeClipBox();

  cloud.updateMatrixWorld(true);
  const worldBounds = new THREE.Box3().setFromObject(cloud);
  const size   = worldBounds.getSize(new THREE.Vector3());
  const center = worldBounds.getCenter(new THREE.Vector3());
  size.x = Math.max(size.x, 0.001);
  size.y = Math.max(size.y, 0.001);
  size.z = Math.max(size.z, 0.001);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffcc00, wireframe: true, transparent: true, opacity: 0.35 })
  );
  box.position.copy(center);
  box.scale.copy(size);

  scene.add(box);
  box.userData.parentCloud = cloud;
  cloud.userData.clipBox = box;

  box.updateMatrixWorld(true);
  cloud.userData.boxRelMatrix = new THREE.Matrix4()
    .copy(cloud.matrixWorld).invert()
    .multiply(box.matrixWorld);

  selectableObjects.push(box);

  transformControls.attach(cloud);
  transformControls.setMode('translate');
}

// ─────────────────────────────────────────────
// Merge i descàrrega
// ─────────────────────────────────────────────
function mergeCloudsToXYZPoints(cloudList) {
  const result = [];
  const v = new THREE.Vector3();

  for (const cloud of cloudList) {
    if (!cloud?.geometry) continue;
    const pos = cloud.geometry.getAttribute('position');
    const col = cloud.geometry.getAttribute('color');
    if (!pos) continue;

    cloud.updateWorldMatrix(true, false);
    const mw = cloud.matrixWorld;

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      const pt = { x: v.x, y: v.y, z: v.z };
      if (col) {
        pt.r = col.getX(i) * 255;
        pt.g = col.getY(i) * 255;
        pt.b = col.getZ(i) * 255;
      }
      result.push(pt);
    }
  }
  return result;
}

function downloadXYZ(points) {
  const lines = points.map(p =>
    p.r !== undefined
      ? `${p.x} ${p.y} ${p.z} ${Math.round(p.r)} ${Math.round(p.g)} ${Math.round(p.b)}`
      : `${p.x} ${p.y} ${p.z}`
  );
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'merged.xyz';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─────────────────────────────────────────────
// Roda (zoom)
// ─────────────────────────────────────────────
function onMouseWheel(event) {
  event.preventDefault();

  if (useOrtho) {
    const factor = event.deltaY > 0 ? 1.1 : 0.9;
    orthoCamera.left   *= factor; orthoCamera.right *= factor;
    orthoCamera.top    *= factor; orthoCamera.bottom *= factor;
    orthoCamera.updateProjectionMatrix();
    return;
  }

  const factor = event.deltaY > 0 ? 1.1 : 0.9;
  const target = controls.target.clone();
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  offset.multiplyScalar(factor);
  camera.position.copy(target).add(offset);
  camera.updateProjectionMatrix();
  controls.update();
}

// ─────────────────────────────────────────────
// Edició semàntica per visió IA
// ─────────────────────────────────────────────

function _captureSceneImage() {
  // Renderitza la vista de planta i retorna base64 JPEG
  const cam = (useOrtho && orthoCamera) ? orthoCamera : camera;
  renderer.render(scene, cam);
  return renderer.domElement.toDataURL('image/jpeg', 0.85).split(',')[1];
}

function _cloudWorldBBox() {
  const box = new THREE.Box3();
  const targets = clouds.length > 0 ? clouds : [];
  targets.forEach(c => box.expandByObject(c));
  return box.isEmpty() ? null : box;
}

// Detecta alçada del terra (5è percentil de Y excloent la bbox donada)
function _detectFloorY(cloud, excludeBBoxes) {
  const pos = cloud.geometry.getAttribute('position');
  const ys = [];
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), pz = pos.getZ(i);
    let inBbox = false;
    for (const b of excludeBBoxes) {
      if (px >= b.wx1 && px <= b.wx2 && pz >= b.wz1 && pz <= b.wz2) { inBbox = true; break; }
    }
    if (!inBbox) ys.push(pos.getY(i));
  }
  if (ys.length === 0) return 0;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.05)];
}

function _applySemanticOp(cloud, operacio, worldObjs, colorHex) {
  const pos = cloud.geometry.getAttribute('position');
  const col = cloud.geometry.getAttribute('color');
  const n   = pos.count;

  // Màscara de punts afectats
  const affected = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i), pz = pos.getZ(i);
    for (const obj of worldObjs) {
      if (px >= obj.wx1 && px <= obj.wx2 && pz >= obj.wz1 && pz <= obj.wz2) {
        affected[i] = 1; count++; break;
      }
    }
  }
  if (count === 0) return 0;

  if (operacio === 'seleccionar' || operacio === 'canviar_color') {
    // Pinta en taronja (seleccionar) o en el color indicat
    let r = 1.0, g = 0.5, b = 0.0;
    if (operacio === 'canviar_color' && colorHex) {
      r = parseInt(colorHex.slice(1,3),16)/255;
      g = parseInt(colorHex.slice(3,5),16)/255;
      b = parseInt(colorHex.slice(5,7),16)/255;
    }
    const arr = col ? col.array.slice() : new Float32Array(n * 3).fill(0.7);
    for (let i = 0; i < n; i++) {
      if (affected[i]) { arr[i*3]=r; arr[i*3+1]=g; arr[i*3+2]=b; }
    }
    cloud.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    cloud.material.vertexColors = true;
    cloud.material.needsUpdate = true;

  } else if (operacio === 'eliminar' || operacio === 'substituir_terra') {
    const floorY = operacio === 'substituir_terra'
      ? _detectFloorY(cloud, worldObjs) : 0;

    // Punt d'espaiat per la substitució de terra (~densitat original)
    const spacing = Math.sqrt(
      (worldObjs.reduce((s,b)=>(s+(b.wx2-b.wx1)*(b.wz2-b.wz1)),0)) / Math.max(count,1)
    ) * 0.3 || 0.05;

    const nX=[], nY=[], nZ=[], nR=[], nG=[], nB=[];
    const hasCol = !!col;

    for (let i = 0; i < n; i++) {
      if (!affected[i]) {
        nX.push(pos.getX(i)); nY.push(pos.getY(i)); nZ.push(pos.getZ(i));
        if (hasCol) { nR.push(col.getX(i)); nG.push(col.getY(i)); nB.push(col.getZ(i)); }
        else { nR.push(0.7); nG.push(0.7); nB.push(0.7); }
      }
    }

    if (operacio === 'substituir_terra') {
      for (const b of worldObjs) {
        for (let px = b.wx1; px <= b.wx2; px += spacing) {
          for (let pz = b.wz1; pz <= b.wz2; pz += spacing) {
            nX.push(px); nY.push(floorY); nZ.push(pz);
            nR.push(0.55); nG.push(0.55); nB.push(0.55);
          }
        }
      }
    }

    const newPos = new Float32Array(nX.length * 3);
    const newCol = new Float32Array(nX.length * 3);
    for (let i = 0; i < nX.length; i++) {
      newPos[i*3]=nX[i]; newPos[i*3+1]=nY[i]; newPos[i*3+2]=nZ[i];
      newCol[i*3]=nR[i]; newCol[i*3+1]=nG[i]; newCol[i*3+2]=nB[i];
    }
    cloud.geometry.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    cloud.geometry.setAttribute('color',    new THREE.BufferAttribute(newCol, 3));
    cloud.material.vertexColors = true;
    cloud.material.needsUpdate  = true;
    cloud.geometry.computeBoundingBox();
    cloud.geometry.computeBoundingSphere();
  }

  return count;
}

async function _semanticVisionEdit(query, operacio, colorHex) {
  const apiKey = localStorage.getItem('ai_api_key');
  if (!apiKey) return 'Cal una clau API per a les ordres semàntiques.';
  if (clouds.length === 0) return 'Primer carrega un núvol de punts.';

  // Assegura vista de planta
  if (!useOrtho) setOrthoView(new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,-1));

  _cmdLog('📷 Capturant vista de planta…', 'cmd-sys');
  const img64 = _captureSceneImage();
  const bbox  = _cloudWorldBBox();
  if (!bbox) return 'No s\'ha pogut calcular els límits del núvol.';

  const sysPrompt = `Ets un expert en interpretació visual de núvols de punts 3D (vista de planta).
Analitza la imatge i localitza els objectes demanats.
Retorna ÚNICAMENT un JSON vàlid, sense text addicional:
{
  "objectes": [
    {"tipus": "nom_objecte", "bbox_norm": {"x1":0.0,"z1":0.0,"x2":1.0,"z2":1.0}}
  ],
  "resposta": "text breu explicatiu"
}
Les coordenades bbox_norm van de 0.0 (esquerra/dalt) a 1.0 (dreta/baix) en la imatge.
Si no trobes els objectes, retorna objectes=[].`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: sysPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img64 } },
          { type: 'text',  text: `Identifica i retorna la posició de: ${query}` }
        ]
      }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(()=>({}));
    return 'Error API Vision: ' + (err.error?.message || resp.statusText);
  }

  const data = await resp.json();
  const raw  = data.content?.[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return 'La IA no ha retornat un format vàlid.';

  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch { return 'Error parsejant la resposta de la IA.'; }

  if (!parsed.objectes || parsed.objectes.length === 0)
    return `No s'han trobat objectes del tipus "${query}" a la vista actual.`;

  // Converteix coordenades normalitzades → coordenades món
  const rangeX = bbox.max.x - bbox.min.x;
  const rangeZ = bbox.max.z - bbox.min.z;
  const worldObjs = parsed.objectes.map(o => ({
    tipus: o.tipus,
    wx1: bbox.min.x + o.bbox_norm.x1 * rangeX,
    wx2: bbox.min.x + o.bbox_norm.x2 * rangeX,
    wz1: bbox.min.z + o.bbox_norm.z1 * rangeZ,
    wz2: bbox.min.z + o.bbox_norm.z2 * rangeZ,
  }));

  _cmdLog(`🔍 ${parsed.resposta || parsed.objectes.length + ' objecte(s) trobat(s)'}`, 'cmd-x');

  const targetClouds = selectedCloud ? [selectedCloud] : clouds;
  let total = 0;
  for (const cloud of targetClouds) {
    total += _applySemanticOp(cloud, operacio, worldObjs, colorHex);
  }

  const opLabel = { seleccionar:'seleccionats (taronja)', eliminar:'eliminats', substituir_terra:'substituïts pel terra', canviar_color:'repintats' };
  return `✓ ${total.toLocaleString()} punts ${opLabel[operacio] || operacio} en ${parsed.objectes.length} zona(es).`;
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// AI Assistant — Claude API integration
// ─────────────────────────────────────────────

const AI_TOOLS = [
  {
    name: 'change_view',
    description: 'Change the 3D viewer camera to a preset view. Use for: "vista de dalt/planta/top/desde arriba", "vista frontal/de davant/de front", "vista 3D/perspectiva", "vista lateral dreta/droit", "vista lateral esquerra/izquierda", "vista posterior/darrere/atrás".',
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['3d','top','front','back','right','left'],
                description: '3d=perspective view, top=plan view from above, front=front elevation, back=rear elevation, right=right side elevation, left=left side elevation' }
      },
      required: ['view']
    }
  },
  {
    name: 'set_transform_mode',
    description: 'Activate move or rotate mode for the selected cloud. Use for: "mou el núvol/mueve la nube/move cloud", "activa el moviment/activa traslació", "rota el núvol/gira la nube/rotate".',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['translate','rotate'], description: 'translate=move/moure, rotate=girar/rotar' }
      },
      required: ['mode']
    }
  },
  {
    name: 'apply_noise_filter',
    description: 'Remove outlier / noise points from the cloud. Use for: "elimina el soroll/elimina ruido/remove noise", "neteja el núvol/limpia la nube", "filtre estadístic/filtro estadístico", "esborra punts aïllats/puntos aislados".',
    input_schema: {
      type: 'object',
      properties: {
        sigma: { type: 'number', description: 'Aggressiveness: 1.5=molt agressiu, 2.0=normal (default), 3.0=conservador' },
        k: { type: 'number', description: 'Number of nearest neighbours to consider (default 10)' }
      }
    }
  },
  {
    name: 'apply_icp_alignment',
    description: 'Fine-tune alignment between two clouds using ICP algorithm. Use for: "alineació fina/ICP/ajusta l\'alineació/afina alineació/alinea con precisión". Note: requires approximate manual alignment first.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'create_clipping_box',
    description: 'Create a clipping/crop box around the cloud. Use for: "crea una caixa de tall/crea caja de corte/clipping box/crea una caixa per retallar".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'apply_clip_permanent',
    description: 'Apply the clipping box permanently, deleting points outside it. Use for: "aplica el tall/aplica el corte/retalla/crop/aplica la caixa de tall".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'remove_clipping_box',
    description: 'Remove the clipping box without applying the crop. Use for: "elimina la caixa/elimina el recuadro/treu la caixa de tall".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'start_erase_tool',
    description: 'Activate the erase tool to delete points by drawing a shape. Use for: "esborra punts/borra puntos/erase points", "eina d\'esborrat/herramienta de borrado", "esborra amb rectangle/esborra lliure".',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rect','lasso'],
                description: 'rect=rectangle selection (default), lasso=freehand drawing' }
      },
      required: ['mode']
    }
  },
  {
    name: 'toggle_annotation',
    description: 'Enable or disable the drawing/annotation overlay. Use for: "dibuixa/dibuja/draw", "activa anotació/activa dibuix", "marca sobre la vista/marca sobre el núvol".',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start','stop'] }
      },
      required: ['action']
    }
  },
  {
    name: 'undo_last_action',
    description: 'Undo the last operation. Use for: "desfés/deshacer/undo/ctrl+z".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'merge_and_download',
    description: 'Merge all clouds into one and download as XYZ file. Use for: "fusiona/merge/uneix els núvols/descàrrega el resultat/exporta XYZ".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'export_section_dxf',
    description: 'Export the current section/clip as a DXF CAD file. Use for: "exporta DXF/exporta la secció/secció en DXF/exporta el tall".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_app_state',
    description: 'Report the current state: clouds loaded, selected cloud, number of points. Use for: "quins núvols hi ha?/quants punts?/estat de l\'app/qué hay cargado?".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'semantic_vision_edit',
    description: 'Use Claude Vision to identify objects visually in the point cloud and edit them. Use for any command that refers to real-world objects by name: "selecciona els llits", "elimina el mobiliari", "substitueix les cadires pel terra", "identifica les taules", "marca les columnes de vermell", "elimina la vegetació". This tool captures the current view as an image and asks Vision AI to locate the objects.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'What to find visually in the cloud (e.g. "llits", "cadires i taules", "vegetació")' },
        operacio: { type: 'string', enum: ['seleccionar','eliminar','substituir_terra','canviar_color'], description: 'seleccionar=highlight orange, eliminar=delete points, substituir_terra=replace with floor level, canviar_color=paint a color' },
        color:   { type: 'string', description: 'Hex color like #ff0000, only needed for canviar_color' }
      },
      required: ['query', 'operacio']
    }
  }
];

function _aiGetState() {
  return {
    clouds: clouds.map((c, i) => ({
      id: i,
      name: c.name || `cloud_${i}`,
      points: c.geometry.getAttribute('position').count,
      selected: c === selectedCloud,
      visible: c.visible
    })),
    selectedCloud: selectedCloud ? clouds.indexOf(selectedCloud) : -1,
    totalClouds: clouds.length,
    currentMode: appMode,
    hasClipBox: !!document.querySelector('.clip-box-mesh') || clouds.some(c => c.userData && c.userData.clipBox)
  };
}

async function _executeAITool(name, input) {
  switch (name) {
    case 'change_view': {
      const btn = document.getElementById('viewA_' + input.view);
      if (btn) btn.click();
      return `Vista canviada a: ${input.view}`;
    }
    case 'set_transform_mode': {
      const btn = document.getElementById(input.mode === 'translate' ? 'modeTranslate' : 'modeRotate');
      if (btn) btn.click();
      return `Mode ${input.mode === 'translate' ? 'moviment' : 'rotació'} activat.`;
    }
    case 'apply_noise_filter': {
      const cloud = selectedCloud || clouds[0];
      if (!cloud) return 'No hi ha núvols carregats.';
      const sigma = input.sigma || 2.0;
      const k = input.k || 10;
      await removeNoiseFromCloud(cloud, k, sigma);
      return `Filtre de soroll aplicat (σ=${sigma}, K=${k}).`;
    }
    case 'apply_icp_alignment': {
      if (clouds.length < 2) return 'Cal tenir almenys 2 núvols per ICP.';
      await applyICP();
      return 'Alineació ICP completada.';
    }
    case 'create_clipping_box': {
      document.getElementById('createClipBox')?.click();
      return 'Caixa de tall creada.';
    }
    case 'apply_clip_permanent': {
      applyAndKeepClip();
      return 'Tall aplicat permanentment.';
    }
    case 'remove_clipping_box': {
      document.getElementById('removeClipBox')?.click();
      return 'Caixa de tall eliminada.';
    }
    case 'start_erase_tool': {
      _startErase(input.mode || 'rect');
      return `Eina d'esborrat (${input.mode}) activada. Dibuixa sobre la vista per esborrar punts.`;
    }
    case 'toggle_annotation': {
      if (input.action === 'start') {
        if (!_annActive) document.getElementById('btnAnnotate')?.click();
        return 'Mode de dibuix activat.';
      } else {
        if (_annActive) stopAnnotate();
        return 'Mode de dibuix desactivat.';
      }
    }
    case 'undo_last_action': {
      doUndo();
      return 'Acció desfeta.';
    }
    case 'merge_and_download': {
      document.getElementById('merge')?.click();
      return 'Fusió iniciada — es descarregarà el fitxer XYZ.';
    }
    case 'export_section_dxf': {
      exportClipSectionDXF();
      return 'Exportació DXF iniciada.';
    }
    case 'get_app_state': {
      const st = _aiGetState();
      const desc = st.clouds.length === 0
        ? 'No hi ha núvols carregats.'
        : st.clouds.map(c => `• ${c.name} (${c.points.toLocaleString()} pts)${c.selected ? ' ← seleccionat' : ''}`).join('\n');
      return desc;
    }
    case 'semantic_vision_edit': {
      return await _semanticVisionEdit(input.query, input.operacio, input.color);
    }
    default:
      return `Eina desconeguda: ${name}`;
  }
}

const _aiHistory = []; // conversa persistent dins la sessió

const _aiToolLabels = {
  change_view:         'Canviant vista',
  set_transform_mode:  'Activant mode de transformació',
  apply_noise_filter:  'Aplicant filtre de soroll',
  apply_icp_alignment: 'Executant ICP',
  create_clipping_box: 'Creant caixa de tall',
  apply_clip_permanent:'Aplicant tall permanent',
  remove_clipping_box: 'Eliminant caixa de tall',
  start_erase_tool:    'Activant eina d\'esborrat',
  toggle_annotation:   'Mode de dibuix',
  undo_last_action:    'Desfent acció',
  merge_and_download:   'Fusionant i descarregant',
  export_section_dxf:   'Exportant secció DXF',
  get_app_state:        'Consultant estat',
  semantic_vision_edit: '🔍 Analitzant núvol per visió IA…'
};

function _aiAddMsg(text, cls) {
  const clsMap = { 'ai-u': 'cmd-u', 'ai-a': 'cmd-a', 'ai-x': 'cmd-x', 'ai-e': 'cmd-e' };
  _cmdLog(text, clsMap[cls] || 'cmd-a');
}

function _aiSetThinking(on) { _cmdSetThinking(on); }

async function sendAICommand(text) {
  const apiKey = localStorage.getItem('ai_api_key');
  if (!apiKey) {
    _aiAddMsg('⚠ Cal guardar la clau API primer.', 'ai-e');
    return;
  }
  if (!text.trim()) return;

  _aiAddMsg('Tu: ' + text, 'ai-u');
  _aiHistory.push({ role: 'user', content: text });
  // Limita historial a 10 missatges
  if (_aiHistory.length > 10) _aiHistory.splice(0, _aiHistory.length - 10);

  _aiSetThinking(true);

  const state = _aiGetState();
  const cloudDesc = state.clouds.length === 0
    ? 'No hi ha núvols carregats.'
    : state.clouds.map(c => `"${c.name}" (${c.points.toLocaleString()} punts)${c.selected ? ' [SELECCIONAT]' : ''}`).join(', ');

  const systemPrompt = `Ets l'assistent de l'app "4 Merge Cloud", un visor web de núvols de punts 3D per a arquitectes i enginyers.

ESTAT ACTUAL DE L'APP:
- Núvols carregats: ${cloudDesc}
- Mode actiu: ${state.currentMode}
- Caixa de tall: ${state.hasClipBox ? 'activa' : 'no activa'}

INSTRUCCIONS:
- Interpreta les ordres de l'usuari en CATALÀ, castellà o anglès.
- SEMPRE crida una eina quan l'ordre sigui una acció sobre l'app. NO responguis només amb text si l'acció es pot executar.
- Si no entens l'ordre, pregunta breument en català.
- Respon sempre en l'idioma que fa servir l'usuari.
- Respostes molt breus (1-2 frases màxim).
- Quan executis una acció, confirma-la breument (p.ex: "Fet." o "Vista de planta activada.").`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
        messages: _aiHistory.slice(),
        tools: AI_TOOLS,
        tool_choice: { type: 'auto' }
      })
    });

    _aiSetThinking(false);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      _aiAddMsg('Error API: ' + (err.error?.message || resp.statusText), 'ai-e');
      _aiHistory.pop(); // treu el missatge que ha fallat
      return;
    }

    const data = await resp.json();
    const assistantContent = data.content || [];
    let assistantText = '';
    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type === 'text' && block.text.trim()) {
        assistantText = block.text.trim();
      } else if (block.type === 'tool_use') {
        const label = _aiToolLabels[block.name] || block.name;
        _aiAddMsg('⚙ ' + label + '…', 'ai-x');
        const result = await _executeAITool(block.name, block.input || {});
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        _aiAddMsg('✓ ' + result, 'ai-a');
      }
    }

    if (assistantText) _aiAddMsg(assistantText, 'ai-a');

    // Afegeix la resposta de l'assistent a l'historial
    _aiHistory.push({ role: 'assistant', content: assistantContent });

    // Si hi ha resultats d'eines, afegeix-los a l'historial
    if (toolResults.length > 0) {
      _aiHistory.push({ role: 'user', content: toolResults });
    }

    if (!assistantText && toolResults.length === 0) {
      _aiAddMsg('No entenc l\'ordre. Pots reformular-la?', 'ai-e');
    }
  } catch (err) {
    _aiSetThinking(false);
    _aiAddMsg('Error: ' + err.message, 'ai-e');
    _aiHistory.pop();
  }
}

let _aiVoiceRec = null;

// ─────────────────────────────────────────────
// Traçat 2D → DXF
// ─────────────────────────────────────────────
const TRACE_LAYERS = {
  PARETS:   { color: 0xffffff, dxfColor: 7 },
  PORTES:   { color: 0x00ccff, dxfColor: 4 },
  FINESTRES:{ color: 0xffee00, dxfColor: 2 },
};
let _tracing          = false;
let _traceMode        = 'polyline'; // 'polyline' | 'free'
let _traceLayer       = 'PARETS';
let _tracePts         = [];
let _traceSegments    = [];
let _tracePreview     = null;
let _traceCurrentLine = null;
let _traceFreeDown    = false; // free-draw: mouse held

function _traceStatusUpdate() {
  const el = document.getElementById('traceStatus');
  if (!el) return;
  const segs = _traceSegments.length;
  const pts  = _tracePts.length;
  const closeBtn = document.getElementById('traceClose');
  if (!_tracing) {
    el.textContent = segs > 0 ? segs + ' segment(s) guardats. Prem Exportar DXF.' : '';
    if (closeBtn) closeBtn.style.display = 'none';
    return;
  }
  if (_traceMode === 'polyline') {
    if (pts === 0)
      el.textContent = 'Capa: ' + _traceLayer + ' — fes clic per afegir vèrtexs.';
    else
      el.textContent = pts + ' punt(s) en curs. Prem "Tancar Segment" per guardar.';
    if (closeBtn) closeBtn.style.display = pts >= 2 ? 'block' : 'none';
  } else {
    el.textContent = 'Mode lliure — manté el botó del ratolí premut i arrossega.';
    if (closeBtn) closeBtn.style.display = 'none';
  }
  if (segs > 0) el.textContent += '\n' + segs + ' segment(s) guardats.';
}

function setTraceLayer(layer) {
  _traceLayer = layer;
  _traceStatusUpdate();
}

function setTraceMode(mode) {
  _traceMode = mode;
  document.getElementById('traceModePolyline')?.classList.toggle('trace-active', mode === 'polyline');
  document.getElementById('traceModeFree')?.classList.toggle('trace-active',     mode === 'free');
  // Commit open polyline when switching modes
  if (_tracePts.length >= 2) _traceCommitSegment();
  else { _tracePts = []; _updateCurrentLine(); }
  _traceStatusUpdate();
}

function _traceRaycast(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width)  * 2 - 1;
  const ny = -((clientY - rect.top)  / rect.height) * 2 + 1;
  const rc = new THREE.Raycaster();
  rc.params.Points = { threshold: 0.15 };
  const cam = (useOrtho && orthoCamera) ? orthoCamera : camera;
  rc.setFromCamera(new THREE.Vector2(nx, ny), cam);
  const hits = rc.intersectObjects(clouds, false);
  if (hits.length > 0) return hits[0].point.clone();
  // fallback: project onto the median Y plane of loaded clouds
  let planeY = 0;
  if (clouds.length > 0) {
    const box = new THREE.Box3().setFromObject(clouds[0]);
    planeY = (box.min.y + box.max.y) / 2;
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
  const target = new THREE.Vector3();
  rc.ray.intersectPlane(plane, target);
  return target;
}

function _buildLineFromPoints(pts, color) {
  if (pts.length < 2) return null;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
  return new THREE.Line(geo, mat);
}

function _updateCurrentLine() {
  if (_traceCurrentLine) { scene.remove(_traceCurrentLine); _traceCurrentLine = null; }
  if (_tracePts.length < 2) return;
  const cfg = TRACE_LAYERS[_traceLayer];
  _traceCurrentLine = _buildLineFromPoints([..._tracePts], cfg.color);
  _traceCurrentLine.renderOrder = 999;
  scene.add(_traceCurrentLine);
}

function _updatePreview(clientX, clientY) {
  if (_tracePreview) { scene.remove(_tracePreview); _tracePreview = null; }
  if (_tracePts.length === 0) return;
  const worldPt = _traceRaycast(clientX, clientY);
  if (!worldPt) return;
  const cfg = TRACE_LAYERS[_traceLayer];
  const mat = new THREE.LineDashedMaterial({ color: cfg.color, dashSize: 0.05, gapSize: 0.03, depthTest: false });
  const geo = new THREE.BufferGeometry().setFromPoints([_tracePts[_tracePts.length - 1], worldPt]);
  _tracePreview = new THREE.Line(geo, mat);
  _tracePreview.computeLineDistances();
  _tracePreview.renderOrder = 999;
  scene.add(_tracePreview);
}

function toggleTracing() {
  _tracing = !_tracing;
  const btn    = document.getElementById('traceToggle');
  const viewer = document.getElementById('viewer');
  if (_tracing) {
    btn.textContent = '⏹ Aturar Traçat';
    btn.classList.add('tracing');
    viewer.classList.add('trace-mode');
    controls.enabled = false;
    if (orthoControls) orthoControls.enabled = false;
    if (!useOrtho) setOrthoView(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
  } else {
    btn.textContent = '✏ Iniciar Traçat 2D';
    btn.classList.remove('tracing');
    viewer.classList.remove('trace-mode');
    controls.enabled = true;
    if (orthoControls) orthoControls.enabled = true;
    if (_tracePreview) { scene.remove(_tracePreview); _tracePreview = null; }
    if (_tracePts.length >= 2) _traceCommitSegment();
    else { _tracePts = []; _updateCurrentLine(); }
  }
  _traceStatusUpdate();
}

function _traceCommitSegment() {
  if (_tracePts.length < 2) { _tracePts = []; _updateCurrentLine(); return; }
  if (_traceCurrentLine) { scene.remove(_traceCurrentLine); _traceCurrentLine = null; }
  const cfg = TRACE_LAYERS[_traceLayer];
  const lineObj = _buildLineFromPoints([..._tracePts], cfg.color);
  if (lineObj) { lineObj.renderOrder = 999; scene.add(lineObj); }
  _traceSegments.push({ layer: _traceLayer, points: [..._tracePts], lineObj });
  _tracePts = [];
  _traceCurrentLine = null;
  _traceStatusUpdate();
}

// ── Polyline mode handlers ────────────────────────────────────────────────────
function _tracePolyClick(event) {
  if (!_tracing || _traceMode !== 'polyline') return;
  event.stopPropagation();
  const pt = _traceRaycast(event.clientX, event.clientY);
  if (!pt) return;
  _tracePts.push(pt);
  _updateCurrentLine();
  _traceStatusUpdate();
}

function _tracePolyMove(event) {
  if (!_tracing || _traceMode !== 'polyline' || _tracePts.length === 0) return;
  _updatePreview(event.clientX, event.clientY);
}

// ── Free-draw mode handlers ───────────────────────────────────────────────────
let _traceFreeLastPt = null;
const FREE_MIN_DIST = 0.05; // metres between sampled points

function _traceFreeDn(event) {
  if (!_tracing || _traceMode !== 'free') return;
  event.preventDefault();
  event.stopImmediatePropagation(); // prevent Three.js onPointerDown on same element
  _traceFreeDown = true;
  _traceFreeLastPt = null;
  _tracePts = [];
  const pt = _traceRaycast(event.clientX, event.clientY);
  if (pt) { _tracePts.push(pt); _traceFreeLastPt = pt; }
}

function _traceFreeMv(event) {
  if (!_tracing || _traceMode !== 'free' || !_traceFreeDown) return;
  event.preventDefault(); // prevent page scroll during draw on touch
  const pt = _traceRaycast(event.clientX, event.clientY);
  if (!pt) return;
  if (!_traceFreeLastPt || pt.distanceTo(_traceFreeLastPt) > FREE_MIN_DIST) {
    _tracePts.push(pt);
    _traceFreeLastPt = pt;
    _updateCurrentLine();
  }
}

function _traceFreeUp(event) {
  if (!_tracing || _traceMode !== 'free' || !_traceFreeDown) return;
  _traceFreeDown = false;
  _traceFreeLastPt = null;
  if (_tracePts.length >= 2) _traceCommitSegment();
  else { _tracePts = []; _updateCurrentLine(); }
}

// ── Undo / clear ─────────────────────────────────────────────────────────────
function traceUndoPoint() {
  if (_tracePts.length > 0) {
    _tracePts.pop();
    _updateCurrentLine();
    if (_tracePreview) { scene.remove(_tracePreview); _tracePreview = null; }
  } else if (_traceSegments.length > 0) {
    const last = _traceSegments.pop();
    if (last.lineObj) scene.remove(last.lineObj);
  }
  _traceStatusUpdate();
}

function traceClearAll() {
  if (_traceSegments.length === 0 && _tracePts.length === 0) return;
  if (!confirm('Esborrar tots els segments traçats?')) return;
  _traceSegments.forEach(s => { if (s.lineObj) scene.remove(s.lineObj); });
  _traceSegments = [];
  _tracePts = [];
  if (_traceCurrentLine) { scene.remove(_traceCurrentLine); _traceCurrentLine = null; }
  if (_tracePreview) { scene.remove(_tracePreview); _tracePreview = null; }
  _traceStatusUpdate();
}

// ── Ajust geomètric: línia i arc (per a exportació neta) ─────────────────────

// PCA per trobar la millor línia recta (retorna endpoints nets i error RMS)
function _fitLine2D(pts) {
  const n = pts.length;
  let mx = 0, mz = 0;
  for (const p of pts) { mx += p.x; mz += p.z; }
  mx /= n; mz /= n;

  let sxx = 0, sxz = 0, szz = 0;
  for (const p of pts) {
    const dx = p.x - mx, dz = p.z - mz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dirX = Math.cos(angle), dirZ = Math.sin(angle);

  let tmin = Infinity, tmax = -Infinity, rms = 0;
  for (const p of pts) {
    const t    =  (p.x - mx) * dirX + (p.z - mz) * dirZ;
    const perp = -(p.x - mx) * dirZ + (p.z - mz) * dirX;
    rms += perp * perp;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  return {
    x1: mx + dirX * tmin, z1: mz + dirZ * tmin,
    x2: mx + dirX * tmax, z2: mz + dirZ * tmax,
    rms: Math.sqrt(rms / n),
    len: tmax - tmin,
  };
}

// Ajust de cercle (mètode Taubin). Retorna {cx,cz,r,a1,a2,rms} o null
function _fitArc2D(pts) {
  const n = pts.length;
  if (n < 4) return null;

  let mx = 0, mz = 0;
  for (const p of pts) { mx += p.x; mz += p.z; }
  mx /= n; mz /= n;

  let Mxx=0, Mzz=0, Mxz=0, Mxxx=0, Mzzz=0, Mxxz=0, Mxzz=0;
  for (const p of pts) {
    const x = p.x - mx, z = p.z - mz;
    Mxx += x*x; Mzz += z*z; Mxz += x*z;
    Mxxx += x*x*x; Mzzz += z*z*z; Mxxz += x*x*z; Mxzz += x*z*z;
  }
  Mxx/=n; Mzz/=n; Mxz/=n; Mxxx/=n; Mzzz/=n; Mxxz/=n; Mxzz/=n;

  const det = Mxx * Mzz - Mxz * Mxz;
  if (Math.abs(det) < 1e-12) return null;

  const bx = -(Mxxx + Mxzz) / 2;
  const bz = -(Mxxz + Mzzz) / 2;
  const cx0 = ( bx * Mzz - bz * Mxz) / det;
  const cz0 = (-bx * Mxz + bz * Mxx) / det;
  const cx = cx0 + mx, cz = cz0 + mz;

  let r = 0;
  for (const p of pts) r += Math.hypot(p.x - cx, p.z - cz);
  r /= n;

  // Radi massa gran = pràcticament una línia recta
  const lineFit = _fitLine2D(pts);
  if (r > lineFit.len * 20) return null;

  let rms = 0;
  for (const p of pts) { const d = Math.hypot(p.x - cx, p.z - cz) - r; rms += d*d; }
  rms = Math.sqrt(rms / n);

  // Angles inici i fi (en graus, sentit antihorari)
  const a1 = (Math.atan2(pts[0].z - cz, pts[0].x - cx) * 180 / Math.PI + 360) % 360;
  const a2 = (Math.atan2(pts[n-1].z - cz, pts[n-1].x - cx) * 180 / Math.PI + 360) % 360;

  return { cx, cz, r, a1, a2, rms };
}

// Decideix si un segment s'ha d'exportar com a LINE o ARC
function _fitSegment(pts) {
  if (pts.length < 2) return null;
  if (pts.length === 2) return { type: 'line', ...pts[0], ...{ x1:pts[0].x,z1:pts[0].z,x2:pts[1].x,z2:pts[1].z } };

  const line = _fitLine2D(pts);
  const arc  = _fitArc2D(pts);

  // Usa arc si l'error és < 40% de l'error de línia i és un arc visible
  if (arc && arc.rms < line.rms * 0.4 && arc.rms < line.len * 0.05) {
    return { type: 'arc', ...arc };
  }
  return { type: 'line', ...line };
}

// ── DXF export ────────────────────────────────────────────────────────────────
function traceExportDXF() {
  if (_tracePts.length >= 2) _traceCommitSegment();

  if (_traceSegments.length === 0) {
    alert('No hi ha cap segment traçat per exportar.\nDibuixa alguna línia primer.');
    return;
  }

  const allSegs  = _traceSegments;
  const layers   = [...new Set(allSegs.map(s => s.layer))];
  const colorMap = { PARETS: 7, PORTES: 4, FINESTRES: 2 };
  const R = '\r\n';

  let dxf = '';
  dxf += '0'+R+'SECTION'+R+'2'+R+'HEADER'+R;
  dxf += '9'+R+'$ACADVER'+R+'1'+R+'AC1009'+R;
  dxf += '0'+R+'ENDSEC'+R;

  dxf += '0'+R+'SECTION'+R+'2'+R+'TABLES'+R;
  dxf += '0'+R+'TABLE'+R+'2'+R+'LAYER'+R+'70'+R+layers.length+R;
  layers.forEach(lyr => {
    dxf += '0'+R+'LAYER'+R+'2'+R+lyr+R+'70'+R+'0'+R+'62'+R+(colorMap[lyr]||7)+R+'6'+R+'CONTINUOUS'+R;
  });
  dxf += '0'+R+'ENDTAB'+R+'0'+R+'ENDSEC'+R;

  dxf += '0'+R+'SECTION'+R+'2'+R+'ENTITIES'+R;

  let nLines = 0, nArcs = 0;
  allSegs.forEach(seg => {
    const fit = _fitSegment(seg.points);
    if (!fit) return;

    if (fit.type === 'line') {
      dxf += '0'+R+'LINE'+R+'8'+R+seg.layer+R;
      dxf += '10'+R+fit.x1.toFixed(4)+R+'20'+R+fit.z1.toFixed(4)+R+'30'+R+'0.0'+R;
      dxf += '11'+R+fit.x2.toFixed(4)+R+'21'+R+fit.z2.toFixed(4)+R+'31'+R+'0.0'+R;
      nLines++;
    } else {
      // ARC: center, radius, start/end angle
      dxf += '0'+R+'ARC'+R+'8'+R+seg.layer+R;
      dxf += '10'+R+fit.cx.toFixed(4)+R+'20'+R+fit.cz.toFixed(4)+R+'30'+R+'0.0'+R;
      dxf += '40'+R+fit.r.toFixed(4)+R;
      dxf += '50'+R+fit.a1.toFixed(4)+R;
      dxf += '51'+R+fit.a2.toFixed(4)+R;
      nArcs++;
    }
  });

  dxf += '0'+R+'ENDSEC'+R+'0'+R+'EOF'+R;

  const filename = 'tracat_' + new Date().toISOString().slice(0, 10) + '.dxf';
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);

  document.getElementById('traceStatus').textContent =
    '✓ ' + filename + ' — ' + nLines + ' línies' + (nArcs > 0 ? ', ' + nArcs + ' arcs' : '') + ' (geometria ajustada)';
}

function initTracing() {
  const canvas = renderer?.domElement;
  if (!canvas) return;

  // Polyline mode
  canvas.addEventListener('click',     _tracePolyClick, { capture: true });
  canvas.addEventListener('mousemove', _tracePolyMove,  { passive: true });

  // Free-draw mode — pointer events work for mouse, touch and stylus
  canvas.addEventListener('pointerdown',   _traceFreeDn, { capture: true });
  canvas.addEventListener('pointermove',   _traceFreeMv, { capture: true });
  canvas.addEventListener('pointerup',     _traceFreeUp, { capture: true });
  canvas.addEventListener('pointercancel', _traceFreeUp, { capture: true });

  // Buttons
  const closeBtn = document.getElementById('traceClose');
  if (closeBtn) closeBtn.addEventListener('click', () => { _traceCommitSegment(); _traceStatusUpdate(); });

  const mPolyBtn = document.getElementById('traceModePolyline');
  const mFreeBtn = document.getElementById('traceModeFree');
  if (mPolyBtn) mPolyBtn.addEventListener('click', () => setTraceMode('polyline'));
  if (mFreeBtn) mFreeBtn.addEventListener('click', () => setTraceMode('free'));
}

// ─────────────────────────────────────────────
// Draw Overlay — 2D freehand canvas → DXF
// ─────────────────────────────────────────────
let _dCtx         = null;
let _dActive      = false;
let _dStroke      = []; // [{clientX, clientY}] current stroke screen coords
let _dLayer       = 0;

const _D_LAYER_COLORS = ['#ff4444', '#4488ff', '#44cc66', '#ffcc00'];

function initDrawOverlay() {
  const overlay = document.getElementById('drawOverlay');
  if (!overlay) return;
  const viewer  = document.getElementById('viewer');

  function _syncSize() {
    const dpr = window.devicePixelRatio || 1;
    const w = viewer.clientWidth;
    const h = viewer.clientHeight;
    overlay.width  = w * dpr;
    overlay.height = h * dpr;
    overlay.style.width  = w + 'px';
    overlay.style.height = h + 'px';
    _dCtx = overlay.getContext('2d');
    _dCtx.scale(dpr, dpr);
  }
  requestAnimationFrame(_syncSize); // defer until layout is ready
  window.addEventListener('resize', _syncSize);

  overlay.addEventListener('pointerdown',   _dDn, { capture: true });
  overlay.addEventListener('pointermove',   _dMv, { capture: true });
  overlay.addEventListener('pointerup',     _dUp, { capture: true });
  overlay.addEventListener('pointercancel', _dUp, { capture: true });

  document.getElementById('drawFloatBtn')?.addEventListener('click', toggleDrawOverlay);
  document.getElementById('drawCloseBtn')?.addEventListener('click', toggleDrawOverlay);
  document.getElementById('drawLayerSel')?.addEventListener('change', e => {
    _dLayer = parseInt(e.target.value);
    _traceLayer = _dLayer;
  });
  document.getElementById('drawUndoBtn')?.addEventListener('click', _dUndo);
  document.getElementById('drawExportBtn')?.addEventListener('click', traceExportDXF);
}

function toggleDrawOverlay() {
  _dActive = !_dActive;
  const overlay = document.getElementById('drawOverlay');
  const tools   = document.getElementById('drawFloatTools');
  const btn     = document.getElementById('drawFloatBtn');

  if (_dActive) {
    overlay.style.pointerEvents = 'auto';
    tools.style.display = 'flex';
    btn.textContent = '⏹ Aturar';
    btn.classList.add('active');
    // Enter top-down ortho + disable orbit
    _tracing = true;
    controls.enabled = false;
    if (orthoControls) orthoControls.enabled = false;
    if (!useOrtho) setOrthoView(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
    _dUpdateCount();
  } else {
    overlay.style.pointerEvents = 'none';
    if (_dCtx) _dCtx.clearRect(0, 0, overlay.width / (window.devicePixelRatio||1), overlay.height / (window.devicePixelRatio||1));
    tools.style.display = 'none';
    btn.textContent = '✏ Dibuix';
    btn.classList.remove('active');
    // Commit any pending, re-enable orbit
    if (_tracePts.length >= 2) _traceCommitSegment();
    else { _tracePts = []; _updateCurrentLine(); }
    _tracing = false;
    controls.enabled = true;
    if (orthoControls) orthoControls.enabled = true;
  }
}

function _dDn(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  _dStroke = [{ clientX: event.clientX, clientY: event.clientY }];
  const color = _D_LAYER_COLORS[_dLayer] || '#ff4444';
  const overlay = document.getElementById('drawOverlay');
  const r = overlay.getBoundingClientRect();
  _dCtx.clearRect(0, 0, overlay.width, overlay.height); // clear previous ghost stroke
  _dCtx.beginPath();
  _dCtx.moveTo(event.clientX - r.left, event.clientY - r.top);
  _dCtx.strokeStyle = color;
  _dCtx.lineWidth = 2.5;
  _dCtx.lineCap = 'round';
  _dCtx.lineJoin = 'round';
  _dCtx.globalAlpha = 0.85;
}

function _dMv(event) {
  if (!_dStroke.length) return;
  event.preventDefault();
  _dStroke.push({ clientX: event.clientX, clientY: event.clientY });
  const r = document.getElementById('drawOverlay').getBoundingClientRect();
  _dCtx.lineTo(event.clientX - r.left, event.clientY - r.top);
  _dCtx.stroke();
}

function _dUp(event) {
  if (!_dStroke.length) return;
  event.preventDefault();
  // Project every screen point to 3D world
  _tracePts = _dStroke.map(p => _traceRaycast(p.clientX, p.clientY)).filter(Boolean);
  _dStroke = [];
  // Clear ghost stroke (3D committed line takes over visually)
  const overlay = document.getElementById('drawOverlay');
  const dpr = window.devicePixelRatio || 1;
  _dCtx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);
  if (_tracePts.length >= 2) {
    _traceLayer = _dLayer;
    _traceCommitSegment();
    _dUpdateCount();
  } else {
    _tracePts = [];
  }
}

function _dUndo() {
  if (!_traceSegments.length) return;
  const seg = _traceSegments.pop();
  if (seg.lineObj) scene.remove(seg.lineObj);
  _traceStatusUpdate();
  _dUpdateCount();
}

function _dUpdateCount() {
  const el = document.getElementById('drawSegCount');
  if (!el) return;
  const n = _traceSegments.length;
  el.textContent = n === 0 ? '' : n + ' traç' + (n > 1 ? 'os dibuixats' : ' dibuixat');
}

// ─────────────────────────────────────────────
// V2 UI: Accordions
// ─────────────────────────────────────────────
function initAccordions() {
  document.querySelectorAll('.acc-header').forEach(header => {
    header.addEventListener('click', () => {
      const accId = header.dataset.acc;
      const body = document.getElementById(accId + '-body');
      if (!body) return;
      const isOpen = body.classList.contains('open');
      body.classList.toggle('open', !isOpen);
      header.classList.toggle('open', !isOpen);
    });
  });
}

// ─────────────────────────────────────────────
// V2 UI: Demo cloud generator
// ─────────────────────────────────────────────
function generateDemoCloud() {
  const N = 15000;
  const positions = new Float32Array(N * 3);
  const colors    = new Float32Array(N * 3);
  const W = 6, D = 10, H = 3; // sala: 6m x 10m x 3m

  for (let i = 0; i < N; i++) {
    let x, y, z, r, g, b;
    const face = Math.floor(Math.random() * 6);
    const noise = () => (Math.random() - 0.5) * 0.02;
    if (face === 0) { // terra
      x = (Math.random() - 0.5) * W; y = 0 + noise(); z = (Math.random() - 0.5) * D;
      r = 0.55; g = 0.5; b = 0.45;
    } else if (face === 1) { // sostre
      x = (Math.random() - 0.5) * W; y = H + noise(); z = (Math.random() - 0.5) * D;
      r = 0.9; g = 0.88; b = 0.85;
    } else if (face === 2) { // paret frontal
      x = (Math.random() - 0.5) * W; y = Math.random() * H; z = -D/2 + noise();
      r = 0.7; g = 0.68; b = 0.65;
    } else if (face === 3) { // paret posterior
      x = (Math.random() - 0.5) * W; y = Math.random() * H; z = D/2 + noise();
      r = 0.7; g = 0.68; b = 0.65;
    } else if (face === 4) { // paret esquerra
      x = -W/2 + noise(); y = Math.random() * H; z = (Math.random() - 0.5) * D;
      r = 0.65; g = 0.63; b = 0.6;
    } else { // paret dreta
      x = W/2 + noise(); y = Math.random() * H; z = (Math.random() - 0.5) * D;
      r = 0.65; g = 0.63; b = 0.6;
    }
    positions[i*3]   = x; positions[i*3+1] = y; positions[i*3+2] = z;
    colors[i*3]      = r; colors[i*3+1]    = g; colors[i*3+2]    = b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ size: 0.025, vertexColors: true });
  const cloud = new THREE.Points(geo, mat);
  cloud.name = 'demo_sala.xyz';
  scene.add(cloud);
  clouds.push(cloud);
  selectCloud(cloud);
  fitCameraToObject(cloud);
  updateCloudList();
  _cmdLog('Escaneig de demo generat: sala de 6×10×3 m, ' + N.toLocaleString() + ' punts.', 'cmd-a');
}

// ─────────────────────────────────────────────
// V2 UI: CAD Command Line (substitueix initAI)
// ─────────────────────────────────────────────
function _cmdLog(text, cls) {
  const box = document.getElementById('cmdHistory');
  if (!box) return;
  const d = document.createElement('div');
  d.className = cls || 'cmd-a';
  d.textContent = text;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

function _cmdSetThinking(on) {
  const box = document.getElementById('cmdHistory');
  if (!box) return;
  let dot = box.querySelector('.cmd-thinking');
  if (on && !dot) {
    dot = document.createElement('div');
    dot.className = 'cmd-thinking';
    dot.textContent = '⏳ processant…';
    box.appendChild(dot);
    box.scrollTop = box.scrollHeight;
  } else if (!on && dot) {
    dot.remove();
  }
}

function initCmdLine() {
  const cmdLine   = document.getElementById('cmdLine');
  const cmdHeader = document.getElementById('cmdHeader');
  const cmdToggle = document.getElementById('cmdToggleBtn');
  const cmdText   = document.getElementById('cmdText');
  const voiceBtn  = document.getElementById('cmdVoiceBtn');

  if (!cmdLine) return;

  // Check for saved API key
  const saved = localStorage.getItem('ai_api_key');

  // Toggle expand/collapse
  cmdHeader?.addEventListener('click', () => {
    const expanded = cmdLine.classList.contains('expanded');
    cmdLine.classList.toggle('expanded', !expanded);
    cmdLine.classList.toggle('collapsed', expanded);
  });

  // API key row
  const apiKeyRow   = document.getElementById('apiKeyRow');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const apiKeySave  = document.getElementById('apiKeySave');
  const apiKeySkip  = document.getElementById('apiKeySkip');

  if (apiKeyRow) apiKeyRow.style.display = saved ? 'none' : 'flex';

  apiKeySave?.addEventListener('click', () => {
    const key = apiKeyInput?.value.trim();
    if (key?.startsWith('sk-')) {
      localStorage.setItem('ai_api_key', key);
      if (apiKeyRow) apiKeyRow.style.display = 'none';
      if (apiKeyInput) apiKeyInput.value = '';
      cmdLine.classList.remove('collapsed'); cmdLine.classList.add('expanded');
      _cmdLog('✓ Clau API guardada. Ja pots escriure ordres al Copilot IA.', 'cmd-a');
    } else {
      if (apiKeyInput) apiKeyInput.style.border = '1px solid #cc5544';
      setTimeout(() => { if (apiKeyInput) apiKeyInput.style.border = ''; }, 1500);
    }
  });

  apiKeyInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') apiKeySave?.click(); });
  apiKeySkip?.addEventListener('click',    () => { if (apiKeyRow) apiKeyRow.style.display = 'none'; });

  // First message
  if (saved) {
    _cmdLog('Copilot IA llest. Escriu una ordre o pregunta.', 'cmd-sys');
  } else {
    _cmdLog('Introdueix la teva clau API Anthropic al camp de dalt per activar el Copilot IA.', 'cmd-sys');
  }

  // Send on Enter
  cmdText?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = cmdText.value.trim();
    if (!text) return;
    cmdText.value = '';

    // Special command: save API key
    if (text.toLowerCase().startsWith('clau ') || text.toLowerCase().startsWith('key ')) {
      const key = text.split(' ').slice(1).join(' ').trim();
      if (key.startsWith('sk-')) {
        localStorage.setItem('ai_api_key', key);
        _cmdLog('4MC> ' + '•'.repeat(20), 'cmd-u');
        _cmdLog('✓ Clau API guardada correctament.', 'cmd-a');
      } else {
        _cmdLog('Error: la clau ha de començar per sk-ant-...', 'cmd-e');
      }
      return;
    }

    // Expand the cmdline if collapsed
    if (cmdLine.classList.contains('collapsed')) {
      cmdLine.classList.remove('collapsed');
      cmdLine.classList.add('expanded');
    }

    _cmdLog('4MC> ' + text, 'cmd-u');
    await sendAICommand(text);
  });

  // Voice input
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec && voiceBtn) {
    const rec = new SpeechRec();
    rec.lang = window.APP_LANG === 'ca' ? 'ca-ES' : 'en-US';
    rec.interimResults = false;
    rec.onresult = e => {
      const txt = e.results[0][0].transcript;
      if (cmdText) cmdText.value = txt;
      voiceBtn.classList.remove('recording');
      // auto-send
      _cmdLog('4MC> ' + txt, 'cmd-u');
      if (cmdLine.classList.contains('collapsed')) {
        cmdLine.classList.remove('collapsed');
        cmdLine.classList.add('expanded');
      }
      sendAICommand(txt);
      if (cmdText) cmdText.value = '';
    };
    rec.onerror = () => voiceBtn.classList.remove('recording');
    rec.onend   = () => voiceBtn.classList.remove('recording');
    voiceBtn.addEventListener('click', () => {
      if (voiceBtn.classList.contains('recording')) {
        rec.stop(); voiceBtn.classList.remove('recording');
      } else {
        rec.start(); voiceBtn.classList.add('recording');
      }
    });
  } else if (voiceBtn) {
    voiceBtn.style.display = 'none';
  }

  // Demo cloud button
  document.getElementById('waDemoCloud')?.addEventListener('click', generateDemoCloud);
}

// KEEP initAI name as alias so it's not called on v1 accidentally
function initAI() {
  const btnAI    = document.getElementById('btnAI');
  const aiPanel  = document.getElementById('aiPanel');
  const keyInput = document.getElementById('aiKeyInput');
  const keySave  = document.getElementById('aiKeySave');
  const textIn   = document.getElementById('aiTextInput');
  const sendBtn  = document.getElementById('aiSendBtn');
  const voiceBtn = document.getElementById('aiVoiceBtn');
  const clearBtn = document.getElementById('aiClearBtn');

  if (!btnAI) return;

  // Load saved key
  const saved = localStorage.getItem('ai_api_key');
  if (saved && keyInput) keyInput.placeholder = '•••••• (guardada)';

  btnAI.addEventListener('click', () => {
    const open = aiPanel.style.display !== 'none' && aiPanel.style.display !== '';
    aiPanel.style.display = open ? 'none' : 'block';
    btnAI.classList.toggle('active', !open);
  });

  clearBtn?.addEventListener('click', () => {
    const box = document.getElementById('aiMessages');
    if (box) box.innerHTML = '';
    _aiHistory.length = 0;
  });

  keySave?.addEventListener('click', () => {
    const val = keyInput.value.trim();
    if (val) {
      localStorage.setItem('ai_api_key', val);
      keyInput.value = '';
      keyInput.placeholder = '•••••• (guardada)';
      _aiAddMsg('✓ Clau guardada al navegador.', 'ai-a');
    }
  });

  sendBtn?.addEventListener('click', () => {
    const txt = textIn.value.trim();
    textIn.value = '';
    sendAICommand(txt);
  });

  textIn?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const txt = textIn.value.trim();
      textIn.value = '';
      sendAICommand(txt);
    }
  });

  // Voice input (Web Speech API)
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec && voiceBtn) {
    _aiVoiceRec = new SpeechRec();
    _aiVoiceRec.lang = 'ca-ES';
    _aiVoiceRec.interimResults = false;
    _aiVoiceRec.maxAlternatives = 1;

    _aiVoiceRec.onresult = e => {
      const txt = e.results[0][0].transcript;
      if (textIn) textIn.value = txt;
      voiceBtn.classList.remove('recording');
      sendAICommand(txt);
      if (textIn) textIn.value = '';
    };
    _aiVoiceRec.onerror = () => voiceBtn.classList.remove('recording');
    _aiVoiceRec.onend   = () => voiceBtn.classList.remove('recording');

    voiceBtn.addEventListener('click', () => {
      if (voiceBtn.classList.contains('recording')) {
        _aiVoiceRec.stop();
        voiceBtn.classList.remove('recording');
      } else {
        _aiVoiceRec.start();
        voiceBtn.classList.add('recording');
      }
    });
  } else if (voiceBtn) {
    voiceBtn.style.display = 'none';
  }
}

// Render loop
// ─────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  try {
    if (useOrtho) {
      if (orthoControls) orthoControls.update();
    } else {
      controls.update();
    }
    updateClipPlanes();

    const { w: W, h: H } = _viewerSize();
    const camA = useOrtho ? orthoCamera : camera;

    if (!useOrtho) { camera.aspect = W / H; camera.updateProjectionMatrix(); }
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.setScissorTest(true);
    renderer.render(scene, camA);
  } catch(err) { console.error('animate error:', err); }
}

// ─────────────────────────────────────────────
// Arrencada
// ─────────────────────────────────────────────
window.addEventListener('error', e => {
  const box = document.getElementById('cmdHistory');
  if (box) {
    const d = document.createElement('div');
    d.style.cssText = 'color:#ff6b6b;font-size:11px;word-break:break-all;';
    d.textContent = '⚠ JS ERROR: ' + e.message + ' (' + (e.filename||'').split('/').pop() + ':' + e.lineno + ')';
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
  const cl = document.getElementById('cmdLine');
  if (cl) cl.classList.remove('collapsed');
});

// Mostra versió a la capçalera
const _vEl = document.getElementById('appVersion');
if (_vEl) _vEl.textContent = 'v' + APP_VERSION;

try { init(); } catch(e) { console.error('init() crashed:', e); }
try { setupUI(); } catch(e) { console.error('setupUI() crashed:', e); }
try { initAccordions(); } catch(e) { console.error('initAccordions() crashed:', e); }
try { initCmdLine(); } catch(e) { console.error('initCmdLine() crashed:', e); }
try { initTracing(); } catch(e) { console.error('initTracing() crashed:', e); }
try { initDrawOverlay(); } catch(e) { console.error('initDrawOverlay() crashed:', e); }
animate();

// Obre els accordions "Propietats" i "Moure/Rotar" per defecte
['accMove', 'accAlign'].forEach(id => {
  const body   = document.getElementById(id + '-body');
  const header = document.querySelector('[data-acc="' + id + '"]');
  if (body)   body.classList.add('open');
  if (header) header.classList.add('open');
});