// Confirm, alert and prompt as bottom sheets (CONTRACTS.md section 7: actions that cannot be undone ask in a
// bottom sheet, with the confirm button in thumb reach). Each returns a promise.
//
//   if (await confirm({ title: "End turn?", message: "2 units can still move.", confirmLabel: "End turn" })) ...
//   if (await confirm({ title: "Resign?", confirmLabel: "Resign", danger: true })) ...
//   await alert({ title: "Saved", message: "..." });
//   const name = await prompt({ title: "Name this map", label: "Name", value: "My map" });   // string, or null
//
// Closing the sheet any other way (scrim tap, Escape, drag down) counts as Cancel: false / null.

import { openSheet } from "ui/sheet.js";

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function ask({ title, message, build, cancelLabel, confirmLabel, danger, hideCancel, value }) {
  return new Promise((resolve) => {
    let result = value;
    const content = document.createElement("div");
    content.className = "stack";
    if (message) {
      const p = document.createElement("p");
      p.className = "dialog-message";
      p.textContent = message;
      content.appendChild(p);
    }
    let read = null;
    if (build) read = build(content, () => ok.click());
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const sheet = openSheet({
      title, content, states: ["auto"], state: "auto", modal: true,
      onClose: () => resolve(result),
    });
    const cancel = button(cancelLabel, "", () => { result = value; sheet.close(); });
    const ok = button(confirmLabel, danger ? "danger" : "primary", () => {
      result = read ? read() : true;
      sheet.close();
    });
    if (!hideCancel) actions.appendChild(cancel);
    actions.appendChild(ok);
    content.appendChild(actions);
    sheet.setContent(content); // measured again with the buttons in
    const first = content.querySelector("input, textarea");
    if (first) first.focus({ preventScroll: true });
  });
}

export function confirm({ title = "Are you sure?", message = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return ask({ title, message, confirmLabel, cancelLabel, danger, value: false });
}

export function alert({ title = "", message = "", okLabel = "OK" } = {}) {
  return ask({ title, message, confirmLabel: okLabel, cancelLabel: "", hideCancel: true, value: undefined }).then(() => undefined);
}

export function prompt({ title = "", message = "", label = "", value = "", placeholder = "", confirmLabel = "OK", cancelLabel = "Cancel", maxLength, type = "text" } = {}) {
  return ask({
    title, message, confirmLabel, cancelLabel, value: null,
    build(content, submit) {
      const field = document.createElement("div");
      field.className = "field";
      const input = document.createElement("input");
      input.type = type;
      input.value = value;
      input.placeholder = placeholder;
      if (maxLength) input.maxLength = maxLength;
      input.autocomplete = "off";
      if (label) {
        const l = document.createElement("label");
        l.textContent = label;
        const id = `prompt-${Math.random().toString(36).slice(2)}`;
        l.htmlFor = input.id = id;
        field.appendChild(l);
      }
      field.appendChild(input);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      content.appendChild(field);
      return () => input.value;
    },
  });
}

export default { confirm, alert, prompt };
