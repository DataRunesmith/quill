const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const num = (v) => Number(v || 0).toLocaleString("sv-SE");
const fmtDate = (v) => (v ? new Date(Number(v)).toLocaleString("sv-SE") : "");
const state = {
  me: null,
  view: "home",
  publicView: "home",
  settings: "mail",
  admin: "accounts",
  step: 1,
  areas: null,
  parties: null,
  roles: null,
  credentials: null,
  jobs: null,
  files: [],
  introPresets: null,
  selectedIntroIds: new Set(),
  useBroadAudienceIntro: false,
  selectedAreas: new Set(),
  publicLevels: new Set(["riksdag"]),
  pendingAreaTypes: null,
  excludeParties: new Set(),
  includeRoles: new Set(),
  excludeBodies: new Set(),
  mediaCategories: new Set(),
  academicFields: new Set(),
  includeEmails: new Map(),
  excludeEmails: new Map(),
};
const POLICY_AREAS = [
  ["ledning", "Kommun-/regionstyrelse"],
  ["social-omsorg", "Social & omsorg"],
  ["utbildning", "Skola & utbildning"],
  ["halso-sjukvard", "Hälso- & sjukvård"],
  ["samhallsbyggnad", "Samhällsbyggnad"],
  ["miljo", "Miljö"],
  ["teknik-infrastruktur", "Teknik & infrastruktur"],
  ["kultur-fritid", "Kultur & fritid"],
  ["arbetsmarknad-naringsliv", "Arbetsmarknad & näringsliv"],
  ["regional-utveckling", "Regional utveckling"],
  ["raddning-samhallsskydd", "Räddning & samhällsskydd"],
];
const MEDIA_CATEGORIES = [
  ["politik", "Politik"],
  ["opinion-debatt", "Opinion & debatt"],
  ["nyhetsredaktion", "Nyhetsredaktion"],
];
const ACADEMIC_FIELDS = [
  ["political-science", "Statsvetenskap"],
  ["public-administration", "Offentlig förvaltning"],
  ["public-law", "Offentlig rätt / förvaltningsrätt"],
];
const PUBLIC_LEVELS = [
  ["riksdag", "Riksdagen", "Ledamöter och partier", "Nationell nivå", "/icon-level-bank.svg"],
  [
    "regering",
    "Regeringen",
    "Statsråd och departement",
    "Nationell nivå",
    "/icon-level-buildings.svg",
  ],
  ["region", "Regioner", "21 regionala församlingar", "Regional nivå", "/icon-level-map-pin.svg"],
  ["kommun", "Kommuner", "290 kommuner i Sverige", "Lokal nivå", "/icon-level-house.svg"],
  ["eu", "EU-parlamentet", "Sveriges folkvalda i EU", "Europeisk nivå", "/icon-level-globe.svg"],
  [
    "media",
    "Media",
    "Redaktioner och opinionssidor",
    "Offentlig debatt",
    "/icon-level-newspaper.svg",
  ],
  [
    "academia",
    "Akademi",
    "Forskare och lärare inom politik, förvaltning och offentlig rätt",
    "Kunskap & analys",
    "/icon-level-bank.svg",
  ],
  ["kyrka", "Svenska kyrkan", "Valda organ och stift", "Förtroendevalda", "/icon-level-church.svg"],
];

async function rawApi(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  let d = {};
  try {
    d = await r.json();
  } catch {}
  if (!r.ok) {
    const err = new Error(d.error || `HTTP ${r.status}`);
    err.code = d.code;
    err.status = r.status;
    throw err;
  }
  return d;
}
let reauthPromise = null,
  modalCancel = null;
