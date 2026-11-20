// What the game screen knows about the rules is only what the engine tells it: the view's legal commands and the
// tables in /api/meta. This file groups and names them; it decides nothing (no legality, no damage, no costs).

import { pretty } from "ui/names.js";

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export { pretty };

const REWARD_TEXT = {
  Resources: "+5 stars now",
  PopulationGrowth: "+3 population",
  BorderGrowth: "The city's border grows",
  Explorer: "An explorer appears",
  SuperUnit: "A giant appears",
  Workshop: "+1 star every turn",
  CityWall: "A wall defends the city",
};
export const rewardText = (r) => REWARD_TEXT[r] || "";

// The unit kinds that never count as "this unit can still act" for the end-of-turn warning.
const IDLE_KINDS = new Set(["Disband", "Stay", "Destroy"]);
const VERB = {
  Capture: "Capture", Recover: "Heal", HealOthers: "Heal others", Promote: "Promote", ExamineRuins: "Examine ruins",
  Upgrade: "Upgrade", Disband: "Disband", Stay: "Stay", Explode: "Explode", Boost: "Boost", Swarm: "Swarm",
  Disembark: "Disembark", Harvest: "Harvest", Decompose: "Decompose", Hide: "Hide", Flood: "Flood", FreezeArea: "Freeze area",
  BreakIce: "Break ice", ClearTileEffect: "Clear", Destroy: "Destroy",
};
export const verb = (kind) => VERB[kind] || pretty(kind);

export function index(meta) {
  const e = meta.engine || {};
  const units = new Map((e.units || []).map((u) => [u.idx, u]));
  const impr = new Map((e.improvements || []).map((i) => [i.idx, i]));
  const techs = new Map((e.techs || []).map((t) => [t.idx, t]));
  const techById = new Map((e.techs || []).map((t) => [t.id, t]));
  const parents = new Map();
  for (const t of techs.values()) for (const c of t.unlocks || []) {
    const ct = techById.get(c);
    if (ct) parents.set(ct.idx, [...(parents.get(ct.idx) || []), t.idx]);
  }
  const tribes = new Map((meta.tribes || []).map((t) => [t.idx, t]));
  const terrain = new Map((meta.terrain || []).map((t) => [t.id, t.name]));
  const resource = new Map((meta.resources || []).map((t) => [t.id, t.name]));
  return {
    unit: (i) => units.get(i), unitName: (i) => pretty(units.get(i)?.id ?? `unit ${i}`),
    impr: (i) => impr.get(i), imprName: (i) => pretty(impr.get(i)?.id ?? `building ${i}`),
    tech: (i) => techs.get(i), techName: (i) => pretty(techs.get(i)?.id ?? `tech ${i}`), techs, techById, parents,
    tribe: (i) => tribes.get(i), tribeName: (i) => pretty(tribes.get(i)?.name ?? "Nature"),
    tribeColour: (i) => tribes.get(i)?.colour || "#999999",
    // a player's colour (a position's player record): its own `colour` (0xRRGGBB) when it has one, else its tribe's.
    // Several players may play one tribe; the later ones have another colour.
    playerColour: (p) => (p && typeof p.colour === "number" ? `#${(p.colour & 0xffffff).toString(16).padStart(6, "0")}` : tribes.get(p && p.tribe)?.colour || "#999999"),
    terrainName: (i) => pretty(terrain.get(i) || "unknown"), resourceName: (i) => pretty(resource.get(i) || ""),
    isWater: (i) => i === 1 || i === 2,
  };
}

export const key = (xy) => `${xy[0]},${xy[1]}`;

// The commands of the view, grouped by what they act on. `byUnit`: unit id -> its commands; `byTile`: "x,y" -> the
// tile commands (train, build, reward, destroy ...); `research`; `diplomacy`; `end` the EndTurn command.
// `lockedByTile`: "x,y" -> the trains and builds known but not affordable (the server's `moves.locked`).
export function group(commands, locked = []) {
  const g = { byUnit: new Map(), byTile: new Map(), lockedByTile: new Map(), research: [], diplomacy: [], end: null, all: commands || [] };
  for (const c of locked || []) if (c.to) g.lockedByTile.set(key(c.to), [...(g.lockedByTile.get(key(c.to)) || []), c]);
  for (const c of commands || []) {
    if (c.unit != null) g.byUnit.set(c.unit, [...(g.byUnit.get(c.unit) || []), c]);
    else if (c.kind === "Research") g.research.push(c);
    else if (c.kind === "EndTurn") g.end = c;
    else if (c.with != null) g.diplomacy.push(c);
    else if (c.to) g.byTile.set(key(c.to), [...(g.byTile.get(key(c.to)) || []), c]);
  }
  return g;
}

// Own units that can still do something, in board order (top row first), and what the end-of-turn sheet lists.
export function actingUnits(g, units, me) {
  return units
    .filter((u) => u.owner === me && (g.byUnit.get(u.id) || []).some((c) => !IDLE_KINDS.has(c.kind)))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function leftToDo(g, units, me) {
  const out = [];
  const n = actingUnits(g, units, me).length;
  if (n) out.push({ kind: "units", n, text: `${n} unit${n === 1 ? "" : "s"} can still move` });
  if (g.research.length) out.push({ kind: "tech", n: g.research.length, text: "You can research a tech" });
  return out;
}

export const moveUnitKinds = new Set(["Move", "Attack"]);

// What a log entry says, in a few words. `who(player)` names the actor.
export function describeEntry(e, M, who) {
  const unit = e.unit_type != null ? M.unitName(e.unit_type) : "unit";
  const at = e.to ? ` (${e.to[0]}, ${e.to[1]})` : "";
  const actor = who(e.player);
  switch (e.kind) {
    case "Move": return `${actor}: ${unit} moved${at}`;
    case "Attack": return `${actor}: ${unit} attacked${e.target_type != null ? " a " + M.unitName(e.target_type) : ""}${at}`;
    case "Train": return `${actor}: trained a ${M.unitName(e.train)}${at}`;
    case "Build": return `${actor}: built ${M.imprName(e.improvement)}${at}`;
    case "Capture": return `${actor}: ${unit} captured a city${at}`;
    case "Research": return `${actor}: researched ${M.techName(e.tech)}`;
    case "CityReward": return `${actor}: city reward, ${pretty(e.reward)}${at}`;
    case "Upgrade": return `${actor}: ${unit} upgraded to ${M.unitName(e.upgrade_to)}`;
    case "EndTurn": return `${actor} ended the turn`;
    case "PeaceTreaty": return `${actor} offered peace`;
    case "PeaceResponse": return `${actor} ${e.accept ? "accepted" : "refused"} peace`;
    case "BreakPeace": return `${actor} broke the peace`;
    case "EstablishEmbassy": return `${actor} opened an embassy`;
    default: return `${actor}: ${unit} ${verb(e.kind).toLowerCase()}${at}`;
  }
}

export const num = (n) => Number(n).toLocaleString("en-GB");
