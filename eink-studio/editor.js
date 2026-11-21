import { FONTS } from './fonts.js';
import { WIDTH, HEIGHT, STRIDE, renderGray, packBits } from './image.js';

let nextId = 0;
const id = () => `layer-${++nextId}`;
const common = (type, name) => ({ id: id(), type, name, x: 0, y: 0, width: WIDTH, height: HEIGHT, rotation: 0, visible: true });

export function createDocument() { return { layers: [], selected: null }; }
export function textLayer(fontId = FONTS[0].id) {
  return { ...common('text', 'Text'), text: 'Привет, мир!', fontId, scale: 1, align: 'left', background: 'transparent', color: 'black' };
}
export function imageLayer(source, name = 'Image') {
  return { ...common('image', name), source, crop: null, mode: 'cover', zoom: 1, offsetX: 0, offsetY: 0, tileSize: 61, brightness: 0, contrast: 0, threshold: 128, dither: 'none', invert: false };
}

// Sources are immutable assets, shared by snapshots rather than copied on every edit.
function snapshot(doc) {
  return { ...doc, layers: doc.layers.map(layer => ({ ...layer, ...(layer.crop ? { crop: { ...layer.crop } } : {}) })) };
}
export class History {
  constructor(initial, limit = 100) {
    this.limit = Math.max(1, Math.floor(limit) || 100);
    this.states = [snapshot(initial)];
    this.index = 0;
  }
  get current() { return snapshot(this.states[this.index]); }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index + 1 < this.states.length; }
  commit(doc) {
    this.states.splice(this.index + 1);
    this.states.push(snapshot(doc));
    if (this.states.length > this.limit) this.states.shift();
    this.index = this.states.length - 1;
    return this.current;
  }
  undo() { if (this.index > 0) this.index--; return this.current; }
  redo() { if (this.index + 1 < this.states.length) this.index++; return this.current; }
}

function wrap(text, columns) {
  const result = [];
  for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const chars = Array.from(paragraph);
    if (!chars.length) { result.push([]); continue; }
    if (columns < 1) { result.push(chars); continue; }
    while (chars.length > columns) {
      let end = columns;
      // Prefer a word boundary, but split words longer than the block.
      for (let i = columns; i > 0; i--) {
        if (/\s/u.test(chars[i])) { end = i; break; }
        if (/\s/u.test(chars[i - 1])) { end = i - 1; break; }
      }
      if (!end) end = columns;
      result.push(chars.splice(0, end));
      while (chars.length && /\s/u.test(chars[0])) chars.shift();
    }
    if (chars.length) result.push(chars);
  }
  return result;
}

function textPixels(layer, warnings) {
  const font = FONTS.find(f => f.id === layer.fontId);
  if (!font) { warnings.push(`${layer.name}: unknown font ${layer.fontId}`); return null; }
  const width = Math.max(0, Math.floor(layer.width)), height = Math.max(0, Math.floor(layer.height));
  const scale = Math.max(1, Math.floor(layer.scale));
  const pixels = new Int8Array(width * height);
  pixels.fill(layer.background === 'black' ? 1 : layer.background === 'white' ? 0 : -1);
  const cellW = font.width * scale, cellH = font.height * scale;
  const columns = Math.floor(width / cellW);
  const lines = wrap(layer.text, columns);
  if (columns < 1 && String(layer.text).length) warnings.push(`${layer.name}: text block too narrow for a glyph`);
  if (lines.length * cellH > height) warnings.push(`${layer.name}: text height overflow`);
  const missing = new Set();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const lineWidth = line.length * cellW;
    const offset = layer.align === 'right' ? width - lineWidth : layer.align === 'center' ? Math.floor((width - lineWidth) / 2) : 0;
    for (let column = 0; column < line.length; column++) {
      const char = line[column], glyph = font.glyphs[char];
      if (!glyph) missing.add(char);
      for (let gy = 0; gy < font.height; gy++) for (let gx = 0; gx < font.width; gx++) {
        const on = glyph ? glyph[gy]?.[gx] === '1' : (gx === 0 || gy === 0 || gx === font.width - 1 || gy === font.height - 1);
        if (!on) continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const x = offset + column * cellW + gx * scale + sx, y = row * cellH + gy * scale + sy;
          if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = layer.color === 'white' ? 0 : 1;
        }
      }
    }
  }
  if (missing.size) warnings.push(`${layer.name}: missing glyphs: ${[...missing].join(' ')}`);
  return { pixels, width, height };
}

function imagePixels(layer, warnings) {
  let { data, width, height } = layer.source;
  if (layer.crop) {
    const crop = layer.crop;
    const x0 = Math.max(0, Math.min(width, Math.floor(crop.x)));
    const y0 = Math.max(0, Math.min(height, Math.floor(crop.y)));
    const x1 = Math.max(0, Math.min(width, Math.ceil(crop.x + crop.width)));
    const y1 = Math.max(0, Math.min(height, Math.ceil(crop.y + crop.height)));
    if (!(x1 > x0 && y1 > y0)) { warnings.push(`${layer.name}: empty image crop`); return null; }
    const cropped = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
    for (let y = y0; y < y1; y++) cropped.set(data.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * (x1 - x0) * 4);
    data = cropped; width = x1 - x0; height = y1 - y0;
  }
  const gray = renderGray(data, width, height, { mode: layer.mode, zoom: layer.zoom, tileSize: layer.tileSize, x: layer.offsetX ?? 0, y: layer.offsetY ?? 0 });
  const packed = packBits(gray, WIDTH, HEIGHT, layer);
  const pixels = new Int8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) pixels[y * WIDTH + x] = (packed[y * STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1;
  return { pixels, width: WIDTH, height: HEIGHT };
}

export function renderDocument(doc) {
  const frame = new Uint8Array(STRIDE * HEIGHT), warnings = [];
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const w = Math.max(0, Math.floor(layer.width)), h = Math.max(0, Math.floor(layer.height));
    if (!w || !h) continue;
    const source = layer.type === 'text' ? textPixels(layer, warnings) : layer.type === 'image' ? imagePixels(layer, warnings) : null;
    if (!source) continue;
    const angle = (Number(layer.rotation) || 0) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const cx = layer.x + w / 2, cy = layer.y + h / 2;
    const halfW = (Math.abs(cos) * w + Math.abs(sin) * h) / 2;
    const halfH = (Math.abs(sin) * w + Math.abs(cos) * h) / 2;
    const left = cx - halfW, right = cx + halfW, top = cy - halfH, bottom = cy + halfH;
    const epsilon = 1e-9;
    if (left < -epsilon || top < -epsilon || right > WIDTH + epsilon || bottom > HEIGHT + epsilon) warnings.push(`${layer.name}: layer clipped by canvas`);
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(HEIGHT, Math.ceil(bottom)); y++) for (let x = Math.max(0, Math.floor(left)); x < Math.min(WIDTH, Math.ceil(right)); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = cos * dx + sin * dy + w / 2, v = -sin * dx + cos * dy + h / 2;
      if (u < 0 || v < 0 || u >= w || v >= h) continue;
      const sx = Math.min(source.width - 1, Math.floor(u * source.width / w));
      const sy = Math.min(source.height - 1, Math.floor(v * source.height / h));
      const value = source.pixels[sy * source.width + sx];
      if (value < 0) continue;
      const index = y * STRIDE + (x >> 3), mask = 0x80 >> (x & 7);
      if (value) frame[index] |= mask; else frame[index] &= ~mask;
    }
  }
  return { frame, warnings };
}
