// A replay on the match screen: one command at a time, with the same animation director as a live game, the whole map
// showing. Two sources: a bot game (admins only, web/botgames.py), a game our AI client played on the official server,
// and one of our own games (web/review.py), a finished game or a share link's. The command list comes first; the
// whole-map positions between commands are fetched in small batches as the replay reaches them.
//
// Controls: play and pause, the speed, one command forward (animated) and back (a jump), the previous and the next
// turn (jumps), and the track (game mode) or slider (technical mode) to jump anywhere. A bot game: from the first
// command the engine could not map or found illegal, a red strip says that the replay no longer matches the server; at
// the end the check against the server's final scores shows. One of ours: at the end, the final scores.

export const SPEEDS = [0.5, 1, 2, 4, 8];
const SPEED_KEY = "poly.botreplay.speed";
const GAP = 220;     // ms between two commands at 1x
const KEEP = 400;    // positions kept in this page
const QUIET = new Set(["EndTurn", "Unsupported", "Resign"]); // nothing to animate: the position after is shown

// A source: load() -> {data: {commands, turns: [{from, to, player}], players: [{id, who, tribe}], end, check?,
// scores?}, game} (game: the match screen's S.game), and positions(list of command counts) -> [{at, position}].

/** A bot game (web/botgames.py): the server replays it and sends the commands, the positions 16 at a time. */
export function botSource(api, gid) {
  return {
    batch: 16,
    async load() {
      const data = await api.get(`/api/bot-games/${gid}`);
      const g = data.game;
      const opp = g.opponents.map((x) => x.name).join(", ") || "?";
      return {
        data,
        game: {
          id: 0, name: `${g.model.name} vs ${opp}`, mode: String(g.mode || "").toLowerCase(), status: "active", watching: true, replay: true,
          turn_limit: 0, assist: false, current_seat: 0,
          seats: data.players.map((p) => ({ seat: p.id, player_id: p.id, kind: p.ours ? "bot" : "human", tribe: p.tribe, user: { username: p.who }, name: p.who })),
        },
      };
    },
    positions: async (list) => (await api.get(`/api/bot-games/${gid}/positions?at=${list.join(",")}`)).positions || [],
  };
}

/** One of our games (web/review.py) under `base` (/api/games/<id> or /api/shared/<token>): the turns and their commands,
 * then the position at each moment. Moment n is the position before command n; the last one is where the game ended.
 * `data.moments[n]` names it as the review API does ({index: the replay turn, k: commands played in it}). */
export function gameSource(api, base) {
  let moments = [];
  return {
    batch: 8,
    async load() {
      const r = await api.get(`${base}/replay`);
      if (!r.turns.length) throw Object.assign(new Error("There is nothing to look back at yet."), { status: 409 });
      moments = [];
      const commands = [], turns = [];
      const last = r.turns[r.turns.length - 1];
      for (const t of r.turns) {
        const from = commands.length;
        t.commands.forEach((c, k) => {
          moments.push({ index: t.index, k, turn: t.turn, player: t.player });
          commands.push({ ...c, player: c.player ?? t.player, turn: t.turn });
        });
        if (t.commands.length) turns.push({ turn: t.turn, player: t.player, index: t.index, from, to: commands.length });
        if (t === last) moments.push({ index: t.index, k: t.commands.length, turn: t.turn, player: t.player });
      }
      const over = r.game.status === "over";
      return {
        data: {
          raw: r, moments, commands, turns,
          players: r.players.map((p) => ({ id: p.player_id, who: p.name, tribe: p.tribe, kind: p.kind })),
          end: { player: last.player, turn: last.turn },
          scores: over ? (last.scores || []).slice().sort((a, b) => b[1] - a[1]) : null,
        },
        game: {
          id: r.game.id, name: r.game.name, mode: r.game.mode, status: "active", watching: true, replay: true,
          turn_limit: r.game.turn_limit || 0, assist: false, current_seat: 0,
          seats: r.players.map((p) => ({ seat: p.seat, player_id: p.player_id, kind: p.kind, tribe: p.tribe, user: p.kind === "human" ? { username: p.name } : null, name: p.name })),
        },
      };
    },
    async positions(list) {
      const at = list.map((n) => `${moments[n].index}.${moments[n].k}`);
      const r = await api.get(`${base}/replay/positions?at=${at.join(",")}`);
      return (r.positions || []).map((x) => ({ at: list[at.indexOf(x.at)], position: x.position }));
    },
  };
}

