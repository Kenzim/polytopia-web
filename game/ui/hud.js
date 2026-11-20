// The match screen's HUD in game mode, drawn on a canvas over the board the way the retail client lays it out (the
// HudScreen, ResourceBar, HudGradients and CenterNotification prefabs, dumped by tools/extract_assets/uiprefabs.py):
//
// - a dark fade at the top and bottom of the screen;
// - the resource bar: Score, Stars with the income, Turn, centred at the top (JosefinSans-Italic headers over
//   Roboto-Light_Numbers amounts);
// - the button bar: round buttons (black at 80 %, a white ring, the retail icon, a label under it), blue when active,
//   with a red badge;
// - banners (a pill under the bar, or the centre card for "Your turn"), notices, and the floaters that carry a
//   score or star gain from a tile to its counter, which then counts up (retail WorldScore "+Np", MoveToResourceBar).
//
// game.js owns the state and passes it in with `update`; taps on drawn buttons call `onAction(id)`. `stats` lists what
// was drawn (with client rects) so tests can find and tap it.
//
// Units ("u"): CSS px on the phone the sizes were first measured on (Kenzi's screenshots, 2026-10-23), which draws
// retail's canvas at REF_SCALE CSS px per canvas unit, so a retail size R is about 0.86 R here. `k` is retail's own
// canvas scale for this screen divided by REF_SCALE: 1 on that phone, and the HUD's size on any screen is retail's.

// UICanvasScalerHelper.CalculateUIScale with UICanvasScaleData: the screen's shorter side in inches picks a size
// factor (the last limit it reaches), and a canvas unit is factor / 221 of an inch.
const SCALE_LIMITS = [[10, 2.5], [5, 2], [2.4, 1.3], [0, 1]];
const REF_SCALE = 0.86;

export function retailScale(w, h, coarse) {
  const short = Math.min(w, h);
  // CSS px per inch: 96 on a desktop by definition; phones and tablets have fewer, larger CSS px (146 puts the
  // reference phone at its measured 0.86; 132 is an iPad's)
  const ppi = !coarse ? 96 : short < 600 ? 146 : 132;
  const factor = SCALE_LIMITS.find(([limit]) => short / ppi >= limit)[1];
  return (factor * ppi) / 221;
}

