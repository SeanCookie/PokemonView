const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://pokesymbols.com/tcg/booster-pack-art";
const CDN_ORIGIN = "https://pokesymbols.com";
const USER_AGENT =
  "PokemonView-BoosterPackArtSync/1.0 (+https://pokesymbols.com/tcg/booster-pack-art)";

/** Booster-pack page slugs → pokesymbols set-art slugs (when they differ). */
const SLUG_ALIASES = {
  "base-set": "base",
  "x-and-y": "xy",
  triumphant: "hs-triumphant",
  undaunted: "hs-undaunted",
  unleashed: "hs-unleashed",
  "heartgold-and-soulsilver": "heart-gold-and-soul-silver",
  "ex-power-keepers": "power-keepers",
  "ex-dragon-frontiers": "dragon-frontiers",
  "ex-crystal-guardians": "crystal-guardians",
  "ex-holon-phantoms": "holon-phantoms",
  "ex-legend-maker": "legend-maker",
  "ex-delta-species": "delta-species",
  "ex-unseen-forces": "unseen-forces",
  "ex-emerald": "emerald",
  "ex-deoxys": "deoxys",
  "ex-team-rocket-returns": "team-rocket-returns",
  "ex-fire-red-and-leaf-green": "fire-red-and-leaf-green",
  "ex-hidden-legends": "hidden-legends",
  "ex-magma-vs-aqua": "team-magma-vs-team-aqua",
  "ex-dragon": "dragon",
  "ex-sandstorm": "sandstorm",
  "ex-ruby-and-sapphire": "ruby-and-sapphire",
  expedition: "expedition-base-set"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtmlToTextChunks(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractPackImages(html) {
  const rows = [];
  const seen = new Set();
  const re =
    /\/images\/tcg\/sets\/booster-pack-art\/([a-z0-9-]+)-pack-(\d+)\.(png|jpg|jpeg|webp)/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const slug = m[1];
    const packIndex = Number(m[2]);
    const ext = String(m[3] || "png").toLowerCase();
    const remotePath = m[0];
    const key = `${slug}|${packIndex}|${ext}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ slug, packIndex, ext, remotePath });
  }
  return rows;
}

function extractFeaturedEntries(html) {
  const chunks = stripHtmlToTextChunks(html);
  const featured = [];
  for (let i = 0; i < chunks.length - 2; i += 1) {
    if (chunks[i] !== "View Set Symbol") continue;
    const setName = chunks[i + 1];
    const featuredName = chunks[i + 2];
    const releasedLine = chunks[i + 3] || "";
    if (!setName || !featuredName || !/^Released:/i.test(releasedLine)) continue;
    featured.push({
      setName,
      featured: featuredName,
      released: releasedLine.replace(/^Released:\s*/i, "").trim()
    });
  }
  return featured;
}

function resolveSymbolSlug(packSlug, symbolsBySlug = {}) {
  const slug = String(packSlug || "").trim().toLowerCase();
  if (!slug) return "";
  if (symbolsBySlug[slug]) return slug;
  if (SLUG_ALIASES[slug] && symbolsBySlug[SLUG_ALIASES[slug]]) return SLUG_ALIASES[slug];
  if (SLUG_ALIASES[slug]) return SLUG_ALIASES[slug];
  if (slug.startsWith("ex-")) {
    const stripped = slug.slice(3);
    if (symbolsBySlug[stripped]) return stripped;
  }
  if (slug.endsWith("-set") && symbolsBySlug[slug.slice(0, -4)]) return slug.slice(0, -4);
  return slug;
}

async function fetchText(url, { retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

async function downloadBinary(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "image/*" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.download`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, destPath);
  return bytes.length;
}

function loadSymbolsManifest(rootDir) {
  const manifestPath = path.join(rootDir, "manifest.json");
  try {
    if (!fs.existsSync(manifestPath)) return { bySlug: {}, byCode: {} };
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      bySlug: parsed.bySlug && typeof parsed.bySlug === "object" ? parsed.bySlug : {},
      byCode: parsed.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {}
    };
  } catch {
    return { bySlug: {}, byCode: {} };
  }
}

function buildFeaturedBySlug(images, featuredEntries, symbolsBySlug) {
  const bySlugFeatured = {};
  const featuredBySetName = new Map();
  for (const entry of featuredEntries) {
    const key = String(entry.setName || "").trim().toLowerCase();
    if (!featuredBySetName.has(key)) featuredBySetName.set(key, []);
    featuredBySetName.get(key).push(entry);
  }

  const imagesBySlug = new Map();
  for (const img of images) {
    if (!imagesBySlug.has(img.slug)) imagesBySlug.set(img.slug, []);
    imagesBySlug.get(img.slug).push(img);
  }

  for (const [slug, packImages] of imagesBySlug.entries()) {
    const symbolSlug = resolveSymbolSlug(slug, symbolsBySlug);
    const symbolRow = symbolsBySlug[symbolSlug] || symbolsBySlug[slug] || null;
    const setName = String((symbolRow && symbolRow.name) || slug)
      .trim()
      .toLowerCase();
    let list = featuredBySetName.get(setName) || null;
    if (!list) {
      for (const [nameKey, entries] of featuredBySetName.entries()) {
        if (entries.length === packImages.length && nameKey.includes(slug.split("-")[0])) {
          list = entries;
          break;
        }
      }
    }
    // Keep document order — packIndex is not always sequential on the source page.
    bySlugFeatured[slug] = packImages.map((img, idx) => {
      const feat = list && list[idx] ? list[idx] : null;
      return {
        packIndex: img.packIndex,
        featured: feat ? feat.featured : "",
        released: feat ? feat.released : ""
      };
    });
  }
  return bySlugFeatured;
}

