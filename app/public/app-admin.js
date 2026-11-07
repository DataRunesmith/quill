const adminCache = new Map();
const clearRecipientSelectionBase = clearRecipientSelection;
clearRecipientSelection = function () {
  clearRecipientSelectionBase();
  initPrivateRecipientState();
  state.privateSelectedContactIds.clear();
  state.privateSelectedListIds.clear();
  state.oneTimeRecipients.clear();
};
async function adminData(key, path, ttl = 15000, force = false) {
  const now = Date.now(),
    hit = adminCache.get(key);
  if (!force && hit && now - hit.ts < ttl) return hit.data;
  const data = await api(path);
  adminCache.set(key, { data, ts: now });
  return data;
}
function warmAdmin() {
  if (!state.me?.isAdmin) return;
  for (const [key, path] of [
    ["accounts", "/api/admin/accounts"],
    ["stats", "/api/admin/stats"],
    ["feedback", "/api/admin/feedback"],
  ])
    adminData(key, path, 20000).catch(() => {});
}
async function renderAdmin(root) {
  if (!state.me?.isAdmin) {
    go("home");
    return;
  }
  root.innerHTML = `<div class="page">${pageHead("Admin", "Konton, utskick, statistik och feedback.")}<div id="admin-tabs" class="segmented"></div><section id="admin-panel" class="section"><div class="empty">Laddar…</div></section></div>`;
  for (const [id, label] of [
    ["accounts", "Konton"],
    ["sends", "Utskick"],
    ["stats", "Statistik"],
    ["feedback", "Feedback"],
  ]) {
    const l = document.createElement("label"),
      i = document.createElement("input"),
      s = document.createElement("span");
    i.type = "radio";
    i.name = "admin-tab";
    i.checked = state.admin === id;
    s.textContent = label;
    i.onchange = () => {
      state.admin = id;
      location.hash = `admin/${id}`;
      renderAdmin(root);
    };
    l.append(i, s);
    $("#admin-tabs").append(l);
  }
  await { accounts: adminAccounts, sends: adminSends, stats: adminStats, feedback: adminFeedback }
    [state.admin]()
    .catch((err) => {
      $("#admin-panel").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    });
}
async function adminAccounts(force = false) {
  const rows = await adminData("accounts", "/api/admin/accounts", 15000, force),
    p = $("#admin-panel");
  p.innerHTML = `<section class="card"><div class="field"><label>Sök konto</label><input class="input" id="account-search" placeholder="E-post eller konto-id"></div><div id="account-list" class="list section"></div></section>`;
  const host = $("#account-list");
  for (const a of rows) {
    const d = document.createElement("div");
    d.className = "admin-row";
    d.dataset.search = `${a.email} ${a.id}`.toLowerCase();
    d.innerHTML = `<div class="row row--between"><div><div class="card__title">${esc(a.email)}</div><div class="card__meta">${esc(a.id)} · ${a.is_admin ? "Admin · " : ""}${a.disabled ? "Inaktiverat" : "Aktivt"}</div></div><div class="row"><button class="button button--secondary reset">Återställ lösenord</button><button class="button button--secondary toggle">${a.disabled ? "Aktivera" : "Inaktivera"}</button>${a.email !== state.me.email ? '<button class="button button--danger remove">Radera</button>' : ""}</div></div>`;
    $(".reset", d).onclick = async () => {
      await api(`/api/admin/accounts/${a.id}/reset-password`, { method: "POST" });
      notice("Återställningslänk skickad.", "success");
    };
    $(".toggle", d).onclick = async () => {
      await api(`/api/admin/accounts/${a.id}/toggle-disabled`, {
        method: "POST",
        body: JSON.stringify({ disabled: !a.disabled }),
      });
      adminCache.delete("accounts");
      adminAccounts(true);
    };
    if ($(".remove", d))
      $(".remove", d).onclick = async () => {
        if (!confirm(`Radera ${a.email}?`)) return;
        await api(`/api/admin/accounts/${a.id}`, { method: "DELETE" });
        adminCache.delete("accounts");
        adminAccounts(true);
      };
    host.append(d);
  }
  if (!rows.length) host.innerHTML = '<div class="empty">Inga konton.</div>';
  $("#account-search").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$(".admin-row", host).forEach((x) => (x.hidden = !x.dataset.search.includes(q)));
  };
}
async function adminSends(force = false) {
  const rows = await adminData("sends", "/api/admin/send-jobs", 10000, force),
    p = $("#admin-panel");
  p.innerHTML = '<section class="admin-send-list" id="send-rows"></section>';
  const host = $("#send-rows");
  for (const j of rows) {
    const d = document.createElement("article");
    d.className = "admin-send";
    d.innerHTML = `<div class="admin-send__item"><span class="admin-send__label">Konto</span><span class="admin-send__value">${esc(j.email || j.account_id)}</span></div><div class="admin-send__item"><span class="admin-send__label">Status</span><span class="admin-send__value">${esc(statusLabel(j.status))}</span></div><div class="admin-send__item"><span class="admin-send__label">Skickade</span><span class="admin-send__value">${num(j.sent_count)}/${num(j.total_recipients)}</span></div><div class="admin-send__item"><span class="admin-send__label">Skapad</span><span class="admin-send__value">${fmtDate(j.created_at)}</span></div>`;
    host.append(d);
  }
  if (!rows.length) host.innerHTML = '<div class="empty">Inga utskick.</div>';
}
async function adminStats(force = false) {
  const s = await adminData("stats", "/api/admin/stats", 30000, force),
    p = $("#admin-panel");
  p.innerHTML = `<div class="kpis"><div class="kpi"><strong>${num(s.totalAccounts)}</strong><span>Konton</span></div><div class="kpi"><strong>${num(s.visitors15m)}</strong><span>Besökare 15 min</span></div><div class="kpi"><strong>${num(s.visitors24h)}</strong><span>Besökare 24 h</span></div><div class="kpi"><strong>${num(s.visitors7d)}</strong><span>Besökare 7 dagar</span></div><div class="kpi"><strong>${num(s.activeSends)}</strong><span>Aktiva utskick</span></div><div class="kpi"><strong>${num(s.queuedRecipients)}</strong><span>Köade mottagare</span></div><div class="kpi"><strong>${num(s.sent24h)}</strong><span>Skickade 24 h</span></div><div class="kpi"><strong>${num(s.sent7d)}</strong><span>Skickade 7 dagar</span></div><div class="kpi"><strong>${num(s.platformErrors24h)}</strong><span>Plattformsfel 24 h</span></div></div>`;
}
async function adminFeedback(force = false) {
  const rows = await adminData("feedback", "/api/admin/feedback", 15000, force),
    p = $("#admin-panel");
  p.innerHTML = '<section class="card"><div id="feedback-list" class="list"></div></section>';
  const host = $("#feedback-list");
  for (const f of rows) {
    const d = document.createElement("button");
    d.type = "button";
    d.className = "button button--secondary admin-row";
    d.innerHTML = `<span><strong>${esc((f.message || "").slice(0, 120))}</strong><br><span class="card__meta">${fmtDate(f.created_at)}</span></span>`;
    d.onclick = () => {
      showModal(
        "Feedback",
        `<div class="stack"><p>${esc(f.message)}</p>${f.reply_to ? `<p><a href="mailto:${encodeURIComponent(f.reply_to)}">${esc(f.reply_to)}</a></p>` : ""}<button class="button button--danger" id="delete-feedback" type="button">Ta bort</button></div>`,
      );
      $("#delete-feedback").onclick = async () => {
        if (!confirm("Ta bort feedbacken?")) return;
        try {
          await api(`/api/admin/feedback/${f.id}`, { method: "DELETE" });
          adminCache.delete("feedback");
          closeModal();
          adminFeedback(true);
        } catch (err) {
          notice(err.message, "error");
        }
      };
    };
    host.append(d);
  }
  if (!rows.length) host.innerHTML = '<div class="empty">Ingen feedback.</div>';
}
function openFeedback() {
  showModal(
    "Kontakt & feedback",
    `<form id="feedback-form" class="stack"><div class="field"><label>Meddelande</label><textarea class="input" name="message" required></textarea></div><div class="field"><label>E-post för svar (valfritt)</label><input class="input" name="replyTo" type="email" autocomplete="email"></div><button class="button button--primary" type="submit">Skicka</button></form>`,
  );
  $("#feedback-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          message: f.get("message"),
          type: "contact",
          replyTo: f.get("replyTo") || undefined,
        }),
      });
      adminCache.delete("feedback");
      closeModal();
      notice("Meddelandet är skickat.", "success");
    } catch (err) {
      notice(err.message, "error");
    }
  };
}

