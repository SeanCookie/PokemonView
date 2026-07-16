(() => {
  function closeNav(nav, backdrop, panel) {
    if (!nav) return;
    nav.classList.remove("nav-open");
    if (panel) panel.classList.remove("is-open");
    const btn = nav.querySelector(".nav-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove("is-open");
    }
    document.documentElement.classList.remove("nav-drawer-open");
  }

  function openNav(nav, backdrop, panel) {
    nav.classList.add("nav-open");
    if (panel) panel.classList.add("is-open");
    const btn = nav.querySelector(".nav-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.classList.add("is-open");
    }
    document.documentElement.classList.add("nav-drawer-open");
  }

  function isDesktopNav() {
    return window.matchMedia("(min-width: 961px)").matches;
  }

  function placePanelForViewport(nav, left, panel) {
    if (isDesktopNav()) {
      if (panel.parentElement !== left) left.appendChild(panel);
      panel.classList.remove("is-open");
    } else if (panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
  }

  /**
   * Keep search inside .nav-right, immediately before the account slot,
   * so Sign In stays to the right of the search bar.
   */
  function placeSearchWithAccount(nav, right, searchWrap) {
    if (!nav || !searchWrap || !right) return;
    if (searchWrap.parentElement !== right) {
      const account = right.querySelector("[data-account-slot]");
      if (account) right.insertBefore(searchWrap, account);
      else right.insertBefore(searchWrap, right.firstChild);
    } else {
      const account = right.querySelector("[data-account-slot]");
      if (account && searchWrap.nextElementSibling !== account) {
        right.insertBefore(searchWrap, account);
      }
    }
  }

  function findSearchWrap(nav, right) {
    return (
      (right && right.querySelector(".nav-search-wrap")) ||
      nav.querySelector(":scope > .nav-search-wrap") ||
      nav.querySelector(".nav-search-wrap") ||
      null
    );
  }

  function enhanceNav(nav) {
    if (!nav || nav.dataset.mobileNav === "1") return;
    nav.dataset.mobileNav = "1";

    const left = nav.querySelector(".nav-left");
    if (!left) return;

    const links = Array.from(left.children).filter(
      (el) => el.classList && el.classList.contains("nav-link")
    );
    if (!links.length) return;

    const panel = document.createElement("nav");
    panel.className = "nav-links";
    panel.id = "siteNavLinks";
    panel.setAttribute("aria-label", "Primary");
    links.forEach((link) => panel.appendChild(link));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-menu-btn";
    btn.setAttribute("aria-label", "Open menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "siteNavLinks");
    btn.innerHTML = '<span aria-hidden="true">☰</span>';

    const brand = left.querySelector(".brand");
    if (brand && brand.nextSibling) {
      left.insertBefore(btn, brand.nextSibling);
    } else {
      left.appendChild(btn);
    }

    let right = nav.querySelector(".nav-right");
    if (!right) {
      right = document.createElement("div");
      right.className = "nav-right";
      nav.appendChild(right);
    }

    let searchWrap = findSearchWrap(nav, right);

    placePanelForViewport(nav, left, panel);
    placeSearchWithAccount(nav, right, searchWrap);

    let backdrop = document.querySelector(".nav-drawer-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("button");
      backdrop.type = "button";
      backdrop.className = "nav-drawer-backdrop";
      backdrop.setAttribute("aria-label", "Close menu");
      backdrop.hidden = true;
      document.body.appendChild(backdrop);
    }

    const syncLayout = () => {
      searchWrap = findSearchWrap(nav, right);
      placePanelForViewport(nav, left, panel);
      placeSearchWithAccount(nav, right, searchWrap);
    };

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      syncLayout();
      if (nav.classList.contains("nav-open") || panel.classList.contains("is-open")) {
        closeNav(nav, backdrop, panel);
      } else {
        openNav(nav, backdrop, panel);
      }
    });

    backdrop.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeNav(nav, backdrop, panel);
    });

    panel.addEventListener(
      "click",
      (event) => {
        const link = event.target && event.target.closest ? event.target.closest("a.nav-link") : null;
        if (!link || !panel.contains(link)) return;
        const href = link.getAttribute("href");
        if (!href || href.startsWith("#")) {
          closeNav(nav, backdrop, panel);
          return;
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
          window.setTimeout(() => closeNav(nav, backdrop, panel), 0);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeNav(nav, backdrop, panel);
        window.location.assign(href);
      },
      true
    );

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeNav(nav, backdrop, panel);
    });

    window.addEventListener(
      "resize",
      () => {
        syncLayout();
        if (isDesktopNav()) closeNav(nav, backdrop, panel);
      },
      { passive: true }
    );

    window.setTimeout(syncLayout, 0);
    window.setTimeout(syncLayout, 250);
  }

  function boot() {
    document.querySelectorAll("nav.top-nav").forEach(enhanceNav);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
