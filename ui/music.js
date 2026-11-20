// Music on the site's pages, outside a match: retail plays its theme (`startscreen`) on the menus and a tribe's song on
// the tribe picker; a match picks its own (static/game/sound.js). One looped clip at a time, crossfading (fade in 1 s,
// out 2 s, the menu AudioManager's times). The page that follows carries on where the last one stopped (the position is
// handed on in sessionStorage). Browsers keep audio locked until the first tap on a page, so it starts then. The Music
// switch is the one the settings page and the game menu write (localStorage "poly.audio", see sound.js).
//
//   import { playMusic } from "ui/music.js";
//   playMusic("startscreen");          // or "citysong_bardur"; playMusic(null) fades out

const AUDIO_KEY = "poly.audio";
const HANDOFF = "poly.music";
const GAIN = 0.22;
const FADE_IN = 1, FADE_OUT = 2;

export const THEME = "startscreen";
export const tribeSong = (tribeName) => (tribeName ? `citysong_${String(tribeName).toLowerCase()}` : null);

const musicOn = () => {
  try { return JSON.parse(localStorage.getItem(AUDIO_KEY) || "{}").music !== false; } catch (e) { return true; }
};

let manifest = null;
const assets = () => {
  if (!manifest) {
    manifest = fetch("/art/manifest.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null)).then((m) => (m && m.assets) || {}).catch(() => ({}));
  }
  return manifest;
};

let current = null; // {name, el}
let wanted = null;
const handoff = (() => { try { return JSON.parse(sessionStorage.getItem(HANDOFF) || "null"); } catch (e) { return null; } })();

function fade(el, to, secs, done) {
  const from = el.volume, t0 = performance.now();
  clearInterval(el.__fade);
  el.__fade = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / (secs * 1000));
    el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
    if (k >= 1) { clearInterval(el.__fade); if (done) done(); }
  }, 50);
}

function stop() {
  if (!current) return;
  const el = current.el;
  current = null;
  fade(el, 0, FADE_OUT, () => { el.pause(); el.src = ""; });
}

async function start(name) {
  const a = (await assets())[`sound/${name}`];
  if (!a || wanted !== name || (current && current.name === name)) return;
  const el = new Audio(`/art/${a.file}`);
  el.loop = true;
  el.volume = 0;
  if (handoff && handoff.name === name && handoff.t > 0) el.currentTime = handoff.t;
  try { await el.play(); } catch (e) { return; } // locked until a tap
  if (wanted !== name) { el.pause(); return; }
  stop();
  current = { name, el };
  fade(el, GAIN, FADE_IN);
}

let asked = null;
export function playMusic(name) {
  asked = name || null;
  wanted = musicOn() ? asked : null;
  if (!wanted) { stop(); return; }
  if (!current || current.name !== wanted) start(wanted);
}
// after the Music switch changed
export const refreshMusic = () => playMusic(asked);

export const music = {
  get playing() { return current ? current.name : null; },
  get wanted() { return wanted; },
};
window.addEventListener("storage", (e) => { if (e.key === AUDIO_KEY) refreshMusic(); });

for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => { if (wanted && (!current || current.name !== wanted)) start(wanted); }, { passive: true });
}
window.addEventListener("pagehide", () => {
  try { sessionStorage.setItem(HANDOFF, JSON.stringify(current ? { name: current.name, t: current.el.currentTime } : null)); } catch (e) { /* private mode */ }
});
