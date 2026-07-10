// main.js — 4 Merge Cloud viewer
import * as THREE from './three/three.module.js';
import { OrbitControls } from './jsm/controls/OrbitControls.js';
import { TransformControls } from './jsm/controls/TransformControls.js';
import { loadPLY, loadXYZ } from './loaders/pointcloud_loaders.js';

// ── Versió i feature flags ────────────────────────────────────────────────────
const APP_VERSION = '2.27.0';
const FEATURES = {
  segmentacioSemantica: false,  // RANSAC + classificació per tipus
  completatBuits:       false,  // omplir forats basant-se en semàntica
  editorPlanta:         true,   // editor 2D estructurat (nodes + parets) → editor2d.js
};

// ── Diagnòstic ("caixa negra"): registre d'accions i errors per depurar ──
const _diagLog = [];
function diag(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  const line = '[' + t + '] ' + msg;
  _diagLog.push(line);
  if (_diagLog.length > 500) _diagLog.shift();
  try { console.log('◆ ' + line); } catch (_) {}
  try { _autoHealCheck(String(msg)); } catch (_) { /* mai propagar errors del healer al productor */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-RECUPERACIÓ ("self-heal") — patró detectat al diagnòstic → acció local
//
// Honest: NO és una IA que reescriu codi. És un catàleg de "circuit breakers":
// per errors coneguts en RUNTIME, executem localment una acció de recuperació
// prèviament codificada. Cada regla té cooldown perquè no entri en bucle si la
// recuperació també falla. Els errors NOUS o de codi (bug d'una funció) no els
// pot arreglar sol; els haurem d'atacar amb codi nou com hem fet fins ara.
// ══════════════════════════════════════════════════════════════════════════════
const _autoHealState = new Map();   // ruleId → { last, count, active }
let _autoHealEnabled = true;

const AUTOHEAL_RULES = [
  // 1) IndexedDB "higher version" — la BD ha estat pujada per un altre codi.
  //    Recuperació: obrir sense versió (agafa la que hi ha) i reintentar
  //    silenciosament l'auto-desat de sessió al proper trigger.
  {
    id: 'idb-higher-version',
    match: /higher version than the version requested/i,
    cooldownMs: 10_000,   // no reintentar més d'una vegada cada 10s
    label: 'BD navegador desactualitzada — reindexant',
    async heal() {
      // Estratègia: obrir amb versió = màxim conegut + 1 perquè el codi actual
      // s'adapti a l'schema real, i llavors reintentar persist al proper canvi.
      try {
        const info = await new Promise((res, rej) => {
          const r = indexedDB.open('mergecloud');   // sense versió: agafa l'actual
          r.onsuccess = () => { const v = r.result.version; r.result.close(); res(v); };
          r.onerror = () => rej(r.error);
        });
        // Si la app estava configurada per v2 i la BD real ja és v3+, no podem
        // canviar-ho des d'aquí (cal desplegament de codi). El que sí fem: silenciar
        // durant el cooldown perquè no torni a inundar el diagnòstic.
        return 'BD detectada v' + info + ' (silenciat durant el cooldown)';
      } catch (e) { return 'no s\'ha pogut obrir la BD: ' + e.message; }
    },
  },

  // 2) WebGL context lost — es pot recuperar sol demanant restore al renderer.
  {
    id: 'webgl-lost',
    match: /webgl.*context.*(lost|error creating)/i,
    cooldownMs: 30_000,
    label: 'context WebGL perdut — intentant restaurar',
    async heal() {
      try {
        const ext = renderer?.getContext?.().getExtension?.('WEBGL_lose_context');
        if (ext && ext.restoreContext) { ext.restoreContext(); return 'restore demanat al driver'; }
        return 'no es pot demanar restore (extensió no disponible)';
      } catch (e) { return 'restore ha fallat: ' + e.message; }
    },
  },

  // 3) Import dinàmic (editor2d) fallat — reintenta la importació al proper ús.
  {
    id: 'editor2d-load-fail',
    match: /editor2d.*(load|import).*fail/i,
    cooldownMs: 15_000,
    label: 'editor2d no s\'ha carregat — s\'esborra la cache d\'import',
    async heal() {
      _ed2d = null; _ed2dActive = false; _ed2dWired = false;
      return 'editor invalidat — es tornarà a importar al proper "Activar editor"';
    },
  },

  // 4) Persistència de sessió fallada per QuotaExceeded — netegem geometria vella.
  {
    id: 'idb-quota',
    match: /quota.*exceeded|storage.*full/i,
    cooldownMs: 60_000,
    label: 'espai al navegador ple — cal buidar sessió',
    async heal() {
      try { await idbDel(MC_KEY); return 'sessió auto-desada esborrada per alliberar espai'; }
      catch (e) { return 'no s\'ha pogut alliberar: ' + e.message; }
    },
  },

  // 5) Càrrega de fitxer avortada (net::ERR_ABORTED) — sovint pel servidor lent.
  //    L'usuari pot reintentar; només informem clarament.
  {
    id: 'load-aborted',
    match: /err_aborted|net::err_connection/i,
    cooldownMs: 20_000,
    label: 'càrrega de fitxer avortada per xarxa — considera reintentar (F5)',
    async heal() { return 'avís mostrat a l\'usuari'; },
  },
];

// Comprovador cridat a cada `diag(msg)`. Silenciós si no coincideix res.
async function _autoHealCheck(msg) {
  if (!_autoHealEnabled) return;
  const now = Date.now();
  for (const rule of AUTOHEAL_RULES) {
    if (!rule.match.test(msg)) continue;
    const st = _autoHealState.get(rule.id) || { last: 0, count: 0, active: false };
    if (st.active) return;                                    // ja hi estem
    if (now - st.last < rule.cooldownMs) return;              // en cooldown
    st.last = now; st.active = true; st.count += 1;
    _autoHealState.set(rule.id, st);
    // Escriu una entrada visible al diagnòstic (sense re-cridar diag() → evita bucle)
    const t = new Date().toTimeString().slice(0, 8);
    _diagLog.push('[' + t + '] 🔧 autocorrecció #' + st.count + ': ' + rule.label);
    if (_diagLog.length > 500) _diagLog.shift();
    try {
      const result = await rule.heal();
      const t2 = new Date().toTimeString().slice(0, 8);
      _diagLog.push('[' + t2 + '] 🔧 ✓ ' + rule.id + ': ' + result);
    } catch (e) {
      const t2 = new Date().toTimeString().slice(0, 8);
      _diagLog.push('[' + t2 + '] 🔧 ✗ ' + rule.id + ': ' + e.message);
    } finally {
      st.active = false;
      _autoHealState.set(rule.id, st);
    }
    return;   // una sola regla per crida
  }
}

// Accés programàtic (útil per depurar): window.autoHealStatus()
window.autoHealStatus = () => ({
  enabled: _autoHealEnabled,
  rules: AUTOHEAL_RULES.map(r => ({ id: r.id, label: r.label, state: _autoHealState.get(r.id) || null })),
});
window.autoHealSetEnabled = (b) => { _autoHealEnabled = !!b; return _autoHealEnabled; };

diag('app iniciada · v' + APP_VERSION);
diag('auto-recuperació: ' + AUTOHEAL_RULES.length + ' regles actives (' + AUTOHEAL_RULES.map(r=>r.id).join(', ') + ')');

// ── Parsers OBJ i GLB ────────────────────────────────────────────────────────
// ── Helpers d'imatge/textura (compartits per OBJ i textures externes) ──
async function _decodeImageFile(file) {
  try {
    const bmp = await createImageBitmap(file);
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const c2 = cv.getContext('2d', { willReadFrequently: true }); c2.drawImage(bmp, 0, 0);
    const id = c2.getImageData(0, 0, cv.width, cv.height);
    bmp.close?.();
    return id;
  } catch (_) { return null; }
}
function _sampleImageData(id, u, v) {
  let x = Math.floor((u - Math.floor(u)) * id.width);
  let y = Math.floor((1 - (v - Math.floor(v))) * id.height);   // V invertida (convenció OBJ/glTF)
  x = Math.min(Math.max(x, 0), id.width - 1);
  y = Math.min(Math.max(y, 0), id.height - 1);
  const o = (y * id.width + x) * 4;
  return [id.data[o] / 255, id.data[o + 1] / 255, id.data[o + 2] / 255];
}
// busca un fitxer company pel camí (relatiu o base), tolerant a barres i carpetes
function _findCompanion(path, companions) {
  if (!path || !companions) return null;
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (companions.has(p)) return companions.get(p);
  const base = p.split('/').pop();
  if (companions.has(base)) return companions.get(base);
  for (const [k, v] of companions) if (k === base || k.endsWith('/' + base)) return v;
  return null;
}
// resol la textura map_Kd d'un .mtl → ImageData (o null)
async function _resolveOBJTexture(mtlName, companions) {
  const mtlFile = _findCompanion(mtlName, companions);
  if (!mtlFile) return { id: null, reason: 'falta el .mtl' };
  const mtlText = await mtlFile.text();
  const mapLine = mtlText.split('\n').map(l => l.trim()).find(l => /^map_Kd\b/i.test(l));
  if (!mapLine) return { id: null, reason: 'el .mtl no té map_Kd' };
  const toks = mapLine.split(/\s+/);
  const texPath = toks[toks.length - 1];   // últim token (map_Kd pot dur opcions -o -s…)
  const texFile = _findCompanion(texPath, companions);
  if (!texFile) return { id: null, reason: 'falta la imatge ' + texPath };
  const id = await _decodeImageFile(texFile);
  return { id, reason: id ? null : 'no s\'ha pogut descodificar la imatge' };
}

async function loadOBJ(file, companions) {
  const text = await file.text();
  const positions = [], colors = [], vt = [];
  const vertexUV = [];        // vertexUV[i] = índex (0-based) dins vt per al vèrtex i
  let colorMax = 0, mtlName = null;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (raw.length < 2) continue;
    const p = raw.trim().split(/\s+/);
    const k = p[0];
    if (k === 'v') {
      positions.push(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
      if (p.length >= 7) {   // extensió color per vèrtex: v x y z r g b
        const r = parseFloat(p[4]), g = parseFloat(p[5]), b = parseFloat(p[6]);
        colors.push(isNaN(r)?1:r, isNaN(g)?1:g, isNaN(b)?1:b);
        colorMax = Math.max(colorMax, r||0, g||0, b||0);
      }
    } else if (k === 'vt') {
      vt.push(parseFloat(p[1]), parseFloat(p[2]));
    } else if (k === 'f') {
      const nV = positions.length / 3, nT = vt.length / 2;
      for (let c = 1; c < p.length; c++) {
        const seg = p[c].split('/');
        let vi = parseInt(seg[0]); if (isNaN(vi)) continue;
        vi = vi > 0 ? vi - 1 : nV + vi;
        if (seg[1]) {
          let ti = parseInt(seg[1]);
          if (!isNaN(ti)) { ti = ti > 0 ? ti - 1 : nT + ti; if (vertexUV[vi] === undefined) vertexUV[vi] = ti; }
        }
      }
    } else if (k === 'mtllib') {
      mtlName = p.slice(1).join(' ');
    }
  }
  if (positions.length === 0) throw new Error('Cap vèrtex trobat al fitxer OBJ');
  const nVerts = positions.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

  let hasCol = colors.length === positions.length && colors.length > 0;
  let colSrc = 'NO', note = '';
  if (hasCol) {
    const norm255 = colorMax > 1.001;
    if (norm255) for (let i = 0; i < colors.length; i++) colors[i] /= 255;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    colSrc = norm255 ? 'per vèrtex (0-255→0-1)' : 'per vèrtex';
  } else if (mtlName) {
    // Color en TEXTURA (map_Kd): mostreja la imatge a la UV de cada vèrtex
    const { id, reason } = await _resolveOBJTexture(mtlName, companions);
    if (id && vt.length) {
      const out = new Float32Array(nVerts * 3);
      let any = false;
      for (let i = 0; i < nVerts; i++) {
        const ti = vertexUV[i];
        if (ti === undefined) { out[i*3] = out[i*3+1] = out[i*3+2] = 1; continue; }
        const c = _sampleImageData(id, vt[ti*2], vt[ti*2+1]);
        out[i*3] = c[0]; out[i*3+1] = c[1]; out[i*3+2] = c[2]; any = true;
      }
      if (any) { geo.setAttribute('color', new THREE.BufferAttribute(out, 3)); hasCol = true; colSrc = 'mostrejat de textura'; }
    } else {
      note = ' — té textura al .mtl però ' + (reason || 'no s\'ha pogut carregar') + '. Arrossega la CARPETA sencera (obj + mtl + textures) per veure el color.';
    }
  }
  const mat = new THREE.PointsMaterial({ size: 0.025, vertexColors: hasCol, color: hasCol ? 0xffffff : 0xcccccc });
  console.log(`OBJ carregat: ${nVerts} punts · color: ${colSrc}${note}`);
  diag('OBJ ' + file.name + ': ' + nVerts + ' punts · color: ' + colSrc + note);
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
  const dvb = binBuf ? new DataView(binBuf) : null;

  // Llegeix un accessor respectant byteStride (entrellaçat) i normalització
  function readAccessor(idx) {
    const acc = gltf.accessors[idx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const comp = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4 }[acc.type] || 3;
    const ct = acc.componentType;
    const bpe = ct === 5126 ? 4 : (ct === 5123 || ct === 5122) ? 2 : 1;
    const stride = bv.byteStride || comp * bpe;
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const out = new Float32Array(acc.count * comp);
    for (let i = 0; i < acc.count; i++) {
      const eo = base + i * stride;
      for (let c = 0; c < comp; c++) {
        const o = eo + c * bpe;
        let v;
        if      (ct === 5126) v = dvb.getFloat32(o, true);
        else if (ct === 5125) v = dvb.getUint32(o, true);
        else if (ct === 5123) v = dvb.getUint16(o, true);
        else if (ct === 5122) v = dvb.getInt16(o, true);
        else if (ct === 5121) v = dvb.getUint8(o);
        else                  v = dvb.getInt8(o);
        if (acc.normalized) {
          if      (ct === 5121) v /= 255;
          else if (ct === 5123) v /= 65535;
          else if (ct === 5120) v = Math.max(v / 127, -1);
          else if (ct === 5122) v = Math.max(v / 32767, -1);
        }
        out[i * comp + c] = v;
      }
    }
    return { data: out, comp, count: acc.count };
  }

  // Decodifica una imatge del GLB (bufferView incrustat o data URI) → ImageData per mostrejar
  async function decodeImage(imageIndex) {
    const img = gltf.images?.[imageIndex];
    if (!img) return null;
    let blob;
    if (img.bufferView != null && binBuf) {
      const bv = gltf.bufferViews[img.bufferView];
      const start = bv.byteOffset || 0;
      blob = new Blob([binBuf.slice(start, start + bv.byteLength)], { type: img.mimeType || 'image/png' });
    } else if (img.uri && img.uri.startsWith('data:')) {
      blob = await (await fetch(img.uri)).blob();
    } else {
      return null;   // textura externa (uri a fitxer): no disponible en pujar només el GLB
    }
    try {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      const c2 = cv.getContext('2d', { willReadFrequently: true }); c2.drawImage(bmp, 0, 0);
      const id = c2.getImageData(0, 0, cv.width, cv.height);
      bmp.close?.();
      return id;
    } catch (_) { return null; }
  }
  // mostreig bilineal simple (nearest) amb wrap repeat i V invertida (convenció glTF)
  function sampleTex(id, u, v) {
    let x = Math.floor((u - Math.floor(u)) * id.width);
    let y = Math.floor((1 - (v - Math.floor(v))) * id.height);
    x = Math.min(Math.max(x, 0), id.width - 1);
    y = Math.min(Math.max(y, 0), id.height - 1);
    const o = (y * id.width + x) * 4;
    return [id.data[o] / 255, id.data[o + 1] / 255, id.data[o + 2] / 255];
  }
  const _texCache = new Map();
  async function getTexImageData(texIndex) {
    if (_texCache.has(texIndex)) return _texCache.get(texIndex);
    const src = gltf.textures?.[texIndex]?.source;
    const id = (src != null) ? await decodeImage(src) : null;
    _texCache.set(texIndex, id);
    return id;
  }

  const allPos = [], allCol = [];
  let anyCol = false, sampledTex = false, sawTexture = false;
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const posIdx = prim.attributes?.POSITION;
      if (posIdx == null || !dvb) continue;
      const pos = readAccessor(posIdx);
      for (let i = 0; i < pos.count; i++) allPos.push(pos.data[i*pos.comp], pos.data[i*pos.comp+1], pos.data[i*pos.comp+2]);
      const colIdx = prim.attributes?.COLOR_0;
      const matDef = (prim.material != null) ? gltf.materials?.[prim.material] : null;
      const pbr = matDef?.pbrMetallicRoughness;
      const bct = pbr?.baseColorTexture;
      if (bct) sawTexture = true;
      const uvIdx = bct ? (prim.attributes?.['TEXCOORD_' + (bct.texCoord || 0)] ?? prim.attributes?.TEXCOORD_0) : null;
      if (colIdx != null) {
        // 1) color per vèrtex (COLOR_0)
        anyCol = true;
        const col = readAccessor(colIdx);
        let mx = 0; for (let k = 0; k < col.data.length; k++) mx = Math.max(mx, col.data[k]);
        const div = mx > 1.001 ? 255 : 1;
        for (let i = 0; i < pos.count; i++) allCol.push(col.data[i*col.comp]/div, col.data[i*col.comp+1]/div, col.data[i*col.comp+2]/div);
      } else if (bct && uvIdx != null) {
        // 2) color en TEXTURA → mostreja la imatge a la UV de cada vèrtex
        const id = await getTexImageData(bct.index);
        const uv = readAccessor(uvIdx);
        const f = pbr.baseColorFactor || [1, 1, 1, 1];
        if (id) {
          anyCol = true; sampledTex = true;
          for (let i = 0; i < pos.count; i++) {
            const c = sampleTex(id, uv.data[i*uv.comp], uv.data[i*uv.comp+1]);
            allCol.push(c[0]*f[0], c[1]*f[1], c[2]*f[2]);
          }
        } else {
          for (let i = 0; i < pos.count; i++) allCol.push(1, 1, 1);
        }
      } else if (pbr?.baseColorFactor) {
        // 3) sense textura ni COLOR_0: color base pla del material
        anyCol = true;
        const f = pbr.baseColorFactor;
        for (let i = 0; i < pos.count; i++) allCol.push(f[0], f[1], f[2]);
      } else {
        for (let i = 0; i < pos.count; i++) allCol.push(1, 1, 1);   // res → blanc (manté el compte)
      }
    }
  }
  if (allPos.length === 0) throw new Error('Cap geometria trobada al GLB');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allPos), 3));
  if (anyCol) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(allCol), 3));
  const mat = new THREE.PointsMaterial({ size: 0.025, vertexColors: anyCol, color: anyCol ? 0xffffff : 0xcccccc });
  const colSrc = sampledTex ? 'sí (mostrejat de textura)' : (anyCol ? 'sí (per vèrtex/material)' : 'NO');
  console.log(`GLB carregat: ${allPos.length/3} punts · color: ${colSrc}${!sampledTex && sawTexture && !anyCol ? ' — textura present però no s\'ha pogut mostrejar (potser externa)' : ''}`);
  diag('GLB ' + file.name + ': ' + (allPos.length/3) + ' punts · color: ' + colSrc);
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