/** The replay controller. `o` is what it needs of the match screen (game.js); `o.source` is botSource or gameSource.
 * Optional hooks: `o.onAt(n, drawn)` on every move to another moment (drawn: the board shows it now; else it is still
 * loading), `o.deckExtra()` -> {marks} for the deck. */
export function createReplay(o) {
  const { source, A, S, M, D, h, board, anim, hud, applyView, drawPosition, play, banner, say, sayError } = o;
  const BATCH = source.batch;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let data = null, total = 0, cur = 0;
  let playing = false, looping = false, token = 0, seeking = null, drag = null;
  let speed = 1;
  try { const sp = Number(localStorage.getItem(SPEED_KEY)); if (SPEEDS.includes(sp)) speed = sp; } catch (e) { /* private mode */ }
  const cache = new Map(), inflight = new Map();
  const stats = { fetches: 0, animated: 0, jumps: 0, steps: 0 };

  // ----- positions
  function remember(n, p) {
    cache.delete(n);
    cache.set(n, p);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
  }
  function fetchFrom(n) {
    const list = [];
    for (let k = n; k <= total && list.length < BATCH; k++) if (!cache.has(k) && !inflight.has(k)) list.push(k);
    if (!list.length) return;
    stats.fetches++;
    const p = source.positions(list)
      .then((got) => { for (const x of got) remember(x.at, x.position); })
      .finally(() => list.forEach((k) => inflight.delete(k)));
    p.catch(() => {});
    list.forEach((k) => inflight.set(k, p));
  }
  async function positionAt(n) {
    if (cache.has(n)) return cache.get(n);
    if (!inflight.has(n)) fetchFrom(n);
    await inflight.get(n);
    if (!cache.has(n)) throw new Error("The replay could not be loaded.");
    return cache.get(n);
  }
  // the next positions start loading while the current command plays
  function prefetch(n) {
    for (let k = n + 1; k <= Math.min(total, n + BATCH / 2); k++) {
      if (!cache.has(k)) { if (!inflight.has(k)) fetchFrom(k); return; }
    }
  }

  // ----- what the match screen shows at command n
  const players = () => data.players;
  const playerOf = (id) => data.players.find((p) => p.id === id) || null;
  const whoName = (id) => { const p = playerOf(id); return p ? p.who : `Player ${id}`; };
  const toMove = (n, pos) => (n < total ? data.commands[n].player : (pos.game && pos.game.current_player) || data.end?.player || 0);
  function turnAt(n) {
    const list = data.turns;
    for (let i = 0; i < list.length; i++) if (n < list[i].to || (i === list.length - 1)) return i;
    return 0;
  }
  function viewAt(n, pos) {
    const pl = (pos.players || []).filter((p) => p.id !== 255);
    return { version: n, view: { position: pos, me: null, moves: null, scores: pl.map((p) => [p.id, p.score || 0]), over: false, winners: [] } };
  }
  function apply(n, pos) {
    cur = n;
    const pid = toMove(n, pos);
    const seat = S.game.seats.find((s) => s.player_id === pid); // a bot game's seats are its player ids, ours are not
    S.game.current_seat = seat ? seat.seat : pid;
    applyView(viewAt(n, pos));
    render();
    prefetch(n);
    if (o.onAt) o.onAt(n, true);
  }

  // ----- moving through the game
  async function stepForward(animate) {
    const t = token, n = cur;
    if (n >= total) return false;
    const e = data.commands[n];
    const [before, after] = await Promise.all([positionAt(n), positionAt(n + 1)]);
    if (t !== token) return false;
    if (animate && !QUIET.has(e.kind)) {
      stats.animated++;
      board.setOverlays([]); // marks drawn for this moment (the page's panel) would point the wrong way while it plays
      await anim.run({
        events: [e], before, after, show: drawPosition, mine: false, me: 0, camera: true, followMoves: true,
        speed: () => speed,
      });
      if (t !== token) return false;
    }
    const turnEnds = data.turns.some((x) => x.to === n + 1 && n + 1 < total);
    apply(n + 1, after);
    stats.steps++;
    if (turnEnds && animate) {
      const next = data.commands[n + 1];
      play("enemy");
      banner(`Turn ${next.turn ?? 0}: ${whoName(next.player)}`, { ms: Math.round(900 / Math.max(1, speed)), kind: "turn" });
    }
    return true;
  }

  async function loop() {
    if (looping) return;
    looping = true;
    try {
      while (playing && cur < total) {
        if (seeking) { await seeking; continue; }
        if (document.hidden) { await sleep(200); continue; }
        let ok = false;
        try { ok = await stepForward(true); } catch (e) { playing = false; sayError(e); break; }
        if (ok) await sleep(GAP / speed);
      }
      if (cur >= total) playing = false;
    } finally {
      looping = false;
      render();
    }
  }

  // a jump: no animation (stepping back, a turn, the track)
  function seek(n) {
    n = Math.max(0, Math.min(total, Math.round(n)));
    token++;
    anim.skip();
    stats.jumps++;
    const t = token;
    cur = n;
    render();
    if (o.onAt) o.onAt(n, false);
    const job = (async () => {
      try {
        const pos = await positionAt(n);
        if (t === token) apply(n, pos);
      } catch (e) { sayError(e); } finally { if (seeking === job) seeking = null; }
    })();
    seeking = job;
    return job;
  }

  function setPlaying(on) {
    playing = !!on && cur < total;
    if (!playing) { token++; anim.skip(); }
    render();
    if (playing) loop();
  }

  const turnStart = (i) => data.turns[Math.max(0, Math.min(data.turns.length - 1, i))].from;
  function action(id) {
    switch (id) {
      case "play": if (cur >= total) { seek(0).then(() => setPlaying(true)); } else setPlaying(!playing); break;
      case "back": setPlaying(false); if (cur > 0) seek(cur - 1); break;
      case "fwd":
        setPlaying(false);
        if (cur < total && !seeking) stepForward(true).catch(sayError);
        break;
      case "prev": { const i = turnAt(cur); seek(cur > turnStart(i) ? turnStart(i) : turnStart(i - 1)); break; }
      case "next": { const i = turnAt(cur); seek(i + 1 < data.turns.length ? turnStart(i + 1) : total); break; }
      case "speed":
        speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
        try { localStorage.setItem(SPEED_KEY, String(speed)); } catch (e) { /* private mode */ }
        render();
        break;
      default: break;
    }
  }

  // ----- the deck: where the replay is, and the buttons
  const div = () => (data.check && data.check.divergence) || null;
  // the command that broke the match has been played: from here on the board may not be the server's
  const diverged = () => !!div() && cur > div().n;
  function caption() {
    const n = Math.min(cur, total - 1), e = data.commands[Math.max(0, n)];
    const pid = cur >= total ? data.end?.player : e ? e.player : 0;
    const turn = cur >= total ? (data.end?.turn ?? 0) : e ? e.turn : 0;
    const p = playerOf(pid);
    const tribe = p ? M.tribeName(p.tribe) : "";
    return `Turn ${turn} · ${tribe}${p ? ` (${p.who})` : ""}`;
  }
  function lastLine() {
    if (cur === 0) return "The start of the game";
    const e = data.commands[cur - 1];
    const text = D.describeEntry(e, M, (pid) => whoName(pid));
    return e.status === "illegal" ? `${text} (not legal here)` : e.status === "unsupported" ? `${whoName(e.player)}: ${e.text}` : text;
  }
  function final() {
    if (cur < total) return null;
    if (data.scores) return { text: `Final scores: ${data.scores.map(([id, s]) => `${whoName(id)} ${s}`).join(" · ")}`, ok: true };
    if (!data.check) return null;
    // an abandoned game that stops at its last command is not a divergence
    return { text: data.check.final, ok: (!!data.check.scores_match || data.check.state === "abandoned") && !data.check.divergence };
  }
  function segments() {
    return data.turns.map((x) => {
      const p = playerOf(x.player);
      return { from: x.from / total, to: x.to / total, colour: p ? M.tribeColour(p.tribe) : "#888" };
    });
  }
  const glyphs = () => [
    { id: "rp:prev", glyph: "prev", label: "Previous turn", disabled: cur === 0 },
    { id: "rp:back", glyph: "back", label: "Back one command", disabled: cur === 0 },
    { id: "rp:play", glyph: playing ? "pause" : "play", label: playing ? "Pause" : cur >= total ? "Play again" : "Play", big: true, active: playing },
    { id: "rp:fwd", glyph: "fwd", label: "Forward one command", disabled: cur >= total },
    { id: "rp:next", glyph: "next", label: "Next turn", disabled: cur >= total },
    { id: "rp:speed", text: `${speed}×`, label: "Speed" },
  ];

  function render() {
    if (!data) return;
    const shown = drag != null ? drag : cur;
    const warn = diverged() ? data.check.message : null;
    o.root.dataset.replayAt = String(cur);
    o.root.dataset.replayPlaying = playing ? "1" : "";
    if (hud) {
      const extra = o.deckExtra ? o.deckExtra(shown) : {};
      hud.update({
        warn,
        deck: {
          caption: drag != null ? `Command ${shown} of ${total}` : caption(), right: `${shown}/${total}`, line: lastLine(), final: final(),
          frac: total ? shown / total : 0, segments: segments(), warnFrom: div() ? div().n / total : null, buttons: glyphs(),
          marks: extra.marks || null,
          onSeek: (f, done) => {
            const n = Math.round(f * total);
            if (done) { drag = null; seek(n); } else { drag = n; render(); }
          },
        },
      });
      return;
    }
    renderHtml(shown, warn);
  }

  // ----- technical mode: the deck in the action bar, the strip on the board
  let el = null;
  function buildHtml() {
    const bar = $("g-bar");
    for (const c of [...bar.children]) c.hidden = true;
    const btn = (b) => h("button", { type: "button", class: `btn g-rp-btn${b.big ? " primary" : ""}`, id: b.id.replace(":", "-"), "aria-label": b.label,
      onclick: () => action(b.id.slice(3)) });
    const buttons = glyphs().map(btn);
    const slider = h("input", { type: "range", id: "rp-slider", min: "0", max: String(total), step: "1", value: "0", "aria-label": "Replay position",
      oninput: () => { drag = Number(slider.value); render(); },
      onchange: () => { const n = Number(slider.value); drag = null; seek(n); } });
    el = {
      box: h("div", { class: "g-rp", id: "g-replay" },
        h("div", { class: "g-rp-top" }, h("span", { class: "g-rp-cap", id: "rp-caption" }), h("span", { class: "g-rp-count", id: "rp-count" })),
        h("div", { class: "g-rp-line", id: "rp-line" }),
        slider,
        h("div", { class: "g-rp-btns" }, ...buttons)),
      buttons, slider,
      warn: h("div", { class: "g-rp-warn", id: "rp-warn", role: "alert", hidden: true }),
    };
    bar.appendChild(el.box);
    $("g-board-wrap").appendChild(el.warn);
  }
  const SIGN = { play: "▶", pause: "❚❚", back: "‹", fwd: "›", prev: "«", next: "»" };
  function renderHtml(shown, warn) {
    if (!el) buildHtml();
    $("rp-caption").textContent = drag != null ? `Command ${shown} of ${total}` : caption();
    $("rp-count").textContent = `${shown}/${total}`;
    const f = final();
    const line = $("rp-line");
    line.textContent = f ? f.text : lastLine();
    line.dataset.final = f ? (f.ok ? "ok" : "bad") : "";
    if (drag == null) el.slider.value = String(cur);
    glyphs().forEach((b, i) => {
      const x = el.buttons[i];
      x.textContent = b.text || SIGN[b.glyph] || "";
      x.disabled = !!b.disabled;
      x.setAttribute("aria-label", b.label);
      if (b.big) x.setAttribute("aria-pressed", b.active ? "true" : "false");
    });
    el.warn.hidden = !warn;
    el.warn.textContent = warn || "";
  }

  // ----- start
  // `at`: the moment to open on, or a function of the loaded data giving it
  async function start(at = 0) {
    const loaded = await source.load();
    data = loaded.data;
    total = data.commands.length;
    S.game = loaded.game;
    A.fetchLog = async () => data.commands.slice(0, cur).map((e, i) => ({ ...e, seq: i + 1 }));
    const n = Math.max(0, Math.min(total, (typeof at === "function" ? at(data) : at) || 0));
    const pos = await positionAt(n);
    apply(n, pos);
    if (data.check && data.check.state !== "matches" && !data.check.divergence) say(data.check.final);
    return data;
  }

  return {
    start, action, seek, render, stats, setPlaying, cached: (n) => cache.get(n) || null,
    get at() { return cur; }, get total() { return total; }, get playing() { return playing; }, get speed() { return speed; },
    get data() { return data; }, get diverged() { return diverged(); },
    play: (on = true) => setPlaying(on),
  };
}
