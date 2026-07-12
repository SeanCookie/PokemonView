"use strict";

const fsp = require("fs/promises");
const path = require("path");

const MAX_AVATAR_BYTES = 512 * 1024;
const ALLOWED_UPLOAD_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

function safeUserIdForFilename(userId) {
  const id = String(userId || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return "";
  return id;
}

function showcaseAvatarFilename(userId, ext) {
  const id = safeUserIdForFilename(userId);
  const safeExt = String(ext || "").toLowerCase();
  if (!id || !/^\.(png|jpe?g|gif|webp)$/.test(safeExt)) return "";
  return `${id}${safeExt}`;
}

function showcaseAvatarPublicPath(userId, ext) {
  const name = showcaseAvatarFilename(userId, ext);
  return name ? `/showcase-avatars/${name}` : "";
}

function normalizeShowcaseAvatarUrl(raw, userId = "") {
  const value = String(raw || "").trim();
  if (!value) return "";

  if (value.startsWith("/showcase-avatars/")) {
    const id = safeUserIdForFilename(userId);
    if (!id) return "";
    const ownPath = new RegExp(`^/showcase-avatars/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(png|jpe?g|gif|webp)$`, "i");
    return ownPath.test(value) ? value : "";
  }

  if (value.length > 2000) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "";
  return value;
}

function resolveShowcasePicture(user) {
  if (!user || typeof user !== "object") return null;
  const showcase = user.showcase && typeof user.showcase === "object" ? user.showcase : {};
  const custom = normalizeShowcaseAvatarUrl(showcase.avatarUrl, user.id);
  if (custom) return custom;
  const account = String(user.picture || "").trim();
  return account || null;
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function parseAvatarDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const match = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (!match) return null;
  const mime = match[1].toLowerCase().replace("jpg", "jpeg");
  const normalizedMime = mime === "image/jpg" ? "image/jpeg" : mime;
  if (!ALLOWED_UPLOAD_MIMES.has(normalizedMime)) return null;
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) return null;
  const detected = detectImageMime(buffer);
  if (!detected || detected !== normalizedMime) return null;
  return { mime: detected, buffer };
}

async function removeShowcaseAvatarFiles(avatarDir, userId) {
  const id = safeUserIdForFilename(userId);
  if (!id) return;
  const exts = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  await Promise.all(
    exts.map(async (ext) => {
      const filePath = path.join(avatarDir, `${id}${ext}`);
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    })
  );
}

async function saveShowcaseAvatarUpload(avatarDir, userId, dataUrl) {
  const id = safeUserIdForFilename(userId);
  if (!id) throw new Error("Invalid user");
  const parsed = parseAvatarDataUrl(dataUrl);
  if (!parsed) throw new Error("Invalid image. Use PNG, JPEG, GIF, or WebP under 512 KB.");

  const ext = EXT_BY_MIME[parsed.mime];
  if (!ext) throw new Error("Unsupported image type");

  await fsp.mkdir(avatarDir, { recursive: true });
  await removeShowcaseAvatarFiles(avatarDir, userId);

  const filePath = path.join(avatarDir, `${id}${ext}`);
  await fsp.writeFile(filePath, parsed.buffer);

  return showcaseAvatarPublicPath(userId, ext);
}

module.exports = {
  MAX_AVATAR_BYTES,
  normalizeShowcaseAvatarUrl,
  resolveShowcasePicture,
  saveShowcaseAvatarUpload,
  removeShowcaseAvatarFiles,
  showcaseAvatarPublicPath
};
