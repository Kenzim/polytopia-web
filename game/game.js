// The game screen (task F). It is driven by the view and its legal commands: nothing here knows a rule, it groups the
// commands (derive.js), shows them (panels.js), plays the one the player picks, and animates what the log reports.
//
// Files are loaded by their versioned URLs (the proxy caches /static/ for hours): game.html puts them in
// <meta name="game-urls">.

import { api } from "ui/api.js";
import { openSheet } from "ui/sheet.js";
import { toast } from "ui/toast.js";
import { confirm } from "ui/dialog.js";
import { createBoard } from "board/board.js";

const urls = JSON.parse(document.querySelector('meta[name="game-urls"]').content);
const D = await import(urls.derive);
const P = await import(urls.panels);
const { createSound, SOUNDS, readAudio, writeAudio, natureTrack, tribeSong, AMBIENCE_FADE, MENU_FADE } = await import(urls.sound);
const { createIcons } = await import(urls.icons);
const TT = await import(urls.techtree);
const { techScreen } = TT;
const { createDirector, estimate } = await import(urls.anim);
const { h, key, pretty, index, group, actingUnits, leftToDo, num, verb } = D;

const root = document.getElementById("game");
const gameId = Number(root.dataset.gameId);
// a replay of one of our games: a player's look back (/games/<id>/review) or a share link's (/r/<token>), whose visitor
// may not be signed in, so the art and the tables come through the link
const share = root.dataset.share || "";
const reviewing = !!share || !!root.dataset.review;
const ART = share ? `/r/${share}/art/` : "/art/";
const META = share ? `/api/shared/${share}/meta` : "/api/meta";
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tenths = (n) => (Number.isInteger(n / 10) ? String(n / 10) : (n / 10).toFixed(1));
const wide = () => window.matchMedia("(min-width: 768px)").matches;

// ---------- settings (this browser only) ----------
const SETTINGS_KEY = "poly.game.settings";
const settings = { confirmEnd: true, infoOnBuild: true, follow: false, fast: false, buildGlow: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) { /* private mode */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } };
const seqKey = `poly.game.${gameId}.seq`;
// the speed commands play at, your own and other players' alike: the fast setting doubles it
const playSpeed = () => (settings.fast ? 2 : 1);
// watching a bots-only game: the speeds the watcher can pick, kept in this browser
const SPEEDS = [0.5, 1, 2, 4];
const SPEED_KEY = "poly.watch.speed";
const WATCH_GAP = 700; // ms between one bot turn's animations ending and the next step, at 1x

// ---------- state ----------
const S = {
  gameId, game: null, view: null, g: group([]), myId: 0, version: 0,
  sel: null, markers: new Map(), forecast: null, hint: null, fogOff: false,
  ctx: null, ctxQuiet: false, info: null, modal: null,
  busy: false, replaying: null, refreshing: false, again: false, wasMine: false,
  undoSteps: 0, lastSeq: 0, nextIdx: -1, overShown: false, tiles: new Map(), cities: new Map(), records: new Map(),
  paused: false, speed: 1,
};
try { const sp = Number(localStorage.getItem(SPEED_KEY)); if (SPEEDS.includes(sp)) S.speed = sp; } catch (e) { /* private mode */ }
let M = null, board = null, sound = null, meta = null, anim = null;
// game mode: the HUD drawn on a canvas (ui/hud.js) in place of the HTML bars, which stay in the page, hidden
let hud = null;
// game mode: the menus and popups drawn on the HUD canvas (ui/screens.js) in place of the HTML sheets
let scr = null;
// game mode: the tech tree drawn on the HUD canvas (ui/techview.js) in place of techtree.js's HTML screen
let techView = null;
// game mode: what the selection bar (ui/selbar.js, drawn by the HUD) shows for a unit, a tile or an attack (ui/selection.js)
let selB = null;

const V = () => S.view.view;
const position = () => (S.fogOff && V().full_position) || V().position;
const unitById = (id) => position().units.find((u) => u.id === id) || null;
const myTurn = () => !!(S.game && S.game.status === "active" && S.view && V().me && V().me.to_move && V().moves && !S.replaying);
const isOver = () => !!(S.game && S.game.status === "over") || !!(S.view && V().over);
const watching = () => !!S.game && !!S.game.watching;
const soloHuman = () => S.game.seats.filter((s) => s.kind === "human").length === 1;

// ---------- what the panels ask of the screen ----------
const A = {
  M: null, S, settings, meta: null, ico: null,
  uiMode: root.dataset.uiMode === "game" ? "game" : "technical",
  // where the menu's exit goes: a share link's visitor may not be signed in
  exitUrl: root.dataset.share ? "/" : "/games",
  async setUiMode(mode) {
    try {
      await api.post("/api/me/prefs", { ui_mode: mode });
      location.reload();
    } catch (e) { sayError(e); }
  },
  myTurn,
  saveSettings,
  audio: () => readAudio(),
  setAudio(name, on) { writeAudio({ [name]: !!on }); if (name === "music") startMusic(); },
  tile: (xy) => S.tiles.get(key(xy)) || null,
  city: (xy) => S.cities.get(key(xy)) || null,
  // The lighthouse at xy, or null: the map corner it stands on, as retail names it (InteractionBar.RefreshBuildingOptions),
  // and the players who have found it, first finder first. Its record lists them all (`found_by`), as its tower shows
  // them to everyone; without that (an older engine service) the tile's explorers do, which are your own unless the
  // whole board is shown (the fog lifted, a watched game).
  lighthouse(xy) {
    const t = A.tile(xy);
    if (!t || M.impr(t.improvement)?.id !== "lighthouse") return null;
    const r = S.records.get(key(xy));
    const whole = !!(S.fogOff && V().full_position) || watching();
    const found = r && Array.isArray(r.found_by) ? r.found_by : (t.explored || []).filter((id) => whole || id === S.myId);
    return { corner: ["south", "east", "west", "north"][(xy[1] > 0 ? 2 : 0) + (xy[0] > 0 ? 1 : 0)], found };
  },
  unitAt: (xy) => position().units.find((u) => u.x === xy[0] && u.y === xy[1]) || null,
  ownerName(id) {
    if (!id) return "Nature";
    const seat = S.game.seats.find((s) => s.player_id === id);
    if (seat && seat.user) return seat.user.username;
    const pl = (position().players || []).find((p) => p.id === id);
    const bot = A.botName(id);
    if (bot) return bot;
    const tribe = M.tribeName(seat ? seat.tribe : pl ? pl.tribe : null);
    return seat && seat.kind === "bot" ? `${tribe} (bot)` : tribe;
  },
  /** A bot's retail name ("Bozu"): the view's, which knows its skin, else its seat's; null for a human or unknown. */
  botName(id) {
    const seat = S.game.seats.find((s) => s.player_id === id);
    if (seat && seat.kind !== "bot") return null;
    const pl = (position().players || []).find((p) => p.id === id);
    return (pl && pl.name) || (seat && seat.name) || null;
  },
  modeText() {
    const g = S.game, limit = turnLimit();
    const turns = limit ? ` ${limit} turns.` : "";
    if (g.mode === "might") return "Might: hold every capital to win. There is no turn limit.";
    if (g.mode === "domination") return `Domination: defeat every other tribe.${turns}`;
    return `Perfection: the highest score wins.${turns}`;
  },
  isLastTurn: () => isLastTurn(),
  canUndo: () => S.game.status === "active" && myTurn() && soloHuman() && S.undoSteps > 0,
  act, run, undo, hint,
  cancelForecast, confirmAttack,
  endTurnNow, nextUnit, setFog, resign, settingsChanged,
  openTech: () => openTech(), openScores: () => openScores(), openLog: () => openLog(),
  fetchLog: async () => (await api.get(`/api/games/${gameId}/log`)).log || [],
};
// the engine plays one more turn after the limit (status 3, "final turn"); ending it ends the game
const isLastTurn = () => !!S.view && V().position.game && V().position.game.status === 3;
const turnNumber = () => (V().position.game && V().position.game.turn) ?? S.game.turn ?? 0;
const turnLimit = () => (S.game.mode === "might" ? 0 : S.game.turn_limit || (V().position.game && V().position.game.settings && V().position.game.settings.turn_limit) || 0);
// the last sound events asked for, for tests (whether or not effects are on)
const soundLog = [];
const play = (name, o) => {
  soundLog.push(name);
  if (soundLog.length > 100) soundLog.shift();
  return sound && sound.play(SOUNDS[name] || name, o);
};
// a short message: an HTML toast in technical mode, a HUD notice in game mode (`error`: an Error or a message)
function say(msg, { error = false } = {}) {
  const text = msg instanceof Error ? msg.message : String(msg);
  if (hud) { hud.notice(text, { error, ms: error ? 4000 : 2200 }); return; }
  if (error) toast.error(msg); else toast(msg);
}
const sayError = (e) => say(e, { error: true });

