// Game mode's selection bar: retail's InteractionBar (the InteractionBarMobile prefab, dumped by
// tools/extract_assets/uiprefabs.py), drawn by the HUD at the bottom of the screen in place of the button bar while a
// unit, a tile or a city is selected:
//
// - the top strip (black at 79 %): the selected thing's picture on the left (retail's SpriteDuplicator copies its
//   sprites), a JosefinSans-Italic header with the info mark, a Nunito description, and the white back button on the
//   right;
// - the bottom strip (solid black): a row of round buttons (UIRoundButton: black at 80 % with a white ring, blue when
//   picked, a grey ring when out of reach), each with its price at the top right and its name under it. A row wider than
//   the screen scrolls sideways.
//
// With a mouse it is retail's PC layout (the "Compact UI" setting): the buttons sit round the selected tile, as retail's
// QuickActions does (QuickActions.RefreshButtons and UpdateBg), and only the top strip stays, at the bottom left.
//
// It knows nothing of the game: ui/selection.js builds the spec it draws. Units are the HUD's (`g.u`).

export function createSelBar(env) {
  // env: { g (the layers toolkit), size() -> {W, H, safe, k}, portrait(ctx, p, cx, cy, size) -> true | null | false,
  //        pressedId() -> the id under a press, reduced(), ring() -> true with a mouse,
  //        anchor([x, y]) -> {x, y}: a tile's centre in canvas px,
  //        barLeft() -> where the HUD's button bar starts in canvas px, or null without one }
  const { g } = env;
  const u = (v) => g.u(v);
  const TOP = 88, BOT = 100, SLIDE = 180;
  const PANEL = 360; // the info's width at the bottom left with the ring (retail's at 1920 x 1080: about 470 px at scale 1.3)
  const RING = 200; // QuickActions.Show: the buttons fly out and the wedge grows from half size in 0.2 s
  let spec = null, shownKey = null, t0 = -1e9, ringT0 = -1e9;
  let scrollX = 0, maxX = 0;
  let strip = null; // the bottom strip's rect, for drags
  const stats = { key: null, header: null, desc: null, buttons: [], rect: null, portrait: null };

  function set(s) {
    if (!s) { spec = null; shownKey = null; stats.key = null; return; }
    if (!spec) t0 = performance.now(); // slides up when it appears, not when its content changes
    if (s.key !== shownKey) { scrollX = 0; ringT0 = performance.now(); }
    shownKey = s.key;
    spec = s;
  }
  const hasButtons = () => !!spec && spec.buttons.length > 0;
  const at = () => spec.at || (spec.portrait && spec.portrait.xy) || null; // the selected tile
  const ringed = () => !!spec && !!at() && !!env.ring && env.ring();
  const panelW = () => { const { W, safe } = env.size(); return ringed() ? Math.min(W, safe.left + u(PANEL)) : W; };
  // with the ring on a screen too narrow for the info beside the button bar, the info sits above the bar: how far up
  const lift = () => {
    const left = ringed() && env.barLeft ? env.barLeft() : null;
    return left != null && panelW() > left ? u(88) : 0;
  };
  function height() {
    if (!spec) return 0;
    return u(TOP) + (hasButtons() && !ringed() ? u(BOT) : u(6)) + env.size().safe.bottom;
  }

  // the description in at most two lines, the second cut with an ellipsis
  function descLines(str, maxW) {
    const o = { font: g.fonts.body, size: 15 };
    const lines = g.lines(str, maxW, o);
    if (lines.length <= 2) return lines;
    let second = lines.slice(1).join(" ");
    while (second.length > 1 && g.measure(`${second}…`, o) > maxW) second = second.slice(0, -1);
    return [lines[0], `${second.trimEnd()}…`];
  }

  function back(cx, cy, d) {
    const ctx = g.ctx;
    const s = env.pressedId() === "sel-back" ? 0.92 : 1;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
    g.circle(0, 0, d / 2, "#ffffff");
    ctx.strokeStyle = "#111"; ctx.lineWidth = u(3); ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(u(2.5), -u(8)); ctx.lineTo(-u(5.5), 0); ctx.lineTo(u(2.5), u(8)); ctx.stroke();
    ctx.restore();
    g.hit({ id: "sel-back", label: spec.backLabel || "Close", x: cx - d / 2, y: cy - d / 2, w: d, h: d, round: true, slop: u(8), onTap: () => spec.back && spec.back() });
  }

  // A round button is drawn in three parts (the disc with its picture, the name under it, the price at its top right),
  // so that round a tile, where neighbours overlap, every name and price can go over every disc.
  const isOff = (b) => b.enabled === false || b.short;
  function disc(b, cx, cy, d) {
    const ctx = g.ctx;
    const s = env.pressedId() === b.id ? 0.92 : 1;
    const off = isOff(b);
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(s, s);
    g.circle(0, 0, d / 2, b.active ? "rgba(0,153,255,0.8)" : b.fill || "rgba(0,0,0,0.8)");
    g.circle(0, 0, d / 2 + u(1), null, off && !b.active ? "#5b5b5b" : "#ffffff", Math.max(1.5, d * 0.045));
    ctx.globalAlpha *= off ? 0.55 : 1;
    let drawn = false;
    if (b.drawIcon) drawn = b.drawIcon(ctx, d);
    // a building's, unit's or resource's picture is the board's art: centred on what is drawn, not on its tile's anchor
    else if (b.icon) drawn = g.icon(b.icon, 0, b.iconDy ? u(b.iconDy) : 0, d * (b.iconScale || 0.62), { centred: true });
    if (!drawn) g.text(b.letter || String(b.label || "?").slice(0, 1), 0, 0, { size: 22, align: "center", baseline: "middle" });
    ctx.restore();
    return g.hit({ id: b.id, label: b.aria || b.label, x: cx - d / 2, y: cy - d / 2, w: d, h: d, round: true, slop: u(10), active: !!b.active, state: b.state || (b.short ? "short" : null), onTap: () => b.onTap && b.onTap(b) });
  }
  function price(b, cx, cy, d) {
    if (b.cost == null) return;
    // retail's ResourceWidget (30 x 30, its right edge 12 past the button's, its top 5 above): the star on the outline
    // at the top right and the price beside it, 3 apart, in Roboto numbers with a shadow
    const ix = cx + d / 2 - u(9.5), iy = cy - d / 2 + u(10);
    g.icon(["icon/resource", "icon/staricon", "icon/star"], ix, iy, u(16));
    g.text(String(b.cost), ix + u(11), iy + u(1), { font: g.fonts.numbers, size: 16, baseline: "middle", colour: b.short ? "#ff6a4d" : "#ffffff", shadow: { dy: 1, colour: "rgba(0,0,0,0.7)" } });
  }
  function name(b, cx, cy, d, pill = false) {
    if (!b.label) return;
    const o = { size: 13.5, align: "center", baseline: "top", maxWidth: 80, minSize: 9, alpha: isOff(b) ? 0.7 : 1, shadow: { dy: 1, colour: "rgba(0,0,0,0.6)" } };
    let top = cy + d / 2 + u(1);
    if (pill) {
      // retail's TextBg under a quick action's name: circle_22 sliced, black at 50 %, 22 high from 4 under the button
      // and as wide as the name (measured on the reference rig: about 4 more either side)
      const w = Math.min(g.measure(b.label, o), u(80)) + u(9);
      top = cy + d / 2 + u(4);
      g.ctx.fillStyle = "rgba(0,0,0,0.5)";
      g.kit.roundRect(g.ctx, cx - w / 2, top, w, u(22), u(11));
      g.ctx.fill();
    }
    g.text(b.label, cx, top + u(4), o);
  }
  function button(b, cx, cy, d) {
    const el = disc(b, cx, cy, d);
    price(b, cx, cy, d);
    name(b, cx, cy, d);
    return el;
  }

  // retail's QuickActions round the tile at `a` (canvas px). Up to 4 buttons sit 1 radian apart centred on the top, on a
  // wedge of 55° a button; from 5 they go round from the top, clockwise. The radius is 90, 10 more for each button past 8.
  function ring(t, a) {
    const ctx = g.ctx;
    const n = spec.buttons.length;
    const R = 90 + Math.max(0, n - 8) * 10;
    const p = env.reduced() ? 1 : Math.min(1, Math.max(0, (t - ringT0) / RING));
    const back = (g.kit.ease.outBack || g.kit.ease.out)(p);
    // the wedge: BackgroundFill (black, faded in to 40 %) inside the 255 circle, cut out inside the 111 mask; from 9
    // buttons both follow the radius
    const outer = u(n >= 9 ? (R + 32) * 1.0379747 : 255 / 2) * (0.5 + 0.5 * back);
    const inner = u(n >= 9 ? (R - 32) * (1 - 0.0379747) : 111 / 2) * (0.5 + 0.5 * back);
    const span = (n < 5 ? Math.min(55 * n, 360) : 360) * Math.PI / 180;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.4 * g.kit.ease.out(p)})`;
    ctx.beginPath();
    if (span >= 2 * Math.PI - 1e-6) {
      ctx.arc(a.x, a.y, outer, 0, 2 * Math.PI);
      ctx.moveTo(a.x + inner, a.y);
      ctx.arc(a.x, a.y, inner, 0, 2 * Math.PI, true);
    } else {
      const from = -Math.PI / 2 - span / 2, to = -Math.PI / 2 + span / 2;
      ctx.arc(a.x, a.y, outer, from, to);
      ctx.arc(a.x, a.y, inner, to, from, true);
      ctx.closePath();
    }
    ctx.fill("evenodd");
    ctx.restore();
    const d = u(60);
    let ang = n < 5 ? Math.PI + (n - 1) * 0.5 : Math.PI;
    const step = n < 5 ? -1 : (-2 * Math.PI) / n;
    const pos = spec.buttons.map(() => {
      const c = [a.x + Math.sin(ang) * u(R) * back, a.y + Math.cos(ang) * u(R) * back];
      ang += step;
      return c;
    });
    ctx.save();
    ctx.globalAlpha = p;
    // neighbours are closer than a button with its name is high: all the discs first, then the names, then the prices
    spec.buttons.forEach((b, i) => {
      disc(b, pos[i][0], pos[i][1], d);
      stats.buttons.push({ id: b.id, label: b.label, cost: b.cost ?? null, active: !!b.active, short: !!b.short, enabled: b.enabled !== false, at: [Math.round(pos[i][0]), Math.round(pos[i][1])] });
    });
    spec.buttons.forEach((b, i) => name(b, pos[i][0], pos[i][1], d, true));
    spec.buttons.forEach((b, i) => price(b, pos[i][0], pos[i][1], d));
    ctx.restore();
    stats.ring = { x: Math.round(a.x), y: Math.round(a.y), r: Math.round(u(R)), n };
    return p < 1;
  }

  function draw(t) {
    if (!spec) { stats.key = null; strip = null; return false; }
    const { W, H, safe } = env.size();
    const ctx = g.ctx;
    let live = false;
    const ringOn = ringed();
    const PW = panelW();
    const full = height(), up = lift();
    const boxH = up ? u(TOP + 6) : full; // lifted: the button bar under it stays tappable
    let y0 = H - full - up;
    if (!env.reduced()) {
      const p = Math.min(1, (t - t0) / SLIDE);
      if (p < 1) { y0 += full * (1 - g.kit.ease.out(p)); live = true; }
    }
    // the whole bar takes the taps that land on it: nothing reaches the board under it
    g.hit({ id: "selbar", label: "", x: 0, y: y0, w: PW, h: up ? boxH : H - y0, inert: true });
    ctx.fillStyle = "rgba(0,0,0,0.79)";
    if (!ringOn) {
      // with the ring retail's info sits on the HUD's bottom fade, with no box of its own
      ctx.fillRect(0, y0, W, u(TOP));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, y0 + u(TOP), W, H - y0 - u(TOP));
    } else if (up) ctx.fillRect(0, y0, PW, boxH); // above the fade it needs a box to be read

    // the picture
    const pcx = safe.left + u(44), pcy = y0 + u(TOP) / 2, ps = u(74);
    let pic = false;
    if (spec.portrait) {
      const r = env.portrait(ctx, spec.portrait, pcx, pcy + u(4), ps);
      if (r === null) live = true;
      pic = !!r;
    }
    if (!pic && spec.portraitIcon) pic = g.icon(spec.portraitIcon, pcx, pcy, u(58));
    stats.portrait = pic;

    // the header, the info mark, the description
    const bd = u(ringOn ? 26 : 40), bcx = (ringOn ? PW : W - safe.right) - u(ringOn ? 24 : 30), bcy = y0 + u(ringOn ? 24 : 30);
    const tx = safe.left + u(90), maxW = bcx - bd / 2 - u(10) - tx;
    const headO = { size: 21, baseline: "top", colour: spec.headerColour || "#fff", maxWidth: (maxW - u(26)) / g.k, minSize: 12 };
    const hb = g.text(spec.header || "", tx, y0 + u(13), headO);
    const hw = Math.min((hb && hb.w) || g.measure(spec.header || "", headO), maxW - u(26));
    if (spec.info) {
      g.icon(["icon/info", "icon/about"], tx + hw + u(13), y0 + u(23), u(17));
      g.hit({ id: "sel-info", label: `About ${spec.header}`, x: tx - u(4), y: y0 + u(4), w: hw + u(30), h: u(34), onTap: () => spec.info() });
    }
    const lines = spec.desc ? descLines(spec.desc, maxW) : [];
    lines.forEach((line, i) => g.text(line, tx, y0 + u(42) + i * u(19), { font: g.fonts.body, size: 15, baseline: "top", colour: "rgba(255,255,255,0.92)" }));
    back(bcx, bcy, bd);

    // the buttons
    stats.buttons = [];
    stats.ring = null;
    strip = null;
    if (ringOn && hasButtons()) {
      const a = env.anchor(at());
      if (a && ring(t, a)) live = true;
    } else if (hasButtons()) {
      const top = y0 + u(TOP);
      const d = u(54), slot = u(80);
      const n = spec.buttons.length;
      const total = n * slot;
      const avail = W - safe.left - safe.right;
      let x0;
      if (total <= avail) { maxX = 0; scrollX = 0; x0 = safe.left + (avail - total) / 2; } else {
        maxX = total - avail + u(16);
        scrollX = Math.max(0, Math.min(maxX, scrollX));
        x0 = safe.left + u(8) - scrollX;
      }
      strip = { x: 0, y: top, w: W, h: u(BOT) };
      const cy = top + u(12) + d / 2;
      g.clip(0, top, W, H - top, () => {
        spec.buttons.forEach((b, i) => {
          const cx = x0 + slot * (i + 0.5);
          button(b, cx, cy, d);
          stats.buttons.push({ id: b.id, label: b.label, cost: b.cost ?? null, active: !!b.active, short: !!b.short, enabled: b.enabled !== false });
        });
      });
      if (maxX > 0) {
        // a fade at the edge that has more buttons behind it
        const fw = u(28);
        if (scrollX > 1) { const gr = ctx.createLinearGradient(0, 0, fw, 0); gr.addColorStop(0, "#000"); gr.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = gr; ctx.fillRect(0, top, fw, u(BOT)); }
        if (scrollX < maxX - 1) { const gr = ctx.createLinearGradient(W - fw, 0, W, 0); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "#000"); ctx.fillStyle = gr; ctx.fillRect(W - fw, top, fw, u(BOT)); }
      }
    }
    stats.key = spec.key;
    stats.header = spec.header || "";
    stats.desc = spec.desc || "";
    stats.rect = { x: 0, y: y0, w: PW, h: up ? boxH : H - y0 };
    stats.scroll = { x: Math.round(scrollX), max: Math.round(maxX) };
    return live;
  }

  return {
    set,
    get spec() { return spec; },
    // the buttons follow the tile: the HUD draws again when the camera moves
    get ringed() { return ringed() && hasButtons(); },
    // retail's PC layout: the HUD's own buttons and bottom fade stay while something is selected
    get compact() { return ringed(); },
    get lift() { return lift(); },
    height,
    draw,
    stats,
    // a sideways drag on the row of buttons
    inStrip: (x, y) => !!strip && maxX > 0 && x >= strip.x && y >= strip.y && x <= strip.x + strip.w && y <= strip.y + strip.h,
    get scrollX() { return scrollX; },
    scrollTo(x) { scrollX = Math.max(0, Math.min(maxX, x)); },
  };
}