export function createHud({ wrap, kit, layersMod, selbarMod, portrait = () => false, anchorOf = () => null, manifest, artBase = "/art/", text, fonts, onAction, onResize = () => {}, onScreen = () => {}, play = () => {}, reduced = () => false }) {
  const { COLOURS, ease, roundRect, createHits } = kit;
  const art = kit.createKit(manifest, artBase);
  const canvas = document.createElement("canvas");
  canvas.className = "g-hud";
  canvas.id = "g-hud";
  canvas.setAttribute("aria-hidden", "true");
  wrap.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const hits = createHits();
  const now = () => performance.now();

  let W = 0, H = 0, dpr = 1, k = 1;
  let safe = { top: 0, right: 0, bottom: 0, left: 0 };
  let frame = 0, destroyed = false;
  let pressed = null, hover = null;
  // the screens and popups (ui/layers.js), drawn over the HUD
  const layers = layersMod ? layersMod.createLayers({
    kit, text, fonts, art, hits, ctx,
    size: () => ({ W, H, safe, k }),
    invalidate: () => invalidate(),
    // the top bar drawn again (not tappable) by a screen that covers it, as retail's TechView keeps it over the tree
    bar: () => { if (state.visible) resourceBar(now(), false); },
    reduced,
    play,
  }) : null;
  // the selection bar (ui/selbar.js): retail's InteractionBar, in place of the button bar while something is selected;
  // with a mouse its buttons go round the selected tile, as on retail's PC version
  const RING_ON_TOUCH = true; // temporary (Kenzi, 2026-11-19): touch screens get the PC layout too; false puts the phone layout back
  const mouse = () => RING_ON_TOUCH || !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const selbar = layers && selbarMod ? selbarMod.createSelBar({
    g: layers.g, size: () => ({ W, H, safe, k }), portrait, reduced,
    pressedId: () => (pressed && !pressed.dragging ? pressed.el.id : null),
    ring: mouse,
    // where the button bar starts (canvas px, with room for its first label), or null when it is not shown
    barLeft: () => {
      const n = state.bottom ? state.buttons.filter((b) => !b.hidden).length : 0;
      return n ? (W - n * u(56) - (n - 1) * u(26)) / 2 - u(16) : null;
    },
    anchor: (xy) => {
      const p = anchorOf(xy);
      if (!p) return null;
      const r = canvas.getBoundingClientRect();
      return { x: p.x - r.left, y: p.y - r.top };
    },
  }) : null;
  const selected = () => !!selbar && !!selbar.spec;
  const compact = () => selected() && selbar.compact; // retail's PC layout while something is selected

  let state = {
    visible: false, mode: "play", // play | watch; drawn from the first update that sets a mode
    score: 0, stars: 0, income: 0, turn: 1, limit: 0, lastTurn: false, who: null,
    buttons: [], tools: [], bottom: true,
  };
  const target = { score: null, stars: null }; // null until game.js first gives the numbers: no count up from 0 on load
  const shown = { score: null, stars: null };
  const held = { score: 0, stars: 0 };
  const tween = { score: null, stars: null };
  const pulse = { score: -1e9, stars: -1e9 };
  const counters = {}; // kind -> {cx, cy, w, h}: where the amount was drawn last
  const floaters = [];
  const notices = [];
  let banner = null;
  const stats = {
    draws: 0, elements: [], counters: {}, banner: null, notices: [], k: 1,
    floaters: { started: 0, arrived: 0, live: [], log: [] }, texts: 0,
  };

  // ---------- size ----------
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;"
    + "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.appendChild(probe);
  function resize() {
    const r = wrap.getBoundingClientRect();
    const cs = getComputedStyle(probe);
    safe = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    k = retailScale(W, H, coarse) / REF_SCALE;
    // a short landscape window keeps room for the board; the four bottom buttons with their labels (about 330 u)
    // must fit the width
    k = Math.max(0.75, Math.min(k, H / 700));
    k = Math.min(k, (W - safe.left - safe.right - 12) / 360);
    stats.k = k;
    invalidate();
    onResize();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  // ---------- drawing helpers ----------
  const u = (v) => v * k;
  function label(str, x, y, o) {
    stats.texts++;
    return text.draw(ctx, str, x, y, { font: fonts.label, colour: "#fff", ...o, size: u(o.size || 16), maxWidth: o.maxWidth ? u(o.maxWidth) : undefined, minSize: o.minSize ? u(o.minSize) : undefined });
  }
  const measure = (str, o) => text.measure(str, { font: fonts.label, ...o, size: u(o.size || 16) });

  // retail's fades behind the top and bottom bars: fully black at the screen's edge, clear about 100 canvas units in,
  // linear (measured on the reference rig at 1280 x 800 and 1920 x 1080)
  function gradients() {
    const top = u(100 * REF_SCALE) + safe.top;
    let g = ctx.createLinearGradient(0, 0, 0, top);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, top);
    if (!state.bottom || (selected() && !compact())) return;
    const bot = u(100 * REF_SCALE) + safe.bottom;
    g = ctx.createLinearGradient(0, H - bot, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = g;
    ctx.fillRect(0, H - bot, W, bot);
  }

  // ---------- the resource bar ----------
  function counterValue(kind, t) {
    if (target[kind] == null) return 0;
    const want = held[kind] > 0 ? Math.max(shown[kind] ?? target[kind], target[kind] - held[kind]) : target[kind];
    if (shown[kind] == null) { shown[kind] = want; return want; }
    const tw = tween[kind];
    if (!tw || tw.to !== want) {
      if (shown[kind] !== want) tween[kind] = { from: shown[kind], to: want, t0: t, ms: Math.min(900, 250 + 25 * Math.abs(want - shown[kind])) };
      else tween[kind] = null;
    }
    const w = tween[kind];
    if (!w) return shown[kind];
    const p = reduced() ? 1 : Math.min(1, (t - w.t0) / w.ms);
    shown[kind] = Math.round(w.from + (w.to - w.from) * ease.out(p));
    if (p >= 1) { shown[kind] = w.to; tween[kind] = null; }
    return shown[kind];
  }

  function resourceBar(t, tappable = true) {
    const top = safe.top;
    // placed as on the retail rig at 1280 x 800 (header cap top 15 canvas units down, amount top 37)
    const headY = top + u(23), amountY = top + u(48);
    const cols = [];
    const num = (s) => ({ str: String(s), font: fonts.numbers, size: 23 });
    if (state.mode === "watch") {
      if (state.who) cols.push({ id: "who", head: "Playing", amount: { str: state.who.name, font: fonts.label, size: 22 }, dot: state.who.colour });
    } else {
      const score = counterValue("score", t), stars = counterValue("stars", t);
      cols.push({ id: "score", head: "Score", amount: num(score.toLocaleString("en-GB")) });
      // retail: the income in the header, "Stars (+4)", and the star icon before the amount
      const inc = state.income;
      cols.push({ id: "stars", head: `Stars (${inc >= 0 ? "+" : "-"}${Math.abs(inc)})`, amount: num(String(stars)), star: true });
    }
    cols.push({ id: "turn", head: "Turn", amount: state.lastTurn ? { str: "Last", font: fonts.label, size: 22 } : num(state.limit ? `${state.turn}/${state.limit}` : `${state.turn}`) });
    // ResourceBar's Top Row: a HorizontalLayoutGroup with 18 units between columns as wide as their text
    const gap = u(18 * REF_SCALE);
    for (const c of cols) {
      const hw = measure(c.head, { size: 14 }).w;
      const aw = measure(c.amount.str, { font: c.amount.font, size: c.amount.size }).w + (c.star ? u(19) : 0) + (c.dot ? u(16) : 0);
      c.w = Math.max(hw, aw);
      c.aw = aw;
    }
    const total = cols.reduce((s, c) => s + c.w, 0) + gap * (cols.length - 1);
    let x = (W - total) / 2;
    for (const c of cols) {
      const cx = x + c.w / 2;
      label(c.head, cx, headY, { size: 14, align: "center", shadow: { dy: 1, colour: "rgba(0,0,0,0.5)" } });
      const p = Math.max(0, 1 - (t - (pulse[c.id] ?? -1e9)) / 320);
      const s = 1 + 0.28 * Math.sin(p * Math.PI);
      ctx.save();
      ctx.translate(cx, amountY - u(9));
      ctx.scale(s, s);
      let ax = -c.aw / 2;
      if (c.star) { art.icon(ctx, ["icon/resource", "icon/staricon", "icon/star"], ax + u(8), 0, u(17)); ax += u(19); }
      if (c.dot) {
        ctx.fillStyle = c.dot;
        ctx.beginPath(); ctx.arc(ax + u(6), -u(1), u(6), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = u(1.5); ctx.stroke();
        ax += u(16);
      }
      label(c.amount.str, ax, u(9), { font: c.amount.font, size: c.amount.size, colour: p > 0 && c.id !== "turn" ? "#ffe9a6" : "#fff", shadow: { dy: 1, colour: "rgba(0,0,0,0.5)" } });
      ctx.restore();
      counters[c.id] = { cx, cy: amountY - u(9), w: c.w, h: u(30), value: c.amount.str, head: c.head };
      if (p > 0) live = true;
      x += c.w + gap;
    }
    if (tappable) hits.add({ id: "bar", label: "Scores", x: (W - total) / 2 - u(8), y: top, w: total + u(16), h: u(70) });
  }

  // ---------- round buttons ----------
  function roundButton(b, cx, cy, d) {
    const isPressed = pressed && pressed.el.id === b.id;
    const s = isPressed ? 0.92 : 1;
    d = Math.max(0, d); // a screen with no room leaves the button no size
    const el = hits.add({ id: b.id, label: b.label, x: cx - d / 2, y: cy - d / 2, w: d, h: d, round: true, slop: u(6), enabled: !b.disabled, active: !!b.active });
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.globalAlpha = b.disabled ? 0.5 : 1;
    ctx.fillStyle = b.active ? COLOURS.buttonActive : COLOURS.buttonBg;
    ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COLOURS.outline;
    ctx.lineWidth = Math.max(1.5, d * 0.045);
    ctx.beginPath(); ctx.arc(0, 0, Math.max(0, d / 2 + u(1) - ctx.lineWidth / 2), 0, Math.PI * 2); ctx.stroke();
    if (b.glyph) {
      glyph(b.glyph, d * 0.36);
    } else if (b.icon && !b.text) {
      const ok = art.icon(ctx, b.icon, 0, 0, d * (b.iconScale || 46 / 66), { alpha: isPressed ? 0.78 : 1 });
      if (!ok) label(b.fallback || b.label.slice(0, 1), 0, 0, { size: 24, align: "center", baseline: "middle" });
    } else if (b.text) {
      label(b.text, 0, 0, { font: fonts.numbers, size: 22, align: "center", baseline: "middle" });
    }
    if (isPressed) { ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (b.label && b.showLabel !== false) {
      label(b.label, cx, cy + d / 2 + u(3.5), { size: 13.5, minSize: 10, maxWidth: 80, align: "center", baseline: "top", alpha: b.disabled ? 0.6 : 1, shadow: { dy: 1, colour: "rgba(0,0,0,0.6)" } });
    }
    if (b.badge) {
      const bx = cx + d / 2 - u(8), by = cy - d / 2 + u(8), r = u(11);
      ctx.fillStyle = COLOURS.badge;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
      label(String(b.badge), bx, by, { font: fonts.body, size: 15, align: "center", baseline: "middle", bold: true });
    }
    if (b.tag) {
      // the Game Stats button's rank over its top right: green when first, blue otherwise (PositionDisplay.UpdateLabel)
      const tw = measure(b.tag, { size: 17 }).w + u(10), th = u(24);
      const tx = cx + d / 2 - u(14), ty = cy - d / 2 - u(10);
      ctx.fillStyle = b.tag === "1st" ? COLOURS.green : COLOURS.blue;
      ctx.fillRect(tx, ty, tw, th);
      label(b.tag, tx + tw / 2, ty + th / 2, { size: 17, align: "center", baseline: "middle" });
    }
    return el;
  }

  // a sign in white, `s` px across, centred on the origin: play, pause, back and fwd (one step), prev and next (a turn),
  // or a function (ctx, s) that draws its own; the retail art has no such icons
  function glyph(name, s) {
    ctx.fillStyle = "#fff";
    if (typeof name === "function") { name(ctx, s); return; }
    const tri = (x, dir, w) => {
      ctx.beginPath();
      if (dir > 0) { ctx.moveTo(x, -s / 2); ctx.lineTo(x + w, 0); ctx.lineTo(x, s / 2); } else { ctx.moveTo(x + w, -s / 2); ctx.lineTo(x, 0); ctx.lineTo(x + w, s / 2); }
      ctx.closePath(); ctx.fill();
    };
    const bar = (x) => ctx.fillRect(x, -s / 2, s * 0.16, s);
    if (name === "play") tri(-s * 0.34, 1, s * 0.82);
    else if (name === "pause") { ctx.fillRect(-s * 0.36, -s / 2, s * 0.26, s); ctx.fillRect(s * 0.1, -s / 2, s * 0.26, s); }
    else if (name === "back") { bar(-s / 2); tri(-s * 0.3, -1, s * 0.75); }
    else if (name === "fwd") { tri(-s * 0.45, 1, s * 0.75); bar(s * 0.34); }
    else if (name === "prev") { bar(-s * 0.6); tri(-s * 0.42, -1, s * 0.5); tri(s * 0.08, -1, s * 0.5); }
    else if (name === "next") { tri(-s * 0.58, 1, s * 0.5); tri(-s * 0.08, 1, s * 0.5); bar(s * 0.44); }
  }

  // ---------- the replay deck (a bot game's replay): where it is, the track to drag, the transport buttons ----------
  // Retail's replay Timeline in short: each player's turn a segment in its tribe's colour, the command played last as a
  // line of text, the playback buttons under it. state.deck: {caption, right, line, final: {text, ok}|null, frac,
  // segments: [{from, to, colour}] (fractions), warnFrom (fraction)|null, buttons: [{id, glyph|text, label, active,
  // disabled, big}], onSeek(frac, done), marks: [{at (fraction), colour}]|null (ticks over the track: the game check's
  // mistakes)}
  const deckH = () => u(128);
  function drawDeck() {
    const dk = state.deck;
    if (!dk) { stats.deck = null; return; }
    const w = Math.min(W - u(20) - safe.left - safe.right, u(460)), h = deckH();
    const x = (W - w) / 2, y = H - safe.bottom - (state.bottom ? u(98) : u(8)) - h;
    ctx.fillStyle = "rgba(0,0,0,0.82)";
    roundRect(ctx, x, y, w, h, u(18)); ctx.fill();
    hits.add({ id: "deck", label: "", x, y, w, h, inert: true });
    const pad = u(16);
    // the caption (the turn and whose it is, the command count), and under it the last command or, at the end, the
    // check against the server
    const cy = y + u(17);
    label(dk.caption || "", x + pad, cy, { size: 15, baseline: "middle", maxWidth: (w * 0.64) / k, minSize: 10 });
    if (dk.right) label(dk.right, x + w - pad, cy, { font: fonts.numbers, size: 15, align: "right", baseline: "middle" });
    const line = dk.final ? dk.final.text : dk.line;
    if (line) label(line, W / 2, y + u(38), { font: fonts.body, size: 13, align: "center", baseline: "middle", maxWidth: (w - 2 * pad) / k, minSize: 8, colour: dk.final ? (dk.final.ok ? "#9cf08a" : "#ff9a7a") : "rgba(255,255,255,0.8)" });
    // the track: the turns in their tribes' colours, bright up to where the replay is; red under it from the divergence
    const tx = x + pad, tw = w - 2 * pad, ty = y + u(60), th = u(7);
    const f = Math.max(0, Math.min(1, dk.frac || 0));
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    roundRect(ctx, tx, ty - th / 2, tw, th, th / 2); ctx.fill();
    for (const sg of dk.segments || []) {
      const sx = tx + tw * sg.from, sw = Math.max(u(1), tw * (sg.to - sg.from) - u(1));
      ctx.globalAlpha = sg.to <= f + 1e-9 ? 1 : sg.from < f ? 0.75 : 0.35;
      ctx.fillStyle = sg.colour || COLOURS.blue;
      ctx.fillRect(sx, ty - th / 2, sw, th);
    }
    ctx.globalAlpha = 1;
    for (const mk of dk.marks || []) {
      ctx.fillStyle = mk.colour || COLOURS.red;
      const mx = tx + tw * Math.max(0, Math.min(1, mk.at));
      roundRect(ctx, mx - u(1.5), ty - th / 2 - u(9), u(3), u(8), u(1.5)); ctx.fill();
    }
    if (dk.warnFrom != null) {
      ctx.fillStyle = COLOURS.red;
      ctx.fillRect(tx + tw * dk.warnFrom, ty + th / 2 + u(2), Math.max(u(2), tw * (1 - dk.warnFrom)), u(3));
      ctx.fillRect(tx + tw * dk.warnFrom - u(1.5), ty - u(9), u(3), u(18));
    }
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(tx + tw * f, ty, u(9), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COLOURS.blue; ctx.lineWidth = u(2); ctx.stroke();
    const track = hits.add({ id: "rp:track", label: "Replay position", x: tx - u(10), y: ty - u(16), w: tw + u(20), h: u(32), track: { x: tx, w: tw } });
    // the transport buttons, centred in a row
    const list = (dk.buttons || []).filter((b) => !b.hidden);
    const dd = u(40), big = u(48), gap = u(12);
    const total = list.reduce((s, b) => s + (b.big ? big : dd), 0) + gap * (list.length - 1);
    let bx = (W - total) / 2;
    const by = y + h - u(34);
    for (const b of list) {
      const d = b.big ? big : dd;
      roundButton({ ...b, showLabel: false }, bx + d / 2, by, d);
      bx += d + gap;
    }
    stats.deck = { caption: dk.caption, right: dk.right, line: dk.line, final: dk.final, frac: f, warnFrom: dk.warnFrom, marks: (dk.marks || []).length, rect: rectOf({ x, y, w, h }), track: rectOf({ x: tx, y: track.y, w: tw, h: track.h }) };
  }
  function seekAt(px, done) {
    const tr = pressed && pressed.el.track;
    if (!tr || !state.deck || !state.deck.onSeek) return;
    state.deck.onSeek(Math.max(0, Math.min(1, (px - tr.x) / tr.w)), done);
  }

  // a red strip under the top bar that stays while it is set (a bot game's replay that no longer matches the server)
  function drawWarn() {
    if (!state.warn || !layers) { stats.warn = null; return; }
    const g = layers.g;
    const w = Math.min(W - u(24), u(520)), pad = u(12);
    const o = { font: fonts.body, size: 14, lineHeight: 18 };
    const hgt = g.paraHeight(state.warn, w - 2 * pad, o) + 2 * pad - u(4);
    const x = (W - w) / 2, y = safe.top + u(116);
    ctx.fillStyle = "rgba(150,24,30,0.92)";
    roundRect(ctx, x, y, w, hgt, u(12)); ctx.fill();
    g.para(state.warn, W / 2, y + pad - u(2), w - 2 * pad, { ...o, align: "center" });
    stats.warn = { text: state.warn, rect: rectOf({ x, y, w, h: hgt }) };
  }

  function buttonBar() {
    const list = state.buttons.filter((b) => !b.hidden);
    if (!list.length) return;
    // retail proportions (Kenzi's phone screenshots, 2026-10-23): about 54 px buttons 80 px apart, centred, low
    const d = u(56), gap = u(26);
    const total = list.length * d + (list.length - 1) * gap;
    const cy = H - safe.bottom - u(82) + d / 2;
    let x = (W - total) / 2 + d / 2;
    for (const b of list) { roundButton(b, x, cy, d); x += d + gap; }
  }

  // smaller round buttons on the right, above the button bar (undo, centre, replay speed)
  function tools() {
    const list = state.tools.filter((b) => !b.hidden);
    const d = u(48);
    let cy = safe.top + u(96) + d / 2;
    const cx = W - safe.right - u(14) - d / 2;
    for (const b of list) { roundButton({ ...b, showLabel: false, iconScale: 0.62 }, cx, cy, d); cy += d + u(12); }
  }

  // ---------- banners and notices ----------
  function drawBanner(t) {
    if (!banner) { stats.banner = null; return; }
    const b = banner;
    const age = t - b.t0;
    if (b.ms && age > b.ms + 260) { banner = null; stats.banner = null; if (b.onEnd) b.onEnd(); return; }
    let a = 1, s = 1;
    if (!reduced()) {
      if (age < 220) { const p = age / 220; a = p; s = 0.85 + 0.15 * ease.outBack(p); }
      if (b.ms && age > b.ms) { a = Math.max(0, 1 - (age - b.ms) / 260); }
      live = true;
    } else if (b.ms) live = true;
    ctx.globalAlpha = a;
    if (b.kind === "turn") {
      // CenterNotification, centred on the screen: a black PopupBg card 336 units wide, padded 30 above and below, a
      // JosefinSans-Thin 34 header and a JosefinSans-Italic 25 message 10 units under it (sizes in retail units)
      const R = REF_SCALE;
      const w = Math.min(u(336 * R), W - u(24));
      const hgt = u((30 + 34 + (b.sub ? 10 + 25 : 0) + 30) * R);
      const x = (W - w) / 2, y = H / 2 - hgt / 2;
      ctx.save();
      ctx.translate(W / 2, y + hgt / 2); ctx.scale(s, s); ctx.translate(-W / 2, -(y + hgt / 2));
      ctx.fillStyle = "#000";
      roundRect(ctx, x, y, w, hgt, u(22 * R)); ctx.fill();
      label(b.text, W / 2, y + u((30 + 17) * R), { font: fonts.thin, size: 34 * R, minSize: 14, maxWidth: 312 * R, align: "center", baseline: "middle" });
      if (b.sub) label(b.sub, W / 2, y + u((30 + 34 + 10 + 12.5) * R), { font: fonts.label, size: 25 * R, minSize: 12, maxWidth: 312 * R, align: "center", baseline: "middle" });
      ctx.restore();
      hits.add({ id: "banner", label: b.text, x, y, w, h: hgt });
      stats.banner = { text: b.text, kind: b.kind, rect: rectOf({ x, y, w, h: hgt }) };
    } else {
      const fs = 18, padX = u(16);
      const tw = Math.min(measure(b.text, { size: fs }).w, W - u(140));
      const w = tw + padX * 2, hgt = u(36);
      const x = (W - w) / 2, y = safe.top + u(74);
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      roundRect(ctx, x, y, w, hgt, hgt / 2); ctx.fill();
      label(b.text, W / 2, y + hgt / 2, { size: fs, align: "center", baseline: "middle", maxWidth: (W - u(140)) / k, minSize: 12 });
      stats.banner = { text: b.text, kind: b.kind, rect: rectOf({ x, y, w, h: hgt }) };
    }
    ctx.globalAlpha = 1;
  }

  function drawNotices(t) {
    stats.notices = [];
    let y = safe.top + (banner && banner.kind !== "turn" ? u(118) : u(78));
    for (let i = notices.length - 1; i >= 0; i--) if (t - notices[i].t0 > notices[i].ms + 260) notices.splice(i, 1);
    for (const n of notices) {
      const age = t - n.t0;
      const a = reduced() ? 1 : Math.min(1, age / 200, Math.max(0, 1 - (age - n.ms) / 260));
      const fs = 17, ic = n.icon ? u(30) : 0;
      const tw = measure(n.text, { size: fs }).w;
      const w = Math.min(W - u(24), tw + ic + u(n.icon ? 28 : 32)), hgt = u(40);
      const x = (W - w) / 2;
      ctx.globalAlpha = a;
      ctx.fillStyle = n.error ? "rgba(150,24,30,0.9)" : "rgba(0,0,0,0.8)";
      roundRect(ctx, x, y, w, hgt, hgt / 2); ctx.fill();
      if (n.icon) art.icon(ctx, n.icon, x + u(8) + ic / 2, y + hgt / 2, ic);
      label(n.text, x + (n.icon ? u(14) + ic : u(16)), y + hgt / 2, { size: fs, baseline: "middle", maxWidth: (w - ic - u(28)) / k, minSize: 11 });
      ctx.globalAlpha = 1;
      stats.notices.push({ text: n.text, error: n.error, rect: rectOf({ x, y, w, h: hgt }) });
      y += hgt + u(8);
      live = true;
    }
  }

  // ---------- floaters: a gain flies from a tile to its counter ----------
  const POP = 260, HOLD = 520, FLY = 620;
  function drawFloaters(t) {
    stats.floaters.live = [];
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const c = counters[f.kind] || { cx: W / 2, cy: safe.top + u(50) };
      const age = t - f.t0;
      if (age < 0) { live = true; continue; }
      if (f.x == null) {
        const r = canvas.getBoundingClientRect();
        const p = typeof f.from === "function" ? f.from() : f.from;
        f.x = (p ? p.x : W / 2) - r.left;
        f.y = (p ? p.y : H / 2) - r.top;
      }
      const total = reduced() ? 0 : POP + HOLD + FLY;
      if (age >= total) {
        floaters.splice(i, 1);
        held[f.kind] = Math.max(0, held[f.kind] - f.amount);
        pulse[f.kind] = t;
        stats.floaters.arrived++;
        stats.floaters.log.push({ kind: f.kind, amount: f.amount, at: [Math.round(c.cx), Math.round(c.cy)] });
        if (stats.floaters.log.length > 50) stats.floaters.log.shift();
        play(f.kind === "stars" ? "coin" : "score");
        f.resolve();
        live = true;
        continue;
      }
      let x = f.x, y = f.y, s = 1, a = 1;
      if (age < POP) s = 0.3 + 0.7 * ease.outBack(age / POP);
      else if (age < POP + HOLD) y = f.y - u(10) * ((age - POP) / HOLD);
      else {
        const p = ease.inOut((age - POP - HOLD) / FLY);
        const sx = f.x, sy = f.y - u(10);
        // a slight arc on the way up
        x = sx + (c.cx - sx) * p + Math.sin(p * Math.PI) * u(24) * (sx < c.cx ? -1 : 1);
        y = sy + (c.cy - sy) * p;
        s = 1 - 0.45 * p;
        a = p > 0.85 ? 1 - (p - 0.85) / 0.15 * 0.6 : 1;
      }
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(x, y);
      ctx.scale(s, s);
      const str = f.kind === "stars" ? `+${f.amount}` : `+${f.amount}p`;
      const o = { size: 30, baseline: "middle", outline: { colour: "rgba(0,0,0,0.85)", width: u(2) }, colour: f.kind === "stars" ? "#ffe066" : "#ffffff" };
      if (f.kind === "stars") {
        const tw = measure(str, { size: 30 }).w;
        const ic = u(30);
        const left = -(tw + ic + u(4)) / 2;
        art.icon(ctx, ["icon/stariconbig", "icon/staricon", "icon/star"], left + ic / 2, 0, ic);
        label(str, left + ic + u(4), 0, o);
      } else label(str, 0, 0, { ...o, align: "center" });
      ctx.restore();
      stats.floaters.live.push({ kind: f.kind, amount: f.amount, x: Math.round(x), y: Math.round(y) });
      live = true;
    }
  }

  // ---------- the frame ----------
  let live = false;
  let covered = false; // a full screen is open: `onScreen` hears of each change, for what the page lays over the canvas
  function draw() {
    frame = 0;
    if (destroyed) return;
    const t = now();
    live = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.__dpr = dpr;
    ctx.clearRect(0, 0, W, H);
    hits.clear();
    stats.texts = 0;
    // a full screen (settings, stats) hides the button bar and the tools, as retail's screens do; the top bar stays, dimmed
    const screen = !!layers && layers.list.some((L) => L.kind === "screen");
    if (screen !== covered) { covered = screen; onScreen(screen); }
    if (state.visible) {
      gradients();
      if (state.top !== false) resourceBar(t); // false: the page's panel shows the turn and the player to move itself
      if (selected() && !screen) { if (selbar.draw(t)) live = true; } else if (selbar) selbar.stats.key = null;
      if (state.bottom && !screen && (!selected() || compact())) buttonBar();
      if (!screen && !selected()) drawDeck(); else stats.deck = null;
      if (!screen) tools();
      drawBanner(t);
      if (!screen) drawWarn(); else stats.warn = null;
    }
    if (layers && layers.draw(t)) live = true;
    if (state.visible) drawNotices(t);
    drawFloaters(t);
    if (tween.score || tween.stars) live = true;
    stats.draws++;
    // what can be tapped now: nothing under the top layer's scrim
    let lastScrim = -1;
    hits.list.forEach((e, i) => { if (e.scrim) lastScrim = i; });
    stats.elements = hits.list.filter((e, i) => !e.scrim && !e.inert && i > lastScrim).map((e) => ({ id: e.id, label: e.label, enabled: e.enabled !== false, active: !!e.active, on: e.on, state: e.state, layer: e.layer ? e.layer.name : null, rect: rectOf(e) }));
    stats.layers = layers ? layers.stats() : [];
    stats.selection = selbar && selbar.stats.key != null ? { ...selbar.stats, rect: rectOf(selbar.stats.rect) } : null;
    stats.counters = Object.fromEntries(Object.entries(counters).map(([kk, c]) => [kk, { value: c.value, head: c.head, shown: shown[kk], target: target[kk], held: held[kk], rect: rectOf({ x: c.cx - c.w / 2, y: c.cy - c.h / 2, w: c.w, h: c.h }) }]));
    if (live) invalidate();
  }
  // client coordinates, for tests that tap
  function rectOf(e) {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(r.left + e.x), y: Math.round(r.top + e.y), w: Math.round(e.w), h: Math.round(e.h) };
  }
  function invalidate() {
    if (!frame && !destroyed) frame = requestAnimationFrame(draw);
  }
  art.onLoad(invalidate);
  text.ready.then(invalidate);

  // ---------- input: taps on drawn buttons never reach the board ----------
  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onDown(e) {
    if (layers && layers.active) {
      // an open screen or popup takes every press: taps on what it drew, drags to scroll it, nothing for the board
      e.stopPropagation();
      e.preventDefault();
      layers.down(local(e), e);
      return;
    }
    if (!state.visible) return;
    const p = local(e);
    const el = hits.at(p.x, p.y);
    if (!el) return;
    e.stopPropagation();
    e.preventDefault();
    // a press on the selection bar's row of buttons may turn into a sideways drag that scrolls it
    const strip = !!selbar && selected() && selbar.inStrip(p.x, p.y);
    pressed = { el, id: e.pointerId, x0: p.x, sx: strip ? selbar.scrollX : 0, strip, dragging: false };
    if (el.track) { pressed.dragging = true; seekAt(p.x, false); return; }
    if (el.id === "bar" || el.id === "banner" || el.inert) return;
    invalidate();
  }
  function onUp(e) {
    if (layers && layers.pressing) {
      const r = layers.up(local(e), e);
      if (!r) return;
      e.stopPropagation();
      swallowClick(e);
      const el = r.el;
      if (el) {
        if (!el.scrim) play("click");
        if (el.onTap) el.onTap(el); else onAction(el.id);
      }
      return;
    }
    if (!pressed || (pressed.id != null && e.pointerId !== pressed.id)) return;
    if (pressed.el.track) { seekAt(local(e).x, true); pressed = null; e.stopPropagation(); swallowClick(e); invalidate(); return; }
    const was = pressed.el, dragged = pressed.dragging;
    pressed = null;
    const p = local(e);
    const el = hits.at(p.x, p.y);
    e.stopPropagation();
    invalidate();
    if (dragged) { swallowClick(e); return; }
    if (el && el.id === was.id && !was.inert) {
      if (was.id !== "bar" && was.id !== "banner") play("click");
      swallowClick(e);
      if (el.onTap) el.onTap(el); else onAction(was.id);
    } else if (was.inert) swallowClick(e);
  }
  // the browser's click that follows the tap would land on whatever the action opened (a sheet's scrim closes on it)
  function swallowClick(e) {
    const x = e.clientX, y = e.clientY, t0 = now();
    const fn = (c) => {
      if (!c.isTrusted) return; // the action's own element.click() calls
      window.removeEventListener("click", fn, true);
      if (now() - t0 < 600 && Math.abs(c.clientX - x) < 30 && Math.abs(c.clientY - y) < 30) { c.stopPropagation(); c.preventDefault(); }
    };
    window.addEventListener("click", fn, true);
    setTimeout(() => window.removeEventListener("click", fn, true), 650);
  }
  function onCancel() { if (layers) layers.cancel(); if (pressed) { pressed = null; invalidate(); } }
  function onDrag(e) {
    if (layers && layers.pressing && layers.move(local(e), e)) { e.stopPropagation(); e.preventDefault(); return; }
    if (pressed && pressed.el.track && (pressed.id == null || e.pointerId === pressed.id)) { seekAt(local(e).x, false); e.stopPropagation(); e.preventDefault(); return; }
    if (pressed && pressed.strip && (pressed.id == null || e.pointerId === pressed.id)) {
      const dx = local(e).x - pressed.x0;
      if (!pressed.dragging && Math.abs(dx) > 8) pressed.dragging = true;
      if (pressed.dragging) { selbar.scrollTo(pressed.sx - dx); invalidate(); e.stopPropagation(); e.preventDefault(); }
    }
  }
  function onWheel(e) {
    if (selected() && !(layers && layers.active)) {
      // the wheel over the selection bar scrolls its row of buttons (and never zooms the board under it)
      const p = local(e);
      const r = selbar.stats.rect;
      if (!r || p.y < r.y || p.x > r.x + r.w) return;
      e.stopPropagation();
      e.preventDefault();
      if (selbar.inStrip(p.x, p.y)) { selbar.scrollTo(selbar.scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)); invalidate(); }
      return;
    }
    if (!layers || !layers.active) return;
    e.stopPropagation();
    e.preventDefault();
    layers.wheel(e, local(e));
  }
  function onMove(e) {
    if (e.pointerType === "touch") return;
    if (layers && layers.active) {
      e.stopPropagation();
      const el = hits.at(local(e).x, local(e).y);
      const id = el && !el.scrim ? el.id : null;
      if (id !== hover) { hover = id; wrap.classList.toggle("g-hud-hover", !!id); }
      return;
    }
    const p = local(e);
    const el = hits.at(p.x, p.y);
    const id = el ? el.id : null;
    if (id !== hover) { hover = id; wrap.classList.toggle("g-hud-hover", !!id); }
    if (el) e.stopPropagation();
  }
  wrap.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  wrap.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointermove", onDrag, true);
  wrap.addEventListener("wheel", onWheel, { capture: true, passive: false });

  // ---------- the API ----------
  const api = {
    canvas,
    stats,
    text,
    // the parts of the screen the HUD covers, for the board's reveal and centreOn
    get insets() {
      const bar = state.bottom ? safe.bottom + u(104) : 0;
      const sel = !selected() ? bar : !compact() ? selbar.height() : selbar.lift ? selbar.height() + selbar.lift : bar;
      return { top: safe.top + u(70), bottom: sel + (state.deck && !selected() ? deckH() : 0) };
    },
    // the selection bar's spec (ui/selection.js builds it), or null to put the button bar back
    select(spec) {
      if (!selbar) return;
      const had = selected();
      selbar.set(spec || null);
      invalidate();
      if (had !== selected()) onResize();
    },
    get selection() { return selbar ? selbar.spec : null; },
    // the camera moved: buttons round the selected tile follow it
    viewChanged() {
      if (selbar && selected() && selbar.ringed) invalidate();
    },
    update(s) {
      Object.assign(state, s);
      if (s.mode && s.visible == null) state.visible = true;
      if (s.score != null) target.score = s.score;
      if (s.stars != null) target.stars = s.stars;
      invalidate();
    },
    banner(textStr, o = {}) {
      if (!textStr) { banner = null; invalidate(); return; }
      if (banner && banner.text === textStr && banner.sub === (o.sub || "") && banner.kind === (o.kind || "")) return;
      banner = { text: textStr, sub: o.sub || "", kind: o.kind || "", ms: o.ms || 0, t0: now() };
      invalidate();
    },
    get bannerKind() { return banner ? banner.kind : ""; },
    // a pill under the top bar for `o.ms`; `o.error` makes it red (game mode's toasts)
    notice(textStr, o = {}) {
      const same = notices.find((n) => n.text === textStr);
      if (same) { same.t0 = now() - 200; invalidate(); return; }
      notices.push({ text: textStr, icon: o.icon || null, ms: o.ms || 1800, error: !!o.error, t0: now() });
      if (notices.length > 3) notices.shift();
      invalidate();
    },
    // A gain of `amount` flies from client point `from` (or a function giving it when the floater starts, after
    // `o.delay` ms) to the counter `kind` ("score" or "stars"); the counter holds that much back until it lands.
    // Resolves when it lands.
    fly(kind, from, amount, o = {}) {
      return api.hold(kind, amount).fly(from, o);
    },
    // A gain the counter holds back now and that flies later (a meeting's stars, once its popup is answered):
    // returns {fly(from, o), release()}; release() gives the counter the amount without a floater.
    hold(kind, amount) {
      if (!(amount > 0) || !(kind in held)) return { fly: () => Promise.resolve(), release() {} };
      held[kind] += amount;
      invalidate();
      let done = false;
      return {
        fly(from, o = {}) {
          if (done) return Promise.resolve();
          done = true;
          stats.floaters.started++;
          return new Promise((resolve) => {
            floaters.push({ kind, amount, from, x: null, y: null, t0: now() + (o.delay || 0), resolve });
            invalidate();
          });
        },
        release() {
          if (done) return;
          done = true;
          held[kind] = Math.max(0, held[kind] - amount);
          invalidate();
        },
      };
    },
    // the client point at the centre of a drawn element (a hit from layers or the bar)
    centreOf(el) {
      const r = canvas.getBoundingClientRect();
      return { x: r.left + el.x + el.w / 2, y: r.top + el.y + el.h / 2 };
    },
    // a gain with no tile to come from: the counter just pulses
    bump(kind) { pulse[kind] = now(); invalidate(); },
    get idle() { return !frame && !floaters.length; },
    resize,
    invalidate,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      probe.remove();
      canvas.remove();
      wrap.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      wrap.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointermove", onDrag, true);
      wrap.removeEventListener("wheel", onWheel, true);
    },
    // a screen or popup (ui/layers.js): returns its handle ({close(), closed, back()})
    open(spec) { return layers.open(spec); },
    get layers() { return layers; },
  };
  return api;
}