// ---------- the sheets ----------
function syncSheets() {
  const open = window.__polySheets || [];
  const top = open.length ? open[open.length - 1].height : 0;
  document.body.classList.toggle("g-covered", top > window.innerHeight * 0.45 && !wide());
  document.body.classList.toggle("g-modal", !!S.modal && !S.modal.closed);
  const sheet = !wide() && S.ctx && !S.ctx.closed ? S.ctx.height : 0;
  if (hud) {
    // retail swaps the button bar for the selection panel: the bar goes while a selection sheet is up
    hud.update({ bottom: !(S.ctx && !S.ctx.closed) });
    const hi = hud.insets;
    if (board) board.setInsets({ top: hi.top, bottom: Math.max(sheet, hi.bottom) });
  } else if (board) board.setInsets({ bottom: sheet });
}

// `keep`: the same selection drawn again (after a command, or a refresh): the sheet stays as tall as the player left it
function openCtx(p, state = "peek", { keep = false } = {}) {
  const title = p.sub ? `${p.title} · ${p.sub}` : p.title;
  if (S.ctx && !S.ctx.closed) {
    S.ctx.setTitle(title);
    S.ctx.setContent(p.content);
    if (!keep) S.ctx.setState(state);
  } else {
    S.ctx = openSheet({
      title, content: p.content, state, peek: 150, states: ["peek", "auto", "full"], className: "g-ctx", label: "Selection",
      onClose: () => { if (!S.ctxQuiet) deselect(); },
      onChange: () => { syncSheets(); if (S.sel && S.ctx && !S.ctx.closed) board.reveal(S.sel.xy); },
    });
  }
  syncSheets();
}

function closeCtx() {
  if (selB) hud.select(null);
  if (S.ctx && !S.ctx.closed) {
    S.ctxQuiet = true;
    S.ctx.close();
    S.ctxQuiet = false;
  }
  S.ctx = null;
  syncSheets();
}

function closeInfo() {
  if (S.info && !S.info.closed) S.info.close();
  S.info = null;
}

async function openModal(build, { states = ["auto"], state, modal = true } = {}) {
  closeModal();
  let real = null;
  const proxy = { close: () => real && real.close(), get closed() { return !real || real.closed; } };
  const p = await build(proxy);
  real = openSheet({
    title: p.title, content: p.content, states, state, modal, className: p.className || "g-modal-sheet",
    onClose: () => { if (S.modal === real) S.modal = null; syncSheets(); setTimeout(showMeetings); },
    onChange: syncSheets,
  });
  S.modal = real;
  syncSheets();
  if (p.afterOpen) p.afterOpen();
  return real;
}
function closeModal() {
  if (S.modal && !S.modal.closed) S.modal.close();
  S.modal = null;
}

// the tech tree is a screen of its own (techtree.js), not a sheet
function openTech() {
  if (!S.view || !V().me || watching() || isOver()) return;
  closeModal();
  closeInfo();
  if (S.tech && !S.tech.closed) return;
  const onClose = () => { S.tech = null; startMusic(); };
  S.tech = techView ? techView.open({ onClose }) : techScreen(A, { onClose });
  startMusic();
}
// a canvas screen or popup kept as the modal sheet was: one at a time, `S.modal` while it is open
function openLayer(make) {
  closeModal();
  const L = make();
  S.modal = L;
  syncSheets();
  return L;
}
// any canvas layer closing: what a sheet's onClose did
function layerClosed(L) {
  if (S.modal === L) S.modal = null;
  if (S.info === L) { S.info = null; if (S.hint) clearHint(); }
  syncSheets();
  setTimeout(showMeetings);
}
// Game Stats plays the tribe's song while it is open (startMusic checks `S.scores`)
async function openScores() {
  S.scores = scr ? openLayer(() => scr.stats()) : await openModal((sheet) => P.scorePanel(A, sheet), { states: ["half", "full"], state: "half" });
  startMusic();
}
const openLog = () => (scr ? openLayer(() => scr.log()) : openModal(() => P.logPanel(A), { states: ["half", "full"], state: "half" }));
const openMenu = () => (scr ? openLayer(() => scr.settings()) : openModal((sheet) => P.menuPanel(A, sheet)));
const ask = (o) => (scr ? scr.ask(o) : confirm(o));

// ---------- the board: position, markers, overlays ----------
function indexView() {
  const p = position();
  S.tiles = new Map((p.tiles || []).map((t) => [`${t.x},${t.y}`, t]));
  // the records include other buildings: only a record on a city tile is a city, as board.js counts them. A ruin and a
  // corner lighthouse carry an unclaimed (owner 0) record too, on land as well as on water, and stay what their tile says
  const cityTile = (c) => {
    const t = S.tiles.get(`${c.x},${c.y}`);
    return !!t && (!!t.city || t.improvement === 1);
  };
  S.records = new Map((p.improvements || []).map((c) => [`${c.x},${c.y}`, c]));
  S.cities = new Map((p.improvements || []).filter(cityTile).map((c) => [`${c.x},${c.y}`, c]));
}

function capital() {
  const p = V().position;
  const t = (p.tiles || []).find((x) => x.capital && x.owner === S.myId);
  if (t) return [t.x, t.y];
  const me = (p.players || []).find((pl) => pl.id === S.myId);
  return me && me.start ? me.start : null;
}

function syncBoard() {
  const p = position();
  const mine = myTurn();
  const acting = mine ? new Set(actingUnits(S.g, p.units, S.myId).map((u) => u.id)) : null;
  const units = acting ? p.units.map((u) => (u.owner === S.myId ? { ...u, dim: !acting.has(u.id) } : u)) : p.units;
  const lifted = watching() || (S.fogOff && V().full_position);
  board.setPosition({ ...p, units }, { fogFor: lifted ? null : S.myId });
  syncSelection();
}

function buildMarkers() {
  S.markers = new Map();
  const sel = S.sel;
  if (!sel || sel.kind !== "unit" || !myTurn()) return;
  const u = unitById(sel.unitId);
  if (!u || u.owner !== S.myId) return;
  for (const c of S.g.byUnit.get(u.id) || []) {
    if (!c.to || key(c.to) === `${u.x},${u.y}`) continue;
    const k = key(c.to);
    if (c.kind === "Move") S.markers.set(k, { cmd: c, kind: "move" });
    else if (c.kind === "Disembark" && !S.markers.has(k)) S.markers.set(k, { cmd: c, kind: "disembark" });
    else if (c.kind === "Attack") S.markers.set(k, { cmd: c, kind: c.combat && c.combat.kills ? "kill" : "attack" });
  }
}

const buildCell = (k, v) => { const [x, y] = k.split(",").map(Number); return { x, y, v }; };

function syncSelection() {
  buildMarkers();
  const list = [];
  const by = {};
  for (const mk of S.markers.values()) (by[mk.kind] = by[mk.kind] || []).push(mk.cmd.to);
  for (const kind of ["move", "disembark", "attack", "kill"]) if (by[kind]) list.push({ kind, cells: by[kind] });
  if (S.forecast) list.push({ kind: "ring", at: S.forecast.to, colour: "#ff5a5a" });
  if (S.hint) {
    const c = S.hint;
    if (c.from && c.to) list.push({ kind: "arrow", from: c.from, to: c.to });
    else if (c.to) list.push({ kind: "target", at: c.to });
  }
  S.buildable = [];
  if (settings.buildGlow && myTurn() && (!S.sel || S.sel.kind === "tile")) {
    // retail puts a blue glow round what the player has the tech to build or harvest (the animal, the fruit),
    // whether or not they can afford it this turn
    const cells = S.buildable, seen = new Set();
    for (const [k, cs] of S.g.byTile) if (cs.some((c) => c.kind === "Build")) { seen.add(k); cells.push(buildCell(k, 1)); }
    for (const [k, cs] of S.g.lockedByTile) if (!seen.has(k) && cs.some((c) => c.kind === "Build")) cells.push(buildCell(k, 1));
    if (cells.length) list.unshift({ kind: "glow", colour: "#66ffff", cells, name: "buildable" }); // ColorConstants.glowColor
  }
  if (myTurn() && !S.sel) {
    const rewards = [...new Set(S.g.all.filter((c) => c.kind === "CityReward").map((c) => key(c.to)))];
    if (rewards.length) list.push({ kind: "target", cells: rewards.map((k) => k.split(",").map(Number)) });
  }
  if (PN) list.push(...PN.marks());
  board.setOverlays(list);
  board.select(S.sel ? S.sel.xy : null);
  root.dataset.sel = S.sel ? `${S.sel.kind}:${S.sel.xy[0]},${S.sel.xy[1]}` : "";
}

// ---------- selecting ----------
function candidates(xy) {
  const out = [];
  const u = A.unitAt(xy);
  if (u) out.push("unit");
  out.push("tile");
  return out;
}

function select(xy, { cycle = true } = {}) {
  const t = A.tile(xy);
  if (!t || !t.terrain || (t.explored && !t.explored.includes(S.myId) && !S.fogOff && t.explored.length === 0)) { deselect(); return; }
  const cs = candidates(xy);
  const same = S.sel && key(S.sel.xy) === key(xy);
  let kind = cs[0];
  if (same && cycle) {
    const at = cs.indexOf(S.sel.kind);
    if (cs.length === 1) { deselect(); return; }
    kind = cs[(at + 1) % cs.length];
  }
  if (kind === "unit") selectUnit(A.unitAt(xy));
  else selectTile(xy);
}

