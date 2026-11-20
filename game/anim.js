// The director of the game screen's animations (task F4). One path plays every event: the player's own command, the
// log entries of other players' turns, and the turns of a watch game. It takes the position the board shows (`before`),
// the events, and the position the server reports afterwards (`after`), and steps a working copy of the board through the
// events one at a time: the effect, then the truth for the tiles and units the event touched (copied from `after`, never
// worked out here). The caller then shows `after` itself, so whatever happens in here the board ends on the server's
// position. Nothing here knows a rule: damage comes from the engine's `combat` when the entry has it, else from the health
// the unit has before and after.

// Milliseconds at speed 1. SPEC section 10 proposes move, attack, kill, train/build, level-up/capture, research and the
// hold; the rest are defaults (SPEC section 16, "default, Kenzi to confirm").
export const TIMING = {
  // a unit's walk: 300 ms a tile, at most 1200 ms, played 85% faster
  movePerTile: Math.round(300 / 1.85), moveMax: Math.round(1200 / 1.85),
  lunge: 500, hit: 180, // retail's step: 0.2 s out, where the strike lands, and 0.3 s back (Unit.AnimateMeleeAttackMovement)
  projectile: 200, projectilePerTile: 50, // retail's flight: 0.2 s + 0.05 s a tile (Unit.Attack to WeaponGFX.AnimateRanged)
  kill: 250, // SPEC item 10 had 300; shortened with the hit for a snappier attack (SPEC section 16)
  floater: 1000, // a damage number springs up in 0.5 s and is gone after 1 s, while the next event goes on
  spawn: 400, build: 400, // SPEC item 10
  capture: 800, levelUp: 800, // SPEC item 10
  research: 300, notice: 1800, // SPEC item 10; the toast stays longer than the pause
  // between the entries of another player's turn (SPEC item 10). None after a walk: one unit sets off as the last arrives,
  // so a player's units are seen to walk as fast as your own
  hold: 250,
  scoutPerTile: 180, scoutMax: 3600, // the explorer's walk, a figure through the tiles it reveals (default, SPEC section 16)
  camera: 350, ring: 90, // a camera pan; the pause between the rings of a growing border
};

// What each ranged unit fires: fx sprite (drawn pointing right), the sound, turns in the air, and a scale (the WeaponGFX
// prefab's: WaterWeapon draws its bubble at 0.5). Everything else with a range over 1 fires an arrow.
const WEAPONS = {
  archer: ["arrowgfx", "arrow"], mermaidarcher: ["arrowgfx", "arrow"], scoutship: ["arrowgfx", "arrow"], transportship: ["arrowgfx", "arrow"],
  icearcher: ["icegfx", "ice_arrow"], icefortress: ["icegfx", "ice_arrow"],
  catapult: ["rockgfx", "rock", 3], bombership: ["rockgfx", "rock", 3], aquapult: ["bubble", "water_weapon", 0, 0.5],
  tridention: ["tridentgfx", "trident"], exida: ["stinggfx", "arrow"], phychi: ["stinggfx", "arrow"], firedragon: ["flamegfx", "fire_blow"],
};
// A close-range attack spins the unit's weapon once in 0.2 s (WeaponGFX.AnimateCloseRangeAttack; board.effects.swing)
const SWING_MS = 200;
const LUNGE_OUT = 0.4; // the part of a lunge that goes out (board.effects.lunge)
const SWAY_MS = 600; // a unit's recoil: down in 0.1 s, back with a spring in 0.5 s (board.effects.sway)
const MELEE_SOUND = {
  rammership: "ram", juggernaut: "stomp", island: "stomp", giant: "stomp", crab: "stomp", dagger: "dagger", mermaiddagger: "dagger", cloak: "dagger",
  mermaidcloak: "dagger", hexapod: "claw", bunny: "claw", polytaur: "club", centipede: "claw", mantis: "claw", shark: "claw", defender: "club",
  mermaiddefender: "club", kiton: "club", gaami: "club",
};

const key = (xy) => `${xy[0]},${xy[1]}`;
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function clonePosition(p) {
  return {
    ...p,
    tiles: (p.tiles || []).map((t) => ({ ...t })),
    units: (p.units || []).map((u) => ({ ...u })),
    improvements: (p.improvements || []).map((i) => ({ ...i })),
  };
}

