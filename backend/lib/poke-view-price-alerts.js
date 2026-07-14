"use strict";

const crypto = require("crypto");

const MAX_ALERTS_PER_USER = 50;
const RECURRING_COOLDOWN_MS = 60_000;
const DEFAULT_EXPIRY_DAYS = 30;

function makeAlertId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `pva_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeEventId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `pve_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function cardIdentityKey({ setCode = "", cardNo = "", cardName = "" } = {}) {
  const code = String(setCode || "")
    .trim()
    .toUpperCase();
  const no = String(cardNo || "")
    .trim()
    .toUpperCase();
  const name = String(cardName || "")
    .trim()
    .toLowerCase();
  if (code && no) return `${code}:${no}`;
  if (name) return `name:${name}`;
  return "";
}

function defaultExpiryIso(from = new Date()) {
  const d = new Date(from.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function normalizeRecurrence(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "recurring" || s === "every_time" || s === "every-time" || s === "repeat") {
    return "recurring";
  }
  return "once";
}

function normalizeCondition(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "above" || s === "crossing_up" || s === "crossing-up") return "above";
  if (s === "below" || s === "crossing_down" || s === "crossing-down") return "below";
  return "crossing";
}

function buildDefaultMessage({ cardLabel, condition, price } = {}) {
  const label = String(cardLabel || "Card").trim() || "Card";
  const p = Number(price);
  const priceText = Number.isFinite(p) ? p.toFixed(2) : String(price || "");
  const cond = normalizeCondition(condition);
  if (cond === "above") return `${label} Moving above ${priceText}`;
  if (cond === "below") return `${label} Moving below ${priceText}`;
  return `${label} Crossing ${priceText}`;
}

function normalizeAlert(raw, { userId } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim() || makeAlertId();
  const uid = String(userId || raw.userId || "").trim();
  if (!uid) return null;
  const setCode = String(raw.setCode || "")
    .trim()
    .toUpperCase();
  const cardNo = String(raw.cardNo || "").trim();
  const cardName = String(raw.cardName || raw.card || "").trim();
  const setName = String(raw.setName || "").trim();
  const watchlistCardId = String(raw.watchlistCardId || raw.cardId || "").trim();
  const price = clampNumber(raw.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!setCode && !cardName && !watchlistCardId) return null;

  const condition = normalizeCondition(raw.condition);
  const recurrence = normalizeRecurrence(raw.recurrence || raw.trigger);
  const notifyToast = normalizeBool(raw.notifyToast, true);
  const notifyEmail = normalizeBool(raw.notifyEmail, true);
  if (!notifyToast && !notifyEmail) return null;

  const cardLabel =
    String(raw.cardLabel || "").trim() ||
    [cardName, setCode && cardNo ? `${setCode} #${cardNo}` : setCode || setName]
      .filter(Boolean)
      .join(" · ") ||
    "Card";

  let expiresAt = raw.expiresAt == null || raw.expiresAt === "" ? null : String(raw.expiresAt);
  if (expiresAt) {
    const ts = Date.parse(expiresAt);
    expiresAt = Number.isFinite(ts) ? new Date(ts).toISOString() : defaultExpiryIso();
  } else {
    expiresAt = defaultExpiryIso();
  }

  const statusRaw = String(raw.status || "active")
    .trim()
    .toLowerCase();
  const status = ["active", "triggered", "expired", "disabled"].includes(statusRaw)
    ? statusRaw
    : "active";

  const message =
    String(raw.message || "").trim() ||
    buildDefaultMessage({ cardLabel, condition, price });

  return {
    id,
    userId: uid,
    watchlistCardId,
    setCode,
    cardNo,
    cardName,
    setName,
    cardLabel,
    cardKey: cardIdentityKey({ setCode, cardNo, cardName }),
    price: Number(price.toFixed(4)),
    condition,
    recurrence,
    notifyToast,
    notifyEmail,
    message,
    expiresAt,
    status,
    lastPrice: clampNumber(raw.lastPrice, null),
    lastTriggeredAt: raw.lastTriggeredAt ? String(raw.lastTriggeredAt) : null,
    createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : new Date().toISOString()
  };
}

function ensureAlertCollections(store) {
  if (!store || typeof store !== "object") return;
  if (!Array.isArray(store.pokeViewPriceAlerts)) store.pokeViewPriceAlerts = [];
  if (!Array.isArray(store.pokeViewPriceAlertEvents)) store.pokeViewPriceAlertEvents = [];
}

