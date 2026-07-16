/**
 * Edge overrides for shared nav assets + HTML structure.
 * Keeps Sign In immediately to the right of the search bar even when the container image is stale.
 */
import { SITE_NAV_CSS, SITE_NAV_JS } from "./frontend-overrides.generated.js";

const NAV_ASSET_CACHE = "no-store";

/**
 * Serve fresh site-nav.css / site-nav.js from the Worker bundle.
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
  const fixed = clusterNavSearchWithAccount(html);
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
