// The sheets of the game screen. Each builder returns DOM (and a title); none of them decides anything about the rules:
// they show the view and the commands, and hand a chosen command to A.act (A is the game screen, see game.js).

import { h, key, pretty, verb, rewardText, describeEntry, leftToDo, num } from "./derive.js";

const tenths = (n) => (n == null ? "?" : Number.isInteger(n / 10) ? String(n / 10) : (n / 10).toFixed(1));
const btn = (label, cls, onClick, attrs = {}) => h("button", { type: "button", class: `btn ${cls || ""}`.trim(), onclick: onClick, ...attrs }, label);

function stat(label, value) {
  return h("div", { class: "g-stat" }, h("span", { class: "g-stat-v" }, value), h("span", { class: "g-stat-l" }, label));
}

// a unit's numbers as [label, value] rows (the HTML stats and game mode's cards)
export function statsOf(A, type, u) {
  const info = A.M.unit(type);
  if (!info) return null;
  const hp = u ? `${tenths(u.health)}/${tenths(info.health + 50 * (u.promotion || 0))}` : tenths(info.health);
  return [["Health", hp], ["Attack", tenths(info.attack)], ["Defence", tenths(info.defence)], ["Move", String(info.movement)], ["Range", String(info.range)]];
}

export function unitStats(A, type, u) {
  const rows = statsOf(A, type, u);
  if (!rows) return null;
  return h("div", { class: "g-stats" }, rows.map(([k, v]) => stat(k, v)));
}

function abilities(A, type) {
  const info = A.M.unit(type);
  const list = (info?.abilities || []).filter((a) => !["land", "water"].includes(a));
  if (!list.length) return null;
  return h("div", { class: "g-chips" }, list.map((a) => h("span", { class: "g-chip" }, pretty(a))));
}

// ---------- a unit ----------
export function unitPanel(A, u) {
  const M = A.M;
  const mine = u.owner === A.S.myId && A.myTurn();
  const cmds = (A.S.g.byUnit.get(u.id) || []).filter((c) => c.kind !== "Move" && c.kind !== "Attack");
  const body = h("div", { class: "stack" });
  if (mine) {
    const canMove = (A.S.g.byUnit.get(u.id) || []).some((c) => c.kind === "Move" || c.kind === "Attack");
    if (cmds.length) {
      body.append(h("div", { class: "g-actions" }, cmds.map((c) => {
        let label = verb(c.kind);
        if (c.kind === "Upgrade") label += ` to ${M.unitName(c.upgrade_to)}`;
        const cost = c.kind === "Upgrade" ? M.unit(c.upgrade_to)?.cost : null;
        return h("button", { type: "button", class: `btn${c.kind === "Capture" ? " primary" : ""}`, onclick: () => A.act(c), "data-kind": c.kind }, label, cost ? [" ", h("span", { class: "g-cost" }, A.ico.star(), String(cost))] : null);
      })));
    } else if (!canMove) body.append(h("p", { class: "muted" }, "Nothing left to do with this unit this turn."));
    else body.append(h("p", { class: "muted" }, "Tap a marked tile to move or attack."));
  }
  body.append(unitStats(A, u.type, u));
  const ab = abilities(A, u.type);
  if (ab) body.append(ab);
  const notes = [];
  if (u.promotion) notes.push(`Veteran ${u.promotion}`);
  if (u.xp) notes.push(`${u.xp} kills`);
  if (notes.length) body.append(h("p", { class: "muted" }, notes.join(" · ")));
  return { title: `${M.unitName(u.type)}`, sub: A.ownerName(u.owner), content: body };
}

// one tribe that has found a lighthouse (A.lighthouse lists them), with its colour as on the tower's gem
function seenOne(A, id) {
  const pl = (A.S.view.view.position.players || []).find((p) => p.id === id);
  return h("span", { class: "g-seen-one" },
    h("span", { class: "g-dot", style: `background:${A.M.tribeColour(pl?.tribe)}` }),
    `${A.M.tribeName(pl?.tribe)}${id === A.S.myId ? " (you)" : ""}`);
}

