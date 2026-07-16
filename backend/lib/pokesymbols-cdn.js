const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { isLfsPointer } = require("./github-lfs-materialize");

const POKESYMBOLS_SETS_CDN_ORIGIN = "https://pokesymbols.com/images/tcg/sets";
const POKESYMBOLS_TCG_CDN_ORIGIN = "https://pokesymbols.com/images/tcg";

const CDN_PATH_ALIASES = {
  "symbols/fire-red-and-leafgreen.png": "symbols/firered-leafgreen.png",
  "logos/fire-red-and-leafgreen.png": "logos/firered-leafgreen.png",
  "symbols/expedition-base-set.png": "symbols/expedition.png",
  "logos/expedition-base-set.png": "logos/expedition.png",
  "symbols/heart-gold-and-soul-silver.png": "symbols/heartgold-soulsilver.png",
  "logos/heart-gold-and-soul-silver.png": "logos/heartgold-soulsilver.png"
};

function resolveCdnRelativePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return "";
  if (CDN_PATH_ALIASES[normalized]) return CDN_PATH_ALIASES[normalized];
  if (/-black-star-promos\.png$/i.test(normalized)) {
    return normalized.replace(/[^/]+\.png$/i, "_promo.png");
  }
  return normalized;
}

function pokesymbolsCdnBaseForRelative(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.startsWith("rarities/")) return POKESYMBOLS_TCG_CDN_ORIGIN;
  return POKESYMBOLS_SETS_CDN_ORIGIN;
}

function pokesymbolsCdnUrl(relativePath) {
  const normalized = resolveCdnRelativePath(relativePath);
  if (!normalized) return "";
  return `${pokesymbolsCdnBaseForRelative(normalized)}/${normalized}`;
}

async function fetchPokesymbolBytes(relativePath, { cachePath = "" } = {}) {
  const candidates = [];
  const primary = resolveCdnRelativePath(relativePath);
  if (primary) candidates.push(primary);
  const raw = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (raw && raw !== primary && !raw.includes("..")) candidates.push(raw);

  let lastError = null;
  for (const rel of candidates) {
    const remoteUrl = `${pokesymbolsCdnBaseForRelative(rel)}/${rel}`;
    try {
      const res = await fetch(remoteUrl);
      if (!res.ok) {
        lastError = new Error(`pokesymbols CDN request failed (${res.status})`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (cachePath) {
        try {
          await fsp.mkdir(path.dirname(cachePath), { recursive: true });
          const tmpPath = `${cachePath}.cdn-download`;
          await fsp.writeFile(tmpPath, bytes);
          await fsp.rename(tmpPath, cachePath);
        } catch {
          /* serve without caching */
        }
      }
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Invalid pokesymbols path");
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.push({ abs, rel: rel.replace(/\\/g, "/") });
      }
    }
  }
  await walk(rootDir, "");
  return out;
}

async function hydratePokesymbolsFromCdnIfNeeded(rootDir, options = {}) {
  if (!fs.existsSync(rootDir)) {
    return { scanned: 0, hydrated: 0, skipped: 0 };
  }

  const batchSize = Number.isFinite(options.batchSize) ? options.batchSize : 20;
  const label = options.label || "pokesymbols";
  const files = await listFilesRecursive(rootDir);
  const missing = [];

  for (const file of files) {
    try {
      const head = Buffer.alloc(80);
      const fd = await fsp.open(file.abs, "r");
      try {
        await fd.read(head, 0, 80, 0);
      } finally {
        await fd.close();
      }
      if (isLfsPointer(head)) missing.push(file);
    } catch {
      /* skip unreadable */
    }
  }

  if (!missing.length) {
    return { scanned: files.length, hydrated: 0, skipped: files.length };
  }

  console.log(`[pokesymbols] ${label}: hydrating ${missing.length} file(s) from pokesymbols.com...`);
  let hydrated = 0;

  for (let i = 0; i < missing.length; i += batchSize) {
    const chunk = missing.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async (file) => {
        try {
          await fetchPokesymbolBytes(file.rel, { cachePath: file.abs });
          hydrated += 1;
        } catch (err) {
          console.warn(`[pokesymbols] Failed to hydrate ${file.rel}: ${err.message}`);
        }
      })
    );
    if (i + batchSize < missing.length) {
      console.log(`[pokesymbols] ${label}: ${Math.min(i + batchSize, missing.length)}/${missing.length}`);
    }
  }

  console.log(`[pokesymbols] ${label}: hydrated ${hydrated} file(s)`);
  return { scanned: files.length, hydrated, skipped: files.length - hydrated };
}

module.exports = {
  pokesymbolsCdnUrl,
  resolveCdnRelativePath,
  fetchPokesymbolBytes,
  hydratePokesymbolsFromCdnIfNeeded
};
