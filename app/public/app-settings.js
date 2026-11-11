function renderSettings(root) {
  root.innerHTML = `<div class="page">${pageHead("Inställningar")}<div class="settings"><nav id="settings-nav" class="settings-nav" aria-label="Inställningar"></nav><section id="settings-panel"><div class="empty">Laddar…</div></section></div></div>`;
  for (const [id, label] of [
    ["mail", "Mail"],
    ["intros", "Inledningar"],
    ["account", "Konto"],
    ["security", "Säkerhet"],
    ["api", "API"],
  ]) {
    const b = button(label, state.settings === id ? "primary" : "quiet", () => {
      state.settings = id;
      location.hash = `settings/${id}`;
      renderSettings(root);
    });
    $("#settings-nav").append(b);
  }
  ({
    mail: renderMailSettings,
    intros: () => window.QuillLetterIntros.renderSettings(),
    account: renderAccountSettings,
    security: renderSecuritySettings,
    api: renderApiSettings,
  })[state.settings]();
}
/**
 * Hämtar mailkontona på nytt och renderar inställningspanelen.
 *
 * Visar anslutningstest endast för SMTP-konton, uppdaterar UI efter lyckade
 * mutationer och visar nätverks-/API-fel som aviseringar.
 *
 * @returns Ett Promise som är klart när panelen har renderats eller ett laddningsfel har visats.
 */