function selectUnit(u, { keep = false } = {}) {
  S.forecast = null;
  const sameSel = keep && !!S.sel && S.sel.kind === "unit" && S.sel.unitId === u.id;
  S.sel = { kind: "unit", xy: [u.x, u.y], unitId: u.id };
  syncSelection();
  if (selB) hud.select(selB.unit(u)); else openCtx(P.unitPanel(A, u), "peek", { keep: sameSel });
  if (!sameSel) play("select");
  board.reveal(S.sel.xy);
  root.dataset.unit = String(u.id);
  if (!keep) S.nextIdx = -1;
}

function selectTile(xy) {
  S.forecast = null;
  S.sel = { kind: "tile", xy: [xy[0], xy[1]] };
  syncSelection();
  if (selB) hud.select(selB.tile(xy));
  else {
    const p = P.tilePanel(A, xy);
    openCtx(p, p.tall ? "auto" : "peek"); // a city menu opens as tall as its content: no scrolling to reach Train
  }
  play("select");
  board.reveal(xy);
}

function deselect() {
  S.sel = null;
  S.forecast = null;
  closeCtx();
  closeInfo();
  syncSelection();
  delete root.dataset.unit;
}

// the current selection drawn again from the new view; the sheet keeps its height
function showSelection() {
  if (!S.sel) return;
  if (S.sel.kind === "unit") {
    const u = unitById(S.sel.unitId);
    if (!u) deselect();
    else if (selB) hud.select(selB.unit(u));
    else openCtx(P.unitPanel(A, u), "peek", { keep: true });
  } else if (selB) hud.select(selB.tile(S.sel.xy));
  else {
    const p = P.tilePanel(A, S.sel.xy);
    openCtx(p, p.tall ? "auto" : "peek", { keep: true });
  }
}

// ---------- tapping ----------
function onTap(info) {
  if (S.replaying && !watching()) { skipReplay(); return; }
  if (S.busy || !S.view) return;
  closeInfo();
  if (myTurn() && S.g.all.some((x) => x.kind === "PeaceResponse")) { openPendingReward(); return; }
  const mk = S.markers.get(key(info.xy));
  if (mk) { onMarker(mk); return; }
  if (info.cloud) { tapCloud(info.xy); return; }
  if (S.hint) clearHint();
  if (S.forecast) { S.forecast = null; syncSelection(); }
  select(info.xy);
}

// a tap on the background round the map: nothing stays selected
function onTapOutside() {
  if (S.replaying && !watching()) { skipReplay(); return; }
  if (S.busy || !S.view) return;
  if (S.hint) clearHint();
  deselect();
}

// A tap on a cloud, as retail's ClientInteraction.SelectTile does for a hidden tile: a puff on it and the cloud sound
// AudioUtils.GetCloudForCoordinate picks ((x + y - 1) mod 4 gives cloud_1 to cloud_4), and the selection is cleared.
// The board has already sunk the cloud on the press and springs it back on the release.
const cloudSound = (xy) => { const c = (xy[0] + xy[1] - 1) % 4; return `cloud_${c >= 0 && c < 3 ? c + 1 : 4}`; };
function tapCloud(xy) {
  if (S.hint) clearHint();
  if (S.forecast) S.forecast = null;
  deselect();
  board.effects.puff(xy);
  play(cloudSound(xy));
}

function onMarker(mk) {
  const c = mk.cmd;
  if (c.kind === "Attack") {
    if (S.forecast && key(S.forecast.to) === key(c.to)) confirmAttack(c);
    else showForecast(c);
  } else run(c);
}

function showForecast(cmd) {
  S.forecast = cmd;
  syncSelection();
  if (selB) hud.select(selB.forecast(cmd)); else openCtx(P.forecastPanel(A, cmd), "peek");
  play("select");
}

function cancelForecast() {
  S.forecast = null;
  syncSelection();
  if (S.sel) showSelection(); else closeCtx();
}

function confirmAttack(cmd) {
  S.forecast = null;
  run(cmd);
}

function onLongPress(info) {
  if (S.busy || (S.replaying && !watching()) || !S.view) return;
  const mk = S.markers.get(key(info.xy));
  if (mk && mk.cmd.kind === "Attack") { showForecast(mk.cmd); return; }
  closeInfo();
  if (scr) { S.info = infoLayer(info.xy); return; }
  const p = P.infoPanel(A, info.xy);
  S.info = openSheet({ title: p.title, content: p.content, states: ["auto"], className: "g-info", label: "Details", onClose: () => { S.info = null; } });
}

// game mode's long press: the tile's facts, and the unit's stats, on a card
function infoLayer(xy) {
  const f = P.tileFacts(A, xy);
  const u = A.unitAt(xy);
  const rows = f.rows.map(([k, v]) => [k, typeof v === "string" ? v : v.textContent]);
  if (u) {
    const s = P.statsOf(A, u.type, u);
    if (s) rows.unshift(["Owner", A.ownerName(u.owner)], ...s);
  }
  return scr.info(u ? M.unitName(u.type) : f.title, rows);
}

// a mouse resting on an enemy the selected unit can attack: the forecast as a small card, with nothing to confirm
let tip = null;
function onHover(info) {
  if (!tip) tip = $("g-tip");
  // game mode has no HTML card: a tap on the target shows the forecast in the selection bar
  const mk = !selB && info && info.pointerType !== "touch" && S.markers.get(key(info.xy));
  if (!mk || mk.cmd.kind !== "Attack" || S.busy || S.replaying) { tip.hidden = true; return; }
  const p = P.forecastPanel(A, mk.cmd, { buttons: false });
  tip.replaceChildren(h("strong", {}, p.title), p.content);
  tip.hidden = false;
  const r = root.getBoundingClientRect();
  tip.style.left = `${Math.min(info.clientX - r.left + 14, r.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(8, info.clientY - r.top - tip.offsetHeight - 14)}px`;
}

// ---------- playing a command ----------
function act(cmd) {
  switch (cmd.kind) {
    case "Attack": showForecast(cmd); break;
    case "Disband":
    case "Destroy":
      ask({ title: `${verb(cmd.kind)}?`, message: cmd.kind === "Disband" ? "The unit goes, and you get back part of its cost." : "This cannot be undone.", confirmLabel: verb(cmd.kind), danger: true })
        .then((ok) => { if (ok) run(cmd); });
      break;
    default: run(cmd);
  }
}

function setBusy(on) {
  S.busy = on;
  root.dataset.busy = on ? "1" : "";
  updateButtons();
}

function failed(e) {
  if (e && e.status === 409) { sayError(e.message || "The game has moved on."); scheduleRefresh(); } else sayError(e);
}

async function run(cmd) {
  if (S.busy || !myTurn()) return;
  if (cmd.kind !== "CityReward" && cmd.kind !== "PeaceResponse" && openPendingReward()) return;
  setBusy(true);
  // ending the turn: the next turn of ours begins from here, even when the bots' events arrive (and a refresh runs)
  // before this command's reply; its income is counted from the stars we end with
  if (cmd.kind === "EndTurn") { S.wasMine = false; S.starsAtEnd = V().me ? V().me.stars : null; S.endVersion = S.version; }
  try {
    const reply = await api.post(`/api/games/${gameId}/command`, { cmd: cmd.text, version: S.version });
    await afterOwn(cmd, reply);
  } catch (e) {
    if (cmd.kind === "EndTurn") { S.wasMine = myTurn(); S.starsAtEnd = null; S.endVersion = null; }
    failed(e);
  } finally {
    setBusy(false);
  }
}

// the board as the animation director draws it: a working copy of the position, shown as the events play
function drawPosition(p) {
  const lifted = watching() || (S.fogOff && V().full_position);
  board.setPosition(p, { fogFor: lifted ? null : S.myId });
}
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const afterPosition = (reply) => (S.fogOff && reply.view.full_position) || reply.view.position;

// A research done: a short toast with the tech's picture, on the board
function notice(kind, id, ms = 1800) {
  if (kind !== "tech") return;
  const name = M.techName(id), t = M.tech(id);
  if (hud) { hud.notice(`Researched ${name}`, { icon: t ? `tech/${t.id}` : null, ms }); return; }
  const el = h("div", { class: "g-notice", role: "status" }, A.ico.tech(t && t.id, name, "g-notice-ico"), h("span", {}, `Researched ${name}`));
  $("g-board-wrap").appendChild(el);
  setTimeout(() => el.classList.add("leaving"), ms);
  setTimeout(() => el.remove(), ms + 250);
}

