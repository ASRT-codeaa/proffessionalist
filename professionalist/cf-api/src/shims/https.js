/* The one thing services/mailer.js uses from node:https — an outgoing POST to the mail Worker —
   on fetch instead.  Workers have no sockets, and while wrangler's dev server happens to let
   require("node:https").get() through (measured: it returned example.com's 200 in `wrangler dev`),
   depending on an undocumented socket translation for the email a new user has to wait for is not a
   risk worth taking, and the production runtime is the one that has to work.
   It is deliberately shaped like the callback API mailer.js was written against — request(options,
   res => …), req.on("timeout"|"error"), req.end(body), req.destroy(error), res.setEncoding,
   res.on("data"|"end") — so services/mailer.js stays byte-for-byte the file running on the VPS and
   what is under test is its logic, not a rewrite of it. */
const background = require("../background.js");

/**
 * mailer.js reads res.statusCode, calls setEncoding("utf8") and collects data/end.  Buffering the
 * whole response and replaying those events keeps the contract without a stream, and a mail payload
 * is a few hundred bytes.
 */
class IncomingResponse {
  constructor(response) {
    this.statusCode = response.status;
    this.headers = response.headers;
    this._listeners = {};
  }

  setEncoding() { return this; }

  on(name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
    return this;
  }

  emit(name, ...args) {
    for (const fn of this._listeners[name] || []) fn(...args);
  }
}

class OutgoingRequest {
  constructor(options, onResponse) {
    this._listeners = {};
    this._controller = new AbortController();
    this._settled = false;
    if (onResponse) this.on("response", onResponse);

    const timeout = Number(options.timeout) || 0;
    this._timer = timeout ? setTimeout(() => this.emit("timeout"), timeout) : null;
    if (this._timer && this._timer.unref) this._timer.unref();

    this._send(options);
  }

  on(name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
    return this;
  }

  emit(name, ...args) {
    for (const fn of this._listeners[name] || []) fn(...args);
  }

  _fail(error) {
    if (this._settled) return;
    this._settled = true;
    if (this._timer) clearTimeout(this._timer);
    this.emit("error", error);
  }

  _send(options) {
    const url = targetOf(options);
    const headers = new Headers(options.headers || {});
    const method = String(options.method || "GET").toUpperCase();
    /* the promise is handed to background.track() by end(), so the mail Worker's slow replies do
       not get frozen out when the API has already answered the visitor */
    this._work = fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : this._body,
      signal: this._controller.signal,
    }).then(async response => {
      if (this._settled) return;
      this._settled = true;
      if (this._timer) clearTimeout(this._timer);
      const text = await response.text();
      const carrier = new IncomingResponse(response);
      this.emit("response", carrier);
      carrier.emit("data", text);
      carrier.emit("end");
    }, error => this._fail(error));
  }

  write(chunk) {
    this._body = (this._body || "") + String(chunk);
    return this;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    background.track(this._work);
    return this;
  }

  destroy(error) {
    this._controller.abort();
    this._fail(error || new Error("socket closed"));
    return this;
  }
}

function targetOf(options) {
  if (options.path !== undefined && (options.hostname || options.host)) {
    const host = options.hostname || String(options.host).split(":")[0];
    const secure = options.protocol ? /https/.test(options.protocol) : !options.port || Number(options.port) === 443;
    const port = options.port ? `:${options.port}` : "";
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    return `${secure ? "https" : "http"}://${host}${port}${path}`;
  }
  return String(options.url || options.href);
}

function request(options, onResponse) {
  return new OutgoingRequest(normalize(options), onResponse);
}

/** https.request accepts (url, options) as well as (options); mailer.js uses the second form. */
function normalize(options) {
  if (typeof options === "string" || options instanceof URL) {
    const url = new URL(String(options));
    return { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET" };
  }
  return options;
}

module.exports = { request, get: (options, onResponse) => request(options, onResponse).end() };
