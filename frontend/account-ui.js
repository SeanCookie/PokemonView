(() => {
  const slot = document.querySelector("[data-account-slot]");
  if (!slot) return;

  const style = document.createElement("style");
  style.textContent = `
    .acct-button {
      height: 44px;
      min-width: 44px;
      border: 1px solid #35507a;
      border-radius: 8px;
      background: #16263c;
      color: #e9f1ff;
      font-size: 12px;
      padding: 0 12px;
      cursor: pointer;
    }
    @media (min-width: 721px) {
      .acct-button {
        height: 34px;
        min-width: 0;
      }
    }
    .acct-button:hover { border-color: #4f6e9c; }
    .acct-button:not([data-auth-ready="1"]) {
      visibility: hidden;
    }
    .acct-menu-wrap {
      position: relative;
    }
    .acct-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: min(210px, calc(var(--app-vv-width, 100vw) - 24px));
      max-width: min(280px, calc(var(--app-vv-width, 100vw) - 24px));
      max-height: min(70vh, calc(var(--app-vv-height, 100dvh) - 72px));
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      border: 1px solid #2d405e;
      border-radius: 10px;
      background: #0f1726;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.38);
      padding: 8px;
      display: none;
      z-index: 70;
      box-sizing: border-box;
    }
    .acct-menu.open { display: grid; gap: 4px; }
    .acct-menu-head {
      color: #93a8c7;
      font-size: 11px;
      padding: 4px 6px 6px;
      border-bottom: 1px solid #243853;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .acct-menu-item {
      height: 34px;
      border: 1px solid #263a57;
      border-radius: 8px;
      background: #132239;
      color: #e9f1ff;
      text-decoration: none;
      font-size: 12px;
      font-family: inherit;
      display: flex;
      align-items: center;
      padding: 0 10px;
      cursor: pointer;
      text-align: left;
    }
    .acct-menu-item[hidden] {
      display: none !important;
    }
    .acct-menu-item:hover {
      border-color: #3f5c84;
      background: #172b47;
    }
    a.acct-menu-item {
      color: inherit;
      text-decoration: none;
    }
    .acct-overlay {
      position: fixed;
      inset: 0;
      width: 100%;
      max-width: 100vw;
      max-height: var(--app-vv-height, 100dvh);
      background: rgba(4, 9, 15, 0.72);
      display: none;
      align-items: safe center;
      justify-content: safe center;
      z-index: 60;
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      padding: max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
    }
    .acct-overlay.open { display: flex; }
    .acct-modal {
      width: min(460px, calc(var(--app-vv-width, 100vw) - 24px), 100%);
      max-width: 100%;
      max-height: min(900px, calc(var(--app-vv-height, 100dvh) - 24px));
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      border: 1px solid #2d405e;
      border-radius: 12px;
      background: #0f1726;
      padding: 14px;
      display: grid;
      gap: 10px;
      color: #e9f1ff;
      box-sizing: border-box;
    }
    @media (max-height: 560px), (max-width: 420px) {
      .acct-overlay { align-items: flex-start; }
      .acct-modal { border-radius: 10px; padding: 12px; gap: 8px; }
    }
    @media (max-width: 380px) {
      .acct-tab {
        font-size: 10px;
        white-space: normal;
        line-height: 1.15;
        height: auto;
        min-height: 36px;
        padding: 6px 4px;
      }
    }
    .acct-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .acct-title {
      margin: 0;
      font-size: 16px;
    }
    .acct-close {
      border: 1px solid #2d405e;
      border-radius: 8px;
      background: #142038;
      color: #e9f1ff;
      height: 30px;
      padding: 0 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .acct-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border: 1px solid #2d405e;
      border-radius: 8px;
      overflow: hidden;
    }
    .acct-tab {
      border: 0;
      background: #121c2d;
      color: #9cb1d1;
      height: 32px;
      padding: 0 6px;
      cursor: pointer;
      font-size: 11px;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: relative;
      z-index: 1;
    }
    .acct-tab + .acct-tab {
      border-left: 1px solid #2d405e;
    }
    .acct-hint {
      margin: 0;
      font-size: 12px;
      color: #93a8c7;
      line-height: 1.45;
    }
    .acct-login-hint {
      margin: -2px 0 0;
      font-size: 11px;
      color: #7d92af;
      line-height: 1.35;
    }
    .acct-login-hint[hidden] {
      display: none !important;
    }
    .acct-tab.active {
      background: #20324c;
      color: #e9f1ff;
    }
    .acct-form {
      display: grid;
      gap: 8px;
    }
    .acct-input {
      width: 100%;
      height: 36px;
      border: 1px solid #2d405e;
      border-radius: 8px;
      background: #0d1624;
      color: #e9f1ff;
      font-size: 13px;
      padding: 0 10px;
    }
    .acct-submit {
      height: 36px;
      border: 1px solid #34547c;
      border-radius: 8px;
      background: #1b304c;
      color: #e9f1ff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }
    .acct-status {
      min-height: 18px;
      color: #93a8c7;
      font-size: 12px;
    }
    .acct-status.error { color: #ff8795; }
    .acct-remember {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #93a8c7;
      cursor: pointer;
      user-select: none;
    }
    .acct-remember input {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: #5b9dff;
      cursor: pointer;
    }
    .acct-google-wrap {
      display: grid;
      gap: 10px;
    }
    .acct-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #7a8fb0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .acct-divider::before,
    .acct-divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: #2d405e;
    }
    .acct-divider span { white-space: nowrap; }
    .acct-google-wrap[hidden] {
      display: none !important;
    }
    #acctGoogle {
      display: flex;
      justify-content: center;
      max-width: 100%;
      overflow: hidden;
    }
    .acct-google-wrap { max-width: 100%; min-width: 0; }
    .acct-input, .acct-submit, .acct-form { max-width: 100%; box-sizing: border-box; }
  `;
  document.head.appendChild(style);

  function syncAcctViewportSize() {
    const root = document.documentElement;
    if (!root) return;
    const vv = window.visualViewport;
    const width = Math.max(
      0,
      Math.round(Number(vv?.width) || window.innerWidth || root.clientWidth || 0)
    );
    const height = Math.max(
      0,
      Math.round(Number(vv?.height) || window.innerHeight || root.clientHeight || 0)
    );
    if (width > 0) root.style.setProperty("--app-vv-width", `${width}px`);
    if (height > 0) root.style.setProperty("--app-vv-height", `${height}px`);
  }
  syncAcctViewportSize();
  window.addEventListener("resize", syncAcctViewportSize, { passive: true });
  window.addEventListener("orientationchange", syncAcctViewportSize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAcctViewportSize, { passive: true });
    window.visualViewport.addEventListener("scroll", syncAcctViewportSize, { passive: true });
  }

  slot.innerHTML = `
    <div class="acct-menu-wrap">
      <button type="button" class="acct-button" id="acctOpen">Account</button>
      <div class="acct-menu" id="acctMenu" role="menu" aria-label="Account menu">
        <div class="acct-menu-head" id="acctMenuHead">Signed in</div>
        <a class="acct-menu-item" id="acctMenuCollection" href="/dashboard.html" role="menuitem">Collection</a>
        <a class="acct-menu-item" id="acctMenuShowcase" href="/showcase" role="menuitem">My Showcase</a>
        <a class="acct-menu-item" id="acctMenuSettings" href="/settings.html" role="menuitem">Settings</a>
        <a class="acct-menu-item" id="acctMenuAdmin" href="/admin.html" role="menuitem" hidden>Admin</a>
        <button type="button" class="acct-menu-item" id="acctMenuSignout" role="menuitem">Sign out</button>
      </div>
    </div>
  `;

  const overlay = document.createElement("div");
  overlay.className = "acct-overlay";
  overlay.id = "acctOverlay";
  overlay.innerHTML = `
    <section class="acct-modal" role="dialog" aria-modal="true" aria-label="Account sign in">
      <header class="acct-head">
        <h3 class="acct-title">Account</h3>
        <button type="button" class="acct-close" id="acctClose">Close</button>
      </header>
      <div class="acct-tabs">
        <button type="button" class="acct-tab active" id="acctTabSignIn">Sign In</button>
        <button type="button" class="acct-tab" id="acctTabCreate">Create Account</button>
        <button type="button" class="acct-tab" id="acctTabForgot">Forgot Password?</button>
      </div>
      <p class="acct-hint" id="acctForgotHint" hidden>
        Enter the email on your account. We will send a link to reset your password (valid for 1 hour).
      </p>
      <form id="acctForm" class="acct-form">
        <input id="acctName" class="acct-input" placeholder="Display name (optional)" autocomplete="name" style="display:none;" />
        <input id="acctUsername" class="acct-input" placeholder="Username" autocomplete="username" style="display:none;" />
        <input id="acctEmail" class="acct-input" placeholder="Username" autocomplete="username" required />
        <input id="acctPassword" class="acct-input" placeholder="Password" type="password" autocomplete="current-password" required />
        <p class="acct-login-hint" id="acctLoginHint">You can also sign in with your email.</p>
        <label class="acct-remember" id="acctRememberWrap">
          <input type="checkbox" id="acctRemember" />
          Remember my username
        </label>
        <button type="submit" class="acct-submit" id="acctSubmit">Sign In</button>
      </form>
      <div class="acct-google-wrap" id="acctGoogleWrap" hidden>
        <div class="acct-divider"><span>or</span></div>
        <div id="acctGoogle"></div>
      </div>
      <div id="acctStatus" class="acct-status"></div>
    </section>
  `;
  document.body.appendChild(overlay);

  const acctOpen = document.getElementById("acctOpen");
  const acctClose = document.getElementById("acctClose");
  const acctTabSignIn = document.getElementById("acctTabSignIn");
  const acctTabCreate = document.getElementById("acctTabCreate");
  const acctTabForgot = document.getElementById("acctTabForgot");
  const acctForgotHint = document.getElementById("acctForgotHint");
  const acctLoginHint = document.getElementById("acctLoginHint");
  const acctForm = document.getElementById("acctForm");
  const acctName = document.getElementById("acctName");
  const acctUsername = document.getElementById("acctUsername");
  const acctEmail = document.getElementById("acctEmail");
  const acctPassword = document.getElementById("acctPassword");
  const acctRemember = document.getElementById("acctRemember");
  const acctRememberWrap = document.getElementById("acctRememberWrap");
  const acctSubmit = document.getElementById("acctSubmit");
  const acctStatus = document.getElementById("acctStatus");
  const acctGoogleWrap = document.getElementById("acctGoogleWrap");
  const acctMenu = document.getElementById("acctMenu");
  const acctMenuHead = document.getElementById("acctMenuHead");
  const acctMenuCollection = document.getElementById("acctMenuCollection");
  const acctMenuShowcase = document.getElementById("acctMenuShowcase");
  const acctMenuSettings = document.getElementById("acctMenuSettings");
  const acctMenuAdmin = document.getElementById("acctMenuAdmin");
  const acctMenuSignout = document.getElementById("acctMenuSignout");
  acctMenuCollection.addEventListener("click", () => closeMenu());
  acctMenuShowcase?.addEventListener("click", () => closeMenu());
  acctMenuSettings.addEventListener("click", () => closeMenu());
  if (acctMenuAdmin) acctMenuAdmin.addEventListener("click", () => closeMenu());

  let mode = "signin";
  let currentUser = null;
  const authListeners = [];
  const REMEMBER_ME_KEY = "ic.rememberMe.v1";
  const AUTH_HINT_KEY = "ic.authHint.v1";
  const REMEMBER_LOGIN_COOKIE = "poke_remember_login";
  const REMEMBER_LOGIN_MAX_AGE_SEC = 60 * 60 * 24 * 30;

  function loadRememberMePreference() {
    try {
      return localStorage.getItem(REMEMBER_ME_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveRememberMePreference(checked) {
    try {
      localStorage.setItem(REMEMBER_ME_KEY, checked ? "1" : "0");
    } catch {
      // ignore
    }
  }

  function readCookie(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    const parts = String(document.cookie || "").split(";");
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        try {
          return decodeURIComponent(trimmed.slice(prefix.length));
        } catch {
          return trimmed.slice(prefix.length);
        }
      }
    }
    return "";
  }

  function writeRememberLoginCookie(login) {
    const value = String(login || "").trim();
    const secure = location.protocol === "https:" ? "; Secure" : "";
    if (!value) {
      document.cookie = `${REMEMBER_LOGIN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
      return;
    }
    document.cookie = `${REMEMBER_LOGIN_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${REMEMBER_LOGIN_MAX_AGE_SEC}; SameSite=Lax${secure}`;
  }

  function clearRememberLoginCookie() {
    writeRememberLoginCookie("");
  }

  function applyRememberedLogin() {
    if (!acctEmail) return;
    const saved = readCookie(REMEMBER_LOGIN_COOKIE);
    if (saved && !String(acctEmail.value || "").trim()) {
      acctEmail.value = saved;
    }
  }

  function persistRememberLogin(login, rememberMe) {
    if (rememberMe) {
      writeRememberLoginCookie(login);
    } else {
      clearRememberLoginCookie();
    }
  }

  function saveAuthHint(user) {
    if (!user) {
      clearAuthHint();
      return;
    }
    try {
      localStorage.setItem(
        AUTH_HINT_KEY,
        JSON.stringify({
          signedIn: true,
          user: {
            id: user.id || "",
            email: user.email || "",
            username: user.username || "",
            name: user.name || "",
            isAdmin: Boolean(user.isAdmin),
            hasPassword: Boolean(user.hasPassword),
            picture: user.picture || "",
            showcaseUrl: user.showcaseUrl || "",
            preferences: {
              showCostBasis: Boolean(user.preferences?.showCostBasis),
              showUnrealizedPnL: Boolean(user.preferences?.showUnrealizedPnL)
            }
          }
        })
      );
    } catch {
      // ignore
    }
  }

  function clearAuthHint() {
    try {
      localStorage.removeItem(AUTH_HINT_KEY);
    } catch {
      // ignore
    }
  }

  function loadAuthHint() {
    try {
      const raw = localStorage.getItem(AUTH_HINT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.signedIn || !parsed?.user) return null;
      return parsed.user;
    } catch {
      return null;
    }
  }

  function markAuthButtonReady() {
    acctOpen.setAttribute("data-auth-ready", "1");
  }

  function isRememberMeChecked() {
    return Boolean(acctRemember?.checked);
  }

  function notifyAuthChange() {
    const detail = { signedIn: Boolean(currentUser), user: currentUser };
    document.dispatchEvent(new CustomEvent("infinity-auth-change", { detail }));
    for (const listener of authListeners) {
      try {
        listener(detail);
      } catch {
        /* listener error */
      }
    }
  }

  window.InfinityAccount = {
    isSignedIn: () => Boolean(currentUser),
    getUser: () => currentUser,
    openSignIn: () => openModal(),
    onChange: (listener) => {
      if (typeof listener !== "function") return;
      authListeners.push(listener);
      listener({ signedIn: Boolean(currentUser), user: currentUser });
    }
  };

  function setStatus(message, isError = false) {
    acctStatus.textContent = String(message || "");
    acctStatus.classList.toggle("error", Boolean(isError));
  }

  function setMode(nextMode) {
    mode = nextMode === "signup" ? "signup" : nextMode === "forgot" ? "forgot" : "signin";
    const isSignup = mode === "signup";
    const isForgot = mode === "forgot";
    acctTabSignIn.classList.toggle("active", mode === "signin");
    acctTabCreate.classList.toggle("active", isSignup);
    acctTabForgot.classList.toggle("active", isForgot);
    if (acctForgotHint) acctForgotHint.hidden = !isForgot;
    if (acctLoginHint) acctLoginHint.hidden = mode !== "signin";
    acctName.style.display = isSignup ? "block" : "none";
    acctUsername.style.display = isSignup ? "block" : "none";
    acctUsername.required = isSignup;
    acctEmail.placeholder = isSignup ? "Email" : isForgot ? "Email on your account" : "Username";
    acctEmail.type = isSignup || isForgot ? "email" : "text";
    acctEmail.autocomplete = isSignup || isForgot ? "email" : "username";
    acctEmail.setAttribute("inputmode", isSignup || isForgot ? "email" : "text");
    acctPassword.style.display = isForgot ? "none" : "block";
    acctPassword.required = !isForgot;
    acctPassword.autocomplete = isSignup ? "new-password" : "current-password";
    acctSubmit.textContent = isForgot ? "Send reset link" : isSignup ? "Create Account" : "Sign In";
    if (acctRememberWrap) {
      acctRememberWrap.style.display = mode === "signin" ? "flex" : "none";
    }
    if (acctGoogleWrap) {
      const showGoogle = !isForgot && acctGoogleWrap.dataset.ready === "1";
      acctGoogleWrap.hidden = !showGoogle;
      acctGoogleWrap.style.display = showGoogle ? "" : "none";
    }
    setStatus("");
  }

  function openModal() {
    syncAcctViewportSize();
    overlay.classList.add("open");
    try {
      window.google?.accounts?.id?.cancel();
    } catch {
      /* optional */
    }
  }

  function closeModal() {
    overlay.classList.remove("open");
    setStatus("");
  }

  function closeMenu() {
    acctMenu.classList.remove("open");
    acctOpen.setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    const isOpen = acctMenu.classList.toggle("open");
    acctOpen.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function setSignedOutView() {
    currentUser = null;
    clearAuthHint();
    if (acctMenuAdmin) {
      acctMenuAdmin.hidden = true;
      acctMenuAdmin.style.display = "none";
    }
    acctOpen.textContent = "Sign In";
    acctOpen.onclick = () => {
      closeMenu();
      openModal();
    };
    acctOpen.removeAttribute("aria-haspopup");
    acctOpen.removeAttribute("aria-expanded");
    closeMenu();
    markAuthButtonReady();
    notifyAuthChange();
  }

  async function signOut() {
    try {
      await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" });
    } catch {
      // still clear local session UI
    }
    setSignedOutView();
    window.location.assign("/");
  }

  function setSignedInView(user) {
    currentUser = user;
    saveAuthHint(user);
    if (acctMenuAdmin) {
      const isAdmin = Boolean(user?.isAdmin);
      acctMenuAdmin.hidden = !isAdmin;
      acctMenuAdmin.style.display = isAdmin ? "" : "none";
    }
    if (acctMenuShowcase) {
      const slug = String(user?.username || "").trim().toLowerCase();
      acctMenuShowcase.href = slug ? `/showcase/@${encodeURIComponent(slug)}` : "/showcase";
    }
    const label = user?.name || user?.username || user?.email || "Account";
    acctMenuHead.textContent = `Signed in as ${label}`;
    acctOpen.textContent = "Account";
    acctOpen.setAttribute("aria-haspopup", "menu");
    acctOpen.setAttribute("aria-expanded", "false");
    acctOpen.onclick = () => {
      if (!currentUser) return;
      toggleMenu();
    };
    acctMenuSignout.onclick = async () => {
      closeMenu();
      await signOut();
    };
    markAuthButtonReady();
    notifyAuthChange();
  }

  async function refreshUser() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!response.ok) {
        setSignedOutView();
        return;
      }
      const payload = await response.json();
      if (!payload?.signedIn || !payload?.user) {
        setSignedOutView();
        return;
      }
      setSignedInView(payload.user);
    } catch {
      setSignedOutView();
    }
  }

  const PREV_PAGE_KEY = "ic.prevPage.v1";
  const CUR_PAGE_KEY = "ic.currentPage.v1";

  function rememberPageHistory() {
    try {
      const current = window.location.href;
      const priorCurrent = sessionStorage.getItem(CUR_PAGE_KEY);
      if (priorCurrent && priorCurrent !== current) {
        sessionStorage.setItem(PREV_PAGE_KEY, priorCurrent);
      }
      sessionStorage.setItem(CUR_PAGE_KEY, current);
    } catch {
      // sessionStorage unavailable; fallback logic will use document.referrer/history.
    }
  }

  function getPreviousPageUrl() {
    try {
      const current = window.location.href;
      const stored = sessionStorage.getItem(PREV_PAGE_KEY);
      if (stored && stored !== current) return stored;
    } catch {
      // ignore storage access issues
    }

    const ref = String(document.referrer || "");
    if (ref && ref !== window.location.href) return ref;
    return "";
  }

  function goToPreviousPage() {
    const prev = getPreviousPageUrl();
    if (prev) {
      window.location.assign(prev);
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
    }
  }

  function trySetsBackNavigation(event) {
    const handler =
      typeof window.__icSetsBackNavigation === "function" ? window.__icSetsBackNavigation : null;
    if (!handler) return false;
    return handler(event) === true;
  }

  function isTypingNavigationTarget(target) {
    const tag = String(target?.tagName || "").toLowerCase();
    return (
      Boolean(target?.isContentEditable) ||
      tag === "input" ||
      tag === "textarea" ||
      tag === "select"
    );
  }

  acctClose.addEventListener("click", closeModal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal();
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(".acct-menu-wrap")) return;
    closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      if (overlay.classList.contains("open")) closeModal();
      return;
    }

    const isBrowserBackKey = event.key === "BrowserBack";
    if (isBrowserBackKey) {
      if (trySetsBackNavigation(event)) return;
      event.preventDefault();
      goToPreviousPage();
      return;
    }

    const target = event.target;
    const isTypingField = isTypingNavigationTarget(target);

    const isAltLeft = event.key === "ArrowLeft" && event.altKey && !event.ctrlKey && !event.metaKey;
    if (isAltLeft && !isTypingField) {
      if (trySetsBackNavigation(event)) return;
      event.preventDefault();
      goToPreviousPage();
      return;
    }

    const isBackspaceNav = event.key === "Backspace" && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (isBackspaceNav && !isTypingField) {
      if (trySetsBackNavigation(event)) return;
      event.preventDefault();
      goToPreviousPage();
    }
  });
  document.addEventListener(
    "auxclick",
    (event) => {
      if (event.button !== 3) return;
      if (event.target?.closest?.("a[href]")) return;
      if (isTypingNavigationTarget(event.target)) return;
      if (trySetsBackNavigation(event)) return;
      event.preventDefault();
      goToPreviousPage();
    },
    true
  );
  acctTabSignIn.addEventListener("click", () => setMode("signin"));
  acctTabCreate.addEventListener("click", () => setMode("signup"));
  acctTabForgot.addEventListener("click", () => setMode("forgot"));

  acctForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const login = String(acctEmail.value || "").trim();
    const username = String(acctUsername.value || "").trim();
    const password = String(acctPassword.value || "");
    const name = String(acctName.value || "").trim();

    if (mode === "forgot") {
      if (!login || !login.includes("@")) {
        setStatus("Enter the email address on your account.", true);
        return;
      }
      setStatus("Sending...");
      try {
        const response = await fetch("/api/auth/forgot-password", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: login })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.ok) {
          setStatus(payload?.error || "Could not send reset email.", true);
          return;
        }
        if (payload.mailConfigured === false) {
          setStatus(
            "Password reset email is not set up on this server yet (SMTP is not configured). Use Google sign-in, or ask the site owner to add SMTP settings.",
            true
          );
          return;
        }
        if (payload.emailSent === false) {
          setStatus(
            payload.message ||
              "Could not send the email. Try again later or sign in with Google.",
            true
          );
          return;
        }
        setStatus(payload.message || "If an account exists for that email, a reset link has been sent.");
      } catch {
        setStatus("Network error. Please try again.", true);
      }
      return;
    }

    if (!login || !password) {
      setStatus("Username and password are required.", true);
      return;
    }
    setStatus("Working...");
    try {
      const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/signin";
      const rememberMe = mode === "signin" ? isRememberMeChecked() : true;
      if (mode === "signin") {
        saveRememberMePreference(rememberMe);
      }
      const body = mode === "signup"
        ? { email: login, username, password, name }
        : { login, password, rememberMe };
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        setStatus(payload?.error || "Unable to complete request.", true);
        return;
      }
      if (mode === "signin") {
        persistRememberLogin(login, rememberMe);
      }
      setSignedInView(payload.user || null);
      acctPassword.value = "";
      if (mode === "signup") {
        acctUsername.value = "";
      }
      setStatus("Success. You are signed in.");
      setTimeout(closeModal, 300);
    } catch {
      setStatus("Network error. Please try again.", true);
    }
  });

  const GSI_SCRIPT = "https://accounts.google.com/gsi/client";

  function loadScriptOnce(src) {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      return new Promise((resolve, reject) => {
        if (window.google?.accounts?.id) {
          resolve();
          return;
        }
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("script load failed")), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script load failed"));
      document.head.appendChild(s);
    });
  }

  let googleSignInBusy = false;

  async function handleGoogleCredential(credential) {
    if (!credential || googleSignInBusy) return;
    googleSignInBusy = true;
    setStatus("Working...");
    try {
      const rememberMe = isRememberMeChecked();
      saveRememberMePreference(rememberMe);
      const response = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ credential, rememberMe })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        setStatus(payload?.error || "Google sign-in failed.", true);
        return;
      }
      const rememberedLogin =
        String(payload.user?.email || payload.user?.username || "").trim();
      if (rememberedLogin) {
        persistRememberLogin(rememberedLogin, rememberMe);
      } else if (!rememberMe) {
        clearRememberLoginCookie();
      }
      setSignedInView(payload.user || null);
      setStatus("Success. You are signed in.");
      setTimeout(closeModal, 300);
    } catch {
      setStatus("Network error. Please try again.", true);
    } finally {
      googleSignInBusy = false;
    }
  }

  async function initGoogleSignIn() {
    if (window.__icGoogleSignInInit) return;
    try {
      const r = await fetch("/api/auth/google-config");
      const cfg = await r.json().catch(() => ({}));
      if (!r.ok || !cfg?.clientId) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            "[account] Google sign-in hidden: /api/auth/google-config missing or empty. Restart the backend with the latest server.js and set GOOGLE_CLIENT_ID in backend/.env."
          );
        }
        return;
      }
      await loadScriptOnce(GSI_SCRIPT);
      if (!window.google?.accounts?.id) return;

      window.__icGoogleSignInInit = true;
      window.google.accounts.id.disableAutoSelect();

      window.google.accounts.id.initialize({
        client_id: cfg.clientId,
        ux_mode: "popup",
        auto_select: false,
        cancel_on_tap_outside: true,
        itp_support: true,
        callback: (resp) => {
          void handleGoogleCredential(resp?.credential);
        }
      });

      const slot = document.getElementById("acctGoogle");
      if (slot) {
        slot.replaceChildren();
        window.google.accounts.id.renderButton(slot, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          width: 360,
          logo_alignment: "left",
          use_fedcm_for_button: false,
          button_auto_select: false
        });
      }

      acctGoogleWrap.dataset.ready = "1";
      const showGoogle = mode !== "forgot";
      acctGoogleWrap.hidden = !showGoogle;
      acctGoogleWrap.style.display = showGoogle ? "" : "none";
    } catch {
      /* Google optional */
    }
  }

  if (acctRemember) {
    acctRemember.checked = loadRememberMePreference();
    acctRemember.addEventListener("change", () => {
      saveRememberMePreference(acctRemember.checked);
      if (!acctRemember.checked) {
        clearRememberLoginCookie();
      } else {
        const login = String(acctEmail?.value || "").trim();
        if (login) {
          writeRememberLoginCookie(login);
        }
      }
    });
  }
  setMode("signin");
  applyRememberedLogin();
  // Optimistic Account label from last session — avoids Sign In flash while /api/auth/me runs.
  const authHint = loadAuthHint();
  if (authHint) {
    setSignedInView(authHint);
  }
  rememberPageHistory();
  refreshUser();
  initGoogleSignIn();
})();