// ---------- facts about a tile (shared by the tile sheet and the info card) ----------
export function tileFacts(A, xy) {
  const M = A.M, t = A.tile(xy), city = A.city(xy);
  if (!t || !t.terrain) return { title: "Unexplored", rows: [] };
  const rows = [];
  const owner = t.owner ? A.ownerName(t.owner) : null;
  if (owner) rows.push(["Owner", t.owner === A.S.myId ? `You (${owner})` : owner]);
  rows.push(["Terrain", M.terrainName(t.terrain)]);
  if (t.resource) rows.push(["Resource", M.resourceName(t.resource)]);
  if (t.improvement && !city) rows.push(["Building", M.imprName(t.improvement)]);
  if (t.road) rows.push(["Road", "Yes"]);
  const lighthouse = city ? null : A.lighthouse(xy);
  if (lighthouse) {
    const ids = lighthouse.found;
    rows.push(["Seen by", ids.length ? h("span", { class: "g-seen" }, ids.map((id) => seenOne(A, id))) : "No one yet"]);
  }
  if (city) {
    rows.push(["Level", String(city.level)]);
    if (city.population != null) rows.push(["Population", String(city.population)]);
    if (city.production != null) rows.push(["Income", `+${city.production} stars a turn`]);
  }
  const title = city ? `${t.capital ? "Capital" : "City"}${city.name ? ` ${city.name}` : ""}` : t.improvement ? M.imprName(t.improvement) : M.terrainName(t.terrain);
  return { title, rows };
}
const factsList = (rows) => h("dl", { class: "g-facts" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));

// ---------- a tile or a city of mine: what can be built or trained ----------
// Like the retail city bar: a round button for each unit or building, with its picture and price. Tapping one picks it and
// shows its details below, with a Train (or Build) button; tapping the picked one again does the same. The sheet stays
// open and where it is: only the details change (and the setting "Ask before training or building" off makes one tap enough).
const REWARD_ICON = { Resources: "icon/rewards_resources", PopulationGrowth: "icon/rewards_populationgrowth", BorderGrowth: "icon/rewards_bordergrowth", Explorer: "icon/rewards_explorer", Workshop: "icon/rewards_workshop", CityWall: "icon/rewards_citywall", Park: "icon/rewards_park" };
let picked = null; // { at: "x,y", id: "train:3" } the choice open in the details of the sheet

