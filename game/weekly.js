// The weekly practice controls on the game screen of a weekly game: undo across turns, redo, restart, save points and
// the current score. A small button over the board opens a sheet; it works in both the game and technical modes.
//
// o: {api, toast, confirm, h, root, gameId, version () -> the view's version, reset async () -> reload the screen
// after the game went back}

const num = (n) => Number(n).toLocaleString("en-GB");

export function createWeekly(o) {
  const { api, toast, confirm, h, root, gameId } = o;
  const base = `/api/games/${gameId}/weekly`;
  let st = null;
  let busy = false;

  const button = h("button", { class: "g-wk-btn", id: "wk-open", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" }, "Weekly");
  const score = h("span", { class: "g-wk-score", id: "wk-score" });
  const body = h("div", { class: "g-wk-body" });
  const box = h("section", { class: "g-wk", id: "wk-panel", role: "dialog", "aria-label": "Weekly practice", hidden: "" },
    h("div", { class: "g-wk-head" }, h("span", { class: "g-wk-title" }, "Weekly practice"), score,
      h("button", { class: "g-an-x", type: "button", "aria-label": "Close", onclick: () => open(false) }, "\u00d7")),
    body);
  root.append(button, box);
  button.addEventListener("click", () => open(box.hidden));

  function open(on) {
    box.hidden = !on;
    button.setAttribute("aria-expanded", on ? "true" : "false");
    root.dataset.weekly = on ? "open" : "";
    if (on) load();
  }

  async function act(path, body2 = {}, method = "post") {
    if (busy) return;
    busy = true;
    draw();
    try {
      const r = method === "delete" ? await api.del(`${base}/${path}`) : await api.post(`${base}/${path}`, { version: o.version(), ...body2 });
      st = r.weekly;
      if (method !== "delete") await o.reset();
      return r;
    } catch (e) {
      toast(e.message || "That did not work.", { kind: "error" });
      await load();
    } finally {
      busy = false;
      draw();
    }
  }

  async function load() {
    try {
      st = (await api.get(base)).weekly;
    } catch (e) {
      st = null;
    }
    draw();
  }

  function draw() {
    score.textContent = st && st.score != null ? `Score ${num(st.score)}` : "";
    root.dataset.weeklyRewinds = st ? String(st.rewinds) : "";
    if (!st) { body.replaceChildren(h("p", { class: "g-an-muted" }, "Loading\u2026")); return; }
    if (!st.active) { body.replaceChildren(h("p", {}, "This attempt is over.")); return; }
    const btn = (id, label, onclick, disabled = false, primary = false) =>
      h("button", { id, class: `g-an-btn${primary ? " primary" : ""}`, type: "button", disabled: disabled || busy ? "" : null, onclick }, label);
    const saves = st.saves.map((s) => h("li", { class: "g-wk-save", "data-save": s.id },
      h("span", { class: "g-an-grow" }, h("strong", {}, s.name), h("span", { class: "g-an-muted" }, ` \u00b7 turn ${s.turn}`)),
      btn(`wk-restore-${s.id}`, "Restore", async () => {
        if (await confirm({ title: `Go back to "${s.name}"?`, message: "The moves since then are lost. The attempt will be marked as rewound.", confirmLabel: "Restore" })) act(`saves/${s.id}/restore`);
      }),
      btn(`wk-delete-${s.id}`, "Delete", () => act(`saves/${s.id}`, {}, "delete"))));
    const nameInput = h("input", { id: "wk-name", class: "g-wk-name", type: "text", maxlength: "40", placeholder: "Save point name", "aria-label": "Save point name" });
    body.replaceChildren(
      h("div", { class: "g-an-row" },
        btn("wk-undo", "Undo", () => act("undo"), !st.can_undo),
        btn("wk-redo", st.redo ? `Redo (${st.redo})` : "Redo", () => act("redo"), !st.redo),
        btn("wk-restart", "Restart", async () => {
          if (await confirm({ title: "Restart from the beginning?", message: "The game goes back to the opening position. The attempt will be marked as rewound.", confirmLabel: "Restart", danger: true })) act("restart");
        })),
      h("p", { class: "g-an-note" }, "Undo here reaches back across turns, even past the bots' moves. Going back further than the normal undo allows marks the attempt as rewound: it keeps its score but is not compared with the official leaderboard.",
        st.rewinds ? h("strong", { id: "wk-rewinds" }, ` Rewinds so far: ${st.rewinds}.`) : null),
      h("p", { class: "g-an-sub" }, `Save points (${st.saves.length} of ${st.max_saves})`),
      h("form", { class: "g-an-row", onsubmit: (e) => { e.preventDefault(); act("saves", { name: nameInput.value }).then((r) => { if (r) nameInput.value = ""; }); } },
        nameInput, h("button", { id: "wk-save", class: "g-an-btn", type: "submit", disabled: busy || st.saves.length >= st.max_saves ? "" : null }, "Save")),
      st.saves.length ? h("ul", { class: "g-wk-saves" }, saves) : h("p", { class: "g-an-muted" }, "No save points yet."));
  }

  load();
  const self = { sync: load, open, state: () => st };
  root.__game = root.__game || {};
  root.__game.weekly = self;
  return self;
}