// the viewer's own score change over a command: the engine's score in the views either side of it
const scoreGained = (before, after) => (before && before.me && after && after.me ? Math.max(0, after.me.score - before.me.score) : 0);
// a "+N" that rises from the score in the bar, for a command that touched no tile (a research)
function floatScore(n) {
  if (hud) { hud.bump("score"); return; }
  const el = h("span", { class: "g-score-gain", "aria-hidden": "true" }, `+${n}`);
  $("g-scorewrap").appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

async function afterOwn(cmd, reply) {
  const wasUnit = S.sel && S.sel.kind === "unit" ? S.sel.unitId : null;
  const unitBefore = cmd.unit != null ? unitById(cmd.unit) : null;
  if (cmd.kind !== "EndTurn") S.undoSteps += 1;
  const was = V();
  const ev = { ...cmd, player: S.myId, unit_type: unitBefore ? unitBefore.type : cmd.unit_type };
  if (cmd.kind !== "EndTurn" && anim) {
    board.setOverlays([]);
    const score = { gain: scoreGained(was, reply.view), bar: floatScore };
    if (hud) score.fly = (xy, n) => { hud.fly("score", () => board.screenOf(xy), n); };
    try {
      await anim.run({ events: [ev], before: () => position(), after: afterPosition(reply), show: drawPosition, mine: true, me: S.myId, speed: playSpeed, score });
    } catch (e) { console.warn("animation failed", e); }
  }
  // game mode: stars a command brings in (a city's reward, a ruin) fly from its tile to the star counter
  // A command that meets a tribe: the stars it brings are the meeting's, shown in its popup and flown when it closes
  const starsIn = was && was.me && reply.view.me ? reply.view.me.stars - was.me.stars : 0;
  const meeting = cmd.kind !== "EndTurn" && meetsNew(reply);
  const from = cmd.to || (unitBefore ? [unitBefore.x, unitBefore.y] : null);
  if (hud && starsIn > 0 && cmd.kind !== "EndTurn" && !meeting) hud.fly("stars", from ? () => board.screenOf(from) : null, starsIn);
  applyView(reply, { meetGain: meeting ? meetingStars(was, reply.view) : 0 });
  switch (cmd.kind) {
    case "PeaceTreaty": play("peaceSent"); break;
    case "PeaceResponse": case "EstablishEmbassy": play("peace"); break;
    default: break;
  }
  if (V().over || (was && !was.over && V().over)) maybeOver();
  // a command that ends the game by the rules (the last capital taken) leaves this one final turn to finish
  const lastBefore = !!(was && was.position && was.position.game && was.position.game.status === 3);
  if (cmd.kind !== "EndTurn" && !V().over && !lastBefore && isLastTurn()) banner("Last turn!", { ms: 1800, kind: "turn" });
  if (cmd.kind === "EndTurn") { S.undoSteps = 0; deselect(); openPendingReward(); return; }
  if (openPendingReward()) return;
  // a unit that can still do something stays selected, with fresh markers; anything else is done
  const u = wasUnit != null ? unitById(wasUnit) : null;
  if (u && u.owner === S.myId && (S.g.byUnit.get(u.id) || []).some((x) => !["Disband", "Stay", "Destroy"].includes(x.kind))) selectUnit(u, { keep: true });
  else if (S.sel && S.sel.kind === "tile" && tileStaysOpen(S.sel.xy)) showSelection(); // training in a city: the menu stays for the next one
  else deselect();
}

// a city of mine, or a tile that still has something to build, keeps its sheet after a command
function tileStaysOpen(xy) {
  const c = A.city(xy);
  return !!(c && c.owner === S.myId) || (S.g.byTile.get(key(xy)) || []).length > 0;
}

// the players the viewer has met: each has a diplomacy entry in the viewer's own player record (255 is the engine's Nature)
function metIds(reply) {
  const me = reply.view.me && reply.view.me.id;
  const own = ((reply.view.position && reply.view.position.players) || []).find((p) => p.id === me);
  return new Set(((own && own.diplomacy) || []).map((d) => d.other).filter((id) => id !== 255));
}

// a new tribe waits until the sheet the player has open closes, so the popup never replaces it. Closes call this in a
// timeout because openModal closes the old sheet before it sets the new one.
// A peace offer or a city reward waiting behind the popup opens when it closes.
// The stars a meeting paid (`meetStars`, the engine's change in the viewer's stars, see meetingStars) are shown in the
// popup; in game mode the star counter holds them back until the popup's reward button is tapped, then they fly up.
let meetPending = [];
let meetOpen = false;
let meetStars = 0;
let meetHolds = [];
let meetAfter = [];     // floaters waiting for the meeting popup to close (the turn's income)
function showMeetings() {
  if (S.modal && !S.modal.closed) return;
  if (!meetPending.length) {
    if (meetOpen) { meetOpen = false; meetAfter.splice(0).forEach((f) => f()); openPendingReward(); }
    return;
  }
  const ids = meetPending, stars = meetStars, holds = meetHolds;
  meetPending = []; meetStars = 0; meetHolds = [];
  meetOpen = true;
  if (scr) {
    let flown = false;
    const fly = (el) => {
      if (flown) return;
      flown = true;
      const from = el ? hud.centreOf(el) : null;
      holds.forEach((hd, i) => hd.fly(from ? () => from : null, { delay: i * 120 }));
    };
    openLayer(() => scr.meet(ids, {
      stars,
      onShow: (p) => { S.meetTribe = p.tribe; startMusic(); },
      onReward: fly,
      onDone: () => { fly(null); S.meetTribe = null; startMusic(); },
    }));
  } else openModal((sheet) => P.meetPanel(A, ids, sheet, stars));
}

// The stars the viewer got from meetings over a change of view: the change in its stars, less what else is known to
// have come in (`other`: the turn's income at a turn start). Only when someone new was met.
function meetingStars(before, after, other = 0) {
  if (!before || !before.me || !after || !after.me) return 0;
  return Math.max(0, after.me.stars - before.me.stars - other);
}

function applyView(reply, { meetGain = 0 } = {}) {
  const metBefore = S.view ? metIds(S.view) : null;
  S.view = reply;
  S.version = reply.version;
  S.g = group((V().moves && V().moves.commands) || [], (V().moves && V().moves.locked) || []);
  S.myId = V().me ? V().me.id : 0;
  indexView();
  syncBoard();
  updateBar();
  updateButtons();
  if (S.tech && !S.tech.closed) S.tech.update();
  root.dataset.turn = String(turnNumber());
  root.dataset.myTurn = myTurn() ? "1" : "";
  root.dataset.version = String(S.version);
  const fresh = metBefore ? [...metIds(reply)].filter((id) => !metBefore.has(id)) : [];
  meetPending.push(...fresh);
  if (fresh.length && meetGain > 0) {
    meetStars += meetGain;
    if (hud) meetHolds.push(hud.hold("stars", meetGain));
  }
  showMeetings();
  return fresh;
}

// whether a reply meets someone new (so the stars it brings are the meeting's)
function meetsNew(reply) {
  if (!S.view) return false;
  const before = metIds(S.view);
  return [...metIds(reply)].some((id) => !before.has(id));
}

// ---------- the bars ----------
let shownStars = null;
function countStars(to) {
  const el = $("g-stars-n");
  if (shownStars == null || shownStars === to) { el.textContent = String(to); shownStars = to; return; }
  const from = shownStars, t0 = performance.now();
  shownStars = to;
  if (to > from) { el.classList.remove("g-stars-gain"); void el.offsetWidth; el.classList.add("g-stars-gain"); }
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / 300);
    el.textContent = String(Math.round(from + (to - from) * p));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let shownIncome = null;
function updateBar() {
  const me = V().me;
  if (!me) { updateWatchBar(); return; }
  countStars(me.stars);
  const inc = $("g-income");
  inc.textContent = `${me.income >= 0 ? "+" : "−"}${Math.abs(me.income)}`;
  inc.classList.toggle("zero", !me.income);
  if (shownIncome != null && shownIncome !== me.income) { inc.classList.remove("flash"); void inc.offsetWidth; inc.classList.add("flash"); }
  shownIncome = me.income;
  const limit = turnLimit();
  $("g-turn").textContent = isLastTurn() ? "Last turn" : `T ${turnNumber()}${limit ? `/${limit}` : ""}`;
  $("g-score").textContent = num(me.score);
  $("g-title").textContent = S.game.name;
  $("g-stats").setAttribute("aria-label", `Stars ${me.stars}, income ${me.income}, turn ${turnNumber()}, score ${me.score}. Show scores`);
  if (hud) hud.update({ mode: "play", score: me.score, stars: me.stars, income: me.income, turn: turnNumber(), limit, lastTurn: isLastTurn() });
}

// a watcher has no stars or score of their own: the bar says whose turn it is, and the turn
function updateWatchBar() {
  const limit = turnLimit();
  $("g-eco").hidden = true;
  $("g-scorewrap").hidden = true;
  const seat = S.game.status === "active" ? S.game.seats.find((s) => s.seat === S.game.current_seat) : null;
  const pl = seat && (V().position.players || []).find((p) => p.id === seat.player_id);
  $("g-who").hidden = !pl;
  if (pl) {
    $("g-who-dot").style.background = M.tribeColour(pl.tribe);
    $("g-who-name").textContent = M.tribeName(pl.tribe);
  }
  const turn = isLastTurn() ? "Last turn" : `T ${turnNumber()}${limit ? `/${limit}` : ""}`;
  $("g-turn").textContent = turn;
  $("g-title").textContent = S.game.name;
  $("g-stats").setAttribute("aria-label", `${isOver() ? "Game over" : `${pl ? `${M.tribeName(pl.tribe)} to move, ` : ""}${turn}`}. Show scores`);
  if (hud) hud.update({ mode: "watch", who: pl ? { name: M.tribeName(pl.tribe), colour: M.tribeColour(pl.tribe) } : null, turn: turnNumber(), limit, lastTurn: isLastTurn() });
}

function waitingFor() {
  const seat = S.game.seats.find((s) => s.seat === S.game.current_seat);
  return seat ? A.ownerName(seat.player_id) : "the other players";
}

function updateButtons() {
  if (!S.view) return;
  const end = $("end-turn"), badge = $("end-badge"), label = $("end-label");
  if (S.game.replay) { replayButtons(); return; }
  if (watching()) { updateWatchButtons(); return; }
  const mine = myTurn();
  const left = mine ? actingUnits(S.g, position().units, S.myId).length : 0;
  end.disabled = false;
  end.dataset.mode = "";
  if (S.replaying) { label.textContent = "Skip"; end.dataset.mode = "skip"; }
  else if (isOver()) { label.textContent = "Game over"; end.dataset.mode = "over"; }
  else if (mine) { label.textContent = "End turn"; end.dataset.mode = "end"; end.disabled = S.busy; }
  else { label.textContent = "Waiting…"; end.dataset.mode = "wait"; end.disabled = true; }
  badge.textContent = String(left);
  badge.hidden = !(mine && left);
  $("g-next").hidden = !mine || !left;
  $("g-tech").hidden = isOver();
  $("g-undo").hidden = !A.canUndo();
  $("g-fast").hidden = !S.replaying;
  $("g-fast").setAttribute("aria-pressed", settings.fast ? "true" : "false");
  $("g-centre").hidden = !capital();
  if (!S.replaying) {
    if (!isOver() && !mine && S.game.status === "active") banner(`Waiting for ${waitingFor()}`, { keep: true });
    else if (bannerKind === "wait") banner(null);
  }
  if (hud) hudButtons(left);
  if (PN) PN.sync();
}

// my place among the tribes I know the scores of ("1st"), the tab on retail's Game Stats button
function myRank() {
  const scores = V().scores || [];
  const mine = scores.find(([id]) => id === S.myId);
  // retail shows the rank from the first turn; our view only has the scores of tribes this player has met
  if (!mine) return null;
  const n = 1 + scores.filter(([id, s]) => id !== S.myId && s > mine[1]).length;
  return ["1st", "2nd", "3rd"][n - 1] || `${n}th`;
}

// game mode: the retail button bar (Settings, Game Stats, Tech Tree, End Turn) and the small round tools on the right.
// End Turn goes blue once every unit is done (SPEC §16).
function hudButtons(left) {
  const mine = myTurn(), over = isOver(), w = watching();
  const end = { id: "end", icon: ["icon/end_turn"], label: "End Turn" };
  if (w) Object.assign(end, over ? { label: "Game Over" } : S.paused ? { label: "Play", icon: ["icon/play_button"] } : { label: "Pause", icon: ["icon/pause_button"] });
  else if (S.replaying) Object.assign(end, { label: "Skip", icon: ["icon/play_button"] });
  else if (over) end.label = "Game Over";
  else if (mine) Object.assign(end, { disabled: S.busy, active: !left });
  else Object.assign(end, { label: "Waiting", disabled: true });
  hud.update({
    buttons: [
      { id: "menu", icon: ["icon/menu"], label: "Settings" },
      { id: "stats", icon: ["icon/stats", "head/head"], iconScale: 1, label: "Game Stats", tag: w ? null : myRank() },
      { id: "tech", icon: ["icon/tech"], label: "Tech Tree", hidden: over || w },
      end,
    ],
    tools: [
      { id: "next", icon: ["icon/move"], label: "Next unit", hidden: w || !mine || !left, badge: left || 0 },
      { id: "undo", icon: ["icon/back_white", "icon/back"], label: "Undo", hidden: w || !A.canUndo() },
      { id: "centre", icon: ["icon/capitalvision", "icon/crown"], label: "Centre on your capital", hidden: w || !capital() },
      { id: "fast", text: "2×", label: "Faster replay", hidden: w || !S.replaying, active: !!settings.fast },
      { id: "speed", text: `${S.speed}×`, label: "Speed", hidden: !w || over },
      ...(PN ? PN.tools() : []),
    ],
  });
}

// ---------- a panel of the page's own (the `panel` URL, optional): its module exports createPanel(o), which returns
// null or {start(), sync(), marks() (board overlays), tools() (round HUD buttons), action(id) (a tap on one),
// onAt(n, drawn) and deckExtra() (a replay)}. o: {api, toast, h, root, meta, gameId, redraw() (the board marks again),
// onLayout() (the HUD buttons again)}, with `live` in a game being played and `R` (the replay) in a replay ----------
let PN = null;
async function pagePanel(extra) {
  if (!urls.panel) return;
  const { createPanel } = await import(urls.panel);
  PN = createPanel({ api, toast, h, root, meta, gameId, redraw: () => syncSelection(), onLayout: () => updateButtons(), ...extra });
  if (PN) PN.start();
}
const livePanel = () => pagePanel({
  R: null,
  live: {
    game: () => S.game,
    active: () => !watching() && !isOver() && S.game.status === "active",
    version: () => S.version,
    position: () => position(),
    players: () => S.game.seats.filter((s) => s.player_id != null).map((s) => ({
      id: s.player_id, kind: s.kind, who: (s.user && s.user.username) || s.name || "Bot",
      tribe: ((position().players || []).find((p) => p.id === s.player_id) || {}).tribe ?? s.tribe,
    })),
    canPlay: () => myTurn() && !S.busy,
    play: (text) => {
      const c = ((V().moves && V().moves.commands) || []).find((x) => x.text === text);
      if (c) act(c); else say("That move is not possible now.");
    },
  },
});

function hudAction(id) {
  if (R && id.startsWith("rp:")) { R.action(id.slice(3)); return; }
  switch (id) {
    case "menu": openMenu(); break;
    case "stats": case "bar": openScores(); break;
    case "tech": openTech(); break;
    case "end": $("end-turn").click(); break;
    case "next": nextUnit(1); break;
    case "undo": undo(); break;
    case "centre": { const c = capital(); if (c) board.centreOn(c); break; }
    case "fast": $("g-fast").click(); break;
    case "speed": cycleSpeed(); break;
    case "banner": $("g-banner").click(); break;
    default: if (PN) PN.action(id); break;
  }
}

function updateWatchButtons() {
  const end = $("end-turn"), over = isOver();
  $("end-label").textContent = over ? "Game over" : S.paused ? "Play" : "Pause";
  end.dataset.mode = over ? "over" : S.paused ? "play" : "pause";
  end.disabled = false;
  $("end-badge").hidden = true;
  for (const id of ["g-next", "g-tech", "g-undo", "g-fast", "g-centre"]) $(id).hidden = true;
  const speed = $("g-speed");
  speed.hidden = over;
  speed.textContent = `${S.speed}×`;
  speed.setAttribute("aria-label", `Speed ${S.speed} times. Change speed`);
  root.dataset.paused = S.paused ? "1" : "";
  root.dataset.speed = String(S.speed);
  if (!S.replaying) {
    if (S.paused && !over) banner("Paused", { keep: true });
    else if (bannerKind === "wait") banner(null);
  }
  if (hud) hudButtons(0);
}

let bannerTimer = 0, bannerKind = "";
function banner(text, { ms = 0, keep = false, kind = "", sub = "" } = {}) {
  const el = $("g-banner");
  clearTimeout(bannerTimer);
  if (!text) { el.hidden = true; bannerKind = ""; if (hud) hud.banner(null); return; }
  el.textContent = sub ? `${text}. ${sub}` : text;
  el.hidden = false;
  bannerKind = keep && !kind ? "wait" : kind;
  el.dataset.kind = bannerKind;
  if (hud) hud.banner(text, { kind: bannerKind, ms, sub });
  if (ms) bannerTimer = setTimeout(() => { el.hidden = true; bannerKind = ""; updateButtons(); }, ms); // the HUD fades its own out
}

// ---------- end turn, next unit, undo, hint, fog, resign ----------
// A city that can level up takes its reward first: as in retail, nothing else can be done until it is picked. Its sheet
// opens (or stays open) and closes any menu or the tech tree. Closing the sheet is allowed; End turn and any other
// command bring it back. The engine offers only the CityReward commands meanwhile. A tribe's peace offer blocks the
// same way (the engine offers only the two PeaceResponse commands), so its prompt opens first.
function openPendingReward() {
  if (!myTurn()) return false;
  const peace = S.g.all.filter((x) => x.kind === "PeaceResponse");
  if (peace.length) {
    if (!meetOpen && !meetPending.length) openPeace(peace);      // a tribe met this turn is introduced first
    return true;
  }
  const c = S.g.all.find((x) => x.kind === "CityReward");
  if (!c) return false;
  if (scr) { openReward(c); return true; }
  closeModal();
  if (S.tech && !S.tech.closed) S.tech.close();
  if (S.sel && S.sel.kind === "tile" && key(S.sel.xy) === key(c.to)) showSelection(); else selectTile(c.to);
  return true;
}

// game mode: the level up popup, over the city
let rewardLayer = null;
function openReward(c) {
  if (rewardLayer && !rewardLayer.closed && S.modal === rewardLayer) return;
  if (S.tech && !S.tech.closed) S.tech.close();
  deselect();
  board.centreOn(c.to, { ms: 300 });
  const cmds = S.g.all.filter((x) => x.kind === "CityReward" && key(x.to) === key(c.to));
  rewardLayer = openLayer(() => scr.reward(cmds, A.city(c.to)));
}

let peaceSheet = null;
function openPeace(cmds) {
  if (peaceSheet && !peaceSheet.closed && S.modal === peaceSheet) return;
  if (S.tech && !S.tech.closed) S.tech.close();
  peaceSheet = null;
  if (scr) peaceSheet = openLayer(() => scr.peace(cmds));
  else openModal((sheet) => P.peacePanel(A, cmds, sheet)).then((s) => { peaceSheet = s; });
}

function endTurn() {
  if (!myTurn() || S.busy) return;
  if (openPendingReward()) return;
  const left = leftToDo(S.g, position().units, S.myId);
  const last = A.isLastTurn();
  if (settings.confirmEnd && (left.length || last)) {
    if (scr) openLayer(() => scr.endTurn(left));
    else openModal((sheet) => P.endPanel(A, left, sheet));
  } else endTurnNow();
}

async function endTurnNow() {
  if (!S.g.end) return;
  $("end-turn").setAttribute("aria-busy", "true");
  try { await run(S.g.end); } finally { $("end-turn").removeAttribute("aria-busy"); }
}

function nextUnit(dir = 1) {
  if (!myTurn()) return;
  const list = actingUnits(S.g, position().units, S.myId);
  if (!list.length) { say("No unit has anything left to do."); return; }
  let i = S.sel && S.sel.kind === "unit" ? list.findIndex((u) => u.id === S.sel.unitId) : S.nextIdx;
  i = i < 0 && dir < 0 ? 0 : i;
  i = (i + dir + list.length) % list.length;
  S.nextIdx = i;
  closeModal();
  selectUnit(list[i], { keep: true });
}

async function undo() {
  if (!A.canUndo() || S.busy) return;
  setBusy(true);
  try {
    const reply = await api.post(`/api/games/${gameId}/undo`, { version: S.version });
    S.undoSteps = Math.max(0, S.undoSteps - 1);
    deselect();
    applyView({ ...S.view, version: reply.version, view: reply.view });
    openPendingReward();
    say("Undone");
  } catch (e) {
    failed(e);
  } finally {
    setBusy(false);
  }
}

function cmdText(c) {
  const at = c.to ? ` at ${c.to[0]}, ${c.to[1]}` : "";
  switch (c.kind) {
    case "Move": return `Move ${M.unitName(c.unit_type)} to ${c.to[0]}, ${c.to[1]}`;
    case "Attack": return `Attack with ${M.unitName(c.unit_type)} at ${c.to[0]}, ${c.to[1]}`;
    case "Train": return `Train ${M.unitName(c.train)}${at}`;
    case "Build": return `Build ${M.imprName(c.improvement)}${at}`;
    case "Research": return `Research ${M.techName(c.tech)}`;
    case "CityReward": return `Pick ${pretty(c.reward)}${at}`;
    case "EndTurn": return "End the turn";
    default: return `${verb(c.kind)}${at}`;
  }
}

function hint() {
  const c = V().moves && V().moves.ai;
  if (!c) { say("No hint right now."); return; }
  clearHint();
  S.hint = c;
  const u = c.unit != null ? unitById(c.unit) : null;
  if (u) selectUnit(u, { keep: true }); else syncSelection();
  const where = c.to || c.from;
  if (where) board.reveal(where);
  closeInfo();
  if (scr) {
    S.info = scr.info("Hint", [], { text: `The AI would: ${cmdText(c)}.`, pills: [
      { id: "hint-close", label: "Close", fill: "rgba(120,120,128,0.75)", onTap: () => closeInfo() },
      { id: "hint-play", label: "Play it", onTap: () => { closeInfo(); act(c); } },
    ] });
    return;
  }
  S.info = openSheet({
    title: "Hint", states: ["auto"], className: "g-info", label: "Hint",
    content: h("div", { class: "stack" }, h("p", {}, `The AI would: ${cmdText(c)}.`),
      h("div", { class: "g-actions end" },
        h("button", { type: "button", class: "btn", "data-act": "hint-close", onclick: () => closeInfo() }, "Close"),
        h("button", { type: "button", class: "btn primary", "data-act": "hint-play", onclick: () => { closeInfo(); act(c); } }, "Play it"))),
    onClose: () => { S.info = null; clearHint(); },
  });
}
function clearHint() {
  if (!S.hint) return;
  S.hint = null;
  syncSelection();
}

function setFog(off) {
  S.fogOff = !!off && !!V().full_position;
  S.forecast = null;
  indexView();
  syncBoard();
  closeInfo();
  if (S.sel?.kind === "tile" && !A.tile(S.sel.xy)?.terrain) deselect();
  else if (S.sel) showSelection();
}

async function resign() {
  const ok = await ask({ title: "Resign?", message: "Your tribe is played by the AI from now on.", confirmLabel: "Resign", danger: true });
  if (!ok) return;
  try {
    await api.post(`/api/games/${gameId}/resign`, {});
    await refresh();
  } catch (e) {
    failed(e);
  }
}

function settingsChanged(name) {
  if (name === "fast") updateButtons();
  if (name === "buildGlow" && S.view) syncSelection();
}

// ---------- the end of the game ----------
function maybeOver() {
  if (S.overShown || !isOver()) return;
  S.overShown = true;
  const won = !watching() && (V().winners || []).includes(S.myId);
  if (!watching()) play(won ? "win" : "lose");
  if (scr) openLayer(() => scr.over());
  else openModal((sheet) => P.overPanel(A, sheet));
}

// ---------- other players' turns: refresh, then replay what we may see ----------
function scheduleRefresh() {
  if (S.refreshing) { S.again = true; return; }
  refresh();
}

async function refresh({ initial = false } = {}) {
  S.refreshing = true;
  try {
    do {
      S.again = false;
      const [gameReply, reply] = await Promise.all([api.get(`/api/games/${gameId}`), api.get(`/api/games/${gameId}/view`).catch((e) => (e.status === 409 ? null : Promise.reject(e)))]);
      S.game = gameReply.game;
      if (!reply) { banner(S.game.status === "lobby" ? "The game has not started yet." : "This game was abandoned.", { keep: true }); return; }
      const logReply = await api.get(`/api/games/${gameId}/log?after=${S.lastSeq}`);
      // the log is read after the view, and a bot may have played in between. An entry the view does not hold yet waits
      // for the view that does: played now, its move would run towards a position from before it and the unit would
      // be put back where it came from, to jump to its tile only with a later view
      const upTo = typeof reply.seq === "number" ? reply.seq : Infinity;
      const entries = (logReply.log || []).filter((e) => e.seq <= upTo);
      if (entries.length < (logReply.log || []).length) S.again = true;
      const mineId = reply.view.me ? reply.view.me.id : 0;
      if (initial) {
        S.undoSteps = soloHuman() ? entries.filter((e) => e.player === mineId && e.kind !== "EndTurn" && e.turn === (reply.view.position.game || {}).turn).length : 0;
      }
      const others = entries.filter((e) => e.player !== mineId && e.kind !== "EndTurn" && e.seq > (initial ? 0 : S.lastSeq));
      if (entries.length) S.lastSeq = Math.max(S.lastSeq, ...entries.map((e) => e.seq));
      try { localStorage.setItem(seqKey, String(S.lastSeq)); } catch (e) { /* private mode */ }
      if (!initial && S.view && others.length && reply.version !== S.version) await replay(others, afterPosition(reply));
      const wasMine = S.wasMine;
      // a selection is only stale when other players moved; an event for our own command must not close the sheet
      const stale = !watching() && others.length > 0;
      if (stale) deselectIfStale();
      // game mode: the turn's income flies from the capital to the star counter (SPEC §16)
      const before = S.view && S.view.view.me, after = reply.view.me;
      // a view from before our own EndTurn was applied (a refresh already in flight) is still the turn we are ending
      const old = S.endVersion != null && reply.version <= S.endVersion;
      const base = S.starsAtEnd ?? (before ? before.stars : null);
      const gain = !initial && !old && base != null && after && after.to_move && !wasMine ? after.stars - base : 0;
      // a tribe met as the turn starts (or by another player's embassy): the stars beyond the turn's income are its
      const meeting = !initial && meetsNew(reply);
      const meetGain = !meeting ? 0 : gain ? Math.max(0, gain - (after.income || 0)) : meetingStars(S.view && S.view.view, reply.view);
      const income = hud ? gain - meetGain : 0;
      if (!old && after && after.to_move) { S.starsAtEnd = null; S.endVersion = null; }
      applyView(reply, { meetGain });
      if (income > 0) {
        // the income waits behind a meeting popup that opens with the turn, so it never flies across the card
        const cap = capital(), hd = hud.hold("stars", income);
        const go = (delay) => hd.fly(cap ? () => board.screenOf(cap) : null, { delay });
        if (meetOpen || meetPending.length) meetAfter.push(() => go(300)); else go(450);
      }
      if (!stale) keepSelection();
      S.wasMine = old ? false : myTurn();
      const turnBegins = S.wasMine && !wasMine;
      if (!initial && turnBegins) turnStart();
      if (initial || turnBegins || stale) openPendingReward();
      if (isOver()) maybeOver();
    } while (S.again);
  } catch (e) {
    if (!initial) sayError(e);
    else throw e;
  } finally {
    S.refreshing = false;
  }
}

function deselectIfStale() { if (S.sel) deselect(); }

// a watcher's selection (tile info, a unit's stats) stays open while the bots play on
function keepSelection() {
  if (!S.sel) return;
  if (S.sel.kind === "unit") {
    const u = unitById(S.sel.unitId);
    if (!u) { deselect(); return; }
    S.sel.xy = [u.x, u.y];
  }
  showSelection();
  syncSelection();
}

function turnStart() {
  play("turn");
  // retail: "Your turn" over "29 turns left" (the limit less the turn), "Last turn!" when none is left
  const limit = turnLimit(), left = limit - turnNumber();
  const sub = isLastTurn() || (limit && left <= 0) ? "Last turn!" : limit ? `${left} turns left` : "";
  banner("Your turn", { ms: 1500, kind: "turn", sub });
  const cap = capital();
  if (cap) board.centreOn(cap, { ms: 400 });
  S.undoSteps = 0;
}

// Another player's turn: its log entries play as one run of the animation director, from the position on the board to the
// one the server reports. The speed is the watcher's (or the fast setting's), raised when the turn would take too long.
async function replay(list, after) {
  const r = { skip: false };
  S.replaying = r;
  updateButtons();
  const base = () => (watching() ? S.speed : playSpeed());
  const cap = watching() ? 8000 : 20000;
  const boost = Math.max(1, estimate(list) / base() / cap);
  let lastPlayer = null;
  try {
    await anim.run({
      events: list, before: () => position(), after, show: drawPosition, mine: false, me: S.myId, hold: true,
      camera: true, followMoves: settings.follow || watching(),
      speed: () => base() * boost,
      onEvent: (e) => {
        if (e.player !== lastPlayer) { lastPlayer = e.player; play("enemy"); }
        banner(`${A.ownerName(e.player)} is moving`, { kind: "replay" });
      },
    });
  } catch (e) {
    console.warn("replay failed", e);
  } finally {
    anim.skip();
    S.replaying = null;
    banner(null);
    updateButtons();
  }
}

function skipReplay() {
  if (!S.replaying) return;
  S.replaying.skip = true;
  anim.skip();
}

// ---------- watching a bots-only game: the client paces it, one `step` (one bot turn) at a time ----------
function togglePause() {
  S.paused = !S.paused;
  updateButtons();
}

function cycleSpeed() {
  S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
  try { localStorage.setItem(SPEED_KEY, String(S.speed)); } catch (e) { /* private mode */ }
  updateButtons();
}

let watchLoopOn = false;
async function watchLoop() {
  if (watchLoopOn) return;
  watchLoopOn = true;
  try {
    while (watching() && S.game.status === "active" && !isOver()) {
      // paused, in a hidden tab (nobody is watching) or still playing the last turn's animations: wait
      if (S.paused || document.hidden || S.refreshing || S.replaying) { await sleep(150); continue; }
      let wait = WATCH_GAP / S.speed;
      try {
        await api.post(`/api/games/${gameId}/step`, { version: S.version });
        await refresh();
      } catch (e) {
        if (e && e.status === 409) { await refresh(); wait = 1000; } else { S.paused = true; updateButtons(); sayError(e); }
      }
      await sleep(wait);
    }
  } finally {
    watchLoopOn = false;
    if (S.view) updateButtons();
  }
}

// ---------- a replay: a bot game's (admins only) or one of ours; replay.js drives the screen, the whole map shows.
// One of ours may have the page's panel beside or under the board ----------
let R = null;
function replayButtons() {
  root.dataset.paused = R && R.playing ? "" : "1";
  if (hud) {
    hud.update({
      buttons: [
        { id: "menu", icon: ["icon/menu"], label: "Settings" },
        { id: "stats", icon: ["icon/stats", "head/head"], iconScale: 1, label: "Game Stats" },
      ],
      tools: PN ? PN.tools() : [],
    });
  }
}

// `source`: replay.js's botSource or gameSource; `at`: the moment to open on (a number or a function of the data)
async function bootReplay(source, at = 0, panel = null) {
  await setupScreen();
  const RP = await import(urls.replay);
  R = RP.createReplay({
    source: source(RP), root, A, S, M, D, h, board, anim, hud,
    applyView: (reply) => applyView(reply), drawPosition, play, banner, say, sayError,
    onAt: (n, drawn) => { if (PN) PN.onAt(n, drawn); },
    deckExtra: () => (PN ? PN.deckExtra() : {}),
  });
  root.__game.replay = R;
  await R.start(at);
  if (panel) await pagePanel({ ...panel, R, wide: wide() });
  $("g-title").textContent = S.game.name;
  $("g-stats").hidden = false;
  measureBar();
  new ResizeObserver(measureBar).observe($("g-bar"));
  syncSheets();
  board.fit({ animate: false });
  startMusic();
  setInterval(startMusic, 1000);
  $("g-stats").addEventListener("click", openScores);
  $("g-menu").addEventListener("click", openMenu);
  $("g-banner").addEventListener("click", () => { if (bannerKind !== "wait") banner(null); });
  document.addEventListener("keydown", onKey);
  updateButtons();
  document.body.dataset.ready = "1";
}

// ---------- the lobby: G's fragment (lobby.html, in a <template> in game.html) and its scripts ----------
async function showLobby() {
  document.body.classList.add("g-lobby-page");
  $("g-board-wrap").hidden = true;
  const box = $("g-lobby");
  box.hidden = false;
  const frag = $("lobby-tpl").content.cloneNode(true);
  frag.querySelectorAll("script").forEach((s) => s.remove());
  box.replaceChildren(frag);
  await import(urls.common);
  await import(urls.lobby);
  (await import("ui/music.js")).playMusic("startscreen"); // the theme, as on the site's other pages
}

// Music, as retail's in-game AudioManager picks it: the nature track of the climate at the centre of the view,
// crossfading as the camera moves; the player's tribe song while the tech tree or Game Stats is open (the screens retail
// marks playTribeMusic). Checked every second, the delay retail waits between climate checks.
let musicClimate = null;
function viewClimate() {
  const r = $("board").getBoundingClientRect();
  if (!board || !r.width) return null;
  const xy = board.tileAt(r.left + r.width / 2, r.top + r.height / 2);
  const t = xy && S.tiles && S.tiles.get(`${xy[0]},${xy[1]}`);
  return t && t.terrain ? (t.climate ?? null) : null;
}
function musicNow() {
  if (!S.view) return { name: null };
  const me = V().me;
  const t = me ? M.tribe(me.tribe) : null;
  // retail's MeetReaction plays the met tribe's song under its popup and fades it out when the reward is taken
  const met = S.meetTribe != null ? M.tribe(S.meetTribe) : null;
  if (met) return { name: tribeSong(met.name), fade: MENU_FADE };
  if (t && ((S.tech && !S.tech.closed) || (S.scores && !S.scores.closed))) return { name: tribeSong(t.name), fade: MENU_FADE };
  const c = viewClimate();
  if (c != null) musicClimate = c;
  return { name: natureTrack(musicClimate ?? (t ? t.idx : 0)), fade: AMBIENCE_FADE };
}
function startMusic() {
  if (!sound) return;
  const m = musicNow();
  sound.music(m.name, m.fade);
}

// the action bar's height, so the selection sheet can sit on top of it
function measureBar() {
  const bar = $("g-bar");
  if (bar) document.documentElement.style.setProperty("--g-bar", `${bar.offsetHeight}px`);
}

// ---------- keys (a desktop extra) ----------
function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey && e.key.toLowerCase() !== "z" || e.altKey || e.metaKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
  if (!S.view) return;
  if (S.tech && !S.tech.closed && !techView) return; // the HTML tech screen has its own keys
  if (hud && hud.layers && hud.layers.active) {
    // a canvas screen or popup: Escape is its back button, Enter its main button; nothing reaches the board
    const top = hud.layers.top;
    if (e.key === "Escape") top.back();
    else if (e.key === "Enter") top.enter();
    else return;
    e.preventDefault();
    return;
  }
  const open = (window.__polySheets || []).length > 0;
  const k = e.key;
  if (k === "Escape") {
    if (open) return; // the sheet closes itself
    if (S.sel) deselect(); else openMenu();
    return;
  }
  if (tag === "BUTTON" || tag === "A") { if (k === "Enter" || k === " ") return; }
  if (k === "Enter") {
    const primary = open && document.querySelector(".sheet:last-of-type .btn.primary:not([disabled])");
    if (primary && !tag.match(/BUTTON|A/)) { primary.click(); e.preventDefault(); return; }
    if (!open) { endTurn(); e.preventDefault(); }
    return;
  }
  if (open) return;
  const lower = k.toLowerCase();
  // a bot game's replay: Space plays and pauses, comma and full stop step a command, Page Up and Down a turn
  const rp = { " ": "play", ",": "back", ".": "fwd", PageUp: "prev", PageDown: "next" }[k];
  if (R && rp) { R.action(rp); e.preventDefault(); return; }
  if (lower === "e") endTurn();
  else if (lower === "t" && !watching()) openTech();
  else if (k === " " && watching()) togglePause();
  else if (lower === "s") openScores();
  else if (lower === "h" && S.game.assist && myTurn()) hint();
  else if (lower === "c" || k === "Home") { const c = capital(); if (c) board.centreOn(c); }
  else if (k === "Tab") nextUnit(e.shiftKey ? -1 : 1);
  else if (lower === "z" && e.ctrlKey) undo();
  else if (k === "+" || k === "=") board.zoomBy(1.25);
  else if (k === "-" || k === "_") board.zoomBy(0.8);
  else if (k === "ArrowLeft" || lower === "a") board.panBy(80, 0, { animate: true });
  else if (k === "ArrowRight" || lower === "d") board.panBy(-80, 0, { animate: true });
  else if (k === "ArrowUp" || lower === "w") board.panBy(0, 80, { animate: true });
  else if (k === "ArrowDown" || lower === "x") board.panBy(0, -80, { animate: true });
  else return;
  e.preventDefault();
}