export function tilePanel(A, xy) {
  const M = A.M, ico = A.ico;
  const at = key(xy);
  const f = tileFacts(A, xy);
  const city = A.city(xy);
  const mine = !!city && city.owner === A.S.myId;
  const cmds = A.myTurn() ? A.S.g.byTile.get(at) || [] : [];
  const tribe = (M.tribe(A.S.view.view.me && A.S.view.view.me.tribe) || {}).name;
  // known but too dear: shown greyed with a red price, as in retail (the server's `moves.locked`)
  const locked = (A.myTurn() ? A.S.g.lockedByTile.get(at) || [] : []).map((c) => ({ ...c, locked: true }));
  const rewards = cmds.filter((c) => c.kind === "CityReward");
  const trains = [...cmds, ...locked].filter((c) => c.kind === "Train");
  const builds = [...cmds, ...locked].filter((c) => c.kind === "Build");
  const rest = cmds.filter((c) => !["CityReward", "Train", "Build"].includes(c.kind));
  if (!picked || picked.at !== at || ![...trains, ...builds].some((c) => idOf(c) === picked.id)) picked = null;
  const body = h("div", { class: "stack g-city" });

  if (mine) {
    const income = city.production;
    body.append(h("div", { class: "g-city-head" },
      h("span", { class: "g-chip g-chip-ico" }, `Level ${city.level}`),
      city.population != null ? h("span", { class: "g-chip g-chip-ico", title: "Population" }, ico.population(), String(city.population)) : null,
      income != null ? h("span", { class: "g-chip g-chip-ico g-cost", title: "Stars a turn" }, ico.star(), `+${income}`) : null));
  }
  if (rewards.length) {
    body.append(h("h3", { class: "g-h" }, "This city can level up: pick a reward"));
    body.append(h("div", { class: "stack" }, rewards.map((c) => h("button", { type: "button", class: "btn primary block g-reward", onclick: () => A.act(c), "data-reward": c.reward },
      ico.icon(REWARD_ICON[c.reward] || "icon/rewards_city", pretty(c.reward), { cls: "g-reward-ico" }),
      h("span", { class: "g-reward-text" }, h("strong", {}, pretty(c.reward)), rewardText(c.reward) ? h("span", { class: "g-sub" }, rewardText(c.reward)) : null)))));
  }

  // one list of round buttons (units or buildings) and the details of the picked one under it
  const chooser = (title, list, kind) => {
    if (!list.length) return;
    const grid = h("div", { class: "g-picks", role: "listbox", "aria-label": title });
    const detail = h("div", { class: "g-pick-detail", hidden: true, "aria-live": "polite" });
    const open = (c) => {
      const id = idOf(c);
      picked = { at, id };
      for (const b of grid.children) { const on = b.dataset.pick === id; b.classList.toggle("sel", on); b.setAttribute("aria-selected", String(on)); }
      fillDetail(c);
      if (detail.scrollIntoView) detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const go = (c) => A.run(c);
    const fillDetail = (c) => {
      const isTrain = c.kind === "Train";
      const info = isTrain ? M.unit(c.train) : M.impr(c.improvement);
      const name = isTrain ? M.unitName(c.train) : M.imprName(c.improvement);
      const cost = info ? info.cost : "?";
      const stars = A.S.view.view.me.stars;
      detail.hidden = false;
      detail.replaceChildren(
        h("div", { class: "g-pick-head" }, pic(c), h("strong", {}, name), h("span", { class: "g-cost g-pick-cost" }, ico.star(), String(cost))),
        isTrain ? unitStats(A, c.train) : null,
        isTrain ? abilities(A, c.train) : null,
        h("p", { class: "muted g-pick-stars" }, `You have ${stars} stars.`),
        c.locked
          ? h("button", { type: "button", class: "btn block", "data-act": "confirm", disabled: true }, "Not enough stars ", ico.star(), String(cost))
          : h("button", { type: "button", class: "btn primary block", "data-act": "confirm", onclick: () => go(c) }, isTrain ? "Train" : "Build", " ", ico.star(), String(cost)));
    };
    const pic = (c) => (c.kind === "Train" ? ico.unit((M.unit(c.train) || {}).id, tribe, M.unitName(c.train), "g-pick-ico") : ico.improvement((M.impr(c.improvement) || {}).id, tribe, M.imprName(c.improvement), "g-pick-ico"));
    for (const c of list) {
      const id = idOf(c);
      const info = c.kind === "Train" ? M.unit(c.train) : M.impr(c.improvement);
      const name = c.kind === "Train" ? M.unitName(c.train) : M.imprName(c.improvement);
      const attrs = c.kind === "Train" ? { "data-train": c.train } : { "data-build": c.improvement };
      grid.append(h("button", { type: "button", class: `g-pick${c.locked ? " locked" : ""}`, role: "option", "aria-selected": "false", "data-pick": id, ...attrs,
        ...(c.locked ? { "data-locked": "1" } : {}),
        "aria-label": `${name}, ${info ? info.cost : "?"} stars${c.locked ? ", not enough stars" : ""}`,
        onclick: () => (!c.locked && (!A.settings.infoOnBuild || (picked && picked.id === id && picked.at === at)) ? go(c) : open(c)) },
      pic(c), h("span", { class: "g-pick-name" }, name), h("span", { class: `g-cost g-pick-price${c.locked ? " short" : ""}` }, ico.star(), String(info ? info.cost : "?"))));
    }
    body.append(h("h3", { class: "g-h" }, title), grid, detail);
    const was = picked && list.find((c) => idOf(c) === picked.id);
    if (was) { for (const b of grid.children) { const on = b.dataset.pick === picked.id; b.classList.toggle("sel", on); b.setAttribute("aria-selected", String(on)); } fillDetail(was); }
  };
  chooser("Train", trains);
  chooser("Build", builds);

  if (rest.length) body.append(h("div", { class: "g-actions" }, rest.map((c) => h("button", { type: "button", class: "btn", onclick: () => A.act(c), "data-kind": c.kind }, verb(c.kind)))));
  if (mine && A.myTurn() && !trains.length && !rewards.length) {
    body.append(h("p", { class: "muted g-nothing" }, A.unitAt(xy) ? "Nothing can be trained here while a unit stands in the city." : "Nothing can be trained here right now: not enough stars, or nothing unlocked yet."));
  }
  body.append(factsList(mine ? f.rows.filter(([k]) => !["Level", "Population", "Income"].includes(k)) : f.rows));
  return { title: f.title, content: body, tall: !!(rewards.length || trains.length || builds.length), city: !!city };
}
const idOf = (c) => (c.kind === "Train" ? `train:${c.train}` : `build:${c.improvement}`);

// ---------- a long press: what is this ----------
export function infoPanel(A, xy) {
  const f = tileFacts(A, xy);
  const u = A.unitAt(xy);
  const body = h("div", { class: "stack" });
  if (u) {
    body.append(h("h3", { class: "g-h" }, `${A.M.unitName(u.type)} · ${A.ownerName(u.owner)}`));
    body.append(unitStats(A, u.type, u));
    const ab = abilities(A, u.type);
    if (ab) body.append(ab);
  }
  body.append(factsList(f.rows));
  return { title: u ? A.M.unitName(u.type) : f.title, content: body };
}

// ---------- the exact result of an attack, before it is played ----------
export function forecastPanel(A, cmd, { buttons = true } = {}) {
  const c = cmd.combat || {};
  const att = A.unitAt(cmd.from), def = A.unitAt(cmd.to);
  const M = A.M;
  const row = (who, text, bad, skull) => h("li", { class: `g-fc${bad ? " bad" : ""}` }, h("span", { class: "g-fc-who" }, who), h("span", { class: "g-fc-what" }, text, skull ? h("span", { class: "g-skull", "aria-label": "dies" }, " ☠") : null));
  const rows = [];
  const dLeft = def ? Math.max(0, def.health - (c.damage || 0)) : null;
  rows.push(row(def ? M.unitName(def.type) : "Target", `−${tenths(c.damage || 0)}${dLeft != null && !c.kills ? ` (${tenths(dLeft)} left)` : ""}${c.kills ? " · destroyed" : ""}`, false, c.kills));
  if (c.retaliation) {
    const aLeft = att ? Math.max(0, att.health - c.retaliation) : null;
    rows.push(row(att ? `Your ${M.unitName(att.type)}` : "Your unit", `−${tenths(c.retaliation)}${aLeft != null && !c.dies ? ` (${tenths(aLeft)} left)` : ""}${c.dies ? " · lost" : ""}`, true, c.dies));
  } else if (c.dies) rows.push(row("Your unit", "lost", true, true));
  const body = h("div", { class: "stack" },
    h("ul", { class: "g-fcs" }, rows),
    c.converts ? h("p", { class: "muted" }, "The target changes side.") : null,
    buttons ? h("div", { class: "g-actions end" }, btn("Cancel", "", () => A.cancelForecast(), { "data-act": "cancel" }), btn("Attack", "primary danger", () => A.confirmAttack(cmd), { "data-act": "attack" })) : null);
  return { title: def ? `Attack ${M.unitName(def.type)}` : "Attack", content: body };
}

// ---------- scores, peace and embassies ----------
export function scorePanel(A, sheet) {
  const V = A.S.view.view, g = A.S.game, M = A.M;
  const scores = [...(V.scores || [])].sort((a, b) => b[1] - a[1]);
  const body = h("div", { class: "stack" });
  body.append(h("p", { class: "muted" }, A.modeText()));
  const pending = A.S.g.diplomacy.filter((c) => c.kind === "PeaceResponse");
  for (const id of new Set(pending.map((c) => c.with))) {
    body.append(h("div", { class: "card g-ask" }, h("p", {}, `${A.ownerName(id)} asks for peace.`),
      h("div", { class: "g-actions end" }, pending.filter((c) => c.with === id).map((c) => btn(c.accept ? "Accept" : "Decline", c.accept ? "primary" : "", () => { sheet.close(); A.act(c); })))));
  }
  body.append(h("ul", { class: "list g-scores" }, scores.map(([id, s], i) => {
    const pl = (V.position.players || []).find((p) => p.id === id);
    const dip = A.S.g.diplomacy.filter((c) => c.with === id && c.kind !== "PeaceResponse");
    return h("li", { class: "g-score-row" },
      h("div", { class: "list-item" },
        h("span", { class: "g-rank" }, String(i + 1)),
        h("span", { class: "g-dot", style: `background:${M.tribeColour(pl?.tribe)}` }),
        h("span", { class: "title" }, A.ownerName(id), id === A.S.myId ? " (you)" : "", h("span", { class: "sub" }, `${M.tribeName(pl?.tribe)}${pl && pl.alive === false ? " · out" : ""}`)),
        h("span", { class: "end" }, num(s))),
      dip.length ? h("div", { class: "g-actions end g-dip" }, dip.map((c) => btn(c.kind === "PeaceTreaty" ? "Offer peace" : c.kind === "BreakPeace" ? "Break peace" : c.kind === "EstablishEmbassy" ? "Embassy" : verb(c.kind), "", () => { sheet.close(); A.act(c); }))) : null);
  })));
  if (!scores.length) body.append(h("p", { class: "muted" }, "No scores yet."));
  const unmet = (V.position.players || []).filter((p) => p.id !== 255 && !scores.some(([id]) => id === p.id)).length;
  if (unmet && !V.over) body.append(h("p", { class: "muted g-unmet" }, `${unmet === 1 ? "One tribe has" : `${unmet} tribes have`} not been met yet. Scores appear once you meet them.`));
  return { title: "Scores", content: body };
}

// a tribe's peace offer: the engine allows nothing else until it is answered
export function peacePanel(A, cmds, sheet) {
  const id = cmds[0].with;
  const mine = cmds.filter((c) => c.with === id);
  const pick = (accept) => mine.find((c) => c.accept === accept);
  return {
    title: "Peace treaty",
    className: "g-modal-sheet g-peace",
    content: h("div", { class: "stack" },
      h("p", {}, `${A.ownerName(id)} wants to make peace with you.`),
      h("p", { class: "muted" }, "At peace, neither of you can attack the other until the treaty is broken."),
      h("div", { class: "g-actions end" },
        pick(false) ? btn("Decline", "", () => { sheet.close(); A.act(pick(false)); }, { "data-act": "peace-decline" }) : null,
        pick(true) ? btn("Accept", "primary", () => { sheet.close(); A.act(pick(true)); }, { "data-act": "peace-accept" }) : null)),
  };
}

// ---------- the log ----------
export async function logPanel(A) {
  const body = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading the log…"));
  A.fetchLog().then((entries) => {
    body.replaceChildren();
    if (!entries.length) { body.append(h("p", { class: "muted" }, "Nothing has happened yet.")); return; }
    let turn = null;
    const ul = h("ul", { class: "list g-log" });
    for (const e of [...entries].reverse()) {
      if (e.turn !== turn) { turn = e.turn; ul.append(h("li", { class: "g-log-turn" }, `Turn ${turn}`)); }
      ul.append(h("li", { class: "list-item" }, describeEntry(e, A.M, (p) => (p === A.S.myId ? "You" : A.ownerName(p)))));
    }
    body.append(ul);
  }).catch((err) => body.replaceChildren(h("p", { class: "muted" }, err.message || "The log could not be loaded.")));
  return { title: "Log", content: body };
}

// ---------- the menu ----------
export function menuPanel(A, sheet) {
  const item = (label, onClick, extra = {}) => h("li", {}, h("button", { type: "button", class: "list-item g-row", onclick: () => { sheet.close(); onClick(); }, ...extra.attrs }, h("span", { class: "title" }, label, extra.sub ? h("span", { class: "sub" }, extra.sub) : null)));
  const toggle = (label, name, sub) => h("li", {}, h("label", { class: "list-item g-row g-toggle" },
    h("span", { class: "title" }, label, sub ? h("span", { class: "sub" }, sub) : null),
    h("input", { type: "checkbox", checked: A.settings[name] ? true : null, onchange: (e) => { A.settings[name] = e.target.checked; A.saveSettings(); A.settingsChanged(name); }, "data-setting": name })));
  const audioToggle = (label, name, sub) => h("li", {}, h("label", { class: "list-item g-row g-toggle" },
    h("span", { class: "title" }, label, sub ? h("span", { class: "sub" }, sub) : null),
    h("input", { type: "checkbox", checked: A.audio()[name] ? true : null, onchange: (e) => A.setAudio(name, e.target.checked), "data-setting": name })));
  const V = A.S.view.view;
  const watching = !!A.S.game.watching;
  const list = h("ul", { class: "list" },
    watching ? null : item("Tech tree", () => A.openTech()), item("Scores", () => A.openScores()), item("Log", () => A.openLog()),
    A.canUndo() ? item("Undo", () => A.undo(), { sub: "Practice games only", attrs: { "data-act": "undo" } }) : null,
    A.S.game.assist && A.myTurn() ? item("Hint", () => A.hint(), { sub: "What the AI would play" }) : null,
    A.S.game.assist && V.full_position ? h("li", {}, h("label", { class: "list-item g-row g-toggle" }, h("span", { class: "title" }, "Show the whole map", h("span", { class: "sub" }, "Practice game: lifts the fog")),
      h("input", { type: "checkbox", checked: A.S.fogOff ? true : null, onchange: (e) => { A.setFog(e.target.checked); }, "data-setting": "fog" }))) : null,
    h("li", {}, h("label", { class: "list-item g-row g-toggle" }, h("span", { class: "title" }, "Game look", h("span", { class: "sub" }, "Draw the screen like the real game")),
      h("input", { type: "checkbox", checked: A.uiMode === "game" ? true : null, onchange: (e) => A.setUiMode(e.target.checked ? "game" : "technical"), "data-setting": "ui-mode" }))),
    audioToggle("Sound effects", "effects"), audioToggle("Music", "music", "The tribe's song"),
    watching ? null : toggle("Confirm end turn", "confirmEnd"), watching ? null : toggle("Ask before training or building", "infoOnBuild"),
    watching ? null : toggle("Follow opponents' moves", "follow"), watching ? null : toggle("Fast replays", "fast"),
    watching ? null : toggle("Highlight what you can build", "buildGlow", "A blue glow on tiles you have the tech for"),
    A.S.game.status === "active" && !watching ? item("Resign", () => A.resign(), { attrs: { class: "list-item g-row g-danger", "data-act": "resign" } }) : null,
    h("li", {}, h("a", { class: "list-item g-row", href: "/games" }, h("span", { class: "title" }, "Back to games"))));
  return { title: "Menu", content: list };
}

// ---------- end turn ----------
export function endPanel(A, left, sheet) {
  const next = left.find((l) => l.kind === "units");
  const last = A.isLastTurn();
  return {
    title: "End your turn?",
    content: h("div", { class: "stack" },
      h("ul", { class: "g-left" }, left.map((l) => h("li", {}, l.text)), last ? h("li", {}, "This is the last turn of the game.") : null),
      h("div", { class: "g-actions end" },
        next ? btn("Next unit", "", () => { sheet.close(); A.nextUnit(1); }, { "data-act": "next" }) : null,
        btn("Keep playing", "", () => sheet.close()),
        btn("End turn", "primary", () => { sheet.close(); A.endTurnNow(); }, { "data-act": "end-confirm" }))),
  };
}

// ---------- game over ----------
export function overPanel(A, sheet) {
  const V = A.S.view.view;
  const winners = V.winners || [];
  const watching = !!A.S.game.watching;
  const won = !watching && winners.includes(A.S.myId);
  const scores = [...(V.scores || [])].sort((a, b) => b[1] - a[1]);
  const body = h("div", { class: "stack", "data-over": watching ? "watch" : "play" },
    h("p", { class: "g-over-line" }, winners.length ? (won ? "You won." : `${winners.map((w) => A.ownerName(w)).join(" and ")} won.`) : "The game is over."),
    h("ul", { class: "list" }, scores.map(([id, s], i) => h("li", { class: "list-item" }, h("span", { class: "g-rank" }, String(i + 1)), h("span", { class: "title" }, A.ownerName(id), id === A.S.myId ? " (you)" : ""), h("span", { class: "end" }, num(s))))),
    h("div", { class: "g-actions end" }, h("a", { class: "btn", href: "/games" }, "Games"), h("a", { class: "btn primary", href: `/games/${A.S.gameId}/review`, "data-act": "review" }, "Review the game")));
  return { title: won ? "Victory" : winners.length && !watching ? "Defeat" : "Game over", content: body, won };
}

// A tribe met for the first time, as the retail popup: "You have met <tribe>!" with each new tribe's colour
// and the stars the engine paid for the meeting (`stars`, from the view's change)
export function meetPanel(A, ids, sheet, stars = 0) {
  const M = A.M, players = A.S.view.view.position.players || [];
  const met = ids.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const names = met.map((p) => M.tribeName(p.tribe));
  const body = h("div", { class: "stack" },
    h("ul", { class: "list" }, met.map((p) => h("li", { class: "list-item" },
      h("span", { class: "g-dot", style: `background:${M.tribeColour(p.tribe)}` }),
      h("span", { class: "title" }, M.tribeName(p.tribe)),
      A.botName(p.id) ? h("span", { class: "end g-meet-leader" }, `Their leader ${A.botName(p.id)}`) : null))),
    stars > 0 ? h("p", { class: "g-meet-stars", "data-stars": String(stars) }, `A one time trade boost of ${stars} stars!`) : null,
    h("div", { class: "g-actions end" }, h("button", { type: "button", class: "btn primary", "data-act": "meet-ok", onclick: () => sheet.close() }, "OK")));
  return { title: names.length === 1 ? `You have met ${names[0]}!` : `You have met ${names.length} tribes!`, content: body };
}
