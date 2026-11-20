// Text drawn the game's way (game mode): the retail TextMeshPro fonts, extracted as distance field atlases
// (tools/extract_assets/fonts.py, manifest keys `font/<slug>`), rendered on a canvas.
//
// A string is laid out from the glyph table, its glyphs are drawn scaled into a scratch canvas (the field interpolates
// well), and each pixel's coverage is read off the field at the stroke's edge, the way the TMP shader does it: edge at
// 0.5 minus the weight's bias, an outline further out, an underlay (drop shadow) under it. The result is cached per
// string, size, colours and pixel ratio, so a HUD that redraws every frame costs one drawImage per label.
//
// Without the extracted fonts (no art on the server) it falls back to the canvas's own text in a rounded sans, so the
// HUD still works.

const FALLBACK = '"Nunito", "Varela Round", system-ui, sans-serif';
const CACHE_MAX = 600;

export const FONTS = {
  label: "josefin-italic", // HUD labels, titles (retail: JosefinSans-Italic)
  thin: "josefin-thin", // popup buttons
  body: "nunito", // descriptions (retail: Nunito-ExtraLight)
  numbers: "roboto-numbers", // the big numbers in the top bar (retail: Roboto-Light_Numbers)
};

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`font atlas ${url}`));
    img.src = url;
  });
}

// the atlas as an opaque grey canvas (field in the colour channels), so glyph quads can be merged with `lighten`
function greyAtlas(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]; p[i] = a; p[i + 1] = a; p[i + 2] = a; p[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  return c;
}

function parseColour(c) {
  if (!c) return null;
  if (Array.isArray(c)) return c.length === 4 ? c : [...c, 1];
  let s = String(c).trim();
  if (s[0] === "#") {
    s = s.slice(1);
    if (s.length === 3 || s.length === 4) s = s.split("").map((ch) => ch + ch).join("");
    const n = (i) => parseInt(s.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), s.length >= 8 ? n(6) / 255 : 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) { const v = m[1].split(",").map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; }
  return [255, 255, 255, 1];
}

