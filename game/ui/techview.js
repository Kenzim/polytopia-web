// Game mode's tech tree, drawn on the HUD canvas as retail's TechView: a black starfield over the board, the tribe's head
// at the centre and the techs on circles round it, one branch for each tier-1 tech, joined by lines. Researched techs are
// green, those you can research blue with a white ring and their price, locked ones a grey ring with the name only. The
// top bar stays over the tree, the white back button closes it, a drag (with momentum) or the wheel pans it. Tapping a
// tech opens the black card (screens.js popup) with what it unlocks and RESEARCH.
//
// The tree and the tech states come from techtree.js (`techSetup`), the same as the HTML tree technical mode shows; this
// file only draws them. Wording from the game's strings (`tr`) where it has them.

// retail's spacing (TechView.NODE_DIAMETER 120 and NODE_SPACE 140): a circle is 100 u here, as measured on Kenzi's phone
// screenshot (2026-10-23), so a tech is 100 * 140 / 120 u from the one that unlocks it. techtree.js places them (`link`).
const LAYOUT = { link: (100 * 140) / 120, disc: 100, pad: 0 };
const D = LAYOUT.disc;
// a tech's name under its icon: its size in a 100 u circle (retail's "Organization" is 0.63 of the circle wide), how far
// below the centre it sits (in radii) and the widest it may be (in diameters), which is the circle's width down there
const LABEL = { size: 11, dy: 0.5, width: 0.74 };
// What a circle shows (retail's TechItem.SetupComplete): a picture of each thing the tech unlocks, in a row across the
// middle, each fitted into a square. In retail's units, where the circle's blue is 115 across: the row is 101 wide with
// 5 between the squares, so a square is (101 - 5n) / n for n pictures, in whole units, and never over the row's 45 high.
const PICTURES = { fill: 115, row: 101, gap: 5, most: 45 };
// the buildings that are an action on a tile and have no art of their own: retail shows what they work on, or their sign
const ACTION_ART = {
  hunting: (tribe) => [`resource/game/${tribe}`], harvestfruit: (tribe) => [`resource/fruit/${tribe}`],
  fishing: () => ["resource/fish"], starfishing: () => ["resource/starfish"], road: () => ["icon/road"],
  burnforest: () => ["icon/burn_forest"], clearforest: () => ["icon/clear_forest"], growforest: () => ["icon/grow_forest"],
};
const COLOURS = {
  done: "#00cc34", // sampled from the screenshot
  available: "#25a8ff",
  expensive: "#1b5c8c", // not in the screenshot: a darker blue (default, Kenzi to confirm)
  lockedRing: "#585858",
  lockedText: "#8c8c8c",
  line: "#656565",
};
const RING_MS = 600; // the white ring that grows out of a tech once its research lands; the tree stays open (Kenzi)
const PARALLAX = 0.35; // the starfield moves slower than the tree (UIStarBg.moveMultiplier)

