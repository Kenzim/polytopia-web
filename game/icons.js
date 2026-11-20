// The extracted game art as small DOM icons (the unit, tech and building pictures and the UI icons of the retail game).
// Everything here is optional: without the art (it is extracted on the server, not shipped) `icon` returns a plain
// disc with the first letters of the name, so a panel never has a hole in it.

import { recolour } from "board/board.js";

export function createIcons(manifest, h, base = "/art/") {
  const assets = (manifest && manifest.assets) || {};
  const version = manifest && manifest.game_version ? `?v=${encodeURIComponent(manifest.game_version)}` : "";
  const entry = (key) => assets[key] || null;
  const url = (key) => (entry(key) ? `${base}${entry(key).file}${version}` : null);
  const first = (keys) => [].concat(keys).find((k) => k && entry(k)) || null;
  const initials = (name) => String(name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";

  // keys: one manifest key or a list tried in order; `name` is what the fallback disc spells. With `colour`
  // ("#rrggbb") a picture the art baked a tribe's colour into (a unit's) shows in that colour once it is made.
  function icon(keys, name, { cls = "", colour = null } = {}) {
    const k = first(keys);
    if (k) {
      const img = h("img", { class: `g-ico${cls ? ` ${cls}` : ""}`, src: url(k), alt: "", draggable: "false", "data-art": k });
      const t = entry(k).tint;
      if (colour && t && colour.toLowerCase() !== String(t.colour).toLowerCase()) inColour(k, colour).then((src) => { if (src) img.src = src; });
      return img;
    }
    return h("span", { class: `g-ico g-ico-fb${cls ? ` ${cls}` : ""}`, "aria-hidden": "true" }, initials(name));
  }
  const made = new Map(); // "key|#rrggbb" -> a promise of the picture's data URL in that colour (null when it cannot be made)
  function inColour(key, colour) {
    const k = `${key}|${colour}`;
    if (!made.has(k)) {
      const t = entry(key).tint;
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      made.set(k, Promise.all([load(url(key)), load(`${base}${t.range}${version}`)])
        .then(([b, r]) => recolour(b, r, rgb(t.colour), rgb(colour)).toDataURL(), () => null));
    }
    return made.get(k);
  }

  return {
    has: (key) => !!entry(key),
    url,
    icon,
    star: (cls = "") => icon(["icon/staricon", "icon/star"], "★", { cls: `g-star-ico ${cls}`.trim() }),
    population: (cls = "") => icon("icon/population", "P", { cls }),
    // a unit as the given tribe fields it (its own picture, in the player's `colour` when given), else the small round icon
    unit: (id, tribe, name, cls = "", colour = null) => icon([tribe && `unit/${tribe}/${id}`, `icon/${id}_icon`], name || id, { cls, colour }),
    tech: (id, name, cls = "") => icon(`tech/${id}`, name || id, { cls }),
    improvement: (id, tribe, name, cls = "") => icon([tribe && `improvement/${id}/${tribe}`, `improvement/${id}`, `icon/${id}_icon`], name || id, { cls }),
  };
}
