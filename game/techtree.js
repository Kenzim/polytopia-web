// The tech tree (task F3), drawn like the retail one: a star with the basic tech at the centre and one branch for each of
// the five tier-1 techs, going out to tier 2 and 3. Each tech is a round icon showing its state; tapping one opens a card
// with what it unlocks and a Research button. Pan and pinch with fingers, drag and wheel with a mouse.
//
// The screen is a full-page overlay (not a sheet): the tree needs the whole screen, also on a desktop. It reads the
// view and the commands through A (game.js) and asks A to play Research; it decides no rule. The one number computed
// here is the shown price (techPrice, a copy of the engine's formula): the engine sends only the Research commands
// that can be paid, so a tech that cannot be paid has no command to read a price from.

import { h, pretty } from "./derive.js";

const SVG = "http://www.w3.org/2000/svg";
const RING = [0, 135, 280, 450]; // radius of each tier from the centre, in tree units (a name and price hang off each circle, so tiers sit far apart)
const DISC = 72; // a tech's circle
const CORE = 96; // the centre
const MIN_K = 0.35, MAX_K = 2.2, OPEN_MIN_K = 0.7, OPEN_MAX_K = 1.15;
const BRANCH_ORDER = ["riding", "organization", "climbing", "fishing", "hunting"];

// A tribe swaps some techs for its own (engine data v28 `tech_overrides`). /api/meta does not carry them yet, so the
// table is the fallback; a tribe entry with `tech_overrides` wins.
const FALLBACK_OVERRIDES = {
  aquarion: { chivalry: "spearing", fishing: "aquafishing", ramming: "aquaculture", roads: "waterways", sailing: "marinelife" },
  elyrion: { hunting: "forestmagic", whaling: "watermagic" },
  polaris: { aquaculture: "sledding", aquatism: "polarism", fishing: "frostwork", navigation: "polarwarfare", sailing: "icefishing" },
  cymanti: { chivalry: "shock", construction: "recycling", meditation: "rituals", philosophy: "mysticism" },
};
const LITERACY = 0.5 * (1 + 0x2aaa3b / 0x800000); // the engine's f32 factor

// price of a tech for a player: tier * cities + 4 stars, a third off with Literacy (engine rules::economy::tech_price)
export function techPrice(tier, cities, literate) {
  if (!tier) return 0;
  const raw = Math.fround((Math.max(1, cities) - 1) * tier + tier + 4);
  return Math.ceil(literate ? Math.fround(raw * LITERACY) : raw);
}

