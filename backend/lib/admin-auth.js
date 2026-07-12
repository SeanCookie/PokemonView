function parseAdminUsernameList(env = {}) {
  const raw = String(process.env.ADMIN_USERNAMES || env.ADMIN_USERNAMES || "seancookie").trim();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function isAdminUserRecord(user, adminUsernames) {
  if (!user || typeof user !== "object") return false;
  if (String(user.role || "").trim().toLowerCase() === "admin") return true;
  const username = normalizeUsername(user.username);
  return Boolean(username && adminUsernames.has(username));
}

function ensureDefaultAdminRoles(store, adminUsernames) {
  let changed = false;
  for (const user of store.users || []) {
    const username = normalizeUsername(user.username);
    if (!username || !adminUsernames.has(username)) continue;
    if (String(user.role || "").trim().toLowerCase() !== "admin") {
      user.role = "admin";
      changed = true;
    }
  }
  return changed;
}

function withAdminFlag(publicUser, adminUsernames) {
  if (!publicUser) return publicUser;
  const username = normalizeUsername(publicUser.username);
  const isAdmin =
    String(publicUser.role || "").trim().toLowerCase() === "admin" ||
    Boolean(username && adminUsernames.has(username));
  return { ...publicUser, isAdmin };
}

module.exports = {
  parseAdminUsernameList,
  normalizeUsername,
  isAdminUserRecord,
  ensureDefaultAdminRoles,
  withAdminFlag
};
