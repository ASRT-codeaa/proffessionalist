const { createClient } = require("./_shim/redis.js");

const client = createClient({
  url: process.env.REDIS_URL
});

client.on("error", err => {
  console.error("Redis error:", err.message);
});

async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
}

module.exports = { client, connectRedis };