// ---------- the tree: which techs, where ----------
// Walks the unlock lists from the basic tech with the tribe's replacements, and places every tech on a ring by its
// depth, in the slice of the circle its subtree needs. `o.rings` (the radius of each tier), `o.disc` (a circle's size)
// and `o.start` (where the first branch's slice begins, in degrees) change that spacing.
//
// `o.link` lays the tree out as retail's TechView.CreateNode does instead (game mode's canvas tree): every tech sits
// that far from the tech that unlocks it, and a tech's unlocks, in the order the data lists them, fan out 72 degrees
// apart about the line that came into it. So the basic tech's five make the full turn, a pair goes 36 degrees to
// either side and an only child carries straight on. Retail turns the whole tree 1 degree: the first branch
// (Organization) points 1 degree below straight right.
const FAN = 72, FAN_IN = 145; // FAN_IN: the line "into" the basic tech, which puts its first unlock at 1 degree
export function buildTree(M, overrides = {}, o = {}) {
  const rings = o.rings || RING, disc = o.disc || DISC;
  const eff = (id) => overrides[id] || id;
  const root = M.techById.get("basic");
  const nodes = new Map();
  if (!root) return { nodes, root: null, extent: 0 };
  nodes.set(root.idx, { t: root, depth: 0, parent: null, children: [], parents: [] });
  const queue = [root.idx];
  while (queue.length) {
    const n = nodes.get(queue.shift());
    let ids = n.t.unlocks || [];
    if (!n.depth && !o.link) ids = [...ids].sort((a, b) => (BRANCH_ORDER.indexOf(a) + 1 || 99) - (BRANCH_ORDER.indexOf(b) + 1 || 99));
    let k = 0;
    for (const id of ids) {
      const t = M.techById.get(eff(id));
      if (!t) continue;
      let c = nodes.get(t.idx);
      if (!c) {
        // turn: how far its line turns from the line into its parent (o.link)
        c = { t, depth: n.depth + 1, parent: n.t.idx, children: [], parents: [], turn: FAN * k - (FAN / 2) * (ids.length - 1) };
        nodes.set(t.idx, c);
        n.children.push(t.idx);
        queue.push(t.idx);
      }
      k++;
      if (!c.parents.includes(n.t.idx)) c.parents.push(n.t.idx);
    }
  }
  const fan = (i, x, y, a) => {
    const n = nodes.get(i);
    n.x = x;
    n.y = y;
    for (const c of n.children) {
      const b = a + nodes.get(c).turn, r = b * (Math.PI / 180);
      fan(c, x + o.link * Math.cos(r), y + o.link * Math.sin(r), b);
    }
  };
  const weight = (i) => {
    const n = nodes.get(i);
    n.w = n.children.length ? n.children.reduce((s, c) => s + weight(c), 0) : 1;
    return n.w;
  };
  weight(root.idx);
  const place = (i, a0, a1) => {
    const n = nodes.get(i);
    const a = ((a0 + a1) / 2) * (Math.PI / 180);
    const r = n.depth < rings.length ? rings[n.depth] : rings[rings.length - 1] + (n.depth - rings.length + 1) * (o.step || 112);
    n.x = Math.round(r * Math.cos(a));
    n.y = Math.round(r * Math.sin(a));
    let s = a0;
    for (const c of n.children) {
      const span = ((a1 - a0) * nodes.get(c).w) / n.w;
      place(c, s, s + span);
      s += span;
    }
  };
  const n = (root.unlocks || []).length || 1;
  const a0 = o.start ?? -90 - 180 / n;
  if (o.link) fan(root.idx, 0, 0, FAN_IN);
  else place(root.idx, a0, a0 + 360);
  let extent = 0;
  for (const v of nodes.values()) extent = Math.max(extent, Math.hypot(v.x, v.y));
  return { nodes, root: root.idx, extent: extent + disc / 2 + (o.pad ?? 56) };
}

// ---------- what the player has ----------
// The tree for the viewer's tribe and the state of each tech, shared by the HTML screen and game mode's canvas tree
// (ui/techview.js). `read()` takes the view again; `stateOf(n)` is done | available | expensive | locked.
export function techSetup(A, layout = {}) {
  const M = A.M;
  const view = () => A.S.view.view;
  const engine = A.meta.engine || {};
  const tribe = M.tribe(view().me.tribe); // name and colour
  const rules = (engine.tribes || []).find((t) => t.idx === view().me.tribe) || {}; // starting unit, and tech replacements once /api/meta sends them
  const tribeName = tribe ? tribe.name : null;
  const overrides = rules.tech_overrides || FALLBACK_OVERRIDES[tribeName] || {};
  const tree = buildTree(M, overrides, layout);
  const st = {
    done: new Set(), avail: new Map(), stars: 0, cities: 1, literate: false,
    read() {
      const me = view().me;
      st.done = new Set(me.tech || []);
      st.avail = new Map(A.S.g.research.map((c) => [c.tech, c]));
      st.stars = me.stars;
      st.cities = me.cities || 1;
      st.literate = [...st.done].some((i) => ((M.tech(i) || {}).abilities || []).includes("literacy"));
    },
    price: (n) => techPrice(n.t.cost, st.cities, st.literate),
    stateOf(n) {
      if (st.done.has(n.t.idx)) return "done";
      if (st.avail.has(n.t.idx)) return "available";
      if (!n.parents.some((p) => st.done.has(p))) return "locked";
      return st.stars >= st.price(n) ? "available" : "expensive"; // paid for but not your turn: shown as available, the card says wait
    },
  };
  st.read();
  return { tree, tribe, tribeName, rules, colour: M.tribeColour(view().me.tribe), st };
}