async function boot() {
  renderNotice();
  $("#menu-button").onclick = openMenu;
  $$("[data-close-menu]").forEach((b) => (b.onclick = closeMenu));
  $$("[data-close-modal]").forEach((b) => (b.onclick = closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#modal").hidden) closeModal();
      else if (!$("#mobile-menu").hidden) closeMenu();
    }
  });
  const reset = new URLSearchParams(location.search).get("reset");
  if (reset) {
    renderReset(reset);
    return;
  }
  try {
    state.me = await api("/api/me");
  } catch {
    state.me = { loggedIn: false };
  }
  const currentRoute = location.hash.replace(/^#/, "");
  const protectedRoute =
    /^(send(?:\/[123])?|jobs|settings(?:\/(?:mail|account|security|api))?|admin(?:\/(?:accounts|sends|stats|feedback))?)$/.test(
      currentRoute,
    )
      ? currentRoute
      : "";
  if (!state.me?.loggedIn) {
    if (protectedRoute) {
      sessionStorage.removeItem("pending:startSend");
      sessionStorage.removeItem("pending:areaTypes");
      sessionStorage.setItem("pending:route", protectedRoute);
    }
    renderPublicHome($("#root"));
    return;
  }
  const resumeSend = sessionStorage.getItem("pending:startSend") === "1",
    resumeRoute = sessionStorage.getItem("pending:route");
  sessionStorage.removeItem("pending:route");
  if (resumeSend) {
    try {
      const pending = JSON.parse(sessionStorage.getItem("pending:areaTypes") || "[]");
      state.pendingAreaTypes = new Set(Array.isArray(pending) ? pending : []);
    } catch {
      state.pendingAreaTypes = new Set();
    }
    sessionStorage.removeItem("pending:startSend");
    sessionStorage.removeItem("pending:areaTypes");
    state.view = "send";
    state.step = 1;
    history.replaceState(null, "", `${location.pathname}${location.search}#send/1`);
  } else if (
    resumeRoute &&
    /^(send(?:\/[123])?|jobs|settings(?:\/(?:mail|account|security|api))?|admin(?:\/(?:accounts|sends|stats|feedback))?)$/.test(
      resumeRoute,
    )
  ) {
    history.replaceState(null, "", `${location.pathname}${location.search}#${resumeRoute}`);
    applyRoute();
  } else {
    applyRoute();
    if (!location.hash)
      history.replaceState(null, "", `${location.pathname}${location.search}#home`);
  }
  $("#feedback-button")?.remove();
  renderApp();
  if (state.me.isAdmin) setTimeout(warmAdmin, 250);
  addEventListener("hashchange", () => {
    applyRoute();
    renderApp();
  });
}
boot();
