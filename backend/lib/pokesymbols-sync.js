const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://pokesymbols.com/tcg/sets";
const CDN_ORIGIN = "https://pokesymbols.com";
const USER_AGENT =
  "PokemonView-PokesymbolsSync/1.0 (+https://pokesymbols.com/tcg/sets)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSetSlugs(indexHtml) {
  return [
    ...new Set([...String(indexHtml).matchAll(/href="\/tcg\/sets\/([a-z0-9-]+)"/gi)].map((m) => m[1]))
  ];
}

function extractSetPageData(html, slug) {
  const text = String(html || "");
  const paths = [
    ...new Set([...text.matchAll(/\/images\/tcg\/sets\/(?:symbols|logos)\/[a-z0-9_.-]+\.png/gi)].map((m) => m[0]))
  ];
  let symbolPath = paths.find((p) => p.includes("/symbols/")) || "";
  let logoPath = paths.find((p) => p.includes("/logos/")) || "";
  if (!symbolPath && logoPath) symbolPath = logoPath;
  if (!logoPath && symbolPath) logoPath = symbolPath;
  if (!symbolPath) {
    symbolPath = `/images/tcg/sets/symbols/${slug}.png`;
  }
  if (!logoPath) {
    logoPath = `/images/tcg/sets/logos/${slug}.png`;
  }

  const codeMatch = text.match(/Trading Card Game Online Code:<\/strong>[^<]*<!-- -->([^<]+)/i);
  const code = codeMatch ? String(codeMatch[1]).trim().toUpperCase() : "";

  const nameMatch = text.match(/<title>([^<|]+)/i);
  const name = nameMatch ? String(nameMatch[1]).replace(/\s+Symbol\s*$/i, "").trim() : slug;

  return { slug, name, code, symbolPath, logoPath };
}

async function fetchText(url, { retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
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
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.download`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, destPath);
  return bytes.length;
}

function localUrl(kind, fileName) {
  return `/pokesymbols/${kind}/${fileName}`;
}

async function syncPokesymbolsSetArt({
  rootDir,
  concurrency = 8,
  delayMs = 40,
  onProgress = null
} = {}) {
  const symbolsDir = path.join(rootDir, "symbols");
  const logosDir = path.join(rootDir, "logos");
  await fsp.mkdir(symbolsDir, { recursive: true });
  await fsp.mkdir(logosDir, { recursive: true });

  const indexHtml = await fetchText(SOURCE_URL);
  const slugs = extractSetSlugs(indexHtml);
  const bySlug = {};
  const byCode = {};
  const failed = [];
  let downloaded = 0;

  async function processSlug(slug) {
    try {
      const pageHtml = await fetchText(`${CDN_ORIGIN}/tcg/sets/${encodeURIComponent(slug)}`);
      const meta = extractSetPageData(pageHtml, slug);
      const symbolFile = `${slug}.png`;
      const logoFile = `${slug}.png`;
      const symbolDest = path.join(symbolsDir, symbolFile);
      const logoDest = path.join(logosDir, logoFile);

      await downloadBinary(`${CDN_ORIGIN}${meta.symbolPath}`, symbolDest);
      downloaded += 1;
      try {
        await downloadBinary(`${CDN_ORIGIN}${meta.logoPath}`, logoDest);
        downloaded += 1;
      } catch {
        if (meta.logoPath !== meta.symbolPath) {
          await fsp.copyFile(symbolDest, logoDest);
          downloaded += 1;
        }
      }

      const row = {
        name: meta.name,
        code: meta.code || "N/A",
        symbol: localUrl("symbols", symbolFile),
        logo: localUrl("logos", logoFile)
      };
      bySlug[slug] = row;
      if (meta.code && meta.code !== "N/A") {
        byCode[meta.code] = { slug, symbol: row.symbol, logo: row.logo };
      }
      if (onProgress) onProgress({ slug, ok: true });
    } catch (err) {
      failed.push({ slug, error: err.message || String(err) });
      if (onProgress) onProgress({ slug, ok: false, error: err.message });
    }
  }

  for (let i = 0; i < slugs.length; i += concurrency) {
    const chunk = slugs.slice(i, i + concurrency);
    await Promise.all(chunk.map((slug) => processSlug(slug)));
    if (delayMs > 0 && i + concurrency < slugs.length) await sleep(delayMs);
    if (onProgress) {
      onProgress({
        phase: "batch",
        done: Math.min(i + concurrency, slugs.length),
        total: slugs.length
      });
    }
  }

  const manifest = {
    source: SOURCE_URL,
    credit: "https://pokesymbols.com — Pokemon Set Symbols",
    generatedAt: new Date().toISOString(),
    setsDownloaded: Object.keys(bySlug).length,
    setsFailed: failed.length,
    bySlug,
    byCode,
    failed
  };

  const manifestPath = path.join(rootDir, "manifest.json");
  const tmpManifest = `${manifestPath}.tmp`;
  await fsp.writeFile(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.rename(tmpManifest, manifestPath);

  return {
    slugs: slugs.length,
    downloaded,
    bySlugCount: Object.keys(bySlug).length,
    byCodeCount: Object.keys(byCode).length,
    failed
  };
}

module.exports = {
  SOURCE_URL,
  extractSetSlugs,
  extractSetPageData,
  syncPokesymbolsSetArt
};