export function createTechView(env) {
  const { A, scr, TT, pretty, hud } = env;
  const { tr, fmt } = scr;
  const tenths = (n) => (Number.isInteger(n / 10) ? String(n / 10) : (n / 10).toFixed(1));
  const techName = (t) => tr(`technology.names.${t.id}`, pretty(t.id));

  // the stars behind the tree: fixed points in a tile repeated over the screen
  const SKY = (() => {
    let seed = 20261023;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: 70 }, () => [rnd(), rnd(), 0.8 + rnd() * 1.4, 0.3 + rnd() * 0.6]);
  })();

  function open({ onClose } = {}) {
    const { tree, tribeName, colour, st } = TT.techSetup(A, LAYOUT); // colour: the viewer's, for the unit pictures
    const engine = A.meta.engine || {};
    const unitById = new Map((engine.units || []).map((u) => [u.id, u]));
    const imprById = new Map((engine.improvements || []).map((i) => [i.id, i]));
    let pending = null; // a research sent from here: {idx, t0, t1 (when it showed as done)}

    // The art for one thing a tech unlocks, `[kind, name]` from /api/meta's `tech_pictures`, as manifest keys to try in
    // order (TechItem.GetUnlockItems): a unit in the tribe's dress, a building, the tribe's tile for terrain it can now
    // enter, UI_bonus_<terrain> for terrain that now defends, UI_<ability> for an ability and UI_task for a task.
    function artOf([kind, name]) {
      if (kind === "unit") return [`unit/${tribeName}/${name}`, `icon/${name}_icon`];
      if (kind === "improvement") return ACTION_ART[name] ? ACTION_ART[name](tribeName) : [`improvement/${name}/${tribeName}`, `improvement/${name}`, `icon/${name}`];
      if (kind === "move") return [`tile/${tribeName}/${name}`];
      if (kind === "defence") return [`icon/bonus_${name}`];
      if (kind === "task") return ["icon/task"];
      return [`icon/${name}`];
    }
    // the pictures in a tech's circle, each the manifest key of its art; what has no art is left out
    const all = A.meta.tech_pictures || {};
    const shown = new Map();
    function picturesOf(t) {
      let keys = shown.get(t.id);
      if (!keys) {
        const items = (all[tribeName] || {})[t.id] || (all[""] || {})[t.id] || [];
        keys = items.map((it) => artOf(it).find((k) => hud.layers.g.art.has(k))).filter(Boolean);
        shown.set(t.id, keys);
      }
      return keys;
    }
    // where they go in a circle `d` across centred on (x, y): [{key, x, y, size}], the centre and side of each square
    function pictureBoxes(t, x, y, d) {
      const keys = picturesOf(t), n = keys.length, unit = d / PICTURES.fill;
      if (!n) return [];
      const side = Math.min(Math.floor((PICTURES.row - PICTURES.gap * n) / n), PICTURES.most) * unit, step = side + PICTURES.gap * unit;
      return keys.map((key, i) => ({ key, x: x + (i - (n - 1) / 2) * step, y, size: side }));
    }

    function sky(g, L) {
      const ctx = g.ctx, T = g.u(360);
      const ox = ((-L.scroll.x * PARALLAX) % T + T) % T - T, oy = ((-L.scroll.y * PARALLAX) % T + T) % T - T;
      ctx.fillStyle = "#fff";
      for (let ty = oy; ty < g.H; ty += T) for (let tx = ox; tx < g.W; tx += T) {
        for (const [px, py, r, a] of SKY) {
          ctx.globalAlpha = a * (L.closed ? 0.6 : 1);
          ctx.fillRect(tx + px * T, ty + py * T, r, r);
        }
      }
      ctx.globalAlpha = 1;
    }

    // a tech's circle in its state, centred on (x, y), `d` across
    function disc(g, n, state, x, y, d, o = {}) {
      const ctx = g.ctx, r = d / 2, f = d / g.u(D); // f: text and icons scale with the circle
      const big = (v) => v * f;
      if (state === "locked") {
        g.circle(x, y, r, "#000", COLOURS.lockedRing, g.u(2.6) * f);
        g.text(techName(n.t), x, y, { size: big(LABEL.size), align: "center", baseline: "middle", colour: COLOURS.lockedText, maxWidth: (d * 0.86) / g.k, minSize: 7 });
        return;
      }
      if (state === "done") g.circle(x, y, r, COLOURS.done);
      else {
        g.circle(x, y, r, state === "expensive" ? COLOURS.expensive : COLOURS.available);
        g.circle(x, y, r + g.u(1), null, state === "expensive" ? "rgba(255,255,255,0.55)" : "#fff", g.u(3.2) * f);
      }
      const boxes = pictureBoxes(n.t, x, y, d);
      for (const b of boxes) g.icon([b.key], b.x, b.y, b.size, { centred: true, colour });
      if (!boxes.length) g.icon([`tech/${n.t.id}`], x, y, d * 0.39); // no list of what it unlocks: its one extracted icon
      g.text(techName(n.t), x, y + r * LABEL.dy, { size: big(LABEL.size), align: "center", baseline: "middle", maxWidth: (d * LABEL.width) / g.k, minSize: 7, shadow: { dy: 1, colour: "rgba(0,0,0,0.35)" } });
      if (state !== "done" && !o.noPrice) {
        const p = String(st.price(n)), sw = g.u(15) * f, tw = g.measure(p, { size: big(17) });
        const left = x - (sw + g.u(4) + tw) / 2, py = y - r * 0.6;
        g.icon(["icon/staricon", "icon/star", "icon/resource"], left + sw / 2, py, sw);
        g.text(p, left + sw + g.u(4), py, { size: big(17), baseline: "middle", colour: state === "expensive" ? "rgba(255,255,255,0.7)" : "#fff", shadow: { dy: 1, colour: "rgba(0,0,0,0.3)" } });
      }
    }

    function stateLabel(n, state) {
      const name = techName(n.t);
      if (state === "done") return `${name}, researched`;
      if (state === "locked") return `${name}, locked`;
      return `${name}, ${st.price(n)} stars${state === "expensive" ? ", too expensive" : ", can be researched"}`;
    }

    const L = scr.open({
      name: "tech", kind: "screen", scroll: "xy", onClose,
      animating: () => !!pending,
      draw(g, L, t) {
        st.read();
        const ctx = g.ctx, W = g.W, H = g.H;
        ctx.fillStyle = "#000"; // retail's tree hides the board behind black space
        ctx.fillRect(0, 0, W, H);
        sky(g, L);
        // the scroll range: every circle can be brought clear of the top bar and of the note along the bottom
        const ext = tree.extent * g.k;
        const top = g.safe.top + g.u(80), bottom = g.safe.bottom + g.u(56);
        L.setScroll(2 * ext + g.u(24), 2 * ext + top + bottom, { x: 0, y: 0, w: W, h: H });
        const cx = W / 2 - L.scroll.x, cy = H / 2 - L.scroll.y;
        const at = (n) => [cx + n.x * g.k, cy + n.y * g.k];

        // the lines: grey under white (from a researched tech) under green (between two)
        const edges = [];
        for (const n of tree.nodes.values()) for (const p of n.parents) {
          const a = tree.nodes.get(p);
          const rank = st.done.has(a.t.idx) ? (st.done.has(n.t.idx) ? 2 : 1) : 0;
          edges.push({ a, b: n, rank });
        }
        edges.sort((e, f) => e.rank - f.rank);
        ctx.lineWidth = g.u(3);
        ctx.lineCap = "round";
        for (const e of edges) {
          const [x1, y1] = at(e.a), [x2, y2] = at(e.b);
          ctx.strokeStyle = [COLOURS.line, "#fff", COLOURS.done][e.rank];
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }

        // the tribe at the centre
        g.icon([`head/${tribeName}`, "head/head"], cx, cy, g.u(D * 1.75));

        const d = g.u(D), r = d / 2;
        for (const n of tree.nodes.values()) {
          if (n.t.idx === tree.root) continue;
          const [x, y] = at(n);
          const state = st.stateOf(n);
          const id = `tech:${n.t.id}`;
          if (x + r > 0 && x - r < W && y + r > 0 && y - r < H) {
            const s = g.pressed(id) ? 0.94 : 1;
            disc(g, n, state, x, y, d * s);
            // a research that just landed: a white ring grows out of the circle
            if (pending && pending.idx === n.t.idx && pending.t1) {
              const p = Math.min(1, (t - pending.t1) / RING_MS);
              ctx.save();
              ctx.globalAlpha *= 1 - p;
              g.circle(x, y, r * (1 + 0.35 * p), null, "#fff", g.u(4));
              ctx.restore();
            }
          }
          g.hit({ id, label: stateLabel(n, state), state, x: x - r, y: y - r, w: d, h: d, round: true, onTap: () => details(n) });
        }

        // retail's note along the bottom (TechView.infoText)
        const lit = fmt(tr("techview.info.literacy", "{1} reduces the price of all technologies by {0}%!"), "33", tr("player.abilities.literacy", "Literacy"));
        const note = { size: 15, align: "center", baseline: "middle", maxWidth: (W - g.u(24)) / g.k, minSize: 10, shadow: { dy: 1, colour: "rgba(0,0,0,0.9)" } };
        g.text(tr("techview.info", "Tech costs increase for each city in your empire."), W / 2, H - g.safe.bottom - g.u(40), note);
        g.text(lit, W / 2, H - g.safe.bottom - g.u(20), note);

        g.bar();
        g.back(L, { label: "Close the tech tree" });

        // after a research: once the tech shows as researched its ring plays, and the tree stays open for the next one
        if (pending) {
          if (!pending.t1 && st.done.has(pending.idx)) pending.t1 = t;
          if (pending.t1 && t - pending.t1 > RING_MS) pending = null;
          else if (!pending.t1 && t - pending.t0 > 10000) pending = null; // the command failed: stay
        }
      },
    });
    L.update = () => L.invalidate();

    // ---------- the card ----------
    const statLine = (u) => `Health ${tenths(u.health)}, attack ${tenths(u.attack)}, defence ${tenths(u.defence)}, move ${u.movement}${u.range > 1 ? `, range ${u.range}` : ""}, ${u.cost} stars`;
    function unlocks(n) {
      const t = n.t, out = [];
      for (const id of t.units || []) {
        if (id === "none") continue;
        const u = unitById.get(id);
        out.push({ icon: [`icon/${id}_icon`, `unit/${tribeName}/${id}`], name: tr(`unit.names.${id}`, pretty(id)), detail: u ? statLine(u) : "" });
      }
      for (const id of t.improvements || []) {
        if (id === "none") continue;
        const i = imprById.get(id);
        const bname = tr(`building.names.${id}`, pretty(id));
        out.push({ icon: [...artOf(["improvement", id]), `icon/${id}_icon`], fit: true, name: bname, detail: [fmt(tr("technology.build", "{0} makes it possible to build {1}"), techName(t), bname), i && i.cost ? `${i.cost} stars` : ""].filter(Boolean).join(", ") });
      }
      for (const id of t.abilities || []) {
        let detail = fmt(tr(`tooltip.ability.${id}`, ""), "33"); // only Literacy's has a number: its 33% off
        if (!detail && id !== "literacy") detail = "A new ability";
        out.push({ icon: [`icon/${id}`], name: tr(`player.abilities.${id}`, pretty(id)), detail });
      }
      for (const c of n.children) {
        const ct = tree.nodes.get(c).t;
        out.push({ icon: [picturesOf(ct)[0], `tech/${ct.id}`], fit: true, name: techName(ct), detail: "Leads to this tech" });
      }
      return out;
    }

    function details(n) {
      const name = techName(n.t);
      const items = unlocks(n);
      const g0 = hud.layers.g;
      const card = () => Math.min(g0.W - g0.u(28), g0.u(372)) - 2 * g0.u(24); // the card's inner width (screens.js popup)
      const detailO = { font: g0.fonts.body, size: 14, lineHeight: 17 };
      const rowH = (it, inner) => Math.max(48, 30 + (it.detail ? g0.paraHeight(it.detail, inner - g0.u(56), detailO) / g0.k : 0) + 6);
      return scr.popup("tech-info", (P) => {
        st.read();
        const state = st.stateOf(n), cmd = st.avail.get(n.t.idx), price = st.price(n);
        const can = !!cmd && A.myTurn();
        let reason = "";
        if (state === "done") reason = tr("techview.completed.info", "You have already researched this technology.");
        else if (state === "locked") reason = fmt(tr("techview.locked.info", "You must research {0} before you can learn {1}."), n.parents.filter((q) => !st.done.has(q)).map((q) => techName(tree.nodes.get(q).t)).join(" or "), name);
        else if (state === "expensive") reason = tr("techview.expensive.info", "You don't have enough stars to buy this. Tap 'next turn' to get more stars.");
        else if (!cmd) reason = A.myTurn() ? "You cannot research this now." : "You can research on your turn.";
        const inner = card();
        const hs = items.map((it) => rowH(it, inner));
        const research = () => { P.close(); pending = { idx: n.t.idx, t0: performance.now(), t1: 0 }; A.act(cmd); L.invalidate(); };
        P.state.research = can ? research : null;
        return [
          { kind: "image", h: 150, draw: (g, x, y, w, h) => {
            const ctx = g.ctx;
            const grad = ctx.createLinearGradient(0, y, 0, y + h);
            grad.addColorStop(0, "#10182a"); grad.addColorStop(1, "#000");
            ctx.fillStyle = grad; ctx.fillRect(x, y, w, h);
            disc(g, n, state, x + w / 2, y + h / 2 + g.u(6), g.u(118), { noPrice: true });
          } },
          { kind: "gap", h: 6 },
          { kind: "image", h: 44, draw: (g, x, y, w) => {
            const pad = g.u(24), cy = y + g.u(26);
            const right = x + w - pad;
            let pw = 0;
            if (state === "done") pw = g.measure(tr("techview.completed", "(completed)"), { size: 18 }) + g.u(8);
            else pw = g.u(22) + g.measure(String(price), { font: g.fonts.numbers, size: 26 }) + g.u(8);
            g.text(name, x + pad, cy, { size: 30, bold: true, baseline: "middle", maxWidth: (w - 2 * pad - pw) / g.k, minSize: 14 });
            if (state === "done") g.text(tr("techview.completed", "(completed)"), right, cy, { size: 18, align: "right", baseline: "middle", colour: COLOURS.done });
            else {
              const tw = g.measure(String(price), { font: g.fonts.numbers, size: 26 });
              g.icon(["icon/staricon", "icon/star"], right - tw - g.u(12), cy, g.u(20));
              g.text(String(price), right, cy, { font: g.fonts.numbers, size: 26, align: "right", baseline: "middle", colour: state === "expensive" ? "rgba(255,255,255,0.6)" : "#fff" });
            }
          } },
          items.length ? { kind: "text", text: tr("technology.intro", "This tech will enable the following:"), size: 17, colour: "rgba(255,255,255,0.8)", after: 4 } : null,
          items.length ? { kind: "image", h: hs.reduce((a, b) => a + b, 0) + 4, draw: (g, x, y, w) => {
            let yy = y;
            const ix = x + g.u(24);
            items.forEach((it, i) => {
              const h = g.u(hs[i]);
              g.circle(ix + g.u(20), yy + g.u(24), g.u(20), "rgba(255,255,255,0.1)");
              if (it.fit) g.icon(it.icon, ix + g.u(20), yy + g.u(24), g.u(28), { centred: true, colour }); // the board's art, inside the circle
              else g.icon(it.icon, ix + g.u(20), yy + g.u(24), g.u(36), { colour });
              g.text(it.name, ix + g.u(52), yy + g.u(16), { size: 19, bold: true, baseline: "middle", maxWidth: (inner - g.u(56)) / g.k, minSize: 11 });
              if (it.detail) g.para(it.detail, ix + g.u(52), yy + g.u(28), inner - g.u(56), { ...detailO, colour: "rgba(255,255,255,0.75)" });
              yy += h;
            });
          } } : null,
          reason ? { kind: "text", text: reason, size: 16, colour: "rgba(255,255,255,0.75)", after: 2 } : null,
          { kind: "pills", items: state === "done"
            ? [{ id: "ok", label: tr("buttons.ok", "OK"), onTap: () => P.close() }]
            : [
              { id: "cancel", label: tr("buttons.back", "BACK"), fill: g0.COLOURS.off, onTap: () => P.close() },
              { id: "research", label: tr("techview.research", "RESEARCH"), aria: `Research ${name} for ${price} stars`, enabled: can, size: 21, onTap: research },
            ] },
        ].filter(Boolean);
      }, { onEnter: (P) => { if (P.state.research) P.state.research(); else P.close(); }, state: { tech: n.t.id } });
    }

    L.details = (id) => { const t = A.M.techById.get(id); const n = t && tree.nodes.get(t.idx); return n ? details(n) : null; };
    // what a tech's circle shows, for tests: the art keys in order with each one's square in units of the circle's width
    L.pictures = (id) => { const t = A.M.techById.get(id); return t ? pictureBoxes(t, 0, 0, 1).map((b) => ({ key: b.key, x: b.x, size: b.size })) : null; };
    return L;
  }

  return { open };
}
