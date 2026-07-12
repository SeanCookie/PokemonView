/**
 * Remove card image trees before Docker build (Cloudflare Git LFS checkout).
 * Shared by cf-build.js and deploy:cloudflare.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PRUNE_DIRS = [
  path.join(ROOT, "backend", "data", "card-images"),
  path.join(ROOT, "backend", "data", "card-images-japanese")
];

function pruneCardImagesForDocker() {
  for (const dir of PRUNE_DIRS) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        // eslint-disable-next-line no-console
        console.log(`[prune] removed ${path.relative(ROOT, dir)}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[prune] could not remove ${dir}: ${err.message}`);
    }
  }
}

if (require.main === module) {
  pruneCardImagesForDocker();
}

module.exports = { pruneCardImagesForDocker };