// ── Traducció de la interfície (etiquetes estàtiques CA → EN) ─────────────────
// El commutador CAT/ENG recarrega amb ?lang=en; aquí traduïm el text del DOM.
const I18N = {
  // Barra superior
  'Obrir':'Open','Unir':'Merge','Descarregar':'Download','Desar projecte':'Save project','Desfer últim':'Undo last','Diagnòstic':'Diagnostics',
  // Pestanyes / mòduls
  'NÚVOL':'CLOUD','DIBUIX':'DRAWING',
  // Càrrega
  'Carregar Fitxer (XYZ/PLY/OBJ/GLB)':'Load File (XYZ/PLY/OBJ/GLB)',
  'ARROSSEGA FITXERS O UNA CARPETA AQUÍ':'DRAG FILES OR A FOLDER HERE',
  'OBJ amb textura?':'Textured OBJ?','Carrega la carpeta sencera':'Load the whole folder',
  '(obj + mtl + textures) per veure\'n el color':'(obj + mtl + textures) to see its color',
  'Núvols carregats':'Loaded clouds','Cap núvol actiu':'No active cloud',
  'Cap núvol carregat. Comença carregant un fitxer PLY o XYZ.':'No cloud loaded. Start by loading a PLY or XYZ file.',
  // Accordions
  'Propietats':'Properties','Moure Núvol / Rotar Núvol':'Move Cloud / Rotate Cloud','Caixa de Tall':'Clipping Box',
  'Alinear 2 Punts / ICP':'Align 2 Points / ICP','Clean & Markup':'Clean & Markup','Carregar DXF Overlay':'Load DXF Overlay','Filtre de Soroll (SOR)':'Noise Filter (SOR)',
  // Botons NÚVOL
  'Moure Núvol':'Move Cloud','Rotar Núvol':'Rotate Cloud','Transformació Numèrica':'Numeric Transform',
  'Crear Caixa de Tall':'Create Clipping Box','Moure Caixa':'Move Box','Rotar Caixa':'Rotate Box',
  'Aplicar Tall (Definitiu)':'Apply Cut (Final)','Eliminar Caixa':'Remove Box','Exportar Secció DXF':'Export Section DXF',
  'Alinear 2 punts':'Align 2 points','Alinear 3 punts':'Align 3 points','Ajustar ICP (finor)':'Fine-tune ICP',
  'Dibuix / Anotació':'Draw / Annotate','Lliure':'Freehand','Línia':'Line','Fletxa':'Arrow','Desfer traç':'Undo stroke',
  'Importar Contorn DXF':'Import DXF Outline','Aplicar Filtre':'Apply Filter','Aplicar':'Apply','Cancel·lar':'Cancel',
  'Desfer':'Undo','Mesura':'Measure','Cotes':'Dimensions','REINICIAR TOT':'RESET ALL','Netejar':'Clear','Rectangle':'Rectangle',
  // DIBUIX (editor CAD)
  'Parets':'Walls','Perímetre':'Perimeter','Editar':'Edit','Esborrar':'Erase','Gruix':'Thickness','Seleccionar (multi)':'Select (multi)',
  'Empalme':'Fillet','Allargar':'Extend','Retallar':'Trim','Portes / Finestres':'Doors / Windows','Porta':'Door','Finestra':'Window',
  'Doble':'Double','Centrat':'Centered','Costat A':'Side A','Costat B':'Side B','Mesurar del núvol':'Measure from cloud',
  'Aplicar gruix a totes':'Apply thickness to all','Esborrar selecció':'Delete selection','Exportar DXF':'Export DXF','Activar editor':'Activate editor',
  // Benvinguda
  'Benvingut/da a 4 Merge Cloud':'Welcome to 4 Merge Cloud',
  'L\'editor 3D i Copilot IA de núvols de punts de referència':'The 3D editor and AI Copilot for reference point clouds',
  'Arrossegar o Carregar Fitxer de Punts':'Drag or Load a Point File','Carrega fitxer DXF Overlay':'Load DXF Overlay file',
  'Explorar ordinador →':'Browse computer →','Importar contorn vector →':'Import vector outline →',
  // Marca / IA
  'Visor i Editor 3D de Núvols de Punts':'3D Point Cloud Viewer & Editor',
  'Copilot IA — Línia de Comandes':'AI Copilot — Command Line',
};
const I18N_ATTR = {
  // placeholders
  'gruix (m)':'thickness (m)',
  'Escriu una ordre o pregunta (ex: vista de planta, aplica filtre soroll)…':'Type a command or question (e.g. top view, apply noise filter)…',
  // tooltips barra superior
  'Obrir fitxers o una carpeta (XYZ/PLY/OBJ/GLB o un projecte .4mc)':'Open files or a folder (XYZ/PLY/OBJ/GLB or a .4mc project)',
  'Uneix tots els núvols carregats en un de sol dins l\'escena (no descarrega)':'Merge all loaded clouds into one in the scene (does not download)',
  'Descarrega el núvol (o núvols) actuals com a fitxer XYZ':'Download the current cloud(s) as an XYZ file',
  'Desfà l\'última acció':'Undo the last action','Registre de diagnòstic':'Diagnostics log',
  'Amagar el panell':'Hide panel','Mostrar el panell d\'eines':'Show tools panel',
  // vistes
  'Vista 3D':'3D View','Vista en Planta':'Top View','Vista Frontal':'Front View','Vista Posterior':'Back View','Lateral Dreta':'Right Side','Lateral Esquerra':'Left Side',
};
function _translateUI() {
  document.documentElement.lang = window.APP_LANG || 'ca';   // activa els estils :lang() (estats buits ::before)
  if (window.APP_LANG !== 'en') return;
  const trText = (s) => {
    const m = s.match(/^([\p{S}\p{P}\s]*?)([\p{L}\p{N}].*)$/su);
    const pre = m ? m[1] : '', label = (m ? m[2] : s).trim();
    const tr = I18N[label];
    return tr != null ? pre + tr : null;
  };
  const roots = ['topBar','sidebox','welcomeScreen','diagPanel','branding','viewToolbar','cmdLine']
    .map(id => document.getElementById(id)).filter(Boolean);
  for (const root of roots) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
    for (const n of nodes) { if (!n.nodeValue || !n.nodeValue.trim()) continue; const tr = trText(n.nodeValue); if (tr != null && tr !== n.nodeValue) n.nodeValue = tr; }
    root.querySelectorAll('[title]').forEach(el => { const t = I18N_ATTR[el.getAttribute('title')]; if (t) el.setAttribute('title', t); });
    root.querySelectorAll('[placeholder]').forEach(el => { const t = I18N_ATTR[el.getAttribute('placeholder')]; if (t) el.setAttribute('placeholder', t); });
  }
}

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
let alignTgtCloud = null;   // núvol de destí (per al reforç de color+posició)

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
  // IMPORTANT: NO fer `material.needsUpdate = true` cada frame — recompila el
  // shader a cada fotograma i deixa la navegació lenta quan hi ha caixa de tall.
  // Es creen els plans un sol cop i després es MUTEN in-place (sense recompilar);
  // només es marca needsUpdate quan canvia el NOMBRE de plans (activa/desactiva clipping).
  clouds.forEach(cloud => {
    const mat = cloud.material;
    if (!mat) return;
    const box = cloud.userData.clipBox;
    if (!box) {
      if (mat.clippingPlanes && mat.clippingPlanes.length) { mat.clippingPlanes = []; mat.needsUpdate = true; }
      return;
    }
    box.updateMatrixWorld(true);
    if (!mat.clippingPlanes || mat.clippingPlanes.length !== LOCAL_CLIP_PLANES.length) {
      mat.clippingPlanes = LOCAL_CLIP_PLANES.map(() => new THREE.Plane());
      mat.needsUpdate = true;   // només quan (re)apareix el clipping
    }
    for (let i = 0; i < LOCAL_CLIP_PLANES.length; i++) {
      mat.clippingPlanes[i].copy(LOCAL_CLIP_PLANES[i]).applyMatrix4(box.matrixWorld);
    }
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
  diag('REINICIAR TOT');

  // Esborra també el dibuix de l'editor i el desat (perquè "reiniciar" netegi de veritat)
  try {
    if (_ed2d) { _ed2d.clear(); }
    localStorage.removeItem('mc_editor_state');
    if (_ed2dActive) toggleEditor2D();
  } catch (e) { diag('reset editor error: ' + e.message); }

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
  if (_picking) _pickStop();
  _pickBuffer = { at: null, color: null, count: 0, clouds: [] };

  transformControls.detach();
  setMode('none');

  const measureBadge = document.getElementById('measureBadge');
  if (measureBadge) measureBadge.style.display = 'none';
  const alignBadge = document.getElementById('alignBadge');
  if (alignBadge) alignBadge.style.display = 'none';

  updateCloudList();
  updateUndoBtn();
  updateMeasureList();
  persistSession(true);   // esborra també la sessió auto-desada
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
  alignSrcCloud = null; alignTgtCloud = null;
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
  if (!alignTgtCloud) alignTgtCloud = cloud;

  if (alignTgtPts.length === alignMode) {
    // captura referències abans que cancelAlign() netegi l'estat
    const srcC = alignSrcCloud, tgtC = alignTgtCloud;
    const anchors = alignTgtPts.map(p => p.clone());
    pushUndo(srcC);
    if (alignMode === 2) applyAlign2pt(srcC, alignSrcPts, alignTgtPts);
    else                 applyAlign3pt(srcC, alignSrcPts, alignTgtPts);
    cancelAlign();
    // Reforç automàtic: afinament local per color+posició de l'entorn dels punts
    refineAlignByColor(srcC, tgtC, anchors);
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
// ── Reforç d'alineació per COLOR + POSICIÓ de l'entorn dels punts picats ──────
// Mostreja els punts (posició món + color) al voltant dels anchors, dins un radi.
function _sampleEnv(cloud, anchorsWorld, radius, maxPts) {
  cloud.updateMatrixWorld(true);
  const pos = cloud.geometry.getAttribute('position');
  const col = cloud.geometry.getAttribute('color');
  if (!pos) return [];
  const mw = cloud.matrixWorld, r2 = radius * radius, v = new THREE.Vector3();
  const stride = Math.max(1, Math.floor(pos.count / 300000));   // acota el recorregut
  const out = [];
  for (let i = 0; i < pos.count; i += stride) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    let near = false;
    for (const a of anchorsWorld) { const dx=v.x-a.x, dy=v.y-a.y, dz=v.z-a.z; if (dx*dx+dy*dy+dz*dz <= r2) { near = true; break; } }
    if (!near) continue;
    out.push({ x:v.x, y:v.y, z:v.z, c: col ? [col.getX(i), col.getY(i), col.getZ(i)] : null });
    if (out.length >= maxPts) break;
  }
  return out;
}

// Veí que minimitza dist_posició² + colorW·dist_color²: el COLOR guia la
// correspondència (troba el mateix punt encara que la posició sigui ambigua),
// no només la filtra. Retorna també la distància de color del match triat.
function _nearestColor(p, tgtEnv, hash, cell, colorW) {
  const kx=Math.floor(p.x/cell), ky=Math.floor(p.y/cell), kz=Math.floor(p.z/cell);
  let best=Infinity, bi=-1, bd=Infinity, bc=0;
  for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++) {
    const bucket=hash.get(`${kx+dx},${ky+dy},${kz+dz}`);
    if (!bucket) continue;
    for (const i of bucket) {
      const q=tgtEnv[i];
      const dp=(q.x-p.x)**2+(q.y-p.y)**2+(q.z-p.z)**2;
      let dc=0;
      if (colorW>0 && p.c && q.c) dc=(p.c[0]-q.c[0])**2+(p.c[1]-q.c[1])**2+(p.c[2]-q.c[2])**2;
      const score=dp+colorW*dc;
      if (score<best) { best=score; bi=i; bd=Math.sqrt(dp); bc=Math.sqrt(dc); }
    }
  }
  return { dist:bd, idx:bi, cdist:bc };
}

// ICP LOCAL (entorn dels punts) GUIAT per color → refina l'alineació manual per
// 2/3 punts. NO reintrodueix gir global: només ajusta l'entorn triat. Coarse-to-fine.
async function refineAlignByColor(srcCloud, tgtCloud, anchorsWorld) {
  if (!srcCloud || !tgtCloud || srcCloud === tgtCloud || !anchorsWorld || !anchorsWorld.length) return;
  const badge = document.getElementById('loadingBadge');
  try {
    const bb = new THREE.Box3().setFromObject(tgtCloud);
    const diagLen = bb.getSize(new THREE.Vector3()).length() || 1;   // NO 'diag' — feia shadow de la funció global diag()
    let spread = 0;
    for (let i=0;i<anchorsWorld.length;i++) for (let j=i+1;j<anchorsWorld.length;j++) spread = Math.max(spread, anchorsWorld[i].distanceTo(anchorsWorld[j]));
    let radius = Math.min(Math.max(spread * 1.4, diagLen * 0.10), diagLen * 0.5);
    if (!(radius > 1e-3)) radius = diagLen * 0.2;

    if (badge) { badge.style.display = 'block'; badge.textContent = '⏳ Afinant amb el color de l\'entorn…'; }
    await new Promise(r => setTimeout(r, 0));

    const srcEnv = _sampleEnv(srcCloud, anchorsWorld, radius, 4000);
    const tgtEnv = _sampleEnv(tgtCloud, anchorsWorld, radius, 6000);
    if (srcEnv.length < 20 || tgtEnv.length < 20) { if (badge) badge.style.display='none'; diag('reforç color: pocs punts a l\'entorn, s\'omet'); return; }
    const haveColor = srcEnv.some(p=>p.c) && tgtEnv.some(p=>p.c);
    let cell = Math.max(radius / 6, 0.02);   // coarse-to-fine: comença gruixut i afina

    let Rtot=[[1,0,0],[0,1,0],[0,0,1]], ttot=[0,0,0], prevErr=Infinity;
    let work = srcEnv.map(p => ({ x:p.x, y:p.y, z:p.z, c:p.c }));
    const COLOR_TH = 0.30;   // distància de color màxima del match (rebuig d'outliers)
    for (let it=0; it<26; it++) {
      const colorW = haveColor ? (6*cell)*(6*cell) : 0;   // el color guia la correspondència (pes en posició²)
      const hash = _buildHash(tgtEnv, cell);
      const sF=[], tF=[], dists=[];
      for (const p of work) {
        const { dist, idx, cdist } = _nearestColor(p, tgtEnv, hash, cell, colorW);
        if (idx < 0) continue;
        if (haveColor && p.c && tgtEnv[idx].c && cdist > COLOR_TH) continue;   // sense bon match de color → outlier
        sF.push(p); tF.push({ x:tgtEnv[idx].x, y:tgtEnv[idx].y, z:tgtEnv[idx].z }); dists.push(dist);
      }
      if (sF.length < 8) break;
      const ds=[...dists].sort((a,b)=>a-b);
      const th = ds[Math.floor(ds.length/2)] * 2.5 + 1e-6;
      const sK=[], tK=[];
      for (let i=0;i<sF.length;i++) if (dists[i] < th) { sK.push(sF[i]); tK.push(tF[i]); }
      if (sK.length < 8) break;
      let err=0; for (let i=0;i<sK.length;i++) err += (sK[i].x-tK[i].x)**2+(sK[i].y-tK[i].y)**2+(sK[i].z-tK[i].z)**2;
      err = Math.sqrt(err / sK.length);
      if (Math.abs(prevErr - err) < 1e-7) break;
      prevErr = err;
      const { R, t } = _kabsch(sK, tK);
      if (!isFinite(R[0][0]) || !isFinite(t[0])) break;
      for (const p of work) { const {x,y,z}=p; p.x=R[0][0]*x+R[0][1]*y+R[0][2]*z+t[0]; p.y=R[1][0]*x+R[1][1]*y+R[1][2]*z+t[1]; p.z=R[2][0]*x+R[2][1]*y+R[2][2]*z+t[2]; }
      Rtot=_m3mul(R,Rtot);
      ttot=[R[0][0]*ttot[0]+R[0][1]*ttot[1]+R[0][2]*ttot[2]+t[0], R[1][0]*ttot[0]+R[1][1]*ttot[1]+R[1][2]*ttot[2]+t[1], R[2][0]*ttot[0]+R[2][1]*ttot[1]+R[2][2]*ttot[2]+t[2]];
      if (it >= 1) cell = Math.max(radius / 50, cell * 0.8);   // afina progressivament (coarse-to-fine)
      if (it % 4 === 3) await new Promise(r => setTimeout(r, 0));
    }
    if (badge) { badge.style.display = 'none'; badge.textContent = '⏳ Carregant fitxer...'; }

    const vals=[...Rtot[0],...Rtot[1],...Rtot[2],...ttot];
    if (vals.some(v => !isFinite(v))) { diag('reforç color: resultat no vàlid, s\'omet'); return; }
    const mat = new THREE.Matrix4().set(
      Rtot[0][0],Rtot[0][1],Rtot[0][2],ttot[0],
      Rtot[1][0],Rtot[1][1],Rtot[1][2],ttot[1],
      Rtot[2][0],Rtot[2][1],Rtot[2][2],ttot[2], 0,0,0,1);
    // Seguretat: mesura el desplaçament REAL dels anchors; si és > radi, la correcció
    // ha divergit → l'ometem i deixem l'alineació manual tal com estava.
    let maxShift = 0;
    for (const a of anchorsWorld) { const b = a.clone().applyMatrix4(mat); maxShift = Math.max(maxShift, a.distanceTo(b)); }
    if (maxShift > radius) { diag('reforç color: correcció massa gran (' + maxShift.toFixed(2) + ' m), s\'omet'); return; }

    srcCloud.applyMatrix4(mat);
    srcCloud.updateMatrixWorld(true);
    syncClipBox(srcCloud);
    selectCloud(srcCloud);
    diag('reforç color+posició aplicat (err ' + (isFinite(prevErr) ? prevErr.toFixed(4) : '—') + ' m · radi ' + radius.toFixed(2) + ' m · color ' + (haveColor ? 'sí' : 'no') + ')');
  } catch (e) {
    if (badge) badge.style.display = 'none';
    console.warn('reforç color+posició error:', e);
    diag('⚠ reforç color ha fallat: ' + e.message);
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
// ═════════════════════════════════════════════════════════════════════════════
// SELECCIÓ PER TRAÇAT LLIURE (LLAÇ 2D → FRUSTUM 3D)
// L'usuari dibuixa un polígon a la pantalla; els punts del núvol la projecció
// dels quals cau dins del polígon queden RESSALTATS (color per vèrtex) i les
// seves coordenades + color originals es guarden a _pickBuffer per a la IA.
// No és destructiu: hi ha "Netejar" i "Copiar per a IA (JSON)".
// ═════════════════════════════════════════════════════════════════════════════

let _picking       = false;   // llaç de selecció actiu
let _pickPath      = [];      // punts pantalla del traç (viewer-space)
let _pickDrawing   = false;
let _pickW = 1, _pickH = 1;
let _pickColor     = [1, 0, 0];   // vermell per defecte (RGB 0-1)
// Estat de selecció per núvol
// { origColors:Float32Array, indices:Uint32Array }  →  per esborrar i restaurar
const _pickState  = new WeakMap();
// Buffer d'exportació IA (tots els núvols)
let _pickBuffer   = { at: null, color: null, count: 0, clouds: [] };

function _pickCanvas() { return document.getElementById('lassoCanvas'); }
function _pickVp(clientX, clientY) {
  const r = document.getElementById('viewer').getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}
function _pickClearOverlay() {
  const lc = _pickCanvas();
  lc.getContext('2d').clearRect(0, 0, lc.width, lc.height);
}
function _pickIsControlTarget(e) {
  return e.target && e.target.closest && e.target.closest('#sidebox, #lassoCancel');
}

function _pickStart() {
  if (_picking) { _pickStop(); return; }
  if (lassoErasing) _stopErase();   // no barregem amb l'esborrat
  _picking = true;
  _pickPath = []; _pickDrawing = false;
  transformControls.detach();

  const viewer = document.getElementById('viewer');
  _pickW = viewer.offsetWidth  || window.innerWidth;
  _pickH = viewer.offsetHeight || window.innerHeight;
  const lc = _pickCanvas();
  lc.width = _pickW; lc.height = _pickH;
  lc.style.display = 'block';

  const badge = document.getElementById('lassoBadge');
  if (badge) { badge.textContent = '✏ Selecció per traçat — dibuixa un contorn, deixa anar per aplicar'; badge.style.display = 'block'; badge.style.background = 'rgba(224,120,32,0.92)'; }
  document.getElementById('lassoCancel').style.display = 'block';
  document.getElementById('btnLassoPick')?.classList.add('active');
  viewer.classList.add('lasso-active');
  if (renderer) renderer.domElement.style.pointerEvents = 'none';

  viewer.addEventListener('pointerdown', _onPickDown, { passive:false });
  viewer.addEventListener('pointermove', _onPickMove, { passive:false });
  viewer.addEventListener('pointerup',   _onPickUp,   { passive:false });
  viewer.addEventListener('pointercancel', _onPickCancel, { passive:false });
}

function _pickStop() {
  _picking = false; _pickPath = []; _pickDrawing = false;
  const viewer = document.getElementById('viewer');
  viewer.removeEventListener('pointerdown', _onPickDown);
  viewer.removeEventListener('pointermove', _onPickMove);
  viewer.removeEventListener('pointerup',   _onPickUp);
  viewer.removeEventListener('pointercancel', _onPickCancel);
  if (renderer) renderer.domElement.style.pointerEvents = 'auto';
  viewer.classList.remove('lasso-active');
  const lc = _pickCanvas();
  lc.style.display = 'none';
  _pickClearOverlay();
  const badge = document.getElementById('lassoBadge');
  if (badge) { badge.style.display = 'none'; badge.style.background = ''; }
  document.getElementById('lassoCancel').style.display = 'none';
  document.getElementById('btnLassoPick')?.classList.remove('active');
}

function _onPickDown(e) {
  if (!_picking || _pickIsControlTarget(e)) return;
  e.preventDefault(); e.stopPropagation();
  _pickDrawing = true;
  _pickPath = [_pickVp(e.clientX, e.clientY)];
}
function _onPickMove(e) {
  if (!_picking || !_pickDrawing) return;
  e.preventDefault(); e.stopPropagation();
  _pickPath.push(_pickVp(e.clientX, e.clientY));
  _drawPickOverlay();
}
function _onPickUp(e) {
  if (!_picking || !_pickDrawing) return;
  e.preventDefault(); e.stopPropagation();
  _pickDrawing = false;
  _applyPick();
}
function _onPickCancel() { if (_picking) _pickStop(); }

function _drawPickOverlay() {
  if (_pickPath.length < 2) return;
  const lc = _pickCanvas(), ctx = lc.getContext('2d');
  ctx.clearRect(0, 0, lc.width, lc.height);
  ctx.beginPath();
  ctx.moveTo(_pickPath[0].x, _pickPath[0].y);
  for (let i = 1; i < _pickPath.length; i++) ctx.lineTo(_pickPath[i].x, _pickPath[i].y);
  ctx.closePath();
  const [r, g, b] = _pickColor;
  const rgba = (a) => `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},${a})`;
  ctx.fillStyle = rgba(0.14); ctx.fill();
  ctx.strokeStyle = rgba(0.95); ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]); ctx.stroke();
}

function _pickInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Aplica la selecció: projecta cada punt a pantalla, mira si és dins del polígon,
// pinta el color per vèrtex i guarda posicions+colors originals al _pickBuffer.
function _applyPick() {
  if (_pickPath.length < 6) { _pickStop(); return; }

  const W = _pickW, H = _pickH;
  const activeCam = (useOrtho && orthoCamera) ? orthoCamera : camera;
  const targets = clouds.filter(c => c.visible);
  if (targets.length === 0) { _pickStop(); return; }

  const badge = document.getElementById('loadingBadge');
  if (badge) badge.style.display = 'block';

  const poly = [..._pickPath];
  _pickStop();   // tanca visualment

  setTimeout(() => {
    let totalPicked = 0;
    _pickBuffer = { at: new Date().toISOString(), color: _pickColor.slice(), count: 0, clouds: [] };
    const vProj = new THREE.Vector3();
    const [pr, pg, pb] = _pickColor;

    for (const cloud of targets) {
      cloud.updateMatrixWorld(true);
      const mw = cloud.matrixWorld;
      const pos = cloud.geometry.getAttribute('position');
      let col = cloud.geometry.getAttribute('color');
      if (!pos) continue;

      // Assegura color-per-vèrtex (si el núvol no en tenia, el creem blanc)
      if (!col) {
        const arr = new Float32Array(pos.count * 3).fill(1);
        cloud.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        col = cloud.geometry.getAttribute('color');
        cloud.material.vertexColors = true;
        cloud.material.needsUpdate = true;
      }

      // Estat previ per aquest núvol (per si es torna a seleccionar): restaura colors abans d'aplicar
      const prev = _pickState.get(cloud);
      if (prev) {
        for (let i = 0; i < prev.indices.length; i++) {
          const idx = prev.indices[i], o = i * 3;
          col.setXYZ(idx, prev.origColors[o], prev.origColors[o + 1], prev.origColors[o + 2]);
        }
      }

      const idxs = [];
      const worldPoints = [];   // per al _pickBuffer (posicions absolutes)
      const origColors  = [];   // colors originals (abans de pintar)
      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i), wy = pos.getY(i), wz = pos.getZ(i);
        vProj.set(wx, wy, wz).applyMatrix4(mw).project(activeCam);
        if (vProj.z > 1 || vProj.z < -1) continue;   // fora del frustum
        const sx = (vProj.x + 1) / 2 * W;
        const sy = (1 - vProj.y) / 2 * H;
        if (!_pickInPolygon(sx, sy, poly)) continue;
        idxs.push(i);
        const wp = new THREE.Vector3(wx, wy, wz).applyMatrix4(mw);
        worldPoints.push({ x: +wp.x.toFixed(4), y: +wp.y.toFixed(4), z: +wp.z.toFixed(4),
                           r: col.getX(i), g: col.getY(i), b: col.getZ(i) });
        origColors.push(col.getX(i), col.getY(i), col.getZ(i));
      }

      if (idxs.length === 0) { _pickState.delete(cloud); continue; }

      // Aplica el color de ressaltat als índexs
      for (const idx of idxs) col.setXYZ(idx, pr, pg, pb);
      col.needsUpdate = true;

      _pickState.set(cloud, {
        origColors: new Float32Array(origColors),
        indices:    new Uint32Array(idxs),
      });

      _pickBuffer.clouds.push({ name: cloud.name || 'Núvol', count: idxs.length, points: worldPoints });
      totalPicked += idxs.length;
    }

    _pickBuffer.count = totalPicked;
    if (badge) badge.style.display = 'none';

    const info = document.getElementById('pickInfo');
    if (info) info.textContent = totalPicked > 0
      ? `${totalPicked.toLocaleString()} punts seleccionats en ${_pickBuffer.clouds.length} núvol(s)`
      : 'Cap punt dins del traçat';
    const exportBtn = document.getElementById('btnPickExport');
    if (exportBtn) exportBtn.disabled = totalPicked === 0;
    const repairBtn = document.getElementById('btnRepairSurface');
    if (repairBtn) repairBtn.disabled = totalPicked === 0;
    diag('llaç selecció: ' + totalPicked + ' punts en ' + _pickBuffer.clouds.length + ' núvol(s)');
  }, 20);
}

