// Touch board renderer (CONTRACTS.md section 6). Draws a position, or one player's view of it, on a canvas in the
// game's isometric diamond, and turns Pointer Events into pan, pinch zoom, tap and long press. It knows no game
// rules: the caller says what to mark (setOverlays) and what a tap means (onTap).
//
//   import { createBoard } from "board/board.js";
//   const board = createBoard(canvas, { meta, onTap, onLongPress, onViewChange });
//
// `meta` is the reply of GET /api/meta.
//
// Geometry (from editor/static/app.js): tile (x, y) sits at lattice (i, j) = (N-1-y, N-1-x), i running down-right
// and j down-left from the top corner of the diamond. Tiles are drawn back to front (x + y descending) with the
// stamps /api/stamp renders from the game's sprites, which overlap their neighbours the way the game's do.

const SLOPE = 0.594;
const TAP_SLOP = 10; // px a finger may move and still be a tap
const TAP_MS = 400; // retail: a touch under 400 ms is a tap, from 400 ms a long press (options tapMs, longPressMs)
const LONG_PRESS_MS = 400;
const HOVER_MS = 500; // a mouse resting on a tile this long reports a hover (option hoverMs)
const MARKER_HIT = 24; // px: a tap this close to a target marker picks that marker's tile
const MAX_FETCHES = 6;

// ---------- images: fetched once, kept as ImageBitmaps, shared by every board on the page ----------
const images = new Map(); // url -> {state: "loading" | "ok" | "failed", img}
const listeners = new Set();
const queue = [];
let inFlight = 0;

function pump() {
  while (inFlight < MAX_FETCHES && queue.length) {
    const entry = queue.shift();
    inFlight++;
    load(entry).finally(() => {
      inFlight--;
      for (const l of listeners) l();
      pump();
    });
  }
}

