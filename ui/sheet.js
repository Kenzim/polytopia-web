// Bottom sheet with peek, half and full states, a drag handle and its own scrolling (CONTRACTS.md section 6).
//
//   const sheet = openSheet({ title: "Warrior", content: node, states: ["peek", "half", "full"], state: "half" });
//   sheet.setState("full"); sheet.setContent(other); sheet.close();
//
// Options: title, content (Node or HTML string), states (any of "peek", "half", "full", "auto"; default peek, half
// and full), state (the one to open in), peek (px visible in the peek state, default 96), modal (dim the page and
// block it; default false so the board stays usable), dismissable (the handle, scrim, Escape and a downward drag
// close it; default true), onClose(), onChange({state, height}), className, label (aria-label).
// "auto" is as tall as its content (at most full): that is what dialogs use.
//
// Non-modal sheets let touches through to the page above them. Its height is also published as `--sheet-h` on the
// document element, so the page can keep the board's controls clear of it.

const host = () => {
  let h = document.getElementById("sheet-host");
  if (!h) {
    h = document.createElement("div");
    h.id = "sheet-host";
    document.body.appendChild(h);
  }
  return h;
};

// shared even if this module is loaded twice (two URLs for one file)
const open = (window.__polySheets = window.__polySheets || []);
let escapeBound = false;

function bindEscape() {
  if (escapeBound || window.__polySheetsEscape) return;
  escapeBound = window.__polySheetsEscape = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = open[open.length - 1];
    if (top && top.dismissable) {
      e.preventDefault();
      top.close();
    }
  });
}