// Restaura els colors originals dels punts seleccionats a tots els núvols.
function _pickClearAll() {
  let n = 0;
  for (const cloud of clouds) {
    const st = _pickState.get(cloud);
    if (!st) continue;
    const col = cloud.geometry.getAttribute('color');
    if (col) {
      for (let i = 0; i < st.indices.length; i++) {
        const idx = st.indices[i], o = i * 3;
        col.setXYZ(idx, st.origColors[o], st.origColors[o + 1], st.origColors[o + 2]);
      }
      col.needsUpdate = true;
    }
    _pickState.delete(cloud); n += st.indices.length;
  }
  _pickBuffer = { at: null, color: null, count: 0, clouds: [] };
  const info = document.getElementById('pickInfo');
  if (info) info.textContent = n ? 'Selecció esborrada' : '';
  const exportBtn = document.getElementById('btnPickExport');
  if (exportBtn) exportBtn.disabled = true;
  const repairBtn = document.getElementById('btnRepairSurface');
  if (repairBtn) repairBtn.disabled = true;
}

// ═════════════════════════════════════════════════════════════════════════════
// REPARAR SUPERFÍCIE (bufada / soroll de paret)
// Estratègia:
//   1. Els punts SELECCIONATS són l'error (la bufada).
//   2. Es pren un ANELL de punts sans just al voltant (buffer exterior en 3D),
//      que són els que descriuen la geometria REAL de la paret.
//   3. RANSAC 3D sobre aquest anell → pla amb màxim consens (ignora outliers).
//   4. Els punts seleccionats es PROJECTEN sobre el pla (col·locats a la
//      paret real) i es respecten els seus colors. La geometria del núvol es
//      substitueix i es guarda pushUndo perquè es pugui desfer.
// ═════════════════════════════════════════════════════════════════════════════

