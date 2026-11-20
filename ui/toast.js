// Toasts: short messages that fade by themselves (CONTRACTS.md section 6).
//
//   toast("Saved");                           // info
//   toast.ok("Map saved");  toast.error(err); // err may be an Error (an ApiError's message is shown)
//   toast("Turn ended", { action: { label: "Undo", onClick: undo }, ms: 6000 });
//
// Tapping a toast dismisses it. Toasts sit above the bottom action bar (the `--bottom-ui` variable). At most
// three show at once; the same message again just restarts the first one's timer.

const MAX = 3;

function host() {
  let h = document.getElementById("toast-host");
  if (!h) {
    h = document.createElement("div");
    h.id = "toast-host";
    h.setAttribute("aria-live", "polite");
    document.body.appendChild(h);
  }
  return h;
}

export function toast(message, opts = {}) {
  const text = message instanceof Error ? message.message : String(message);
  const kind = opts.kind || "info";
  const h = host();
  for (const el of h.children) {
    if (el.dataset.text === text && el.dataset.kind === kind && el.__restart) {
      el.__restart();
      return { dismiss: el.__dismiss };
    }
  }
  while (h.children.length >= MAX) h.firstElementChild.__dismiss(true);

  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.dataset.text = text;
  el.dataset.kind = kind;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);
  let timer = 0;
  let gone = false;
  const dismiss = (now = false) => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    if (now === true) return el.remove();
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  const ms = opts.ms ?? (kind === "error" ? 6000 : 3500);
  const restart = () => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(dismiss, ms);
  };
  if (opts.action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = opts.action.label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
      opts.action.onClick();
    });
    el.appendChild(b);
  }
  el.addEventListener("click", () => dismiss());
  el.__dismiss = dismiss;
  el.__restart = restart;
  h.appendChild(el);
  restart();
  return { dismiss };
}

toast.ok = (message, opts = {}) => toast(message, { ...opts, kind: "ok" });
toast.error = (message, opts = {}) => toast(message, { ...opts, kind: "error" });
toast.info = (message, opts = {}) => toast(message, { ...opts, kind: "info" });

export default toast;
