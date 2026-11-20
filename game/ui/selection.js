// What game mode's selection bar (ui/selbar.js) shows for a unit, a tile or city, and an attack: the header, the
// description and the round buttons, in the retail wording (strings.json) where the game has it. Like panels.js it
// decides nothing about the rules: the buttons are the view's commands, handed to A.act or A.run.
//
// The city menu works as panels.js's: a round button per unit or building with its price; with "Info on Build" on the
// first tap picks one (it turns blue and the bar describes it) and the second plays it; a price out of reach is grey
// with a red price and only describes.

const tenths = (n) => (n == null ? "?" : Number.isInteger(n / 10) ? String(n / 10) : (n / 10).toFixed(1));
const ACTION_ICON = {
  Capture: "icon/capture", Recover: "icon/recover", HealOthers: "icon/healothers", Promote: "icon/promote",
  ExamineRuins: "icon/examineruins", Disband: "icon/disband", Explode: "icon/explode", Boost: "icon/boost", Swarm: "icon/swarm",
  Disembark: "icon/disembark", Decompose: "icon/decompose", FreezeArea: "icon/freezearea", BreakIce: "icon/breakice",
  Destroy: "icon/destroy", Upgrade: "icon/upgrade", Stay: "icon/move",
};
const ACTION_STRING = {
  Capture: "action.info.capture", Recover: "action.info.recover", HealOthers: "action.info.healothers", Promote: "action.info.promote",
  ExamineRuins: "action.info.examineruins", Explode: "action.info.explode", Boost: "action.info.boost", Swarm: "action.info.swarm",
  Disembark: "action.info.disembark", Decompose: "action.info.decompose", FreezeArea: "action.info.freezearea", BreakIce: "action.info.breakice",
  Destroy: "action.info.destroy", Stay: "action.info.stay",
};
// buildings whose picture is the resource they harvest, or a UI icon
const BUILD_ICON = {
  fishing: () => ["resource/fish"], starfishing: () => ["resource/starfish"], harvestspores: () => ["resource/spores"],
  hunting: (c) => [`resource/game/${c}`, "resource/game/bardur"], harvestfruit: (c) => [`resource/fruit/${c}`, "resource/fruit/bardur"],
  clearforest: () => ["icon/clear_forest"], burnforest: () => ["icon/burn_forest"], growforest: () => ["icon/grow_forest"], road: () => ["icon/road"],
};