// A shortest route between two tiles over the board (eight neighbours), for a move the log gives no path for: other
// units are walked round, and a tile of the other element (land for a ship, water for a walker) costs more. Falls back to
// the straight line, which is also what a single step is.
export function routeBetween(pos, from, to, isWater, blocked = new Set()) {
  const n = (pos.game && pos.game.width) || 0;
  if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return [from, to].filter(Boolean);
  if (cheb(from, to) <= 1 || !n || cheb(from, to) > 14) return [from, to];
  const tiles = new Map((pos.tiles || []).map((t) => [key([t.x, t.y]), t]));
  const wet = (xy) => { const t = tiles.get(key(xy)); return !!t && isWater(t.terrain); };
  const goalWet = wet(to);
  const cost = (xy) => 1 + (wet(xy) === goalWet ? 0 : 2) + (blocked.has(key(xy)) ? 5 : 0);
  const best = new Map([[key(from), 0]]);
  const prev = new Map();
  const open = [[0, from]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, cur] = open.shift();
    if (cur[0] === to[0] && cur[1] === to[1]) break;
    if (d > (best.get(key(cur)) ?? Infinity)) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = cur[0] + dx, ny = cur[1] + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n || !tiles.get(key([nx, ny]))) continue;
      const nd = d + cost([nx, ny]);
      if (nd < (best.get(key([nx, ny])) ?? Infinity)) {
        best.set(key([nx, ny]), nd);
        prev.set(key([nx, ny]), cur);
        open.push([nd, [nx, ny]]);
      }
    }
  }
  if (!prev.has(key(to))) return [from, to];
  const path = [to];
  while (key(path[0]) !== key(from)) path.unshift(prev.get(key(path[0])));
  return path.length >= 2 && path.length <= 16 ? path : [from, to];
}

// The explorer's walk (a CityReward Explorer) is not in the log, only the reward: its route is rebuilt from the tiles the owner
// sees after the walk. `land` is the keys of the land seen after; `fresh` the tiles seen for the first time, as [x, y].
// A tour from the city, over land: each fresh tile in turn, the nearest first.
const nearby = (xy) => {
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) out.push([xy[0] + dx, xy[1] + dy]);
  return out;
};
const seen = (t, p) => !!t && (t.explored == null || t.explored.includes(p));
export function scoutRoute(start, fresh, land) {
  const todo = new Map(fresh.map((xy) => [key(xy), xy]).filter(([k]) => land.has(k)));
  todo.delete(key(start));
  const route = [start];
  let cur = start;
  while (todo.size) {
    const from = new Map([[key(cur), null]]), queue = [cur];
    let goal = null;
    for (let i = 0; i < queue.length && !goal; i++) {
      for (const xy of nearby(queue[i])) {
        const k = key(xy);
        if (from.has(k) || !land.has(k)) continue;
        from.set(k, queue[i]);
        if (todo.has(k)) { goal = xy; break; }
        queue.push(xy);
      }
    }
    if (!goal) break;
    const steps = [];
    for (let xy = goal; key(xy) !== key(cur); xy = from.get(key(xy))) steps.unshift(xy);
    for (const xy of steps) { route.push(xy); todo.delete(key(xy)); }
    cur = goal;
  }
  return route;
}

// How long a replay of these entries takes at speed 1, for the cap on a long opponent turn
export function estimate(events) {
  const t = TIMING;
  const per = {
    Move: t.movePerTile * 2, Attack: t.lunge + t.hit + t.kill / 2, Train: t.spawn, Build: t.build, Capture: t.capture, CityReward: t.levelUp, Research: t.research,
  };
  return events.reduce((sum, e) => sum + (e.kind === "CityReward" && e.reward === "Explorer" ? t.scoutMax : per[e.kind] ?? 200) + (e.kind === "Move" ? 0 : t.hold), 0);
}

