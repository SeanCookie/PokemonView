/**
 * Edge overrides for shared nav assets + HTML structure.
 * Keeps Sign In immediately to the right of the search bar even when the container image is stale.
 * Also serves a fresh /sets.html so set-open perf fixes are not stuck on an old Docker image.
 * Favicon is served from the Worker so tab icons update without a container rebuild.
 */
import {
  SITE_NAV_CSS,
  SITE_NAV_JS,
  SETS_HTML,
  FAVICON_SVG,
  FAVICON_PNG_BASE64,
  APPLE_TOUCH_ICON_PNG_BASE64
} from "./frontend-overrides.generated.js";

const NAV_ASSET_CACHE = "no-store";
const FAVICON_CACHE = "public, max-age=86400";

const FAVICON_LINK_TAGS = [
  `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
  `<link rel="icon" href="/favicon.png" type="image/png" sizes="32x32" />`,
  `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`
].join("\n  ");

function base64ToBytes(base64) {
  const bin = atob(String(base64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function ensureFaviconLinks(html) {
  if (typeof html !== "string" || !html.includes("<head")) return html;
  if (html.includes('rel="icon"') && html.includes("/favicon.svg")) return html;
  const inject = `\n  ${FAVICON_LINK_TAGS}\n`;
  if (/<meta\s+charset=["']UTF-8["']\s*\/?>/i.test(html)) {
    return html.replace(/(<meta\s+charset=["']UTF-8["']\s*\/?>)/i, `$1${inject}`);
  }
  return html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
}

/**
 * Serve fresh site-nav.css / site-nav.js / sets.html / favicon from the Worker bundle.
 * @param {Request} request
 * @returns {Response|null}
 */
export function tryServeNavAssetOverride(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/site-nav.css") {
    const headers = {
      "content-type": "text/css; charset=utf-8",
      "cache-control": NAV_ASSET_CACHE
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(SITE_NAV_CSS, { status: 200, headers });
  }

  if (path === "/site-nav.js") {
    const headers = {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": NAV_ASSET_CACHE
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(SITE_NAV_JS, { status: 200, headers });
  }

  if (path === "/favicon.svg" || path === "/favicon.ico") {
    const headers = {
      "content-type": "image/svg+xml",
      "cache-control": FAVICON_CACHE
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(FAVICON_SVG, { status: 200, headers });
  }

  if (path === "/favicon.png") {
    const headers = {
      "content-type": "image/png",
      "cache-control": FAVICON_CACHE
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(base64ToBytes(FAVICON_PNG_BASE64), { status: 200, headers });
  }

  if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon") {
    const headers = {
      "content-type": "image/png",
      "cache-control": FAVICON_CACHE
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(base64ToBytes(APPLE_TOUCH_ICON_PNG_BASE64), { status: 200, headers });
  }

  if (path === "/sets.html" || path === "/sets") {
    const html = ensureFaviconLinks(clusterNavSearchWithAccount(SETS_HTML));
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": NAV_ASSET_CACHE
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(html, { status: 200, headers });
  }

  return null;
}

function findMatchingDivBlock(html, className) {
  const open = `<div class="${className}">`;
  const start = html.indexOf(open);
  if (start < 0) {
    // allow extra attributes / spacing variants
    const re = new RegExp(`<div\\s+class="${className}"[^>]*>`, "i");
    const m = html.match(re);
    if (!m) return null;
    return findMatchingDivBlockFrom(html, html.indexOf(m[0]), m[0].length);
  }
  return findMatchingDivBlockFrom(html, start, open.length);
}

function findMatchingDivBlockFrom(html, start, openLen) {
  let i = start + openLen;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
    } else {
      depth -= 1;
      if (depth === 0) {
        return { start, end: nextClose + 6, text: html.slice(start, nextClose + 6) };
      }
      i = nextClose + 6;
    }
  }
  return null;
}

/**
 * Ensure .nav-search-wrap sits inside .nav-right before the account slot.
 * Desired: [logo…] [search][Sign In]
 */
export function clusterNavSearchWithAccount(html) {
  if (typeof html !== "string" || !html.includes("nav-search-wrap") || !html.includes("nav-right")) {
    return html;
  }

  const right = findMatchingDivBlock(html, "nav-right");
  const search = findMatchingDivBlock(html, "nav-search-wrap");
  if (!right || !search) return html;

  // Already inside nav-right.
  if (search.start > right.start && search.end < right.end) return html;

  // Search must appear before nav-right as a sibling.
  if (search.end > right.start) return html;

  const searchHtml = search.text;
  const rightOpen = right.text.match(/^<div[^>]*>/i)?.[0] || `<div class="nav-right">`;
  const rightInner = right.text.slice(rightOpen.length, right.text.length - 6).trim();
  const clustered = `${rightOpen}
      ${searchHtml}
      ${rightInner}
    </div>`;

  // Rebuild: remove search block, replace nav-right (indices shift after removal).
  const withoutSearch = html.slice(0, search.start) + html.slice(search.end);
  const shiftedRight = findMatchingDivBlock(withoutSearch, "nav-right");
  if (!shiftedRight) return html;
  return withoutSearch.slice(0, shiftedRight.start) + clustered + withoutSearch.slice(shiftedRight.end);
}

/**
 * @param {Request} request
 * @param {Response} response
 * @returns {Promise<Response>}
 */
export async function maybeRewriteHtmlNav(request, response) {
  if (!response || response.status >= 400) return response;
  if (request.method !== "GET" && request.method !== "HEAD") return response;

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) return response;

  if (request.method === "HEAD") return response;

  const html = await response.text();
  const clustered = clusterNavSearchWithAccount(html);
  const fixed = ensureFaviconLinks(clustered);
  const headers = new Headers(response.headers);
  if (fixed !== html) {
    headers.set("cache-control", "no-store");
    headers.delete("content-length");
  }
  return new Response(fixed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
