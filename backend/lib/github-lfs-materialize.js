const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");

const DEFAULT_LFS_REPO = "https://github.com/SeanCookie/PokemonView.git";
const inFlightByOid = new Map();

function getLfsRepoUrl() {
  const raw = String(process.env.GITHUB_LFS_REPO || DEFAULT_LFS_REPO).trim();
  return raw.endsWith(".git") ? raw : `${raw.replace(/\/$/, "")}.git`;
}

function isLfsPointer(data) {
  if (!data || !data.length) return false;
  const head = Buffer.isBuffer(data) ? data.subarray(0, 64).toString("utf8") : String(data).slice(0, 64);
  return head.startsWith("version https://git-lfs.github.com/spec/v1");
}

function parseLfsPointer(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (!isLfsPointer(text)) return null;
  const oidMatch = text.match(/^oid (sha256:[a-f0-9]+)$/m);
  const sizeMatch = text.match(/^size (\d+)$/m);
  if (!oidMatch || !sizeMatch) return null;
  return { oid: oidMatch[1], size: Number(sizeMatch[1]) };
}

async function downloadLfsObjects(objects) {
  if (!objects.length) return new Map();
  const repo = getLfsRepoUrl();
  const headers = {
    Accept: "application/vnd.git-lfs+json",
    "Content-Type": "application/vnd.git-lfs+json"
  };
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const batchRes = await fetch(`${repo}/info/lfs/objects/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operation: "download",
      transfers: ["basic"],
      objects: objects.map(({ oid, size }) => ({ oid, size }))
    })
  });

  if (!batchRes.ok) {
    throw new Error(`Git LFS batch request failed (${batchRes.status})`);
  }

  const payload = await batchRes.json();
  const out = new Map();
  const entries = Array.isArray(payload.objects) ? payload.objects : [];

  for (const entry of entries) {
    if (entry.error) {
      throw new Error(entry.error.message || "Git LFS object unavailable");
    }
    const action = entry.actions && entry.actions.download;
    if (!action || !action.href) {
      throw new Error("Git LFS batch response missing download action");
    }
    const dlHeaders = { ...(action.header || {}) };
    const fileRes = await fetch(action.href, { headers: dlHeaders });
    if (!fileRes.ok) {
      throw new Error(`Git LFS object download failed (${fileRes.status})`);
    }
    out.set(entry.oid, Buffer.from(await fileRes.arrayBuffer()));
  }

  return out;
}

async function fetchLfsObject(oid, size) {
  const key = `${oid}:${size}`;
  if (inFlightByOid.has(key)) return inFlightByOid.get(key);

  const promise = downloadLfsObjects([{ oid, size }]).then((map) => {
    const data = map.get(oid);
    if (!data) throw new Error("Git LFS object missing from batch response");
    return data;
  });

  inFlightByOid.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightByOid.delete(key);
  }
}

async function materializeLfsFile(filePath, existingData) {
  let pointerData = existingData;
  if (!pointerData) {
    pointerData = await fsp.readFile(filePath);
  }
  if (!isLfsPointer(pointerData)) {
    return pointerData;
  }

  const parsed = parseLfsPointer(pointerData);
  if (!parsed) {
    throw new Error(`Invalid LFS pointer: ${filePath}`);
  }

  const bytes = await fetchLfsObject(parsed.oid, parsed.size);
  const tmpPath = `${filePath}.lfs-download`;
  await fsp.writeFile(tmpPath, bytes);
  await fsp.rename(tmpPath, filePath);
  return bytes;
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
        out.push({ abs, rel });
      }
    }
  }
  await walk(rootDir, "");
  return out;
}

async function materializeDirectory(rootDir, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : Infinity;
  const batchSize = Number.isFinite(options.batchSize) ? options.batchSize : 40;
  const label = options.label || path.basename(rootDir);

  if (!fs.existsSync(rootDir)) {
    return { scanned: 0, materialized: 0, skipped: 0 };
  }

  const files = await listFilesRecursive(rootDir);
  const pointers = [];
  for (const file of files) {
    if (pointers.length >= maxFiles) break;
    try {
      const head = Buffer.alloc(80);
      const fd = await fsp.open(file.abs, "r");
      try {
        await fd.read(head, 0, 80, 0);
      } finally {
        await fd.close();
      }
      if (isLfsPointer(head)) {
        const full = await fsp.readFile(file.abs);
        const parsed = parseLfsPointer(full);
        if (parsed) pointers.push({ filePath: file.abs, ...parsed });
      }
    } catch {
      /* skip unreadable */
    }
  }

  if (!pointers.length) {
    console.log(`[lfs] ${label}: no LFS pointers found`);
    return { scanned: files.length, materialized: 0, skipped: files.length };
  }

  console.log(`[lfs] ${label}: materializing ${pointers.length} file(s) from GitHub LFS...`);
  let materialized = 0;

  for (let i = 0; i < pointers.length; i += batchSize) {
    const chunk = pointers.slice(i, i + batchSize);
    const objects = chunk.map(({ oid, size }) => ({ oid, size }));
    const downloaded = await downloadLfsObjects(objects);
    for (const item of chunk) {
      const bytes = downloaded.get(item.oid);
      if (!bytes) continue;
      const tmpPath = `${item.filePath}.lfs-download`;
      await fsp.writeFile(tmpPath, bytes);
      await fsp.rename(tmpPath, item.filePath);
      materialized += 1;
    }
    if (i + batchSize < pointers.length) {
      console.log(`[lfs] ${label}: ${Math.min(i + batchSize, pointers.length)}/${pointers.length}`);
    }
  }

  console.log(`[lfs] ${label}: materialized ${materialized} file(s)`);
  return { scanned: files.length, materialized, skipped: files.length - materialized };
}

async function materializeDirectoryIfNeeded(rootDir, options = {}) {
  if (!fs.existsSync(rootDir)) return { scanned: 0, materialized: 0, skipped: 0 };
  const files = await listFilesRecursive(rootDir);
  for (const file of files.slice(0, 5)) {
    try {
      const head = await fsp.readFile(file.abs);
      if (isLfsPointer(head)) {
        return materializeDirectory(rootDir, options);
      }
    } catch {
      /* ignore */
    }
  }
  return { scanned: files.length, materialized: 0, skipped: files.length };
}

module.exports = {
  isLfsPointer,
  parseLfsPointer,
  materializeLfsFile,
  materializeDirectory,
  materializeDirectoryIfNeeded
};
