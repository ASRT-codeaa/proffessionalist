const https = require("../_shim/https.js");

/* -------------------------------------------------------------------------- */
/*  Outbound email goes through the Cloudflare Worker at                     */
/*  email.proffessionalist.com. The API has no SMTP credentials and never     */
/*  renders a message: it names a template and passes the tokens the worker   */
/*  links to, so mail copy lives in one place.                                */
/* -------------------------------------------------------------------------- */

const RETRY_DELAYS = [0, 1500, 6000];
let warnedMissing = false;

function settings() {
  return {
    url: String(process.env.MAILER_API_URL || "").trim(),
    token: String(process.env.MAILER_API_TOKEN || "").trim(),
    timeout: Number(process.env.MAILER_TIMEOUT_MS || 8000),
    enabled: String(process.env.MAILER_ENABLED || "true").toLowerCase() !== "false",
  };
}

function mask(email) {
  const [local = "", domain = ""] = String(email).split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function post(cfg, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(cfg.url);
    } catch {
      reject(new Error("MAILER_API_URL is not a valid URL"));
      return;
    }

    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "POST",
        headers: Object.assign(
          {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${cfg.token}`,
          },
          extraHeaders || {}
        ),
        timeout: cfg.timeout,
      },
      res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      }
    );

    req.on("timeout", () => req.destroy(new Error("mailer request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Fire-and-forget. A mail failure is logged and dropped: signup, reset and
 * moderation actions must keep succeeding when the mail worker is unhappy.
 */
function send(template, { to, name, params, idempotencyKey }) {
  const cfg = settings();
  const recipient = String(to || "").trim();

  if (!recipient) return false;
  if (!cfg.enabled) return false;

  if (!cfg.url || !cfg.token) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[mailer] disabled: MAILER_API_URL and MAILER_API_TOKEN are not set");
    }
    return false;
  }

  const payload = {
    template: String(template),
    to: recipient,
    params: params && typeof params === "object" ? params : {},
  };
  if (name) payload.name = String(name).slice(0, 120);

  const key = idempotencyKey || `${template}:${recipient}:${Date.now()}`;
  const headers = { "X-Idempotency-Key": String(key).slice(0, 120) };

  (async () => {
    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt]) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
      try {
        const res = await post(cfg, payload, headers);
        if (res.status >= 200 && res.status < 300) {
          console.log(`[mailer] sent ${template} to ${mask(recipient)} (${res.status})`);
          return;
        }
        // 4xx is a contract problem, not a blip: retrying only delays the log line.
        console.error(
          `[mailer] rejected ${template} for ${mask(recipient)} (${res.status}) ${res.text.slice(0, 200)}`
        );
        if (res.status < 500) return;
      } catch (err) {
        console.error(`[mailer] attempt ${attempt + 1} for ${template}/${mask(recipient)} failed: ${err.message}`);
      }
    }
    console.error(`[mailer] gave up on ${template} for ${mask(recipient)}`);
  })().catch(err => console.error("[mailer] unexpected:", err.message));

  return true;
}

module.exports = { send, settings, mask };
