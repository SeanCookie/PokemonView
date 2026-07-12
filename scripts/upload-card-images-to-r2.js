#!/usr/bin/env node
/**
 * One-time (or incremental) upload of backend/data/card-images → R2.
 * Requires: npx wrangler login (or CLOUDFLARE_API_TOKEN with R2 edit).
 *
 *   npm run upload:card-images
 *   npm run upload:card-images -- --dry-run
 *   npm run upload:card-images -- --set SV1
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CARD_DIR = path.join(ROOT, "backend", "data", "card-images");
const BUCKET = process.env.CARD_IMAGES_R2_BUCKET || "pokemonview-card-images";
const CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY) || 8);

function wranglerJsPath() {
  const bin = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(bin)) {
    throw new Error("wrangler not installed — run: npm install");
  }
  return bin;
}

function runWrangler(args, { stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerJsPath(), ...args], {
      cwd: ROOT,
      stdio
    });
    let stderr = "";
    if (stdio === "pipe" || (Array.isArray(stdio) && stdio.includes("pipe"))) {
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `wrangler ${args.join(" ")} exited ${code}`));
    });
  });
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const setFilter = (() => {
  const i = args.indexOf("--set");
  return i >= 0 ? String(args[i + 1] || "").trim().toUpperCase() : "";
})();

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif"
  };
  return map[ext] || "application/octet-stream";
}

async function walkImages(dir, rel = "") {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (setFilter && rel === "" && entry.name.toUpperCase() !== setFilter) continue;
      out.push(...(await walkImages(abs, relPath)));
    } else if (/\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name)) {
      if (setFilter && rel === "" && entry.name.toUpperCase() !== setFilter) continue;
      if (setFilter && rel && !relPath.toUpperCase().startsWith(`${setFilter}/`)) continue;
      out.push({ key: relPath.replace(/\\/g, "/"), abs });
    }
  }
  return out;
}

function putObject(key, filePath) {
  return new Promise((resolve, reject) => {
    const objectPath = `${BUCKET}/${key}`;
    const child = spawn(
      process.execPath,
      [
        wranglerJsPath(),
        "r2",
        "object",
        "put",
        objectPath,
        "--file",
        filePath,
        "--content-type",
        contentType(filePath),
        "--remote"
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `wrangler exited ${code} for ${objectPath}`));
    });
  });
}

async function runPool(items, worker, limit) {
  let index = 0;
  let ok = 0;
  let failed = 0;
  async function runWorker() {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) break;
      const item = items[i];
      try {
        await worker(item);
        ok += 1;
        if (ok % 250 === 0) {
          // eslint-disable-next-line no-console
          console.log(`uploaded ${ok}/${items.length}…`);
        }
      } catch (err) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn(`failed ${item.key}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return { ok, failed };
}

async function main() {
  if (!fs.existsSync(CARD_DIR)) {
    throw new Error(`Missing ${CARD_DIR} — run git lfs pull first.`);
  }

  const files = await walkImages(CARD_DIR);
  // eslint-disable-next-line no-console
  console.log(`found ${files.length} files → r2://${BUCKET}/`);
  if (dryRun) return;

  const { ok, failed } = await runPool(files, (f) => putObject(f.key, f.abs), CONCURRENCY);
  // eslint-disable-next-line no-console
  console.log(`done uploaded=${ok} failed=${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

module.exports = { runWrangler, wranglerJsPath, BUCKET, CARD_DIR };
