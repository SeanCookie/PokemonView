const fsp = require("fs/promises");
const { writeJsonAtomic } = require("./write-json-atomic");

function randomId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e7)}`;
}

function normalizeNicknameText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function loadCardNicknames(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.nicknames) ? parsed.nicknames : [];
  } catch {
    return [];
  }
}

async function saveCardNicknames(filePath, nicknames) {
  await writeJsonAtomic(filePath, {
    ok: true,
    updatedAt: new Date().toISOString(),
    nicknames: Array.isArray(nicknames) ? nicknames : []
  });
}

function normalizeCardNicknameEntry(input = {}, existing = null) {
  const nickname = String(input.nickname ?? existing?.nickname ?? "").trim();
  const setCode = String(input.setCode ?? existing?.setCode ?? "")
    .trim()
    .toUpperCase();
  const cardNumber = String(input.cardNumber ?? input.cardNo ?? existing?.cardNumber ?? existing?.cardNo ?? "").trim();
  const setName = String(input.setName ?? existing?.setName ?? "").trim();
  const language =
    String(input.language ?? existing?.language ?? "english").trim().toLowerCase() === "japanese"
      ? "japanese"
      : "english";
  if (!nickname) throw new Error("Nickname is required");
  if (!setCode) throw new Error("Set code is required");
  if (!cardNumber) throw new Error("Card number is required");
  return {
    id: existing?.id || randomId(),
    nickname,
    nicknameKey: normalizeNicknameText(nickname),
    setCode,
    cardNumber,
    setName,
    language,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function addCardNickname(filePath, input = {}) {
  const entry = normalizeCardNicknameEntry(input);
  const nicknames = await loadCardNicknames(filePath);
  const dup = nicknames.some((row) => row.nicknameKey === entry.nicknameKey);
  if (dup) throw new Error("This nickname already exists");
  nicknames.unshift(entry);
  await saveCardNicknames(filePath, nicknames);
  return entry;
}

async function removeCardNickname(filePath, id) {
  const targetId = String(id || "").trim();
  if (!targetId) throw new Error("Nickname id is required");
  const nicknames = await loadCardNicknames(filePath);
  const next = nicknames.filter((row) => String(row.id) !== targetId);
  if (next.length === nicknames.length) throw new Error("Nickname not found");
  await saveCardNicknames(filePath, next);
  return { removed: true, id: targetId };
}

function nicknameMatchesQuery(nicknameKey, queryKey) {
  if (!nicknameKey || !queryKey) return false;
  if (nicknameKey === queryKey) return true;
  if (queryKey.length < 3) return false;
  return nicknameKey.includes(queryKey) || queryKey.includes(nicknameKey);
}

function findNicknamesForQuery(nicknames, query) {
  const queryKey = normalizeNicknameText(query);
  if (!queryKey) return [];
  const list = Array.isArray(nicknames) ? nicknames : [];
  const exact = [];
  const partial = [];
  for (const row of list) {
    const key = row.nicknameKey || normalizeNicknameText(row.nickname);
    if (key === queryKey) exact.push(row);
    else if (nicknameMatchesQuery(key, queryKey)) partial.push(row);
  }
  return [...exact, ...partial];
}

function publicNicknamePayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    setCode: row.setCode,
    cardNumber: row.cardNumber,
    setName: row.setName || "",
    language: row.language || "english"
  };
}

module.exports = {
  normalizeNicknameText,
  loadCardNicknames,
  saveCardNicknames,
  addCardNickname,
  removeCardNickname,
  findNicknamesForQuery,
  publicNicknamePayload
};
