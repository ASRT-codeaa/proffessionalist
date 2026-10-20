/* The Worker entry.  Everything above this line is the app; this file only does the two things a
   Worker has and an Express process does not: hand one Fetch request to the transcribed server.js
   (src/api.js) and give the rate limiter a place to count.

   It is deliberately thin.  The 500 answer below is the only original response in the file, and it
   exists because app.handle() rethrows whatever the error middleware could not answer
   (shims/express.js:355), which on the VPS would have been express's finalhandler — a text page no
   visitor ever sees, since nginx's proxy_intercept_errors turned it into the same JSON envelope.
   A runtime error page instead would be the one visible regression of the whole migration. */

import api from "./api.js";
import { handleCountMessage } from "./shims/limit.js";

/* server.js:173's envelope, character for character (measured live on api.proffessionalist.com:
   {"error":{"code":"api_error","message":"Something went wrong on our side. Please try again.","fields":{}}}) */
const API_ERROR_BODY = JSON.stringify({
  error: {
    code: "api_error",
    message: "Something went wrong on our side. Please try again.",
    fields: {},
  },
});

export default {
  async fetch(request, env, ctx) {
    try {
      return await api.handle(request, env, ctx);
    } catch (err) {
      /* the same line server.js:165 printed, so a `wrangler tail` shows what the VPS's journal
         showed; err carries no env values, and none are ever printed from here */
      console.error("API error:", err);
      return new Response(API_ERROR_BODY, {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};

/* -------------------------------------------------------------------------- *
 *  the counter
 * -------------------------------------------------------------------------- */

/**
 * Durable Object holding the three express-rate-limit buckets.
 *
 * shims/limit.js:64-75 is the only client: one POST to https://limit.internal/ with a JSON body
 * {op, key, windowMs} — `key` is already "<limit>-in-<windowMs>|<ip or u:sub>", which is how the
 * three limiters share a single instance without colliding — and it reads back
 * {totalHits, resetTime} (the answer handleCountMessage() produces from a Map of
 * key -> {hits, resetTime}).  Anything else this class receives is not the shim's wire format, so
 * it gets a non-2xx, and limit.js's own catch then lets the request through: a bookkeeping outage
 * must not become an error page, because the account lockout in routes/auth is the real brute-force
 * defence (server.js:87-91).
 *
 * No cron and no alarm: on the VPS the windows die by simply not being read again (MemoryStore),
 * so pruning on write is enough, and the doc's "no cron, no background writers" (§3, data volume)
 * means there is nothing else for a scheduled() handler to do.  wrangler.toml therefore declares no
 * [triggers].
 */
export class RateLimiter {
  constructor(state) {
    this.state = state;
    this.buckets = new Map();
    /* one read per instance, shared by every concurrent request that arrives before it lands */
    this.loading = null;
  }

  load() {
    if (!this.loading) {
      this.loading = this.state.storage
        .get("buckets")
        .then(saved => {
          /* a recycled or evicted instance must resume the windows that are already running: without
             this a visitor who hit the limit and waited one minute would be reset to zero the moment
             the DO went idle, which is exactly the "users notice nothing" failure */
          if (saved && typeof saved === "object") {
            for (const [key, value] of Object.entries(saved)) {
              if (value && Number.isFinite(value.hits) && Number.isFinite(value.resetTime)) {
                this.buckets.set(key, { hits: value.hits, resetTime: value.resetTime });
              }
            }
          }
        })
        .catch(err => {
          this.loading = null;
          throw err;
        });
    }
    return this.loading;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      await this.load();
      const info = handleCountMessage(this.buckets, await request.json());
      this.prune();
      /* storage.put() is what survives a recycle; the write happens after the answer is produced, so
         the visitor never waits for it, and each put is a whole-snapshot overwrite, which is the
         cheap consistent form for a map this small (one entry per active client per bucket) */
      const snapshot = Object.fromEntries(this.buckets);
      this.state.waitUntil(this.state.storage.put("buckets", snapshot));
      return new Response(JSON.stringify(info), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("RateLimiter:", err && err.message);
      return new Response("counter failed", { status: 500 });
    }
  }

  /* a window nobody has hit in windowMs is dead: MemoryStore kept its keys for the process's
     lifetime, but a long-lived DO would otherwise accumulate one row per visitor forever */
  prune() {
    const now = Date.now();
    if (this.buckets.size < 2000) return;
    for (const [key, value] of this.buckets) {
      if (value.resetTime <= now) this.buckets.delete(key);
    }
  }
}
