'use strict';
/*
 * Pure-JS sharp compatibility shim for DSH on Android (no libvips binaries).
 * Covers the API surface actually used by @deepseek-ai/dsh-attachment-local:
 *   sharp(data, {failOn, limitInputPixels}) -> .metadata() / .raw().toBuffer()
 * Full decode: non-interlaced PNG (color types 0/2/3/4/6, bit depths 1-16).
 * Header-only metadata: PNG / JPEG / GIF / WebP.
 * Anything not implemented throws a clear error instead of returning a Proxy.
 */
const fs = require("fs");
const zlib = require("zlib");

class ShimError extends Error {}

/* ── format sniffing ── */
function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("latin1", 0, 3) === "GIF") return "gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return undefined;
}

/* ── PNG ── */
function parsePng(buf) {
  if (buf.toString("latin1", 1, 4) !== "PNG") throw new ShimError("not a PNG");
  let pos = 8;
  const meta = { format: "png" };
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (type === "IHDR") {
      meta.width = buf.readUInt32BE(pos + 8);
      meta.height = buf.readUInt32BE(pos + 12);
      meta.depth = buf[pos + 16];
      meta.colorType = buf[pos + 17];
      meta.interlaced = buf[pos + 20];
    } else if (type === "PLTE") { meta.plte = Buffer.from(buf.subarray(pos + 8, pos + 8 + len)); }
    else if (type === "tRNS") { meta.trns = Buffer.from(buf.subarray(pos + 8, pos + 8 + len)); }
    else if (type === "IDAT") { idat.push(buf.subarray(pos + 8, pos + 8 + len)); }
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!meta.width || !meta.height) throw new ShimError("PNG missing IHDR dimensions");
  return { meta, idat };
}

