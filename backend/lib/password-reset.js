const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("./write-json-atomic");
const { sendPasswordResetEmail, isEmailConfigured } = require("./send-email");

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;

const resetRequestLastAt = new Map();

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function randomResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function loadResetStore(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  } catch {
    return [];
  }
}

async function saveResetStore(filePath, tokens) {
  const now = Date.now();
  const pruned = tokens.filter((row) => {
    const expiresAt = Date.parse(row?.expiresAt || "");
    return Number.isFinite(expiresAt) && expiresAt > now - 60_000;
  });
  await writeJsonAtomic(filePath, { updatedAt: new Date().toISOString(), tokens: pruned });
}

function getPublicAppUrl(req, env = {}) {
  const configured = String(env.APP_PUBLIC_URL || process.env.APP_PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = String(req?.headers?.host || "localhost:828").trim();
  const proto =
    String(req?.headers?.["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function canSetPasswordForUser(user) {
  if (!user) return false;
  return true;
}

async function requestPasswordReset({
  email,
  users,
  resetFilePath,
  req,
  env = {}
}) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  const genericMessage =
    "If an account exists for that email, a reset link has been sent. Check your inbox and spam folder.";

  if (!normalized || !normalized.includes("@")) {
    return { ok: false, error: "Enter the email address on your account." };
  }

  const lastAt = resetRequestLastAt.get(normalized) || 0;
  if (Date.now() - lastAt < RESET_REQUEST_COOLDOWN_MS) {
    return { ok: true, message: genericMessage };
  }
  resetRequestLastAt.set(normalized, Date.now());

  const user = users.find((entry) => String(entry.email || "").trim().toLowerCase() === normalized);
  if (!user || !canSetPasswordForUser(user)) {
    return { ok: true, message: genericMessage };
  }

  const plainToken = randomResetToken();
  const tokenHash = hashToken(plainToken);
  const tokens = await loadResetStore(resetFilePath);
  const now = Date.now();
  const next = tokens.filter((row) => row.userId !== user.id);
  next.push({
    userId: user.id,
    tokenHash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PASSWORD_RESET_TTL_MS).toISOString(),
    usedAt: null
  });
  await saveResetStore(resetFilePath, next);

  const resetUrl = `${getPublicAppUrl(req, env)}/reset-password.html?token=${encodeURIComponent(plainToken)}`;
  const mailResult = await sendPasswordResetEmail(
    {
      to: user.email,
      resetUrl,
      userName: user.name || user.username || ""
    },
    env
  );

  const message = mailResult.loggedToConsole
    ? `${genericMessage} (SMTP not configured — check the server console for the reset link.)`
    : genericMessage;

  return { ok: true, message, emailSent: Boolean(mailResult.ok) };
}

async function completePasswordReset({ token, newPassword, users, resetFilePath }) {
  const plain = String(token || "").trim();
  if (!plain) {
    return { ok: false, error: "Reset link is invalid or expired." };
  }
  if (String(newPassword || "").length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }

  const tokenHash = hashToken(plain);
  const tokens = await loadResetStore(resetFilePath);
  const now = Date.now();
  const row = tokens.find((entry) => entry.tokenHash === tokenHash && !entry.usedAt);
  if (!row) {
    return { ok: false, error: "Reset link is invalid or expired." };
  }
  if (Date.parse(row.expiresAt) <= now) {
    return { ok: false, error: "Reset link has expired. Request a new one." };
  }

  const user = users.find((entry) => entry.id === row.userId);
  if (!user) {
    return { ok: false, error: "Account not found." };
  }

  row.usedAt = new Date(now).toISOString();
  await saveResetStore(resetFilePath, tokens);

  return { ok: true, userId: user.id };
}

module.exports = {
  PASSWORD_RESET_TTL_MS,
  isEmailConfigured,
  getPublicAppUrl,
  requestPasswordReset,
  completePasswordReset,
  hashToken
};
