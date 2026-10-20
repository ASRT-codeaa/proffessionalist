/* middleware/upload.js on the VPS is multer diskStorage over ./uploads; src/shims/upload.js is
   the R2-backed replacement and keeps the exact export surface the six route files read —
   {UPLOAD_ROOT, uploadImage, uploadFiles, publicUrl, mediaType, removeStored} (mirror
   middleware/upload.js:111-118 vs shim line 366-377, which also adds init/serveUpload/keyFromPath
   for the Worker entry).  UPLOAD_ROOT differs by design: "/uploads" URL prefix in the shim vs an
   on-disk path in the mirror; both publicUrl() outputs are "/uploads/<kind>/<name>", which is what
   routes and the DB actually store. */
module.exports = require("../../src/shims/upload.js");
