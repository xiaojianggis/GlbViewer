import * as THREE from 'three';

// Reader for uncompressed LAS 1.0–1.4 (point formats 0–10).
const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
export const MAX_LAS_POINTS = 12_000_000;

export function parseLAS(buffer, origin) {
  const dv = new DataView(buffer);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('Not a LAS file (missing LASF signature).');
  const minor = dv.getUint8(25);
  const offsetToPoints = dv.getUint32(96, true);
  const rawFormat = dv.getUint8(104);
  if (rawFormat & 0x80 || rawFormat & 0x40) {
    throw new Error('This LAS file is LAZ-compressed. Decompress it to .las first (e.g. with `laszip` or PDAL).');
  }
  const format = rawFormat & 0x3f;
  const recLen = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (minor >= 4 && count === 0) count = Number(dv.getBigUint64(247, true));
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offs = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const max = [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)];
  const min = [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)];
  count = Math.min(count, Math.floor((buffer.byteLength - offsetToPoints) / recLen));

  const warnings = [];
  const step = Math.max(1, Math.ceil(count / MAX_LAS_POINTS));
  if (step > 1) warnings.push(`Showing every ${step}th point (${count.toLocaleString()} points in file).`);
  const n = Math.ceil(count / step);

  if (!origin) origin = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  const pos = new Float32Array(n * 3);
  const elev = new Float32Array(n);
  const inten = new Float32Array(n);
  const cls = new Float32Array(n);
  const rgbOff = RGB_OFFSET[format];
  const rgb = rgbOff ? new Float32Array(n * 3) : null;
  const clsOff = format >= 6 ? 16 : 15;
  let rgbMax = 0;

  for (let i = 0, k = 0; i < count; i += step, k++) {
    const b = offsetToPoints + i * recLen;
    const x = dv.getInt32(b, true) * scale[0] + offs[0];
    const y = dv.getInt32(b + 4, true) * scale[1] + offs[1];
    const z = dv.getInt32(b + 8, true) * scale[2] + offs[2];
    pos[k * 3] = x - origin[0]; pos[k * 3 + 1] = y - origin[1]; pos[k * 3 + 2] = z - origin[2];
    elev[k] = z;
    inten[k] = dv.getUint16(b + 12, true);
    cls[k] = format >= 6 ? dv.getUint8(b + clsOff) : dv.getUint8(b + clsOff) & 0x1f;
    if (rgb) {
      const r = dv.getUint16(b + rgbOff, true), g = dv.getUint16(b + rgbOff + 2, true), bl = dv.getUint16(b + rgbOff + 4, true);
      rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = bl;
      if (r > rgbMax) rgbMax = r; if (g > rgbMax) rgbMax = g; if (bl > rgbMax) rgbMax = bl;
    }
  }
  if (rgb) {
    const div = rgbMax > 255 ? 65535 : 255;
    for (let k = 0; k < rgb.length; k++) { const c = rgb[k] / div; rgb[k] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }));
  points.name = 'points';

  const vars = [elev, inten, cls];
  const field = {
    variables: ['Elevation', 'Intensity', 'Classification'],
    defaultVar: rgb ? -2 : 0,
    hasRGB: !!rgb,
    parts: [{ object: points, kind: 'points', nodal: (v) => vars[v], rgb }],
  };
  return { object: points, field, origin, warnings, info: { 'Point format': format, 'LAS version': `1.${minor}`, Points: count.toLocaleString() } };
}