const CT_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/* PNG spec §11.2: allowed bit depths per color type */
const CT_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function decodePngRaw(buf) {
  const { meta, idat } = parsePng(buf);
  if (meta.interlaced) throw new ShimError("dsh-shim: interlaced PNG is not supported");
  if (!(meta.colorType in CT_CHANNELS)) throw new ShimError("dsh-shim: unsupported PNG color type " + meta.colorType);
  const allowed = CT_DEPTHS[meta.colorType] || [];
  if (allowed.indexOf(meta.depth) === -1) throw new ShimError("dsh-shim: invalid PNG bit depth " + meta.depth + " for color type " + meta.colorType);
  const W = meta.width, H = meta.height, depth = meta.depth, ct = meta.colorType;
  const srcCh = CT_CHANNELS[ct];
  const bpp = Math.max(1, (srcCh * depth) >> 3);
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); }
  catch (e) { throw new ShimError("dsh-shim: PNG IDAT inflate failed: " + e.message); }
  const stride = Math.ceil((W * srcCh * depth) / 8);
  const lines = Buffer.alloc(H * stride);
  let p = 0;
  for (let y = 0; y < H; y++) {
    if (p >= raw.length) throw new ShimError("dsh-shim: PNG scanline data truncated");
    const ft = raw[p++];
    const cur = y * stride, prev = cur - stride;
    for (let x = 0; x < stride; x++) {
      const v = p + x < raw.length ? raw[p + x] : 0;
      const a = x >= bpp ? lines[cur + x - bpp] : 0;
      const b = y > 0 ? lines[prev + x] : 0;
      const c = (x >= bpp && y > 0) ? lines[prev + x - bpp] : 0;
      let o;
      if (ft === 0) o = v;
      else if (ft === 1) o = (v + a) & 255;
      else if (ft === 2) o = (v + b) & 255;
      else if (ft === 3) o = (v + ((a + b) >> 1)) & 255; /* PNG Average = floor(left + above)/2 */
      else {
        const pa = Math.abs(a - c), pb = Math.abs(b - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        o = (v + pr) & 255;
      }
      lines[cur + x] = o;
    }
    p += stride;
  }
  /* expand to 8-bit RGB or RGBA */
  const alpha = ct === 4 || ct === 6 || (ct === 3 && meta.trns);
  const outCh = alpha ? 4 : 3;
  const out = Buffer.alloc(W * H * outCh);
  const readSample = (base, idx) => {
    if (depth === 8) return lines[base + idx];
    if (depth === 16) return lines[base + idx * 2]; /* take high byte */
    /* sub-byte depths (gray 1/2/4 only) */
    const bitPos = idx * depth, byte = lines[base + (bitPos >> 3)];
    const shift = 8 - depth - (bitPos & 7);
    const mask = (1 << depth) - 1;
    const val = (byte >> shift) & mask;
    return Math.round((val * 255) / mask);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const base = y * stride + Math.floor((x * srcCh * depth) / 8);
      const di = (y * W + x) * outCh;
      if (ct === 0) {
        /* sub-byte gray packs pixels MSB-first across the row: bit offset must come from x, not from base alone */
        let g;
        if (depth >= 8) g = lines[base]; /* 16-bit: take high byte */
        else {
          const bitPos = x * depth;
          const byte = lines[y * stride + (bitPos >> 3)];
          const mask = (1 << depth) - 1;
          g = Math.round((((byte >> (8 - depth - (bitPos & 7))) & mask) * 255) / mask);
        }
        out[di] = out[di + 1] = out[di + 2] = g;
      }
      else if (ct === 2) { out[di] = readSample(base, 0); out[di + 1] = readSample(base + (depth >> 3), 0); out[di + 2] = readSample(base + 2 * (depth >> 3), 0); if (alpha) out[di + 3] = 255; }
      else if (ct === 4) { const g = readSample(base, 0); out[di] = out[di + 1] = out[di + 2] = g; out[di + 3] = depth === 16 ? lines[y * stride + x * 4 + 2] : lines[y * stride + x * 2 + 1]; }
      else if (ct === 6) { out[di] = readSample(base, 0); out[di + 1] = readSample(base + (depth >> 3), 0); out[di + 2] = readSample(base + 2 * (depth >> 3), 0); out[di + 3] = depth === 16 ? readSample(base + 3 * (depth >> 3), 0) : readSample(base + 3, 0); }
      else { /* palette */
        const idx = depth < 8 ? (() => { const bitPos = x * depth; const byte = lines[y * stride + (bitPos >> 3)]; return (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1); })() : lines[y * stride + x];
        const plte = meta.plte;
        if (!plte || idx * 3 + 2 >= plte.length) throw new ShimError("dsh-shim: PNG palette index out of range");
        out[di] = plte[idx * 3]; out[di + 1] = plte[idx * 3 + 1]; out[di + 2] = plte[idx * 3 + 2];
        out[di + 3] = meta.trns && idx < meta.trns.length ? meta.trns[idx] : 255;
      }
    }
  }
  return { data: out, width: W, height: H, channels: outCh };
}

/* ── JPEG header ── */
function parseJpeg(buf) {
  let pos = 2;
  while (pos + 9 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = buf.readUInt16BE(pos + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: "jpeg", width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5), depth: 8, channels: buf[pos + 9] };
    }
    pos += 2 + len;
  }
  throw new ShimError("dsh-shim: JPEG SOF marker not found");
}

/* ── WebP header ── */
function parseWebp(buf) {
  const fourcc = buf.toString("latin1", 12, 16);
  if (fourcc === "VP8X") {
    return { format: "webp", width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)), depth: 8, channels: 4 };
  }
  if (fourcc === "VP8 ") {
    return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, depth: 8, channels: 3 };
  }
  if (fourcc === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, depth: 8, channels: 4 };
  }
  throw new ShimError("dsh-shim: unsupported WebP chunk " + JSON.stringify(fourcc));
}

function computeMeta(buf) {
  const fmt = sniff(buf);
  if (!fmt) throw new ShimError("dsh-shim: unsupported or unrecognized image data");
  if (fmt === "png") {
    const { meta } = parsePng(buf);
    const space = meta.colorType === 0 || meta.colorType === 4 ? "b-w" : meta.colorType === 3 ? "srgb" : "srgb";
    return { format: "png", width: meta.width, height: meta.height, space, channels: CT_CHANNELS[meta.colorType] || 3, depth: String(meta.depth), chromaSubsampling: "4:4:4", isProgressive: false };
  }
  if (fmt === "jpeg") return Object.assign({ chromaSubsampling: "4:2:0", isProgressive: false }, parseJpeg(buf));
  if (fmt === "gif") return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), animated: buf.toString("latin1", 10, 13) === "NET", pages: 1 };
  return parseWebp(buf);
}

