// Screens and popups drawn on the HUD canvas in game mode (the retail UIScreenBase screens and BasicPopup cards), and the
// widgets they are made of: the white back button, pill buttons with thin capitals, ON/OFF toggles, round buttons,
// dividers, black cards, wrapped text.
//
// A layer is drawn every frame by its `draw(g, L)` from what it shows now (immediate mode): there is no widget tree to
// keep in step with the game. Taps reach the element drawn under the finger (`g.hit`), drags scroll the layer (with
// momentum), the wheel scrolls it, and nothing under an open layer (the board, the HUD's own buttons) gets the input.
//
// Units: as the HUD's, `g.u(v)` scales the retail canvas units to CSS px.

export function createLayers(env) {
  const { kit, text, fonts, art, hits } = env;
  const { roundRect, ease } = kit;
  const stack = [];
  const now = () => performance.now();
  let pressed = null; // {el, layer, x0, y0, id, dragging, last: [{x, y, t}]}
  const FADE_IN = 190, FADE_OUT = 150;

  // ---------- the toolkit handed to a layer's draw ----------
  let clipRect = null;
  let noHits = false;
  let layerNow = null;
  const g = {
    get ctx() { return env.ctx; },
    get W() { return env.size().W; },
    get H() { return env.size().H; },
    get safe() { return env.size().safe; },
    get k() { return env.size().k; },
    u: (v) => v * env.size().k,
    fonts,
    art,
    kit,
    get layer() { return layerNow; },
    pressed: (id) => !!pressed && !pressed.dragging && pressed.el && pressed.el.id === id,

    text(str, x, y, o = {}) {
      return text.draw(env.ctx, str, x, y, { font: fonts.label, colour: "#fff", ...o, size: g.u(o.size || 16), maxWidth: o.maxWidth ? g.u(o.maxWidth) : undefined, minSize: o.minSize ? g.u(o.minSize) : undefined });
    },
    measure: (str, o = {}) => text.measure(str, { font: fonts.label, ...o, size: g.u(o.size || 16) }).w,
    // the lines `str` breaks into at `maxW` CSS px (explicit "\n" kept)
    lines(str, maxW, o = {}) {
      const out = [];
      for (const para of String(str).split("\n")) {
        const words = para.split(/\s+/).filter(Boolean);
        let line = "";
        for (const w of words) {
          const tryLine = line ? `${line} ${w}` : w;
          if (line && g.measure(tryLine, o) > maxW) { out.push(line); line = w; } else line = tryLine;
        }
        out.push(line);
      }
      return out;
    },
    // wrapped text from (x, y) (the top of the first line); returns the y under the last line
    para(str, x, y, maxW, o = {}) {
      const size = o.size || 16, lh = g.u(o.lineHeight || size * 1.22);
      let yy = y;
      for (const line of g.lines(str, maxW, o)) {
        g.text(line, x, yy, { ...o, baseline: "top" });
        yy += lh;
      }
      return yy;
    },
    paraHeight(str, maxW, o = {}) {
      const size = o.size || 16;
      return g.lines(str, maxW, o).length * g.u(o.lineHeight || size * 1.22);
    },
    icon: (keys, cx, cy, size, o) => art.icon(env.ctx, keys, cx, cy, size, o),
    // the HUD's top bar (score, stars, turn), for a screen that covers it
    bar: () => { if (env.bar) env.bar(); },

    // something tappable drawn this frame: {id, label, x, y, w, h, round?, onTap, enabled?}
    hit(el) {
      if (noHits) return el;
      if (clipRect) {
        const c = clipRect;
        if (el.y + el.h < c.y || el.y > c.y + c.h || el.x + el.w < c.x || el.x > c.x + c.w) return el;
      }
      el.layer = layerNow;
      return hits.add(el);
    },
    clip(x, y, w, h, fn) {
      const ctx = env.ctx;
      const was = clipRect;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      clipRect = { x, y, w, h };
      try { fn(); } finally { ctx.restore(); clipRect = was; }
    },

    rr(x, y, w, h, r, fill, stroke, lw) {
      const ctx = env.ctx;
      roundRect(ctx, x, y, w, h, r);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
    },
    circle(cx, cy, r, fill, stroke, lw) {
      const ctx = env.ctx;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.beginPath(); ctx.arc(cx, cy, r - (lw || 1) / 2, 0, Math.PI * 2); ctx.stroke(); }
    },
    dim(alpha = 0.72) {
      env.ctx.fillStyle = `rgba(4,6,14,${alpha})`;
      env.ctx.fillRect(0, 0, g.W, g.H);
    },
    divider(cx, y, w) {
      const ctx = env.ctx;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(Math.round(cx - w / 2), Math.round(y), Math.round(w), Math.max(1, Math.round(g.u(1.5))));
    },
    card(x, y, w, h, o = {}) {
      g.rr(x, y, w, h, g.u(o.r || 22), o.fill || "rgba(0,0,0,0.94)");
    },

    // the retail back button: a white disc with a black chevron, top left
    back(L, o = {}) {
      const d = g.u(42), cx = g.safe.left + g.u(14) + d / 2, cy = g.safe.top + g.u(12) + d / 2;
      const s = g.pressed("back") ? 0.92 : 1;
      const ctx = env.ctx;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
      g.circle(0, 0, d / 2, "#ffffff");
      ctx.strokeStyle = "#111"; ctx.lineWidth = g.u(3.4); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(g.u(3), -g.u(9)); ctx.lineTo(-g.u(6), 0); ctx.lineTo(g.u(3), g.u(9)); ctx.stroke();
      ctx.restore();
      g.hit({ id: "back", label: o.label || "Back", x: cx - d / 2, y: cy - d / 2, w: d, h: d, round: true, slop: g.u(8), onTap: () => L.back() });
      return { cx, cy, d };
    },

    // a rounded text button: blue by default, thin capitals (EXIT TO MENU, RESIGN, ON/OFF)
    pill(o) {
      const { x, y, w, h } = o;
      const on = o.enabled !== false;
      const s = g.pressed(o.id) ? 0.95 : 1;
      const ctx = env.ctx;
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2); ctx.scale(s, s);
      ctx.globalAlpha *= on ? 1 : 0.45;
      g.rr(-w / 2, -h / 2, w, h, o.r != null ? g.u(o.r) : g.u(12), o.fill || COLOURS.blue, o.stroke, o.stroke ? g.u(2) : 0);
      const label = o.upper === false ? o.label : String(o.label).toUpperCase();
      const iw = o.icon ? g.u(o.iconSize || 22) : 0;
      const tw = Math.min(g.measure(label, { font: o.font || fonts.thin, size: o.size || 22, bold: o.bold !== false }), w - g.u(16) - iw);
      let tx = -(tw + (iw ? iw + g.u(4) : 0)) / 2;
      if (o.icon) { g.icon(o.icon, tx + iw / 2, 0, iw); tx += iw + g.u(4); }
      g.text(label, tx, 0, { font: o.font || fonts.thin, size: o.size || 22, bold: o.bold !== false, baseline: "middle", colour: o.colour || "#fff", maxWidth: (w - g.u(16) - iw) / g.k, minSize: 10 });
      ctx.restore();
      // a small pill (RESIGN) still takes a finger-sized tap: its hit rect grows to `minH` CSS px
      const hh = Math.max(h, o.minH || 0);
      return g.hit({ id: o.id, label: o.aria || o.label, x, y: y - (hh - h) / 2, w, h: hh, enabled: on, onTap: o.onTap });
    },

    // a labelled ON/OFF switch, centred on cx: the label above, the pill under it
    toggle(o) {
      const w = g.u(o.w || 60), h = g.u(38);
      g.text(o.label, o.cx, o.y, { size: 15, align: "center", baseline: "top", maxWidth: o.maxLabel || 120, minSize: 10, shadow: { dy: 1, colour: "rgba(0,0,0,0.5)" } });
      const el = g.pill({ id: o.id, label: o.on ? "On" : "Off", aria: `${o.label}: ${o.on ? "on" : "off"}`, x: o.cx - w / 2, y: o.y + g.u(22), w, h, r: 10, fill: o.on ? COLOURS.blue : COLOURS.off, size: 25, minH: 40, onTap: o.onTap, enabled: o.enabled });
      el.on = !!o.on;
      return el;
    },

    // a round button: a dark disc with a white ring and a picture (or text), a label under it
    round(o) {
      const { cx, cy, d } = o;
      const s = g.pressed(o.id) ? 0.92 : 1;
      const ctx = env.ctx;
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(s, s);
      if (o.enabled === false) ctx.globalAlpha *= 0.5;
      g.circle(0, 0, d / 2, o.fill || "rgba(0,0,0,0.85)");
      if (o.ring !== false) g.circle(0, 0, d / 2 + g.u(1), null, o.ringColour || "#fff", Math.max(1.5, d * 0.05));
      if (o.drawInside) o.drawInside(d);
      else if (o.icon && !o.text) {
        if (!g.icon(o.icon, 0, 0, d * (o.iconScale || 0.7))) g.text((o.label || "?").slice(0, 1), 0, 0, { size: 22, align: "center", baseline: "middle" });
      }
      if (o.text) g.text(o.text, 0, 0, { font: o.textFont || fonts.numbers, size: o.textSize || 26, align: "center", baseline: "middle", bold: o.textBold, maxWidth: (d * 0.84) / g.k, minSize: 10 });
      ctx.restore();
      if (o.label && o.labelBelow !== false) {
        g.text(o.label, cx, cy + d / 2 + g.u(6), { size: o.labelSize || 16, align: "center", baseline: "top", maxWidth: o.labelMax || 110, minSize: 10, shadow: { dy: 1, colour: "rgba(0,0,0,0.6)" } });
      }
      return g.hit({ id: o.id, label: o.aria || o.label, x: cx - d / 2, y: cy - d / 2, w: d, h: d, round: true, slop: g.u(6), enabled: o.enabled !== false, onTap: o.onTap });
    },
  };

  const COLOURS = {
    blue: "#0a8ce6",
    off: "rgba(120,120,128,0.75)",
    red: "rgba(240,60,20,0.95)",
    green: "#2ecc40",
  };
  g.COLOURS = COLOURS;

  // ---------- the stack ----------
  function open(spec) {
    const L = {
      spec, name: spec.name || "layer", kind: spec.kind || "popup",
      t0: now(), closed: false, t1: 0,
      scroll: { x: 0, y: 0, vx: 0, vy: 0, maxX: 0, maxY: 0 },
      viewport: null, // the rect a drag scrolls, in CSS px (default: the whole screen)
      state: spec.state || {},
      close(result) {
        if (L.closed) return;
        L.closed = true;
        L.t1 = now();
        if (pressed && pressed.layer === L) pressed = null;
        env.invalidate();
        if (spec.onClose) spec.onClose(result);
      },
      back() { if (spec.onBack) spec.onBack(L); else L.close(); },
      // Enter: the layer's main button, if it has one
      enter() { if (spec.onEnter) { spec.onEnter(L); return true; } return false; },
      // the scrollable size: content w, h inside the viewport rect. "y" scrolls from 0 down to the end; "xy" (a map
      // like the tech tree) pans either way from the centre, so x and y run from -max to +max.
      setScroll(contentW, contentH, vp) {
        L.viewport = vp;
        const xy = spec.scroll === "xy";
        L.scroll.maxY = Math.max(0, (contentH - vp.h) / (xy ? 2 : 1));
        L.scroll.maxX = xy ? Math.max(0, (contentW - vp.w) / 2) : 0;
        clampScroll(L);
      },
      // scroll so a content rect is in view (for tests and keyboard)
      reveal(y, h) {
        if (!L.viewport) return;
        if (y < L.scroll.y) L.scroll.y = y;
        else if (y + h > L.scroll.y + L.viewport.h) L.scroll.y = y + h - L.viewport.h;
        clampScroll(L);
        env.invalidate();
      },
      invalidate: () => env.invalidate(),
      get open() { return !L.closed; },
    };
    stack.push(L);
    // retail's Popup sound as a card comes up (a screen opens with the button's own click)
    if (L.kind === "popup" && !spec.silent && env.play) env.play("popup");
    env.invalidate();
    return L;
  }

  function clampScroll(L) {
    const s = L.scroll;
    if (L.spec.scroll === "xy") {
      s.y = Math.max(-s.maxY, Math.min(s.maxY, s.y));
      s.x = Math.max(-s.maxX, Math.min(s.maxX, s.x));
    } else {
      s.y = Math.max(0, Math.min(s.maxY, s.y));
      s.x = 0;
    }
  }

  const live = () => stack.filter((L) => !L.closed);
  const top = () => { const l = live(); return l.length ? l[l.length - 1] : null; };

  // ---------- drawing ----------
  let lastT = 0;
  function draw(t) {
    let animating = false;
    const dt = lastT ? Math.min(50, t - lastT) : 16;
    lastT = t;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].closed && (env.reduced() || t - stack[i].t1 > FADE_OUT)) stack.splice(i, 1);
    const reduced = env.reduced();
    for (const L of stack) {
      // momentum
      const s = L.scroll;
      if (!(pressed && pressed.layer === L && pressed.dragging) && (Math.abs(s.vy) > 0.01 || Math.abs(s.vx) > 0.01)) {
        s.y += s.vy * dt; s.x += s.vx * dt;
        const f = Math.pow(0.94, dt / 16);
        s.vy *= f; s.vx *= f;
        const y0 = s.y, x0 = s.x;
        clampScroll(L);
        if (s.y !== y0) s.vy = 0;
        if (s.x !== x0) s.vx = 0;
        animating = true;
      }
      const age = t - L.t0;
      let a = 1, sc = 1;
      if (!reduced) {
        if (L.closed) a = Math.max(0, 1 - (t - L.t1) / FADE_OUT);
        else if (age < FADE_IN) { const p = age / FADE_IN; a = ease.out(p); sc = L.kind === "popup" ? 0.88 + 0.12 * ease.outBack(p) : 1; }
        if (L.closed || age < FADE_IN) animating = true;
      }
      const ctx = env.ctx;
      ctx.save();
      ctx.globalAlpha = a;
      layerNow = L;
      noHits = L.closed;
      if (!L.closed) {
        // nothing under an open layer takes a tap; a popup that may be dismissed closes on a tap outside it
        g.hit({ id: `scrim:${L.name}`, label: "", x: 0, y: 0, w: g.W, h: g.H, scrim: true, onTap: L.spec.dismiss ? () => L.back() : null });
      }
      L.scale = sc;
      L.age = age;
      try { L.spec.draw(g, L, t); } catch (e) { console.error("layer draw", L.name, e); }
      if (L.spec.animating && L.spec.animating(L, t)) animating = true;
      ctx.restore();
      layerNow = null;
      noHits = false;
    }
    return animating;
  }

  // ---------- input (hud.js forwards pointer events here while a layer is open) ----------
  function down(p, e) {
    const L = top();
    if (!L) return false;
    const el = hits.at(p.x, p.y);
    L.scroll.vx = 0; L.scroll.vy = 0;
    pressed = { el: el && el.layer && !el.scrim && !el.inert ? el : null, layer: L, x0: p.x, y0: p.y, sx: L.scroll.x, sy: L.scroll.y, id: e.pointerId, dragging: false, last: [{ x: p.x, y: p.y, t: now() }] };
    if (el && el.scrim) pressed.scrim = el;
    env.invalidate();
    return true;
  }
  function move(p, e) {
    if (!pressed || (pressed.id != null && e.pointerId !== pressed.id)) return false;
    const L = pressed.layer;
    const dx = p.x - pressed.x0, dy = p.y - pressed.y0;
    const canScroll = L.spec.scroll && (L.scroll.maxY > 0 || L.scroll.maxX > 0);
    if (!pressed.dragging && Math.hypot(dx, dy) > 8 && canScroll) pressed.dragging = true;
    if (pressed.dragging) {
      L.scroll.y = pressed.sy - dy;
      if (L.spec.scroll === "xy") L.scroll.x = pressed.sx - dx;
      clampScroll(L);
      pressed.last.push({ x: p.x, y: p.y, t: now() });
      if (pressed.last.length > 6) pressed.last.shift();
      env.invalidate();
    }
    return true;
  }
  function up(p, e) {
    if (!pressed || (pressed.id != null && e.pointerId !== pressed.id)) return null;
    const was = pressed;
    pressed = null;
    env.invalidate();
    if (was.dragging) {
      const a = was.last[0], b = was.last[was.last.length - 1];
      const dt = Math.max(1, b.t - a.t);
      if (now() - b.t < 80) {
        was.layer.scroll.vy = -(b.y - a.y) / dt;
        if (was.layer.spec.scroll === "xy") was.layer.scroll.vx = -(b.x - a.x) / dt;
      }
      return { dragged: true };
    }
    const el = hits.at(p.x, p.y);
    if (was.el && el && el.id === was.el.id && el.layer === was.el.layer && !el.inert) return { el };
    if (!was.el && was.scrim && el && el.scrim && el.onTap) return { el };
    return { el: null };
  }
  function wheel(e, p) {
    const L = top();
    if (!L) return false;
    if (L.spec.scroll) {
      const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? g.H : 1;
      const sideways = L.spec.scroll === "xy" && e.shiftKey; // shift and the wheel pans a map sideways
      if (!sideways) L.scroll.y += e.deltaY * m;
      if (L.spec.scroll === "xy") L.scroll.x += (sideways ? e.deltaY : e.deltaX) * m;
      clampScroll(L);
      env.invalidate();
    }
    return true;
  }
  function cancel() { pressed = null; env.invalidate(); }

  return {
    g,
    open,
    draw,
    down, move, up, wheel, cancel,
    get active() { return !!top(); },
    get top() { return top(); },
    get list() { return live(); },
    get pressing() { return !!pressed; },
    closeAll() { for (const L of live()) L.close(); },
    stats() {
      return live().map((L) => ({ name: L.name, kind: L.kind, scroll: { x: Math.round(L.scroll.x), y: Math.round(L.scroll.y), maxY: Math.round(L.scroll.maxY), maxX: Math.round(L.scroll.maxX) }, texts: L.texts || [] }));
    },
  };
}