export function createDirector({ board, M, play, notice, reduced = () => false }) {
  const fx = board.effects;
  const stats = { runs: 0, events: 0, skipped: 0, errors: 0, kinds: {}, log: [], last: null };
  // the shots, swings and puffs start loading with the match: drawn before its image has loaded, a 0.3 s shot is not seen
  if (fx.preload) {
    fx.preload([...new Set(Object.values(WEAPONS).map((w) => w[0])), "arrowgfx", "explosiongfx", "puffgfx", "shinegfx", "shine", "healgfx",
      ...["club", "sword", "magic", "claw", "dagger"].map((w) => `weapon/${w}`)]);
  }
  let tail = Promise.resolve();
  let current = null;

  const unitInfo = (type) => M.unit(type) || {};
  const unitId = (type) => unitInfo(type).id || "";
  const rangeOf = (type) => unitInfo(type).range || 1;
  const isRanged = (type) => rangeOf(type) > 1;
  function weapon(type) {
    const id = unitId(type);
    const w = WEAPONS[id];
    if (w) return { sprite: w[0], sound: w[1], ranged: true, spin: w[2], scale: w[3] };
    if (isRanged(type)) return { sprite: "arrowgfx", sound: "arrow", ranged: true };
    return { sprite: null, sound: MELEE_SOUND[id] || "sword", ranged: false };
  }

  // ----- the working copy and the truth to copy from
  function context(before, after, o) {
    const W = clonePosition(before);
    const ctx = {
      W, after, o,
      wTile: new Map(W.tiles.map((t, i) => [key([t.x, t.y]), i])),
      aTile: new Map((after.tiles || []).map((t) => [key([t.x, t.y]), t])),
      aCity: new Map((after.improvements || []).map((c) => [key([c.x, c.y]), c])),
      aUnit: new Map((after.units || []).map((u) => [u.id, u])),
    };
    return ctx;
  }
  const wUnit = (ctx, id) => ctx.W.units.find((u) => u.id === id) || null;
  const wUnitAt = (ctx, xy, not) => ctx.W.units.find((u) => u.x === xy[0] && u.y === xy[1] && u.id !== not) || null;
  const wCity = (ctx, xy) => ctx.W.improvements.find((c) => c.x === xy[0] && c.y === xy[1]) || null;
  const wTileAt = (ctx, xy) => { const i = ctx.wTile.get(key(xy)); return i == null ? null : ctx.W.tiles[i]; };
  function patchTile(ctx, xy) {
    const k = key(xy), t = ctx.aTile.get(k);
    if (t) {
      const i = ctx.wTile.get(k);
      if (i == null) { ctx.wTile.set(k, ctx.W.tiles.length); ctx.W.tiles.push({ ...t }); } else ctx.W.tiles[i] = { ...t };
    }
    const c = ctx.aCity.get(k);
    if (c) {
      const i = ctx.W.improvements.findIndex((x) => x.x === xy[0] && x.y === xy[1]);
      if (i < 0) ctx.W.improvements.push({ ...c }); else ctx.W.improvements[i] = { ...c };
    }
  }
  function patchArea(ctx, xy, r) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) patchTile(ctx, [xy[0] + dx, xy[1] + dy]);
  }
  // tiles within r of xy whose owner differs between the working copy and the truth, nearest first
  function ownerChanges(ctx, xy, r) {
    const out = [];
    for (const [k, t] of ctx.aTile) {
      const w = ctx.W.tiles[ctx.wTile.get(k)];
      if (!w || (w.owner || 0) === (t.owner || 0)) continue;
      const d = cheb(xy, [t.x, t.y]);
      if (d <= r) out.push([d, [t.x, t.y]]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
  // units the truth has near xy for `owner` that the working copy has not: a trained unit, an explorer, a giant
  function newUnits(ctx, xy, owner, r = 1) {
    const out = [];
    for (const u of ctx.after.units || []) {
      if (wUnit(ctx, u.id) || (owner != null && u.owner !== owner) || cheb(xy, [u.x, u.y]) > r) continue;
      out.push(u);
    }
    return out;
  }
  function addUnit(ctx, u) {
    const c = { ...u };
    ctx.W.units.push(c);
    return c;
  }
  function removeUnit(ctx, id) {
    ctx.W.units = ctx.W.units.filter((u) => u.id !== id);
  }

  // ----- who is hit by what: the outcome of attacks from the position before and after (when the entry has no `combat`)
  // For every attack: the ids of the attacker and the target, and for each unit how many events can change its health.
  function plan(events, ctx) {
    const at = new Map(ctx.W.units.map((u) => [u.id, [u.x, u.y]]));
    const kinds = new Map(ctx.W.units.map((u) => [u.id, u.type]));
    const notes = events.map(() => ({}));
    const touch = new Map(); // unit id -> [event index, ...]
    const add = (id, i) => touch.set(id, [...(touch.get(id) || []), i]);
    const idAt = (xy, not) => { for (const [id, p] of at) if (id !== not && p[0] === xy[0] && p[1] === xy[1]) return id; return null; };
    events.forEach((e, i) => {
      if (e.kind === "Move" && e.unit != null && e.to) at.set(e.unit, [e.to[0], e.to[1]]);
      if (e.kind !== "Attack" || e.unit == null || !e.to) return;
      const tgt = idAt(e.to, e.unit);
      notes[i] = { att: e.unit, tgt };
      if (tgt != null) add(tgt, i);
      // the attacker can take a retaliation only from a target that reaches back
      const from = at.get(e.unit);
      const reach = tgt != null ? rangeOf(kinds.get(tgt)) : 1;
      if (from && cheb(from, e.to) <= Math.max(1, reach)) add(e.unit, i);
    });
    return { notes, touch };
  }
  function movedLater(events, i, id) {
    return events.slice(i + 1).some((e) => e.kind === "Move" && e.unit === id);
  }
  // {damage, retaliation, kills, dies, converts}; a number that cannot be told apart (two hits on one unit) is null
  function outcome(e, i, events, ctx, pl) {
    if (e.combat) return { converts: false, ...e.combat };
    const note = pl.notes[i] || {};
    const tgt = note.tgt != null ? wUnit(ctx, note.tgt) : wUnitAt(ctx, e.to, e.unit);
    const att = wUnit(ctx, e.unit);
    const out = { damage: null, retaliation: null, kills: false, dies: false, converts: false };
    const judge = (unit, role) => {
      if (!unit) return;
      const list = pl.touch.get(unit.id) || [];
      const last = list[list.length - 1] === i;
      const now = ctx.aUnit.get(unit.id);
      const gone = !now && !movedLater(events, i, unit.id);
      if (role === "tgt") {
        if (gone && last) { out.kills = true; if (list.length === 1) out.damage = unit.health; }
        else if (now && list.length === 1 && now.health <= unit.health) out.damage = unit.health - now.health;
        if (now && now.owner !== unit.owner) out.converts = true;
      } else {
        if (gone && last) out.dies = true;
        else if (now && list.length === 1 && now.health <= unit.health) out.retaliation = unit.health - now.health;
      }
    };
    judge(tgt, "tgt");
    judge(att, "att");
    return out;
  }

  // ----- one run
  function newRun(o) {
    const run = { skipped: false, waiters: new Set(), speed: o.speed || (() => 1), pending: [], floaters: [] };
    run.sleep = (ms) => new Promise((resolve) => {
      if (run.skipped) { resolve(); return; }
      const done = () => { clearTimeout(t); run.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      run.waiters.add(done);
    });
    run.skip = () => {
      if (run.skipped) return;
      run.skipped = true;
      stats.skipped++;
      for (const w of [...run.waiters]) w();
      fx.skip();
      board.finishCamera();
    };
    return run;
  }

  async function runNow(o) {
    const run = newRun(o);
    current = run;
    stats.runs++;
    const t0 = performance.now();
    const events = (o.events || []).filter(Boolean);
    const record = { events: events.length, kinds: [], t0 };
    stats.last = record;
    const errors0 = stats.errors;
    let clean = false;
    try {
      const before = typeof o.before === "function" ? o.before() : o.before;
      const after = typeof o.after === "function" ? o.after() : o.after;
      if (!before || !after || !events.length) return;
      const ctx = context(before, after, o);
      const scale = () => (reduced() ? 3 : 1) * Math.max(0.05, run.speed());
      const ms = (n) => Math.max(30, Math.round(n / scale()));
      ctx.run = run; ctx.ms = ms; ctx.record = record;
      const pl = plan(events, ctx);
      o.show(ctx.W);
      for (let i = 0; i < events.length && !run.skipped; i++) {
        const e = events[i];
        stats.events++;
        stats.kinds[e.kind] = (stats.kinds[e.kind] || 0) + 1;
        const s0 = performance.now();
        if (o.onEvent) o.onEvent(e, i);
        try {
          await step(e, i, events, ctx, pl);
        } catch (err) {
          stats.errors++;
          console.warn("animation step failed", e.kind, err);
          fx.skip();
        }
        record.kinds.push({ kind: e.kind, ms: Math.round(performance.now() - s0) });
        stats.log.push({ kind: e.kind, planned: ctx.lastPlanned ?? null, speed: run.speed(), run: stats.runs });
        ctx.lastPlanned = null;
        if (stats.log.length > 200) stats.log.shift();
        if (o.hold && e.kind !== "Move" && i < events.length - 1 && !run.skipped) await run.sleep(ms(TIMING.hold));
      }
      if (!run.skipped && o.score && o.score.gain > 0) scoreFloat(ctx, events, o.score);
      // your own command frees the screen as soon as the motion is over: its numbers fade on by themselves
      const wait = o.mine ? run.pending : run.pending.concat(run.floaters);
      if (!run.skipped) await Promise.race([Promise.all(wait), run.sleep(ms(TIMING.floater) + 400)]);
      if (!run.skipped) await settle(ctx, events);
      clean = true;
    } catch (err) {
      stats.errors++;
      console.warn("animation failed", err);
    } finally {
      if (!(o.mine && clean && !run.skipped && stats.errors === errors0)) fx.skip();
      board.finishCamera();
      record.ms = Math.round(performance.now() - t0);
      record.skipped = run.skipped;
      current = null;
    }
  }

  // what changed beyond the events: a city that grew at the turn's start, a unit healed
  async function settle(ctx, events) {
    const { W } = ctx;
    const grown = [];
    for (const c of ctx.after.improvements || []) {
      const w = wCity(ctx, [c.x, c.y]);
      if (w && (c.level || 1) > (w.level || 1)) grown.push(c);
    }
    if (!grown.length) return;
    for (const c of grown.slice(0, 3)) {
      patchTile(ctx, [c.x, c.y]);
    }
    ctx.o.show(W);
    play("reward");
    await Promise.all(grown.slice(0, 3).map((c) => levelBurst(ctx, [c.x, c.y], c.level)));
  }

  // ----- the effects, in pieces
  function cam(ctx, xy, always = false) {
    if (!xy || !(always || ctx.o.camera)) return Promise.resolve();
    const t = ctx.ms(TIMING.camera);
    return Promise.race([board.reveal(xy, { ms: t }), sleepMs(t + 250)]);
  }
  function float(ctx, xy, text, o = {}) {
    ctx.run.floaters.push(fx.pop(xy, text, { ms: ctx.ms(TIMING.floater), ...o }));
  }
  // the viewer's own score gain from a command: a "+N" above the tile the command touched, or in the score bar when it
  // touched none. In game mode (`score.fly`) the gain flies from the tile to the HUD's score counter instead.
  function scoreFloat(ctx, events, score) {
    const xy = events.map((e) => e.to).find(Boolean);
    if (xy && score.fly) score.fly(xy, score.gain);
    else if (xy) float(ctx, xy, `+${score.gain}`, { colour: "#5ad19a" });
    else if (score.bar) score.bar(score.gain);
  }
  // Retail's tile effects. A puff (cloud, or another sprite with the same tween), the beams of light of a Shine that
  // flicker out, the halo behind a promoted unit, and sparkles. Each returns its promise; `name` is the effect's name
  // in board.stats.
  const puff = (ctx, xy, o = {}) => fx.puff(xy, { ms: ctx.ms(600), ...o });
  const shine = (ctx, xy, o = {}) => fx.puff(xy, { key: "fx/shinegfx", timing: { grow: 0.15, rise: 0, fade: 0.65, from: 0.6 }, up: 0.55, flicker: true, ms: ctx.ms(TIMING.capture), ...o });
  const halo = (ctx, xy, o = {}) => fx.puff(xy, { key: "fx/shine", timing: { grow: 0.1, rise: 0, fade: 1, from: 0.5 }, up: 0.2, under: true, ms: ctx.ms(1100), ...o });
  const sparkles = (ctx, xy, amount = 1, o = {}) => fx.sparkles(xy, { amount, ms: ctx.ms(900), ...o });
  const later = (ctx, p) => { ctx.run.pending.push(p); return p; };
  // an effect that plays out on its own after your own command has freed the screen, like the damage numbers
  const trailing = (ctx, p) => { ctx.run.floaters.push(p); return p; };
  // a city grows a level: light and sparkles as it rises, then a puff and more sparkles
  async function levelBurst(ctx, xy) {
    later(ctx, sparkles(ctx, xy, 1));
    await shine(ctx, xy, { ms: ctx.ms(TIMING.levelUp), name: "levelUp" });
    later(ctx, puff(ctx, xy));
    later(ctx, sparkles(ctx, xy, 1));
  }
  const show = (ctx) => ctx.o.show(ctx.W);
  const tenths = (n) => (Number.isInteger(n / 10) ? String(n / 10) : (n / 10).toFixed(1));

  async function step(e, i, events, ctx, pl) {
    const own = ctx.o.mine;
    const { ms } = ctx;
    switch (e.kind) {
      case "Move": return stepMove(e, ctx);
      case "Attack": return stepAttack(e, i, events, ctx, pl);
      case "Train": {
        await cam(ctx, e.to);
        const made = newUnits(ctx, e.to, e.player ?? null).filter((u) => (e.train == null || u.type === e.train));
        const added = made.slice(0, 1).map((u) => addUnit(ctx, u));
        patchTile(ctx, e.to);
        show(ctx);
        play(own ? "spawn" : "spawnEnemy");
        later(ctx, puff(ctx, e.to));
        ctx.lastPlanned = ms(TIMING.spawn);
        await Promise.all(added.map((u) => fx.popIn(u.id, { ms: ms(TIMING.spawn) })).concat([ctx.run.sleep(ms(TIMING.spawn) * 0.9)]));
        return;
      }
      case "Build": {
        await cam(ctx, e.to);
        const before = wTileAt(ctx, e.to);
        const harvested = !!(before && before.resource && ctx.aTile.get(key(e.to)) && !ctx.aTile.get(key(e.to)).resource);
        const city = nearestCity(ctx, e.to, e.player);
        const level = city ? city.level || 1 : 0;
        const xp0 = city ? (city.xp ?? city.population ?? 0) : 0;
        patchTile(ctx, e.to);
        if (city) patchTile(ctx, [city.x, city.y]);
        show(ctx);
        play("build");
        // a harvest sparkles where the resource was; anything built comes up in a puff
        if (harvested) later(ctx, sparkles(ctx, e.to, 0.4));
        else later(ctx, puff(ctx, e.to));
        const done = [ctx.run.sleep(ms(TIMING.build))];
        const c1 = city ? ctx.aCity.get(key([city.x, city.y])) : null;
        if (c1 && (c1.level || 1) > level) done.push(levelBurst(ctx, [city.x, city.y]));
        else if (c1 && (c1.xp ?? c1.population ?? 0) > xp0) float(ctx, [city.x, city.y], `+${(c1.xp ?? c1.population) - xp0}`, { colour: "#5ad19a" });
        ctx.lastPlanned = ms(TIMING.build);
        await Promise.all(done);
        return;
      }
      case "Capture": {
        await cam(ctx, e.to);
        const was = wTileAt(ctx, e.to);
        const lost = was && was.owner && ctx.o.me != null && was.owner === ctx.o.me;
        patchTile(ctx, e.to);
        const rings = ownerChanges(ctx, e.to, 3);
        show(ctx);
        play(lost ? "lostCity" : "capture");
        // a city taken shines and sparkles; the viewer's own city lost goes up in smoke
        later(ctx, sparkles(ctx, e.to, 2));
        const burst = lost ? puff(ctx, e.to, { ms: ms(TIMING.capture), name: "capture" }) : shine(ctx, e.to, { name: "capture" });
        ctx.lastPlanned = ms(TIMING.capture);
        await Promise.all([burst, growBorder(ctx, rings)]);
        return;
      }
      case "CityReward": {
        await cam(ctx, e.to);
        const c0 = wCity(ctx, e.to);
        const level0 = c0 ? c0.level || 1 : 0;
        const scout = e.reward === "Explorer" ? scoutPlan(ctx, e) : null;
        patchTile(ctx, e.to);
        const rings = ownerChanges(ctx, e.to, 4);
        const made = newUnits(ctx, e.to, e.player ?? null, 2).slice(0, 1).map((u) => addUnit(ctx, u));
        show(ctx);
        play("reward");
        const c1 = ctx.aCity.get(key(e.to));
        const done = [];
        if (c1 && (c1.level || 1) > level0) done.push(levelBurst(ctx, e.to));
        else done.push(sparkles(ctx, e.to, 1, { ms: ms(TIMING.levelUp), name: "reward" }));
        for (const u of made) done.push(fx.popIn(u.id, { ms: ms(TIMING.spawn) }));
        done.push(growBorder(ctx, rings));
        if (scout) done.push(scoutWalk(ctx, scout));
        ctx.lastPlanned = ms(TIMING.levelUp);
        await Promise.all(done);
        return;
      }
      case "Research": {
        play("tech");
        if (notice) notice("tech", e.tech, ms(TIMING.notice));
        ctx.lastPlanned = ms(TIMING.research);
        await ctx.run.sleep(ms(TIMING.research));
        return;
      }
      case "Upgrade": case "Promote": {
        const u = wUnit(ctx, e.unit), now = ctx.aUnit.get(e.unit);
        await cam(ctx, e.to || e.from);
        if (u && now) Object.assign(u, now);
        show(ctx);
        play("promote");
        const xy = e.from || e.to;
        if (!xy) return;
        // a veteran gets a halo and sparkles; a unit rebuilt as another comes out of a puff
        // (the sway starts first: the halo goes behind a unit an effect is playing on)
        if (u) later(ctx, fx.sway(u.id, { ms: ms(1100) }));
        if (e.kind === "Promote") { later(ctx, sparkles(ctx, xy, 1)); later(ctx, halo(ctx, xy, { name: "promote" })); }
        else later(ctx, puff(ctx, xy, { name: "promote" }));
        await ctx.run.sleep(ms(TIMING.build));
        return;
      }
      case "Recover": case "HealOthers": {
        await cam(ctx, e.from || e.to);
        for (const u of ctx.W.units) {
          const now = ctx.aUnit.get(u.id);
          if (now && now.health > u.health && cheb([u.x, u.y], e.from || e.to) <= 1) u.health = now.health;
        }
        play("heal");
        const xy = e.from || e.to;
        if (xy) { later(ctx, puff(ctx, xy, { key: "fx/healgfx" })); await ctx.run.sleep(ms(TIMING.build) * 0.8); }
        return;
      }
      case "Disband": case "Destroy": {
        const u = e.unit != null ? wUnit(ctx, e.unit) : null;
        if (u) { await fx.fadeOut(u.id, { ms: ms(TIMING.kill), shrink: 0.3 }); removeUnit(ctx, u.id); }
        const at = e.to || e.from;
        if (at) patchArea(ctx, at, 0);
        show(ctx);
        return;
      }
      case "EndTurn": return;
      default: return stepOther(e, ctx);
    }
  }

  // the city of this owner the tile feeds: the nearest of theirs in the working copy
  function nearestCity(ctx, xy, owner) {
    let best = null, bd = 99;
    for (const c of ctx.W.improvements) {
      const t = wTileAt(ctx, [c.x, c.y]);
      if (!t || !(t.improvement === 1 || t.city) || (owner != null && t.owner !== owner)) continue;
      const d = cheb(xy, [c.x, c.y]);
      if (d < bd) { bd = d; best = c; }
    }
    return bd <= 4 ? best : null;
  }

  // a border growing: the new tiles join ring by ring, nearest first
  async function growBorder(ctx, rings) {
    if (!rings.length) return;
    let ring = rings[0][0];
    let batch = [];
    const flush = async () => {
      for (const [, xy] of batch) patchTile(ctx, xy);
      show(ctx);
      batch = [];
      await ctx.run.sleep(ctx.ms(TIMING.ring));
    };
    for (const r of rings) {
      if (r[0] !== ring) { await flush(); ring = r[0]; }
      batch.push(r);
    }
    await flush();
  }

  // the explorer's walk, from the city: the route, and the tiles the owner sees for the first time (seen after, not before)
  function scoutPlan(ctx, e) {
    const who = e.player ?? (ctx.aTile.get(key(e.to)) || {}).owner;
    const fresh = [], land = new Set();
    for (const [k, t] of ctx.aTile) {
      if (!seen(t, who)) continue;
      if (!M.isWater(t.terrain)) land.add(k);
      if (!seen(ctx.W.tiles[ctx.wTile.get(k)], who)) fresh.push([t.x, t.y]);
    }
    return { who, fresh, route: scoutRoute(e.to, fresh, land) };
  }
  // a figure walks the route; each tile it reaches is revealed with the ones round it, as the scout sees them. At the end
  // every tile the walk saw is the truth, also the ones the figure did not reach (and after a skip).
  async function scoutWalk(ctx, scout) {
    await fx.figure(scout.who, "scout", scout.route, {
      ms: ctx.ms(Math.min(TIMING.scoutMax, TIMING.scoutPerTile * (scout.route.length - 1))),
      at: (xy) => { patchArea(ctx, xy, 1); show(ctx); },
    });
    for (const xy of scout.fresh) patchTile(ctx, xy);
    show(ctx);
  }

  async function stepMove(e, ctx) {
    const { ms } = ctx;
    if (e.unit == null || !e.to) return;
    let u = wUnit(ctx, e.unit);
    const now = ctx.aUnit.get(e.unit);
    const from = e.from || (u ? [u.x, u.y] : null);
    if (!u && now && from) { u = addUnit(ctx, { ...now, x: from[0], y: from[1] }); show(ctx); }
    if (!u || !from) { if (now) { patchArea(ctx, e.to, 1); show(ctx); } return; }
    if (ctx.o.followMoves) await cam(ctx, e.to, true); else await cam(ctx, null);
    const blocked = new Set(ctx.W.units.filter((x) => x.id !== u.id).map((x) => key([x.x, x.y])));
    const route = e.path && e.path.length > 1 ? e.path : routeBetween(ctx.W, from, e.to, M.isWater, blocked);
    // the tiles around the destination come out of the fog as the unit gets there
    patchArea(ctx, e.to, 1);
    show(ctx);
    play(M.isWater((wTileAt(ctx, e.to) || {}).terrain) ? "moveWater" : "move");
    const total = Math.min(TIMING.moveMax, TIMING.movePerTile * Math.max(1, route.length - 1));
    ctx.lastPlanned = ms(total);
    await fx.moveUnit(u.id, route, { ms: ms(total) });
    u.x = e.to[0]; u.y = e.to[1]; u.moved = true;
    if (now) u.direction = now.direction;
    show(ctx);
  }

  // A unit strikes at a tile the way its type does: its shot flies there while it recoils, or it steps in with its
  // weapon spinning round it. Resolves as the strike lands, with the time that took at speed 1.
  async function strike(ctx, u, from, to) {
    const { ms } = ctx, w = weapon(u.type);
    play(w.sound);
    if (w.ranged && w.sprite) {
      fx.face(u.id, to);
      trailing(ctx, fx.sway(u.id, { amount: 1.5, ms: ms(SWAY_MS) }));
      const flight = TIMING.projectile + TIMING.projectilePerTile * cheb(from, to);
      await fx.projectile(w.sprite, from, to, { ms: ms(flight), spin: w.spin, arc: w.spin ? 0.9 : 0.4, scale: w.scale });
      return flight;
    }
    later(ctx, fx.lunge(u.id, to, { ms: ms(TIMING.lunge) }));
    if (fx.swing) later(ctx, fx.swing(u.id, { ms: ms(SWING_MS) }));
    await ctx.run.sleep(ms(TIMING.lunge) * LUNGE_OUT);
    return TIMING.lunge * LUNGE_OUT;
  }

  async function stepAttack(e, i, events, ctx, pl) {
    const { ms } = ctx;
    const att = wUnit(ctx, e.unit);
    const note = pl.notes[i] || {};
    const tgt = note.tgt != null ? wUnit(ctx, note.tgt) : wUnitAt(ctx, e.to, e.unit);
    if (!att || !e.to) { if (e.to) patchArea(ctx, e.to, 0); return; }
    const c = outcome(e, i, events, ctx, pl);
    const from = [att.x, att.y];
    await cam(ctx, e.to, !ctx.o.mine); // your own attack was tapped on screen: no pan
    show(ctx);
    let planned = await strike(ctx, att, from, e.to);
    // the strike lands: red spikes burst on the tile and the unit rocks (retail's Tile.Damage)
    play(c.kills ? "kill" : "hit");
    const struck = (u, xy) => {
      trailing(ctx, puff(ctx, xy, { key: "fx/explosiongfx", name: "struck" }));
      trailing(ctx, fx.hit(u.id, { ms: ms(SWAY_MS) }));
    };
    if (tgt) {
      struck(tgt, e.to);
      if (c.damage != null) {
        float(ctx, e.to, c.damage ? `−${tenths(c.damage)}` : "0");
        tgt.health = Math.max(0, tgt.health - c.damage);
      }
      if (c.converts) { const now = ctx.aUnit.get(tgt.id); if (now) tgt.owner = now.owner; }
    }
    planned += TIMING.hit;
    await ctx.run.sleep(ms(TIMING.hit));
    if (c.retaliation || c.dies) {
      // the target, still standing, strikes back the way its own type does
      if (tgt && !c.kills) {
        planned += await strike(ctx, tgt, e.to, from);
        play(c.dies ? "kill" : "hit");
      }
      struck(att, from);
      if (c.retaliation) {
        float(ctx, from, `−${tenths(c.retaliation)}`, { colour: "#ffb347" });
        att.health = Math.max(0, att.health - c.retaliation);
      }
      planned += TIMING.hit;
      await ctx.run.sleep(ms(TIMING.hit));
    }
    const dead = [];
    if (c.kills && tgt) dead.push(die(ctx, tgt));
    if (c.dies) dead.push(die(ctx, att));
    if (dead.length) { planned += TIMING.kill; await Promise.all(dead); }
    att.attacked = true; att.moved = true;
    ctx.lastPlanned = ms(planned);
    show(ctx);
  }

  // the unit fades inside the burst of the hit that killed it
  async function die(ctx, u) {
    await fx.fadeOut(u.id, { ms: ctx.ms(TIMING.kill), shrink: 0.2 });
    removeUnit(ctx, u.id);
  }

  // everything else a command can do: the truth for the tiles around it, the unit as it is now, a quick flash
  async function stepOther(e, ctx) {
    const xy = e.to || e.from;
    if (e.with != null || !xy) { play(e.kind === "PeaceTreaty" ? "peaceSent" : "peace"); return; }
    await cam(ctx, xy);
    const u = e.unit != null ? wUnit(ctx, e.unit) : null;
    const now = e.unit != null ? ctx.aUnit.get(e.unit) : null;
    if (u && now) { u.health = now.health; u.type = now.type; u.owner = now.owner; }
    patchArea(ctx, xy, 1);
    for (const n of newUnits(ctx, xy, e.player ?? null, 2).slice(0, 1)) { addUnit(ctx, n); }
    show(ctx);
    later(ctx, puff(ctx, xy));
    await ctx.run.sleep(ctx.ms(TIMING.research));
  }

  // ----- the public side
  return {
    // Queue a run. {events, before, after, show(position), mine, me, camera, followMoves, hold, speed()}; resolves when it has played
    // (or been skipped). `before` and `after` may be functions, read when the run starts.
    run(o) {
      const p = tail.then(() => runNow(o));
      tail = p.catch(() => {});
      return p;
    },
    skip() { if (current) current.skip(); },
    get running() { return !!current; },
    stats,
    weapon,
  };
}
