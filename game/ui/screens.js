// Game mode's screens and popups, drawn on the HUD canvas (ui/layers.js) in the retail look: the Settings and Game Stats
// screens over the dimmed board with the white back button, and the black BasicPopup cards (a tribe met, a peace offer,
// the end turn warning, a city's level up, confirms, the end of the game). Wording from the game's own strings
// (strings.json, from tools/extract_assets/strings.py) where it has them.
//
// Each opener returns the layer (`closed`, `close()`), so game.js keeps it as it kept the HTML sheet. `env.onClose(L)`
// runs when any of them closes.

const ORDINALS = ["1st", "2nd", "3rd"];
const ordinal = (n) => ORDINALS[n - 1] || `${n}th`;
const MODE_ICON = { might: "icon/might", perfection: "icon/perfection", domination: "icon/domination" };
const REWARD_ICON = {
  Resources: "icon/rewards_resources", PopulationGrowth: "icon/rewards_populationgrowth", BorderGrowth: "icon/rewards_bordergrowth",
  Explorer: "icon/rewards_explorer", Workshop: "icon/rewards_workshop", CityWall: "icon/rewards_citywall", Park: "icon/rewards_park",
  SuperUnit: "icon/giant_icon",
};

export function createScreens(env) {
  const { hud, A, strings = {}, pretty, rewardText, num } = env;
  const M = () => A.M;
  const V = () => A.S.view.view;
  const fmt = (s, ...args) => String(s).replace(/\{(\d)\}/g, (m, i) => (args[i] ?? ""));
  // the game's string for `key`; placeholders are filled only when args are given, so `fmt(tr(k, fb), x)` works too
  const tr = (key, fallback, ...args) => { const s = strings[key] ?? fallback; return (args.length ? fmt(s, ...args) : String(s)).trim(); };

  function open(spec) {
    const L = hud.open({
      ...spec,
      onClose: (r) => { if (spec.onClose) spec.onClose(r); env.onClose(L, r); },
    });
    return L;
  }

  // ---------- the black card (retail BasicPopup) ----------
  // blocks: {image}, {title}, {text}, {rows}, {pills}, {round}, {choices}, {list}, {gap}
  function blockH(g, b, inner) {
    switch (b.kind) {
      case "image": return g.u(b.h || 170);
      case "title": return g.u(b.size ? b.size * 1.5 : 50);
      case "text": return g.paraHeight(b.text, inner, { font: g.fonts.body, size: b.size || 19 }) + g.u(b.after ?? 10);
      case "rows": return b.rows.length * g.u(30) + g.u(8);
      case "pills": return g.u(70);
      case "round": return g.u(b.d || 100) + g.u(b.label ? 52 : 26);
      case "choices": return g.u(172);
      case "list": return b.items.length * g.u(44) + g.u(8);
      case "gap": return g.u(b.h || 10);
      default: return 0;
    }
  }

  function drawBlock(g, L, b, x, y, w, inner, pad) {
    const ix = x + pad;
    switch (b.kind) {
      case "image": b.draw(g, x, y, w, g.u(b.h || 170)); break;
      case "title": {
        const size = b.size || 34;
        const cy = y + g.u(size * 0.85);
        const tw = g.measure(b.text, { size, bold: true });
        const maxT = b.chip ? inner * 0.6 : inner;
        const drawn = g.text(b.text, ix, cy, { size, bold: true, baseline: "alphabetic", maxWidth: maxT / g.k, minSize: 16 });
        if (b.chip) chip(g, b.chip, ix + Math.min(tw, (drawn && drawn.w) || tw) + g.u(12), cy - g.u(10), inner - Math.min(tw, maxT) - g.u(12));
        break;
      }
      case "text": g.para(b.text, b.centre ? x + w / 2 : ix, y, inner, { font: g.fonts.body, size: b.size || 19, colour: b.colour || "#fff", align: b.centre ? "center" : "left" }); break;
      case "rows": {
        let yy = y + g.u(15);
        for (const [k, v] of b.rows) {
          g.text(k, ix, yy, { size: 18, baseline: "middle", colour: "rgba(255,255,255,0.75)" });
          g.text(String(v), ix + inner, yy, { font: g.fonts.body, size: 18, baseline: "middle", align: "right", maxWidth: (inner * 0.6) / g.k, minSize: 10 });
          yy += g.u(30);
        }
        break;
      }
      case "pills": {
        const n = b.items.length, gap = g.u(12);
        const pw = Math.min(g.u(170), (inner - gap * (n - 1)) / n), ph = g.u(50);
        let px = x + (w - (pw * n + gap * (n - 1))) / 2;
        for (const it of b.items) {
          g.pill({ ...it, x: px, y: y + g.u(8), w: pw, h: ph, size: it.size || 24 });
          px += pw + gap;
        }
        break;
      }
      case "round": {
        const d = g.u(b.d || 100);
        g.round({ id: b.id, cx: x + w / 2, cy: y + g.u(6) + d / 2, d, fill: b.fill || g.COLOURS.blue, ringColour: "#fff", text: b.text, textFont: b.textFont || g.fonts.label, textSize: b.textSize || 34, icon: b.icon, label: b.label, aria: b.aria || b.text || b.label, onTap: b.onTap, drawInside: b.drawInside });
        break;
      }
      case "choices": {
        const n = b.items.length, d = g.u(92);
        const slot = inner / n;
        b.items.forEach((it, i) => {
          const cx = ix + slot * (i + 0.5), cy = y + g.u(12) + d / 2;
          g.round({ id: it.id, cx, cy, d, fill: g.COLOURS.blue, icon: it.icon, iconScale: 0.78, label: it.label, labelSize: 18, labelMax: slot / g.k - 6, aria: it.label, onTap: it.onTap });
          if (it.sub) g.para(it.sub, cx, cy + d / 2 + g.u(30), slot - g.u(8), { font: g.fonts.body, size: 14, align: "center", colour: "rgba(255,255,255,0.8)", lineHeight: 16 });
        });
        break;
      }
      case "list": {
        let yy = y + g.u(4);
        for (const it of b.items) {
          const rh = g.u(44);
          if (it.me) g.rr(ix - g.u(6), yy, inner + g.u(12), rh, g.u(6), g.COLOURS.blue);
          g.circle(ix + g.u(10), yy + rh / 2, g.u(7), it.colour || "#888");
          g.text(it.name, ix + g.u(26), yy + rh / 2, { size: 21, bold: true, baseline: "middle", maxWidth: (inner * 0.66) / g.k, minSize: 12 });
          g.text(it.right, ix + inner, yy + rh / 2, { font: g.fonts.numbers, size: 22, baseline: "middle", align: "right" });
          yy += rh;
        }
        break;
      }
      default: break;
    }
  }

  // a tribe's chip: its colour, its head, its name (the retail "You meet [Zebasi]")
  function chip(g, c, x, cy, maxW) {
    const h = g.u(30), hd = g.u(24);
    const tw = Math.min(g.measure(c.text, { size: 19 }), maxW - hd - g.u(22));
    const w = hd + tw + g.u(20);
    g.rr(x, cy - h / 2, w, h, h / 2, c.colour || "#888");
    if (c.head) g.icon(c.head, x + g.u(6) + hd / 2, cy, hd);
    g.text(c.text, x + g.u(10) + hd, cy, { size: 19, baseline: "middle", maxWidth: tw / g.k, minSize: 10, shadow: { dy: 1, colour: "rgba(0,0,0,0.35)" } });
  }

  // a popup card: the blocks stacked in a black rounded card in the middle of the screen; a card taller than the screen
  // scrolls. `o.width` caps the card's width (u).
  function popup(name, blocks, o = {}) {
    return open({
      name, kind: "popup", dismiss: o.dismiss !== false, scroll: "y",
      onBack: o.onBack, onEnter: o.onEnter, state: o.state,
      draw(g, L) {
        const list = typeof blocks === "function" ? blocks(L) : blocks;
        // what the card says, for hud.stats.layers (tests read it)
        L.texts = list.filter((b) => b.kind === "text" || b.kind === "title").map((b) => b.chip ? `${b.text} ${b.chip.text}`.trim() : b.text);
        g.dim(o.dim ?? 0.45);
        const w = Math.min(g.W - g.u(28), g.u(o.width || 372));
        const pad = g.u(24), inner = w - 2 * pad;
        const hasImage = list[0] && list[0].kind === "image";
        let total = (hasImage ? 0 : g.u(22)) + g.u(20);
        const hs = list.map((b) => { const h = blockH(g, b, inner); total += h; return h; });
        const top = g.safe.top + g.u(16), bottom = g.H - g.safe.bottom - g.u(16);
        const ch = Math.min(total, bottom - top);
        const x = (g.W - w) / 2, y = top + (bottom - top - ch) / 2;
        L.setScroll(w, total, { x, y, w, h: ch });
        const ctx = g.ctx;
        ctx.save();
        if (L.scale !== 1) { ctx.translate(g.W / 2, y + ch / 2); ctx.scale(L.scale, L.scale); ctx.translate(-g.W / 2, -(y + ch / 2)); }
        g.card(x, y, w, ch, { fill: "#000" });
        g.hit({ id: `card:${name}`, label: "", x, y, w, h: ch, inert: true });
        ctx.save();
        g.kit.roundRect(ctx, x, y, w, ch, g.u(22));
        ctx.clip();
        g.clip(x, y, w, ch, () => {
          let yy = y - L.scroll.y + (hasImage ? 0 : g.u(22));
          list.forEach((b, i) => { drawBlock(g, L, b, x, yy, w, inner, pad); yy += hs[i]; });
        });
        ctx.restore();
        ctx.restore();
      },
    });
  }

  // ---------- full screens (retail UIScreenBase): the dimmed board, the back button, a title ----------
  function screen(name, drawBody, o = {}) {
    return open({
      name, kind: "screen", scroll: "y", onBack: o.onBack, onEnter: o.onEnter, state: o.state,
      draw(g, L) {
        g.dim(0.74);
        const top = g.safe.top + g.u(84), bottom = g.H - g.safe.bottom;
        const vp = { x: 0, y: top, w: g.W, h: bottom - top };
        let end = top;
        g.clip(0, top - g.u(6), g.W, bottom - top + g.u(6), () => { end = drawBody(g, L, top - L.scroll.y); });
        L.setScroll(g.W, end + L.scroll.y - top + g.u(24), vp);
        if (o.title) g.text(o.title, g.W / 2, g.safe.top + g.u(36), { font: o.titleFont || g.fonts.thin, size: o.titleSize || 32, bold: true, align: "center", baseline: "middle", maxWidth: (g.W - g.u(150)) / g.k, minSize: 14 });
        g.back(L);
        if (o.corner) o.corner(g, L);
      },
    });
  }
  const column = (g) => Math.min(g.W - g.u(28), g.u(430));

  // ---------- Settings (retail: SETTINGS, its ON/OFF switches in threes, EXIT TO MENU) ----------
  function settings() {
    const watching = !!A.S.game.watching;
    const sw = (id, label, get, set) => ({ id, label, get, set });
    const setting = (name, label) => sw(`set:${name}`, label, () => !!A.settings[name], (on) => { A.settings[name] = on; A.saveSettings(); A.settingsChanged(name); });
    const audio = (name, label) => sw(`set:${name}`, label, () => !!A.audio()[name], (on) => A.setAudio(name, on));
    const groups = [
      [audio("effects", tr("settings.soundeffects", "Sound Effects")), audio("music", tr("settings.tribemusic", "Tribe Music")), watching ? null : setting("fast", "Fast Replays")],
      watching ? null : [setting("follow", "Follow Moves"), setting("infoOnBuild", tr("settings.info", "Info on Build")), setting("confirmEnd", tr("settings.confirm", "Confirm turn"))],
      [sw("set:ui-mode", "Game Look", () => A.uiMode === "game", (on) => A.setUiMode(on ? "game" : "technical")),
        watching ? null : setting("buildGlow", "Build Glow"),
        A.S.game.assist && V().full_position ? sw("set:fog", "Whole Map", () => !!A.S.fogOff, (on) => A.setFog(on)) : null],
    ].filter(Boolean).map((r) => r.filter(Boolean));
    const canResign = A.S.game.status === "active" && !watching;
    return screen("settings", (g, L, y) => {
      const cw = column(g), cx = g.W / 2;
      let yy = y + g.u(4);
      // retail: three switches a row, about 108 u apart, a short white rule between rows
      groups.forEach((row, i) => {
        if (i) { g.divider(cx, yy + g.u(2), g.u(205)); yy += g.u(20); }
        const slot = Math.min(cw / 3, g.u(112));
        row.forEach((it, j) => {
          const sx = cx + (j - (row.length - 1) / 2) * slot;
          g.toggle({ id: it.id, label: it.label, cx: sx, y: yy, on: it.get(), maxLabel: slot / g.k - 4, onTap: () => { it.set(!it.get()); L.invalidate(); } });
        });
        yy += g.u(80);
      });
      g.divider(cx, yy + g.u(2), g.u(205));
      yy += g.u(22);
      const pills = [
        { id: "log", label: "Game Log", onTap: () => { L.close(); A.openLog(); } },
        A.S.game.assist && A.myTurn() ? { id: "hint", label: "Hint", onTap: () => { L.close(); A.hint(); } } : null,
        { id: "exit", label: tr("settings.saveexit", "EXIT TO MENU"), onTap: () => { location.href = A.exitUrl || "/games"; } },
      ].filter(Boolean);
      for (const p of pills) {
        const pw = Math.min(cw, g.u(176));
        g.pill({ ...p, x: cx - pw / 2, y: yy, w: pw, h: g.u(40), r: 10, size: 22, minH: 44 });
        yy += g.u(52);
      }
      return yy;
    }, {
      title: `-${tr("settings.title", "SETTINGS")}-`,
      titleSize: 25,
      corner: canResign ? (g, L) => {
        const w = g.u(72), h = g.u(26);
        g.pill({ id: "resign", label: tr("onlineview.game.resign", "RESIGN"), x: g.W - g.safe.right - g.u(14) - w, y: g.safe.top + g.u(36) - h / 2, w, h, r: 8, fill: g.COLOURS.red, size: 16, minH: 44, onTap: () => { L.close(); A.resign(); } });
      } : null,
    });
  }

  // ---------- Game Stats (retail: Game mode, the map, the mode, Scores) ----------
  function playerRows() {
    const v = V(), players = (v.position.players || []).filter((p) => p.id !== 255);
    const scores = new Map(v.scores || []);
    const capitals = new Map();
    for (const t of v.position.tiles || []) if (t.capital && t.owner) capitals.set(t.owner, (capitals.get(t.owner) || 0) + 1);
    const rows = players.map((p) => ({ p, met: scores.has(p.id) || p.id === A.S.myId || !!A.S.game.watching, score: scores.get(p.id) ?? null }));
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return { rows, capitals, total: players.length };
  }
  function ruler(id) {
    const seat = A.S.game.seats.find((s) => s.player_id === id);
    if (seat && seat.user) return seat.user.username;
    return A.botName(id) || (seat && seat.kind === "bot" ? "the AI" : "nobody");
  }

  function stats() {
    const mode = A.S.game.mode || "perfection";
    const modeName = tr(`gamemode.${mode}`, pretty(mode));
    const src = A.S.game.source || {};
    const gen = src.generate || src;
    const tiles = (V().position.tiles || []).length || gen.size || "?";
    const mapType = gen.map_type ? tr(`gamesettings.map.${String(gen.map_type).toLowerCase().replace(/[^a-z]/g, "")}`, pretty(gen.map_type)) : "Custom map";
    return screen("stats", (g, L, y) => {
      const cw = column(g), cx = g.W / 2;
      let yy = y;
      g.text(fmt(tr("gamestats.gamemode", "Game mode: {0}"), modeName), cx, yy + g.u(8), { size: 22, bold: true, align: "center", baseline: "middle", maxWidth: cw / g.k, minSize: 14 });
      yy += g.u(34);
      const d = g.u(56), slot = Math.min(cw / 3, g.u(74));
      const circles = [
        { id: "map", text: String(tiles), label: mapType, onTap: () => modeInfo() },
        { id: "mode", icon: [MODE_ICON[mode] || "icon/perfection"], label: modeName, onTap: () => modeInfo() },
        { id: "more", icon: ["icon/about", "icon/info"], label: "More info", onTap: () => modeInfo() },
      ];
      circles.forEach((c, i) => g.round({ ...c, cx: cx + (i - 1) * slot, cy: yy + d / 2, d, fill: "#000", textFont: g.fonts.label, textSize: 24, textBold: true, labelSize: 13, labelMax: slot / g.k + 6, iconScale: 0.72 }));
      yy += d + g.u(40);
      g.divider(cx, yy, g.u(205));
      yy += g.u(52);
      g.text(tr("gamestatus.scores", "Scores"), cx, yy, { size: 21, align: "center", baseline: "middle" });
      yy += g.u(18);
      const { rows, capitals, total } = playerRows();
      const sw = Math.min(cw, g.u(306));
      const left = cx - sw / 2, right = cx + sw / 2;
      rows.forEach((r, i) => {
        const rh = g.u(42), p = r.p, me = p.id === A.S.myId;
        const tribe = M().tribe(p.tribe);
        if (me) g.rr(left, yy, sw, rh, 0, g.COLOURS.blue);
        const headD = g.u(32);
        let tx = left + g.u(3);
        if (r.met) {
          g.circle(tx + headD / 2, yy + rh / 2, headD / 2, M().playerColour(p));
          g.icon([`head/${tribe ? tribe.name : ""}`, "head/head"], tx + headD / 2, yy + rh / 2, headD * 0.8);
          tx += headD + g.u(8);
        }
        const name = r.met ? M().tribeName(p.tribe) : "Unknown tribe";
        const rightText = mode === "might" ? `${capitals.get(p.id) || 0}/${total}` : r.score != null ? ordinal(i + 1) : "?";
        const rw = g.measure(rightText, { font: g.fonts.numbers, size: 24 });
        const nameBox = g.text(name, tx, yy + g.u(20), { size: 23, bold: true, baseline: "alphabetic", maxWidth: (right - tx - rw - g.u(24)) / g.k, minSize: 12 });
        const nw = (nameBox && nameBox.w) || g.measure(name, { size: 23, bold: true });
        // the dotted leader to the number, as retail's
        const ctx = g.ctx;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        for (let dx = tx + nw + g.u(3); dx < right - rw - g.u(5); dx += g.u(6.5)) ctx.fillRect(dx, yy + g.u(18), Math.max(1.2, g.u(1.8)), Math.max(1.2, g.u(1.8)));
        g.text(rightText, right - g.u(2), yy + g.u(20), { font: g.fonts.numbers, size: 24, baseline: "alphabetic", align: "right" });
        const sub = r.met ? `Ruled by ${ruler(p.id)}${r.score != null ? `, score: ${num(r.score)} points` : ""}${p.alive === false ? " (out)" : ""}` : "Unknown ruler";
        g.text(sub, tx, yy + g.u(32), { font: g.fonts.body, size: 12, baseline: "middle", maxWidth: (right - tx) / g.k, minSize: 9, colour: "rgba(255,255,255,0.88)" });
        const dip = r.met && !me ? A.S.g.diplomacy.filter((c) => c.with === p.id && c.kind !== "PeaceResponse") : [];
        g.hit({ id: `tribe:${p.id}`, label: name, x: left, y: yy, w: sw, h: rh + g.u(8), enabled: !!dip.length, onTap: () => tribePopup(p, dip) });
        yy += rh + g.u(8);
      });
      const unmet = rows.filter((r) => !r.met).length;
      if (unmet && !V().over) {
        yy += g.u(6);
        yy = g.para(`${unmet === 1 ? "One tribe has" : `${unmet} tribes have`} not been met yet. Their scores appear once you meet them.`, cx, yy, cw, { font: g.fonts.body, size: 16, align: "center", colour: "rgba(255,255,255,0.7)" });
      }
      yy += g.u(16);
      g.divider(cx, yy, g.u(190));
      return yy + g.u(10);
    }, {});
  }

  function modeInfo() {
    const mode = A.S.game.mode || "perfection";
    return popup("mode-info", [
      { kind: "title", text: tr(`gamemode.${mode}`, pretty(mode)) },
      { kind: "text", text: tr(`gamemode.${mode}.description`, A.modeText()) },
      { kind: "text", text: A.modeText(), size: 16, colour: "rgba(255,255,255,0.75)" },
      { kind: "pills", items: [{ id: "ok", label: tr("buttons.ok", "OK"), onTap: (el) => el.layer.close() }] },
    ], { onEnter: (L) => L.close() });
  }

  // a tribe's diplomacy: peace, an embassy, breaking peace
  function tribePopup(p, dip) {
    const label = (c) => (c.kind === "PeaceTreaty" ? tr("action.info.peacetreaty", "Offer Peace") : c.kind === "BreakPeace" ? tr("action.info.breakpeace", "Break Peace") : c.kind === "EstablishEmbassy" ? "Embassy" : pretty(c.kind));
    const tribe = M().tribe(p.tribe);
    return popup("tribe", [
      { kind: "title", text: M().tribeName(p.tribe), chip: null },
      { kind: "text", text: `Ruled by ${ruler(p.id)}.` },
      { kind: "pills", items: dip.slice(0, 3).map((c) => ({ id: `dip:${c.kind}`, label: label(c), size: 20, fill: c.kind === "BreakPeace" ? g0().COLOURS.red : undefined, onTap: (el) => { el.layer.close(); closeAll(); A.act(c); } })) },
    ], { state: { tribe: tribe && tribe.name } });
  }
  const g0 = () => hud.layers.g;
  const closeAll = () => hud.layers.closeAll();

  // ---------- popups ----------
  const headOf = (p) => { const t = M().tribe(p && p.tribe); return [`head/${t ? t.name : ""}`, "head/head"]; };
  // the retail meeting popup has a picture of the tribe at the top; the web has the tribe's head on its colour
  function tribeBanner(p) {
    const colour = M().playerColour(p);
    return {
      kind: "image", h: 170,
      draw(g, x, y, w, h) {
        const ctx = g.ctx;
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, colour);
        grad.addColorStop(1, "rgba(0,0,0,1)");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha *= 0.18;
        for (let i = -2; i < 9; i++) { ctx.fillStyle = i % 2 ? "#fff" : "#000"; ctx.beginPath(); ctx.moveTo(x + i * g.u(60), y + h); ctx.lineTo(x + i * g.u(60) + g.u(90), y); ctx.lineTo(x + i * g.u(60) + g.u(120), y); ctx.lineTo(x + i * g.u(60) + g.u(30), y + h); ctx.fill(); }
        ctx.globalAlpha /= 0.18;
        g.icon(headOf(p), x + w / 2, y + h * 0.55, h * 0.78);
      },
    };
  }

  // Retail's MeetReaction: the tribe's picture, "You meet [tribe]", the leader's line and the trade boost line, and an
  // IconRewardPopup button showing the stars ("5★"); tapping it takes them (the stars fly to the counter). `stars` is
  // what the engine paid for the meeting (game.js reads it from the view's change); when several tribes are met by one
  // command the engine's total is shown on the last of them (SPEC §16). `onShow(p)` runs as each tribe comes up (its
  // song plays), `onReward(el)` when the last button is tapped (el: the button, for the floater's start).
  function meet(ids, { stars = 0, onShow, onReward, onDone } = {}) {
    const players = V().position.players || [];
    const met = ids.map((id) => players.find((pl) => pl.id === id)).filter(Boolean);
    let i = 0;
    const myScore = V().me ? V().me.score : 0;
    const scores = new Map(V().scores || []);
    const show = () => { if (onShow && met[i]) onShow(met[i]); };
    const next = (L, el) => {
      if (i < met.length - 1) { i++; show(); L.invalidate(); return; }
      if (onReward) onReward(el || null);
      L.close();
    };
    show();
    return popup("meet", (L) => {
      const p = met[Math.min(i, met.length - 1)];
      if (!p) return [];
      const last = i === met.length - 1;
      const paid = last && stars > 0 ? stars : 0;
      const theirs = scores.get(p.id) ?? 0;
      const lead = `${tr("wcontroller.meet.tribe.leader", "Their leader {0} ", ruler(p.id))} ${tr(theirs > myScore ? "wcontroller.meet.tribe.bigger.friendly" : "wcontroller.meet.tribe.smaller.friendly", "")}`.replace(/\s+/g, " ").trim();
      // the boost line names the tribe's size, wcontroller.tribe.level_1..4 (curious, sprawling, impressive, epic),
      // read back from the amount: Kenzi's retail screenshot pays 5 stars for a "curious" tribe, so 5 is level 1 and
      // each 2 more stars a level up (SPEC §16)
      const level = Math.max(1, Math.min(4, Math.floor((paid - 3) / 2)));
      const boost = paid ? tr("wcontroller.meet.tribe.resource.boost", "The discovery of this {0} tribe gives you a one time trade boost of {1} stars!", tr(`wcontroller.tribe.level_${level}`, "curious"), paid) : "";
      const ok = { kind: "round", id: "meet-ok", d: 96, textSize: 30, onTap: (el) => next(L, el) };
      if (paid) {
        Object.assign(ok, {
          aria: `${paid} stars`,
          drawInside(d) {
            const g = g0(), s = String(paid), ts = 34;
            const tw = g.measure(s, { font: g.fonts.numbers, size: ts }), iw = d * 0.3, gap = g.u(2);
            const x0 = -(tw + gap + iw) / 2;
            g.text(s, x0, 0, { font: g.fonts.numbers, size: ts, baseline: "middle" });
            g.icon(["icon/stariconbig", "icon/staricon", "icon/star"], x0 + tw + gap + iw / 2, 0, iw);
          },
        });
      } else ok.text = met.length > 1 && !last ? "Next" : tr("buttons.ok", "OK");
      return [
        tribeBanner(p),
        { kind: "gap", h: 16 },
        { kind: "title", text: fmt(tr("world.meet.tribe", "You meet {0}"), "").trim(), chip: { text: M().tribeName(p.tribe), colour: M().playerColour(p), head: headOf(p) } },
        { kind: "text", text: boost ? `${lead}\n${boost}` : lead },
        ok,
      ];
    }, { dismiss: false, onEnter: (L) => next(L, null), onBack: (L) => { i = met.length - 1; next(L, null); }, onClose: onDone });
  }

  function peace(cmds) {
    const id = cmds[0].with;
    const mine = cmds.filter((c) => c.with === id);
    const pick = (accept) => mine.find((c) => c.accept === accept);
    const p = (V().position.players || []).find((pl) => pl.id === id);
    return popup("peace", [
      tribeBanner(p),
      { kind: "gap", h: 16 },
      { kind: "title", text: tr("player.abilities.peacetreaty", "Peace Treaty"), size: 30 },
      { kind: "text", text: tr("diplomacy.peacetreaty.description", "{0} suggests a peace treaty.", A.ownerName(id)) },
      { kind: "pills", items: [
        pick(false) ? { id: "peace-decline", label: tr("buttons.decline", "DECLINE"), fill: g0().COLOURS.off, onTap: (el) => { el.layer.close(); A.act(pick(false)); } } : null,
        pick(true) ? { id: "peace-accept", label: tr("buttons.accept", "ACCEPT"), onTap: (el) => { el.layer.close(); A.act(pick(true)); } } : null,
      ].filter(Boolean) },
    ], { onEnter: (L) => { L.close(); if (pick(true)) A.act(pick(true)); } });
  }

  function endTurn(left) {
    const next = left.find((l) => l.kind === "units");
    const last = A.isLastTurn();
    const lines = left.map((l) => l.text);
    if (last) lines.push(tr("world.turn.last", "Last turn!"));
    const go = (L) => { L.close(); A.endTurnNow(); };
    return popup("end", [
      { kind: "title", text: tr("world.turn.end.question", "End your turn?"), size: 30 },
      ...lines.map((t) => ({ kind: "text", text: `• ${t}`, size: 18, after: 4 })),
      { kind: "gap", h: 6 },
      { kind: "pills", items: [
        next ? { id: "next", label: "Next unit", fill: g0().COLOURS.off, size: 20, onTap: (el) => { el.layer.close(); A.nextUnit(1); } } : { id: "keep", label: tr("buttons.back", "BACK"), fill: g0().COLOURS.off, onTap: (el) => el.layer.close() },
        { id: "end-confirm", label: tr("world.turn.end", "End Turn"), size: 22, onTap: (el) => go(el.layer) },
      ] },
    ], { onEnter: go });
  }

  // a yes or no question (disband, destroy, resign); resolves true for yes
  function ask({ title, message, confirmLabel, danger }) {
    return new Promise((resolve) => {
      let answer = false;
      popup("confirm", [
        { kind: "title", text: title, size: 30 },
        message ? { kind: "text", text: message } : null,
        { kind: "pills", items: [
          { id: "cancel", label: tr("buttons.back", "BACK"), fill: g0().COLOURS.off, onTap: (el) => el.layer.close() },
          { id: "yes", label: confirmLabel || tr("actionbox.confirm.button", "YES"), fill: danger ? g0().COLOURS.red : undefined, onTap: (el) => { answer = true; el.layer.close(); } },
        ] },
      ].filter(Boolean), { onClose: () => resolve(answer), onEnter: (L) => { answer = true; L.close(); } });
    });
  }

  // a city's level up: retail's popup with the two rewards as round buttons. Nothing else can be done until one is picked.
  function reward(cmds, city) {
    const name = city && city.name ? city.name : "City";
    const level = city && city.level != null ? city.level + 1 : null;
    return popup("reward", [
      { kind: "title", text: fmt(tr("world.reward.levelup", "{0} level up!"), name), size: 30 },
      level ? { kind: "text", text: `Level ${level}: pick a reward.`, size: 17, colour: "rgba(255,255,255,0.8)" } : null,
      { kind: "choices", items: cmds.map((c) => ({ id: `reward:${c.reward}`, icon: [REWARD_ICON[c.reward] || "icon/rewards_city"], label: pretty(c.reward), sub: rewardText(c.reward), onTap: (el) => { el.layer.close(); A.act(c); } })) },
    ].filter(Boolean), { dismiss: false, onBack: () => {} });
  }

  // a card of facts: the long press, a hint
  function info(title, rows, { text, pills } = {}) {
    return popup("info", [
      { kind: "title", text: title, size: 28 },
      text ? { kind: "text", text } : null,
      rows && rows.length ? { kind: "rows", rows } : null,
      pills ? { kind: "pills", items: pills } : null,
    ].filter(Boolean));
  }

  function over() {
    const v = V(), winners = v.winners || [];
    const watching = !!A.S.game.watching;
    const won = !watching && winners.includes(A.S.myId);
    const scores = [...(v.scores || [])].sort((a, b) => b[1] - a[1]);
    const players = v.position.players || [];
    const title = won ? tr("endscreen.victory", "VICTORY") : tr("endscreen.gameover", "GAME OVER");
    const line = winners.length ? (won ? "You won." : fmt(tr("endscreen.winner", "{0} wins!"), winners.map((w) => A.ownerName(w)).join(" and "))) : "The game is over.";
    return popup("over", [
      { kind: "title", text: title, size: 36 },
      { kind: "text", text: line },
      { kind: "list", items: scores.map(([id, s]) => { const pl = players.find((p) => p.id === id); return { name: `${A.ownerName(id)}${id === A.S.myId ? " (you)" : ""}`, right: num(s), colour: M().playerColour(pl), me: id === A.S.myId }; }) },
      { kind: "pills", items: [
        { id: "games", label: "Games", fill: g0().COLOURS.off, onTap: () => { location.href = "/games"; } },
        { id: "review", label: "Review", onTap: () => { location.href = `/games/${A.S.gameId}/review`; } },
      ] },
    ], { state: { won } });
  }

  // the game's log, newest first
  function log() {
    const st = { entries: null, error: null, heights: new Map() };
    A.fetchLog().then((e) => { st.entries = e; hud.layers.top && hud.layers.top.invalidate(); }).catch((e) => { st.error = e.message || "The log could not be loaded."; });
    return screen("log", (g, L, y) => {
      const cw = column(g), cx = g.W / 2, left = cx - cw / 2;
      let yy = y;
      if (!st.entries) return g.para(st.error || "Loading the log…", cx, yy, cw, { font: g.fonts.body, size: 18, align: "center" });
      if (!st.entries.length) return g.para("Nothing has happened yet.", cx, yy, cw, { font: g.fonts.body, size: 18, align: "center" });
      let turn = null;
      const vpTop = g.safe.top + g.u(70), vpBottom = g.H;
      for (const e of [...st.entries].reverse()) {
        if (e.turn !== turn) {
          turn = e.turn;
          yy += g.u(10);
          if (yy > vpTop - g.u(40) && yy < vpBottom) g.text(`Turn ${turn}`, left, yy + g.u(14), { size: 22, bold: true, baseline: "middle" });
          yy += g.u(32);
        }
        const text = env.describe(e);
        const hk = `${e.seq}:${Math.round(cw)}`;
        let h = st.heights.get(hk);
        if (h == null) { h = g.paraHeight(text, cw, { font: g.fonts.body, size: 17, lineHeight: 22 }) + g.u(2); st.heights.set(hk, h); }
        if (yy + h > vpTop - g.u(40) && yy < vpBottom) g.para(text, left, yy, cw, { font: g.fonts.body, size: 17, lineHeight: 22 });
        yy += h;
      }
      return yy;
    }, { title: "Game Log", titleFont: hud.layers.g.fonts.label, titleSize: 30 });
  }

  return { settings, stats, log, meet, peace, endTurn, ask, reward, info, over, modeInfo, tr, fmt, popup, screen, open };
}
