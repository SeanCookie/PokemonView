const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "backend", "data", "set-card-lists.json");
const CARD_IMAGE_DIR = path.join(ROOT, "backend", "data", "card-images");
const MISSING = ["TK4R", "TK4G", "TK3M", "TK3L", "CRI"];

function getFileExtFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return ext;
  } catch {
    /* ignore */
  }
  return ".jpg";
}

async function downloadOne(code, cardNo, sourceUrl) {
  const ext = getFileExtFromUrl(sourceUrl);
  const filename = `${cardNo}${ext}`;
  const codeDir = path.join(CARD_IMAGE_DIR, code);
  const filePath = path.join(codeDir, filename);
  const localUrl = `/card-images/${encodeURIComponent(code)}/${encodeURIComponent(filename)}`;
  await fsp.mkdir(codeDir, { recursive: true });
  try {
    await fsp.access(filePath);
    return { ok: true, localUrl, skipped: true };
  } catch {
    /* download */
  }
  const response = await fetch(sourceUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  await fsp.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return { ok: true, localUrl, skipped: false };
}

async function main() {
  const prevRaw = execSync("git show HEAD:backend/data/set-card-lists.json", {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const prev = JSON.parse(prevRaw);
  const cur = JSON.parse(await fsp.readFile(DATA_FILE, "utf8"));
  let patched = 0;
  let failed = 0;

  for (const code of MISSING) {
    const prevEntry = prev.byCode?.[code];
    const curEntry = cur.byCode?.[code];
    if (!prevEntry || !curEntry) continue;
    const images = prevEntry.images && typeof prevEntry.images === "object" ? prevEntry.images : {};
    if (!curEntry.localImages || typeof curEntry.localImages !== "object") {
      curEntry.localImages = {};
    }
    for (const [cardNo, sourceUrl] of Object.entries(images)) {
      const result = await downloadOne(code, cardNo, String(sourceUrl));
      if (result.ok) {
        curEntry.localImages[cardNo] = result.localUrl;
        patched += 1;
      } else {
        failed += 1;
      }
    }
    delete curEntry.images;
  }

  cur.localImageSnapshot = {
    ...(cur.localImageSnapshot || {}),
    backfillMissingSetsAt: new Date().toISOString(),
    backfillSets: MISSING,
    backfillPatched: patched,
    backfillFailed: failed
  };
  await fsp.writeFile(DATA_FILE, `${JSON.stringify(cur, null, 2)}\n`);
  console.log(JSON.stringify({ patched, failed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