// ---------- pan and zoom ----------
function panZoom(pan, world, { extent, onBackgroundTap }) {
  let x = 0, y = 0, k = 1;
  const ptrs = new Map();
  let drag = null, pinch = null, suppress = false, easeTimer = 0;
  const size = () => pan.getBoundingClientRect();
  const clampK = (v) => Math.min(MAX_K, Math.max(MIN_K, v));
  const apply = () => {
    const r = size(), lim = extent * k;
    x = Math.min(r.width / 2 + lim, Math.max(r.width / 2 - lim, x));
    y = Math.min(r.height / 2 + lim, Math.max(r.height / 2 - lim, y));
    world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    pan.dataset.zoom = k.toFixed(3);
    pan.dataset.panX = String(Math.round(x));
    pan.dataset.panY = String(Math.round(y));
  };
  const ease = () => {
    world.classList.add("easing");
    clearTimeout(easeTimer);
    easeTimer = setTimeout(() => world.classList.remove("easing"), 320);
  };
  const zoomAt = (cx, cy, f) => {
    const k2 = clampK(k * f);
    x = cx - ((cx - x) / k) * k2;
    y = cy - ((cy - y) / k) * k2;
    k = k2;
    apply();
  };
  const mid = () => {
    const [a, b] = [...ptrs.values()];
    const r = size();
    return { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  pan.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) drag = { x0: e.clientX, y0: e.clientY, ox: x, oy: y, active: false };
    else if (ptrs.size === 2) {
      const m = mid();
      pinch = { d0: m.d, k0: k, wx: (m.x - x) / k, wy: (m.y - y) / k };
      drag = null;
      suppress = true;
      for (const id of ptrs.keys()) try { pan.setPointerCapture(id); } catch (err) { /* synthetic */ }
    }
  });
  pan.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const m = mid();
      k = clampK(pinch.k0 * (m.d / pinch.d0));
      x = m.x - pinch.wx * k;
      y = m.y - pinch.wy * k;
      apply();
      e.preventDefault();
    } else if (drag) {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.active && Math.hypot(dx, dy) < 6) return;
      if (!drag.active) {
        drag.active = true;
        suppress = true;
        try { pan.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
        pan.classList.add("dragging");
      }
      x = drag.ox + dx;
      y = drag.oy + dy;
      apply();
      e.preventDefault();
    }
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const wasDrag = drag && drag.active;
    ptrs.delete(e.pointerId);
    if (pinch && ptrs.size < 2) pinch = null;
    if (!ptrs.size) {
      pan.classList.remove("dragging");
      const plain = !wasDrag && !suppress && e.type === "pointerup" && (e.target === pan || e.target === world || e.target.closest(".tech-lines"));
      drag = null;
      if (plain) onBackgroundTap();
      setTimeout(() => { suppress = false; }, 0);
    } else if (ptrs.size === 1) {
      const [p] = [...ptrs.values()];
      drag = { x0: p.x, y0: p.y, ox: x, oy: y, active: true };
    }
  };
  pan.addEventListener("pointerup", up);
  pan.addEventListener("pointercancel", up);
  // a drag that ends over a node is not a tap on it
  pan.addEventListener("click", (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
  pan.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = size();
    const unit = e.deltaMode === 1 ? 16 : 1;
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016)));
  }, { passive: false });

  return {
    get k() { return k; },
    get x() { return x; },
    get y() { return y; },
    set({ nx = x, ny = y, nk = k }, { animate = false } = {}) {
      if (animate) ease();
      x = nx; y = ny; k = clampK(nk);
      apply();
    },
    zoomBy(f) {
      const r = size();
      ease();
      zoomAt(r.width / 2, r.height / 2, f);
    },
    panBy(dx, dy) { ease(); x += dx; y += dy; apply(); },
    // the least movement that brings the tree point (wx, wy) into the part of the screen not covered by the card
    reveal(wx, wy, { bottom = 0, margin = 64 } = {}) {
      const r = size();
      const sx = x + wx * k, sy = y + wy * k;
      const maxX = r.width - margin, maxY = Math.max(margin + 20, r.height - bottom - margin);
      const dx = sx < margin ? margin - sx : sx > maxX ? maxX - sx : 0;
      const dy = sy < margin ? margin - sy : sy > maxY ? maxY - sy : 0;
      if (dx || dy) { ease(); x += dx; y += dy; apply(); }
    },
    apply,
  };
}