async function load(entry) {
  try {
    const resp = await fetch(entry.url, { credentials: "same-origin" });
    if (!resp.ok) throw new Error(String(resp.status));
    const blob = await resp.blob();
    entry.img = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : await blobToImage(blob);
    entry.state = "ok";
  } catch (e) {
    entry.state = "failed";
  }
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function image(url) {
  let e = images.get(url);
  if (!e) {
    e = { state: "loading", img: null, url };
    images.set(url, e);
    queue.push(e);
    pump();
  }
  return e;
}

const tintCache = new Map(); // "url|r,g,b" -> a canvas: a white sprite in one colour

// the box of an image's solid pixels, [x0, y0, x1, y1] in a w by h sprite (the whole sprite when it cannot be read)
const boxCache = new WeakMap();
function opaqueBox(img, w, h) {
  let b = boxCache.get(img);
  if (!b) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    b = [0, 0, 1, 1];
    try {
      const c = document.createElement("canvas");
      c.width = iw; c.height = ih;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, iw, ih).data;
      let x0 = iw, y0 = ih, x1 = -1, y1 = -1;
      for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
        // above 128: past a unit's soft shadow
        if (d[(y * iw + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 >= 0) b = [x0 / iw, y0 / ih, (x1 + 1) / iw, (y1 + 1) / ih];
    } catch (e) { /* unreadable: the whole sprite */ }
    boxCache.set(img, b);
  }
  return [b[0] * w, b[1] * h, b[2] * w, b[3] * h];
}

// whether an image has a solid pixel at (fx, fy), each 0..1 across it (never, when it cannot be read). The alpha is kept
// at half size: enough for a pointer, and a quarter of the memory.
const solidCache = new WeakMap();
function solidAt(img, fx, fy) {
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return false;
  let m = solidCache.get(img);
  if (m === undefined) {
    m = null;
    try {
      const w = Math.max(1, Math.ceil((img.naturalWidth || img.width) / 2)), h = Math.max(1, Math.ceil((img.naturalHeight || img.height) / 2));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
      m = { w, h, a };
    } catch (e) { /* unreadable: nothing solid */ }
    solidCache.set(img, m);
  }
  // above 128: past a sprite's soft shadow
  return !!m && m.a[Math.floor(fy * m.h) * m.w + Math.floor(fx * m.w)] > 128;
}

// ---------- positions -> what the board draws ----------
const WATER = new Set([1, 2]);
const TERRAIN_FLAT = { 1: "rgba(70,140,220,0.7)", 2: "rgba(40,100,190,0.75)", 3: "rgba(120,170,90,0.7)", 4: "rgba(140,140,150,0.8)", 5: "rgba(60,120,70,0.8)" };
const RAFT = 43; // a land unit on water rides in the basic boat

function normalise(pos) {
  const g = (pos && pos.game) || {};
  const list = (pos && pos.tiles) || [];
  let n = g.width || (pos && pos.size) || 0;
  if (!n) for (const t of list) n = Math.max(n, t.x + 1, t.y + 1);
  const tiles = new Array(n * n).fill(null);
  for (const t of list) {
    if (!(t.x >= 0 && t.y >= 0 && t.x < n && t.y < n)) continue;
    const city = !!t.city || t.improvement === 1;
    tiles[t.y * n + t.x] = {
      raw: t, x: t.x, y: t.y, known: !!t.terrain, terrain: t.terrain || 0, climate: t.climate ?? 2,
      resource: t.resource || 0, improvement: city ? 0 : t.improvement || 0, city, capital: !!t.capital,
      owner: t.owner || 0, road: !!t.road, level: t.level || 1, name: t.name || "",
      explored: t.explored == null ? null : t.explored,
      // whose capital the city is: its holder, or `capital_of` once another player has taken it (it keeps the building)
      capitalOf: t.capital ? t.capital_of ?? t.owner ?? 0 : 0,
    };
  }
  for (const r of (pos && pos.improvements) || []) {
    const t = r.x >= 0 && r.y >= 0 && r.x < n && r.y < n ? tiles[r.y * n + r.x] : null;
    if (!t) continue;
    // A village is a tile with improvement 1 and an owner-0 record. Ruins (2) and the corner lighthouses (47) also carry
    // owner-0 records; they stay what their tile says.
    if (r.name) t.name = r.name;
    if (t.city && r.level) t.level = r.level;
    // a lighthouse's record: its level (one more than its floors) and who has found it, first finder first
    if (!t.city) { t.towerLevel = r.level ?? null; t.foundBy = Array.isArray(r.found_by) ? r.found_by : null; }
    if (t.city) {
      t.xp = r.xp ?? r.population ?? null;
      t.production = r.production ?? null;
      t.work = r.work ?? null; // the stars a turn the city brings its owner (added by the engine service)
      t.rewards = Array.isArray(r.rewards) ? r.rewards : [];
      t.embassies = Array.isArray(r.embassies) ? r.embassies : []; // the players with an embassy in this capital
    }
  }
  const units = ((pos && pos.units) || []).filter((u) => u.x >= 0 && u.y >= 0 && u.x < n && u.y < n);
  let homes = false; // units supported: those whose home is the city (only when the position says where homes are)
  for (const u of units) {
    const h = Array.isArray(u.home) ? u.home : u.home && typeof u.home.x === "number" ? [u.home.x, u.home.y] : null;
    if (!h) continue;
    homes = true;
    const c = h[0] >= 0 && h[0] < n && h[1] >= 0 && h[1] < n ? tiles[h[1] * n + h[0]] : null;
    if (c && c.city && c.owner === u.owner) c.supported = (c.supported || 0) + 1;
  }
  if (homes) for (const t of tiles) if (t && t.city && t.xp != null && !t.supported) t.supported = 0;
  return { n, tiles, units, players: (pos && pos.players) || [] };
}

const asXY = (a) => (Array.isArray(a) ? [a[0], a[1]] : a && typeof a.x === "number" ? [a.x, a.y] : null);

// cells of an overlay: `at`, or `cells` as [x, y], [x, y, value], {x, y} or {at, v, label}
function overlayCells(o) {
  const out = [];
  const add = (c) => {
    if (Array.isArray(c)) out.push({ x: c[0], y: c[1], v: c[2] });
    else if (c && c.at) out.push({ x: asXY(c.at)[0], y: asXY(c.at)[1], v: c.v, label: c.label });
    else if (c && typeof c.x === "number") out.push({ x: c.x, y: c.y, v: c.v, label: c.label });
  };
  if (o.at) {
    const a = asXY(o.at);
    if (a) out.push({ x: a[0], y: a[1] });
  }
  for (const c of o.cells || []) add(c);
  return out;
}

const MARKER_KINDS = new Set(["target", "move", "attack", "kill", "disembark"]);
const KIND_COLOURS = {
  target: "#ffd65a", move: "#4aa3ff", attack: "#ff5a5a", kill: "#ff2d55", disembark: "#2dd4bf", path: "#4aa3ff", arrow: "#ffd65a",
  heat: "#ff5a5a", ring: "#5ad19a",
};
// the game's own sprites for the tappable targets, and their size against the art's
const MARKER_ART = { move: "fx/movetarget", attack: "fx/attacktarget", kill: "fx/killtarget", disembark: "fx/disembarktarget" };
const MARKER_SCALE = 0.75;
const TERRAIN_ART = { 1: "water", 2: "ocean", 3: "field", 4: "mountain", 5: "forest", 6: "ice", 7: "wetland" };
const RESOURCE_ART = { 1: "game", 2: "crop", 3: "fish", 4: "whale", 5: "metal", 6: "fruit", 7: "spores", 8: "starfish", 9: "aquacrop" };
const ART_PER_SX = 1 / 128; // composed art is 256 px per tile wide, a tile is 2 * sx on screen
const ART_PPU = 265.08197; // composed art pixels per retail world unit (the ground blocks' ppu)

// A besieged city burns: retail's "Fire" prefab (Tile.SpawnFire), read from its particle systems. Fire: FlameGFX
// particles, 5 a second from a 0.6 wu edge through the tile, rising at 0.3 to 0.6 wu/s against a 0.05 wu/s² pull,
// living 0.6 s, growing from nothing to 0.1 wu wide and fading 1, 0.89 (half way), 0. Embers: 0.015 wu sparks, 20 a
// second falling to none over each 1 s loop, from a 0.5 wu square turned 45°, living 1 to 3 s, rising 0.4 wu/s and
// drifting sideways between two velocity curves, through a white, yellow, red, white, orange, red, black gradient
// that blinks out and back. Shadow: GenericFade in black under them.
const FIRE = { rate: 5, life: 0.6, edge: 0.3, speed: [0.3, 0.6], pull: 0.05, width: 0.1, alpha: [[0, 1], [0.5, 0.888], [1, 0]] };
const EMBERS = {
  peak: 20, life: [1, 3], half: 0.354, rise: 0.4, size: 0.015,
  driftA: [[0.002, -0.499], [0.174, 0.136], [0.604, -0.423], [0.992, 0.471]],
  driftB: [[0.002, 0.532], [0.326, -0.424], [0.566, 0.098], [0.981, -0.56]],
  rgb: [[0, 254, 255, 255], [0.088, 254, 255, 0], [0.238, 255, 51, 0], [0.556, 254, 243, 255], [0.582, 254, 255, 0], [0.641, 255, 144, 0], [0.697, 255, 52, 0], [0.903, 0, 0, 0]],
  alpha: [[0, 1], [0.256, 1], [0.388, 0], [0.55, 0], [0.553, 1], [0.815, 1], [1, 0]],
};
// piecewise linear through [[t, v...], ...]
function keyed(keys, t) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b[0]) { const f = (t - a[0]) / (b[0] - a[0] || 1); return a.slice(1).map((v, j) => v + (b[j + 1] - v) * f); }
  }
  return keys[keys.length - 1].slice(1);
}
// a fixed random number in [0, 1) for a particle (city tile, system, particle number, which value)
function rnd(a, b, c, d) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 1, 0x27d4eb2f) ^ Math.imul(d + 7, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export function createBoard(canvas, opts = {}) {
  const meta = opts.meta || {};
  const geo = meta.stamp || { sx: 64, width: 256, height: 320, anchor: [128, 190] };
  const minTapScale = opts.minTapScale ?? 24;
  const dprCap = opts.dprCap ?? 2;
  const tapMs = opts.tapMs ?? TAP_MS, longPressMs = opts.longPressMs ?? LONG_PRESS_MS, hoverMs = opts.hoverMs ?? HOVER_MS;
  const ctx = canvas.getContext("2d");
  let insets = { top: 0, bottom: 0 }; // px of the canvas a sheet or bar covers: centreOn and reveal use what is left
  let art = opts.art || null; // {manifest, base?: "/art/", version?}: the extracted game art; absent, the stamps are drawn
  let textDrawer = opts.text || null; // draws strings in the game's fonts (setText); absent, the canvas's own text
  const fx = []; // running effects: {update(now) -> done}
  const overrides = new Map(); // unit id -> {x, y, alpha, flip, hidden}: a unit drawn off its tile while an effect plays
  const flips = new Map(); // unit id -> true when it last walked left on screen
  const seenDir = new Map(); // unit id -> the engine direction it last had

  let pos = { n: 0, tiles: [], units: [], players: [] };
  let fogFor = null;
  let overlays = [];
  let glows = new Map(); // "x,y" -> {colour, v}: the "glow" overlays, drawn as a halo round the item on the tile
  let selected = null;
  let cssW = 0, cssH = 0, dpr = 1;
  const view = { sx: 10, ox: 0, oy: 0 };
  let touched = false; // the user (or the caller) moved the view, so a new position keeps it
  let fitSx = 10;
  let dirty = true;
  let frame = 0;
  let destroyed = false;
  let anim = null; // {t0, dur, from, to}
  let momentum = null; // {vx, vy, t}
  // camera feel, off unless asked for (setFeel): `elastic` lets a drag pull past the edge with resistance and springs
  // back on release; `smoothZoom` glides the wheel zoom to its target instead of stepping
  const feel = { elastic: !!(opts.feel && opts.feel.elastic), smoothZoom: !!(opts.feel && opts.feel.smoothZoom) };
  let zoomGlide = null; // {sx, px, py, t}: where the wheel zoom is gliding to
  let viewReported = "";
  // plates: the city plates the last draw made; units and badges: each unit drawn and each unit badge; fx: effects started
  // and finished, how many of each name, and a log of the last 400 ({name, ms}); cameraMoves: view animations started
  // fires: the besieged cities the last draw set alight ({x, y, cx, cy, particles}); clouds: presses and releases of a
  // cloud and how far the last one is sunk (world units); puff: the last puff ({key, drawn, scale, alpha, x, y})
  const stats = { draws: 0, lastMs: 0, lastTiles: 0, plates: [], glows: 0, units: [], badges: [], badgeBoxes: [], fires: [], fx: { started: 0, finished: 0, names: {}, log: [] }, cameraMoves: 0, springs: 0, swing: null, projectile: null, clouds: { presses: 0, releases: 0, sink: 0 }, puff: null, cities: [] };

  canvas.style.touchAction = "none"; // the board only; the rest of the page scrolls normally
  canvas.style.userSelect = "none";
  canvas.style.webkitUserSelect = "none";
  canvas.style.webkitTouchCallout = "none";

  const sy = () => view.sx * SLOPE;
  const inside = (x, y) => x >= 0 && y >= 0 && x < pos.n && y < pos.n;
  const tileAtXY = (x, y) => (inside(x, y) ? pos.tiles[y * pos.n + x] : null);
  const corner = (x, y) => {
    const i = pos.n - 1 - y, j = pos.n - 1 - x;
    return [view.ox + (i - j) * view.sx, view.oy + (i + j) * sy()];
  };
  const centre = (x, y) => {
    const c = corner(x, y);
    return [c[0], c[1] + sy()];
  };
  function flatTileUnder(px, py) {
    const dx = (px - view.ox) / view.sx, dy = (py - view.oy) / sy();
    const i = Math.floor((dx + dy) / 2), j = Math.floor((dy - dx) / 2);
    return [pos.n - 1 - j, pos.n - 1 - i];
  }

  // ---------- players, units, stamps ----------
  const tribeInfo = (tribe) => {
    const list = meta.tribes || [];
    return typeof tribe === "string" ? list.find((t) => t.name === tribe) : list.find((t) => t.idx === tribe);
  };
  const playerTribe = (owner) => {
    const p = pos.players.find((q) => q.id === owner);
    return p ? p.tribe : null;
  };
  const tribeIdx = (owner) => tribeInfo(playerTribe(owner))?.idx ?? 1;
  const tribeColour = (owner) => tribeInfo(playerTribe(owner))?.colour || "#999999";
  const unitInfo = (type) => (meta.engine?.units || []).find((u) => u.idx === type);
  const unitName = (type) => unitInfo(type)?.id || `unit ${type}`;
  const hasAbility = (type, a) => !!unitInfo(type)?.abilities?.includes(a);
  const maxHealth = (u) => (u.passenger && !hasAbility(u.type, "protect") ? maxHealth(u.passenger) : (unitInfo(u.type)?.health || 100) + 50 * (u.promotion || 0));
  const isWater = (t) => !!t && WATER.has(t.terrain);

  const explored = (t, p) => !t || t.explored == null || t.explored.includes(p);
  const fogged = (t) => fogFor != null && (!t || !explored(t, fogFor));

  function tileImage(t) {
    const lvl = Math.min(4, Math.max(1, t.level));
    const village = t.city && !t.owner && !t.capital ? 1 : 0; // a city nobody owns is a village, as in the art; a capital keeps its look
    return image(`/api/stamp?t=${t.terrain}&c=${t.climate}&r=${t.resource}&i=${t.improvement}&city=${t.city ? 1 : 0}&cap=${t.capital ? 1 : 0}&lvl=${lvl}&village=${village}`);
  }
  function unitImage(u) {
    if (meta.unit_sprites && !meta.unit_sprites.includes(u.type)) return null;
    const water = isWater(tileAtXY(u.x, u.y)) ? 1 : 0;
    return image(`/api/unitstamp?type=${u.type}&tribe=${tribeIdx(u.owner)}&water=${water}`);
  }

  // ---------- the extracted game art (optional): layers anchored on the tile's top-face centre ----------
  const artEntry = (key) => art && art.manifest && art.manifest.assets ? art.manifest.assets[key] : null;
  function artImage(a) {
    if (a.picture) return a.picture; // made here, not loaded (a built city)
    const base = art.base || "/art/";
    return image(`${base}${a.file}${art.version ? `?v=${encodeURIComponent(art.version)}` : ""}`);
  }
  const tribeName = (idx) => tribeInfo(idx)?.name || null;
  const ownerTribeName = (owner) => tribeInfo(playerTribe(owner))?.name || null;
  const improvementId = (idx) => (meta.engine?.improvements || []).find((i) => i.idx === idx)?.id || null;

  // The layers of a tile, bottom to top, as manifest entries; null when the art lacks one (the caller draws the stamp)
  const artClimate = (t) => tribeName(t.climate) || ownerTribeName(t.owner) || "bardur";
  function artBase(t) {
    const terrain = TERRAIN_ART[t.terrain];
    return terrain && (artEntry(`tile/${artClimate(t)}/${terrain}`) || artEntry(`tile/bardur/${terrain}`));
  }
  // A forest or mountain tile as its block ("ground") and the feature on it, drawn apart so the back borders go between
  // them; null while the tribe's art lacks the split or its images are not loaded yet
  function artSplit(t) {
    const climate = artClimate(t), terrain = TERRAIN_ART[t.terrain];
    const ground = artEntry(`tile/${climate}/${terrain}/ground`), feature = artEntry(`tile/${climate}/${terrain}/feature`);
    return ground && feature && artImage(ground).state === "ok" && artImage(feature).state === "ok" ? { ground, feature } : null;
  }
  // A city as retail builds it (CityRenderer.RefreshCity, CityPlot.AddHouse): its houses stand on a square grid of plots,
  // 2 a side at level 1, 3 at levels 2 to 4 and 4 from level 5, and stack in floors on a plot.
  // - The houses: floor(16 x level^2 / 10) + 4 x level - 1 of them, each of a kind drawn from 1 to the level (5 at
  //   most) and put at a random place in the list; then the Workshop and one Park for each park reward.
  // - Each goes on the next plot, one or two plots on from the last (back to the first after the last), the plots
  //   counted from the back of the tile to the front; an embassy for each player who has one follows the same way but
  //   never takes the front plot.
  // - The capital's building goes on top of the front plot, in the look of the tribe it is the capital of, and the City
  //   Wall round the whole in front.
  // - A Luxidoor capital still held by Luxidoor is built a level higher and with a park more (their tribe bonus).
  // - The houses and the wall of a city that is not the viewer's are paler (TerrainMaterialHelper.SetSpriteSaturated,
  //   see `paled`); the embassies keep their colours.
  // Retail draws its random numbers from the game's seed and the tile, which the page is not told, so the houses are
  // those of a generator seeded by the tile alone: one city keeps its look, and it is not retail's own for that game.
  // The parts are placed by `geometry.city` (art px up from the centre of the tile's drawn top face). null when the art
  // has no parts for the tribe (an older extraction): the caller draws the fixed picture and `rewardLayers` over it.
  const cityParts = new Map(); // "key|dx|dy|colour|pale" -> the part's entry moved by (dx, dy) art px, with its colour
  function cityPart(key, dx, dy, shade = null, pale = false) {
    const a = artEntry(key);
    if (!a) return null;
    const k = `${key}|${dx}|${dy}|${shade}|${pale}`;
    let p = cityParts.get(k);
    if (!p || p.of !== a) cityParts.set(k, (p = { ...a, of: a, anchor: [a.anchor[0] - dx, a.anchor[1] - dy], shade, pale }));
    return p;
  }
  function cityRandom(x, y) {
    let s = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let v = Math.imul(s ^ (s >>> 15), 1 | s);
      v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
      return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
    };
  }
  const cityBuilt = new Map(); // "x,y" -> {sig, art, layers, on}: `on` is each layer's [i, j, floor] on the grid, null for the wall
  function cityLayers(t) {
    const geo = art?.manifest?.geometry?.city;
    const tribe = ownerTribeName(t.owner);
    if (!geo || !tribe || !artEntry(`city/${tribe}/house/1`)) return null;
    const rewards = t.rewards || [];
    const own = t.capitalOf && t.capitalOf === t.owner;
    const bonus = own && tribe === "luxidoor" ? 1 : 0;
    const level = Math.max(1, t.level) + bonus;
    const parks = rewards.filter((r) => r === REWARD_PARK).length + bonus;
    const embassies = own ? t.embassies || [] : [];
    const capitalTribe = t.capitalOf ? ownerTribeName(t.capitalOf) || tribe : null;
    const pale = fogFor != null && fogFor !== t.owner; // nobody's city is another's when the board is shown whole
    const sig = [tribe, level, parks, rewards.includes(REWARD_WORKSHOP), rewards.includes(REWARD_WALL), capitalTribe, pale,
      embassies.map((p) => `${p}:${ownerTribeName(p)}:${tribeColour(p)}`).join("/")].join("|");
    const k = `${t.x},${t.y}`;
    const had = cityBuilt.get(k);
    if (had && had.sig === sig && had.art === art) return had.layers;

    const rnd = cityRandom(t.x, t.y);
    const pick = (n) => Math.min(n - 1, Math.floor(rnd() * n)); // a whole number under n; 0 when n is under 1
    const size = level <= 1 ? 2 : level <= 4 ? 3 : 4;
    // the plots from the front of the tile to the back, a diagonal at a time, then turned round as retail's list is
    const plots = [];
    for (let d = 0; d <= 2 * (size - 1); d++) for (let i = Math.min(d, size - 1); i >= 0 && d - i < size; i--) plots.push({ i, j: d - i, order: -plots.length - d, houses: [] });
    const front = plots[0];
    plots.reverse();

    const kinds = Math.min(level, 5);
    const houses = [];
    for (let n = Math.floor((16 * level * level) / 10) + 4 * level - 1; n > 0; n--) {
      const kind = `city/${tribe}/house/${1 + pick(kinds)}`;
      houses.splice(houses.length > 0 ? Math.max(0, pick(houses.length - 1)) : 0, 0, [kind, null]);
    }
    if (rewards.includes(REWARD_WORKSHOP)) houses.push(["city/part/workshop", null]);
    for (let n = 0; n < parks; n++) houses.push(["city/part/park", null]);
    let at = 0;
    const next = (count) => {
      const to = at + Math.max(1, Math.ceil(rnd() * 1.5));
      at = to <= count ? to : 1;
      return plots[at - 1];
    };
    for (const h of houses) next(plots.length).houses.push(h);
    for (const p of embassies) {
      const plot = next(plots.length - 1);
      const look = ownerTribeName(p);
      if (look) plot.houses.push([artEntry(`city/${look}/embassy`) ? `city/${look}/embassy` : `city/${tribe}/embassy`, tribeColour(p)]);
    }
    if (capitalTribe) front.houses.push([artEntry(`city/${capitalTribe}/capital`) ? `city/${capitalTribe}/capital` : `city/${tribe}/capital`, null]);

    // Drawn in retail's sorting order: a plot's is one lower for each plot before it in the front to back list and for
    // each diagonal back, and a house adds its floor, so a high floor shows over the foot of the plot in front; then
    // the wall over them all. The composed art's anchor is face_dy px above the centre of the drawn face, which the
    // layout is measured from.
    const placed = [], face = landFace();
    for (const plot of plots) {
      const dx = (plot.i - plot.j) * geo.plot[0], up = geo.front[size] + (plot.i + plot.j) * geo.plot[1];
      plot.houses.forEach(([key, colour], floor) => {
        const dy = face - up - floor * geo.floor;
        const on = [plot.i, plot.j, floor];
        placed.push({ order: plot.order + floor, parts: colour ? [cityPart(key, dx, dy), cityPart("city/part/embassy_tint", dx, dy, colour)] : [cityPart(key, dx, dy, null, pale)], on });
      });
    }
    placed.sort((a, b) => a.order - b.order); // stable: equal orders stay back to front
    const all = placed.flatMap((p) => p.parts.map((part) => [part, p.on]));
    if (rewards.includes(REWARD_WALL)) all.push([cityPart("city/part/wall", 0, face - geo.wall, null, pale), null]);
    const drawn = all.filter(([part]) => part), out = drawn.map(([part]) => part);
    cityBuilt.set(k, { sig, art, layers: out, on: drawn.map(([, on]) => on) });
    return out;
  }
  // A built city as one picture, an entry like the art's own (made once the images of all its parts have loaded; null
  // before). A big city is over a hundred houses, and a board of them drawn a house at a time is thousands of
  // drawImage calls a frame: past about 3,500 Chrome takes a quarter of a second over one. As one picture the
  // highlight also goes round the city, not round each house.
  function cityWhole(built, k) {
    if (built.whole) return built.whole;
    const imgs = built.layers.map(artImage);
    if (!imgs.length || imgs.some((e) => e.state !== "ok")) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, r = 1; // the box in art px from the anchor; image px per art px
    built.layers.forEach((a, i) => {
      x0 = Math.min(x0, -a.anchor[0]); x1 = Math.max(x1, a.w - a.anchor[0]);
      y0 = Math.min(y0, -a.anchor[1]); y1 = Math.max(y1, a.h - a.anchor[1]);
      r = Math.max(r, imgs[i].img.width / a.w);
    });
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    const c = document.createElement("canvas");
    c.width = Math.ceil((x1 - x0) * r); c.height = Math.ceil((y1 - y0) * r);
    const g = c.getContext("2d");
    built.layers.forEach((a, i) => g.drawImage(partImage(a, imgs[i]), Math.round((-a.anchor[0] - x0) * r), Math.round((-a.anchor[1] - y0) * r), a.w * r, a.h * r));
    return (built.whole = { w: c.width / r, h: c.height / r, anchor: [-x0, -y0], built, picture: { state: "ok", img: c, url: `city|${k}|${built.sig}` } });
  }
  // what `stats.cities` says of a city's layers. `at`: where each stands, in art px right of and below its own anchor;
  // `on`: its plot and floor (a city built of its parts; [0, 0] and null otherwise)
  const cityStat = (layers, built) => ({
    layers: layers.map((a) => a.file), pale: layers.map((a) => !!a.pale),
    at: layers.map((a) => (a.of ? [a.of.anchor[0] - a.anchor[0], a.of.anchor[1] - a.anchor[1]] : [0, 0])),
    on: layers.map((a, i) => (built && built.layers[i] === a ? built.on[i] : null)),
  });

  // The rewards over the fixed city picture of an art folder without the city's parts: the Workshop building and each
  // Park in three slots (left, front, inner left), then the City Wall in front of them. `rewards` holds retail's numbers
  // (CityWall 1, Park 2, Workshop 3). Drawn back to front.
  const REWARD_WALL = 1, REWARD_PARK = 2, REWARD_WORKSHOP = 3;
  function rewardLayers(t) {
    const r = t.rewards || [];
    const parks = Math.min(3, r.filter((x) => x === REWARD_PARK).length);
    const out = [
      parks >= 1 && artEntry("city/park/1"),
      r.includes(REWARD_WORKSHOP) && artEntry("city/workshop"),
      parks >= 3 && artEntry("city/park/3"),
      parks >= 2 && artEntry("city/park/2"),
      r.includes(REWARD_WALL) && artEntry("city/wall"),
    ];
    return out.filter(Boolean);
  }
  function artTileLayers(t) {
    if (!art) return null;
    const climate = artClimate(t);
    const base = artBase(t);
    if (!base) return null;
    const layers = [base];
    if (t.city) {
      const tribe = ownerTribeName(t.owner) || climate;
      // a village is the game's one neutral huts sprite; `city/<climate>/village` is the older art folder's stand-in
      const village = artEntry("city/village") || artEntry(`city/${climate}/village`);
      const built = t.owner ? cityLayers(t) : null;
      if (built) {
        const k = `${t.x},${t.y}`, whole = cityWhole(cityBuilt.get(k), k);
        return whole ? [base, whole] : layers.concat(built);
      }
      const c = t.owner ? artEntry(`city/${tribe}/${Math.min(4, Math.max(1, t.level))}`) || village : village;
      if (!c) return null;
      layers.push(c);
      if (t.owner) layers.push(...rewardLayers(t));
    } else if (t.improvement) {
      const id = improvementId(t.improvement);
      if (id === "road" || id === "none") return layers;
      const tower = id === "lighthouse" ? lighthouseLayers(t) : null;
      if (tower) return layers.concat(tower);
      const mono = /^monument\d$/.test(id || "");
      const a = id && (mono ? artEntry(`improvement/${id}/${ownerTribeName(t.owner) || climate}`) : artEntry(`improvement/${id}`));
      if (a) layers.push(a);
    } else if (t.resource) {
      const r = RESOURCE_ART[t.resource];
      const key = r && (r === "fruit" || r === "game" ? `${r}/${climate}` : r);
      const a = key && artEntry(`resource/${key}`);
      if (a) {
        layers.push(a);
        const o = artEntry(`resourceglow/${key}`);
        if (o) gameOutline.set(a, o);
      }
    }
    return layers;
  }
  // manifest entry -> the game's outline image for it, for the highlight (outlineArt)
  const gameOutline = new WeakMap();

  // The lighthouse as the game builds it (Lighthouse.UpdateObject, BuildingTowerHelper): one section for each player who
  // has found it (its level less one), each with a gem in that player's colour, the first finder's at the bottom, and
  // the roof on top. The art has the parts where the prefab puts them: the section and the gem on the first floor, the
  // roof over `floors` floors, `step` art px from one floor to the next, and all of it `land_dy` px lower on land than
  // on water. null when the art has no parts (an older extraction): the caller draws the fixed two-floor picture.
  const towerParts = new Map(); // "part|rise|colour" -> the part's entry raised by `rise` art px, a gem with its colour
  function towerPart(name, rise, shade = null) {
    const a = artEntry(`improvement/lighthouse/${name}`);
    if (!a) return null;
    const k = `${name}|${rise}|${shade}`;
    let p = towerParts.get(k);
    if (!p || p.of !== a) towerParts.set(k, (p = { ...a, of: a, anchor: [a.anchor[0], a.anchor[1] + rise], shade }));
    return p;
  }
  function lighthouseLayers(t) {
    const section = artEntry("improvement/lighthouse/section");
    if (!section || !artEntry("improvement/lighthouse/roof")) return null;
    const found = t.foundBy || t.explored || [];
    const n = t.towerLevel != null ? Math.max(0, t.towerLevel - 1) : Math.max(1, found.length);
    const step = section.step || 0, base = isWater(t) ? 0 : -(section.land_dy || 0);
    const out = [towerPart("shadow", base)];
    for (let i = 0; i < n; i++) {
      out.push(towerPart("section", base + i * step));
      out.push(towerPart("gem", base + i * step, found[i] != null ? tribeColour(found[i]) : "#ffffff"));
    }
    out.push(towerPart("roof", base + (n - (section.floors || 2)) * step));
    return out.filter(Boolean);
  }

  // The composed art is anchored a little above the centre of the tile's drawn top face (geometry.face_dy px at scale 1 for
  // a land block). drawArt lifts every piece by that much, so a land tile's top face sits on its diamond and what the
  // board draws on the diamond (borders, labels, selection, markers) lies on the art. Water is drawn lower than land by
  // the difference of the two face_dy; `faceDrop` is that, for the things drawn on a water tile's surface (not its borders).
  const artScale = () => view.sx * ART_PER_SX;
  const landFace = () => art?.manifest?.geometry?.face_dy ?? 0;
  function faceDrop(t) {
    const base = t && t.known ? artBase(t) : null;
    return base && base.face_dy != null ? (base.face_dy - landFace()) * artScale() : 0;
  }

  // `tint`: [r, g, b] draws the sprite as a flat silhouette in that colour (a hit flash)
  function drawArt(a, x, y, alpha = 1, flip = false, scale = 1, lift = 0, tint = null, cut = 0) {
    const e = artImage(a);
    if (e.state !== "ok") return e.state === "loading";
    const k = view.sx * ART_PER_SX * scale;
    lift += landFace() * artScale();
    const [cx, cy] = centre(x, y);
    const src = tint ? tinted(e, tint, cut) : partImage(a, e);
    ctx.globalAlpha = alpha;
    if (flip) {
      ctx.save();
      ctx.translate(cx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, -a.anchor[0] * k, cy - a.anchor[1] * k - lift, a.w * k, a.h * k);
      ctx.restore();
    } else {
      ctx.drawImage(src, cx - a.anchor[0] * k, cy - a.anchor[1] * k - lift, a.w * k, a.h * k);
    }
    ctx.globalAlpha = 1;
    return true;
  }
  // whether the art, drawn on tile (x, y) as drawArt draws it, has a solid pixel at a point of the canvas
  function artCovers(a, x, y, px, py, flip = false, scale = 1, lift = 0) {
    const e = artImage(a);
    if (e.state !== "ok") return false;
    const k = view.sx * ART_PER_SX * scale;
    const [cx, cy] = centre(x, y);
    const u = ((flip ? cx - px : px - cx) / k + a.anchor[0]) / a.w;
    const v = ((py - cy + lift + landFace() * artScale()) / k + a.anchor[1]) / a.h;
    return solidAt(e.img, u, v);
  }

  // the unit's art: its own sprite, with the basic boat under a land unit on water; flips to face the way it walks
  function unitArt(u) {
    if (!art) return null;
    const info = unitInfo(u.type);
    const tribe = ownerTribeName(u.owner);
    if (!info || !tribe) return null;
    const own = artEntry(`unit/${tribe}/${info.id}`);
    if (!own) return null;
    const boat = isWater(tileAtXY(u.x, u.y)) && info.abilities?.includes("land") ? artEntry(`unit/${tribe}/boat`) : null;
    // the outlines the game shows round a unit that can act (absent from asset sets extracted before they were added)
    const outline = artEntry(`unitglow/${tribe}/${info.id}`);
    const boatOutline = boat ? artEntry(`unitglow/${tribe}/boat`) : null;
    return { own, boat, outline, boatOutline };
  }
  // the sprites face screen-right; a unit is mirrored when its last step went screen-left. Screen x grows with x - y, so
  // the engine's GridDirection (SW 0, W 1, NW 2, N 3, NE 4, E 5, SE 6, S 7) faces left for W, NW and N; SW and NE are
  // straight up or down the screen and keep the default.
  const DIR_LEFT = [false, true, true, true, false, false, false, false];
  const facesLeft = (u) => (flips.has(u.id) ? flips.get(u.id) : !!DIR_LEFT[(u.direction ?? 7) % 8]);

  // ---------- size and view ----------
  function resize() {
    if (destroyed) return;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(0, Math.round(r.width)), h = Math.max(0, Math.round(r.height));
    const d = Math.min(window.devicePixelRatio || 1, dprCap);
    if (w === cssW && h === cssH && d === dpr) return;
    const first = cssW === 0;
    cssW = w; cssH = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    computeFit();
    if (!touched || first) applyFit();
    else clampView();
    invalidate();
  }

  function computeFit() {
    const n = Math.max(1, pos.n);
    // the board is 2n half-widths wide and 2n half-heights tall; leave room for tall sprites at the top
    fitSx = Math.max(3, Math.min((cssW * 0.94) / (2 * n), (cssH * 0.88) / (2 * n * SLOPE + 1.5)));
  }
  const minSx = () => Math.max(3, fitSx * 0.7);
  // the closest zoom: a tile about 300 px wide, and on a large screen about half the short side, so that a monitor
  // gets as close to a tile as a phone does
  const maxSx = () => opts.maxScale ?? Math.max(150, Math.min(cssW, cssH) * 0.25);

  function fitTarget() {
    const n = pos.n;
    const sx = fitSx;
    return { sx, ox: cssW / 2, oy: (cssH - 2 * n * sx * SLOPE) / 2 + sx * SLOPE * 0.6 };
  }
  function applyFit() {
    Object.assign(view, fitTarget());
    touched = false;
  }

  // the range the view's offsets may take at the current scale
  function bounds() {
    const n = pos.n, m = Math.min(cssW, cssH) * 0.2;
    return { x0: m - n * view.sx, x1: cssW - m + n * view.sx, y0: m - 2 * n * sy(), y1: cssH - m };
  }
  function clampView() {
    view.sx = clamp(view.sx, minSx(), maxSx());
    const b = bounds();
    view.ox = clamp(view.ox, b.x0, b.x1);
    view.oy = clamp(view.oy, b.y0, b.y1);
  }
  // elastic edges: `raw` is where the finger would put the offset, the result is pulled back toward [lo, hi] so it
  // never goes more than `reach` past it; unrubber is the inverse (a drag that starts while the view is past the edge)
  const RUBBER = 0.55;
  const reach = () => Math.min(cssW, cssH) * 0.22;
  function rubber(v, lo, hi) {
    const R = reach();
    if (v < lo) return lo - R * (1 - 1 / ((RUBBER * (lo - v)) / R + 1));
    if (v > hi) return hi + R * (1 - 1 / ((RUBBER * (v - hi)) / R + 1));
    return v;
  }
  function unrubber(v, lo, hi) {
    const R = reach();
    const back = (e) => (R / RUBBER) * (Math.min(e, R * 0.999) / (R - Math.min(e, R * 0.999)));
    if (v < lo) return lo - back(lo - v);
    if (v > hi) return hi + back(v - hi);
    return v;
  }

  function reportView() {
    const key = `${view.sx.toFixed(2)},${view.ox.toFixed(1)},${view.oy.toFixed(1)}`;
    if (key === viewReported) return;
    viewReported = key;
    if (opts.onViewChange) opts.onViewChange(getView());
  }

  const getView = () => ({ sx: view.sx, ox: view.ox, oy: view.oy, fitSx, minSx: minSx(), maxSx: maxSx(), touched });

  function setView(v) {
    if (v.sx != null) view.sx = v.sx;
    if (v.ox != null) view.ox = v.ox;
    if (v.oy != null) view.oy = v.oy;
    touched = true;
    clampView();
    invalidate();
  }

  // returns a promise that resolves when the move has ended (or was replaced by another); a hidden tab never ends it, so a
  // caller that waits should not wait for ever (see animateTo's callers in game/anim.js)
  function animateTo(to, ms) {
    cancelMotion();
    if (!ms) {
      Object.assign(view, to);
      clampView();
      invalidate();
      return Promise.resolve();
    }
    stats.cameraMoves++;
    return new Promise((resolve) => {
      anim = { t0: performance.now(), dur: ms, from: { sx: view.sx, ox: view.ox, oy: view.oy }, to, resolve };
      invalidate();
    });
  }
  function cancelMotion() {
    if (anim && anim.resolve) anim.resolve();
    anim = null;
    momentum = null;
    zoomGlide = null;
  }

  // keep `world` (a point of the board at scale s0 / offset o0) under screen point p when the scale becomes sx
  function zoomAround(px, py, sx) {
    sx = clamp(sx, minSx(), maxSx());
    const k = sx / view.sx;
    view.ox = px - (px - view.ox) * k;
    view.oy = py - (py - view.oy) * k;
    view.sx = sx;
  }

  // ---------- effects: each returns a promise that resolves when it has played (or been skipped) ----------
  function finishFx(f) {
    const i = fx.indexOf(f);
    if (i < 0) return;
    fx.splice(i, 1);
    clearTimeout(f.guard);
    if (f.step) f.step(1);
    if (f.end) f.end();
    stats.fx.finished++;
    f.resolve();
    invalidate();
  }
  // `spec.name` is what stats.fx counts and logs (tests and the replay read it)
  function addFx(ms, spec) {
    return new Promise((resolve) => {
      const f = { t0: performance.now(), ms: Math.max(1, ms), p: 0, resolve, ...spec };
      // a hidden tab stops animation frames: do not let the caller wait for ever
      f.guard = setTimeout(() => finishFx(f), f.ms + 300);
      const name = f.name || "fx";
      stats.fx.started++;
      stats.fx.names[name] = (stats.fx.names[name] || 0) + 1;
      stats.fx.log.push(f.text != null ? { name, ms: f.ms, text: f.text } : { name, ms: f.ms });
      if (stats.fx.log.length > 400) stats.fx.log.shift();
      fx.push(f);
      invalidate();
    });
  }
  // The override a unit is drawn with while effects play on it. Channels: px/py (where it stands or walks), ox/oy (an offset
  // in tiles, for a lunge or a shake), lift, scale, alpha, tint (a flat colour over the sprite, with tintAlpha), flip, hidden.
  function ovOf(u) {
    let ov = overrides.get(u.id);
    if (!ov) { ov = { px: u.x, py: u.y, ox: 0, oy: 0, x: u.x, y: u.y }; overrides.set(u.id, ov); }
    return ov;
  }
  const place = (ov) => { ov.x = ov.px + ov.ox; ov.y = ov.py + ov.oy; };
  const easeOutBack = (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
  const inOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  // retail's Sway: down `dip` world units in the first sixth of the time, then back up with a spring
  const swayAt = (p, dip) => -dip * wuPx() * (p < 1 / 6 ? outQuad(p * 6) : 1 - outElastic((p - 1 / 6) * 1.2));
  function artFx(key) {
    const a = artEntry(key);
    return a && art ? a : null;
  }
  // a fx sprite at a point of the board: scale, alpha, lift (px at this zoom), rotation (radians), optional flat colour
  function drawFxSprite(a, x, y, scale, alpha, lift = 0, rot = 0, rgb = null) {
    const e = artImage(a);
    if (e.state !== "ok") return;
    const k = view.sx * ART_PER_SX * scale;
    const [cx, cy] = centre(x, y);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy - lift - landFace() * artScale());
    if (rot) ctx.rotate(rot);
    ctx.drawImage(rgb ? tinted(e, rgb) : e.img, -a.anchor[0] * k, -a.anchor[1] * k, a.w * k, a.h * k);
    ctx.restore();
  }
  // a flat sprite of the game's overlays (`fx/<name>`) lying on a tile's top face, centred, at its own size times
  // `scale`; false while it has no image yet
  function drawOnTile(key, x, y, scale = 1, alpha = 1) {
    const a = artFx(key);
    if (!a || artImage(a).state !== "ok") return false;
    const ppu = art.manifest.ppu && a.ppu ? art.manifest.ppu / a.ppu : 1;
    const k = artScale() * ppu * scale, [cx, cy] = centre(x, y), fy = cy + faceDrop(tileAtXY(x, y));
    ctx.globalAlpha = alpha;
    ctx.drawImage(artImage(a).img, cx - a.anchor[0] * k, fy - a.anchor[1] * k, a.w * k, a.h * k);
    ctx.globalAlpha = 1;
    return true;
  }
  const unitOf = (ref) => (typeof ref === "number" ? pos.units.find((u) => u.id === ref) : pos.units.find((u) => u.x === asXY(ref)[0] && u.y === asXY(ref)[1]));
  const effects = {
    // walk a unit (id, or the tile it stands on) along `path` ([[x, y], ...] starting at its tile)
    moveUnit(ref, path, o = {}) {
      const u = unitOf(ref);
      const pts = (path || []).map(asXY).filter(Boolean);
      if (!u || pts.length < 2) return Promise.resolve();
      const ms = o.ms ?? Math.min(o.maxMs ?? 1200, (o.msPerTile ?? 300) * (pts.length - 1));
      const ov = ovOf(u);
      ov.px = pts[0][0]; ov.py = pts[0][1];
      place(ov);
      return addFx(ms, {
        name: "move",
        step(p) {
          const d = p * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(d)), f = d - i;
          const a = pts[i], b = pts[i + 1];
          ov.px = a[0] + (b[0] - a[0]) * f;
          ov.py = a[1] + (b[1] - a[1]) * f;
          ov.lift = Math.sin(f * Math.PI) * view.sx * 0.12;
          place(ov);
          const dx = (b[0] - b[1]) - (a[0] - a[1]);
          if (dx) { ov.flip = dx < 0; flips.set(u.id, dx < 0); }
        },
        end() { ov.px = pts[pts.length - 1][0]; ov.py = pts[pts.length - 1][1]; ov.lift = 0; place(ov); },
      });
    },
    // the attacker steps towards the target in the first two fifths of the time and back over the rest (retail: 0.2 s
    // out, 0.3 s back)
    lunge(ref, target, o = {}) {
      const u = unitOf(ref), t = asXY(target);
      if (!u || !t) return Promise.resolve();
      const ov = ovOf(u);
      const x0 = ov.px, y0 = ov.py;
      const dx = (t[0] - t[1]) - (x0 - y0);
      if (dx) { ov.flip = dx < 0; flips.set(u.id, dx < 0); }
      return addFx(o.ms ?? 500, {
        name: "lunge",
        step(p) {
          const k = (p < 0.4 ? outQuad(p / 0.4) : 1 - inOutQuad((p - 0.4) / 0.6)) * 0.45;
          ov.ox = (t[0] - x0) * k;
          ov.oy = (t[1] - y0) * k;
          place(ov);
        },
        end() { ov.ox = 0; ov.oy = 0; place(ov); },
      });
    },
    // The game's close-range attack: the unit's weapon (the manifest's `weapon/*` key named by its art) spins once round
    // the centre of the unit's sprites, as WeaponGFX.AnimateCloseRangeAttack does; it stays where the unit stood when
    // it started. Without that art it ends at once (the caller's lunge still plays).
    swing(ref, o = {}) {
      const u = unitOf(ref), ua = u && unitArt(u);
      const w = ua && ua.own.weapon ? artFx(ua.own.weapon) : null;
      if (!w) return Promise.resolve();
      const ov = overrides.get(u.id);
      const x = ov ? ov.px : u.x, y = ov ? ov.py : u.y;
      const flip = ov && ov.flip != null ? ov.flip : facesLeft(u);
      const at = ua.own.weapon_at || [0, 0];
      const sc = ua.boat ? 0.8 : 1, raise = ua.boat ? view.sx * 0.28 : 0; // as drawUnit puts a unit aboard a boat
      const spin = w.spin || { deg: -360, s: 0.2 };
      stats.swing = { key: ua.own.weapon, unit: u.id, drawn: 0, angle: 0, turn: spin.deg ?? -360, x: 0, y: 0, size: 0 };
      return addFx(o.ms ?? spin.s * 1000, {
        name: "swing",
        draw(p) {
          const e = artImage(w);
          if (e.state !== "ok") return;
          const k = artScale(), [cx, cy] = centre(x, y);
          const px = cx + (flip ? -1 : 1) * at[0] * k * sc, py = cy - landFace() * k - raise + at[1] * k * sc;
          const deg = (spin.deg ?? -360) * inOutQuad(p); // Unity's z turn: negative is clockwise on screen
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate((-deg * Math.PI) / 180);
          ctx.drawImage(e.img, -w.anchor[0] * k, -w.anchor[1] * k, w.w * k, w.h * k);
          ctx.restore();
          Object.assign(stats.swing, { drawn: stats.swing.drawn + 1, angle: deg, x: px, y: py, size: Math.hypot(w.w - w.anchor[0], w.h - w.anchor[1]) * k });
        },
      });
    },
    // turn a unit to face a tile (a ranged unit before it fires); ends at once
    face(ref, target) {
      const u = unitOf(ref), t = asXY(target);
      if (!u || !t) return Promise.resolve();
      const dx = (t[0] - t[1]) - (u.x - u.y);
      if (dx) { flips.set(u.id, dx < 0); const ov = overrides.get(u.id); if (ov) ov.flip = dx < 0; invalidate(); }
      return Promise.resolve();
    },
    // Retail's Sway on a unit (it is picked, it fires, it is hit): it dips 0.05 world units (times o.amount) in 0.1 s and
    // springs back over 0.5 s
    sway(ref, o = {}) {
      const u = unitOf(ref);
      if (!u) return Promise.resolve();
      const ov = ovOf(u), dip = 0.05 * (o.amount ?? 1);
      return addFx(o.ms ?? 600, {
        name: o.name || "sway",
        step(p) { ov.lift = swayAt(p, dip); },
        end() { ov.lift = 0; },
      });
    },
    // a unit takes damage: it sways (the red burst on its tile is the caller's puff)
    hit(ref, o = {}) { return effects.sway(ref, { ...o, name: "hit" }); },
    // a unit appears: it grows from nothing with a small overshoot
    popIn(ref, o = {}) {
      const u = unitOf(ref);
      if (!u) return Promise.resolve();
      const ov = ovOf(u);
      ov.scale = 0.05; ov.alpha = 0;
      return addFx(o.ms ?? 380, {
        name: "popIn",
        step(p) { ov.scale = Math.max(0.05, easeOutBack(p)); ov.alpha = Math.min(1, p * 4); },
        end() { ov.scale = 1; ov.alpha = 1; },
      });
    },
    fadeOut(ref, o = {}) {
      const u = unitOf(ref);
      if (!u) return Promise.resolve();
      const ov = ovOf(u);
      return addFx(o.ms ?? 300, {
        name: "fadeOut",
        step(p) { ov.alpha = 1 - p; if (o.shrink) ov.scale = 1 - p * o.shrink; },
        end() { ov.hidden = true; },
      });
    },
    fadeIn(ref, o = {}) {
      const u = unitOf(ref);
      if (!u) return Promise.resolve();
      const ov = ovOf(u);
      return addFx(o.ms ?? 300, { name: "fadeIn", step(p) { ov.alpha = p; }, end() { ov.alpha = 1; } });
    },
    // A sprite of the game's effects (manifest key `fx/<name>`) on a tile: scale from o.scale[0] to o.scale[1], opacity from
    // o.alpha[0] to o.alpha[1], rising o.rise tiles. Without that art it ends at once.
    sprite(key, xy, o = {}) {
      const a = asXY(xy), art1 = artFx(key.startsWith("fx/") ? key : `fx/${key}`);
      if (!a || !art1) return Promise.resolve();
      const [s0, s1] = o.scale || [0.4, 1], [a0, a1] = o.alpha || [1, 0];
      return addFx(o.ms ?? 600, {
        name: o.name || "sprite",
        draw(p) {
          const e = o.ease === "out" ? easeOut(p) : p;
          drawFxSprite(art1, a[0], a[1], s0 + (s1 - s0) * e, a0 + (a1 - a0) * p, (o.lift ?? 0.2) * view.sx + (o.rise ?? 0) * view.sx * p, 0, o.rgb || null);
        },
      });
    },
    // Retail's Puff on a tile (`fx/puffgfx` unless o.key): it grows from 0 to full size over 0.3 s with OutBack, then
    // rises 0.3 world units while it fades out over 0.3 s. Drawn at the sprite's own scale, as the shots are.
    // The game's other effects are the same tween with other numbers (o.timing: grow, rise and fade as above, `from`
    // the scale it starts at) and another sprite: the red spikes of a hit (`fx/explosiongfx`), a heal's ring, the halo
    // of a promotion. `o.up` raises it by that many world units; `o.flicker` makes the fade uneven, as a Shine's is;
    // `o.under` draws it behind the units that effects are playing on.
    puff(xy, o = {}) {
      const a = asXY(xy), name = o.key || "fx/puffgfx", art1 = artFx(name);
      if (!a || !art1) return Promise.resolve();
      const P = { grow: 0.3, rise: 0.3, fade: 0.3, from: 0, ...(o.timing || {}) };
      const ppu = art.manifest.ppu && art1.ppu ? art.manifest.ppu / art1.ppu : 1;
      const total = P.grow + P.fade, cut = P.grow / total;
      const st = (stats.puff = { key: name, x: a[0], y: a[1], drawn: 0, scale: 0, alpha: 0 });
      return addFx(o.ms ?? total * 1000, {
        name: o.name || "puff",
        under: !!o.under,
        draw(p) {
          if (artImage(art1).state !== "ok") return;
          const g = p < cut ? P.from + (1 - P.from) * easeOutBack(p / cut) : 1, f = p < cut ? 0 : (p - cut) / (1 - cut);
          const scale = g * ppu * (o.scale ?? 1);
          const alpha = (1 - f) * (o.flicker && f > 0 ? 0.75 + 0.25 * Math.sin(f * 60) : 1);
          drawFxSprite(art1, a[0], a[1], scale, alpha, (o.lift ?? 0) * view.sx + ((o.up ?? 0) + outQuad(f) * P.rise) * wuPx());
          Object.assign(st, { drawn: st.drawn + 1, scale: g, alpha });
        },
      });
    },
    // Retail's sparkles on a tile: small white glints that appear round it, drift up and go out. `o.amount` scales how many.
    sparkles(xy, o = {}) {
      const a = asXY(xy);
      if (!a) return Promise.resolve();
      const n = Math.max(4, Math.round(12 * (o.amount ?? 1)));
      const bits = Array.from({ length: n }, (_, i) => {
        const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
        return { x: Math.cos(ang) * r * 0.75, y: Math.sin(ang) * r * 0.45 - 0.45 - Math.random() * 0.5, t0: (i / n) * 0.6, size: 0.07 + Math.random() * 0.08 };
      });
      return addFx(o.ms ?? 900, {
        name: o.name || "sparkles",
        draw(p) {
          const [cx, cy] = centre(a[0], a[1]);
          ctx.fillStyle = "#ffffff";
          for (const b of bits) {
            const t = (p - b.t0) / 0.4;
            if (t <= 0 || t >= 1) continue;
            const s = view.sx * b.size * Math.sin(t * Math.PI), x = cx + b.x * view.sx, y = cy + (b.y - t * 0.25) * view.sx;
            ctx.globalAlpha = Math.min(1, 1.6 * Math.sin(t * Math.PI));
            ctx.beginPath();
            ctx.moveTo(x, y - s); ctx.quadraticCurveTo(x, y, x + s, y); ctx.quadraticCurveTo(x, y, x, y + s);
            ctx.quadraticCurveTo(x, y, x - s, y); ctx.quadraticCurveTo(x, y, x, y - s);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        },
      });
    },
    // A projectile (fx sprite drawn pointing right) flying from one tile to another on a small arc, turned along its course.
    // It is drawn at the game's size: the sprite's own pixels per unit against the composed art's, times `o.scale`.
    // `stats.projectile` reports the last one: frames drawn, frames skipped because the image was not loaded yet, how far
    // it has flown (p, 0 to 1), its angle (degrees, screen, clockwise from right), drawn width and centre in CSS px.
    projectile(key, from, to, o = {}) {
      const f = asXY(from), t = asXY(to), name = key.startsWith("fx/") ? key : `fx/${key}`, art1 = artFx(name);
      if (!f || !t || !art1) return Promise.resolve();
      const ppu = art.manifest.ppu && art1.ppu ? art.manifest.ppu / art1.ppu : 1;
      const scale = (o.scale ?? 1) * ppu;
      const st = (stats.projectile = { key: name, drawn: 0, skipped: 0, angle: 0, width: 0, x: 0, y: 0 });
      return addFx(o.ms ?? 360, {
        name: "projectile",
        draw(p) {
          const x = f[0] + (t[0] - f[0]) * p, y = f[1] + (t[1] - f[1]) * p;
          const [ax, ay] = centre(f[0], f[1]), [bx, by] = centre(t[0], t[1]);
          const arc = o.arc ?? 0.55, rise = Math.sin(p * Math.PI) * view.sx * arc;
          // the slope of the course on screen, with the arc's own slope added so the arrow follows its curve
          const slope = (by - ay) - Math.cos(p * Math.PI) * Math.PI * view.sx * arc;
          const rot = o.spin ? p * Math.PI * 2 * o.spin : Math.atan2(slope, bx - ax || 0.001);
          if (artImage(art1).state !== "ok") { st.skipped++; return; }
          const lift = view.sx * 0.45 + rise;
          drawFxSprite(art1, x, y, scale, 1, lift, rot);
          const [cx, cy] = centre(x, y);
          Object.assign(st, { drawn: st.drawn + 1, p, angle: (rot * 180) / Math.PI, width: art1.w * view.sx * ART_PER_SX * scale, x: cx, y: cy - lift - landFace() * artScale() });
        },
      });
    },
    // an expanding outline of a tile (a level-up, a capture, a harvest)
    burst(xy, o = {}) {
      const a = asXY(xy);
      if (!a) return Promise.resolve();
      return addFx(o.ms ?? 600, {
        name: o.name || "burst",
        draw(p) {
          const [cx, cy] = centre(a[0], a[1]);
          const s = 0.4 + 1.1 * easeOut(p), w = view.sx * s, h = sy() * s;
          ctx.globalAlpha = (1 - p) * 0.9;
          ctx.lineWidth = Math.max(2, view.sx * 0.12 * (1 - p));
          ctx.strokeStyle = o.colour || "#ffd65a";
          ctx.beginPath();
          ctx.moveTo(cx, cy - h); ctx.lineTo(cx + w, cy); ctx.lineTo(cx, cy + h); ctx.lineTo(cx - w, cy); ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = 1;
        },
      });
    },
    // the art for these keys (`<name>` for `fx/<name>`, or a whole key such as `fx/arrowgfx` or `weapon/club`) starts
    // loading, so the first use is not empty
    preload(keys) {
      for (const k of keys) { const a = artFx(k.includes("/") ? k : `fx/${k}`); if (a) artImage(a); }
    },
    // A number or word over a tile (a damage number, a gain), as retail's damage indicator: it starts at a unit's head at
    // 0.7 of its size, springs up 0.2 world units to full size in the first half of the time, stays, and fades at the
    // end. In the game's font where the board was given its text drawer (setText).
    pop(xy, text, o = {}) {
      const a = asXY(xy), str = String(text);
      if (!a) return Promise.resolve();
      const dx = (Math.random() - 0.5) * 0.2;
      return addFx(o.ms ?? 1000, {
        name: o.name || "pop",
        text: str,
        draw(p) {
          const [cx, cy] = centre(a[0], a[1]);
          const e = outElastic(Math.min(1, p * 2));
          const fs = Math.max(14, Math.min(24, view.sx * 0.46)) * (0.7 + 0.3 * e);
          const alpha = p < 0.85 ? 1 : 1 - (p - 0.85) / 0.15;
          const x = cx + dx * view.sx, y = cy - sy() * 0.95 - 0.2 * e * wuPx();
          const colour = o.colour || "#ff5a5a";
          if (textDrawer) {
            // the game's fonts have the hyphen for a minus sign
            textDrawer.draw(ctx, str.replace("−", "-"), x, y, { font: "roboto-numbers", size: fs * 1.15, colour, weight: 0.75, outline: { colour: "rgba(10,12,18,0.9)", width: 1.6 }, align: "center", baseline: "middle", alpha, dpr });
            return;
          }
          ctx.globalAlpha = alpha;
          ctx.font = `800 ${fs}px system-ui, sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.lineWidth = 4; ctx.strokeStyle = "rgba(10,12,18,0.9)"; ctx.strokeText(str, x, y);
          ctx.fillStyle = colour; ctx.fillText(str, x, y);
          ctx.globalAlpha = 1;
        },
      });
    },
    // a coloured flash on a tile (a hit, a capture, a spawn)
    flash(xy, o = {}) {
      const a = asXY(xy);
      if (!a) return Promise.resolve();
      return addFx(o.ms ?? 350, {
        name: "flash",
        draw(p) {
          diamond(a[0], a[1]);
          ctx.globalAlpha = (1 - p) * 0.6;
          ctx.fillStyle = o.colour || "#ffffff";
          ctx.fill();
          ctx.globalAlpha = 1;
        },
      });
    },
    // A figure in a unit's art (`unitId` of `owner`'s tribe, e.g. the explorer's "scout") walks a route of tiles: it floats a
    // little above them, faces the way it goes and fades at the end. No tile holds it, so it is not one of the units.
    // `o.at(xy)` is called as the figure reaches each tile (at once for the ones it skipped on a skip), so the caller can
    // reveal what it passes; without the art the walk still runs and calls `at`.
    figure(owner, unitId, path, o = {}) {
      const pts = (path || []).map(asXY).filter(Boolean);
      if (pts.length < 2) return Promise.resolve();
      const tribe = ownerTribeName(owner);
      const a = tribe ? artEntry(`unit/${tribe}/${unitId}`) : null;
      let flip = false, reached = 0;
      return addFx(o.ms ?? 1200, {
        name: "figure",
        step(p) {
          const upto = p >= 1 ? pts.length - 1 : Math.floor(p * (pts.length - 1));
          for (; reached <= upto; reached++) if (o.at) o.at(pts[reached]);
        },
        draw(p) {
          if (!a) return;
          const d = p * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(d)), f = d - i;
          const s = pts[i], t = pts[i + 1];
          const dx = (t[0] - t[1]) - (s[0] - s[1]);
          if (dx) flip = dx < 0;
          const alpha = p < 0.85 ? 1 : 1 - (p - 0.85) / 0.15;
          const lift = view.sx * (0.35 + 0.08 * Math.sin(f * Math.PI));
          drawArt(a, s[0] + (t[0] - s[0]) * f, s[1] + (t[1] - s[1]) * f, alpha, flip, o.scale ?? 0.6, lift);
        },
      });
    },
    wait() { return Promise.all(fx.map((f) => new Promise((r) => { const done = f.resolve; f.resolve = () => { done(); r(); }; }))); },
    // finish everything at once (the replay's Skip)
    skip() { for (const f of fx.slice()) finishFx(f); },
    get running() { return fx.length; },
  };
  // the effects marked `under` go behind the units that effects are playing on, the rest over everything
  function drawFx(under = false) {
    for (const f of fx) if (f.draw && !!f.under === under) f.draw(f.p || 0);
  }

  // ---------- drawing ----------
  function invalidate() {
    dirty = true;
    if (!frame && !destroyed) frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    if (destroyed) return;
    let moving = false;
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / anim.dur), e = easeOut(t);
      view.sx = anim.from.sx + (anim.to.sx - anim.from.sx) * e;
      view.ox = anim.from.ox + (anim.to.ox - anim.from.ox) * e;
      view.oy = anim.from.oy + (anim.to.oy - anim.from.oy) * e;
      if (t >= 1) { const done = anim.resolve; anim = null; if (done) done(); }
      else moving = true;
      dirty = true;
    }
    if (momentum) {
      const dt = Math.min(48, now - momentum.t);
      momentum.t = now;
      const before = [view.ox, view.oy];
      view.ox += momentum.vx * dt;
      view.oy += momentum.vy * dt;
      clampView();
      if (view.ox === before[0]) momentum.vx = 0; // hit the edge
      if (view.oy === before[1]) momentum.vy = 0;
      const decay = Math.exp(-dt / 320);
      momentum.vx *= decay; momentum.vy *= decay;
      if (Math.hypot(momentum.vx, momentum.vy) < 0.01) momentum = null;
      else moving = true;
      dirty = true;
    }
    if (zoomGlide) {
      const z = zoomGlide, dt = Math.max(0, Math.min(48, now - z.t));
      z.t = Math.max(z.t, now);
      let sx = view.sx + (z.sx - view.sx) * (1 - Math.exp(-dt / 70));
      if (Math.abs(z.sx - sx) < z.sx * 0.002) sx = z.sx;
      zoomAround(z.px, z.py, sx);
      clampView();
      if (sx === z.sx) zoomGlide = null;
      else moving = true;
      dirty = true;
    }
    if (fx.length) {
      for (const f of fx.slice()) {
        const p = Math.max(0, Math.min(1, (now - f.t0) / f.ms)); // a frame timestamp can precede the start
        if (f.step) f.step(p);
        f.p = p;
        if (p >= 1) finishFx(f);
      }
      moving = moving || fx.length > 0;
      dirty = true;
    }
    if (clouds.size && stepClouds(now)) { moving = true; dirty = true; }
    if (dirty) {
      dirty = false;
      draw();
      reportView();
    }
    // an effect that ended in this tick has already asked for the next frame (finishFx invalidates): a second request
    // would start a second chain of ticks, each drawing every frame
    if (moving && !frame) frame = requestAnimationFrame(tick);
  }

  function diamond(x, y, inset = 0) {
    const [cx, cy] = corner(x, y);
    const a = view.sx * (1 - inset), b = sy() * (1 - inset), o = sy() * inset;
    ctx.beginPath();
    ctx.moveTo(cx, cy + o);
    ctx.lineTo(cx + a, cy + sy());
    ctx.lineTo(cx, cy + 2 * sy() - o);
    ctx.lineTo(cx - a, cy + sy());
    ctx.closePath();
  }

  function drawSprite(entry, x, y, alpha = 1) {
    const k = view.sx / geo.sx;
    const [cx, cy] = corner(x, y);
    ctx.globalAlpha = alpha;
    ctx.drawImage(entry.img, cx - geo.anchor[0] * k, cy - geo.anchor[1] * k, geo.width * k, geo.height * k);
    ctx.globalAlpha = 1;
  }

  // An unexplored tile of a player's view is drawn as the game draws it: its cloud block, in the tile's own place in the
  // back to front order, so the clouds of the tiles in front cover the edge of the explored land behind them. The diamond
  // under the cloud is filled with the cloud's colour, so no gap shows between two clouds.
  const fogArt = () => (art && fogFor != null ? artEntry("tile/fog") : null);
  function drawCloud(f, x, y) {
    diamond(x, y, -0.03);
    ctx.fillStyle = art.manifest.geometry?.fog_colour || "#cedbfd";
    ctx.fill();
    drawArt(f, x, y, 1, false, 1, -cloudSink(x, y) * wuPx());
  }

  // ---------- a pressed cloud ----------
  // As retail's Tile.OnPress and OnRelease: a press on a cloud sinks it 0.05 world units over 0.2 s (DOTween's default
  // OutQuad), and the release springs it back over 1 s with OutElastic. Only clouds move, so it shows nothing under them.
  const CLOUD_PRESS = { sink: 0.05, downMs: 200, upMs: 1000 };
  const clouds = new Map(); // "x,y" -> {from, to, t0, ms, ease}
  let pressedCloud = null;
  const outQuad = (t) => 1 - (1 - t) * (1 - t);
  const outElastic = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
  function cloudSink(x, y, now = performance.now()) {
    const c = clouds.get(`${x},${y}`);
    if (!c) return 0;
    const p = Math.max(0, Math.min(1, (now - c.t0) / c.ms));
    return c.from + (c.to - c.from) * c.ease(p);
  }
  function moveCloud(xy, to, ms, ease) {
    const k = `${xy[0]},${xy[1]}`;
    clouds.set(k, { from: cloudSink(xy[0], xy[1]), to, t0: performance.now(), ms, ease });
    invalidate();
  }
  function pressCloud(px, py) {
    const pk = pickAt(px, py);
    const t = pk && !pk.marker ? tileAtXY(pk.xy[0], pk.xy[1]) : null;
    if (opts.cloudPress === false || !fogArt() || !pk || !(!t || !t.known || fogged(t))) return;
    pressedCloud = pk.xy;
    stats.clouds.presses++;
    moveCloud(pk.xy, CLOUD_PRESS.sink, CLOUD_PRESS.downMs, outQuad);
  }
  function releaseCloud() {
    if (!pressedCloud) return;
    stats.clouds.releases++;
    moveCloud(pressedCloud, 0, CLOUD_PRESS.upMs, outElastic);
    pressedCloud = null;
  }
  // true while a cloud is still moving; a cloud back at rest is forgotten
  function stepClouds(now) {
    let any = false;
    for (const [k, c] of clouds) {
      if (now - c.t0 < c.ms) any = true;
      else if (c.to === 0) clouds.delete(k);
    }
    const s = pressedCloud || [...clouds.keys()].map((k) => k.split(",").map(Number))[0];
    stats.clouds.sink = s ? cloudSink(s[0], s[1], now) : 0;
    return any;
  }

  // `burning`: a besieged city, whose fire's shadow goes on the ground under the city
  function drawTile(t, x, y, burning = false) {
    const cloud = fogArt();
    if (cloud && (!t || !t.known || fogged(t))) {
      drawCloud(cloud, x, y);
      return;
    }
    if (!t || !t.known) {
      diamond(x, y, 0.03);
      ctx.fillStyle = "#171b27";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    const layers = artTileLayers(t);
    if (layers) {
      if (!layers.every((a) => artImage(a).state === "ok")) {
        diamond(x, y);
        ctx.fillStyle = TERRAIN_FLAT[t.terrain] || "rgba(120,120,120,0.6)";
        ctx.fill();
      }
      const split = artSplit(t);
      drawArt(split ? split.ground : layers[0], x, y);
      drawFacing(x, y);
      drawBorderSides(t, x, y, ["north", "east"]);
      if (split) drawArt(split.feature, x, y);
      const g = glows.get(`${x},${y}`);
      if (g && layers.length === 1) glowFace(x, y, g);
      if (burning) drawFireShadow(x, y);
      for (let i = 1; i < layers.length; i++) {
        if (g) outlineArt(layers[i], x, y, g);
        drawArt(layers[i], x, y);
      }
      if (t.city) {
        // `whole`: drawn as one picture of its parts, which `layers` and the rest then list
        const built = layers.length === 2 && layers[1].built ? layers[1].built : null;
        if (built) stats.cities.push({ x, y, whole: true, ...(built.stat || (built.stat = cityStat(built.layers, built))) });
        else stats.cities.push({ x, y, whole: false, ...cityStat(layers.slice(1), cityBuilt.get(`${x},${y}`)) });
      }
      if (t.capital && t.city && !(view.sx >= 16 && plateArt())) drawFlag(x, y, t.owner); // the plate's crown marks it when near
      return;
    }
    const s = tileImage(t);
    if (s.state === "ok") drawSprite(s, x, y);
    else {
      diamond(x, y);
      ctx.fillStyle = TERRAIN_FLAT[t.terrain] || "rgba(120,120,120,0.6)";
      ctx.fill();
    }
    drawFacing(x, y);
    const g = glows.get(`${x},${y}`);
    if (g) glowFace(x, y, g);
  }

  // ---------- siege fire ----------
  // A city burns while a unit of another player stands in it (retail's "{0} is under siege!"). It is worked out from what
  // the board is shown, so a fogged city, or a unit the view leaves out, never burns. Each particle is a pure function of
  // the clock and its number, so nothing is kept between frames.
  const siegeOn = opts.siegeFire !== false;
  let fireTimer = 0;
  const besieged = (t, u) => siegeOn && !!t && !!t.city && !!t.owner && !!u && u.owner !== t.owner && !fogged(t);
  const wuPx = () => ART_PPU * artScale(); // screen px per retail world unit
  function fireBase(x, y) {
    const [cx, cy] = centre(x, y);
    return [cx, cy - landFace() * artScale()];
  }
  function drawFireShadow(x, y) {
    const a = artFx("fx/genericfade"), e = a && artImage(a);
    if (!e || e.state !== "ok") return;
    const [bx, by] = fireBase(x, y), s = wuPx() / (a.ppu || 100);
    ctx.save();
    diamond(x, y);
    ctx.clip();
    ctx.drawImage(tinted(e, [0, 0, 0]), bx - a.anchor[0] * s, by - a.anchor[1] * s, a.w * s, a.h * s);
    ctx.restore();
  }
  // the flames and embers of a burning city, in front of what stands in it
  function drawFire(x, y, now) {
    const seed = y * pos.n + x, sec = now / 1000, w = wuPx();
    const [bx, by] = fireBase(x, y);
    const flame = artFx("fx/flamegfx"), fe = flame && artImage(flame);
    let drawn = 0;
    // flames: number k is born at k / rate
    const newest = Math.floor(sec * FIRE.rate);
    for (let k = newest; k > newest - Math.ceil(FIRE.life * FIRE.rate) - 1; k--) {
      const age = sec - k / FIRE.rate;
      if (age < 0 || age >= FIRE.life) continue;
      const p = age / FIRE.life;
      const v = FIRE.speed[0] + (FIRE.speed[1] - FIRE.speed[0]) * rnd(seed, 1, k, 0);
      const px = bx + (rnd(seed, 1, k, 1) * 2 - 1) * FIRE.edge * w;
      const py = by - (v * age - 0.5 * FIRE.pull * age * age) * w;
      const alpha = keyed(FIRE.alpha, p)[0];
      const fw = FIRE.width * p * w; // grows from nothing
      if (fe && fe.state === "ok") {
        const fh = fw * (flame.h / flame.w);
        ctx.globalAlpha = alpha;
        ctx.drawImage(fe.img, px - fw / 2, py - fh, fw, fh); // the renderer's pivot (0, 0.5) stands it on its point
      } else {
        const fh = fw * 3.2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#ff8a1c";
        ctx.beginPath();
        ctx.moveTo(px, py - fh); ctx.quadraticCurveTo(px + fw / 2, py - fh * 0.3, px, py); ctx.quadraticCurveTo(px - fw / 2, py - fh * 0.3, px, py - fh);
        ctx.fill();
      }
      drawn++;
    }
    // embers: 20 a second falling to none over each 1 s loop is 10 a loop, the n-th at 1 - sqrt(1 - n / 10)
    const loop = Math.floor(sec);
    for (let L = loop; L > loop - EMBERS.life[1] - 1; L--) {
      for (let n = 0; n < EMBERS.peak / 2; n++) {
        const born = L + 1 - Math.sqrt(1 - n / (EMBERS.peak / 2)), age = sec - born;
        const id = L * 16 + n;
        const life = EMBERS.life[0] + (EMBERS.life[1] - EMBERS.life[0]) * rnd(seed, 2, id, 0);
        if (age < 0 || age >= life) continue;
        const p = age / life;
        // a point of a 0.5 wu square turned 45°
        const u = rnd(seed, 2, id, 1) - 0.5, q = rnd(seed, 2, id, 2) - 0.5;
        const ex = (u - q) * 0.5 * Math.SQRT1_2, ey = (u + q) * 0.5 * Math.SQRT1_2;
        // sideways drift: between the two curves, integrated over its life in a few steps
        const mix = rnd(seed, 2, id, 3);
        let dx = 0;
        const steps = 6;
        for (let i = 0; i < steps; i++) {
          const tt = ((i + 0.5) / steps) * p;
          const va = keyed(EMBERS.driftA, tt)[0], vb = keyed(EMBERS.driftB, tt)[0];
          dx += (va + (vb - va) * mix) * (life * p / steps);
        }
        const dy = EMBERS.rise * age - 0.5 * FIRE.pull * age * age;
        const [r, g, b] = keyed(EMBERS.rgb, p);
        const alpha = keyed(EMBERS.alpha, p)[0];
        if (alpha <= 0.01) continue;
        const sz = Math.max(1.5, EMBERS.size * w);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        ctx.beginPath();
        ctx.arc(bx + (ex + dx) * w, by - (ey + dy) * w, sz / 2, 0, Math.PI * 2);
        ctx.fill();
        drawn++;
      }
    }
    ctx.globalAlpha = 1;
    return drawn;
  }
  // keep a burning city moving, at about 30 frames a second, when nothing else is
  function keepBurning() {
    if (fireTimer || destroyed || !stats.fires.length) return;
    fireTimer = setTimeout(() => { fireTimer = 0; invalidate(); }, 33);
  }

  // ColorConstants.glowColor, the colour of the game's outlines on whatever can act or be used
  const GLOW_COLOUR = "#66ffff";
  // the game's overlay on a unit with nothing left to do: white at 0.4 strength (measured on the rig: a moved warrior's
  // black feet come out #666666)
  const SPENT_COLOUR = [255, 255, 255], SPENT_WASH = 0.4;

  // The retail highlight on a unit that can act or on something that can be built or harvested: a thin white rim round
  // the sprite's outline with a soft light in `g.colour` fading out from it, drawn as silhouettes behind the sprite.
  // `g.v` (0..1) is its strength.
  function glowArt(a, x, y, g, flip = false, scale = 1, lift = 0) {
    const rgb = dimmed(g.colour, 1);
    const alpha = (0.45 + 0.55 * g.v) * (g.fade ?? 1);
    const rim = Math.max(1, view.sx * 0.02);
    // the light: the silhouette pushed out past the rim, blurred about 8 px
    drawHalo(a, x, y, rgb, rim * 1.8, Math.max(5, Math.min(10, view.sx * 0.14)), alpha, flip, scale, lift, g.cut || 0);
    // the rim: the white silhouette nudged out in eight directions
    for (let i = 0; i < 8; i++) {
      const ang = (i * 2 * Math.PI) / 8;
      ctx.save();
      ctx.translate(Math.cos(ang) * rim, Math.sin(ang) * rim);
      drawArt(a, x, y, alpha, flip, scale, lift, [255, 255, 255], g.cut || 0);
      ctx.restore();
    }
    stats.glows++;
  }

  // A canvas shadow blur drawn every frame makes Chrome's GPU process stall for 100 ms and more every few frames, so the
  // blurred parts of the drawn glows are made once into their own canvas, per sprite (or tile shape), colour and zoom
  // step (2^(1/4) apart), and drawn scaled to the exact size.
  const haloCache = new Map();
  const zoomStep = (v) => 2 ** (Math.round(Math.log2(Math.max(v, 0.25)) * 4) / 4);
  function cachedHalo(key, make) {
    let h = haloCache.get(key);
    if (!h) {
      if (haloCache.size >= 160) haloCache.clear();
      h = make();
      haloCache.set(key, h);
    }
    return h;
  }
  // the sprite's silhouette in `rgb` pushed out `push` CSS px in four directions, with its shadow blurred `blur` CSS px,
  // drawn where drawArt draws the sprite
  function drawHalo(a, x, y, rgb, push, blur, alpha, flip, scale, lift, cut) {
    const e = artImage(a);
    if (e.state !== "ok") return;
    const k = view.sx * ART_PER_SX * scale; // CSS px per art unit
    const u = k / (e.img.width / a.w); // CSS px per image px
    const p = zoomStep(push / u), b = zoomStep(blur / u); // in image px
    const h = cachedHalo(`${e.url}|${rgb}|${cut}|${p}|${b}`, () => {
      const pad = Math.ceil(p + b * 1.5) + 2;
      const c = document.createElement("canvas");
      c.width = e.img.width + 2 * pad;
      c.height = e.img.height + 2 * pad;
      const g = c.getContext("2d");
      const src = tinted(e, rgb, cut);
      g.globalAlpha = 0.8;
      g.shadowColor = `rgb(${rgb})`;
      g.shadowBlur = b;
      for (let i = 0; i < 4; i++) g.drawImage(src, pad + Math.round(Math.cos(i * Math.PI / 2) * p), pad + Math.round(Math.sin(i * Math.PI / 2) * p));
      return { canvas: c, pad };
    });
    lift += landFace() * artScale();
    const [cx, cy] = centre(x, y);
    const left = -a.anchor[0] * k - h.pad * u, top = cy - a.anchor[1] * k - lift - h.pad * u;
    const w = h.canvas.width * u, ht = h.canvas.height * u;
    ctx.globalAlpha = alpha;
    if (flip) {
      ctx.save();
      ctx.translate(cx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(h.canvas, left, top, w, ht);
      ctx.restore();
    } else {
      ctx.drawImage(h.canvas, cx + left, top, w, ht);
    }
    ctx.globalAlpha = 1;
  }

  // The game's own highlight: the sprite's `_Outline` image (a blurred white silhouette, extracted as unitglow/... and
  // resourceglow/...) tinted in `g.colour` and drawn behind it, as the game's Outline renderers do. `o` defaults to the
  // outline registered for `a`; without one (older asset sets) the drawn rim stands in.
  function outlineArt(a, x, y, g, flip = false, scale = 1, lift = 0, o = gameOutline.get(a)) {
    if (!o) { glowArt(a, x, y, g, flip, scale, lift); return; }
    drawArt(o, x, y, (0.45 + 0.55 * g.v) * (g.fade ?? 1), flip, scale, lift, dimmed(g.colour, 1));
    stats.glows++;
  }

  // a tile with nothing standing on it (a building site): the halo goes round the top face instead
  function glowFace(x, y, g) {
    const rgb = dimmed(g.colour, 1);
    // the blur (the outline's shadow alone: the outline drawn off the canvas, its shadow offset back onto it) and the
    // outline itself, drawn once at device px; a path stroked on the board every frame stalls Chrome's GPU process
    // for 200 ms and more while another program keeps the GPU busy
    const S = zoomStep(view.sx * dpr), ratio = Math.round((sy() / view.sx) * 50) / 50, Sy = S * ratio;
    const h = cachedHalo(`face|${rgb}|${S}|${ratio}|${dpr}`, () => {
      const blur = Math.max(4 * dpr, S * 0.3), line = Math.max(1.5 * dpr, S * 0.06);
      const pad = Math.ceil(blur * 1.5 + line) + 2;
      const c = document.createElement("canvas");
      c.width = Math.ceil(2 * S) + 2 * pad;
      c.height = Math.ceil(2 * Sy) + 2 * pad;
      const ox = c.width / 2, oy = pad, a = S * 0.92, o = Sy * 0.08;
      const face = (gx, dx) => {
        gx.beginPath();
        gx.moveTo(ox + dx, oy + o);
        gx.lineTo(ox + dx + a, oy + Sy);
        gx.lineTo(ox + dx, oy + 2 * Sy - o);
        gx.lineTo(ox + dx - a, oy + Sy);
        gx.closePath();
      };
      const gx = c.getContext("2d"), off = c.width + 64;
      face(gx, -off);
      gx.shadowColor = `rgb(${rgb})`;
      gx.shadowBlur = blur;
      gx.shadowOffsetX = off;
      gx.strokeStyle = "#000";
      gx.lineWidth = line;
      gx.stroke();
      const edge = document.createElement("canvas");
      edge.width = c.width;
      edge.height = c.height;
      const ex = edge.getContext("2d");
      face(ex, 0);
      ex.strokeStyle = `rgb(${rgb})`;
      ex.lineWidth = line;
      ex.stroke();
      return { canvas: c, edge, ox, oy, S, Sy };
    });
    const [cx, cy] = corner(x, y);
    const fx = view.sx / h.S, fy = sy() / h.Sy; // CSS px per cached px
    const box = [cx - h.ox * fx, cy - h.oy * fy, h.canvas.width * fx, h.canvas.height * fy];
    ctx.globalAlpha = (0.35 + 0.65 * g.v) * (0.3 + 0.6 * g.v);
    ctx.drawImage(h.canvas, ...box);
    ctx.globalAlpha = 0.3 + 0.6 * g.v;
    ctx.drawImage(h.edge, ...box);
    ctx.globalAlpha = 1;
    stats.glows++;
  }

  // the capital's flag is ours: the extracted art has none
  function drawFlag(x, y, owner) {
    if (view.sx < 10) return;
    const [cx, cy] = centre(x, y);
    const h = view.sx * 0.95, px = cx + view.sx * 0.28, py = cy - view.sx * 0.72;
    ctx.strokeStyle = "#f4f4f4";
    ctx.lineWidth = Math.max(1.5, view.sx * 0.05);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - h * 0.55); ctx.stroke();
    ctx.fillStyle = tribeColour(owner);
    ctx.beginPath(); ctx.moveTo(px, py - h * 0.55); ctx.lineTo(px + h * 0.42, py - h * 0.4); ctx.lineTo(px, py - h * 0.25); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();
  }

  function drawUnit(u, x, y, ov) {
    const ua = unitArt(u);
    const ready = u.dim === false; // game.js sends dim on our units in our turn: false while one can still move or attack
    const spent = u.dim === true; // and true once it has nothing left to do: the game mixes such a unit 40% toward white
    const alpha = (u.flags?.includes("invisible") ? 0.6 : 1) * (ov && ov.alpha != null ? ov.alpha : 1); // only a cloaked unit is translucent
    stats.units.push({ id: u.id, owner: u.owner, ready, spent, alpha });
    if (ua && artImage(ua.own).state !== "failed") {
      if (ua.own.weapon) { const w = artEntry(ua.own.weapon); if (w) artImage(w); } // loaded before its first swing
      const flip = ov && ov.flip != null ? ov.flip : facesLeft(u);
      const lift = ov && ov.lift ? ov.lift : 0;
      const sc = ov && ov.scale != null ? ov.scale : 1;
      const tint = ov && ov.tint ? ov.tint : null, ta = tint ? alpha * (ov.tintAlpha ?? 1) : 0;
      // cut: the unit sprites carry a faint ground shadow the full width of the tile; the rim follows the figure only
      const glow = ready ? { colour: GLOW_COLOUR, v: 1, fade: ov && ov.alpha != null ? ov.alpha : 1, cut: 96 } : null;
      // the game's own outline sprites, tinted, behind the unit; the drawn rim only when the asset set has none
      const outline = (o, a, s, l) => {
        if (glow) outlineArt(a, x, y, glow, flip, s, l, o);
      };
      // the sprite's own shape in white over it, so every colour goes the same way toward white and black parts turn grey
      const wash = (a, s, l) => {
        if (spent) drawArt(a, x, y, alpha * SPENT_WASH, flip, s, l, SPENT_COLOUR);
      };
      if (ua.boat) {
        outline(ua.boatOutline, ua.boat, sc, lift);
        drawArt(ua.boat, x, y, alpha, flip, sc, lift);
        wash(ua.boat, sc, lift);
        outline(ua.outline, ua.own, 0.8 * sc, lift + view.sx * 0.28 * sc);
        drawArt(ua.own, x, y, alpha, flip, 0.8 * sc, lift + view.sx * 0.28 * sc);
        wash(ua.own, 0.8 * sc, lift + view.sx * 0.28 * sc);
        if (tint) drawArt(ua.own, x, y, ta, flip, 0.8 * sc, lift + view.sx * 0.28 * sc, tint);
      } else {
        outline(ua.outline, ua.own, sc, lift);
        drawArt(ua.own, x, y, alpha, flip, sc, lift);
        wash(ua.own, sc, lift);
        if (tint) drawArt(ua.own, x, y, ta, flip, sc, lift, tint);
      }
      return;
    }
    const s = unitImage(u);
    if (s && s.state === "ok") {
      drawSprite(s, x, y, alpha);
    } else if (!s || s.state === "failed") {
      const [cx, cy] = corner(x, y);
      const r = Math.max(5, view.sx * 0.32);
      ctx.beginPath();
      ctx.arc(cx, cy + sy() * 0.6, r, 0, Math.PI * 2);
      ctx.fillStyle = tribeColour(u.owner);
      ctx.fill();
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (view.sx >= 12) {
        ctx.fillStyle = "#fff";
        ctx.font = `700 ${Math.max(8, r * 0.8)}px system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(unitName(u.type).slice(0, 2), cx, cy + sy() * 0.6);
      }
    }
  }

  // The game look's unit status display, as retail's UnitStatusDisplay (world units, y up, from 0.106 above the tile's
  // centre, measured on the rig):
  // - health at (-0.25, 0.15): ceil(health / 10) in JosefinSans-Italic 0.1 high, white, red below 5; behind it, at
  //   (-0.24, 0.13) x 0.7, a shield by the defence bonus (tenths): none at 10, reduced below, shield_1 above, shield_2 from 40;
  // - the type at (0.24, 0.147): circle_30 x 0.7 in the owner's colour at 0.4 alpha (it comes out as 48% of the colour over
  //   #323232: measured on Imperius only), a white outline_64 x 0.35 while the unit can still both move and attack in its
  //   owner's turn, and the type icon x (0.72, 0.74) over its 25% black shadow offset (0.005, -0.005).
  const BADGE = { lift: 0.106, hp: [-0.25, 0.15], shield: [-0.24, 0.13], type: [0.24, 0.147], text: 0.1 };
  function unitBadgeArt() {
    if (!art || !textDrawer || !textDrawer.has("josefin-italic")) return null;
    const keys = { circle: "icon/circle_30", ring: "icon/outline_64", low: "icon/unithealthgfx_reduced", one: "icon/unithealthgfx_shield_1", two: "icon/unithealthgfx_shield_2" };
    const out = {};
    for (const [k, key] of Object.entries(keys)) if (!(out[k] = artEntry(key))) return null;
    return out;
  }
  // the sprite `a` with its anchor at (x, y), scaled by (kx, ky) at world size, in one colour when `rgb` is given
  function worldSprite(a, img, x, y, kx, ky, rgb, alpha = 1) {
    const w = wuPx() / (a.ppu || 100), sx = w * kx, sy2 = w * ky;
    if (alpha !== 1) ctx.globalAlpha *= alpha;
    ctx.drawImage(rgb ? tinted(img, rgb) : img.img, x - a.anchor[0] * sx, y - a.anchor[1] * sy2, a.w * sx, a.h * sy2);
    if (alpha !== 1) ctx.globalAlpha /= alpha;
  }
  function drawGameBadge(u, cx, cy, a) {
    const imgs = {};
    for (const k of Object.keys(a)) {
      imgs[k] = artImage(a[k]);
      if (imgs[k].state !== "ok") return imgs[k].state === "loading";
    }
    const w = wuPx(), oy = cy - BADGE.lift * w, at = (p) => [cx + p[0] * w, oy - p[1] * w];
    const bonus = u.defence_bonus ?? 10, health = u.health ?? 100;
    const shield = bonus === 10 ? null : bonus < 10 ? "low" : bonus >= 40 ? "two" : "one";
    const [hx, hy] = at(BADGE.hp), [bx, by] = at(BADGE.shield);
    let box;
    if (shield) {
      const e = a[shield], k = (w / e.ppu) * 0.7;
      worldSprite(e, imgs[shield], bx, by, 0.7, 0.7);
      box = [bx - e.anchor[0] * k, by - e.anchor[1] * k, e.w * k, e.h * k];
    }
    const text = String(Math.ceil(health / 10)), size = BADGE.text * w;
    const m = textDrawer.measure(text, { font: "josefin-italic", size });
    textDrawer.draw(ctx, text, hx - m.w / 2, hy + (m.box.t + m.box.b) / 2, { font: "josefin-italic", size, colour: health < 50 ? "#ff0000" : "#fff", dpr });
    if (!box) box = [hx - m.w / 2, hy - size / 2, m.w, size];
    stats.badgeBoxes.push({ x: u.x, y: u.y, rect: box, look: "game", shield, text });
    const [tx, ty] = at(BADGE.type), own = dimmed(tribeColour(u.owner), 1);
    const fill = own.map((v) => Math.round(v * 0.48 + 50 * 0.52));
    worldSprite(a.circle, imgs.circle, tx, ty, 0.7, 0.7, fill);
    const ring = u.dim === false && u.moved === false && u.attacked === false; // game.js sets dim only on our units in our turn
    if (ring) worldSprite(a.ring, imgs.ring, tx, ty, 0.35, 0.35);
    const icon = badgeIcon(u), ii = icon && artImage(icon.a), r = ((a.circle.w / a.circle.ppu) * 0.7 * w) / 2;
    let iconW = 0;
    if (ii && ii.state === "ok") {
      if (icon.sprite) {
        // a unit's own sprite is not made to an icon's size: its figure (not the empty sprite round it) fitted in the disc
        const [x0, y0, x1, y1] = opaqueBox(ii.img, icon.a.w, icon.a.h), k = (r * 1.5) / Math.max(x1 - x0, y1 - y0);
        iconW = (x1 - x0) * k;
        ctx.drawImage(ii.img, tx - ((x0 + x1) / 2) * k, ty - ((y0 + y1) / 2) * k, icon.a.w * k, icon.a.h * k);
      } else {
        iconW = (icon.a.w / (icon.a.ppu || 100)) * 0.72 * w;
        worldSprite(icon.a, ii, tx + 0.005 * w, ty + 0.005 * w, 0.74, 0.74, [0, 0, 0], 0.25);
        worldSprite(icon.a, ii, tx, ty, 0.72, 0.74);
      }
    }
    const hex = "#" + fill.map((v) => v.toString(16).padStart(2, "0")).join("");
    stats.badges.push({ id: u.id, x: tx, y: ty, r, colour: hex, icon: icon ? icon.name : null, iconW, ring, look: "game" });
    return true;
  }

  function drawUnitBadge(u, ov) {
    // hit points on the left and the owner's colour on the right, as the game's unit status display; far out, just
    // the owner's colour
    const [cx, cy] = centre(ov && ov.x != null ? ov.x : u.x, ov && ov.y != null ? ov.y : u.y);
    if (view.sx < 14) {
      ctx.beginPath();
      ctx.arc(cx, cy + sy() * 0.1, Math.max(2.5, view.sx * 0.22), 0, Math.PI * 2);
      ctx.fillStyle = tribeColour(u.owner);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    const gameArt = unitBadgeArt();
    if (gameArt && drawGameBadge(u, cx, cy, gameArt)) return;
    const fs = Math.max(9, view.sx * 0.26);
    const hp = (u.health ?? 100) / 10;
    const text = Number.isInteger(hp) ? String(hp) : hp.toFixed(1);
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = Math.max(fs * 1.3, ctx.measureText(text).width + fs * 0.5), bx = cx - view.sx * 0.42, by = cy - sy() * 0.15;
    ctx.fillStyle = u.moved && u.attacked ? "rgba(150,150,150,0.92)" : "rgba(245,245,245,0.95)";
    stats.badgeBoxes.push({ x: u.x, y: u.y, rect: [bx - w / 2, by - fs * 0.62, w, fs * 1.24] });
    ctx.fillRect(bx - w / 2, by - fs * 0.62, w, fs * 1.24);
    ctx.fillStyle = (u.health ?? 100) < maxHealth(u) ? "#b3261e" : "#333";
    ctx.fillText(text, bx, by + 0.5);
    const ox = cx + view.sx * 0.42;
    ctx.beginPath();
    ctx.arc(ox, by, fs * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = tribeColour(u.owner);
    ctx.fill();
    const icon = badgeIcon(u);
    if (icon) drawBadgeIcon(icon.a, ox, by, fs * 0.9);
    stats.badges.push({ id: u.id, x: ox, y: by, r: fs * 0.55, colour: tribeColour(u.owner), icon: icon ? icon.name : null });
    if (u.promotion > 0) { // just outside the disc's top right, outlined, so the icon stays clear
      ctx.font = `700 ${fs * 0.6}px system-ui, sans-serif`;
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(10,12,18,0.9)";
      ctx.strokeText("★", ox + fs * 0.5, by - fs * 0.5);
      ctx.fillStyle = "#fff";
      ctx.fillText("★", ox + fs * 0.5, by - fs * 0.5);
    }
  }

  // The icon for a unit's badge, as retail's UnitStatusDisplay.SetState picks it: the type of the unit it carries when it
  // carries one (a raft shows who is aboard), else its own. The extracted icon, or that type's own sprite (`sprite`)
  // where the art has no icon for the type.
  function badgeIcon(u) {
    const id = unitInfo((u.passenger || u).type)?.id;
    if (!id) return null;
    const icon = artEntry(`icon/${id}_icon`);
    if (icon) return { name: `icon/${id}_icon`, a: icon };
    const tribe = ownerTribeName(u.owner), own = tribe && artEntry(`unit/${tribe}/${id}`);
    return own ? { name: `unit/${tribe}/${id}`, a: own, sprite: true } : null;
  }

  // a sprite fitted inside a `size` px square centred on (x, y); nothing is drawn while it loads
  function drawBadgeIcon(a, x, y, size) {
    const e = artImage(a);
    if (e.state !== "ok") return;
    const k = Math.min(size / a.w, size / a.h);
    ctx.drawImage(e.img, x - (a.w * k) / 2, y - (a.h * k) / 2, a.w * k, a.h * k);
  }

  function drawRoad(x, y) {
    // a road runs from the tile's centre half way to each neighbour (diagonals too) that has a road or a city
    const [cx, cy] = centre(x, y);
    ctx.strokeStyle = "rgba(150,105,60,0.95)";
    ctx.lineWidth = Math.max(2, view.sx * 0.12);
    ctx.lineCap = "round";
    let any = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nb = (dx || dy) && tileAtXY(x + dx, y + dy);
      if (!nb || !(nb.road || nb.city)) continue;
      const [nx, ny] = centre(x + dx, y + dy);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo((cx + nx) / 2, (cy + ny) / 2); ctx.stroke();
      any = true;
    }
    if (!any) { ctx.beginPath(); ctx.arc(cx, cy, ctx.lineWidth, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
    ctx.lineCap = "butt";
  }

  // A south or west border waits in `laid`, keyed by the tile in front, until that tile's ground is drawn (drawFacing), so
  // the ground does not cover it. A tile with no ground to draw (unknown, or under cloud) gets its border at once, and one
  // that is not drawn this frame gets it at the end of the frame.
  const laid = new Map();
  const drawsGround = (t) => !!t && t.known && !(fogArt() && fogged(t));
  function frontBorders(t, x, y) {
    for (const edge of ["south", "west"]) {
      const [dx, dy] = BORDER_NEIGHBOUR[edge], key = `${x + dx},${y + dy}`;
      if (drawsGround(tileAtXY(x + dx, y + dy))) laid.set(key, [...(laid.get(key) ?? []), { t, x, y, edge }]);
      else drawBorderSides(t, x, y, [edge]);
    }
  }
  function drawFacing(x, y) {
    const key = `${x},${y}`, list = laid.get(key);
    if (!list) return;
    laid.delete(key);
    for (const b of list) drawBorderSides(b.t, b.x, b.y, [b.edge]);
  }

  // The game's border: four dashed-edge sprites on a tile, one per side, tinted with the owner's colour. Each stands on its
  // side of the tile's diamond, as in the game: the feet of its dashes run along the side, so the sprite's centre is half a
  // dash above the side's midpoint (BORDER_SIDE: signs of the midpoint's offset from the top face's centre, in half the
  // diamond's width and half its height). The north and east ones go behind what stands on the tile; the south and
  // west ones go over the ground of the tile in front (frontBorders). A side is drawn where the neighbour has another owner.
  // A water tile's borders stay at the height of a land tile's, as in the game, so a border runs straight from land over water.
  const BORDER_NEIGHBOUR = { north: [0, 1], east: [1, 0], south: [0, -1], west: [-1, 0] };
  const BORDER_SIDE = { north: [-1, -1], east: [1, -1], south: [1, 1], west: [-1, 1] };
  const borderArt = () => {
    const list = art?.manifest?.geometry?.borders;
    return list && list.length && list.every((b) => artEntry(b.key)) ? list : null;
  };
  const dimmed = (hex, dim) => [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * dim));
  function borderTint(entry, hex, dim) {
    return tinted(entry, dimmed(hex, dim));
  }
  // a white sprite drawn in one colour (cached)
  // `cut` (0..255): drop pixels fainter than that first, so a sprite's soft ground shadow is not part of the silhouette
  function tinted(entry, rgb, cut = 0) {
    const key = `${entry.url}|${rgb}|${cut}`;
    let c = tintCache.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = entry.img.width; c.height = entry.img.height;
      const g = c.getContext("2d");
      g.drawImage(entry.img, 0, 0);
      if (cut) {
        const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
        for (let i = 3; i < px.length; i += 4) px[i] = px[i] < cut ? 0 : 255;
        g.putImageData(d, 0, 0);
      }
      g.globalCompositeOperation = "source-in";
      g.fillStyle = `rgb(${rgb})`;
      g.fillRect(0, 0, c.width, c.height);
      tintCache.set(key, c);
    }
    return c;
  }
  // A sprite as retail's Polytopia/Sprite shader draws one marked DESATURATED (cached): its colours times 243 / 255,
  // then drawn 0.4 of the way to their own grey (Rec. 709 luma). Retail marks so the houses of a city that is not the
  // viewer's.
  function paled(entry) {
    const key = `${entry.url}|pale`;
    let c = tintCache.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = entry.img.width; c.height = entry.img.height;
      const g = c.getContext("2d");
      g.drawImage(entry.img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height), px = d.data, dim = 243 / 255;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i] * dim, gr = px[i + 1] * dim, b = px[i + 2] * dim, grey = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
        px[i] = grey + 0.6 * (r - grey); px[i + 1] = grey + 0.6 * (gr - grey); px[i + 2] = grey + 0.6 * (b - grey);
      }
      g.putImageData(d, 0, 0);
      tintCache.set(key, c);
    }
    return c;
  }
  // the picture to draw for a layer's entry: its loaded image, coloured or paled when the entry says so
  const partImage = (a, e) => (a.shade ? shaded(e, a.shade) : a.pale ? paled(e) : e.img);
  // a sprite multiplied by one colour (cached), as the game colours a part: the sprite's own shading stays
  function shaded(entry, colour) {
    const key = `${entry.url}|x${colour}`;
    let c = tintCache.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = entry.img.width; c.height = entry.img.height;
      const g = c.getContext("2d");
      g.drawImage(entry.img, 0, 0);
      g.globalCompositeOperation = "multiply";
      g.fillStyle = colour;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(entry.img, 0, 0);
      tintCache.set(key, c);
    }
    return c;
  }
  function drawBorderSides(t, x, y, edges) {
    const list = t && t.owner && t.known ? borderArt() : null;
    if (!list || fogged(t)) return;
    const k = artScale(), [cx, cy] = centre(x, y);
    const dims = art.manifest.geometry.border_dim || {};
    const dim = dims[String(tribeIdx(t.owner))] ?? dims.default ?? 0.62;
    for (const b of list) {
      if (!edges.includes(b.edge)) continue;
      const [dx, dy] = BORDER_NEIGHBOUR[b.edge];
      const nb = tileAtXY(x + dx, y + dy);
      if (nb && nb.owner === t.owner) continue;
      const a = artEntry(b.key), e = artImage(a);
      if (e.state !== "ok") continue;
      const [ux, uy] = BORDER_SIDE[b.edge];
      const rise = (a.h * k - sy()) / 2; // half a dash: the sprite is a side's height plus one dash high
      ctx.drawImage(borderTint(e, tribeColour(t.owner), dim), cx + (ux * view.sx) / 2 - a.anchor[0] * k, cy + (uy * sy()) / 2 - a.anchor[1] * k - rise, a.w * k, a.h * k);
    }
  }

  function drawBorders() {
    // a territory edge is drawn where the neighbour has a different owner. Corners 0 top, 1 right, 2 bottom, 3 left;
    // then the neighbour across that edge (the top-right edge's neighbour is game x+1, and so on round)
    const edges = [[0, 1, 1, 0], [1, 2, 0, -1], [2, 3, -1, 0], [3, 0, 0, 1]];
    const n = pos.n, a = view.sx * 0.92, b = sy() * 0.92;
    ctx.lineWidth = Math.max(1.5, view.sx * 0.09);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const t = pos.tiles[y * n + x];
        if (!t || !t.owner || !t.known || fogged(t)) continue;
        const [cx, cy] = corner(x, y);
        if (cx < -a || cx > cssW + a || cy < -2 * b || cy > cssH + 2 * b) continue;
        const oy = sy();
        const pts = [[cx, cy + oy - b], [cx + a, cy + oy], [cx, cy + oy + b], [cx - a, cy + oy]];
        ctx.strokeStyle = tribeColour(t.owner);
        for (const [p, q, dx, dy] of edges) {
          const nb = tileAtXY(x + dx, y + dy);
          if (nb && nb.owner === t.owner) continue;
          ctx.beginPath();
          ctx.moveTo(pts[p][0], pts[p][1]);
          ctx.lineTo(pts[q][0], pts[q][1]);
          ctx.stroke();
        }
      }
    }
  }

  // The city plate: one banner in the owner's colour, made of the retail progress bar's sprites (round ends and a flat
  // middle, scaled to the plate's height). Its top row holds the name, a crown before it for a capital. For the viewer's
  // own city a row beneath holds the population pips (a city needs level + 1 to grow, so that many, filled as far as it
  // has come) and the units it supports out of what it can (level + 1 at most), in a small dark badge at the row's end.
  // Other cities get the name alone. The plate hangs below the tile's centre, clear of the unit badge on the city.
  const plateArt = () => {
    if (!art) return null;
    const p = { l: artEntry("icon/cityprogressbg_0"), m: artEntry("icon/cityprogressbg_1"), r: artEntry("icon/cityprogressbg_2"), dot: artEntry("icon/cityprogressdots") };
    return p.l && p.m && p.r && p.dot ? p : null;
  };
  // the text cut to `max` px with an ellipsis when it is longer (the caller has set the font)
  function fitText(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1);
    return `${out}…`;
  }
  function drawPlate(t, cx, cy) {
    const p = plateArt();
    if (!p) return false;
    const imgs = {};
    for (const k of ["l", "m", "r", "dot"]) {
      imgs[k] = artImage(p[k]);
      if (imgs[k].state !== "ok") return imgs[k].state === "loading";
    }
    const s = view.sx;
    const fs = clamp(s * 0.3, 10, 17), slots = Math.max(1, t.level) + 1, pitch = fs * 0.9, dot = fs * 0.6, gap = fs * 0.35;
    const mine = !!t.owner && (fogFor == null || fogFor === t.owner); // every owned city when there is no fog
    const showPips = mine && t.xp != null;
    const units = mine && t.supported != null ? `${t.supported}/${slots}` : "";
    const rgb = dimmed(tribeColour(t.owner), 0.55);

    const name = t.name || "city";
    const crown = t.capital ? artEntry("icon/crown") : null;
    const cw = crown ? fs * crown.w / crown.h : 0;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const shown = fitText(name, s * 6);
    const nm = ctx.measureText(shown);
    const nameW = nm.width + (crown ? cw + fs * 0.25 : 0);
    ctx.font = `700 ${fs * 0.85}px system-ui, sans-serif`;
    const chipW = units ? ctx.measureText(units).width + fs * 0.6 : 0;
    const pipsW = showPips ? slots * pitch : 0;
    const rowW = pipsW + (units ? chipW + (showPips ? gap : 0) : 0);
    const hasRow = showPips || !!units;
    const nh = fs * 1.15, ph = hasRow ? fs * 0.9 : 0, vpad = fs * 0.18;
    // the bar sprites are 20 rows tall, and each end's slice is 12 columns: the round cap (about 8 columns) and a flat run.
    // Scaled by H / 20, the caps stay round at the plate's height.
    const H = nh + ph + 2 * vpad, k = H / 20, capW = 12 * k;
    const w = Math.round(Math.max(nameW, rowW, 2 * capW) + H * 0.8);
    const x0 = Math.round(cx - w / 2), y0 = Math.round(cy + sy() * 0.62);
    const plate = { x: t.x, y: t.y, name: t.name, capital: t.capital, xp: showPips ? t.xp : null, slots, units, rect: [x0, y0, w, H], colour: rgb, label: null, badge: null };
    stats.plates.push(plate);

    ctx.globalAlpha = 0.92;
    const bar = (e, sx, sw, dx, dw) => ctx.drawImage(tinted(e, rgb), sx, 4, sw, 20, dx, y0, dw, H);
    bar(imgs.l, 4, 12, x0, capW);
    bar(imgs.m, 20, 14, x0 + capW, w - 2 * capW);
    bar(imgs.r, 40, 12, x0 + w - capW, capW);
    ctx.globalAlpha = 1;

    if (hasRow) {
      const rowY = y0 + vpad + nh + ph / 2, gx = cx - rowW / 2;
      if (showPips) {
        const filled = clamp(t.xp, 0, slots);
        for (let i = 0; i < slots; i++) {
          ctx.globalAlpha = i < filled ? 1 : 0.28;
          ctx.drawImage(imgs.dot.img, 20, 4, 12, 12, gx + i * pitch + (pitch - dot) / 2, rowY - dot / 2, dot, dot);
        }
        ctx.globalAlpha = 1;
      }
      if (units) {
        const chipX = gx + pipsW + (showPips ? gap : 0);
        plate.badge = [chipX, rowY - ph / 2, chipW, ph];
        ctx.fillStyle = "rgba(10,12,18,0.85)";
        ctx.fillRect(...plate.badge);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(units, chipX + chipW / 2, rowY + 0.5);
      }
    }

    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const nameY = y0 + vpad + nh / 2, groupX = cx - nameW / 2, nx = groupX + (crown ? cw + fs * 0.25 : 0);
    if (crown) {
      const e = artImage(crown);
      if (e.state === "ok") ctx.drawImage(e.img, groupX, nameY - fs / 2, cw, fs);
    }
    ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, fs * 0.28); ctx.strokeStyle = "rgba(10,12,18,0.85)";
    ctx.strokeText(shown, nx, nameY);
    ctx.fillStyle = "#fff";
    ctx.fillText(shown, nx, nameY);
    plate.label = { text: name, shown, rect: [nx, nameY - nm.actualBoundingBoxAscent, nm.width, nm.actualBoundingBoxAscent + nm.actualBoundingBoxDescent] };
    return true;
  }

  // The game look's city label, laid out as retail's CityStatusDisplay does it (sizes in world units):
  // - a bar in the owner's colour at half opacity, 0.192 high and 26.4 Square-widths (1.056) times as wide as its content;
  // - the content, centred: for a capital a crown on a #0399ff circle, then the name (JosefinSans-Italic, 0.144; underlined
  //   for a capital), then the city's stars a turn: a star and the number (Roboto-Light_Numbers, 0.128). Gaps follow
  //   CityStatusNameContainer.UpdateSize; the texts take the width of their glyph quads, padding included, as TMP measures;
  // - for the viewer's own city, a progress bar beneath: level + 1 segments over min(0.59 + (n - 2) x 0.27, 0.9), the
  //   population's segments #0099ff (#ff3300 when it is negative), the rest #e5e5e5, and a dot for each unit the city
  //   supports, white on a filled segment and black on an empty one (CityStatusProgressBar.UpdateFields).
  // The label's origin is 0.057 below the tile's centre, the name 0.08 and the bar 0.25 below that (measured on the rig).
  const CITY = { drop: 0.057, nameY: 0.08, barY: 0.25, name: 0.144, number: 0.128, square: 0.04, base: [229, 229, 229], fill: [0, 153, 255], negative: [255, 51, 0], circle: [3, 153, 255] };
  function cityLabelArt() {
    if (!art || !textDrawer || !textDrawer.has("josefin-italic") || !textDrawer.has("roboto-numbers")) return null;
    const keys = { crown: "icon/crown", circle: "icon/circle_30", star: "icon/resource", l: "icon/cityprogressbg_0", m: "icon/cityprogressbg_1", r: "icon/cityprogressbg_2", dot: "icon/cityprogressdots" };
    const out = {};
    for (const [k, key] of Object.entries(keys)) if (!(out[k] = artEntry(key))) return null;
    return out;
  }
  function drawCityLabel(t, cx, cy, a) {
    const imgs = {};
    for (const k of Object.keys(a)) {
      imgs[k] = artImage(a[k]);
      if (imgs[k].state !== "ok") return imgs[k].state === "loading";
    }
    const w = wuPx(), name = t.name || "city";
    const mine = !!t.owner && (fogFor == null || fogFor === t.owner);
    const ox = cx, oy = cy + CITY.drop * w, ny = oy + CITY.nameY * w;
    // the sprite `k` at scale `sc`, its anchor at (x, y), in one colour when `rgb` is given
    const sprite = (k, x, y, sc, rgb) => {
      const e = a[k], s = (w / (e.ppu || 100)) * sc;
      ctx.drawImage(rgb ? tinted(imgs[k], rgb) : imgs[k].img, x - e.anchor[0] * s, y - e.anchor[1] * s, e.w * s, e.h * s);
    };
    const nameSize = CITY.name * w, numSize = CITY.number * w;
    const nm = textDrawer.measure(name, { font: "josefin-italic", size: nameSize });
    const work = t.work != null ? String(t.work) : null;
    const wm = work != null ? textDrawer.measure(work, { font: "roboto-numbers", size: numSize }) : null;
    // CityStatusNameContainer.UpdateSize, in world units from the content's left
    const r = (a.circle.w / a.circle.ppu) * 0.48 / 2;
    let W = 0, iconX = null, workX = null;
    if (t.capital) { iconX = r + 0.012; W = 2 * r + 0.012; }
    const nameX = W + 0.03;
    W += (nm.box.r - nm.box.l) / w + 0.03;
    if (wm) {
      workX = W + 0.015;
      W += (a.star.w / a.star.ppu) * 0.2 + (wm.box.r - wm.box.l) / w + 0.012 + 0.015;
    } else W += 0.03;
    const left = ox - (W / 2) * w, bw = W * 26.4 * CITY.square * w, bh = 4.8 * CITY.square * w;
    const rgb = dimmed(tribeColour(t.owner), 1);
    ctx.fillStyle = `rgba(${rgb},0.5)`;
    ctx.fillRect(ox - bw / 2, ny - bh / 2, bw, bh);
    if (iconX != null) {
      sprite("circle", left + iconX * w, ny, 0.48, CITY.circle);
      sprite("crown", left + iconX * w, ny, 0.115);
    }
    const pen = left + nameX * w, base = ny + (nm.ascent - nm.descent) / 2;
    textDrawer.draw(ctx, name, pen, base, { font: "josefin-italic", size: nameSize, colour: "#fff", dpr });
    if (t.capital) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(pen + Math.max(0, nm.box.l), base + 0.17 * nameSize, nm.w - Math.max(0, nm.box.l), Math.max(1 / dpr, 0.07 * nameSize));
    }
    if (wm) {
      const sx = left + (workX + 0.07) * w;
      sprite("star", sx, ny + 0.004 * w, 0.2, [0, 0, 0]);
      sprite("star", sx, ny, 0.2);
      textDrawer.draw(ctx, work, left + (workX + 0.15) * w, ny + (wm.box.t + wm.box.b) / 2, { font: "roboto-numbers", size: numSize, colour: "#fff", dpr });
    }
    let rect = [ox - bw / 2, ny - bh / 2, bw, bh], slots = null, dots = null;
    if (mine && t.xp != null) {
      const n = Math.max(1, t.level || 1) + 1, T = Math.min(0.59 + (n - 2) * 0.27, 0.9), seg = T / n, by = oy + CITY.barY * w;
      const filled = Math.min(Math.abs(t.xp), n), colour = t.xp < 0 ? CITY.negative : CITY.fill;
      dots = t.supported || 0;
      slots = n;
      for (let i = 0; i < n; i++) {
        const k = i === 0 ? "l" : i === n - 1 ? "r" : "m", e = a[k], h = (e.h / e.ppu) * w, sx = ox + ((i + 0.5) * seg - T / 2) * w;
        ctx.drawImage(tinted(imgs[k], i < filled ? colour : CITY.base), sx - (seg / 2) * w, by - h / 2, seg * w, h);
        if (i < dots) sprite("dot", sx, by, 0.75, i < filled ? [255, 255, 255] : [0, 0, 0]);
      }
      const bh2 = (a.m.h / a.m.ppu) * w, top = Math.min(rect[1], by - bh2 / 2), x0 = Math.min(rect[0], ox - (T / 2) * w);
      rect = [x0, top, Math.max(rect[0] + rect[2], ox + (T / 2) * w) - x0, Math.max(rect[1] + rect[3], by + bh2 / 2) - top];
    }
    stats.plates.push({
      x: t.x, y: t.y, name: t.name, capital: t.capital, look: "game", xp: slots ? t.xp : null, slots, dots, work, rect, colour: rgb, badge: null,
      label: { text: name, shown: name, rect: [pen + nm.box.l, base - nm.box.t, nm.box.r - nm.box.l, nm.box.t - nm.box.b] },
    });
    return true;
  }

  function drawLabels() {
    if (view.sx < 16) return; // names would only be clutter
    const plate = plateArt(), game = cityLabelArt();
    const fs = Math.max(10, view.sx * 0.3);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const t of pos.tiles) {
      // a village (a city with no owner) has no name plate, as in retail
      if (!t || !t.known || !t.city || !t.owner || fogged(t)) continue;
      const [cx, cy] = centre(t.x, t.y);
      if (cx < -100 || cx > cssW + 100 || cy < -60 || cy > cssH + 60) continue;
      if (game && drawCityLabel(t, cx, cy, game)) continue;
      if (plate && drawPlate(t, cx, cy)) continue;
      const label = (t.capital ? "★ " : "") + (t.name || "city");
      const tw = ctx.measureText(label).width + fs * 0.8;
      const ly = cy + sy() * 0.9;
      ctx.fillStyle = t.owner ? tribeColour(t.owner) : "rgba(20,20,20,0.75)";
      ctx.globalAlpha = 0.85;
      ctx.fillRect(cx - tw / 2, ly - fs * 0.7, tw, fs * 1.4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.fillText(label, cx, ly);
    }
  }

  // retail's space around the map: about 130 single-pixel stars per screen whatever its size, mostly full white, a
  // tenth or so dimmer (measured on the reference rig at 1280 x 800 and 1920 x 1080).
  // They follow the map a little, as retail's BgStarContainerParalax and its Polytopia/Star shader: each star has a
  // depth of 0.5 to 1.8 and moves STAR_SPEED x its depth of what the map moves on screen (a tenth to a third), and one
  // that leaves the screen comes back in at the opposite edge. Only the camera's travel counts, that is the map point
  // under the middle of the screen changing, at the zoom of the moment: zooming about the middle moves no star.
  // They keep still with reduced motion. stats.stars is where the last draw put each one ([x, y, depth], CSS px).
  const STAR_SPEED = 0.2;
  let stars = null;
  const drift = { x: 0, y: 0, at: null }; // the camera's travel so far in half screen heights, and where it was last measured
  const calm = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function drawSpace(w, h) {
    if (!w || !h) return;
    if (!stars) {
      let seed = 0x2545f491;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      stars = Array.from({ length: 130 }, () => [rnd(), rnd(), rnd() < 0.15 ? 0.5 : 1]);
      for (const s of stars) s.push(0.5 + 1.3 * rnd());
    }
    const mx = (w / 2 - view.ox) / view.sx, my = (h / 2 - view.oy) / view.sx, at = drift.at;
    if (at && at.w === w && at.h === h && !(calm && calm.matches)) {
      drift.x -= ((mx - at.mx) * view.sx) / (h / 2);
      drift.y -= ((my - at.my) * view.sx) / (h / 2);
    }
    drift.at = { mx, my, w, h };
    const px = 1 / dpr, wrap = (v, m) => ((v % m) + m) % m;
    stats.stars = [];
    for (const [fx, fy, a, depth] of stars) {
      const k = (depth * STAR_SPEED * h) / 2, x = wrap(fx * w + drift.x * k, w), y = wrap(fy * h + drift.y * k, h);
      ctx.fillStyle = a === 1 ? "#fff" : "rgba(255,255,255,0.5)";
      ctx.fillRect(Math.floor(x * dpr) / dpr, Math.floor(y * dpr) / dpr, px, px);
      stats.stars.push([x, y, depth]);
    }
  }

  function draw() {
    const t0 = performance.now();
    const w = cssW, h = cssH, n = pos.n;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = opts.space ? "#000" : opts.background || "#0b0d12";
    ctx.fillRect(0, 0, w, h);
    if (opts.space) drawSpace(w, h);
    stats.lastTiles = 0;
    stats.plates = [];
    stats.glows = 0;
    stats.units = [];
    stats.badges = [];
    stats.badgeBoxes = [];
    stats.fires = [];
    stats.cities = [];
    if (!n || !w || !h) return;
    const k = view.sx / geo.sx;
    const left = geo.anchor[0] * k, up = geo.anchor[1] * k, down = (geo.height - geo.anchor[1]) * k;
    const unitAtTile = new Map(), standing = new Map();
    for (const u of pos.units) {
      standing.set(u.y * n + u.x, u);
      if (!overrides.has(u.id)) unitAtTile.set(u.y * n + u.x, u);
    }
    const now = performance.now();
    let selectorDrawn = false;
    // back to front: i + j ascending, i.e. x + y descending
    for (let s = 2 * n - 2; s >= 0; s--) {
      for (let x = Math.max(0, s - n + 1); x <= Math.min(n - 1, s); x++) {
        const y = s - x;
        const [cx, cy] = corner(x, y);
        if (cx + left < 0 || cx - left > w || cy + down < 0 || cy - up > h) continue;
        stats.lastTiles++;
        const t = pos.tiles[y * n + x];
        const burning = besieged(t, standing.get(y * n + x));
        drawTile(t, x, y, burning);
        if (!t || !t.known) continue;
        if (t.road && !t.city) drawRoad(x, y);
        const fg = fogged(t);
        // retail's white selector diamond lies on the selected tile, under what stands there
        if (selected && selected[0] === x && selected[1] === y && !fg) selectorDrawn = drawOnTile("fx/selectoriso_1_white", x, y);
        const u = unitAtTile.get(y * n + x);
        if (u && !fg) drawUnit(u, x, y);
        if (burning) {
          const [fx0, fy0] = centre(x, y);
          stats.fires.push({ x, y, cx: fx0, cy: fy0, particles: drawFire(x, y, now) });
        }
        if (!fg) frontBorders(t, x, y);
        if (fg && !fogArt()) {
          diamond(x, y);
          ctx.fillStyle = "rgba(4,6,12,0.72)";
          ctx.fill();
        }
      }
    }
    for (const list of laid.values()) for (const b of list) drawBorderSides(b.t, b.x, b.y, [b.edge]);
    laid.clear();
    drawFx(true);
    for (const u of pos.units) {
      const ov = overrides.get(u.id);
      if (ov && !ov.hidden && !fogged(tileAtXY(Math.round(ov.x ?? u.x), Math.round(ov.y ?? u.y)))) drawUnit(u, ov.x ?? u.x, ov.y ?? u.y, ov);
    }
    if (!borderArt()) drawBorders();
    drawOverlays("under");
    for (const u of pos.units) {
      const ov = overrides.get(u.id);
      if (ov && (ov.hidden || (ov.alpha != null && ov.alpha < 0.99) || (ov.scale != null && ov.scale < 0.99))) continue; // appearing or fading
      const t = tileAtXY(u.x, u.y);
      if (!fogged(t)) drawUnitBadge(u, ov);
    }
    drawLabels(); // over the badges, so a neighbour's badge cannot hide a city's name
    drawOverlays("over");
    drawFx();
    // without the selector art (or before it has loaded) the selected tile has a blue outline
    if (selected && inside(selected[0], selected[1]) && !selectorDrawn) {
      diamond(selected[0], selected[1]);
      ctx.fillStyle = "rgba(74,163,255,0.26)";
      ctx.fill();
      ctx.strokeStyle = "#4aa3ff";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    stats.draws++;
    stats.lastMs = performance.now() - t0;
    keepBurning();
  }

  // ---------- overlays ----------
  function markerRadius(kind) {
    return kind === "move" ? Math.max(view.sx * 0.2, 9) : Math.max(view.sx * (kind === "attack" || kind === "kill" ? 0.34 : kind === "disembark" ? 0.26 : 0.38), 15);
  }

  function pill(text, cx, cy, colour) {
    const fs = Math.max(11, Math.min(15, view.sx * 0.32));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width + fs * 0.9;
    ctx.fillStyle = "rgba(10,12,18,0.85)";
    ctx.fillRect(cx - tw / 2, cy - fs * 0.75, tw, fs * 1.5);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - tw / 2, cy - fs * 0.75, tw, fs * 1.5);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, cx, cy + 0.5);
  }

  function arrow(from, to, colour, dashed, lw) {
    const [ax, ay] = centre(from[0], from[1]), [bx, by] = centre(to[0], to[1]);
    ctx.strokeStyle = ctx.fillStyle = colour;
    ctx.lineWidth = lw;
    if (from[0] === to[0] && from[1] === to[1]) {
      ctx.beginPath(); ctx.arc(ax, ay, view.sx * 0.35, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    const a = Math.atan2(by - ay, bx - ax), head = Math.max(8, view.sx * 0.28);
    ctx.setLineDash(dashed ? [head * 0.6, head * 0.4] : []);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx - Math.cos(a) * head * 0.8, by - Math.sin(a) * head * 0.8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - head * Math.cos(a - 0.45), by - head * Math.sin(a - 0.45));
    ctx.lineTo(bx - head * Math.cos(a + 0.45), by - head * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill();
  }

  // "under": areas, paths and arrows (units and badges draw over them); "over": the tappable markers
  function drawOverlays(layer) {
    for (const o of overlays) {
      const marker = MARKER_KINDS.has(o.kind);
      if ((layer === "over") !== marker) continue;
      const colour = o.colour || KIND_COLOURS[o.kind] || "#ffd65a";
      const cells = overlayCells(o).filter((c) => inside(c.x, c.y));
      if (o.kind === "heat") {
        for (const c of cells) {
          diamond(c.x, c.y);
          ctx.globalAlpha = clamp(c.v ?? 1, 0, 1) * 0.6;
          ctx.fillStyle = colour;
          ctx.fill();
          ctx.globalAlpha = 1;
          if (c.label) { const [cx, cy] = centre(c.x, c.y); pill(c.label, cx, cy, colour); }
        }
      } else if (o.kind === "ring") {
        for (const c of cells) {
          diamond(c.x, c.y, 0.06);
          ctx.strokeStyle = colour;
          ctx.lineWidth = 2.5;
          ctx.stroke();
          const label = c.label || o.label;
          if (label) { const [cx, cy] = centre(c.x, c.y); pill(label, cx, cy - sy() * 1.2, colour); }
        }
      } else if (o.kind === "path") {
        const pts = cells.map((c) => centre(c.x, c.y));
        if (pts.length < 2) continue;
        const lw = Math.max(3, view.sx * 0.1);
        ctx.strokeStyle = colour;
        ctx.lineWidth = lw;
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.setLineDash([lw * 2, lw * 1.2]);
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineJoin = "miter"; ctx.lineCap = "butt";
        const e = pts[pts.length - 1];
        ctx.beginPath(); ctx.arc(e[0], e[1], Math.max(5, view.sx * 0.16), 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill();
        if (o.label) pill(o.label, e[0], e[1] - sy() * 1.4, colour);
      } else if (o.kind === "arrow") {
        const f = asXY(o.from), t = asXY(o.to);
        if (f && t && inside(f[0], f[1]) && inside(t[0], t[1])) {
          arrow(f, t, colour, !!o.dashed, Math.max(3, view.sx * 0.08));
          if (o.label) { const [cx, cy] = centre(t[0], t[1]); pill(o.label, cx, cy - sy() * 1.4, colour); }
        }
      } else if (marker) {
        const r = markerRadius(o.kind);
        const sprite = !o.colour && MARKER_ART[o.kind];
        for (const c of cells) {
          const [cx, cy] = centre(c.x, c.y);
          const label = c.label || o.label;
          // retail's target sprites where the art has them; drawn shapes otherwise
          if (sprite && drawOnTile(sprite, c.x, c.y, MARKER_SCALE)) {
            if (label) pill(label, cx, cy - r - 10, colour);
            continue;
          }
          diamond(c.x, c.y, 0.04);
          ctx.globalAlpha = 0.2; ctx.fillStyle = colour; ctx.fill(); ctx.globalAlpha = 1;
          ctx.lineWidth = 3;
          if (o.kind === "move") {
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = colour; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
            ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 2; ctx.stroke();
          } else {
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(10,12,18,0.35)"; ctx.fill();
            ctx.strokeStyle = colour; ctx.stroke();
            if (o.kind === "attack" || o.kind === "kill") {
              const q = r * 0.55;
              if (o.kind === "kill") { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1; ctx.lineWidth = 4; ctx.stroke(); }
              ctx.beginPath();
              ctx.moveTo(cx - q, cy - q); ctx.lineTo(cx + q, cy + q);
              ctx.moveTo(cx + q, cy - q); ctx.lineTo(cx - q, cy + q);
              ctx.stroke();
            } else if (o.kind === "disembark") {
              ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill();
              ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
            } else {
              ctx.beginPath(); ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2); ctx.stroke();
            }
          }
          if (label) pill(label, cx, cy - r - 10, colour);
        }
      }
    }
  }

  // ---------- picking ----------
  function markerAt(px, py) {
    let best = null, bd = Infinity;
    for (const o of overlays) {
      if (!MARKER_KINDS.has(o.kind)) continue;
      for (const c of overlayCells(o)) {
        if (!inside(c.x, c.y)) continue;
        const [cx, cy] = centre(c.x, c.y);
        const d = Math.hypot(px - cx, py - cy);
        if (d < Math.max(MARKER_HIT, markerRadius(o.kind)) && d < bd) { bd = d; best = [c.x, c.y]; }
      }
    }
    return best;
  }

  // whether a unit standing on its tile is drawn over a point: the solid pixels of its sprite, placed as drawUnit places
  // it (aboard a boat: smaller and raised, over the boat); without the art, an oval about its body
  function unitCovers(u, px, py) {
    const ua = unitArt(u);
    if (ua && artImage(ua.own).state === "ok") {
      const flip = facesLeft(u);
      if (!ua.boat) return artCovers(ua.own, u.x, u.y, px, py, flip);
      return artCovers(ua.own, u.x, u.y, px, py, flip, 0.8, view.sx * 0.28) || artCovers(ua.boat, u.x, u.y, px, py, flip);
    }
    const [cx, cy] = centre(u.x, u.y);
    const ex = (px - cx) / (view.sx * 0.4), ey = (py - (cy - view.sx * 0.5)) / (view.sx * 0.5);
    return ex * ex + ey * ey <= 1;
  }

  // the tiles in front of a tile whose art can stand up over it (how many tiles nearer in x and in y), front-most first:
  // the three it touches, and for a tower or a monument the three beyond those
  const IN_FRONT = [[2, 2], [2, 1], [1, 2], [1, 1], [1, 0], [0, 1]];
  const PICK_CORE = 0.3; // this near its centre (0 the centre, 1 the edge) a tile is itself whatever stands in front

  // The tile a point on the board means: the nearest target marker if one is close; else the tile whose diamond
  // contains the point, unless a unit or what stands on a tile in front of it (trees, a building) is drawn over the
  // point: then that tile. Only the sprite's own solid pixels count, so the ground seen beside a tree or over a unit's
  // shoulder is still the tile behind. A mountain is ground, not something standing on it: retail takes the tile from
  // the diamond alone (ClientInteraction.TileAtScreenPosition), so a peak takes no tap from the tiles behind it.
  function pickAt(px, py) {
    const m = markerAt(px, py);
    if (m) return { xy: m, marker: true };
    const flat = flatTileUnder(px, py);
    const [fx, fy] = centre(flat[0], flat[1]);
    if (Math.abs(px - fx) / view.sx + Math.abs(py - fy) / sy() > PICK_CORE) {
      for (const [dx, dy] of IN_FRONT) {
        const x = flat[0] - dx, y = flat[1] - dy;
        const t = tileAtXY(x, y);
        if (!t || !t.known || fogged(t)) continue;
        const u = pos.units.find((q) => q.x === x && q.y === y);
        const stands = (artTileLayers(t) || []).slice(TERRAIN_ART[t.terrain] === "mountain" ? 1 : 0); // less the mountain itself
        if ((u && unitCovers(u, px, py)) || stands.some((a) => artCovers(a, x, y, px, py))) return { xy: [x, y], marker: false };
      }
    }
    return inside(flat[0], flat[1]) ? { xy: flat, marker: false } : null;
  }

  function infoFor(xy, px, py, e) {
    const r = canvas.getBoundingClientRect();
    const t = tileAtXY(xy[0], xy[1]);
    return {
      xy, x: xy[0], y: xy[1], tile: t?.raw || null,
      cloud: !!fogArt() && (!t || !t.known || fogged(t)), // drawn as a cloud: the caller shows nothing of it
      unit: pos.units.find((u) => u.x === xy[0] && u.y === xy[1]) || null,
      clientX: r.left + px, clientY: r.top + py, pointerType: e ? e.pointerType : "",
    };
  }

  // ---------- gestures ----------
  const ptrs = new Map(); // pointerId -> {x, y} in canvas px
  let g = null; // {mode: "pending" | "pan" | "pinch" | "done", ...}
  let longTimer = 0;
  let samples = []; // recent {t, x, y} of the panning finger, for the throw

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mid = () => {
    const p = [...ptrs.values()];
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1 };
  };

  // a mouse resting on a tile: after hoverMs the caller hears of it (the damage forecast), and again, with null,
  // when the pointer leaves the tile or presses
  let hoverXY = null, hoverTimer = 0, hoverShown = false;
  function clearHover() {
    clearTimeout(hoverTimer);
    hoverXY = null;
    if (hoverShown) {
      hoverShown = false;
      if (opts.onHover) opts.onHover(null, { dwell: hoverMs });
    }
  }
  function onHoverMove(e) {
    if (!opts.onHover) return;
    const p = local(e);
    const pk = pickAt(p.x, p.y);
    const xy = pk ? pk.xy : null;
    if (hoverXY && xy && hoverXY[0] === xy[0] && hoverXY[1] === xy[1]) return;
    clearHover();
    if (!xy) return;
    hoverXY = xy;
    hoverTimer = setTimeout(() => {
      hoverShown = true;
      opts.onHover(infoFor(xy, p.x, p.y, e), { dwell: hoverMs });
    }, hoverMs);
  }

  function onDown(e) {
    clearHover();
    if (e.pointerType === "mouse" && e.button === 1) {
      // the middle button drags the map and never taps
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
      cancelMotion();
      const p = local(e);
      ptrs.set(e.pointerId, p);
      g = { mode: "pan", last: p };
      samples = [{ t: performance.now(), x: p.x, y: p.y }];
      e.preventDefault();
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no live pointer */ }
    cancelMotion();
    const p = local(e);
    ptrs.set(e.pointerId, p);
    clearTimeout(longTimer);
    if (ptrs.size === 1) {
      pressCloud(p.x, p.y);
      g = { mode: "pending", start: p, t0: performance.now(), last: p, e };
      samples = [{ t: g.t0, x: p.x, y: p.y }];
      longTimer = setTimeout(() => {
        if (!g || g.mode !== "pending") return;
        g.mode = "done";
        const pk = pickAt(g.start.x, g.start.y);
        if (pk && opts.onLongPress) {
          if (navigator.vibrate) try { navigator.vibrate(12); } catch (err) { /* not allowed */ }
          opts.onLongPress(infoFor(pk.xy, g.start.x, g.start.y, g.e));
        }
      }, longPressMs);
    } else if (ptrs.size === 2) {
      const m = mid();
      g = { mode: "pinch", m0: m, sx0: view.sx, ox0: view.ox, oy0: view.oy };
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (e.pointerType === "mouse" && !ptrs.has(e.pointerId)) {
      onHoverMove(e);
      return;
    }
    if (!ptrs.has(e.pointerId) || !g) return;
    const p = local(e);
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, p);
    if (g.mode === "pending") {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) <= TAP_SLOP) return;
      clearTimeout(longTimer);
      g.mode = "pan";
      g.last = g.start; // the slop is part of the drag, so the board does not jump
    }
    if (g.mode === "pan") {
      if (feel.elastic) {
        const b = bounds();
        if (!g.raw) g.raw = { x: unrubber(view.ox, b.x0, b.x1), y: unrubber(view.oy, b.y0, b.y1) };
        g.raw.x += p.x - g.last.x;
        g.raw.y += p.y - g.last.y;
        view.ox = rubber(g.raw.x, b.x0, b.x1);
        view.oy = rubber(g.raw.y, b.y0, b.y1);
      } else {
        view.ox += p.x - g.last.x;
        view.oy += p.y - g.last.y;
        clampView();
      }
      g.last = p;
      touched = true;
      const t = performance.now();
      samples.push({ t, x: p.x, y: p.y });
      while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
      invalidate();
    } else if (g.mode === "pinch" && ptrs.size >= 2) {
      const m = mid();
      const sx = clamp(g.sx0 * (m.d / g.m0.d), minSx(), maxSx());
      const k = sx / g.sx0;
      view.sx = sx;
      view.ox = m.x - (g.m0.x - g.ox0) * k;
      view.oy = m.y - (g.m0.y - g.oy0) * k;
      touched = true;
      clampView();
      invalidate();
    }
    e.preventDefault();
  }

  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e);
    ptrs.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    clearTimeout(longTimer);
    if (!ptrs.size) releaseCloud();
    if (!g) return;
    if (g.mode === "pending" && e.type === "pointerup") {
      const dt = performance.now() - g.t0;
      if (dt < tapMs && Math.hypot(p.x - g.start.x, p.y - g.start.y) <= TAP_SLOP) tap(p, e);
      g = null;
    } else if (g.mode === "pan") {
      const t = performance.now();
      const a = samples[0], b = samples[samples.length - 1];
      if (springBack()) {
        // pulled past the edge: no throw, it eases back
      } else if (e.type === "pointerup" && samples.length > 1 && b && t - b.t < 60 && b.t > a.t) {
        const vx = (b.x - a.x) / (b.t - a.t), vy = (b.y - a.y) / (b.t - a.t);
        if (Math.hypot(vx, vy) > 0.05) {
          momentum = { vx, vy, t };
          invalidate();
        }
      }
      g = null;
    } else if (g.mode === "pinch") {
      if (ptrs.size === 1) {
        // one finger stays down: carry on panning with it, no tap
        const rest = [...ptrs.values()][0];
        g = { mode: "pan", last: rest };
        samples = [{ t: performance.now(), x: rest.x, y: rest.y }];
      } else g = null;
    } else if (ptrs.size === 0) g = null;
    if (ptrs.size === 0 && g && g.mode === "done") g = null;
  }

  function onCancel(e) {
    ptrs.delete(e.pointerId);
    clearTimeout(longTimer);
    if (!ptrs.size) {
      releaseCloud();
      g = null;
      if (!anim) springBack();
    }
  }

  // an elastic drag that let go past the edge eases back inside; true when it had to
  function springBack() {
    if (!feel.elastic) return false;
    const to = clampTarget({ sx: view.sx, ox: view.ox, oy: view.oy });
    if (Math.abs(to.ox - view.ox) < 0.5 && Math.abs(to.oy - view.oy) < 0.5) return false;
    stats.springs++;
    animateTo(to, 340);
    return true;
  }

  function tap(p, e) {
    const pk = pickAt(p.x, p.y);
    if (!pk) {
      // off the map: the background round it
      if (opts.onTapOutside) opts.onTapOutside();
      return;
    }
    // too small to hit a tile reliably: zoom in on the spot rather than guess (a target marker is always hittable)
    if (!pk.marker && minTapScale && view.sx < minTapScale * 0.98) {
      const sx = minTapScale, k = sx / view.sx;
      touched = true;
      animateTo(clampTarget({ sx, ox: p.x - (p.x - view.ox) * k, oy: p.y - (p.y - view.oy) * k }), 220);
      return;
    }
    if (opts.onTap) opts.onTap(infoFor(pk.xy, p.x, p.y, e));
  }

  function clampTarget(to) {
    const keep = { sx: view.sx, ox: view.ox, oy: view.oy };
    Object.assign(view, to);
    clampView();
    const out = { sx: view.sx, ox: view.ox, oy: view.oy };
    Object.assign(view, keep);
    return out;
  }

  function onWheel(e) {
    e.preventDefault();
    const glide = zoomGlide;
    cancelMotion();
    const p = local(e);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015) * (e.deltaMode === 1 ? 16 : 1));
    if (feel.smoothZoom) {
      // each notch moves the target; the frames glide the scale to it around the pointer
      zoomGlide = { sx: clamp((glide ? glide.sx : view.sx) * factor, minSx(), maxSx()), px: p.x, py: p.y, t: performance.now() };
      touched = true;
      invalidate();
      return;
    }
    zoomAround(p.x, p.y, view.sx * factor);
    touched = true;
    clampView();
    invalidate();
  }

  function onContextMenu(e) {
    e.preventDefault(); // a touch long press (and a mouse right click) is the long press, not the browser menu
    if (e.pointerType === "touch" || !e.isTrusted || e.button !== 2) return;
    const p = local(e);
    const pk = pickAt(p.x, p.y);
    if (pk && opts.onLongPress) opts.onLongPress(infoFor(pk.xy, p.x, p.y, e));
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("lostpointercapture", onCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("pointerleave", clearHover);
  const onImage = () => invalidate();
  listeners.add(onImage);
  let ro = null;
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);

  // ---------- the API ----------
  const board = {
    canvas,
    // pos: a position, or a view's `position`. fogFor: a player id; tiles that player has not explored are dark.
    setPosition(position, o = {}) {
      const before = pos.n;
      pos = normalise(position);
      overrides.clear(); // a new position is the truth: units are drawn on their tiles again
      // a unit the engine has turned left or right faces that way; a step straight up or down the screen keeps its facing
      for (const u of pos.units) {
        const d = u.direction;
        if (d == null) continue;
        const was = seenDir.get(u.id);
        if (was != null && was !== d) {
          if (d % 4 !== 0) flips.delete(u.id);
          else if (!flips.has(u.id)) flips.set(u.id, !!DIR_LEFT[was % 8]);
        }
        seenDir.set(u.id, d);
      }
      fogFor = o.fogFor == null ? null : o.fogFor;
      if (pos.n !== before) {
        computeFit();
        if (!touched || !before) applyFit();
        else clampView();
        selected = null;
      }
      invalidate();
    },
    setOverlays(list) {
      overlays = Array.isArray(list) ? list : [];
      glows = new Map();
      for (const o of overlays) {
        if (o.kind !== "glow") continue;
        for (const c of overlayCells(o)) glows.set(`${c.x},${c.y}`, { colour: o.colour || GLOW_COLOUR, v: clamp(c.v ?? 1, 0, 1) });
      }
      invalidate();
    },
    select(xy) {
      selected = xy ? asXY(xy) : null;
      invalidate();
    },
    centreOn(xy, o = {}) {
      const a = asXY(xy);
      if (!a) return Promise.resolve();
      const sx = clamp(o.scale ?? view.sx, minSx(), maxSx());
      // the tile centre is at (ox + (i - j) * sx, oy + ((i + j) * SLOPE + SLOPE) * sx): put it mid-screen
      const i = pos.n - 1 - a[1], j = pos.n - 1 - a[0];
      touched = true;
      const midY = (insets.top + cssH - insets.bottom) / 2;
      return animateTo(clampTarget({ sx, ox: cssW / 2 - (i - j) * sx, oy: midY - ((i + j) * SLOPE + SLOPE) * sx }), o.animate === false ? 0 : o.ms ?? 300);
    },
    // the part of the canvas under a bar or sheet, so that centreOn and reveal aim at the visible part
    setInsets(v = {}) {
      insets = { top: Math.max(0, v.top || 0), bottom: Math.max(0, v.bottom || 0) };
    },
    // move the view by the least that brings the tile (and the given margin around it) into the visible part
    reveal(xy, o = {}) {
      const a = asXY(xy);
      if (!a) return Promise.resolve();
      const m = o.margin ?? view.sx * 1.2;
      const [cx, cy] = centre(a[0], a[1]);
      let dx = 0, dy = 0;
      const top = insets.top + m * 1.2, bottom = cssH - insets.bottom - m * 0.6;
      if (cx < m) dx = m - cx; else if (cx > cssW - m) dx = cssW - m - cx;
      if (cy < top) dy = top - cy; else if (cy > bottom) dy = bottom - cy;
      if (!dx && !dy) return Promise.resolve();
      touched = true;
      return animateTo(clampTarget({ ox: view.ox + dx, oy: view.oy + dy }), o.animate === false ? 0 : o.ms ?? 220);
    },
    panBy(dx, dy, o = {}) {
      touched = true;
      return animateTo(clampTarget({ ox: view.ox + dx, oy: view.oy + dy }), o.animate ? o.ms ?? 160 : 0);
    },
    // the extracted game art ({manifest, base, version}) or null for the stamps
    setArt(a) {
      art = a || null;
      invalidate();
    },
    // the game's text drawer (game/ui/text.js) for the words the board draws, or null for the canvas's own text
    setText(t) {
      textDrawer = t || null;
      invalidate();
    },
    effects,
    fit(o = {}) {
      computeFit();
      touched = false;
      return animateTo(fitTarget(), o.animate ? o.ms ?? 300 : 0);
    },
    zoomBy(factor, o = {}) {
      const px = o.x ?? cssW / 2, py = o.y ?? cssH / 2;
      const sx = clamp(view.sx * factor, minSx(), maxSx()), k = sx / view.sx;
      touched = true;
      return animateTo(clampTarget({ sx, ox: px - (px - view.ox) * k, oy: py - (py - view.oy) * k }), o.animate === false ? 0 : o.ms ?? 200);
    },
    // end a view animation at once, at its target (the replay's Skip)
    finishCamera() {
      if (!anim) return;
      const a = anim;
      anim = null;
      Object.assign(view, a.to);
      clampView();
      invalidate();
      if (a.resolve) a.resolve();
    },
    resize,
    getView,
    setView,
    // the tile under a client point, or null: what a tap there would pick
    tileAt(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const pk = pickAt(clientX - r.left, clientY - r.top);
      return pk ? pk.xy : null;
    },
    // The art of a tile (its terrain with the city, building or resource on it), or with `o.unit` (a unit id) that unit's,
    // drawn into another canvas context fitted into an `o.size` box centred on (`o.cx`, `o.cy`): game mode's selection
    // bar shows it as retail's SpriteDuplicator copies the selected thing's sprites. Returns true when drawn, null while
    // an image is still loading, false when there is no art for it (no art at all, a dark tile, no such unit).
    drawPortrait(target, xy, o = {}) {
      const a = asXY(xy);
      const t = a && tileAtXY(a[0], a[1]);
      if (!art || !t || fogged(t)) return false;
      let parts;
      if (o.unit != null) {
        const u = pos.units.find((v) => v.id === o.unit);
        const ua = u && unitArt(u);
        if (!ua) return false;
        // a land unit at sea rides the boat, smaller and lifted, as drawUnit draws it
        parts = ua.boat ? [{ a: ua.boat, s: 1, dy: 0 }, { a: ua.own, s: 0.8, dy: -0.28 / ART_PER_SX }] : [{ a: ua.own, s: 1, dy: 0 }];
      } else {
        const layers = artTileLayers(t);
        if (!layers) return false;
        parts = layers.map((l) => ({ a: l, s: 1, dy: 0 }));
      }
      const imgs = parts.map((p) => artImage(p.a));
      if (imgs.some((e) => e.state === "failed")) return false;
      if (imgs.some((e) => e.state !== "ok")) return null;
      // fitted to the drawn pixels, not the sprite's box: a unit's sprite has much empty room round it
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      parts.forEach((p, i) => {
        const b = opaqueBox(imgs[i].img, p.a.w, p.a.h);
        x0 = Math.min(x0, (b[0] - p.a.anchor[0]) * p.s); x1 = Math.max(x1, (b[2] - p.a.anchor[0]) * p.s);
        y0 = Math.min(y0, (b[1] - p.a.anchor[1]) * p.s + p.dy); y1 = Math.max(y1, (b[3] - p.a.anchor[1]) * p.s + p.dy);
      });
      const k = (o.size || 64) / Math.max(1, x1 - x0, y1 - y0);
      const ox = (o.cx || 0) - ((x0 + x1) / 2) * k, oy = (o.cy || 0) - ((y0 + y1) / 2) * k;
      parts.forEach((p, i) => {
        target.drawImage(partImage(p.a, imgs[i]), ox - p.a.anchor[0] * p.s * k, oy + (p.dy - p.a.anchor[1] * p.s) * k, p.a.w * p.s * k, p.a.h * p.s * k);
      });
      return true;
    },
    // client coordinates of a tile's centre
    screenOf(xy) {
      const a = asXY(xy);
      const r = canvas.getBoundingClientRect();
      const [cx, cy] = centre(a[0], a[1]);
      return { x: r.left + cx, y: r.top + cy };
    },
    get size() { return pos.n; },
    // what the board shows now, as plain data (tests compare it with the server's position): units, and per tile the owner,
    // city level, improvement and resource
    get shown() {
      return {
        units: pos.units.map((u) => ({ id: u.id, x: u.x, y: u.y, type: u.type, owner: u.owner, health: u.health, left: facesLeft(u) })),
        tiles: pos.tiles.filter(Boolean).map((t) => [t.x, t.y, t.owner, t.city ? t.level : 0, t.improvement, t.resource]),
        dark: pos.tiles.filter(Boolean).filter((t) => fogged(t)).map((t) => [t.x, t.y]),
      };
    },
    get idle() { return !anim && !momentum && !zoomGlide && !dirty && !frame; },
    // camera feel: {elastic, smoothZoom} (both off by default); returns the current settings
    setFeel(f = {}) {
      if (f.elastic != null) feel.elastic = !!f.elastic;
      if (f.smoothZoom != null) feel.smoothZoom = !!f.smoothZoom;
      return { ...feel };
    },
    get feel() { return { ...feel }; },
    get stats() { return { ...stats, clouds: { ...stats.clouds }, images: images.size, pending: queue.length + inFlight }; },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      clearTimeout(longTimer);
      clearTimeout(fireTimer);
      listeners.delete(onImage);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      for (const [ev, fn] of [["pointerdown", onDown], ["pointermove", onMove], ["pointerup", onUp], ["pointercancel", onCancel], ["lostpointercapture", onCancel], ["wheel", onWheel], ["contextmenu", onContextMenu]]) canvas.removeEventListener(ev, fn);
      if (canvas.__board === board) delete canvas.__board;
    },
  };
  canvas.__board = board; // lets the phone harness (ui/testing.js) find the board behind a canvas
  resize();
  return board;
}

export default createBoard;
