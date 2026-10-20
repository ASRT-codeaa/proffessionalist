const express = require("../_shim/express.js");
const { query } = require("../db");

const router = express.Router();

const COUNTRIES = [
  "Nigeria", "Ghana", "Kenya", "South Africa", "United Kingdom", "United States", "Zimbabwe",
  "Canada", "Germany", "France", "Netherlands", "India", "Philippines", "Brazil", "Australia", "UAE", "Rwanda",
];

const PROFESSIONAL_CATEGORIES = [
  "Software & Technology", "Design & Creative", "Business & Finance", "Marketing & Media",
  "Healthcare", "Engineering", "Education & Training", "Construction & Trades",
  "Agriculture", "Transport & Logistics", "Real Estate", "Legal", "Retail & E-commerce", "Consulting",
];

router.get("/countries", (req, res) => res.json(COUNTRIES));
router.get("/categories", (req, res) => res.json(PROFESSIONAL_CATEGORIES));
router.get("/trends", (req, res) => res.json([]));

/* Server-owned copy: maintained through the admin ops API instead of a shell
 * session. Answers with defaults when nothing is stored (or the table is not
 * there yet) so a client can always read the same shape. */
const CONTENT_KEYS = ["maintenance", "announcement", "landing"];
const CONTENT_DEFAULTS = { maintenance: { enabled: false }, announcement: null, landing: null };

router.get("/content", async (req, res) => {
  try {
    const result = await query(`SELECT key, value FROM app_content WHERE key = ANY($1::text[])`, [CONTENT_KEYS]);
    res.json(Object.assign({}, CONTENT_DEFAULTS, Object.fromEntries(result.rows.map(r => [r.key, r.value]))));
  } catch (error) {
    console.error("Content lookup error:", error.message);
    res.json(CONTENT_DEFAULTS);
  }
});

module.exports = router;