// Ajusta un pla per Kabsch/SVD ràpid (mínims quadrats via matriu covariança)
// a partir d'un conjunt de punts. Retorna { n:[nx,ny,nz], d } tal que
// n·x + d = 0. Fallback si els punts són quasi degenerats.
function _fitPlaneLSQ(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let cx=0, cy=0, cz=0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx/=n; cy/=n; cz/=n;
  let xx=0, xy=0, xz=0, yy=0, yz=0, zz=0;
  for (const p of pts) {
    const dx=p[0]-cx, dy=p[1]-cy, dz=p[2]-cz;
    xx+=dx*dx; xy+=dx*dy; xz+=dx*dz; yy+=dy*dy; yz+=dy*dz; zz+=dz*dz;
  }
  const cov = [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
  const eig = _jacobiEig3(cov);
  // Vector propi de la MENOR variança = normal del pla
  let iMin = 0; if (eig.values[1] < eig.values[iMin]) iMin = 1; if (eig.values[2] < eig.values[iMin]) iMin = 2;
  const nx = eig.vectors[0][iMin], ny = eig.vectors[1][iMin], nz = eig.vectors[2][iMin];
  const norm = Math.hypot(nx, ny, nz) || 1;
  const nrm = [nx/norm, ny/norm, nz/norm];
  const d = -(nrm[0]*cx + nrm[1]*cy + nrm[2]*cz);
  return { n: nrm, d, centroid: [cx, cy, cz] };
}

// RANSAC 3D per pla: mostreja 3 punts a l'atzar, ajusta pla, compta inliers
// (distància < eps). Repeteix i queda't amb el millor. Refina amb LSQ dels inliers.
function _ransacPlane(worldPts, opts = {}) {
  const N = worldPts.length;
  if (N < 8) return null;
  const iters = opts.iters || 200;
  const eps   = opts.eps   || _ransacEstimateEps(worldPts);
  let best = { count: 0, plane: null, inliers: null };
  for (let it = 0; it < iters; it++) {
    const i1 = (Math.random()*N)|0, i2 = (Math.random()*N)|0, i3 = (Math.random()*N)|0;
    if (i1===i2 || i1===i3 || i2===i3) continue;
    const p1 = worldPts[i1], p2 = worldPts[i2], p3 = worldPts[i3];
    const e1 = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]];
    const e2 = [p3[0]-p1[0], p3[1]-p1[1], p3[2]-p1[2]];
    const nx = e1[1]*e2[2]-e1[2]*e2[1];
    const ny = e1[2]*e2[0]-e1[0]*e2[2];
    const nz = e1[0]*e2[1]-e1[1]*e2[0];
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) continue;
    const nrm = [nx/nl, ny/nl, nz/nl];
    const d = -(nrm[0]*p1[0] + nrm[1]*p1[1] + nrm[2]*p1[2]);
    // Comptem inliers
    let cnt = 0;
    for (let k = 0; k < N; k++) {
      const p = worldPts[k];
      if (Math.abs(nrm[0]*p[0] + nrm[1]*p[1] + nrm[2]*p[2] + d) < eps) cnt++;
    }
    if (cnt > best.count) best = { count: cnt, plane: { n: nrm, d } };
  }
  if (!best.plane) return null;
  // Refinament: LSQ sobre TOTS els inliers per estabilitzar la normal
  const inliers = [];
  const P = best.plane;
  for (let k = 0; k < N; k++) {
    const p = worldPts[k];
    if (Math.abs(P.n[0]*p[0] + P.n[1]*p[1] + P.n[2]*p[2] + P.d) < eps) inliers.push(p);
  }
  const refined = _fitPlaneLSQ(inliers) || P;
  return { plane: refined, inliers: inliers.length, total: N, eps };
}

// Estimació d'eps per RANSAC: 10% de la mitjana de distàncies al centroide
function _ransacEstimateEps(pts) {
  const n = pts.length; if (!n) return 0.05;
  let cx=0, cy=0, cz=0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx/=n; cy/=n; cz/=n;
  let s = 0;
  for (const p of pts) s += Math.hypot(p[0]-cx, p[1]-cy, p[2]-cz);
  const mean = s / n;
  return Math.max(0.01, mean * 0.05);
}

// Anell de punts SANS al voltant de la selecció:
// per cada punt del núvol NO seleccionat, mira si té algun veí (per hash espacial)
// que sí estigui seleccionat, dins d'un radi bufferR. Retorna posicions MÓN.
function _collectHealthyRing(cloud, selectedIdxs, bufferR) {
  cloud.updateMatrixWorld(true);
  const mw = cloud.matrixWorld;
  const pos = cloud.geometry.getAttribute('position');
  if (!pos) return { ring: [], selWorld: [] };

  // Punts seleccionats en MÓN (per construir el hash)
  const v = new THREE.Vector3();
  const selWorld = new Array(selectedIdxs.length);
  const selSet   = new Set();
  for (let i = 0; i < selectedIdxs.length; i++) {
    const idx = selectedIdxs[i];
    v.set(pos.getX(idx), pos.getY(idx), pos.getZ(idx)).applyMatrix4(mw);
    selWorld[i] = [v.x, v.y, v.z];
    selSet.add(idx);
  }
  const hash = _buildHash(selWorld.map(p => ({x:p[0], y:p[1], z:p[2]})), bufferR);
  const cell = bufferR;
  const r2   = bufferR * bufferR;

  // Cerca als NO seleccionats. Acota amb el mateix hash espacial: només vèrtexs
  // que la bucket del seu punt sigui adjacent a alguna bucket amb selecció.
  const ring = [];
  for (let i = 0; i < pos.count; i++) {
    if (selSet.has(i)) continue;
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mw);
    const kx = Math.floor(v.x / cell), ky = Math.floor(v.y / cell), kz = Math.floor(v.z / cell);
    let nearAny = false;
    outer:
    for (let dx=-1; dx<=1 && !nearAny; dx++)
      for (let dy=-1; dy<=1 && !nearAny; dy++)
        for (let dz=-1; dz<=1 && !nearAny; dz++) {
          const bucket = hash.get(`${kx+dx},${ky+dy},${kz+dz}`);
          if (!bucket) continue;
          for (const bi of bucket) {
            const q = selWorld[bi];
            const d2 = (q[0]-v.x)*(q[0]-v.x) + (q[1]-v.y)*(q[1]-v.y) + (q[2]-v.z)*(q[2]-v.z);
            if (d2 <= r2) { nearAny = true; break outer; }
          }
        }
    if (nearAny) ring.push([v.x, v.y, v.z]);
  }
  return { ring, selWorld, selSet };
}

// Projecta un punt món sobre un pla { n, d } en la mateixa direcció de la normal
function _projectOntoPlane(p, plane) {
  const s = plane.n[0]*p[0] + plane.n[1]*p[1] + plane.n[2]*p[2] + plane.d;
  return [p[0] - plane.n[0]*s, p[1] - plane.n[1]*s, p[2] - plane.n[2]*s];
}