async function api(path, opts = {}) {
  try {
    return await rawApi(path, opts);
  } catch (err) {
    if (err.code !== "FRESH_AUTH_REQUIRED") throw err;
    await ensureFreshAuthentication();
    return rawApi(path, opts);
  }
}
async function ensureFreshAuthentication() {
  if (reauthPromise) return reauthPromise;
  reauthPromise = runReauthentication().finally(() => {
    reauthPromise = null;
  });
  return reauthPromise;
}
async function runReauthentication() {
  if (!state.me?.loggedIn) throw new Error("Logga in för att fortsätta.");
  if (!state.me.passwordSetByUser && !state.me.totpEnabled) return externalReauthentication();
  return new Promise((resolve, reject) => {
    const passwordField = state.me.passwordSetByUser
      ? '<div class="field"><label for="reauth-password">Lösenord</label><input class="input" id="reauth-password" name="password" type="password" autocomplete="current-password" required></div>'
      : "";
    const totpField = state.me.totpEnabled
      ? '<div class="field"><label for="reauth-totp">2FA-kod</label><input class="input" id="reauth-totp" name="totpCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>'
      : "";
    showModal(
      "Bekräfta att det är du",
      `<form id="reauth-form" class="stack"><p class="muted">Av säkerhetsskäl behöver du verifiera dig igen. Du stannar kvar på samma sida.</p>${passwordField}${totpField}<div id="reauth-error"></div><div class="row"><button class="button button--primary" type="submit">Fortsätt</button><button class="button button--quiet" id="reauth-cancel" type="button">Avbryt</button></div></form>`,
    );
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      modalCancel = null;
      reject(new Error("Verifieringen avbröts."));
    };
    modalCancel = cancel;
    $("#reauth-cancel").onclick = () => closeModal();
    $("#reauth-form").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        submit = $('button[type="submit"]', form),
        data = Object.fromEntries(new FormData(form));
      submit.disabled = true;
      try {
        await rawApi("/api/reauth", { method: "POST", body: JSON.stringify(data) });
        settled = true;
        modalCancel = null;
        closeModal();
        resolve();
      } catch (err) {
        submit.disabled = false;
        $("#reauth-error").innerHTML =
          `<div class="notice notice--error">${esc(err.message)}</div>`;
      }
    };
    setTimeout(() => $("#reauth-password,#reauth-totp")?.focus(), 0);
  });
}
async function externalReauthentication() {
  const identities = await rawApi("/api/oauth-identities");
  const supported = identities.filter((x) => x.provider === "google" || x.provider === "microsoft");
  if (!supported.length)
    throw new Error("Kontot saknar ett inloggningssätt som kan användas för återautentisering.");
  return new Promise((resolve, reject) => {
    const links = supported
      .map(
        (x) =>
          `<a class="button button--secondary" data-reauth-provider="${esc(x.provider)}" href="/api/oauth/${encodeURIComponent(x.provider)}/start">${esc(providerName(x.provider))}</a>`,
      )
      .join("");
    showModal(
      "Bekräfta att det är du",
      `<div class="stack"><p class="muted">Verifiera dig igen med ditt vanliga inloggningssätt. Du behöver inte logga ut.</p><div class="row">${links}</div><button class="button button--quiet" id="reauth-cancel" type="button">Avbryt</button></div>`,
    );
    let settled = false;
    modalCancel = () => {
      if (settled) return;
      settled = true;
      modalCancel = null;
      reject(new Error("Verifieringen avbröts."));
    };
    $("#reauth-cancel").onclick = () => closeModal();
    $$("[data-reauth-provider]").forEach(
      (link) =>
        (link.onclick = () => {
          settled = true;
          modalCancel = null;
          sessionStorage.setItem(
            "pending:route",
            location.hash.replace(/^#/, "") || "settings/mail",
          );
        }),
    );
  });
}
function button(label, kind = "secondary", handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `button button--${kind}`;
  b.textContent = label;
  if (handler) b.onclick = handler;
  return b;
}
function notice(text, type = "info") {
  sessionStorage.setItem("ui:lastNotice", JSON.stringify({ text, type, ts: Date.now() }));
  renderNotice();
}
function renderNotice() {
  const host = $("#global-notices");
  if (!host) return;
  host.innerHTML = "";
  let x = null;
  try {
    x = JSON.parse(sessionStorage.getItem("ui:lastNotice") || "null");
  } catch {}
  if (!x || Date.now() - x.ts > 86400000) {
    sessionStorage.removeItem("ui:lastNotice");
    return;
  }
  const n = document.createElement("div");
  n.className = `notice ${x.type === "error" ? "notice--error" : x.type === "success" ? "notice--success" : x.type === "warning" ? "notice--warning" : ""}`;
  n.innerHTML = `<span>${esc(x.text)}</span>`;
  n.append(
    button("Stäng", "quiet", () => {
      sessionStorage.removeItem("ui:lastNotice");
      renderNotice();
    }),
  );
  host.append(n);
}
function showModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal").hidden = false;
  document.body.classList.add("is-locked");
}
function closeModal() {
  const cancel = modalCancel;
  modalCancel = null;
  $("#modal").hidden = true;
  $("#modal-body").innerHTML = "";
  document.body.classList.remove("is-locked");
  if (cancel) cancel();
}
function openMenu() {
  $("#mobile-menu").hidden = false;
  $("#menu-button").setAttribute("aria-expanded", "true");
  document.body.classList.add("is-locked");
}
function closeMenu() {
  $("#mobile-menu").hidden = true;
  $("#menu-button").setAttribute("aria-expanded", "false");
  document.body.classList.remove("is-locked");
}
function route() {
  return location.hash.replace(/^#/, "").split("/").filter(Boolean);
}
function applyRoute() {
  const p = route(),
    v = p[0] || "home";
  state.view = ["home", "send", "jobs", "settings", "admin"].includes(v) ? v : "home";
  if (state.view === "settings" && ["mail", "intros", "account", "security", "api"].includes(p[1]))
    state.settings = p[1];
  if (state.view === "admin" && ["accounts", "sends", "stats", "feedback"].includes(p[1]))
    state.admin = p[1];
  if (state.view === "send" && ["1", "2", "3"].includes(p[1])) state.step = Number(p[1]);
  if (state.view === "admin" && !state.me?.isAdmin) state.view = "home";
}
function go(v) {
  state.view = v;
  const next =
    v === "home"
      ? "home"
      : v === "send"
        ? `send/${state.step}`
        : v === "settings"
          ? `settings/${state.settings}`
          : v === "admin"
            ? `admin/${state.admin}`
            : v;
  if (location.hash === `#${next}`) {
    renderApp();
    return;
  }
  location.hash = next;
}
function pageHead(title, lead = "") {
  return `<div class="page-head"><h1>${esc(title)}</h1>${lead ? `<p>${esc(lead)}</p>` : ""}</div>`;
}
function navItems() {
  const items = [
    ["home", "Start"],
    ["send", "Nytt utskick"],
    ["jobs", "Utskick"],
  ];
  if (state.me?.loggedIn) items.push(["settings", "Inställningar"]);
  if (state.me?.isAdmin) items.push(["admin", "Admin"]);
  return items;
}
function showShell() {
  $("#service-band").hidden = false;
  $("#app-header").hidden = false;
  $("#app-footer").hidden = false;
  document.body.classList.toggle("is-signed-in", !!state.me?.loggedIn);
  document.body.classList.toggle("is-signed-out", !state.me?.loggedIn);
  $("#footer-feedback").onclick = openFeedback;
  for (const link of $$(".brand,.site-footer__brand"))
    link.onclick = (e) => {
      if (state.me?.loggedIn) return;
      e.preventDefault();
      returnToPublicHome();
    };
}
function renderNav() {
  const loggedIn = !!state.me?.loggedIn;
  for (const sel of ["#primary-nav", "#mobile-nav"]) {
    const host = $(sel);
    host.innerHTML = "";
    for (const [id, label] of navItems()) {
      const handler = () => {
        closeMenu();
        if (loggedIn) go(id);
        else if (id === "home") returnToPublicHome();
        else if (id === "send") beginPublicSend();
        else beginPublicRoute(id);
      };
      const b = button(label, "quiet", handler);
      const current = loggedIn ? state.view === id : state.publicView === "home" && id === "home";
      b.setAttribute("aria-current", current ? "page" : "false");
      host.append(b);
    }
    if (sel === "#mobile-nav") {
      const faq = document.createElement("a");
      faq.className = "button button--quiet";
      faq.href = "/faq.html";
      faq.textContent = "FAQ";
      host.append(faq);
      host.append(
        button("Kontakt & feedback", "quiet", () => {
          closeMenu();
          openFeedback();
        }),
      );
      host.append(
        button(
          loggedIn ? "Logga ut" : "Logga in",
          "quiet",
          loggedIn
            ? logout
            : () => {
                closeMenu();
                renderAuth();
              },
        ),
      );
    }
  }
  const session = $("#session-button");
  session.hidden = loggedIn;
  if (!loggedIn) {
    session.innerHTML =
      state.publicView === "auth"
        ? "Till startsidan"
        : '<img class="button__icon" src="/icon-sign-in.svg" alt=""><span>Logga in</span>';
    session.onclick = state.publicView === "auth" ? returnToPublicHome : renderAuth;
  }
}
async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

let turnstilePromise;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstilePromise) return turnstilePromise;
  turnstilePromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = reject;
    document.head.append(s);
  });
  return turnstilePromise;
}
async function renderTurnstiles() {
  try {
    const t = await loadTurnstile();
    $$(".cf-turnstile").forEach((el) => {
      if (el.dataset.rendered) return;
      el.dataset.rendered = "1";
      if (!el.dataset.sitekey) return el.remove();
      t.render(el, { sitekey: el.dataset.sitekey, action: el.dataset.action });
    });
  } catch {
    console.warn("Turnstile kunde inte laddas i den här webbläsaren.");
  }
}
const googleLogo =
  '<svg class="provider-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.37l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.92A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.92V7.46H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.54l3.35-2.62Z"/><path fill="#EA4335" d="M12 5.95c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.46l3.35 2.62C7.18 7.71 9.39 5.95 12 5.95Z"/></svg>';
