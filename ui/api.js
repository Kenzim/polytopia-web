// JSON API client (CONTRACTS.md section 6). Every request sends `X-Poly: 1` (the server refuses mutating /api
// calls without it), parses the JSON reply and throws ApiError {status, message} for anything but 2xx.
// status 0 means the request never reached the server.

// Connection state for the banner (ui/app.js listens): "down" when a request never reached the server, "up" once
// any reply arrives.
const connection = (state) => window.dispatchEvent(new CustomEvent("poly:connection", { detail: state }));

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, isForm = false) {
  const headers = { "X-Poly": "1", Accept: "application/json" };
  const init = { method, headers, credentials: "same-origin" };
  if (body !== undefined) {
    if (isForm) {
      init.body = body; // the browser sets the multipart boundary
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  let resp;
  try {
    resp = await fetch(path, init);
  } catch (e) {
    connection("down");
    throw new ApiError(0, "No connection to the server. Check your network and try again.");
  }
  connection("up");
  const text = await resp.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }
  if (!resp.ok) {
    const message = (data && data.error) || resp.statusText || `Request failed (${resp.status})`;
    throw new ApiError(resp.status, message, data);
  }
  return data;
}

// Live updates from an SSE path (`/api/events`, `/api/games/<id>/events`). onEvent({id, kind, data}) is called
// for each event; kind "resync" means events were missed: refetch. The browser reconnects by itself and
// resumes after the last event; when the page comes back to the foreground with the stream closed, it is
// reopened from the last id. opts.onStatus("open" | "down") drives a connection banner.
// Returns {close()}.
function events(path, onEvent, opts = {}) {
  let source = null;
  let lastId = null;
  let closed = false;

  const status = (s) => {
    connection(s === "open" ? "up" : "down");
    if (opts.onStatus) opts.onStatus(s);
  };

  function open() {
    if (closed) return;
    let url = path;
    if (lastId !== null) url += (url.includes("?") ? "&" : "?") + "last_event_id=" + encodeURIComponent(lastId);
    source = new EventSource(url);
    source.onopen = () => status("open");
    source.onerror = () => {
      status("down");
      if (source.readyState === EventSource.CLOSED) {
        // the browser gave up (e.g. a 401 or the server went away): try again in a while
        setTimeout(() => {
          if (!closed && source.readyState === EventSource.CLOSED) open();
        }, 5000);
      }
    };
    source.onmessage = (ev) => {
      if (ev.lastEventId) lastId = ev.lastEventId;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.kind === "reconnect") {
        // the server ends each stream after a while: reopen from the last id without showing the banner
        source.close();
        open();
        return;
      }
      onEvent({ id: ev.lastEventId, kind: msg.kind, data: msg.data });
    };
  }

  function onVisible() {
    if (document.visibilityState === "visible" && source && source.readyState === EventSource.CLOSED) open();
  }

  document.addEventListener("visibilitychange", onVisible);
  open();
  return {
    close() {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (source) source.close();
    },
  };
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
  put: (path, body = {}) => request("PUT", path, body),
  del: (path) => request("DELETE", path),
  upload: (path, formData) => request("POST", path, formData, true),
  events,
};

export default api;
