// Drawing pieces for game mode: the retail UI sprites (manifest `icon/...` keys) drawn on a canvas, the retail shapes
// (round buttons, PopupBg's rounded cards, pill badges) and the hit list that makes drawn things tappable.
//
// Sizes are in the retail canvas's units ("u", about one CSS pixel on a phone) times the layout scale `k`.

// the retail colours (UIRoundButton, BasicPopup, NotificationBadge in the HudScreen prefab)
export const COLOURS = {
  buttonBg: "rgba(0,0,0,0.8)", // UIRoundButton deactiveColor
  buttonActive: "rgba(0,153,255,0.8)", // activeColor #0099ff
  outline: "#ffffff",
  badge: "rgba(255,51,0,0.8)", // NotificationBadge #ff3300
  blue: "#0099ff",
  green: "#00cc33", // ColorConstants.green, measured on the reference rig
  red: "#ff3300",
  popup: "#000000",
  textBg: "rgba(0,0,0,0.5)",
};

export const ease = {
  outBack: (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
};

export function createKit(manifest, base = "/art/") {
  const assets = (manifest && manifest.assets) || {};
  const version = manifest && manifest.game_version ? `?v=${encodeURIComponent(manifest.game_version)}` : "";
  const images = new Map();
  const listeners = new Set();

  function image(key) {
    const e = assets[key];
    if (!e) return null;
    let im = images.get(key);
    if (!im) {
      const img = new Image();
      im = { img, state: "loading", e };
      images.set(key, im);
      img.onload = () => { im.state = "ok"; for (const fn of listeners) fn(); };
      img.onerror = () => { im.state = "error"; };
      img.src = `${base}${e.file}${version}`;
    }
    return im;
  }
  const first = (keys) => [].concat(keys).find((k) => k && assets[k]) || null;

  // the box of an image's solid pixels as fractions of it, [x0, y0, x1, y1] (alpha above 128: past a unit's soft shadow);
  // the whole image when it cannot be read
  const boxes = new WeakMap();
  function solidBox(img) {
    let b = boxes.get(img);
    if (b) return b;
    b = [0, 0, 1, 1];
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 >= 0) b = [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h];
    } catch (e) { /* unreadable: the whole image */ }
    boxes.set(img, b);
    return b;
  }

  // A UI sprite fitted into a size x size box centred on (cx, cy), the way a Unity Image with "preserve aspect" draws it:
  // the sprite's full rect (before trimming) fills the box, the trimmed pixels sit where the anchor puts them. An Image
  // ignores the sprite's pivot, so the anchor (the pivot, in trimmed pixels) is moved to the full rect's centre first:
  // without that a sprite with a low pivot (the Workshop reward, 0.28) is drawn high, out of its circle.
  //
  // The board's art (a building, a unit, a resource: an entry without a rect) is anchored on its tile's centre, which
  // says nothing of where the picture is. With `o.centred` its solid pixels are fitted into the box and centred there.
  function icon(ctx, keys, cx, cy, size, o = {}) {
    const key = first(keys);
    const im = key ? image(key) : null;
    if (!im || im.state !== "ok") return false;
    const { e, img } = im;
    if (o.centred && !e.rect) {
      const [x0, y0, x1, y1] = solidBox(img);
      const s = size / Math.max((x1 - x0) * e.w, (y1 - y0) * e.h);
      const a = ctx.globalAlpha;
      if (o.alpha != null) ctx.globalAlpha = a * o.alpha;
      ctx.drawImage(img, cx - ((x0 + x1) / 2) * e.w * s, cy - ((y0 + y1) / 2) * e.h * s, e.w * s, e.h * s);
      ctx.globalAlpha = a;
      return true;
    }
    const rw = (e.rect && e.rect[0]) || e.w, rh = (e.rect && e.rect[1]) || e.h;
    const [px, py] = e.pivot || [0.5, 0.5];
    const ax = e.anchor[0] - (px - 0.5) * rw, ay = e.anchor[1] - (0.5 - py) * rh; // the full rect's centre, in trimmed pixels
    const s = size / Math.max(rw, rh);
    const a = ctx.globalAlpha;
    if (o.alpha != null) ctx.globalAlpha = a * o.alpha;
    ctx.drawImage(img, cx - ax * s, cy - ay * s, e.w * s, e.h * s);
    ctx.globalAlpha = a;
    return true;
  }

  return {
    has: (key) => !!assets[key],
    icon,
    onLoad(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// The things drawn this frame that a tap can hit, in CSS px of the canvas. The last one added is on top.
export function createHits() {
  let list = [];
  return {
    clear() { list = []; },
    add(el) { list.push(el); return el; },
    at(x, y) {
      for (let i = list.length - 1; i >= 0; i--) {
        const el = list[i];
        if (el.enabled === false) continue;
        if (el.round) {
          const dx = x - (el.x + el.w / 2), dy = y - (el.y + el.h / 2), r = el.w / 2 + (el.slop || 0);
          if (dx * dx + dy * dy <= r * r) return el;
        } else if (x >= el.x && y >= el.y && x <= el.x + el.w && y <= el.y + el.h) return el;
      }
      return null;
    },
    get list() { return list; },
  };
}