const microsoftLogo =
  '<svg class="provider-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="#f25022" d="M2 2h9.5v9.5H2z"/><path fill="#7fba00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00a4ef" d="M2 12.5h9.5V22H2z"/><path fill="#ffb900" d="M12.5 12.5H22V22h-9.5z"/></svg>';

function heroProof() {
  return `<div class="hero-proof" aria-label="Tjänstens huvudprinciper"><div class="hero-proof__item"><img src="/icon-lock.png" alt=""><span><strong>Ditt e-postkonto</strong><small>Du står alltid som avsändare</small></span></div><div class="hero-proof__item"><img src="/icon-many.png" alt=""><span><strong>Flera samtidigt</strong><small>Välj en eller flera nivåer</small></span></div><div class="hero-proof__item"><img src="/icon-send.png" alt=""><span><strong>Enkelt att skicka</strong><small>Ett tydligt flöde i tre steg</small></span></div><div class="hero-proof__item"><img src="/icon-shield.png" alt=""><span><strong>Integritet först</strong><small>Minsta möjliga datamängd</small></span></div></div>`;
}
function homeLevels(loggedIn) {
  return PUBLIC_LEVELS.map(
    ([id, title, caption, meta, icon]) =>
      `<button class="level-card${!loggedIn && state.publicLevels.has(id) ? " is-selected" : ""}" type="button" ${loggedIn ? `data-app-level="${id}"` : `data-public-level="${id}" aria-pressed="${state.publicLevels.has(id)}"`}><span class="level-card__icon"><img src="${icon}" alt=""></span><span class="level-card__copy"><strong>${title}</strong><span>${caption}</span><small>${meta}</small></span></button>`,
  ).join("");
}
function heroImage() {
  return `<picture><source media="(max-width:760px)" srcset="/civic-hero-1280.webp" type="image/webp"><source srcset="/civic-hero.webp" type="image/webp"><img class="hero__image" src="/civic-hero.png" alt="Svensk flagga och Stockholms stadshus i skymning" width="1672" height="941" fetchpriority="high"></picture>`;
}
function marketingHome(loggedIn) {
  return `<div class="home-page"><section class="hero">${heroImage()}<div class="hero__veil" aria-hidden="true"></div><div class="hero__inner"><div class="hero__copy"><div class="card__eyebrow"><img src="/icon-bank-fill.svg" alt="">För svensk demokrati</div><h1>Din röst ska hitta fram.</h1><p>Välj folkvalda, redaktioner eller akademiska mottagare. Skriv med dina egna ord och skicka från ditt eget e-postkonto.</p><div class="row hero__actions"><button class="button button--primary" id="${loggedIn ? "new-send" : "public-start"}" type="button"><span>Välj mottagare</span><img class="button__icon" src="/icon-arrow-right-bold.svg" alt=""></button><button class="button button--secondary" id="${loggedIn ? "see-jobs" : "public-about"}" type="button">${loggedIn ? "Visa utskick" : "Så fungerar det"}</button></div></div>${heroProof()}</div></section><section class="level-section" id="mottagare"><div class="content-shell"><div class="section-heading"><div><span class="section-eyebrow">Offentliga mottagare</span><h2>Vem vill du nå?</h2></div><p>Välj brett först. Du kan avgränsa område, parti, roll eller enskild person i nästa steg.</p></div><div class="level-grid">${homeLevels(loggedIn)}</div>${loggedIn ? "" : `<div class="selection-bar"><span><strong id="public-selection-count">${state.publicLevels.size}</strong> <span id="public-selection-label">${state.publicLevels.size === 1 ? "mottagargrupp vald" : "mottagargrupper valda"}</span></span><button class="button button--primary" id="public-continue" type="button" ${state.publicLevels.size ? "" : "disabled"}>Fortsätt till urvalet</button></div>`}</div></section><section class="process-section" id="sa-fungerar-det"><div class="content-shell process-grid"><div class="process-intro"><span class="section-eyebrow">En rak väg fram</span><h2>Från dig. Till dem. På dina villkor.</h2><p>Quill är infrastruktur för din kommunikation. Tjänsten skriver inte åt dig och tar inte politisk ställning.</p></div><ol class="process-list"><li><span>01</span><div><strong>Välj mottagare</strong><p>Nationellt, regionalt, lokalt eller enskilt.</p></div></li><li><span>02</span><div><strong>Skriv brevet</strong><p>Formulera ditt eget budskap direkt i tjänsten.</p></div></li><li><span>03</span><div><strong>Granska och skicka</strong><p>Du ser urvalet innan något går iväg.</p></div></li></ol></div></section><section class="neutrality-section" id="integritet"><div class="content-shell neutrality-card"><div><strong>Oberoende samhällstjänst — inte en myndighet</strong><p>Kontaktuppgifterna bygger på offentliga källor. Plattformen är partipolitiskt neutral och du är alltid avsändare.</p></div></div></section></div>`;
}
function clearPendingPublicIntent() {
  for (const key of ["pending:areaTypes", "pending:startSend", "pending:route"])
    sessionStorage.removeItem(key);
}
function clearRecipientSelection() {
  state.selectedAreas.clear();
  state.excludeParties.clear();
  state.includeRoles.clear();
  state.excludeBodies.clear();
  state.mediaCategories.clear();
  state.academicFields.clear();
  state.includeEmails.clear();
  state.excludeEmails.clear();
  state.privateSelectedContactIds?.clear();
  state.privateSelectedListIds?.clear();
  state.oneTimeRecipients?.clear();
  state.pendingAreaTypes = null;
}
function beginPublicSend() {
  if (!state.publicLevels.size) {
    $("#mottagare")?.scrollIntoView({ behavior: "smooth" });
    return;
  }
  sessionStorage.removeItem("pending:route");
  sessionStorage.setItem("pending:areaTypes", JSON.stringify([...state.publicLevels]));
  sessionStorage.setItem("pending:startSend", "1");
  renderAuth();
}
function beginPublicRoute(id) {
  clearPendingPublicIntent();
  sessionStorage.setItem("pending:route", id);
  renderAuth();
}
function applyPendingPublicAreas() {
  const pending = state.pendingAreaTypes;
  if (!pending) return;
  clearRecipientSelection();
  for (const area of state.areas || [])
    if (pending.has(area.area_type)) state.selectedAreas.add(area.area_name);
}
function resetShellForAuth() {
  closeMenu();
  showShell();
}
function returnToPublicHome() {
  clearPendingPublicIntent();
  const url = new URL(location.href);
  url.searchParams.delete("reset");
  url.hash = "home";
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  renderPublicHome($("#root"));
}
function syncPublicSelection() {
  const count = $("#public-selection-count"),
    label = $("#public-selection-label"),
    next = $("#public-continue");
  if (count) count.textContent = String(state.publicLevels.size);
  if (label)
    label.textContent =
      state.publicLevels.size === 1 ? "mottagargrupp vald" : "mottagargrupper valda";
  if (next) next.disabled = state.publicLevels.size === 0;
}
function renderPublicHome(root = $("#root")) {
  state.publicView = "home";
  state.me = { loggedIn: false };
  const url = new URL(location.href);
  url.searchParams.delete("reset");
  if (!url.hash) url.hash = "home";
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  showShell();
  renderNav();
  root.innerHTML = marketingHome(false);
  $("#public-start").onclick = beginPublicSend;
  $("#public-continue").onclick = beginPublicSend;
  $("#public-about").onclick = () => $("#sa-fungerar-det").scrollIntoView({ behavior: "smooth" });
  syncPublicSelection();
  $$("[data-public-level]").forEach(
    (card) =>
      (card.onclick = () => {
        const id = card.dataset.publicLevel;
        if (state.publicLevels.has(id)) state.publicLevels.delete(id);
        else state.publicLevels.add(id);
        card.classList.toggle("is-selected", state.publicLevels.has(id));
        card.setAttribute("aria-pressed", String(state.publicLevels.has(id)));
        syncPublicSelection();
      }),
  );
}
function renderAuth() {
  state.publicView = "auth";
  resetShellForAuth();
  renderNav();
  const root = $("#root");
  root.innerHTML = `<div class="auth-page"><section class="auth-scene"><div class="auth-scene__inner"><div class="card__eyebrow">Ditt konto</div><h1>Din röst ska hitta fram.</h1><p>Logga in för att välja mottagare, skriva ditt brev och skicka från ditt eget e-postkonto.</p></div></section><div class="page page--narrow auth-content"><div class="auth-brand"><div class="card__eyebrow">Quill</div><h1>Logga in eller skapa konto.</h1><p class="muted">Plattformen blir aldrig avsändare. Du behåller kontrollen över mottagare, innehåll och takt.</p></div><div class="auth"><section class="card"><div class="card__eyebrow">Inloggning</div><h2>Logga in</h2><div class="oauth"><a class="button button--secondary" href="/api/oauth/google/start">${googleLogo}<span>Google</span></a><a class="button button--secondary" href="/api/oauth/microsoft/start">${microsoftLogo}<span>Microsoft</span></a></div><div class="divider">eller</div><form id="login-form" class="stack"><div class="field"><label for="login-email">E-post</label><input class="input" id="login-email" name="email" type="email" autocomplete="username" required></div><div class="field"><label for="login-password">Lösenord</label><input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required></div><div class="field" id="totp-row" hidden><label for="login-totp">2FA-kod</label><input class="input" id="login-totp" name="totpCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"></div><button class="button button--primary button--block" type="submit">Logga in</button><button class="button button--quiet button--block" id="forgot-btn" type="button">Glömt lösenord?</button></form><div id="auth-msg" class="section"></div></section><section class="card"><div class="card__eyebrow">Nytt konto</div><h2>Skapa konto</h2><form id="signup-form" class="stack"><div class="field"><label>E-post</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="field"><label>Lösenord</label><input class="input" name="password" type="password" minlength="10" autocomplete="new-password" required><span class="field__hint">Minst 10 tecken.</span></div><div class="cf-turnstile" data-sitekey="__TURNSTILE_SITE_KEY__" data-action="turnstile-spin-v1"></div><button class="button button--primary button--block" type="submit">Skapa konto</button></form><div id="signup-msg" class="section"></div></section></div></div></div>`;
  renderTurnstiles();
  $("#login-form").onsubmit = loginSubmit;
  $("#signup-form").onsubmit = signupSubmit;
  $("#forgot-btn").onclick = forgotPassword;
}
async function loginSubmit(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: f.get("email"),
        password: f.get("password"),
        totpCode: f.get("totpCode") || undefined,
      }),
    });
    location.reload();
  } catch (err) {
    if (err.message === "TOTP_REQUIRED") {
      const row = $("#totp-row");
      row.hidden = false;
      const code = $("#login-totp");
      code.value = "";
      code.required = true;
      $("#auth-msg").innerHTML =
        '<div class="notice notice--warning">Ange koden från din autentiseringsapp.</div>';
      setTimeout(() => {
        code.focus({ preventScroll: true });
        code.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 0);
    } else $("#auth-msg").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
  }
}
async function signupSubmit(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  try {
    const d = await api("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        email: f.get("email"),
        password: f.get("password"),
        turnstileToken: f.get("cf-turnstile-response"),
      }),
    });
    if (d.verified) {
      notice("Kontot är skapat. Logga in.", "success");
      return;
    }
    showModal(
      "Bekräfta e-post",
      `<form id="verify-form" class="stack"><p class="muted">Ange den sexsiffriga koden som skickades till din adress.</p><div class="field"><label>Kod</label><input class="input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div><button class="button button--primary" type="submit">Bekräfta</button></form>`,
    );
    $("#verify-form").onsubmit = async (x) => {
      x.preventDefault();
      try {
        await api("/api/verify", {
          method: "POST",
          body: JSON.stringify({
            accountId: d.accountId,
            code: new FormData(x.currentTarget).get("code"),
          }),
        });
        closeModal();
        notice("Kontot är verifierat. Logga in.", "success");
      } catch (err) {
        notice(err.message, "error");
      }
    };
  } catch (err) {
    $("#signup-msg").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
  }
}
function forgotPassword() {
  showModal(
    "Återställ lösenord",
    `<form id="forgot-form" class="stack"><div class="field"><label>E-post</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="cf-turnstile" data-sitekey="__TURNSTILE_SITE_KEY__" data-action="turnstile-spin-v1"></div><button class="button button--primary" type="submit">Skicka återställningslänk</button></form>`,
  );
  renderTurnstiles();
  $("#forgot-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api("/api/request-password-reset", {
      method: "POST",
      body: JSON.stringify({
        email: f.get("email"),
        turnstileToken: f.get("cf-turnstile-response"),
      }),
    }).catch(() => {});
    closeModal();
    notice("Om adressen finns skickas en återställningslänk.", "success");
  };
}
function renderReset(token) {
  state.publicView = "auth";
  resetShellForAuth();
  renderNav();
  $("#root").innerHTML =
    `<div class="page page--narrow reset-page"><section class="card"><div class="card__eyebrow">Kontosäkerhet</div><h1>Sätt nytt lösenord</h1><p class="muted">Tvåfaktorsautentisering förblir aktiv efter lösenordsåterställningen. Använd din befintliga autentiseringsapp vid nästa inloggning.</p><form id="reset-form" class="stack"><div class="field"><label>Nytt lösenord</label><input class="input" name="password" type="password" minlength="10" autocomplete="new-password" required></div><div class="field"><label>Bekräfta lösenord</label><input class="input" name="password2" type="password" minlength="10" autocomplete="new-password" required></div><button class="button button--primary" type="submit">Spara nytt lösenord</button></form><div id="reset-msg" class="section"></div></section></div>`;
  $("#reset-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("password2")) {
      $("#reset-msg").innerHTML =
        '<div class="notice notice--error">Lösenorden matchar inte.</div>';
      return;
    }
    try {
      await api("/api/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword: f.get("password") }),
      });
      history.replaceState(null, "", "/");
      $("#reset-msg").innerHTML =
        '<div class="notice notice--success">Lösenordet är ändrat. Du kan logga in nu.</div>';
    } catch (err) {
      $("#reset-msg").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  };
}

function renderApp() {
  state.publicView = "app";
  showShell();
  renderNav();
  const root = $("#root");
  root.innerHTML = "";
  (
    ({
      home: renderHome,
      send: renderSend,
      jobs: renderJobs,
      settings: renderSettings,
      admin: renderAdmin,
    })[state.view] || renderHome
  )(root);
}
function renderHome(root) {
  root.innerHTML = marketingHome(true);
  $("#new-send").onclick = () => go("send");
  $("#see-jobs").onclick = () => go("jobs");
  $$("[data-app-level]").forEach(
    (card) =>
      (card.onclick = () => {
        clearRecipientSelection();
        state.pendingAreaTypes = new Set([card.dataset.appLevel]);
        state.step = 1;
        go("send");
      }),
  );
}
