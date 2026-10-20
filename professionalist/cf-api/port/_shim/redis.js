/* No ported route reads or writes redis (grep over the mirror: only server.js called
   connectRedis at boot, and redis.js itself); the cache layer is dead code in the Worker for now.
   createClient must still answer an object because redis.js:5-9 runs client.on("error") at module
   scope — an emitter that records nothing and a connect() that resolves immediately keep the
   require graph closed without opening a socket. */
function createClient() {
  const client = {
    isOpen: true,
    on() { return client; },
    once() { return client; },
    removeListener() { return client; },
    async connect() {},
    async quit() {},
    async disconnect() {},
  };
  return client;
}
module.exports = { createClient };