// Executa el REPARAT: selecció actual + anell → pla RANSAC → projecta seleccionats
// sobre el pla i actualitza la geometria de cada núvol involucrat. pushUndo per
// poder desfer. Restaura els colors originals dels seleccionats (que estaven
// vermells/grocs pel ressaltat del llaç).
async function _repairSurface() {
  const sel = _pickBuffer;
  if (!sel || !sel.count) { alert('Fes primer una selecció amb el llaç.'); return; }

  const badge = document.getElementById('loadingBadge');
  if (badge) { badge.style.display = 'block'; badge.textContent = '⏳ Analitzant paret…'; }
  await new Promise(r => setTimeout(r, 0));

  const info = document.getElementById('pickInfo');
  const stats = { totalRepaired: 0, ringUsed: 0, resIn: 0, resTot: 0, clouds: 0, mmSaved: 0 };

  for (const cloud of clouds) {
    const st = _pickState.get(cloud);
    if (!st || st.indices.length === 0) continue;

    // Amplada del buffer exterior: 3× la mida mitjana de cel·la del núvol
    // (=aproximadament 3 vèrtexs "sans" al voltant de la selecció)
    cloud.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(cloud);
    const dsz = bbox.getSize(new THREE.Vector3()).length() || 1;
    const bufferR = Math.max(dsz / 200, 0.05);   // ≈ 5cm mínim

    if (badge) badge.textContent = '⏳ Buscant punts sans al voltant…';
    await new Promise(r => setTimeout(r, 0));
    const { ring, selWorld } = _collectHealthyRing(cloud, Array.from(st.indices), bufferR);
    if (ring.length < 12) {
      diag('reparar: núvol "' + (cloud.name||'Núvol') + '" no té prou punts sans al voltant (' + ring.length + '), s\'omet');
      continue;
    }

    if (badge) badge.textContent = '⏳ Ajustant pla (RANSAC)…';
    await new Promise(r => setTimeout(r, 0));
    const result = _ransacPlane(ring, { iters: 250 });
    if (!result || !result.plane) { diag('reparar: RANSAC no convergeix a "' + (cloud.name||'Núvol') + '"'); continue; }
    const plane = result.plane;

    // Projecta els punts seleccionats sobre el pla, mesura desplaçament mitjà
    // (per informar), i actualitza la geometria (posicions locals = worldInverse·nova).
    const pos = cloud.geometry.getAttribute('position');
    const col = cloud.geometry.getAttribute('color');
    const mw  = cloud.matrixWorld;
    const mwI = new THREE.Matrix4().copy(mw).invert();
    const vLocal = new THREE.Vector3();

    pushUndo(cloud, true);

    let sumShift = 0;
    for (let i = 0; i < st.indices.length; i++) {
      const idx = st.indices[i];
      const wp = selWorld[i];
      const np = _projectOntoPlane(wp, plane);
      sumShift += Math.hypot(np[0]-wp[0], np[1]-wp[1], np[2]-wp[2]);
      vLocal.set(np[0], np[1], np[2]).applyMatrix4(mwI);
      pos.setXYZ(idx, vLocal.x, vLocal.y, vLocal.z);
    }
    pos.needsUpdate = true;

    // Restaura els colors ORIGINALS dels seleccionats (treu el ressaltat vermell)
    if (col && st.origColors && st.origColors.length === st.indices.length * 3) {
      for (let i = 0; i < st.indices.length; i++) {
        const idx = st.indices[i], o = i * 3;
        col.setXYZ(idx, st.origColors[o], st.origColors[o+1], st.origColors[o+2]);
      }
      col.needsUpdate = true;
    }
    cloud.geometry.computeBoundingBox();
    cloud.geometry.computeBoundingSphere();
    _pickState.delete(cloud);

    stats.totalRepaired += st.indices.length;
    stats.ringUsed      += ring.length;
    stats.resIn         += result.inliers;
    stats.resTot        += result.total;
    stats.clouds        += 1;
    stats.mmSaved       += (sumShift / Math.max(1, st.indices.length)) * 1000;
  }

  if (badge) badge.style.display = 'none';
  _pickBuffer = { at: null, color: null, count: 0, clouds: [] };
  const exportBtn = document.getElementById('btnPickExport');
  if (exportBtn) exportBtn.disabled = true;
  const repairBtn = document.getElementById('btnRepairSurface');
  if (repairBtn) repairBtn.disabled = true;

  if (stats.clouds === 0) {
    if (info) info.textContent = 'No s\'ha pogut reparar cap superfície (poc anell sà o RANSAC no convergeix).';
    return;
  }
  const avgShift = (stats.mmSaved / stats.clouds).toFixed(0);
  const consens  = Math.round(100 * stats.resIn / Math.max(1, stats.resTot));
  const msg = '✓ ' + stats.totalRepaired.toLocaleString() + ' punts reparats — anell sà: ' + stats.ringUsed.toLocaleString() +
              ' pts · RANSAC consens: ' + consens + '% · desplaçament mitjà: ' + avgShift + ' mm';
  if (info) info.textContent = msg;
  diag('reparar superfície: ' + msg);
}

