"use strict";

const { normalizeShowcaseAvatarUrl, resolveShowcasePicture } = require("./showcase-avatar");
const { buildShowcaseCardHref } = require("./showcase-enrich");

function defaultShowcaseSettings() {
  return {
    isPublic: true,
    bio: "",
    showValues: true,
    showCost: false,
    collectrProfileUrl: "",
    avatarUrl: ""
  };
}

function normalizeShowcaseSettings(raw, userId = "") {
  const base = defaultShowcaseSettings();
  if (!raw || typeof raw !== "object") return { ...base };
  const collectrProfileUrl = String(raw.collectrProfileUrl || "").trim();
  const avatarUrl = Object.prototype.hasOwnProperty.call(raw, "avatarUrl")
    ? normalizeShowcaseAvatarUrl(raw.avatarUrl, userId)
    : base.avatarUrl;
  return {
    isPublic: raw.isPublic !== false,
    bio: String(raw.bio || "").trim().slice(0, 500),
    showValues: raw.showValues !== false,
    showCost: raw.showCost === true,
    collectrProfileUrl: collectrProfileUrl.slice(0, 300),
    avatarUrl
  };
}

function ensureUserShowcase(user) {
  if (!user || typeof user !== "object") return defaultShowcaseSettings();
  user.showcase = normalizeShowcaseSettings(user.showcase, user.id);
  return user.showcase;
}

function normalizeUsernameSlug(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function showcasePathForUsername(username) {
  const slug = normalizeUsernameSlug(username);
  return slug ? `/showcase/@${encodeURIComponent(slug)}` : "";
}

function publicShowcaseProfilePayload(user) {
  const showcase = ensureUserShowcase(user);
  return {
    username: user.username || "",
    name: String(user.name || user.username || "").trim() || user.username,
    picture: resolveShowcasePicture(user),
    memberSince: user.createdAt || null,
    showcaseUrl: showcasePathForUsername(user.username),
    showcase: {
      isPublic: showcase.isPublic,
      bio: showcase.bio,
      showValues: showcase.showValues,
      showCost: showcase.showCost,
      collectrProfileUrl: showcase.collectrProfileUrl || "",
      avatarUrl: showcase.avatarUrl || "",
      hasCustomAvatar: Boolean(showcase.avatarUrl)
    }
  };
}

function effectiveItemValue(item) {
  const manual = item.manualPrice;
  const market = item.marketPrice;
  const unit =
    manual !== null && manual !== undefined && Number.isFinite(Number(manual))
      ? Number(manual)
      : Number(market);
  return Number.isFinite(unit) && unit > 0 ? unit : 0;
}

function publicShowcaseItemPayload(item, showcase) {
  const settings = normalizeShowcaseSettings(showcase);
  const qty = Math.max(0, Number(item.quantity) || 0);
  const unit = effectiveItemValue(item);
  const row = {
    id: item.id,
    type: item.type === "sealed" ? "sealed" : "single",
    name: item.name,
    setName: item.setName || "",
    cardNumber: item.cardNumber || "",
    setCode: item.setCode || "",
    setLanguage: item.setLanguage === "japanese" ? "japanese" : "english",
    imageUrl: item.imageUrl || "",
    conditionType: item.conditionType === "graded" ? "graded" : "raw",
    condition: item.condition || "",
    gradeCompany: item.gradeCompany || "",
    gradeValue: item.gradeValue || "",
    quantity: qty,
    cardUrl:
      item.type === "single"
        ? buildShowcaseCardHref(item, item.showcaseReturnPath || "")
        : ""
  };
  if (settings.showValues) {
    row.unitValue = Number(unit.toFixed(2));
    row.totalValue = Number((unit * qty).toFixed(2));
  }
  if (settings.showCost) {
    const cost = Math.max(0, Number(item.costBasis) || 0);
    row.costBasis = Number(cost.toFixed(2));
    row.totalCost = Number((cost * qty).toFixed(2));
  }
  return row;
}

function summarizeShowcaseCollection(items, showcase) {
  const settings = normalizeShowcaseSettings(showcase);
  const singles = items.filter((i) => i.type === "single");
  const sealed = items.filter((i) => i.type === "sealed");
  let totalQuantity = 0;
  let marketValue = 0;
  let pricedLineItems = 0;
  let costBasis = 0;
  for (const item of items) {
    const qty = Math.max(0, Number(item.quantity) || 0);
    totalQuantity += qty;
    const unit = effectiveItemValue(item);
    if (unit > 0) {
      marketValue += unit * qty;
      pricedLineItems += 1;
    }
    costBasis += Math.max(0, Number(item.costBasis) || 0) * qty;
  }
  const stats = {
    lineItems: items.length,
    totalQuantity,
    singles: singles.length,
    sealed: sealed.length
  };
  if (settings.showValues) {
    stats.marketValue = Number(marketValue.toFixed(2));
    stats.pricedLineItems = pricedLineItems;
  }
  if (settings.showCost) {
    stats.costBasis = Number(costBasis.toFixed(2));
    stats.unrealizedPnL = Number((marketValue - costBasis).toFixed(2));
  }
  return stats;
}

function migrateStoreCollections(store) {
  if (!store || typeof store !== "object") return false;
  let changed = false;
  const defaultOwnerId = store.users?.[0]?.id || null;

  if (Array.isArray(store.users)) {
    for (const user of store.users) {
      const before = JSON.stringify(user.showcase || null);
      ensureUserShowcase(user);
      if (JSON.stringify(user.showcase) !== before) changed = true;
    }
  }

  if (Array.isArray(store.items)) {
    for (const item of store.items) {
      if (!item.userId && defaultOwnerId) {
        item.userId = defaultOwnerId;
        changed = true;
      }
    }
  }

  if (Array.isArray(store.activities)) {
    for (const activity of store.activities) {
      if (!activity.userId && defaultOwnerId) {
        activity.userId = defaultOwnerId;
        changed = true;
      }
    }
  }

  return changed;
}

module.exports = {
  defaultShowcaseSettings,
  normalizeShowcaseSettings,
  ensureUserShowcase,
  normalizeUsernameSlug,
  showcasePathForUsername,
  publicShowcaseProfilePayload,
  publicShowcaseItemPayload,
  summarizeShowcaseCollection,
  migrateStoreCollections,
  effectiveItemValue,
  resolveShowcasePicture
};