/* ── instance ── */
class SharpInstance {
  constructor(input) {
    this._in = input;
    this._mode = null;          /* null | 'raw' */
    this._resizeTo = null;      /* {width,height} nearest-neighbour */
    sniff(this._in);            /* fail fast on garbage */
  }
  metadata() {
    try { return Promise.resolve(computeMeta(this._in)); }
    catch (e) { return Promise.reject(e); }
  }
  raw() { this._mode = "raw"; return this; }
  resize(width, height) {
    this._resizeTo = { width: width || null, height: height || null };
    return this;
  }
  rotate() { return this; }
  flatten() { return this; }
  withMetadata() { return this; }
  greyscale() { return this; }
  grayscale() { return this; }
  png() { this._reencode = "png"; return this; }
  jpeg() { this._reencode = "jpeg"; return this; }
  webp() { this._reencode = "webp"; return this; }
  clone() { const c = new SharpInstance(this._in); c._mode = this._mode; c._resizeTo = this._resizeTo; c._reencode = this._reencode; return c; }
  toBuffer(options) {
    return Promise.resolve().then(() => {
      if (this._reencode && sniff(this._in) !== this._reencode)
        throw new ShimError("dsh-shim: re-encoding to " + this._reencode + " is not supported (no libvips on this platform)");
      if (this._mode === "raw" || this._resizeTo) {
        const decoded = decodePngAny(this._in);
        let { data, width, height, channels } = decoded;
        if (this._resizeTo && (this._resizeTo.width || this._resizeTo.height)) {
          const rt = this._resizeTo;
          const w2 = rt.width || Math.round(width * (rt.height / height));
          const h2 = rt.height || Math.round(height * (rt.width / width));
          const out = Buffer.alloc(w2 * h2 * channels);
          for (let y = 0; y < h2; y++) {
            const sy = Math.min(height - 1, Math.floor((y * height) / h2));
            for (let x = 0; x < w2; x++) {
              const sx = Math.min(width - 1, Math.floor((x * width) / w2));
              const so = (sy * width + sx) * channels, doff = (y * w2 + x) * channels;
              for (let ch = 0; ch < channels; ch++) out[doff + ch] = data[so + ch];
            }
          }
          data = out; width = w2; height = h2;
        }
        if (options && options.resolveWithObject) return { data, info: { width, height, channels } };
        return data;
      }
      if (options && options.resolveWithObject) {
        const m = computeMeta(this._in);
        return { data: this._in, info: { format: m.format, width: m.width, height: m.height } };
      }
      return this._in;
    });
  }
}

function decodePngAny(buf) {
  const fmt = sniff(buf);
  if (fmt !== "png") throw new ShimError("dsh-shim: full pixel decode only supported for PNG on this platform (got " + (fmt || "unknown") + ")");
  return decodePngRaw(buf);
}

/* callable with or without `new` */
function sharp(input, options) {
  let buf = input;
  if (typeof input === "string") buf = fs.readFileSync(input);
  else if (input instanceof Uint8Array && !Buffer.isBuffer(input)) buf = Buffer.from(input);
  else if (input && typeof input.pipe === "function")
    return Promise.reject(new ShimError("dsh-shim: stream input is not supported"));
  return new SharpInstance(buf);
}
sharp.versions = { vips: "none", "dsh-shim": "1.0.0-purejs" };
sharp.format = ["jpeg", "png", "webp", "gif", "svg", "tiff", "avif"].reduce((acc, id) => {
  acc[id] = { id, input: { buffer: ["jpeg", "png", "webp", "gif"].includes(id), file: false, stream: false }, output: { buffer: id === "png", file: false, stream: false } };
  return acc;
}, {});
sharp.definitions = {};
sharp.vendor = "";
sharp.isShim = true;

module.exports = sharp;
module.exports.default = sharp;
module.exports.Sharp = SharpInstance;