async function syncBoosterPackArt({
  rootDir,
  concurrency = 8,
  delayMs = 40,
  skipExisting = true,
  onProgress = null
} = {}) {
  const artDir = path.join(rootDir, "booster-pack-art");
  await fsp.mkdir(artDir, { recursive: true });

  const symbols = loadSymbolsManifest(rootDir);
  const indexHtml = await fetchText(SOURCE_URL);
  const images = extractPackImages(indexHtml);
  const featuredEntries = extractFeaturedEntries(indexHtml);
  const featuredBySlug = buildFeaturedBySlug(images, featuredEntries, symbols.bySlug);

  const failed = [];
  let downloaded = 0;
  let skipped = 0;
  const okImages = [];

  async function processImage(img) {
    const fileName = `${img.slug}-pack-${img.packIndex}.${img.ext}`;
    const destPath = path.join(artDir, fileName);
    const localUrl = `/pokesymbols/booster-pack-art/${fileName}`;
    try {
      if (skipExisting && fs.existsSync(destPath)) {
        skipped += 1;
      } else {
        await downloadBinary(`${CDN_ORIGIN}${img.remotePath}`, destPath);
        downloaded += 1;
      }
      okImages.push({ ...img, fileName, localUrl });
      if (onProgress) onProgress({ fileName, ok: true });
    } catch (err) {
      failed.push({ slug: img.slug, packIndex: img.packIndex, error: err.message || String(err) });
      if (onProgress) {
        onProgress({ fileName, ok: false, error: err.message });
      }
    }
  }

  for (let i = 0; i < images.length; i += concurrency) {
    const chunk = images.slice(i, i + concurrency);
    await Promise.all(chunk.map((img) => processImage(img)));
    if (delayMs > 0 && i + concurrency < images.length) await sleep(delayMs);
    if (onProgress) {
      onProgress({
        phase: "batch",
        done: Math.min(i + concurrency, images.length),
        total: images.length
      });
    }
  }

  const bySlug = {};
  for (const img of okImages) {
    const symbolSlug = resolveSymbolSlug(img.slug, symbols.bySlug);
    const symbolRow = symbols.bySlug[symbolSlug] || symbols.bySlug[img.slug] || null;
    const code = String((symbolRow && symbolRow.code) || "").trim().toUpperCase();
    const name = String((symbolRow && symbolRow.name) || img.slug).trim();
    const featMeta =
      (featuredBySlug[img.slug] || []).find((row) => row.packIndex === img.packIndex) || null;

    if (!bySlug[img.slug]) {
      bySlug[img.slug] = {
        name,
        code: code || "N/A",
        symbolSlug: symbolSlug || img.slug,
        packs: []
      };
    }
    bySlug[img.slug].packs.push({
      packIndex: img.packIndex,
      featured: featMeta ? featMeta.featured : "",
      released: featMeta ? featMeta.released : "",
      image: img.localUrl,
      fileName: img.fileName
    });
  }

  const byCode = {};
  for (const [slug, row] of Object.entries(bySlug)) {
    row.packs.sort((a, b) => a.packIndex - b.packIndex);
    const code = String(row.code || "").trim().toUpperCase();
    if (!code || code === "N/A") continue;
    byCode[code] = {
      slug,
      symbolSlug: row.symbolSlug,
      name: row.name,
      packs: row.packs
    };
  }

  const manifest = {
    source: SOURCE_URL,
    credit: "https://pokesymbols.com — Pokemon Booster Pack Art",
    generatedAt: new Date().toISOString(),
    packsDownloaded: downloaded,
    packsSkipped: skipped,
    packsFailed: failed.length,
    setCount: Object.keys(bySlug).length,
    bySlug,
    byCode,
    failed
  };

  const manifestPath = path.join(rootDir, "booster-pack-art-manifest.json");
  const tmpManifest = `${manifestPath}.tmp`;
  await fsp.writeFile(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.rename(tmpManifest, manifestPath);

  return {
    imageCount: images.length,
    downloaded,
    skipped,
    bySlugCount: Object.keys(bySlug).length,
    byCodeCount: Object.keys(byCode).length,
    failed
  };
}

module.exports = {
  SOURCE_URL,
  SLUG_ALIASES,
  extractPackImages,
  extractFeaturedEntries,
  resolveSymbolSlug,
  syncBoosterPackArt
};
