#!/usr/bin/env node
/**
 * Create R2 bucket (if needed) and upload card images.
 * Uses `node …/wrangler.js` — works when PowerShell blocks npx/npm scripts.
 */
const path = require("path");
const { spawn } = require("child_process");
const { runWrangler, BUCKET } = require("./upload-card-images-to-r2");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  try {
    await runWrangler(["r2", "bucket", "create", BUCKET], { stdio: "pipe" });
    // eslint-disable-next-line no-console
    console.log(`[r2] created bucket ${BUCKET}`);
  } catch (err) {
    const msg = String(err.message || err);
    if (/already exists|10004/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.log(`[r2] bucket ${BUCKET} already exists`);
    } else {
      throw err;
    }
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "upload-card-images-to-r2.js")], {
      cwd: ROOT,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`upload exited ${code}`));
    });
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