export function createSelection(env) {
  const { A, tr, fmt, verb, P } = env;
  const M = () => A.M;
  const V = () => A.S.view.view;
  let picked = null; // { at: "x,y", id: "train:3" }

  const myTribe = () => (M().tribe(V().me && V().me.tribe) || {}).name || "bardur";
  const tribeOf = (owner) => {
    const pl = (V().position.players || []).find((p) => p.id === owner);
    return pl ? M().tribe(pl.tribe) : null;
  };
  const actionLabel = (c) => {
    if (c.kind === "Upgrade") return M().unitName(c.upgrade_to);
    if (c.kind === "Disband") return fmt(tr("action.info.disband", "Disband {0}"), "").trim() || "Disband";
    return ACTION_STRING[c.kind] ? tr(ACTION_STRING[c.kind], verb(c.kind)) : verb(c.kind);
  };
  const unitIcon = (id, tribe) => [tribe && `unit/${tribe}/${id}`, `icon/${id}_icon`].filter(Boolean);

  // ---------- a unit ----------
  function unitDesc(u) {
    const parts = [];
    const info = M().unit(u.type);
    const mine = u.owner === A.S.myId;
    if (mine && Array.isArray(u.home)) {
      const home = A.city(u.home);
      if (home && home.name) parts.push(fmt(tr("world.unit.info.from", "From the city of {0}."), home.name));
    }
    if (!mine) parts.push(`${A.ownerName(u.owner)}.`);
    if (info) parts.push(`${tr("unit.info.health", "Health")} ${tenths(u.health)}/${tenths(info.health + 50 * (u.promotion || 0))}, ${tr("unit.info.attack", "attack").toLowerCase()} ${tenths(info.attack)}, ${tr("unit.info.defence", "defence").toLowerCase()} ${tenths(info.defence)}.`);
    if (u.promotion) parts.push(tr("world.unit.veteran", "This unit is a veteran."));
    else if (mine && u.xp) parts.push(fmt(tr("world.unit.veteran.progress", "{0}/{1} to become a veteran."), u.xp, 3));
    return parts.join(" ");
  }

  function unit(u) {
    const tribe = (tribeOf(u.owner) || {}).name;
    const info = M().unit(u.type);
    const mine = u.owner === A.S.myId && A.myTurn();
    const cmds = mine ? (A.S.g.byUnit.get(u.id) || []).filter((c) => c.kind !== "Move" && c.kind !== "Attack") : [];
    const seen = new Map();
    const buttons = cmds.map((c) => {
      const n = (seen.get(c.kind) || 0) + 1;
      seen.set(c.kind, n);
      const up = c.kind === "Upgrade" ? M().unit(c.upgrade_to) : null;
      return {
        id: `act:${c.kind}${n > 1 ? `:${n}` : ""}`, label: actionLabel(c), kind: c.kind,
        icon: up ? unitIcon(up.id, tribe) : [ACTION_ICON[c.kind]].filter(Boolean), iconScale: up ? 0.8 : 0.62,
        cost: up ? up.cost : null, fill: c.kind === "Capture" ? "rgba(0,153,255,0.8)" : null,
        onTap: () => A.act(c),
      };
    });
    return {
      key: `unit:${u.id}`, header: M().unitName(u.type), desc: unitDesc(u),
      portrait: { xy: [u.x, u.y], unit: u.id }, portraitIcon: info ? [`icon/${info.id}_icon`] : null,
      info: () => env.openInfo([u.x, u.y]), back: () => env.deselect(),
      buttons,
    };
  }

  // ---------- a tile or a city ----------
  // A lighthouse: retail names it by its map corner and says who has found it (TileTipGenerator.GetTileTip); until
  // someone has, the game's own words about it.
  const lighthouseName = (lh) => tr(`building.names.lighthouse.${lh.corner}`, `${lh.corner.replace(/^./, (c) => c.toUpperCase())}ern Lighthouse`);
  function lighthouseDesc(lh) {
    const names = lh.found.map((id) => tribeOf(id)).filter(Boolean).map((tribe) => M().tribeName(tribe.idx));
    if (!names.length) return tr("tooltip.tile.lighthouse", "A mighty lighthouse constructed by someone a very long time ago.").trim();
    return `${tr("tooltip.tile.lighthouse.discovered_by", "Discovered by ").trim()} ${names.join(", ")}.`;
  }

  function tileDesc(xy, t, city) {
    const f = P.tileFacts(A, xy);
    const val = (k) => { const r = f.rows.find(([kk]) => kk === k); return r ? (typeof r[1] === "string" ? r[1] : r[1].textContent) : null; };
    const lh = A.lighthouse(xy);
    if (lh) return lighthouseDesc(lh);
    if (city && !city.owner) return tr("building.village.owner", "This is a village that doesn't belong to any tribe");
    if (city) {
      const tribe = tribeOf(city.owner);
      const tname = tribe ? M().tribeName(tribe.idx) : "";
      const name = city.name || "This city";
      const parts = [fmt(tr(t.capital ? "building.capital.owner" : "building.city.owner", t.capital ? "{0} is the {1} capital" : "{0} is a city in the {1} empire"), name, tname)];
      if (city.owner === A.S.myId) {
        const bits = [`level ${city.level}`];
        if (city.population != null) bits.push(`population ${city.population}`);
        if (city.production != null) bits.push(`+${city.production} stars a turn`);
        parts.push(bits.join(", "));
      }
      return `${parts.join(": ")}.`;
    }
    const impr = t.improvement ? M().impr(t.improvement) : null;
    if (impr && impr.id === "ruin") return tr("building.ability.ruin", "A ruin from an ancient civilization.");
    const parts = [];
    if (impr && impr.id !== "road") parts.push(M().imprName(t.improvement));
    else if (t.resource) parts.push(val("Resource"));
    if (t.road) parts.push("road");
    parts.push(t.owner ? (t.owner === A.S.myId ? "Your land" : `${A.ownerName(t.owner)}'s land`) : "No one's land");
    return `${parts.filter(Boolean).join(", ")}.`.replace(/^./, (c) => c.toUpperCase());
  }

  const idOf = (c) => (c.kind === "Train" ? `train:${c.train}` : `build:${c.improvement}`);
  function pickDesc(c) {
    const isTrain = c.kind === "Train";
    const info = isTrain ? M().unit(c.train) : M().impr(c.improvement);
    const cost = info ? info.cost : "?";
    const stars = V().me ? V().me.stars : 0;
    const parts = [];
    if (isTrain && info) parts.push(`${tr("unit.info.health", "Health")} ${tenths(info.health)}, ${tr("unit.info.attack", "attack").toLowerCase()} ${tenths(info.attack)}, ${tr("unit.info.defence", "defence").toLowerCase()} ${tenths(info.defence)}, ${tr("unit.info.movement", "movement").toLowerCase()} ${info.movement}, ${tr("unit.info.range", "range").toLowerCase()} ${info.range}.`);
    const ab = (info && info.abilities || []).filter((a) => !["land", "water"].includes(a)).map((a) => env.pretty(a).toLowerCase());
    if (ab.length) parts.push(`${ab.join(", ").replace(/^./, (x) => x.toUpperCase())}.`);
    parts.push(c.locked ? `Not enough stars: it costs ${cost}, you have ${stars}.` : `Tap again to ${isTrain ? "train" : "build"} it for ${cost} stars.`);
    return parts.join(" ");
  }

  function tile(xy) {
    const at = `${xy[0]},${xy[1]}`;
    const t = A.tile(xy), city = A.city(xy);
    const f = P.tileFacts(A, xy);
    const mine = A.myTurn();
    const cmds = mine ? A.S.g.byTile.get(at) || [] : [];
    const locked = (mine ? A.S.g.lockedByTile.get(at) || [] : []).map((c) => ({ ...c, locked: true }));
    const trains = [...cmds, ...locked].filter((c) => c.kind === "Train");
    const builds = [...cmds, ...locked].filter((c) => c.kind === "Build");
    const rest = cmds.filter((c) => !["CityReward", "Train", "Build"].includes(c.kind));
    if (!picked || picked.at !== at || ![...trains, ...builds].some((c) => idOf(c) === picked.id)) picked = null;
    const tribe = myTribe();
    const climate = (t && M().tribe(t.climate) || {}).name || tribe;
    const buttons = [];
    for (const c of [...trains, ...builds]) {
      const isTrain = c.kind === "Train";
      const info = isTrain ? M().unit(c.train) : M().impr(c.improvement);
      const id = idOf(c);
      const iid = info ? info.id : "";
      const icon = isTrain ? unitIcon(iid, tribe) : BUILD_ICON[iid] ? BUILD_ICON[iid](climate) : [`improvement/${iid}/${tribe}`, `improvement/${iid}`, `icon/${iid}_icon`];
      buttons.push({
        id, label: isTrain ? M().unitName(c.train) : M().imprName(c.improvement), kind: c.kind,
        icon, iconScale: isTrain ? 0.8 : 0.72, cost: info ? info.cost : null, short: !!c.locked,
        active: !!picked && picked.id === id, state: c.locked ? "short" : null,
        aria: `${isTrain ? M().unitName(c.train) : M().imprName(c.improvement)}, ${info ? info.cost : "?"} stars${c.locked ? ", not enough stars" : ""}`,
        onTap: () => {
          if (!c.locked && (!A.settings.infoOnBuild || (picked && picked.id === id && picked.at === at))) { picked = null; A.run(c); return; }
          picked = { at, id };
          env.refresh();
        },
      });
    }
    for (const c of rest) buttons.push({ id: `act:${c.kind}`, label: actionLabel(c), kind: c.kind, icon: [ACTION_ICON[c.kind]].filter(Boolean), onTap: () => A.act(c) });
    const pick = picked && [...trains, ...builds].find((c) => idOf(c) === picked.id);
    const lh = A.lighthouse(xy);
    let header = lh ? lighthouseName(lh) : city ? (city.owner ? city.name || f.title : tr("world.building.village", "Village")) : f.title;
    let desc = t && t.terrain ? tileDesc(xy, t, city) : "";
    if (pick) {
      header = pick.kind === "Train" ? M().unitName(pick.train) : M().imprName(pick.improvement);
      desc = pickDesc(pick);
    }
    if (city && city.owner === A.S.myId && mine && !trains.length && !buttons.length) {
      desc = `${desc} ${A.unitAt(xy) ? "Nothing can be trained while a unit stands in the city." : "Nothing can be trained right now."}`;
    }
    return {
      key: `tile:${at}`, header, desc, headerColour: pick && pick.locked ? "#ff8a73" : null,
      portrait: { xy: [xy[0], xy[1]] },
      info: () => env.openInfo(xy), back: () => env.deselect(),
      buttons,
    };
  }

  // ---------- an attack, before it is played ----------
  function forecast(cmd) {
    const c = cmd.combat || {};
    const att = A.unitAt(cmd.from), def = A.unitAt(cmd.to);
    const name = (u) => (u ? M().unitName(u.type) : "the target");
    const parts = [];
    if (c.kills) parts.push(`Destroys the ${name(def)}.`);
    else parts.push(`Deals ${tenths(c.damage || 0)} damage${def ? `, ${tenths(Math.max(0, def.health - (c.damage || 0)))} left` : ""}.`);
    if (c.converts) parts.push("The target changes side.");
    if (c.dies) parts.push(`Your ${name(att)} is lost.`);
    else if (c.retaliation) parts.push(`Your ${name(att)} takes ${tenths(c.retaliation)}${att ? `, ${tenths(Math.max(0, att.health - c.retaliation))} left` : ""}.`);
    else parts.push("No damage back.");
    return {
      key: `fc:${cmd.from}>${cmd.to}`, header: `${tr("world.unit.attack", "Attack")} ${name(def)}`, desc: parts.join(" "),
      portrait: def ? { xy: [cmd.to[0], cmd.to[1]], unit: def.id } : { xy: [cmd.to[0], cmd.to[1]] },
      back: () => A.cancelForecast(), backLabel: "Cancel",
      buttons: [
        { id: "fc-cancel", label: "Cancel", icon: ["icon/back_white", "icon/back"], iconScale: 0.5, onTap: () => A.cancelForecast() },
        { id: "fc-attack", label: tr("world.unit.attack", "Attack"), icon: ["icon/attack"], fill: "rgba(240,60,20,0.85)", onTap: () => A.confirmAttack(cmd) },
      ],
    };
  }

  return { unit, tile, forecast, clearPick: () => { picked = null; } };
}
