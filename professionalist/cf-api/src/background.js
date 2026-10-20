/* Work the VPS did on its own schedule — sending mail after the answer was already returned —
   needs ctx.waitUntil in a Worker, or the isolate is frozen the moment the Response leaves and the
   message is never sent.  The modules that do that work cannot reach ctx themselves (routes call
   mailer.send() and never hear about it), so they register here and worker.js drains the queue with
   waitUntil after every answer.
   The queue is per-isolate, not per-request: an extra request keeping someone else's retry loop
   alive is harmless, whereas losing a password-reset email is not. */

const pending = new Set();

/* services/mailer.js retries with RETRY_DELAYS [0, 1500, 6000] — the sleeps between attempts
   happen in its own loop, OUTSIDE anything track() can see, so the queue looks finished while
   the next attempt is merely sleeping.  The https shim knows when an attempt ended in a
   retryable state (5xx or transport error — mailer.js:112 returns without retry on 4xx), and
   arms this window so drain() stays awake across the largest gap.
   7700 covers the worst case that one arming must bridge: from a 5xx answered at t≈0 the third
   attempt fires at 1500 + 6000 = 7500 (mailer.js:98-100), and each further retryable outcome
   re-arms.  Anything past RETRY_DELAYS's tail would only idle the isolate. */
const RETRY_ARM_MS = 7700;
let windowUntil = 0;

/** Keep drain() awake for another windowMs of possible retry activity. */
function armRetryWindow(windowMs = RETRY_ARM_MS) {
  windowUntil = Math.max(windowUntil, Date.now() + Math.min(windowMs, RETRY_ARM_MS));
}

/** Track a promise so the Worker stays awake for it. Returns the same promise. */
function track(promise) {
  const tracked = Promise.resolve(promise)
    .catch(() => { /* the caller logs its own failures; the queue must never reject */ })
    .finally(() => pending.delete(tracked));
  pending.add(tracked);
  return promise;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Resolve once the queue is empty AND no retryable attempt is arming a window.  The extra tick
 * still distinguishes "quiet" from "finished" for the between-attempt .then scheduling; the armed
 * window covers the 1500/6000 ms sleeps mailer.js takes between attempts, which no tracked
 * promise spans.
 */
async function drain(maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!pending.size) {
      await sleep(0);
      if (!pending.size && Date.now() >= windowUntil) return;
      const remaining = Math.min(windowUntil - Date.now(), deadline - Date.now());
      if (remaining > 0) await sleep(remaining);
      continue;
    }
    await Promise.race([...pending]);
  }
  console.warn(`background: gave up waiting on ${pending.size} task(s) after ${maxMs}ms`);
}

/** what worker.js hands to ctx.waitUntil */
function waitUntilWork(ctx) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(drain());
}

module.exports = { track, drain, waitUntilWork, armRetryWindow, size: () => pending.size };
