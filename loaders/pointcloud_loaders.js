// loaders/pointcloud_loaders.js
import * as THREE from '../three/three.module.js';
import { PLYLoader } from './PLYLoader.js';

// FileReader wrappers — compatibles amb tots els navegadors mòbils
function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Error llegint fitxer: ' + file.name));
    reader.readAsArrayBuffer(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Error llegint fitxer: ' + file.name));
    reader.readAsText(file);
  });
}

// -----------------------------------------------------------------------------
// Carregador PLY
// -----------------------------------------------------------------------------
export async function loadPLY(file) {
  console.log("loadPLY() ->", file.name);
  const arrayBuffer = await readAsArrayBuffer(file);

  const loader = new PLYLoader();
  const geometry = loader.parse(arrayBuffer);

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const hasColor = geometry.getAttribute('color') !== undefined;

  const material = new THREE.PointsMaterial({
    size: 3,
    sizeAttenuation: false,
    vertexColors: hasColor,
    color: hasColor ? undefined : 0xffffff
  });

  const points = new THREE.Points(geometry, material);
  points.name = file.name;

  const posAttr = geometry.getAttribute('position');
  console.log('PLY carregat, punts:', posAttr ? posAttr.count : 0);

  return points;
}

// -----------------------------------------------------------------------------
// Carregador XYZ (x y z [r g b])
// -----------------------------------------------------------------------------
export async function loadXYZ(file) {
  console.log("loadXYZ() ->", file.name);
  const text = await readAsText(file);
  const lines = text.split(/\r?\n/);

  const positions = [];
  const colors = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    // Accepta espais, comes i punt-i-coma com a separadors (formats iOS)
    const parts = line.trim().split(/[\s,;]+/);
    if (parts.length < 3) continue;

    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    const z = parseFloat(parts[2]);

    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;

    positions.push(x, y, z);

    if (parts.length >= 6) {
      const r = parseFloat(parts[3]);
      const g = parseFloat(parts[4]);
      const b = parseFloat(parts[5]);

      const rr = (!Number.isNaN(r) ? r : 255) / 255;
      const gg = (!Number.isNaN(g) ? g : 255) / 255;
      const bb = (!Number.isNaN(b) ? b : 255) / 255;

      colors.push(rr, gg, bb);
    } else {
      colors.push(1, 1, 1);
    }
  }

  const numPoints = positions.length / 3;
  console.log("Línies vàlides XYZ:", numPoints);

  if (numPoints === 0) throw new Error('Cap punt vàlid al fitxer ' + file.name);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.PointsMaterial({
    size: 3,
    sizeAttenuation: false,
    vertexColors: true
  });

  const points = new THREE.Points(geometry, material);
  points.name = file.name;

  console.log('XYZ carregat, punts:', numPoints);
  return points;
}