function listAlertsForUser(store, userId, { includeInactive = true } = {}) {
  ensureAlertCollections(store);
  const id = String(userId || "").trim();
  if (!id) return [];
  return store.pokeViewPriceAlerts
    .filter((row) => String(row.userId || "") === id)
    .filter((row) => (includeInactive ? true : row.status === "active"))
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function getAlertForUser(store, userId, alertId) {
  ensureAlertCollections(store);
  const uid = String(userId || "").trim();
  const id = String(alertId || "").trim();
  if (!uid || !id) return null;
  return (
    store.pokeViewPriceAlerts.find(
      (row) => String(row.id) === id && String(row.userId || "") === uid
    ) || null
  );
}

function createAlertForUser(store, userId, input) {
  ensureAlertCollections(store);
  const existing = listAlertsForUser(store, userId, { includeInactive: true });
  if (existing.length >= MAX_ALERTS_PER_USER) {
    const err = new Error(`Alert limit reached (${MAX_ALERTS_PER_USER})`);
    err.code = "ALERT_LIMIT";
    throw err;
  }
  const alert = normalizeAlert({ ...input, status: "active" }, { userId });
  if (!alert) {
    const err = new Error("Invalid alert");
    err.code = "INVALID_ALERT";
    throw err;
  }
  store.pokeViewPriceAlerts.push(alert);
  return alert;
}

function updateAlertForUser(store, userId, alertId, patch = {}) {
  ensureAlertCollections(store);
  const current = getAlertForUser(store, userId, alertId);
  if (!current) return null;
  const next = normalizeAlert(
    {
      ...current,
      ...patch,
      id: current.id,
      userId: current.userId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    },
    { userId }
  );
  if (!next) {
    const err = new Error("Invalid alert update");
    err.code = "INVALID_ALERT";
    throw err;
  }
  const idx = store.pokeViewPriceAlerts.findIndex((row) => String(row.id) === String(alertId));
  if (idx === -1) return null;
  store.pokeViewPriceAlerts[idx] = next;
  return next;
}

function deleteAlertForUser(store, userId, alertId) {
  ensureAlertCollections(store);
  const uid = String(userId || "").trim();
  const id = String(alertId || "").trim();
  const before = store.pokeViewPriceAlerts.length;
  store.pokeViewPriceAlerts = store.pokeViewPriceAlerts.filter(
    (row) => !(String(row.id) === id && String(row.userId || "") === uid)
  );
  return store.pokeViewPriceAlerts.length < before;
}

function listActiveAlerts(store) {
  ensureAlertCollections(store);
  const now = Date.now();
  return store.pokeViewPriceAlerts.filter((row) => {
    if (!row || row.status !== "active") return false;
    if (row.expiresAt) {
      const exp = Date.parse(row.expiresAt);
      if (Number.isFinite(exp) && exp <= now) return false;
    }
    return true;
  });
}

function expireDueAlerts(store) {
  ensureAlertCollections(store);
  const now = Date.now();
  let changed = false;
  for (const row of store.pokeViewPriceAlerts) {
    if (!row || row.status !== "active" || !row.expiresAt) continue;
    const exp = Date.parse(row.expiresAt);
    if (Number.isFinite(exp) && exp <= now) {
      row.status = "expired";
      row.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

function conditionTriggered(condition, prevPrice, nextPrice, target) {
  const next = Number(nextPrice);
  const goal = Number(target);
  if (!Number.isFinite(next) || !Number.isFinite(goal)) return false;
  const cond = normalizeCondition(condition);
  const hasPrev = prevPrice != null && prevPrice !== "" && Number.isFinite(Number(prevPrice));
  const prev = hasPrev ? Number(prevPrice) : NaN;

  if (cond === "above") {
    if (!hasPrev) return false;
    return prev < goal && next >= goal;
  }
  if (cond === "below") {
    if (!hasPrev) return false;
    return prev > goal && next <= goal;
  }

  // crossing either direction
  if (!hasPrev) return false;
  if (prev === next) return false;
  if (next === goal) return true;
  return (prev < goal && next > goal) || (prev > goal && next < goal);
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const userId = String(raw.userId || "").trim();
  if (!userId) return null;
  return {
    id: String(raw.id || makeEventId()),
    userId,
    alertId: String(raw.alertId || "").trim(),
    title: String(raw.title || "Price alert").trim() || "Price alert",
    message: String(raw.message || "").trim(),
    price: clampNumber(raw.price, null),
    marketPrice: clampNumber(raw.marketPrice, null),
    cardLabel: String(raw.cardLabel || "").trim(),
    setCode: String(raw.setCode || "").trim(),
    cardNo: String(raw.cardNo || "").trim(),
    createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    read: Boolean(raw.read)
  };
}

function enqueueToastEvent(store, payload) {
  ensureAlertCollections(store);
  const event = normalizeEvent(payload);
  if (!event) return null;
  store.pokeViewPriceAlertEvents.push(event);
  // Keep a bounded history per store to avoid unbounded growth.
  if (store.pokeViewPriceAlertEvents.length > 2000) {
    store.pokeViewPriceAlertEvents = store.pokeViewPriceAlertEvents.slice(-1500);
  }
  return event;
}

function listUnreadEventsForUser(store, userId, { limit = 20 } = {}) {
  ensureAlertCollections(store);
  const id = String(userId || "").trim();
  if (!id) return [];
  return store.pokeViewPriceAlertEvents
    .filter((row) => String(row.userId || "") === id && !row.read)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

function acknowledgeEventsForUser(store, userId, eventIds = []) {
  ensureAlertCollections(store);
  const uid = String(userId || "").trim();
  if (!uid) return 0;
  const wanted = new Set((Array.isArray(eventIds) ? eventIds : []).map((id) => String(id)));
  let count = 0;
  for (const row of store.pokeViewPriceAlertEvents) {
    if (String(row.userId || "") !== uid || row.read) continue;
    if (wanted.size && !wanted.has(String(row.id))) continue;
    row.read = true;
    count += 1;
  }
  return count;
}

function markAlertTriggered(alert, marketPrice, nowIso = new Date().toISOString()) {
  alert.lastTriggeredAt = nowIso;
  alert.updatedAt = nowIso;
  alert.lastPrice = Number(marketPrice);
  if (alert.recurrence === "once") {
    alert.status = "triggered";
  }
}

function canTriggerAgain(alert, nowMs = Date.now()) {
  if (alert.recurrence === "once") return true;
  const last = Date.parse(alert.lastTriggeredAt || "");
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= RECURRING_COOLDOWN_MS;
}

/**
 * Apply a market price sample to one alert. Returns { triggered, event } when fired.
 */
function evaluateAlertAgainstPrice(store, alert, marketPrice, { now = new Date() } = {}) {
  if (!alert || alert.status !== "active") return { triggered: false };
  const price = Number(marketPrice);
  if (!Number.isFinite(price) || price <= 0) return { triggered: false };

  if (alert.expiresAt) {
    const exp = Date.parse(alert.expiresAt);
    if (Number.isFinite(exp) && exp <= now.getTime()) {
      alert.status = "expired";
      alert.updatedAt = now.toISOString();
      return { triggered: false, expired: true };
    }
  }

  const prev = alert.lastPrice;
  const fired =
    conditionTriggered(alert.condition, prev, price, alert.price) && canTriggerAgain(alert, now.getTime());

  alert.lastPrice = price;
  alert.updatedAt = now.toISOString();

  if (!fired) return { triggered: false };

  markAlertTriggered(alert, price, now.toISOString());

  let event = null;
  if (alert.notifyToast) {
    event = enqueueToastEvent(store, {
      userId: alert.userId,
      alertId: alert.id,
      title: "Price alert",
      message: alert.message,
      price: alert.price,
      marketPrice: price,
      cardLabel: alert.cardLabel,
      setCode: alert.setCode,
      cardNo: alert.cardNo
    });
  }

  return { triggered: true, event, alert };
}

function publicAlert(alert) {
  if (!alert) return null;
  return {
    id: alert.id,
    watchlistCardId: alert.watchlistCardId || "",
    setCode: alert.setCode || "",
    cardNo: alert.cardNo || "",
    cardName: alert.cardName || "",
    setName: alert.setName || "",
    cardLabel: alert.cardLabel || "",
    cardKey: alert.cardKey || "",
    price: alert.price,
    condition: alert.condition,
    recurrence: alert.recurrence,
    notifyToast: Boolean(alert.notifyToast),
    notifyEmail: Boolean(alert.notifyEmail),
    message: alert.message || "",
    expiresAt: alert.expiresAt || null,
    status: alert.status,
    lastPrice: alert.lastPrice,
    lastTriggeredAt: alert.lastTriggeredAt,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt
  };
}

module.exports = {
  MAX_ALERTS_PER_USER,
  RECURRING_COOLDOWN_MS,
  makeAlertId,
  cardIdentityKey,
  buildDefaultMessage,
  defaultExpiryIso,
  normalizeAlert,
  ensureAlertCollections,
  listAlertsForUser,
  getAlertForUser,
  createAlertForUser,
  updateAlertForUser,
  deleteAlertForUser,
  listActiveAlerts,
  expireDueAlerts,
  conditionTriggered,
  evaluateAlertAgainstPrice,
  listUnreadEventsForUser,
  acknowledgeEventsForUser,
  publicAlert
};
