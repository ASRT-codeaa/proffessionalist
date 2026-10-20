const express = require("../../_shim/express.js");

/**
 * The SPA-facing surface. Mounted ahead of routes/platform.js so the paths the
 * client actually calls resolve here instead of being swallowed by platform's
 * resource-id routes.
 */
const router = express.Router();

// /network/suggestions is the single route the deployed network router does
// better than anything here, so it keeps its place inside this surface.
router.use("/network", require("../network"));

router.use(require("./feed"));
router.use(require("./social"));

// Marketplace, messaging/tasks/settings and the operator surface. Their paths
// are all two segments or deeper, so none of them shadows a route above or the
// legacy platform router below.
router.use(require("./market"));
router.use(require("./chat"));
router.use("/admin/ops", require("./ops"));

module.exports = router;