export function createText(manifest, base = "/art/") {
  const fonts = new Map(); // slug -> {meta, atlas}
  const cache = new Map();
  const stats = { strings: 0, hits: 0, fallback: 0 };
  const version = manifest && manifest.game_version ? `?v=${encodeURIComponent(manifest.game_version)}` : "";

  async function loadFont(slug) {
    const e = manifest && manifest.assets && manifest.assets[`font/${slug}`];
    if (!e) return;
    try {
      const [meta, img] = await Promise.all([
        fetch(`${base}${e.json}${version}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))),
        loadImage(`${base}${e.file}${version}`),
      ]);
      fonts.set(slug, { meta, atlas: greyAtlas(img) });
    } catch (err) {
      console.warn("font not loaded", slug, err);
    }
  }
  const ready = Promise.all(Object.values(FONTS).map(loadFont)).then(() => { cache.clear(); });

  // the chain of fonts a font's missing characters come from
  const chain = (slug) => [slug, FONTS.body, FONTS.label].filter((s, i, a) => a.indexOf(s) === i).map((s) => fonts.get(s)).filter(Boolean);

  function layout(str, slug, size) {
    const fs = chain(slug);
    if (!fs.length) return null;
    const main = fs[0].meta;
    const s0 = size / main.point_size;
    const quads = [];
    // the glyph quads' extent, padding included: what TextMeshPro's text bounds measure (x from the pen's start, y up)
    const box = { l: Infinity, r: -Infinity, t: -Infinity, b: Infinity };
    let pen = 0, prev = null;
    for (const ch of String(str)) {
      const cp = ch.codePointAt(0);
      let f = fs.find((x) => x.meta.glyphs[cp]);
      if (!f) f = fs.find((x) => x.meta.glyphs[63]); // "?"
      if (!f) continue;
      const g = f.meta.glyphs[cp] || f.meta.glyphs[63];
      const s = size / f.meta.point_size;
      if (prev != null && f === fs[0]) pen += (main.kerning[`${prev},${cp}`] || 0) * s;
      if (g[2] && g[3]) {
        quads.push({ f, g, x: pen, s });
        const P = f.meta.padding;
        box.l = Math.min(box.l, pen + (g[4] - P) * s);
        box.r = Math.max(box.r, pen + (g[4] + g[2] + P) * s);
        box.t = Math.max(box.t, (g[5] + P) * s);
        box.b = Math.min(box.b, (g[5] - g[3] - P) * s);
      }
      pen += g[6] * s;
      prev = cp;
    }
    if (!quads.length) Object.assign(box, { l: 0, r: 0, t: 0, b: 0 });
    return { quads, box, width: pen, ascent: main.ascent * s0, descent: -main.descent * s0, cap: (main.cap || main.ascent * 0.7) * s0, main };
  }

  function measure(str, o = {}) {
    const size = o.size || 16;
    const L = layout(str, o.font || FONTS.label, size);
    if (L) return { w: L.width, ascent: L.ascent, descent: L.descent, cap: L.cap, h: L.ascent + L.descent, box: L.box };
    const x = scratch(1, 1);
    x.font = `${o.bold ? 800 : 600} ${size}px ${FALLBACK}`;
    return { w: x.measureText(String(str)).width, ascent: size * 0.8, descent: size * 0.25, cap: size * 0.7, h: size * 1.05 };
  }

  let scratchCanvas = null;
  function scratch(w, h) {
    if (!scratchCanvas) scratchCanvas = document.createElement("canvas");
    if (scratchCanvas.width < w) scratchCanvas.width = w;
    if (scratchCanvas.height < h) scratchCanvas.height = h;
    return scratchCanvas.getContext("2d", { willReadFrequently: true });
  }

  // a bitmap of the string at device pixels: {canvas, w, h (device px), ox, oy (device px from the pen's origin on the baseline)}
  function render(str, o, dpr) {
    const size = o.size || 16;
    const slug = o.font || FONTS.label;
    const L = layout(str, slug, size);
    const fill = parseColour(o.colour || "#fff");
    const line = o.outline ? parseColour(o.outline.colour || "#000") : null;
    const under = o.shadow ? parseColour(o.shadow.colour || "rgba(0,0,0,0.55)") : null;
    const ow = o.outline ? o.outline.width || 1.5 : 0;
    const sdy = o.shadow ? (o.shadow.dy ?? 1.5) : 0, sdx = o.shadow ? (o.shadow.dx ?? 0) : 0;
    const margin = Math.ceil((ow + Math.max(Math.abs(sdy), Math.abs(sdx)) + 2) * dpr);
    if (!L) return renderFallback(str, o, dpr, fill, line, ow, under, sdx, sdy, margin);
    const W = Math.max(1, Math.ceil(L.width * dpr) + margin * 2 + Math.ceil(size * 0.3 * dpr));
    const H = Math.max(1, Math.ceil((L.ascent + L.descent) * dpr) + margin * 2 + Math.ceil(size * 0.2 * dpr));
    const baseX = margin, baseY = margin + Math.ceil(L.ascent * dpr);
    const x = scratch(W, H);
    x.save();
    x.globalCompositeOperation = "source-over";
    x.fillStyle = "#000";
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = "lighten";
    x.imageSmoothingEnabled = true;
    // point samples of the distance field, as the GPU takes them: averaging it over each pixel would blur the edge
    x.imageSmoothingQuality = "low";
    for (const q of L.quads) {
      const { g, f, s } = q;
      const P = f.meta.padding;
      const k = s * dpr;
      x.drawImage(f.atlas, g[0] - P, g[1] - P, g[2] + 2 * P, g[3] + 2 * P,
        baseX + (q.x + (g[4] - P) * s) * dpr, baseY - (g[5] + P) * k, (g[2] + 2 * P) * k, (g[3] + 2 * P) * k);
    }
    x.restore();
    const src = x.getImageData(0, 0, W, H);
    const m = L.main;
    const k = (size / m.point_size) * dpr; // device px per atlas px
    const spread = 2 * m.gradient_scale * k; // field units -> device px
    const weight = o.weight != null ? o.weight : o.bold ? m.weight_bold : m.weight_normal;
    const edge = 0.5 - (weight / 4 + (o.dilate || 0)) * m.scale_ratio * 0.5;
    const edgeOut = edge - (ow * dpr) / spread;
    const out = new ImageData(W, H);
    const S = src.data, D = out.data;
    const cov = (v, e) => Math.min(1, Math.max(0, (v - e) * spread + 0.5));
    const offX = Math.round(sdx * dpr), offY = Math.round(sdy * dpr);
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const i = (yy * W + xx) * 4;
        const v = S[i] / 255;
        let r = 0, gg = 0, b = 0, a = 0;
        if (under) {
          const sx2 = xx - offX, sy2 = yy - offY;
          if (sx2 >= 0 && sy2 >= 0 && sx2 < W && sy2 < H) {
            const vs = S[(sy2 * W + sx2) * 4] / 255;
            const ca = cov(vs, line ? edgeOut : edge) * under[3];
            r = under[0] * ca; gg = under[1] * ca; b = under[2] * ca; a = ca;
          }
        }
        if (line) {
          const ca = cov(v, edgeOut) * line[3];
          r = line[0] * ca + r * (1 - ca); gg = line[1] * ca + gg * (1 - ca); b = line[2] * ca + b * (1 - ca); a = ca + a * (1 - ca);
        }
        const cf = cov(v, edge) * fill[3];
        r = fill[0] * cf + r * (1 - cf); gg = fill[1] * cf + gg * (1 - cf); b = fill[2] * cf + b * (1 - cf); a = cf + a * (1 - cf);
        if (a > 0) { D[i] = r / a; D[i + 1] = gg / a; D[i + 2] = b / a; D[i + 3] = a * 255; }
      }
    }
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d").putImageData(out, 0, 0);
    return { canvas: c, w: W, h: H, ox: baseX, oy: baseY, width: L.width, ascent: L.ascent, descent: L.descent, cap: L.cap };
  }

  function renderFallback(str, o, dpr, fill, line, ow, under, sdx, sdy, margin) {
    stats.fallback++;
    const size = o.size || 16;
    const font = `${o.bold ? 800 : 600} ${size * dpr}px ${FALLBACK}`;
    const m = scratch(1, 1);
    m.font = font;
    const w = m.measureText(String(str)).width;
    const W = Math.ceil(w) + margin * 2 + 2, H = Math.ceil(size * 1.3 * dpr) + margin * 2;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d");
    x.font = font;
    x.textBaseline = "alphabetic";
    const by = margin + Math.ceil(size * 0.95 * dpr);
    const rgba = (v) => `rgba(${v[0]},${v[1]},${v[2]},${v[3]})`;
    if (under) { x.fillStyle = rgba(under); x.fillText(String(str), margin + sdx * dpr, by + sdy * dpr); }
    if (line) { x.lineJoin = "round"; x.lineWidth = ow * 2 * dpr; x.strokeStyle = rgba(line); x.strokeText(String(str), margin, by); }
    x.fillStyle = rgba(fill);
    x.fillText(String(str), margin, by);
    return { canvas: c, w: W, h: H, ox: margin, oy: by, width: w / dpr, ascent: size * 0.8, descent: size * 0.25, cap: size * 0.7 };
  }

  function bitmap(str, o, dpr) {
    const k = JSON.stringify([String(str), o.font, o.size, o.colour, o.weight, o.bold, o.dilate, o.outline, o.shadow, dpr, fonts.size]);
    let b = cache.get(k);
    if (b) { stats.hits++; cache.delete(k); cache.set(k, b); return b; }
    b = render(str, o, dpr);
    stats.strings++;
    cache.set(k, b);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return b;
  }

  // Draws `str` with its pen at (x, y) in the context's CSS px (the context is scaled by `dpr`).
  // align: left | center | right; baseline: alphabetic | middle (the cap height's middle) | top | bottom.
  // Returns the box drawn, in CSS px.
  function draw(ctx, str, x, y, o = {}) {
    if (str == null || str === "") return { x, y, w: 0, h: 0 };
    const dpr = o.dpr || ctx.__dpr || window.devicePixelRatio || 1;
    let opts = o;
    if (o.maxWidth) {
      const w = measure(str, o).w;
      if (w > o.maxWidth) opts = { ...o, size: Math.max(o.minSize || 8, Math.floor((o.size || 16) * (o.maxWidth / w) * 10) / 10) };
    }
    const b = bitmap(str, opts, dpr);
    let px = x;
    if (opts.align === "center") px -= b.width / 2;
    else if (opts.align === "right") px -= b.width;
    let py = y;
    if (opts.baseline === "middle") py += b.cap / 2;
    else if (opts.baseline === "top") py += b.ascent;
    else if (opts.baseline === "bottom") py -= b.descent;
    const left = px - b.ox / dpr, top = py - b.oy / dpr;
    const a = ctx.globalAlpha;
    if (opts.alpha != null) ctx.globalAlpha = a * opts.alpha;
    ctx.drawImage(b.canvas, left, top, b.w / dpr, b.h / dpr);
    ctx.globalAlpha = a;
    return { x: px, y: py - b.ascent, w: b.width, h: b.ascent + b.descent };
  }

  return { ready, measure, draw, stats, has: (slug) => fonts.has(slug), get loaded() { return [...fonts.keys()]; } };
}
