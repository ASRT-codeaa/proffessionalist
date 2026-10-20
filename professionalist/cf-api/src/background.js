/* Work the VPS did on its own schedule — sending mail after the answer was already returned —
   needs ctx.waitUntil in a Worker, or the isolate is frozen the moment the Response leaves and the
   message is never sent.  The modules that do that work cannot reach ctx themselves (routes call
   mailer.send() and never hear about it), so they register here and worker.js drains the queue with
   waitUntil after every answer.
   The queue is per-isolate, not per-request: an extra request keeping someone else's retry loop
   alive is harmless, whereas losing a password-reset email is not. */

const pending = new Set();

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
 * Resolve once nothing new has arrived for a tick.  mailer's retry loop schedules its next attempt
 * from a .then of the request we are tracking, so the queue only looks empty between attempts — the
 * extra tick is what distinguishes "quiet" from "finished".
 */
async function drain(maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!pending.size) {
      await sleep(0);
      if (!pending.size) return;
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

module.exports = { track, drain, waitUntilWork, size: () => pending.size };
