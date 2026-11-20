// Sound effects from the extracted game sounds (/art/manifest.json keys `sound/<name>`). Browsers keep audio locked until
// the first tap, so the context is made on the first pointer or key press. Missing sounds are skipped silently.

// The two switches live in this browser (the settings page and the game menu write them): effects and music.
export const AUDIO_KEY = "poly.audio";
export function readAudio() {
  const a = { effects: true, music: true };
  try { Object.assign(a, JSON.parse(localStorage.getItem(AUDIO_KEY) || "{}")); } catch (e) { /* private mode */ }
  return a;
}
export function writeAudio(patch) {
  const a = { ...readAudio(), ...patch };
  try { localStorage.setItem(AUDIO_KEY, JSON.stringify(a)); } catch (e) { /* private mode */ }
  return a;
}

export function createSound(manifest, { base = "/art/", enabled = () => true, musicEnabled = () => true } = {}) {
  const assets = (manifest && manifest.assets) || {};
  const buffers = new Map(); // name -> AudioBuffer | "loading" | "missing"
  let ctx = null;

  const entry = (name) => assets[`sound/${name}`];
  const has = (name) => !!entry(name);

  function context() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    return ctx;
  }

  async function load(name) {
    const e = entry(name);
    if (!e) { buffers.set(name, "missing"); return; }
    buffers.set(name, "loading");
    try {
      const r = await fetch(`${base}${e.file}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.arrayBuffer();
      buffers.set(name, await new Promise((ok, no) => context().decodeAudioData(data, ok, no)));
    } catch (err) {
      buffers.set(name, "missing");
    }
  }

  function unlock() {
    const c = context();
    if (c && c.state === "suspended") c.resume().catch(() => {});
  }
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlock, { passive: true });

  // play(name) or play(["first_choice", "fallback"]): the first the art has
  function play(names, { gain = 0.7 } = {}) {
    if (!enabled() || !assets) return;
    const name = [].concat(names).find(has);
    if (!name) return;
    const c = context();
    if (!c || c.state !== "running") { if (c) unlock(); }
    const b = buffers.get(name);
    if (b === undefined) { load(name).then(() => { /* the first play is lost, the next is heard */ }); return; }
    if (!b || typeof b === "string" || !c) return;
    const src = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = gain;
    src.buffer = b;
    src.connect(g).connect(c.destination);
    src.start();
  }

  function preload(names) {
    for (const n of names) if (has(n) && !buffers.has(n)) load(n);
  }

  // Music: one looped clip at a time, quietly, while music is on: the climate's nature track in a match, a tribe's song on
  // that tribe's screens, the theme elsewhere (the page picks). A change crossfades: the old clip fades out over
  // `fadeOut` seconds while the new one fades in over `fadeIn`, as retail's AudioManager fades its ambience sources. A clip
  // left and come back to carries on where it was. It starts on the first tap (browsers keep audio locked until then) and
  // follows the setting being switched.
  const offsets = new Map(); // name -> seconds into the clip when it was faded out
  let song = null; // {name, src, g, startedAt, offset, dur}
  let wanted = null;
  let fades = { fadeIn: 1, fadeOut: 1 };
  const where = (s) => (s.offset + ctx.currentTime - s.startedAt) % s.dur;
  async function startSong(name) {
    const c = context();
    if (!c || !has(name)) return;
    if (!buffers.has(name)) await load(name);
    const b = buffers.get(name);
    if (wanted !== name || !b || typeof b === "string" || (song && song.name === name)) return;
    if (c.state !== "running") return; // locked: the first tap starts it
    stopSong(fades.fadeOut);
    const src = c.createBufferSource();
    const g = c.createGain();
    const now = c.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(MUSIC_GAIN, now + Math.max(0.01, fades.fadeIn));
    src.buffer = b;
    src.loop = true;
    src.connect(g).connect(c.destination);
    const offset = (offsets.get(name) || 0) % b.duration;
    src.start(0, offset);
    song = { name, src, g, startedAt: now, offset, dur: b.duration };
  }
  function stopSong(fadeOut = 0) {
    if (!song) return;
    const s = song;
    song = null;
    offsets.set(s.name, where(s));
    const now = ctx.currentTime;
    try {
      s.g.gain.cancelScheduledValues(now);
      s.g.gain.setValueAtTime(s.g.gain.value, now);
      s.g.gain.linearRampToValueAtTime(0, now + Math.max(0.01, fadeOut));
      s.src.stop(now + Math.max(0.01, fadeOut) + 0.05);
    } catch (e) { /* stopped */ }
  }
  // music(name, {fadeIn, fadeOut}) in seconds; music(null) fades out
  function music(name, o = {}) {
    wanted = name || null;
    fades = { fadeIn: o.fadeIn ?? 1, fadeOut: o.fadeOut ?? 1 };
    if (!wanted || !musicEnabled()) { stopSong(fades.fadeOut); return; }
    if (!song || song.name !== wanted) startSong(wanted);
  }
  const kick = () => {
    const c = context();
    const go = () => { if (wanted && musicEnabled() && (!song || song.name !== wanted)) startSong(wanted); };
    if (c && c.state !== "running") c.resume().then(go, () => {}); else go();
  };
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, kick, { passive: true });

  return {
    play, preload, has, unlock, music,
    get playingMusic() { return song ? song.name : null; },
    get wantedMusic() { return wanted; },
    // seconds into the clip playing now (null when none), so a page can hand it on to the next
    get musicTime() { return song ? where(song) : null; },
    seekMusic(name, t) { if (!song || song.name !== name) offsets.set(name, Math.max(0, t || 0)); },
  };
}

const MUSIC_GAIN = 0.22;

// Retail's MusicData: the nature (ambience) track for each climate, by TribeType index (the climate a tile has), and each
// tribe's song. A match plays the nature track of the climate at the centre of the view, crossfading as the camera
// moves (the in-game AudioManager: trackCameraMovement on, fade in 5 s, fade out 2.6 s). The tribe song plays only on
// the screens retail marks playTribeMusic (the tech tree, Game Stats) and the tribe pickers. The theme (startscreen)
// plays on the menus.
export const NATURE = { 0: 0, 13: 1, 7: 2, 4: 3, 10: 4, 8: 5, 6: 6, 9: 7, 12: 8, 15: 9, 2: 10, 3: 11, 11: 12, 5: 13, 14: 14, 16: 15, 17: 16 };
export const natureTrack = (climate) => (climate in NATURE ? `nature_${NATURE[climate]}` : null);
export const tribeSong = (tribeName) => (tribeName ? `citysong_${String(tribeName).toLowerCase()}` : null);
export const THEME = "startscreen";
export const AMBIENCE_FADE = { fadeIn: 5, fadeOut: 2.6 };
export const MENU_FADE = { fadeIn: 1, fadeOut: 2 };

// Event name -> the game sounds to try, in order
export const SOUNDS = {
  press: ["click_down"],
  click: ["click_down"],
  select: ["click_down"],
  score: ["score", "count"],
  move: ["move_grass", "move_forest", "plop", "snap"],
  moveWater: ["move_water", "move_grass"],
  hit: ["hit_1", "hit_2", "hit_3"],
  kill: ["kill", "hit_3"],
  attackMelee: ["sword", "club", "claw"],
  attackRanged: ["arrow", "gun"],
  spawn: ["spawn"],
  spawnEnemy: ["spawn_enemy"],
  build: ["grow", "grow_small", "plop"],
  heal: ["heal"],
  capture: ["capture_city"],
  lostCity: ["lost_city_long", "enemy_action"],
  tech: ["tech_discover"],
  reward: ["reward_start"],
  rewardDone: ["reward_end_v2"],
  coin: ["paystar_1", "income_increase"],
  promote: ["unit_promote"],
  turn: ["alert_popup", "suggestion_02"],
  popup: ["bubble_appear", "click_down"],
  enemy: ["enemy_action"],
  win: ["endscreen_win"],
  lose: ["endscreen_loose"],
  peace: ["peace_treaty_accepted"],
  peaceSent: ["peace_treaty_sent"],
  error: ["peace_treaty_rejected"],
};
