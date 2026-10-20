const { query } = require("../db");

async function securityEvent({
  userId = null,
  eventType,
  ip = null,
  userAgent = null,
  details = {}
}) {
  try {
    await query(
      `INSERT INTO security_events
       (user_id,event_type,ip_address,user_agent,details)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        userId,
        eventType,
        ip,
        userAgent,
        JSON.stringify(details)
      ]
    );
  } catch (err) {
    console.error("Security event logging failed:", err.message);
  }
}

async function audit({
  actorId = null,
  action,
  targetUserId = null,
  ip = null,
  details = {}
}) {
  try {
    // actor_user_id, not actor_id — the old name threw on every write.
    // audit_logs has no ip_address column, so the value is kept in details.
    await query(
      `INSERT INTO audit_logs
       (actor_user_id,action,target_user_id,details)
       VALUES ($1,$2,$3,$4)`,
      [
        actorId,
        action,
        targetUserId,
        JSON.stringify(ip ? Object.assign({ ip }, details) : details)
      ]
    );
  } catch (err) {
    console.error("Audit logging failed:", err.message);
  }
}

module.exports = { securityEvent, audit };
