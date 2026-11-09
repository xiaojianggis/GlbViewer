import * as THREE from 'three';

const STOPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  turbo: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#d93806', '#b11901', '#7a0402'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  coolwarm: ['#3b4cc0', '#6788ee', '#9abbff', '#c9d7f0', '#edd1c2', '#f7a889', '#e26952', '#b40426'],
  jet: ['#00007f', '#0000ff', '#007fff', '#00ffff', '#7fff7f', '#ffff00', '#ff7f00', '#ff0000', '#7f0000'],
  terrain: ['#333399', '#0294fa', '#24d36d', '#b6f08a', '#dcd28c', '#937a5e', '#a6928c', '#ffffff'],
  grayscale: ['#000000', '#ffffff'],
};

// UTCI assessment scale (°C), Bröde et al. 2012
export const UTCI_CLASSES = [
  { max: -40, label: 'Extreme cold stress', color: '#0b1a4f' },
  { max: -27, label: 'Very strong cold stress', color: '#1a3a8f' },
  { max: -13, label: 'Strong cold stress', color: '#2563c0' },
  { max: 0, label: 'Moderate cold stress', color: '#4fa6e0' },
  { max: 9, label: 'Slight cold stress', color: '#9bd7f2' },
  { max: 26, label: 'No thermal stress', color: '#3fae49' },
  { max: 32, label: 'Moderate heat stress', color: '#ffcc00' },
  { max: 38, label: 'Strong heat stress', color: '#ff7a00' },
  { max: 46, label: 'Very strong heat stress', color: '#e3170a' },
  { max: Infinity, label: 'Extreme heat stress', color: '#7a0000' },
];

export const COLORMAPS = [
  { id: 'viridis', label: 'Viridis' },
  { id: 'turbo', label: 'Turbo' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'coolwarm', label: 'Cool–warm' },
  { id: 'jet', label: 'Jet' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'grayscale', label: 'Grayscale' },
  { id: 'utci', label: 'UTCI stress classes (°C)' },
];

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function sampleStops(stops, t) {
  t = Math.min(1, Math.max(0, t));
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export const LUT_SIZE = 256;

/** Builds an sRGB RGBA lookup table (Uint8Array, LUT_SIZE * 4) over [min, max]. */
export function buildLUT({ cmap, bands = 0, invert = false, min = 0, max = 1 }) {
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let k = 0; k < LUT_SIZE; k++) {
    let t = (k + 0.5) / LUT_SIZE;
    let rgb;
    if (cmap === 'utci') {
      const value = min + t * (max - min);
      rgb = hex(UTCI_CLASSES.find((c) => value < c.max || c.max === Infinity).color);
    } else {
      if (bands > 0) t = (Math.min(bands - 1, Math.floor(t * bands)) + 0.5) / bands;
      if (invert) t = 1 - t;
      rgb = sampleStops(STOPS[cmap] ?? STOPS.viridis, t);
    }
    lut.set([rgb[0], rgb[1], rgb[2], 255], k * 4);
  }
  return lut;
}

export function lutTexture(lut, discrete) {
  const tex = new THREE.DataTexture(lut, LUT_SIZE, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = discrete ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = discrete ? THREE.NearestFilter : THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function lutToCss(lut) {
  const parts = [];
  for (let k = 0; k < LUT_SIZE; k += 8) {
    parts.push(`rgb(${lut[k * 4]},${lut[k * 4 + 1]},${lut[k * 4 + 2]}) ${((k + 0.5) / LUT_SIZE * 100).toFixed(1)}%`);
  }
  parts.push(`rgb(${lut[(LUT_SIZE - 1) * 4]},${lut[(LUT_SIZE - 1) * 4 + 1]},${lut[(LUT_SIZE - 1) * 4 + 2]}) 100%`);
  return parts.join(',');
}

const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const S2L = new Float32Array(256).map((_, i) => s2l(i));

/** Linear-space RGB for a value, for vertex colours. */
export function lutColorLinear(lut, t, out, o) {
  const k = t !== t ? 0 : Math.min(LUT_SIZE - 1, Math.max(0, Math.floor(t * LUT_SIZE)));
  out[o] = S2L[lut[k * 4]]; out[o + 1] = S2L[lut[k * 4 + 1]]; out[o + 2] = S2L[lut[k * 4 + 2]];
}