async function renderMailSettings() {
  const p = $("#settings-panel");
  try {
    await ensureCredentials(true);
    p.innerHTML = `<div class="stack"><section class="card"><div class="row row--between"><div><div class="card__eyebrow">Avsändare</div><h2>Mailkonton</h2></div><div class="row"><button class="button button--primary" id="add-smtp">Koppla SMTP</button><a class="button button--secondary" href="/api/oauth-mail/microsoft/start">${microsoftLogo}<span>Microsoft 365</span></a></div></div><div id="cred-list" class="list section"></div></section></div>`;
    const host = $("#cred-list");
    for (const c of state.credentials) {
      const d = document.createElement("div");
      d.className = "admin-row";
      const smtpActions =
        c.provider !== "microsoft_graph"
          ? '<button class="button button--secondary" data-action="test">Testa anslutning</button><button class="button button--secondary" data-action="password">Uppdatera lösenord</button>'
          : "";
      d.innerHTML = `<div class="row row--between"><div><div class="card__title">${esc(c.from_address)}</div><div class="card__meta">${esc(c.provider)}${c.verified_at ? " · " + fmtDate(c.verified_at) : ""}</div></div><div class="row">${smtpActions}<button class="button button--danger" data-action="delete">Ta bort</button></div></div>`;
      const testButton = $('[data-action="test"]', d);
      if (testButton)
        testButton.onclick = async () => {
          testButton.disabled = true;
          testButton.textContent = "Testar…";
          try {
            await api(`/api/mail-credentials/${encodeURIComponent(c.id)}/test`, { method: "POST" });
            state.credentials = null;
            await renderMailSettings();
            notice("SMTP-anslutningen fungerar.", "success");
          } catch (err) {
            testButton.disabled = false;
            testButton.textContent = "Testa anslutning";
            notice(err.message, "error");
          }
        };
      const passwordButton = $('[data-action="password"]', d);
      if (passwordButton) passwordButton.onclick = () => openUpdateCredentialPassword(c);
      $('[data-action="delete"]', d).onclick = async () => {
        if (!confirm("Ta bort mailkontot?")) return;
        try {
          await api(`/api/mail-credentials/${c.id}`, { method: "DELETE" });
          state.credentials = null;
          renderMailSettings();
        } catch (err) {
          notice(err.message, "error");
        }
      };
      host.append(d);
    }
    if (!state.credentials.length)
      host.innerHTML = '<div class="empty">Inget mailkonto kopplat.</div>';
    $("#add-smtp").onclick = openAddCredential;
  } catch (err) {
    p.innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
  }
}
function openUpdateCredentialPassword(c) {
  const providerHint =
    c.provider === "icloud"
      ? "Använd det appspecifika lösenordet från ditt Apple-konto."
      : "Ange lösenordet eller app-lösenordet som SMTP-leverantören kräver.";
  showModal(
    "Uppdatera SMTP-lösenord",
    `<form id="smtp-password-form" class="stack"><p class="muted">${esc(c.from_address)}</p><p class="muted">${esc(providerHint)} Det testas mot leverantören innan något sparas.</p><div class="field"><label>Lösenord/app-lösenord</label><input class="input" name="password" type="password" autocomplete="off" required></div><button class="button button--primary" type="submit">Testa och spara</button></form>`,
  );
  $("#smtp-password-form").onsubmit = async (e) => {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get("password");
    try {
      await api(`/api/mail-credentials/${encodeURIComponent(c.id)}/password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      state.credentials = null;
      closeModal();
      await renderMailSettings();
      notice("SMTP-lösenordet är verifierat och uppdaterat.", "success");
    } catch (err) {
      notice(err.message, "error");
    }
  };
}
function openAddCredential() {
  showModal(
    "Koppla SMTP-konto",
    `<form id="cred-form" class="stack"><div class="field"><label>Leverantör</label><select class="input" name="provider"><option value="icloud">iCloud</option><option value="gmail">Gmail</option><option value="outlook">Outlook SMTP</option><option value="yahoo">Yahoo</option><option value="generic">Annan SMTP</option></select></div><div class="field"><label>E-postadress</label><input class="input" name="fromAddress" type="email" required></div><div class="field"><label>Användarnamn</label><input class="input" name="user" required></div><div class="field"><label>Lösenord/app-lösenord</label><input class="input" name="password" type="password" required></div><div class="field"><label>SMTP-server (Annan SMTP)</label><input class="input" name="host"></div><div class="field"><label>Port</label><input class="input" name="port" type="number" value="587"></div><button class="button button--primary" type="submit">Testa och koppla</button></form>`,
  );
  $("#cred-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    if (f.port) f.port = Number(f.port);
    try {
      await api("/api/mail-credentials", { method: "POST", body: JSON.stringify(f) });
      state.credentials = null;
      closeModal();
      renderMailSettings();
    } catch (err) {
      notice(err.message, "error");
    }
  };
}
function renderAccountSettings() {
  const p = $("#settings-panel");
  p.innerHTML = `<div class="stack"><section class="card"><div class="card__eyebrow">Konto</div><h2>${esc(state.me.email)}</h2></section><section class="card"><h3>Lösenord</h3><button class="button button--secondary" id="change-pw">Byt lösenord</button></section><section class="card"><h3>Radera konto</h3><p class="muted">Radering är permanent.</p><button class="button button--danger" id="delete-account">Radera konto</button></section></div>`;
  $("#change-pw").onclick = () => {
    showModal(
      "Byt lösenord",
      `<form id="pw-form" class="stack"><div class="field"><label>Nytt lösenord</label><input class="input" name="newPassword" type="password" minlength="10" autocomplete="new-password" required></div><button class="button button--primary" type="submit">Spara</button></form>`,
    );
    $("#pw-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/set-password", {
          method: "POST",
          body: JSON.stringify({ newPassword: new FormData(e.currentTarget).get("newPassword") }),
        });
        closeModal();
        notice("Lösenordet är uppdaterat.", "success");
      } catch (err) {
        notice(err.message, "error");
      }
    };
  };
  $("#delete-account").onclick = () => {
    showModal(
      "Radera konto",
      `<form id="delete-form" class="stack"><div class="notice notice--warning">Detta går inte att ångra.</div>${state.me.passwordSetByUser ? '<div class="field"><label>Lösenord</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>' : ""}${state.me.totpEnabled ? '<div class="field"><label>2FA-kod</label><input class="input" name="totpCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>' : ""}<button class="button button--danger" type="submit">Radera permanent</button></form>`,
    );
    $("#delete-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/delete-account", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
        });
        location.href = "/";
      } catch (err) {
        notice(err.message, "error");
      }
    };
  };
}
function providerName(p) {
  return { google: "Google", microsoft: "Microsoft" }[p] || p;
}
function providerLogo(p) {
  return p === "google" ? googleLogo : p === "microsoft" ? microsoftLogo : "";
}
async function renderSecuritySettings() {
  const p = $("#settings-panel");
  p.innerHTML = `<div class="stack"><section class="card"><div class="card__eyebrow">2FA</div><h2>${state.me.totpEnabled ? "Aktiverad" : "Avstängd"}</h2><button class="button ${state.me.totpEnabled ? "button--danger" : "button--primary"}" id="totp-action">${state.me.totpEnabled ? "Inaktivera 2FA" : "Aktivera 2FA"}</button></section><section class="card"><h3>Länkade inloggningssätt</h3><div id="oauth-list" class="list section"><div class="empty">Laddar…</div></div></section></div>`;
  $("#totp-action").onclick = state.me.totpEnabled
    ? async () => {
        if (!confirm("Inaktivera 2FA?")) return;
        try {
          await api("/api/totp/disable", { method: "POST" });
          state.me.totpEnabled = false;
          renderSecuritySettings();
        } catch (err) {
          notice(err.message, "error");
        }
      }
    : startTotp;
  try {
    const ids = await api("/api/oauth-identities"),
      host = $("#oauth-list");
    host.innerHTML = "";
    for (const x of ids) {
      const d = document.createElement("div");
      d.className = "admin-row";
      d.innerHTML = `<div class="row row--between"><div><div class="card__title row">${providerLogo(x.provider)}<span>${esc(providerName(x.provider))}</span></div><div class="card__meta">${x.provider_email ? esc(x.provider_email) : "Kopplad"}${x.created_at ? " · " + fmtDate(x.created_at) : ""}</div></div><button class="button button--danger">Koppla bort</button></div>`;
      $("button", d).onclick = async () => {
        if (!confirm(`Koppla bort ${providerName(x.provider)}?`)) return;
        try {
          await api(`/api/oauth-identities/${encodeURIComponent(x.provider)}`, {
            method: "DELETE",
          });
          renderSecuritySettings();
        } catch (err) {
          notice(err.message, "error");
        }
      };
      host.append(d);
    }
    if (!ids.length) host.innerHTML = '<div class="empty">Inga externa inloggningar länkade.</div>';
  } catch (err) {
    $("#oauth-list").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
  }
}
async function startTotp() {
  try {
    const d = await api("/api/totp/setup", { method: "POST" });
    showModal(
      "Aktivera 2FA",
      `<form id="totp-form" class="stack"><p class="muted">Lägg in denna hemlighet i din autentiseringsapp:</p><code class="code">${esc(d.secret)}</code><div class="field"><label>Sexsiffrig kod</label><input class="input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div><button class="button button--primary" type="submit">Aktivera</button></form>`,
    );
    $("#totp-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/totp/confirm", {
          method: "POST",
          body: JSON.stringify({ code: new FormData(e.currentTarget).get("code") }),
        });
        state.me.totpEnabled = true;
        closeModal();
        renderSecuritySettings();
      } catch (err) {
        notice(err.message, "error");
      }
    };
  } catch (err) {
    notice(err.message, "error");
  }
}
async function renderApiSettings() {
  const p = $("#settings-panel");
  p.innerHTML =
    '<section class="card"><div class="row row--between"><div><div class="card__eyebrow">Automation</div><h2>API-nycklar</h2></div><button class="button button--primary" id="api-new">Ny API-nyckel</button></div><div id="api-list" class="list section"><div class="empty">Laddar…</div></div></section>';
  try {
    const keys = await api("/api/api-keys"),
      host = $("#api-list");
    host.innerHTML = "";
    for (const k of keys) {
      const d = document.createElement("div");
      d.className = "admin-row";
      d.innerHTML = `<div class="row row--between"><div><div class="card__title">${esc(k.name)}</div><div class="card__meta">${fmtDate(k.created_at)}</div></div><button class="button button--danger">Återkalla</button></div>`;
      $("button", d).onclick = async () => {
        try {
          await api(`/api/api-keys/${k.id}`, { method: "DELETE" });
          renderApiSettings();
        } catch (err) {
          notice(err.message, "error");
        }
      };
      host.append(d);
    }
    if (!keys.length) host.innerHTML = '<div class="empty">Inga API-nycklar.</div>';
    $("#api-new").onclick = () => {
      showModal(
        "Ny API-nyckel",
        `<form id="api-form" class="stack"><div class="field"><label>Namn</label><input class="input" name="name" required></div><button class="button button--primary" type="submit">Skapa</button><div id="api-result"></div></form>`,
      );
      $("#api-form").onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api("/api/api-keys", {
            method: "POST",
            body: JSON.stringify({ name: new FormData(e.currentTarget).get("name") }),
          });
          $("#api-result").innerHTML =
            `<div class="notice notice--warning"><div><strong>Kopiera nyckeln nu.</strong><br><code class="code">${esc(r.key)}</code></div></div>`;
        } catch (err) {
          notice(err.message, "error");
        }
      };
    };
  } catch (err) {
    $("#api-list").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
  }
}