// Copia el JSON al porta-retalls (per enganxar-lo a la IA)
async function _pickExport() {
  if (!_pickBuffer.count) return;
  const json = JSON.stringify(_pickBuffer, null, 2);
  try { await navigator.clipboard.writeText(json); }
  catch (_) { const ta = document.createElement('textarea'); ta.value = json; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
  const info = document.getElementById('pickInfo');
  if (info) info.textContent = `✓ Copiat al porta-retalls (${_pickBuffer.count.toLocaleString()} punts, JSON)`;
  diag('llaç: JSON copiat (' + _pickBuffer.count + ' punts)');
}

// Retorna el buffer per accés programàtic (p.ex. des de la línia IA)
function getPickedPoints() { return _pickBuffer; }
window.getPickedPoints = getPickedPoints;

// ═════════════════════════════════════════════════════════════════════════════
// SEGMENTACIÓ SEMÀNTICA — client + backend provisional (STUB) + dataset local
//
// ⚠ AVÍS: aquesta app NO té connexió a un model 3D real (SAM3D, PointNet++…)
// perquè no en tenim un servei propi. La classificació es fa amb heurístiques
// senzilles (altura respecte al terra, color mitjà, forma) i està etiquetada
// com a "provisional" a la UI. El dia que tinguem endpoint real, es canvia
// BACKEND_URL i el contracte de resposta és el mateix.
// ═════════════════════════════════════════════════════════════════════════════

// Configuració — canviar aquí el dia que tinguem servei real
const SEG_BACKEND_URL = null;   // p.ex. 'https://api.4mc.example/segment'; null = STUB local

// Categories reconegudes (traducció mostrada a la UI)
const SEG_LABELS = ['paret', 'terra', 'sostre', 'porta', 'finestra', 'moble', 'columna', 'sanitari', 'coberta', 'vegetacio', 'altres'];
// Color de classificació per etiqueta (RGB 0-1) — servirà per pintar-los en confirmar
const SEG_COLORS = {
  paret:      [0.72, 0.72, 0.75],
  terra:      [0.55, 0.40, 0.28],
  sostre:     [0.90, 0.88, 0.85],
  porta:      [0.85, 0.55, 0.15],
  finestra:   [0.35, 0.65, 0.90],
  moble:      [0.65, 0.35, 0.20],
  columna:    [0.60, 0.60, 0.62],
  sanitari:   [0.90, 0.95, 0.98],
  coberta:    [0.40, 0.30, 0.25],
  vegetacio:  [0.35, 0.60, 0.30],
  altres:     [0.70, 0.30, 0.70],
};

// ── STUB: classificador heurístic (provisional) ──────────────────────────────
// Rep la selecció actual (_pickBuffer) i retorna la mateixa forma que el
// backend real ha de tornar: { label, confidence, provisional, alternatives }.
function _segStubClassify(sel) {
  const pts = sel.clouds.flatMap(c => c.points);
  if (pts.length === 0) return { label: 'altres', confidence: 0, provisional: true, alternatives: [] };

  // Estadística bàsica
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let sr = 0, sg = 0, sb = 0;
  for (const p of pts) {
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    sr += p.r; sg += p.g; sb += p.b;
  }
  const n = pts.length;
  const rr = sr/n, gg = sg/n, bb = sb/n;
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const luma = 0.299*rr + 0.587*gg + 0.114*bb;

  // Terra de referència = el mínim Y global dels núvols carregats (fallback: minY de la selecció)
  let floorY = minY;
  const bboxAll = _cloudWorldBBox && _cloudWorldBBox();
  if (bboxAll) floorY = bboxAll.min.y;
  const relY = (minY + maxY) / 2 - floorY;         // altura mitjana sobre el terra
  const totalH = bboxAll ? (bboxAll.max.y - bboxAll.min.y) : Math.max(dy, 1);

  // Puntuació per etiqueta (heurística — declaradament simple)
  const score = {};
  for (const L of SEG_LABELS) score[L] = 0;

  // Horitzontal molt pla i a baix → terra
  if (dy < 0.1 && relY < totalH * 0.1) score.terra += 0.9;
  // Horitzontal molt pla i a dalt → sostre / coberta
  if (dy < 0.1 && relY > totalH * 0.85) { score.sostre += 0.7; score.coberta += 0.55; }
  // Vertical prim (una cara), altura mitjana i llum grisa → paret
  const isVertical = dy > 0.6 && Math.min(dx, dz) < 0.15;
  if (isVertical && luma > 0.35 && luma < 0.85) score.paret += 0.75;
  // Vertical i amb amplada 0.6–1.1 m i altura ~1.9–2.2 → porta (guanya la paret per aquesta franja concreta)
  const width = Math.max(dx, dz);
  if (isVertical && width > 0.55 && width < 1.2 && dy > 1.7 && dy < 2.3) score.porta += 0.85;
  // Vertical i amb amplada > 0.6 i altura < 1.6 → finestra
  if (isVertical && width > 0.5 && dy > 0.5 && dy < 1.6 && bb > rr) score.finestra += 0.55;
  // Volum compacte (0.3–2 m) i colors saturats → moble
  const bulky = Math.min(dx, dy, dz) > 0.25 && Math.max(dx, dy, dz) < 2.5;
  const chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
  if (bulky && (chroma > 0.15 || luma < 0.35)) score.moble += 0.55;
  // Vertical alt i simètric → columna
  if (isVertical && Math.abs(dx - dz) < 0.2 && dy > totalH * 0.6) score.columna += 0.6;
  // Blanc molt lluminós i volum petit → sanitari (heurística molt feble)
  if (luma > 0.85 && bulky) score.sanitari += 0.4;
  // Verd → vegetació
  if (gg > rr + 0.05 && gg > bb + 0.05) score.vegetacio += 0.55;

  // "altres" sempre té una base mínima
  score.altres = 0.15;

  // Escull el guanyador
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  // Confidence: mai més de 0.75 (és heurístic, no cal donar falsa seguretat)
  const confidence = Math.max(0.2, Math.min(0.75, bestScore));
  const alternatives = ranked.slice(1, 4).map(([lab, s]) => ({ label: lab, confidence: Math.min(0.6, Math.max(0.1, s)) }));

  return { label: best, confidence, provisional: true, alternatives };
}

// Prediu la classe de la selecció actual (backend real si BACKEND_URL, si no stub)
async function segPredict() {
  const sel = _pickBuffer;
  if (!sel || !sel.count) return null;
  if (SEG_BACKEND_URL) {
    try {
      const resp = await fetch(SEG_BACKEND_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: sel.clouds.flatMap(c => c.points).map(p => [p.x, p.y, p.z, p.r, p.g, p.b]) }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();   // { label, confidence, provisional?, alternatives? }
    } catch (e) { diag('⚠ segment backend fallat, uso stub: ' + e.message); return _segStubClassify(sel); }
  }
  return _segStubClassify(sel);
}

// ── Aplicació de la classificació al núvol ───────────────────────────────────
// Pinta els punts seleccionats amb el color de la categoria i marca les seves
// etiquetes semàntiques al núvol (userData.semantic). Es guarda una entrada
// pel dataset local d'entrenament.
function segApply(label, opts = {}) {
  const sel = _pickBuffer;
  if (!sel || !sel.count) return 0;
  const rgb = SEG_COLORS[label] || SEG_COLORS.altres;
  const meta = { label, ts: Date.now(), correctedFrom: opts.correctedFrom || null };

  for (const cloud of clouds) {
    const st = _pickState.get(cloud);
    if (!st) continue;
    const col = cloud.geometry.getAttribute('color');
    if (!col) continue;
    // Pinta els punts amb el color de la categoria
    for (let i = 0; i < st.indices.length; i++) {
      const idx = st.indices[i];
      col.setXYZ(idx, rgb[0], rgb[1], rgb[2]);
    }
    col.needsUpdate = true;
    // Guarda l'etiqueta per índex al userData (metadades semàntiques del núvol)
    if (!cloud.userData.semantic) cloud.userData.semantic = new Map();
    for (let i = 0; i < st.indices.length; i++) cloud.userData.semantic.set(st.indices[i], meta);
    // La selecció ja no és "vermell reversible": es converteix en assignació definitiva
    _pickState.delete(cloud);
  }

  // Dataset local (train store)
  segTrainSave({
    id: 'seg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    at: new Date().toISOString(),
    label,
    correctedFrom: opts.correctedFrom || null,
    source: opts.source || (opts.correctedFrom ? 'user_correction' : 'user_confirmation'),
    count: sel.count,
    clouds: sel.clouds.map(c => ({ name: c.name, count: c.count, points: c.points })),   // punts en món amb r,g,b originals
  }).catch(e => diag('⚠ segTrainSave: ' + e.message));

  const nWas = sel.count;
  _pickBuffer = { at: null, color: null, count: 0, clouds: [] };
  const exportBtn = document.getElementById('btnPickExport');
  if (exportBtn) exportBtn.disabled = true;
  const repairBtn = document.getElementById('btnRepairSurface');
  if (repairBtn) repairBtn.disabled = true;
  const info = document.getElementById('pickInfo');
  if (info) info.textContent = `✓ ${nWas.toLocaleString()} punts etiquetats com a "${label}" ${opts.correctedFrom ? '(correcció)' : ''}`;
  return nWas;
}

// ── Dataset local d'entrenament (IndexedDB store 'segTrain') ─────────────────
const SEG_DB = 'mergecloud', SEG_STORE = 'segTrain';
function _segTrainDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SEG_DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');   // reutilitza l'store existent
      if (!db.objectStoreNames.contains(SEG_STORE)) db.createObjectStore(SEG_STORE, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function segTrainSave(entry) {
  const db = await _segTrainDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(SEG_STORE, 'readwrite');
    tx.objectStore(SEG_STORE).put(entry);
    tx.oncomplete = () => res(entry.id); tx.onerror = () => rej(tx.error);
  });
}
async function segTrainList() {
  const db = await _segTrainDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(SEG_STORE, 'readonly');
    const rq = tx.objectStore(SEG_STORE).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
  });
}
async function segTrainClear() {
  const db = await _segTrainDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(SEG_STORE, 'readwrite');
    tx.objectStore(SEG_STORE).clear();
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function segTrainExport() {
  const list = await segTrainList();
  const bundle = { format: '4mc-segment-training', version: 1, at: new Date().toISOString(), count: list.length, samples: list };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'segment_training_' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return list.length;
}
window.segTrainList = segTrainList;   // accés programàtic

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
  if (e.key === 'Escape' && _picking) _pickStop();
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

  const CLOUD_EXTS = ['ply', 'xyz', 'txt', 'obj', 'glb', 'gltf'];

  async function handleFiles(fileList) {
    if (_loading || !fileList) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;
    _loading = true;
    // Mapa de fitxers "companys" (per resoldre .mtl i textures dels OBJ):
    // s'indexen pel nom base i pel camí relatiu (carpeta) en minúscules.
    const companions = new Map();
    for (const f of files) {
      companions.set(f.name.toLowerCase(), f);
      const rp = (f.relPath || f.webkitRelativePath || '').toLowerCase();
      if (rp) companions.set(rp, f);
    }
    // Projecte .4mc → restaura núvols + dibuix i acaba
    const projFile = files.find(f => f.name.toLowerCase().endsWith('.4mc'));
    if (projFile) {
      const badge0 = document.getElementById('loadingBadge');
      try { if (badge0) badge0.style.display = 'block'; await loadProject(projFile); }
      catch (e) { diag('⚠ error projecte: ' + e.message); alert('Error obrint el projecte: ' + e.message); }
      finally { if (badge0) badge0.style.display = 'none'; _loading = false; fileInput.value = ''; }
      return;
    }
    const cloudFiles = files.filter(f => CLOUD_EXTS.includes(f.name.split('.').pop().toLowerCase()));
    if (cloudFiles.length === 0) { _loading = false; alert('No he trobat cap núvol (.ply .xyz .obj .glb) entre els fitxers.'); return; }
    const badge = document.getElementById('loadingBadge');
    try {
      for (const file of cloudFiles) {
        const ext = file.name.split('.').pop().toLowerCase();
        let cloud = null;
        diag('càrrega: ' + file.name + ' (' + ext + ', ' + Math.round(file.size/1024) + ' KB)');
        if (badge) badge.style.display = 'block';
        try {
          if      (ext === 'ply')                cloud = await loadPLY(file);
          else if (ext === 'xyz' || ext === 'txt') cloud = await loadXYZ(file);
          else if (ext === 'obj')                cloud = await loadOBJ(file, companions);
          else if (ext === 'glb' || ext === 'gltf') cloud = await loadGLB(file);
          else { alert(T.unsupported(ext)); continue; }
        } catch (err) {
          console.error('Error carregant núvol:', err);
          diag('⚠ error càrrega ' + file.name + ': ' + err.message);
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
        diag('carregat OK: ' + file.name + ' · ' + (cloud.geometry.attributes.position.count) + ' punts · total núvols: ' + clouds.length);
      }
    } finally {
      _loading = false;
      fileInput.value = '';
    }
  }

  // Recull els fitxers d'un drop, entrant dins les CARPETES (per obtenir .mtl + textures/)
  async function gatherDropFiles(dt) {
    const items = dt.items;
    if (!items || !items.length || !items[0].webkitGetAsEntry) return Array.from(dt.files || []);
    const roots = [];
    for (const it of items) { const e = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (e) roots.push(e); }
    if (roots.length === 0) return Array.from(dt.files || []);
    const out = [];
    async function walk(entry, path) {
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        try { Object.defineProperty(f, 'relPath', { value: path + entry.name, configurable: true }); } catch (_) {}
        out.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => new Promise((res, rej) => reader.readEntries(res, rej));
        let batch;
        do { batch = await readBatch(); for (const e of batch) await walk(e, path + entry.name + '/'); } while (batch.length);
      }
    }
    for (const e of roots) await walk(e, '');
    return out;
  }

  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  const dirInput = document.getElementById('dirInput');
  if (dirInput) dirInput.addEventListener('change', (e) => handleFiles(e.target.files));

  // ── Drag & Drop al loadArea i al viewer (accepta carpetes) ──
  ['loadArea', 'viewer'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const files = await gatherDropFiles(e.dataTransfer);
      handleFiles(files);
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
  document.getElementById('lassoCancel').onclick = () => { if (_picking) _pickStop(); else _stopErase(); };

  // ── Selecció per traçat (llaç → frustum 3D) ──
  document.getElementById('btnLassoPick')?.addEventListener('click', () => {
    cancelAlign();
    if (lassoErasing) _stopErase();
    _pickStart();
  });
  document.getElementById('btnPickClear')?.addEventListener('click', _pickClearAll);
  document.getElementById('btnPickExport')?.addEventListener('click', _pickExport);
  document.getElementById('btnRepairSurface')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnRepairSurface');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Reparant…'; }
    try { await _repairSurface(); }
    catch (e) { diag('⚠ reparar superfície: ' + e.message); alert('Error reparant: ' + e.message); }
    finally { if (btn) { btn.textContent = '🔧 Reparar Superfície'; btn.disabled = true; } }
  });
  const _setPickColor = (rgb, btnId) => {
    _pickColor = rgb.slice();
    ['btnPickColorRed','btnPickColorYellow'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(btnId)?.classList.add('active');
  };
  document.getElementById('btnPickColorRed')?.addEventListener('click',    () => _setPickColor([1, 0.15, 0.15], 'btnPickColorRed'));
  document.getElementById('btnPickColorYellow')?.addEventListener('click', () => _setPickColor([1, 0.85, 0.15], 'btnPickColorYellow'));

  // ── Segmentació semàntica (client + STUB) ──
  let _lastPred = null;   // última predicció (per corregir/confirmar)
  const $ = (id) => document.getElementById(id);
  const _segShowResult = (pred) => {
    _lastPred = pred;
    $('segLabel').textContent = pred.label + (pred.provisional ? ' (provisional)' : '');
    $('segConf').textContent = 'Confiança: ' + Math.round((pred.confidence || 0) * 100) + '% · font: ' + (SEG_BACKEND_URL ? 'backend' : 'stub heurístic');
    $('segResult').style.display = 'block';
    $('segCorrect').style.display = 'none';
    if (pred.label) $('segLabelSelect').value = pred.label;
  };
  const _segRefreshTrainInfo = async () => {
    try { const list = await segTrainList(); const el = $('segTrainInfo'); if (el) el.textContent = list.length + ' mostres · ' + list.reduce((a,e)=>a+(e.count||0),0).toLocaleString() + ' punts'; } catch(_){}
  };

  $('btnSegPredict')?.addEventListener('click', async () => {
    const sel = _pickBuffer;
    if (!sel || !sel.count) { alert('Fes primer una selecció amb el llaç.'); return; }
    $('btnSegPredict').disabled = true;
    $('btnSegPredict').textContent = '⏳ Analitzant…';
    try {
      const pred = await segPredict();
      if (pred) _segShowResult(pred);
    } catch (e) { diag('⚠ segPredict: ' + e.message); alert('Error a la predicció: ' + e.message); }
    finally { $('btnSegPredict').disabled = !_pickBuffer.count; $('btnSegPredict').textContent = '🔎 Identificar objecte'; }
  });

  $('btnSegConfirm')?.addEventListener('click', async () => {
    if (!_lastPred) return;
    segApply(_lastPred.label, { source: 'user_confirmation' });
    $('segResult').style.display = 'none';
    $('btnSegPredict').disabled = true;
    _lastPred = null;
    await _segRefreshTrainInfo();
  });

  $('btnSegWrong')?.addEventListener('click', () => {
    $('segCorrect').style.display = 'block';
  });

  $('btnSegSaveCorrection')?.addEventListener('click', async () => {
    if (!_lastPred) return;
    const correct = $('segLabelSelect').value;
    segApply(correct, { correctedFrom: _lastPred.label, source: 'user_correction' });
    $('segResult').style.display = 'none';
    $('btnSegPredict').disabled = true;
    _lastPred = null;
    await _segRefreshTrainInfo();
  });

  $('btnSegExport')?.addEventListener('click', async () => {
    try { const n = await segTrainExport(); diag('dataset exportat: ' + n + ' mostres'); }
    catch (e) { alert('Export ha fallat: ' + e.message); }
  });

  $('btnSegClear')?.addEventListener('click', async () => {
    if (!confirm('Buidar el dataset local d\'entrenament? Aquesta acció no es pot desfer.')) return;
    try { await segTrainClear(); await _segRefreshTrainInfo(); diag('dataset buidat'); }
    catch (e) { alert('No s\'ha pogut buidar: ' + e.message); }
  });

  // Activa/desactiva "Identificar objecte" a mesura que hi ha o no selecció
  const _origPickInfo = new MutationObserver(() => {
    const has = !!(_pickBuffer && _pickBuffer.count);
    const btn = $('btnSegPredict'); if (btn) btn.disabled = !has;
  });
  const infoEl = $('pickInfo'); if (infoEl) _origPickInfo.observe(infoEl, { childList: true, characterData: true, subtree: true });

  // Compte inicial
  _segRefreshTrainInfo();

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

  // ── Unir (a l'escena) / Descarregar ──
  document.getElementById('mergeScene').onclick = () => { mergeCloudsInScene(); };
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
  persistSession();   // auto-desat de la sessió (F5 no perd el treball)
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
  if (_ed2dActive) return;   // durant el dibuix, l'editor + navegació tàctil ho gestionen tot
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
    // si l'usuari està agafant el gizmo (les fletxes sobresurten de la caixa),
    // NO desenganxis — si no, el moviment es cancel·laria a l'instant
    if (transformControls.dragging || transformControls.axis) return;
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

// Uneix tots els núvols carregats en un de sol DINS l'escena (sense descarregar).
// Aplica la matriu de món de cada núvol i el substitueix pel resultat combinat.
function mergeCloudsInScene() {
  const list = clouds.filter(c => c?.geometry?.getAttribute('position'));
  if (list.length === 0) { alert(T.noClouds); return null; }
  if (list.length === 1) { diag('unir: només hi ha 1 núvol, no cal unir'); return list[0]; }

  let total = 0;
  const allHaveColor = list.every(c => c.geometry.getAttribute('color'));
  for (const c of list) total += c.geometry.getAttribute('position').count;

  const outPos = new Float32Array(total * 3);
  const outCol = allHaveColor ? new Float32Array(total * 3) : null;
  const v = new THREE.Vector3();
  let o = 0;
  for (const c of list) {
    const pos = c.geometry.getAttribute('position');
    const col = c.geometry.getAttribute('color');
    c.updateWorldMatrix(true, false);
    const mw = c.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      outPos[o] = v.x; outPos[o + 1] = v.y; outPos[o + 2] = v.z;
      if (outCol) { outCol[o] = col.getX(i); outCol[o + 1] = col.getY(i); outCol[o + 2] = col.getZ(i); }
      o += 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outCol) geo.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({ size: 0.025, vertexColors: !!outCol, color: outCol ? 0xffffff : 0xcccccc });
  const merged = new THREE.Points(geo, mat);
  merged.name = 'Núvol unit';

  // Desenganxa el gizmo abans de destruir els núvols antics (evita que quedi apuntant a un objecte destruït)
  if (transformControls) transformControls.detach();

  // Treu els originals de l'escena i les llistes; allibera memòria. També elimina
  // les seves caixes de tall (si en tenien) i els seus estats de selecció.
  for (const c of list) {
    // Caixa de tall associada
    if (c.userData?.clipBox) {
      const box = c.userData.clipBox;
      scene.remove(box);
      box.geometry?.dispose(); box.material?.dispose();
      const bi = selectableObjects.indexOf(box); if (bi >= 0) selectableObjects.splice(bi, 1);
      c.userData.clipBox = null;
      c.userData.boxRelMatrix = null;
    }
    // Estat de selecció del llaç per aquest núvol (WeakMap sense referències vives)
    if (_pickState && _pickState.delete) _pickState.delete(c);
    scene.remove(c);
    const ci = clouds.indexOf(c); if (ci >= 0) clouds.splice(ci, 1);
    const si = selectableObjects.indexOf(c); if (si >= 0) selectableObjects.splice(si, 1);
    c.geometry?.dispose(); c.material?.dispose();
  }
  // Neteja també la variable global 'selectedCloud' si apuntava a un dels destruïts
  if (!clouds.includes(selectedCloud)) selectedCloud = null;

  adaptPointSize(merged);
  scene.add(merged);
  clouds.push(merged);
  selectableObjects.push(merged);
  // Enganxa el gizmo al nou núvol en el mode de núvol actiu (translate per defecte)
  selectCloud(merged);
  if (transformControls) transformControls.setMode(cloudTCMode || 'translate');
  setMode(cloudTCMode || 'translate');
  updateRaycasterThreshold();
  updateCloudList();
  // El buffer de selecció del llaç quedaria referint dades ja no vàlides
  _pickBuffer = { at: null, color: null, count: 0, clouds: [] };
  const _pxBtn = document.getElementById('btnPickExport'); if (_pxBtn) _pxBtn.disabled = true;
  const _rBtn  = document.getElementById('btnRepairSurface'); if (_rBtn)  _rBtn.disabled  = true;
  diag('UNIT: ' + list.length + ' núvols → 1 (' + total.toLocaleString() + ' punts)' + (outCol ? ' amb color' : ' sense color'));
  return merged;
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

// ═══════════════════════════════════════════════════════════════════════════
// Persistència de sessió — auto-desat a IndexedDB (F5 no perd el treball)
// + projecte portàtil .4mc (descarregable / reobrible)
// ═══════════════════════════════════════════════════════════════════════════
const MC_DB = 'mergecloud', MC_STORE = 'session', MC_KEY = 'current';
let _restoring = false, _persistTimer = null, _sessionReady = false;

function _idb() {
  // IMPORTANT: v2 (v2.25 va pujar la BD a v2 per afegir el store 'segTrain'
  // de segmentació IA); si obríem amb v1 llançava "higher version" a cada auto-desat.
  return new Promise((res, rej) => {
    const r = indexedDB.open(MC_DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(MC_STORE)) db.createObjectStore(MC_STORE);
      if (!db.objectStoreNames.contains('segTrain')) db.createObjectStore('segTrain', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function _idbTx(mode, fn) {
  return _idb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(MC_STORE, mode);
    const store = tx.objectStore(MC_STORE);
    let out; try { out = fn(store); } catch (e) { rej(e); return; }
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => rej(tx.error);
  }));
}
const idbPut = (key, val) => _idbTx('readwrite', s => s.put(val, key));
const idbGet = (key) => _idbTx('readonly',  s => s.get(key));
const idbDel = (key) => _idbTx('readwrite', s => s.delete(key));

// núvol → objecte serialitzable (posicions/colors com a Float32Array; matriu de món)
function _serializeCloud(cloud) {
  const g = cloud.geometry;
  const pos = g.getAttribute('position');
  const col = g.getAttribute('color');
  cloud.updateMatrix();
  return {
    name: cloud.name || 'Núvol',
    visible: cloud.visible !== false,
    matrix: Array.from(cloud.matrix.elements),
    size: cloud.material?.size ?? 3,
    sizeAttenuation: cloud.material?.sizeAttenuation ?? false,   // clau: sense això els punts es veien com a blobs de món
    pos: pos ? pos.array.slice(0) : null,
    col: col ? col.array.slice(0) : null,
  };
}
function _deserializeCloud(d) {
  const g = new THREE.BufferGeometry();
  const posArr = d.pos instanceof Float32Array ? d.pos : new Float32Array(d.pos || []);
  g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  const hasCol = !!d.col;
  if (hasCol) {
    const colArr = d.col instanceof Float32Array ? d.col : new Float32Array(d.col);
    g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({ size: d.size ?? 3, sizeAttenuation: d.sizeAttenuation ?? false, vertexColors: hasCol, color: hasCol ? 0xffffff : 0xcccccc });
  const cloud = new THREE.Points(g, mat);
  cloud.name = d.name || 'Núvol';
  cloud.visible = d.visible !== false;
  if (d.matrix && d.matrix.length === 16) {
    cloud.matrix.fromArray(d.matrix);
    cloud.matrix.decompose(cloud.position, cloud.quaternion, cloud.scale);
  }
  return cloud;
}

// Recull l'estat actual de la sessió (núvols + dibuix CAD)
function _collectSession() {
  return {
    v: 1, t: Date.now(),
    clouds: clouds.map(_serializeCloud),
    drawing: _ed2d ? _ed2d.getState() : (JSON.parse(localStorage.getItem('mc_editor_state') || 'null')),
  };
}

// Auto-desat (debounced) — s'invoca a cada canvi rellevant
function persistSession(immediate) {
  if (_restoring || !_sessionReady) return;
  clearTimeout(_persistTimer);
  const run = async () => {
    try {
      const hasWork = clouds.length > 0 || (_ed2d && _ed2d.count().walls > 0);
      if (!hasWork) { await idbDel(MC_KEY); return; }
      await idbPut(MC_KEY, _collectSession());
    } catch (e) { diag('⚠ auto-desat sessió: ' + e.message); }
  };
  if (immediate) return run();
  _persistTimer = setTimeout(run, 1000);
}

// Restauració de la sessió a l'arrencada
async function restoreSession() {
  let data;
  try { data = await idbGet(MC_KEY); } catch (_) { _sessionReady = true; return; }
  if (data && data.clouds && data.clouds.length) {
    _restoring = true;
    try {
      for (const cd of data.clouds) {
        const cloud = _deserializeCloud(cd);
        scene.add(cloud); clouds.push(cloud); selectableObjects.push(cloud);
      }
      const last = clouds[clouds.length - 1];
      selectCloud(last);
      updateCloudList(); updateRaycasterThreshold(); onWindowResize(); fitCameraToObject(last);
      diag('sessió restaurada: ' + clouds.length + ' núvols (F5)');
    } catch (e) { diag('⚠ restaurar sessió ha fallat: ' + e.message); }
    _restoring = false;
  }
  _sessionReady = true;
}

// ── Projecte portàtil .4mc (JSON amb geometria en base64) ──
function _f32ToB64(f32) {
  if (!f32) return null;
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function _b64ToF32(b64) {
  if (!b64) return null;
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function saveProject() {
  if (clouds.length === 0 && !(_ed2d && _ed2d.count().walls)) { alert('No hi ha res per desar encara. Carrega un núvol o dibuixa una planta.'); return; }
  const s = _collectSession();
  const data = {
    format: '4mc-project', version: 1, t: s.t,
    clouds: s.clouds.map(c => ({ name: c.name, visible: c.visible, matrix: c.matrix, size: c.size, pos: _f32ToB64(c.pos), col: c.col ? _f32ToB64(c.col) : null })),
    drawing: s.drawing,
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'projecte_' + new Date().toISOString().slice(0, 10) + '.4mc';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  diag('projecte desat com a .4mc (' + data.clouds.length + ' núvols)');
  return data.clouds.length;
}
async function loadProject(file) {
  const data = JSON.parse(await file.text());
  if (!data || data.format !== '4mc-project') throw new Error('No és un projecte .4mc vàlid');
  for (const cd of (data.clouds || [])) {
    const cloud = _deserializeCloud({ name: cd.name, visible: cd.visible, matrix: cd.matrix, size: cd.size, pos: _b64ToF32(cd.pos), col: cd.col ? _b64ToF32(cd.col) : null });
    scene.add(cloud); clouds.push(cloud); selectableObjects.push(cloud);
  }
  if (data.drawing) {
    try { localStorage.setItem('mc_editor_state', JSON.stringify(data.drawing)); if (_ed2d) _ed2d.setState(data.drawing); } catch (_) {}
  }
  if (clouds.length) { const last = clouds[clouds.length - 1]; selectCloud(last); fitCameraToObject(last); }
  updateCloudList(); updateRaycasterThreshold(); onWindowResize();
  persistSession();
  diag('projecte .4mc carregat: ' + (data.clouds ? data.clouds.length : 0) + ' núvols');
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
// Raycast pantalla → món (helper compartit per l'editor de planta)
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Editor de planta 2D estructurat (mòdul aïllat editor2d.js)
// ─────────────────────────────────────────────
let _ed2d       = null;
let _ed2dActive = false;
let _ed2dWired  = false;
let _edPrevOrtho = false;   // vista abans d'entrar a l'editor (per restaurar-la)

async function _ensureEditor2D() {
  if (_ed2d) return _ed2d;
  const mod = await import('./editor2d.js?v=' + APP_VERSION);
  _ed2d = mod.createEditor2D({
    THREE, scene, renderer,
    screenToWorld:      (x, y) => _traceRaycast(x, y),
    getActiveCamera:    () => (useOrtho && orthoCamera) ? orthoCamera : camera,
    setTopView:         () => { if (!useOrtho) setOrthoView(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)); },
    setControlsEnabled: (b) => {
      controls.enabled = b;
      if (orthoControls) orthoControls.enabled = b;
      if (transformControls) transformControls.enabled = b;
    },
    // Navegació durant el dibuix: amb DITS pan (1) + pinch-zoom (2), sense rotar.
    // El pen/ratolí els captura l'editor per dibuixar; els dits arriben aquí.
    setEditorNav: (on) => {
      if (!orthoControls) return;
      if (on) {
        orthoControls.enabled = true;
        orthoControls.enableRotate = false;
        orthoControls.enableZoom = true;
        orthoControls.enablePan = true;
        orthoControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
        orthoControls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      } else {
        orthoControls.enableRotate = true;
        orthoControls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
        orthoControls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      }
    },
    getClouds:          () => clouds,
  });
  // restaura el dibuix desat (si n'hi ha)
  try { const s = localStorage.getItem('mc_editor_state'); if (s) _ed2d.setState(JSON.parse(s)); } catch (e) { console.warn('no s\'ha pogut restaurar el dibuix:', e); }
  return _ed2d;
}

// ── Barra superior + paletes auto-amagables (estil AutoCAD) ──
function initTopUI() {
  const pals = [
    { tab: 'tabCloud', pal: 'controls' },
    { tab: 'tabDraw',  pal: 'palDraw' },
  ];
  // Les pestanyes CANVIEN de mòdul (sempre n'hi ha un de visible dins la caixa).
  const setModule = (palId) => {
    pals.forEach(p => {
      const on = p.pal === palId;
      document.getElementById(p.pal)?.classList.toggle('open', on);
      document.getElementById(p.tab)?.classList.toggle('active', on);
    });
    // Entrar al mòdul DIBUIX activa l'editor i desplega les eines; sortir-ne el desactiva.
    if (palId === 'palDraw') { if (!_ed2dActive) toggleEditor2D(); }
    else { if (_ed2dActive) toggleEditor2D(); }
  };
  pals.forEach(p => {
    document.getElementById(p.tab)?.addEventListener('click', () => setModule(p.pal));
  });
  setModule('controls');   // per defecte es mostra el mòdul NÚVOL

  // La caixa és fixa però es pot plegar/desplegar lateralment
  const box = document.getElementById('sidebox');
  const reopen = document.getElementById('sideReopen');
  const setCollapsed = (c) => {
    box?.classList.toggle('collapsed', c);
    reopen?.classList.toggle('show', c);
    document.getElementById('cmdLine')?.classList.toggle('full', c);   // la línia IA ocupa tot l'ample
  };
  document.getElementById('sideCollapse')?.addEventListener('click', () => setCollapsed(true));
  reopen?.addEventListener('click', () => setCollapsed(false));

  // Barra superior — accions globals
  document.getElementById('tbOpen')?.addEventListener('click', () => document.getElementById('fileInput')?.click());
  document.getElementById('tbMerge')?.addEventListener('click', () => mergeCloudsInScene());
  document.getElementById('tbDownload')?.addEventListener('click', () => document.getElementById('merge')?.click());
  document.getElementById('tbUndo')?.addEventListener('click', () => {
    if (_ed2dActive && _ed2d) { _ed2d.undo(); }
    else { doUndo(); }
  });
  document.getElementById('tbSave')?.addEventListener('click', () => {
    try {
      const n = saveProject();   // descarrega un fitxer de projecte .4mc (núvols + dibuix)
      if (n === undefined) return;
      const b = document.getElementById('tbSave');
      if (b) { const t = b.textContent; b.textContent = '✓ Projecte desat'; setTimeout(() => { b.textContent = t; }, 1600); }
    } catch (e) { diag('⚠ desar projecte ha fallat: ' + e.message); alert('No s\'ha pogut desar el projecte: ' + e.message); }
  });
}

// ── Panell de diagnòstic ──
function _diagStateSummary() {
  let ed = '—';
  try { if (_ed2d) { const c = _ed2d.count(); ed = 'actiu:' + (_ed2dActive ? 'sí' : 'no') + ' · ' + c.walls + ' parets, ' + c.nodes + ' nodes, ' + c.openings + ' obertures'; } }
  catch (_) {}
  const pts = clouds.reduce((s, c) => s + (c.geometry?.attributes?.position?.count || 0), 0);
  const saved = !!localStorage.getItem('mc_editor_state');
  return [
    '── ESTAT ──',
    'versió: v' + APP_VERSION,
    'núvols: ' + clouds.length + ' · punts totals: ' + pts.toLocaleString(),
    'mode: ' + appMode + ' · vista: ' + (useOrtho ? 'ortogràfica' : '3D'),
    'editor: ' + ed,
    'dibuix desat al navegador: ' + (saved ? 'sí' : 'no'),
    '── REGISTRE ──',
  ].join('\n');
}
function _renderDiag() {
  const body = document.getElementById('diagBody');
  if (body) body.textContent = _diagStateSummary() + '\n' + _diagLog.join('\n');
}
function initDiagUI() {
  const panel = document.getElementById('diagPanel');
  document.getElementById('tbDiag')?.addEventListener('click', () => {
    if (!panel) return;
    const open = panel.classList.toggle('open');
    if (open) _renderDiag();
  });
  document.getElementById('diagClose')?.addEventListener('click', () => panel?.classList.remove('open'));
  document.getElementById('diagClear')?.addEventListener('click', () => { _diagLog.length = 0; diag('registre netejat'); _renderDiag(); });
  document.getElementById('diagHeal')?.addEventListener('click', (e) => {
    _autoHealEnabled = !_autoHealEnabled;
    e.currentTarget.textContent = '🔧 Auto-fix: ' + (_autoHealEnabled ? 'ON' : 'OFF');
    e.currentTarget.style.background = _autoHealEnabled ? '' : '#3a1e08';
    diag('auto-recuperació ' + (_autoHealEnabled ? 'activada' : 'desactivada') + ' per l\'usuari');
    _renderDiag();
  });
  document.getElementById('diagCopy')?.addEventListener('click', async () => {
    const txt = _diagStateSummary() + '\n' + _diagLog.join('\n');
    try { await navigator.clipboard.writeText(txt); }
    catch (_) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
    const b = document.getElementById('diagCopy');
    if (b) { const t = b.textContent; b.textContent = '✓ Copiat'; setTimeout(() => { b.textContent = t; }, 1200); }
  });
}

function _edSetModeBtn(m) {
  document.getElementById('edModeDraw')?.classList.toggle('active', m === 'draw');
  document.getElementById('edModePerim')?.classList.toggle('active', m === 'perimeter');
  document.getElementById('edModeEdit')?.classList.toggle('active', m === 'edit');
  document.getElementById('edModeErase')?.classList.toggle('active', m === 'erase');
  document.getElementById('edModeThick')?.classList.toggle('active', m === 'thickness');
  document.getElementById('edModeEmpalme')?.classList.toggle('active', m === 'empalme');
  document.getElementById('edModeExtend')?.classList.toggle('active', m === 'extend');
  document.getElementById('edModeTrim')?.classList.toggle('active', m === 'trim');
  document.getElementById('edModeOpening')?.classList.toggle('active', m === 'opening');
  document.getElementById('edModeSelect')?.classList.toggle('active', m === 'select');
  const tp = document.getElementById('edThickPanel');
  if (tp) tp.style.display = (m === 'thickness') ? 'flex' : 'none';
  const sp = document.getElementById('edSelPanel');
  if (sp) sp.style.display = (m === 'select') ? 'flex' : 'none';
  const otr = document.getElementById('edOpTypeRow');
  if (otr) otr.style.display = (m === 'opening') ? 'flex' : 'none';
  const owr = document.getElementById('edOpWidthRow');
  if (owr) owr.style.display = (m === 'opening') ? 'flex' : 'none';
  const oi = document.getElementById('edOpInfo');
  if (oi && !['empalme','extend','trim','opening','select'].includes(m)) oi.textContent = '';
}

function _wireEditorButtons(ed) {
  if (_ed2dWired) return;
  _ed2dWired = true;
  const upd = () => {
    const c = ed.count();
    const el = document.getElementById('edCount');
    if (el) el.textContent = c.walls + ' parets, ' + c.nodes + ' nodes' + (c.openings ? ', ' + c.openings + ' obertures' : '');
    // auto-desat del dibuix (localStorage per l'editor + sessió a IndexedDB)
    try { localStorage.setItem('mc_editor_state', JSON.stringify(ed.getState())); } catch (_) {}
    persistSession();
  };
  ed.onChange = upd;
  ed.onThick = (info) => {
    const el = document.getElementById('edThickInfo');
    if (el) el.textContent = info.status + (info.thickness ? ' — actual: ' + info.thickness.toFixed(2) + ' m' : '');
    const inp = document.getElementById('edThickVal');
    if (inp && info.thickness) inp.value = info.thickness;   // no buidis el camp si la paret no té gruix
  };
  document.getElementById('edModeDraw').onclick  = () => { ed.setMode('draw'); _edSetModeBtn('draw'); };
  document.getElementById('edModePerim').onclick = () => { ed.setMode('perimeter'); _edSetModeBtn('perimeter'); };
  document.getElementById('edModeEdit').onclick  = () => { ed.setMode('edit'); _edSetModeBtn('edit'); };
  document.getElementById('edModeErase').onclick = () => { ed.setMode('erase'); _edSetModeBtn('erase'); };
  document.getElementById('edModeThick').onclick = () => { ed.setMode('thickness'); _edSetModeBtn('thickness'); };
  document.getElementById('edModeEmpalme').onclick = () => { ed.setMode('empalme'); _edSetModeBtn('empalme'); };
  document.getElementById('edModeExtend').onclick  = () => { ed.setMode('extend'); _edSetModeBtn('extend'); };
  document.getElementById('edModeTrim').onclick    = () => { ed.setMode('trim'); _edSetModeBtn('trim'); };
  document.getElementById('edModeOpening').onclick = () => { ed.setMode('opening'); _edSetModeBtn('opening'); };
  document.getElementById('edModeSelect').onclick  = () => { ed.setMode('select'); _edSetModeBtn('select'); };
  // ── Accions sobre la selecció múltiple ──
  let _edSelSide = 0;
  const _setSelSide = (s, btn) => {
    _edSelSide = s;
    ['edSelSideCenter','edSelSideA','edSelSideB'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(btn)?.classList.add('active');
  };
  document.getElementById('edSelSideCenter').onclick = () => _setSelSide(0, 'edSelSideCenter');
  document.getElementById('edSelSideA').onclick      = () => _setSelSide(1, 'edSelSideA');
  document.getElementById('edSelSideB').onclick      = () => _setSelSide(-1, 'edSelSideB');
  document.getElementById('edSelThickApply').onclick = () => { ed.applyThicknessSelection(parseFloat(document.getElementById('edSelThickVal').value), _edSelSide); upd(); };
  document.getElementById('edSelDelete').onclick     = () => { ed.deleteSelection(); upd(); };
  ed.onSel = (info) => {
    const el = document.getElementById('edSelInfo');
    if (!el) return;
    el.innerHTML = info.count > 0
      ? '<b style="color:#ffdd00">' + info.count + ' paret(s)</b> seleccionada(es) — aplica gruix o esborra'
      : 'Arrossega → <b style="color:#8ab4ff">finestra</b> (tanca) · ← <b style="color:#6de0a0">captura</b> (toca) · Shift afegeix';
  };
  document.getElementById('edOpDoor').onclick   = () => { ed.setOpType('door'); document.getElementById('edOpDoor').classList.add('active'); document.getElementById('edOpWindow').classList.remove('active'); };
  document.getElementById('edOpWindow').onclick = () => { ed.setOpType('window'); document.getElementById('edOpWindow').classList.add('active'); document.getElementById('edOpDoor').classList.remove('active'); };
  document.getElementById('edW60').onclick  = () => ed.setOpWidth(0.60);
  document.getElementById('edW70').onclick  = () => ed.setOpWidth(0.70);
  document.getElementById('edW80').onclick  = () => ed.setOpWidth(0.80);
  document.getElementById('edW90').onclick  = () => ed.setOpWidth(0.90);
  document.getElementById('edWDob').onclick = () => ed.setOpWidth(1.40);
  document.getElementById('edOpRotate').onclick = () => ed.rotateOpening();
  ed.onOp = (msg) => { const oi = document.getElementById('edOpInfo'); if (oi) oi.textContent = msg; };
  document.getElementById('edThickApply').onclick   = () => ed.applyThickness(parseFloat(document.getElementById('edThickVal').value));
  document.getElementById('edThickMeasure').onclick = () => ed.startMeasure();
  const _setSide = (s, btn) => {
    ed.setSelSide(s);
    ['edSideCenter','edSideA','edSideB'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(btn)?.classList.add('active');
  };
  document.getElementById('edSideCenter').onclick = () => _setSide(0, 'edSideCenter');
  document.getElementById('edSideA').onclick      = () => _setSide(1, 'edSideA');
  document.getElementById('edSideB').onclick      = () => _setSide(-1, 'edSideB');
  document.getElementById('edThickAll').onclick   = () => ed.applyThicknessAll(parseFloat(document.getElementById('edThickVal').value));
  document.getElementById('edHideCloud').onclick = () => {
    const s = ed.cycleCloud();
    document.getElementById('edHideCloud').textContent = '👁 Núvol: ' + s;
  };
  document.getElementById('edUndo').onclick   = () => { ed.undo(); upd(); };
  document.getElementById('edClear').onclick  = () => { if (confirm('Esborrar tota la planta?')) { ed.clear(); upd(); } };
  document.getElementById('edExport').onclick = () => ed.exportDXF();
}

async function toggleEditor2D() {
  let ed;
  try { ed = await _ensureEditor2D(); }
  catch (e) { console.error('editor2d load failed:', e); alert('No s\'ha pogut carregar l\'editor de planta: ' + e.message); return; }
  _wireEditorButtons(ed);

  _ed2dActive = !_ed2dActive;
  diag('editor ' + (_ed2dActive ? 'ACTIVAT' : 'aturat'));
  const tools = document.getElementById('editorTools');
  const btn   = document.getElementById('editorLaunchBtn');

  if (_ed2dActive) {
    _edPrevOrtho = useOrtho;                              // recorda la vista actual
    if (transformControls) transformControls.detach();   // amaga el gizmo del núvol
    ed.setActive(true);
    tools.style.display = 'flex';
    btn.textContent = '⏹ Aturar editor';
    btn.classList.add('active');
    ed.setMode('select'); _edSetModeBtn('select');   // per defecte, mode selecció (CAD estàndard)
    if (ed.onChange) ed.onChange();
  } else {
    ed.setActive(false);
    if (!_edPrevOrtho) activate3DView();                  // restaura la vista 3D si hi érem
    if (selectedCloud && transformControls) {             // reenganxa el gizmo al núvol
      transformControls.attach(selectedCloud);
      transformControls.setMode(cloudTCMode);
    }
    tools.style.display = 'none';
    btn.textContent = '📐 Activar editor';
    btn.classList.remove('active');
  }
}

function initEditor2DUI() {
  const launch = document.getElementById('editorLaunchBtn');
  if (launch) launch.addEventListener('click', toggleEditor2D);
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
    updateGizmo();

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
  diag('⚠ ERROR: ' + e.message + ' (' + (e.filename||'').split('/').pop() + ':' + e.lineno + ')');
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
window.addEventListener('unhandledrejection', e => {
  diag('⚠ PROMISE REBUTJADA: ' + ((e.reason && e.reason.message) || e.reason || 'desconegut'));
});

// ── Gizmo d'orientació / rotació de vista (SVG lleuger) ───────────────────────
// Mostra els eixos X/Y/Z segons la vista actual · clic a un eix = encara la vista ·
// arrossega el gizmo = orbita la càmera. Es dibuixa a la cantonada del visor.
let _gizmo = null;
const _SVGNS = 'http://www.w3.org/2000/svg';
function initGizmo() {
  const viewer = document.getElementById('viewer');
  if (!viewer || _gizmo) return;
  const el = document.createElement('div');
  el.id = 'navGizmo';
  el.title = 'Arrossega per orbitar · clica un eix per encarar la vista';
  el.style.cssText = 'position:absolute;right:14px;bottom:96px;width:84px;height:84px;z-index:16;cursor:grab;touch-action:none;';
  el.innerHTML = '<svg width="84" height="84" viewBox="0 0 84 84"><circle cx="42" cy="42" r="40" fill="rgba(20,22,29,.82)" stroke="#2a2d40" stroke-width="1"/><g id="_gzLines"></g><g id="_gzDots"></g></svg>';
  viewer.appendChild(el);
  const dots = el.querySelector('#_gzDots'), lines = el.querySelector('#_gzLines');
  const AX = [
    { lab:'X', col:'#e06a52', pos:true,  dir:[1,0,0],  up:[0,1,0],  v:[1,0,0] },
    { lab:'',  col:'#e06a52', pos:false, dir:[-1,0,0], up:[0,1,0],  v:[-1,0,0] },
    { lab:'Y', col:'#63c06f', pos:true,  dir:[0,1,0],  up:[0,0,-1], v:[0,1,0] },
    { lab:'',  col:'#63c06f', pos:false, dir:[0,-1,0], up:[0,0,1],  v:[0,-1,0] },
    { lab:'Z', col:'#4f97e6', pos:true,  dir:[0,0,1],  up:[0,1,0],  v:[0,0,1] },
    { lab:'',  col:'#4f97e6', pos:false, dir:[0,0,-1], up:[0,1,0],  v:[0,0,-1] },
  ];
  const items = AX.map(a => {
    let line = null;
    if (a.pos) { line = document.createElementNS(_SVGNS,'line'); line.setAttribute('x1','42'); line.setAttribute('y1','42'); line.setAttribute('stroke',a.col); line.setAttribute('stroke-width','2'); lines.appendChild(line); }
    const g = document.createElementNS(_SVGNS,'g'); g.style.cursor = 'pointer';
    const c = document.createElementNS(_SVGNS,'circle'); c.setAttribute('r', a.pos ? '9' : '6'); c.setAttribute('fill', a.pos ? a.col : 'rgba(20,22,29,.92)'); c.setAttribute('stroke', a.col); c.setAttribute('stroke-width','1.5');
    const t = document.createElementNS(_SVGNS,'text'); t.setAttribute('text-anchor','middle'); t.setAttribute('dominant-baseline','central'); t.setAttribute('font-size','10'); t.setAttribute('font-weight','700'); t.setAttribute('fill','#fff'); t.textContent = a.lab;
    g.appendChild(c); g.appendChild(t); dots.appendChild(g);
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); try { setOrthoView(new THREE.Vector3(a.dir[0],a.dir[1],a.dir[2]), new THREE.Vector3(a.up[0],a.up[1],a.up[2])); } catch(_){} });
    return { a, line, g, v: new THREE.Vector3(a.v[0], a.v[1], a.v[2]) };
  });
  _gizmo = { el, items };
  // Arrossegar el fons → orbita
  let drag = false, lx = 0, ly = 0;
  el.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; el.style.cursor = 'grabbing'; try { el.setPointerCapture(e.pointerId); } catch(_){} });
  el.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY; _gizmoOrbit(dx, dy); });
  const stop = () => { drag = false; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
}
function _gizmoOrbit(dx, dy) {
  if (!controls || !camera) return;
  if (useOrtho) activate3DView();
  const offset = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(offset);
  sph.theta -= dx * 0.012;
  sph.phi   -= dy * 0.012;
  sph.phi = Math.max(0.001, Math.min(Math.PI - 0.001, sph.phi));
  offset.setFromSpherical(sph);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}
function updateGizmo() {
  if (!_gizmo) return;
  const cam = (useOrtho && orthoCamera) ? orthoCamera : camera;
  if (!cam) return;
  const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
  const R = 27, dots = [];
  for (const it of _gizmo.items) {
    const d = it.v.clone().transformDirection(inv);   // eix en espai de càmera
    dots.push({ it, x: 42 + d.x*R, y: 42 - d.y*R, z: d.z });
  }
  dots.sort((p,q) => p.z - q.z);   // darrere primer (z-order)
  for (const o of dots) {
    o.it.g.setAttribute('transform', `translate(${o.x.toFixed(1)},${o.y.toFixed(1)})`);
    o.it.g.setAttribute('opacity', (o.z > 0 ? 1 : 0.4).toFixed(2));
    if (o.it.line) { o.it.line.setAttribute('x2', o.x.toFixed(1)); o.it.line.setAttribute('y2', o.y.toFixed(1)); o.it.line.setAttribute('opacity', (o.z > 0 ? 0.9 : 0.35).toFixed(2)); }
    o.it.g.parentNode.appendChild(o.it.g);   // el de davant, a sobre
  }
}

// Mostra versió a la capçalera
const _vEl = document.getElementById('appVersion');
if (_vEl) _vEl.textContent = 'v' + APP_VERSION;

try { init(); } catch(e) { console.error('init() crashed:', e); }
try { setupUI(); } catch(e) { console.error('setupUI() crashed:', e); }
try { initAccordions(); } catch(e) { console.error('initAccordions() crashed:', e); }
try { initCmdLine(); } catch(e) { console.error('initCmdLine() crashed:', e); }
try { initEditor2DUI(); } catch(e) { console.error('initEditor2DUI() crashed:', e); }
try { initTopUI(); } catch(e) { console.error('initTopUI() crashed:', e); }
try { initDiagUI(); } catch(e) { console.error('initDiagUI() crashed:', e); }
try { initGizmo(); } catch(e) { console.error('initGizmo() crashed:', e); }
try { _translateUI(); } catch(e) { console.error('_translateUI() crashed:', e); }
// Restaura la sessió anterior (núvols + dibuix) — F5 no perd el treball
try { restoreSession(); } catch(e) { console.error('restoreSession() crashed:', e); _sessionReady = true; }
// Desat de darrera hora en tancar/refrescar (captura moviments/transformacions no desats)
window.addEventListener('pagehide', () => { try { persistSession(true); } catch(_) {} });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { persistSession(true); } catch(_) {} } });
animate();

// Obre els accordions "Propietats" i "Moure/Rotar" per defecte
['accMove', 'accAlign'].forEach(id => {
  const body   = document.getElementById(id + '-body');
  const header = document.querySelector('[data-acc="' + id + '"]');
  if (body)   body.classList.add('open');
  if (header) header.classList.add('open');
});