// ---------- start ----------
async function artManifest() {
  try {
    const r = await fetch(`${ART}manifest.json`, { credentials: "same-origin" });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// the game's English UI text (extracted with the art); game mode falls back to its own wording without it
async function gameStrings() {
  try {
    const r = await fetch(`${ART}strings.json`, { credentials: "same-origin" });
    return r.ok ? await r.json() : {};
  } catch (e) { return {}; }
}

// the board, the animations and (game mode) the HUD, its screens and the selection bar
async function setupScreen() {
  [meta] = await Promise.all([api.get(META)]);
  const manifest = await artManifest();
  M = index(meta);
  A.M = M;
  A.meta = meta;
  A.ico = createIcons(manifest, h, ART);
  sound = createSound(manifest, { base: ART, enabled: () => readAudio().effects, musicEnabled: () => readAudio().music });
  sound.preload(["click_down", "move_grass", "hit_1", "kill", "spawn", "turn", "cloud_1", "cloud_2", "cloud_3", "cloud_4"].filter(Boolean));
  const canvas = $("board");
  board = createBoard(canvas, {
    meta,
    art: manifest ? { manifest, base: ART, version: manifest.game_version } : null,
    onTap, onTapOutside, onLongPress, onHover,
    onViewChange: () => { if (hud) hud.viewChanged(); },
    // game mode: retail's camera, elastic at the edges, the wheel zoom gliding (technical mode keeps the plain one)
    feel: { elastic: A.uiMode === "game", smoothZoom: A.uiMode === "game" },
    space: A.uiMode === "game",
  });
  anim = createDirector({ board, M, play, notice, reduced });
  if (A.uiMode === "game") {
    const [T, K, HUD, LY, SC, TV, SB, SL, strings] = await Promise.all([import(urls.text), import(urls.kit), import(urls.hud), import(urls.layers), import(urls.screens), import(urls.techview), import(urls.selbar), import(urls.selection), gameStrings()]);
    const text = T.createText(manifest, ART);
    text.ready.then(() => board.setText(text));
    const portrait = (ctx, p, cx, cy, size) => board.drawPortrait(ctx, p.xy, { unit: p.unit, cx, cy, size });
    hud = HUD.createHud({ wrap: $("g-board-wrap"), kit: K, layersMod: LY, selbarMod: SB, portrait, anchorOf: (xy) => board.screenOf(xy), manifest, artBase: ART, text, fonts: T.FONTS, onAction: hudAction, onResize: syncSheets, play, reduced });
    const fmt = (str, ...args) => String(str).replace(/\{(\d)\}/g, (m, i) => (args[i] ?? ""));
    const tr = (k, fallback) => String(strings[k] ?? fallback).trim();
    selB = SL.createSelection({
      A, P, tr, fmt, verb, pretty,
      openInfo: (xy) => { closeInfo(); S.info = infoLayer(xy); },
      deselect: () => deselect(),
      refresh: () => showSelection(),
    });
    scr = SC.createScreens({
      hud, A, strings, pretty, num, rewardText: D.rewardText, onClose: layerClosed,
      describe: (e) => D.describeEntry(e, M, (p) => (p === S.myId ? "You" : A.ownerName(p))),
    });
    techView = TV.createTechView({ A, scr, TT, pretty, hud });
    hud.resize();
    syncSheets();
  }
  root.__game = { A, S, board, anim, hud, scr, selB, sounds: soundLog, get music() { return sound ? { playing: sound.playingMusic, wanted: sound.wantedMusic } : null; } };
  window.__game = root.__game;
}

// a player's look back or a share link: the game screen replays the game. A link to a moment
// (#<replay turn>.<commands played in it>) opens there.
async function bootReview() {
  const base = share ? `/api/shared/${share}` : `/api/games/${gameId}`;
  const hash = /^#(\d+)\.(\d+)$/.exec(location.hash);
  const at = (data) => (hash ? Math.max(0, data.moments.findIndex((m) => m.index === Number(hash[1]) && m.k === Number(hash[2]))) : 0);
  await bootReplay((RP) => RP.gameSource(api, base), at, { base, gameId, share });
  if (share) document.title = `${S.game.name} · Polytopia`;
}

async function boot() {
  if (root.dataset.botGame) { await bootReplay((RP) => RP.botSource(api, root.dataset.botGame)); return; }
  if (reviewing) { await bootReview(); return; }
  const gameReply = await api.get(`/api/games/${gameId}`);
  S.game = gameReply.game;
  $("g-title").textContent = S.game.name;
  if (S.game.status === "lobby") { await showLobby(); document.body.dataset.ready = "1"; return; }
  await setupScreen();
  await livePanel();

  S.recap = false;
  try { S.lastSeq = Number(localStorage.getItem(seqKey) || 0); S.recap = S.lastSeq > 0; } catch (e) { /* private mode */ }
  await refresh({ initial: true });
  $("g-stats").hidden = false;
  measureBar();
  new ResizeObserver(measureBar).observe($("g-bar"));
  S.wasMine = myTurn();
  const cap = capital();
  const scale = Math.max(18, Math.min(46, $("board").clientWidth / 14));
  if (watching()) board.fit({ animate: false });
  else if (cap) board.centreOn(cap, { scale, animate: false });
  startMusic();
  setInterval(startMusic, 1000);
  if (isOver()) maybeOver();

  $("g-stats").addEventListener("click", openScores);
  $("g-menu").addEventListener("click", openMenu);
  $("g-tech").addEventListener("click", openTech);
  $("g-next").addEventListener("click", () => nextUnit(1));
  $("g-undo").addEventListener("click", undo);
  $("g-centre").addEventListener("click", () => { const c = capital(); if (c) board.centreOn(c); });
  $("g-fast").addEventListener("click", () => { settings.fast = !settings.fast; saveSettings(); updateButtons(); });
  $("g-banner").addEventListener("click", () => { if (bannerKind !== "wait" && bannerKind !== "replay") banner(null); });
  $("end-turn").addEventListener("click", () => {
    const mode = $("end-turn").dataset.mode;
    if (mode === "pause" || mode === "play") togglePause();
    else if (mode === "skip") skipReplay(); else if (mode === "end") endTurn(); else if (mode === "over") { S.overShown = false; maybeOver(); }
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleRefresh(); });
  $("g-speed").addEventListener("click", cycleSpeed);
  if (!watching()) api.events(`/api/games/${gameId}/events`, (ev) => {
    if (ev.kind !== "game") return;
    const d = ev.data || {};
    if (d.version !== S.version || d.status !== S.game.status || d.current_seat !== S.game.current_seat) scheduleRefresh();
  });
  updateButtons();
  document.body.dataset.ready = "1";
  if (watching()) watchLoop();
}

boot().catch((e) => {
  if (!(e && e.status >= 400 && e.status < 500)) console.error(e); // a refusal is shown on the page, not an error in the code
  const msg = e && e.status === 403 ? (reviewing ? e.message || "You can not look back at this game." : "You are not in this game.")
    : e && e.status === 404 ? (share ? "This link does not work any more." : "There is no such game.")
      : e && e.status === 409 && reviewing ? e.message || "There is nothing to look back at yet."
        : "The game could not be loaded.";
  $("g-board-wrap").hidden = true;
  const box = $("g-lobby");
  box.hidden = false;
  document.body.classList.add("g-lobby-page");
  box.replaceChildren(h("div", { class: "page stack" }, h("p", { id: "g-error-text" }, msg), h("a", { class: "btn", href: share ? "/" : "/games" }, share ? "Home" : "Back to games")));
  document.body.dataset.ready = "1";
});