// env(safe-area-inset-*) in px (custom properties keep it unresolved, so measure with a probe)
function safe(side) {
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-${side}:env(safe-area-inset-${side}, 0px)`;
  document.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe)[`padding${side[0].toUpperCase()}${side.slice(1)}`]) || 0;
  probe.remove();
  return v;
}

const viewportHeight = () => (window.visualViewport ? window.visualViewport.height : window.innerHeight);
const px = (n) => `${Math.round(n)}px`;

function toNode(content) {
  if (content == null) return null;
  if (typeof content === "string") {
    const t = document.createElement("template");
    t.innerHTML = content;
    return t.content;
  }
  return content;
}

export function openSheet(opts = {}) {
  bindEscape();
  const states = opts.states && opts.states.length ? opts.states : ["peek", "half", "full"];
  const peek = opts.peek ?? 96;
  const modal = !!opts.modal;
  const dismissable = opts.dismissable !== false;
  let state = states.includes(opts.state) ? opts.state : states[Math.min(1, states.length - 1)];
  let closed = false;
  let height = 0;

  const root = document.createElement("div");
  root.className = "sheet" + (opts.className ? ` ${opts.className}` : "");
  root.setAttribute("role", "dialog");
  if (modal) root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", opts.label || opts.title || "Panel");
  root.tabIndex = -1;

  const grip = document.createElement("div");
  grip.className = "sheet-grip";
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "sheet-handle";
  handle.setAttribute("aria-label", states.length > 1 ? "Resize panel" : "Panel handle");
  const head = document.createElement("div");
  head.className = "sheet-head";
  const titleEl = document.createElement("h2");
  titleEl.className = "sheet-title";
  head.appendChild(titleEl);
  if (dismissable && !modal) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "icon-btn sheet-close";
    x.setAttribute("aria-label", "Close");
    x.textContent = "×";
    x.addEventListener("click", () => api.close());
    x.addEventListener("pointerdown", (e) => e.stopPropagation()); // not the start of a drag
    head.appendChild(x);
  }
  grip.append(handle, head);
  const body = document.createElement("div");
  body.className = "sheet-body";
  root.append(grip, body);

  let scrim = null;
  if (modal) {
    scrim = document.createElement("div");
    scrim.className = "sheet-scrim";
    scrim.addEventListener("click", () => dismissable && api.close());
  }

  function fullHeight() {
    const top = Math.max(16, safe("top")) + 8;
    return Math.max(120, viewportHeight() - top);
  }

  function contentHeight() {
    // natural height: head + content (the body normally stretches to fill the sheet)
    const prev = [root.style.height, root.style.transition, body.style.flex];
    root.style.transition = "none";
    root.style.height = "auto";
    root.style.maxHeight = px(fullHeight());
    body.style.flex = "none";
    const h = root.offsetHeight;
    root.style.maxHeight = "";
    root.style.height = prev[0];
    root.style.transition = prev[1];
    body.style.flex = prev[2];
    return h;
  }

  function heightOf(s) {
    const full = fullHeight();
    if (s === "peek") return Math.min(peek + safe("bottom"), full);
    if (s === "half") return Math.min(Math.round(viewportHeight() * 0.5), full);
    if (s === "auto") return Math.min(contentHeight(), full);
    return full;
  }

  function publish() {
    document.documentElement.style.setProperty("--sheet-h", px(closed ? 0 : height));
    if (opts.onChange) opts.onChange({ state, height });
  }

  function apply(s, instant = false) {
    state = s;
    height = heightOf(s);
    if (instant) root.classList.add("dragging");
    root.style.height = px(height);
    if (instant) {
      void root.offsetHeight;
      root.classList.remove("dragging");
    }
    root.dataset.state = s;
    publish();
  }

  // ---------- dragging the handle ----------
  let drag = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    drag = { y0: e.clientY, h0: height, last: [{ t: performance.now(), y: e.clientY }], moved: false };
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      root.classList.add("dragging");
    }
    const lo = 0, hi = fullHeight();
    root.style.height = px(Math.min(hi, Math.max(lo, drag.h0 - dy)));
    const t = performance.now();
    drag.last.push({ t, y: e.clientY });
    while (drag.last.length > 2 && t - drag.last[0].t > 120) drag.last.shift();
    e.preventDefault();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* released */ }
    root.classList.remove("dragging");
    if (!d.moved) {
      if (e.type === "pointerup" && e.target === handle) cycle();
      return;
    }
    const a = d.last[0], b = d.last[d.last.length - 1];
    const v = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0; // px/ms, positive = moving down
    const now = parseFloat(root.style.height) || height;
    const projected = now - v * 160;
    const lowest = Math.min(...states.map(heightOf));
    if (dismissable && projected < lowest * 0.6) {
      api.close();
      return;
    }
    let best = state, bd = Infinity;
    for (const s of states) {
      const dist = Math.abs(heightOf(s) - projected);
      if (dist < bd) { bd = dist; best = s; }
    }
    apply(best);
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  function cycle() {
    // a tap on the handle: up one state, and from the top back down to the middle one
    if (states.length < 2) return;
    const i = states.indexOf(state);
    apply(states[i + 1 < states.length ? i + 1 : Math.max(0, states.length - 2)]);
  }

  const onResize = () => !closed && !drag && apply(state, true);
  // an "auto" sheet follows its content as it grows or shrinks (pictures loading, a detail row opening)
  const fitter = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => { if (state === "auto" && !closed && !drag && root.isConnected) apply("auto"); })
    : null;
  window.addEventListener("resize", onResize);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", onResize);

  const api = {
    el: root,
    body,
    get state() { return state; },
    get height() { return height; },
    get closed() { return closed; },
    dismissable,
    setState(s) {
      if (states.includes(s) && !closed) apply(s);
    },
    setTitle(t) {
      titleEl.textContent = t || "";
      head.hidden = !t && !(dismissable && !modal);
      if (t) root.setAttribute("aria-label", opts.label || t);
    },
    setContent(content) {
      body.replaceChildren();
      const n = toNode(content);
      if (n) {
        body.appendChild(n);
        if (fitter) fitter.observe(n);
      }
      if (state === "auto" && !closed) apply("auto");
    },
    close() {
      if (closed) return;
      closed = true;
      const i = open.indexOf(api);
      if (i >= 0) open.splice(i, 1);
      window.removeEventListener("resize", onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", onResize);
      if (fitter) fitter.disconnect();
      root.style.height = "0px";
      if (scrim) scrim.classList.remove("on");
      document.documentElement.style.setProperty("--sheet-h", px(open.length ? open[open.length - 1].height : 0));
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        root.remove();
        if (scrim) scrim.remove();
        if (opener && opener.isConnected && modal) try { opener.focus(); } catch (err) { /* gone */ }
      };
      root.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 350);
      if (opts.onClose) opts.onClose();
    },
  };

  const opener = document.activeElement;
  api.setTitle(opts.title || "");
  api.setContent(opts.content);
  const h = host();
  if (scrim) h.appendChild(scrim);
  h.appendChild(root);
  open.push(api);
  // open from zero height so it slides up
  root.style.height = "0px";
  void root.offsetHeight;
  apply(state);
  if (scrim) requestAnimationFrame(() => scrim.classList.add("on"));
  if (modal) root.focus({ preventScroll: true });
  return api;
}

export function closeAllSheets() {
  for (const s of [...open]) s.close();
}

export default openSheet;