// ---------- the screen ----------
export function techScreen(A, { onClose } = {}) {
  const M = A.M;
  const ico = A.ico;
  const view = () => A.S.view.view;
  const engine = A.meta.engine || {};
  const { tree, rules, colour, tribeName, st } = techSetup(A);
  const unitById = new Map((engine.units || []).map((u) => [u.id, u]));
  const imprById = new Map((engine.improvements || []).map((i) => [i.id, i]));
  const tenths = (n) => (Number.isInteger(n / 10) ? String(n / 10) : (n / 10).toFixed(1));

  // what the player has, read again on every update
  let done, avail, stars;
  const read = () => {
    st.read();
    ({ done, avail, stars } = st);
  };
  read();
  const { price, stateOf } = st;

  // ----- the DOM
  const world = h("div", { class: "tech-world" });
  const lines = document.createElementNS(SVG, "svg");
  lines.setAttribute("class", "tech-lines");
  lines.setAttribute("width", "1");
  lines.setAttribute("height", "1");
  world.append(lines);
  const pan = h("div", { class: "tech-pan", tabindex: "0", "aria-label": "Tech tree. Drag to move, pinch or scroll to zoom." }, world);
  const card = h("div", { class: "tech-card", hidden: true, role: "region", "aria-label": "Tech details" });
  const starsEl = h("span", { class: "tech-stars" });
  const hintEl = h("span", { class: "muted tech-hint" });
  const close = () => { screen.remove(); document.removeEventListener("keydown", onKey, true); if (onClose) onClose(); };
  const zoomBtn = (label, text, onclick, extra = {}) => h("button", { type: "button", class: "btn tech-zbtn", "aria-label": label, onclick, ...extra }, text);
  const stage = h("div", { class: "tech-stage" }, pan,
    h("div", { class: "tech-zoom" },
      zoomBtn("Zoom in", "+", () => pz.zoomBy(1.3), { "data-act": "zoom-in" }),
      zoomBtn("Zoom out", "−", () => pz.zoomBy(1 / 1.3), { "data-act": "zoom-out" }),
      zoomBtn("Centre the tree", "⌖", () => home(true), { "data-act": "tech-home" })),
    card);
  const screen = h("div", { class: "tech-wrap tech-screen", role: "dialog", "aria-label": "Tech tree", style: `--tribe:${colour}` },
    h("div", { class: "tech-top" },
      h("button", { type: "button", class: "icon-btn tech-back", "aria-label": "Close the tech tree", "data-act": "tech-close", onclick: close }, "×"),
      h("strong", { class: "tech-title" }, "Technology"),
      h("span", { class: "grow" }), starsEl),
    h("div", { class: "tech-sub" }, hintEl),
    stage);

  // the lines first (under the circles), then the circles
  const edges = [];
  for (const n of tree.nodes.values()) for (const p of n.parents) {
    const a = tree.nodes.get(p);
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y); line.setAttribute("x2", n.x); line.setAttribute("y2", n.y);
    lines.append(line);
    edges.push({ line, from: a, to: n });
  }

  const els = new Map();
  const coreEl = (() => {
    return h("div", { class: "tech-core", style: `left:${-CORE / 2}px;top:${-CORE / 2}px`, "aria-hidden": "true" },
      ico.unit(rules.starting_unit, tribeName, tribeName),
      h("span", { class: "tech-label tech-core-label" }, M.tribeName(view().me.tribe)));
  })();
  world.append(coreEl);
  for (const n of tree.nodes.values()) {
    if (n.t.idx === tree.root) continue;
    const up = n.y < -DISC / 2; // names go on the outer side of a circle: above in the upper half
    const el = h("button", { type: "button", class: `tech-node${up ? " up" : ""}`, style: `left:${n.x - DISC / 2}px;top:${n.y - DISC / 2}px`, "data-tech": n.t.idx, "data-id": n.t.id, "data-up": up ? "1" : null, "aria-label": M.techName(n.t.idx), onclick: () => show(n.t.idx) },
      h("span", { class: "tech-disc" }, ico.tech(n.t.id, M.techName(n.t.idx))),
      h("span", { class: "tech-badge" }),
      h("span", { class: "tech-meta" },
        h("span", { class: "tech-label" }, M.techName(n.t.idx)),
        h("span", { class: "tech-price" }, ico.star(), h("b", {}, ""))));
    els.set(n.t.idx, el);
    world.append(el);
  }

  let selected = null;
  function refreshNodes() {
    read();
    const can = A.S.g.research.length;
    starsEl.replaceChildren(ico.star(), h("b", {}, String(stars)));
    starsEl.setAttribute("aria-label", `${stars} stars`);
    hintEl.textContent = can ? `${can} can be researched` : A.myTurn() ? "Nothing you can pay for yet" : "You can research on your turn";
    for (const n of tree.nodes.values()) {
      const el = els.get(n.t.idx);
      if (!el) continue;
      const st = stateOf(n);
      el.dataset.state = st;
      el.className = `tech-node ${st}${el.dataset.up ? " up" : ""}${selected === n.t.idx ? " sel" : ""}`;
      el.querySelector(".tech-price b").textContent = String(price(n));
      const badge = el.querySelector(".tech-badge");
      badge.replaceChildren(st === "done" ? "✓" : st === "locked" ? ico.icon("icon/padlock", "L") : "");
      el.setAttribute("aria-label", `${M.techName(n.t.idx)}, ${st === "done" ? "researched" : st === "available" ? `${price(n)} stars, can be researched` : st === "expensive" ? `${price(n)} stars, too expensive` : "locked"}`);
    }
    for (const e of edges) {
      const a = done.has(e.from.t.idx), b = done.has(e.to.t.idx);
      e.line.setAttribute("class", a && b ? "full" : a ? "next" : "");
    }
  }

  // ----- the card
  const statLine = (u) => `Health ${tenths(u.health)} · Attack ${tenths(u.attack)} · Defence ${tenths(u.defence)} · Move ${u.movement}${u.range > 1 ? ` · Range ${u.range}` : ""} · ${u.cost} stars`;
  function unlockRow(kind, id) {
    const name = pretty(id);
    let pic, detail = "";
    if (kind === "unit") {
      const u = unitById.get(id);
      pic = ico.unit(id, tribeName, name);
      if (u) detail = statLine(u);
    } else if (kind === "building") {
      const i = imprById.get(id);
      pic = ico.improvement(id, tribeName, name);
      if (i && i.cost) detail = `Costs ${i.cost} stars`;
    } else if (kind === "tech") {
      pic = ico.tech(id, name);
      detail = "Opens up when you research this";
    } else {
      pic = h("span", { class: "g-ico g-ico-fb", "aria-hidden": "true" }, "✦");
      detail = "A new ability";
    }
    const more = h("span", { class: "tech-unlock-more muted", hidden: true }, detail);
    const row = h("button", { type: "button", class: `tech-unlock tech-unlock-${kind}`, onclick: () => { more.hidden = !more.hidden; row.setAttribute("aria-expanded", String(!more.hidden)); if (kind === "tech") jump(id); } },
      pic, h("span", { class: "tech-unlock-name" }, kind === "tech" ? `Leads to ${name}` : name), more);
    row.setAttribute("aria-expanded", "false");
    return row;
  }

  function show(idx) {
    const n = tree.nodes.get(idx);
    if (!n) return;
    selected = idx;
    refreshNodes();
    const st = stateOf(n), cmd = avail.get(idx), p = price(n);
    const t = n.t;
    const rows = [
      ...(t.units || []).filter((u) => u !== "none").map((u) => unlockRow("unit", u)),
      ...(t.improvements || []).filter((i) => i !== "none").map((i) => unlockRow("building", i)),
      ...(t.abilities || []).map((a) => unlockRow("ability", a)),
      ...n.children.map((c) => unlockRow("tech", tree.nodes.get(c).t.id)),
    ];
    let reason = "";
    if (st === "done") reason = "Already researched.";
    else if (st === "locked") reason = `Research ${n.parents.filter((q) => !done.has(q)).map((q) => M.techName(q)).join(" or ")} first.`;
    else if (st === "expensive") reason = `You need ${p} stars and have ${stars}.`;
    else if (!cmd) reason = A.myTurn() ? "You cannot research this now." : "You can research on your turn.";
    const can = !!cmd && A.myTurn();
    card.hidden = false;
    card.dataset.tech = String(idx);
    card.replaceChildren(
      h("div", { class: "tech-card-head" },
        h("span", { class: "tech-card-pic" }, ico.tech(t.id, M.techName(idx))),
        h("span", { class: "tech-card-name" }, h("strong", {}, M.techName(idx)), h("span", { class: "muted" }, `Tier ${t.cost}`)),
        st === "done" ? h("span", { class: "tech-done" }, "✓ Researched") : h("span", { class: "g-cost tech-card-price" }, ico.star(), h("b", {}, String(p))),
        h("button", { type: "button", class: "icon-btn tech-card-x", "aria-label": "Close details", onclick: hideCard }, "×")),
      rows.length ? h("div", { class: "tech-unlocks" }, h("span", { class: "g-h" }, "Unlocks"), rows) : h("p", { class: "muted" }, "Unlocks nothing new."),
      reason ? h("p", { class: "muted tech-reason", "data-reason": st }, reason) : null,
      st === "done" ? null : h("div", { class: "g-actions end" },
        h("button", { type: "button", class: "btn primary", "data-act": "research", disabled: can ? null : true, onclick: () => { close(); A.act(cmd); } },
          "Research", " ", ico.star(), String(p))));
    requestAnimationFrame(() => pz.reveal(n.x, n.y, { bottom: card.offsetHeight }));
  }
  function hideCard() {
    selected = null;
    card.hidden = true;
    refreshNodes();
  }
  function jump(id) {
    const t = M.techById.get(id);
    if (t && tree.nodes.has(t.idx)) show(t.idx);
  }

  // ----- pan and zoom
  const pz = panZoom(pan, world, { extent: tree.extent, onBackgroundTap: () => { if (!card.hidden) hideCard(); } });
  function home(animate) {
    const r = pan.getBoundingClientRect();
    const fit = Math.min(r.width, r.height) / (2 * tree.extent);
    const k = Math.min(OPEN_MAX_K, Math.max(OPEN_MIN_K, fit));
    pz.set({ nx: r.width / 2, ny: r.height / 2, nk: k }, { animate });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!card.hidden) hideCard(); else close();
    } else if (e.target === pan) {
      const step = 70;
      const move = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (move) { pz.panBy(...move); e.preventDefault(); }
      else if (e.key === "+" || e.key === "=") { pz.zoomBy(1.3); e.preventDefault(); }
      else if (e.key === "-" || e.key === "_") { pz.zoomBy(1 / 1.3); e.preventDefault(); }
    }
  }
  document.addEventListener("keydown", onKey, true);

  document.body.append(screen);
  refreshNodes();
  home(false);
  new ResizeObserver(() => pz.apply()).observe(pan);
  pan.focus({ preventScroll: true });

  return {
    el: screen,
    close,
    get closed() { return !screen.isConnected; },
    update() {
      refreshNodes();
      if (!card.hidden && selected != null) show(selected);
    },
    show,
    layout: tree,
  };
}
