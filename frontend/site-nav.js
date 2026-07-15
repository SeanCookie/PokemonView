(() => {
  function closeNav(nav, backdrop) {
    if (!nav) return;
    nav.classList.remove("nav-open");
    const btn = nav.querySelector(".nav-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove("is-open");
    }
    document.documentElement.classList.remove("nav-drawer-open");
  }

  function openNav(nav, backdrop) {
    nav.classList.add("nav-open");
    const btn = nav.querySelector(".nav-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.classList.add("is-open");
    }
    document.documentElement.classList.add("nav-drawer-open");
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

    const panel = document.createElement("div");
    panel.className = "nav-links";
    panel.setAttribute("role", "navigation");
    panel.setAttribute("aria-label", "Primary");
    links.forEach((link) => panel.appendChild(link));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-menu-btn";
    btn.setAttribute("aria-label", "Open menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "siteNavLinks");
    panel.id = panel.id || "siteNavLinks";
    btn.innerHTML = "<span aria-hidden=\"true\">☰</span>";

    const brand = left.querySelector(".brand");
    if (brand && brand.nextSibling) {
      left.insertBefore(btn, brand.nextSibling);
    } else {
      left.appendChild(btn);
    }
    left.appendChild(panel);

    // Keep Account on the top row; move search under logo/menu/account on narrow layouts.
    const right = nav.querySelector(".nav-right");
    const searchWrap =
      (right && right.querySelector(".nav-search-wrap")) ||
      nav.querySelector(":scope > .nav-search-wrap") ||
      null;
    if (searchWrap && searchWrap.parentElement !== nav) {
      nav.appendChild(searchWrap);
    }

    let backdrop = document.querySelector(".nav-drawer-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("button");
      backdrop.type = "button";
      backdrop.className = "nav-drawer-backdrop";
      backdrop.setAttribute("aria-label", "Close menu");
      backdrop.hidden = true;
      document.body.appendChild(backdrop);
    }

    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (nav.classList.contains("nav-open")) closeNav(nav, backdrop);
      else openNav(nav, backdrop);
    });

    backdrop.addEventListener("click", () => closeNav(nav, backdrop));

    panel.querySelectorAll("a.nav-link").forEach((link) => {
      link.addEventListener("click", () => {
        // Let navigation proceed; just close the drawer.
        closeNav(nav, backdrop);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeNav(nav, backdrop);
    });

    window.addEventListener(
      "resize",
      () => {
        if (window.matchMedia("(min-width: 961px)").matches) closeNav(nav, backdrop);
      },
      { passive: true }
    );
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
