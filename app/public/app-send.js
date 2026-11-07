function initPrivateRecipientState() {
  state.privateRecipientData ??= { contacts: [], lists: [] };
  state.privateSelectedContactIds ??= new Set();
  state.privateSelectedListIds ??= new Set();
  state.oneTimeRecipients ??= new Map();
}
function applyPrivateRecipientData(data) {
  initPrivateRecipientState();
  state.privateRecipientData = {
    contacts: Array.isArray(data?.contacts) ? data.contacts : [],
    lists: Array.isArray(data?.lists) ? data.lists : [],
  };
  const contactIds = new Set(state.privateRecipientData.contacts.map((c) => c.id)),
    listIds = new Set(state.privateRecipientData.lists.map((l) => l.id));
  for (const id of [...state.privateSelectedContactIds])
    if (!contactIds.has(id)) state.privateSelectedContactIds.delete(id);
  for (const id of [...state.privateSelectedListIds])
    if (!listIds.has(id)) state.privateSelectedListIds.delete(id);
}
async function loadPrivateRecipientData(force = false) {
  initPrivateRecipientState();
  if (state.privateRecipientLoaded && !force) return;
  applyPrivateRecipientData(await api("/api/private-contacts"));
  state.privateRecipientLoaded = true;
}
async function ensureRecipientData() {
  const tasks = [];
  if (!(state.areas && state.parties && state.roles))
    tasks.push(
      Promise.all([api("/api/areas"), api("/api/parties"), api("/api/roles")]).then((data) => {
        [state.areas, state.parties, state.roles] = data;
      }),
    );
  if (!state.privateRecipientLoaded) tasks.push(loadPrivateRecipientData());
  await Promise.all(tasks);
}
function selectedPrivateRecipientMap() {
  initPrivateRecipientState();
  const data = state.privateRecipientData || { contacts: [], lists: [] },
    wantedIds = new Set(state.privateSelectedContactIds);
  for (const list of data.lists)
    if (state.privateSelectedListIds.has(list.id))
      for (const id of list.contactIds || []) wantedIds.add(id);
  const out = new Map();
  for (const c of data.contacts)
    if (wantedIds.has(c.id)) out.set(String(c.email).toLowerCase(), c.name || c.email);
  for (const [email, name] of state.oneTimeRecipients)
    out.set(String(email).toLowerCase(), name || email);
  return out;
}
function recipientToken(email, name) {
  const safeName = String(name || "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .trim()
    .slice(0, 160);
  return safeName ? `${safeName} <${email}>` : email;
}
function filterPayload() {
  const included = new Map();
  for (const [email, name] of state.includeEmails)
    included.set(String(email).trim().toLowerCase(), name);
  for (const [email, name] of selectedPrivateRecipientMap()) {
    const key = String(email).trim().toLowerCase();
    if (!included.has(key)) included.set(key, name);
  }
  return {
    areaNames: [...state.selectedAreas],
    excludeParties: [...state.excludeParties],
    excludeEmails: [...state.excludeEmails.keys()],
    includeRoles: [
      ...state.includeRoles,
      ...[...state.excludeBodies].map((x) => "exclude-body:" + x),
      ...[...state.mediaCategories].map((x) => "media-category:" + x),
      ...[...(state.academicFields || [])].map((x) => "academic-field:" + x),
    ],
    includeEmails: [...included].map(([email, name]) => recipientToken(email, name)),
  };
}
async function recipientCount() {
  if (typeof paintLocalRecipientCount === "function") return paintLocalRecipientCount();
  const e = $("#recipient-count"),
    r = $("#review-count");
  if (e) e.textContent = "Mottagarantal visas när metadata är laddad.";
  if (r) r.textContent = "…";
  return "?";
}
async function renderSend(root) {
  root.innerHTML = `<div class="page">${pageHead("Nytt utskick", "Tre steg. Avancerade filter är frivilliga.")}<div class="segmented"><label><input type="radio" name="step" value="1" ${state.step === 1 ? "checked" : ""}><span>1. Mottagare</span></label><label><input type="radio" name="step" value="2" ${state.step === 2 ? "checked" : ""}><span>2. Brev</span></label><label><input type="radio" name="step" value="3" ${state.step === 3 ? "checked" : ""}><span>3. Granska</span></label></div><section id="send-step" class="section"><div class="empty">Laddar…</div></section></div>`;
  $$('input[name="step"]').forEach(
    (i) =>
      (i.onchange = () => {
        state.step = Number(i.value);
        location.hash = `send/${state.step}`;
        renderSend(root);
      }),
  );
  try {
    if (state.step === 1) {
      await ensureRecipientData();
      applyPendingPublicAreas();
      renderRecipients();
    } else if (state.step === 2) await renderCompose();
    else {
      await Promise.all([ensureCredentials(), ensureRecipientData()]);
      applyPendingPublicAreas();
      await renderReview();
    }
  } catch (err) {
    $("#send-step").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
  }
}
function groupedAreas() {
  const m = new Map();
  for (const a of state.areas || []) {
    if (!m.has(a.area_type)) m.set(a.area_type, []);
    m.get(a.area_type).push(a);
  }
  return m;
}
function renderRecipients() {
  const el = $("#send-step"),
    labels = {
      eu: "EU",
      regering: "Regering",
      riksdag: "Riksdag",
      media: "Media",
      academia: "Akademi",
      region: "Regioner",
      kommun: "Kommuner",
      kyrka: "Kyrkan",
    };
  el.innerHTML = `<div class="stack"><div class="row row--between"><div><h2>Välj mottagare</h2><p class="muted">Välj offentliga mottagare, egna mottagare eller kombinera båda.</p></div><button class="button button--secondary" id="select-all">Välj alla offentliga</button></div><div id="area-groups" class="choice-grid"></div><details class="details" open><summary>Mina mottagare</summary><div id="private-recipients" class="stack section"></div></details><div id="recipient-count" class="notice">Beräknar…</div><details class="details"><summary>Avancerade filter</summary><div class="stack"><div class="field"><label>Sök enskilt område</label><input class="input" id="area-search" placeholder="Kommun, region…"></div><div id="area-list" class="filter-list"></div><details class="details"><summary>Uteslut ansvarsområden</summary><p class="muted">Gäller kommuner och regioner.</p><div id="body-list"></div></details><details class="details" id="media-filter" hidden><summary>Begränsa media efter inriktning</summary><div id="media-list"></div></details><details class="details" id="academic-filter" hidden><summary>Begränsa akademi efter område</summary><div id="academic-list"></div></details><details class="details"><summary>Befattning och parti</summary><div class="grid grid--2"><div><h3>Befattning</h3><div id="role-list"></div></div><div><h3>Uteslut parti</h3><div id="party-list"></div></div></div></details><div class="field"><label>Sök specifik offentlig mottagare</label><input class="input" id="person-search" placeholder="Skriv minst två tecken"></div><div id="person-results" class="list"></div><div><h3>Enskilt tillagda från offentliga registret</h3><div id="include-chips" class="chips"></div></div><div><h3>Exkluderade</h3><div id="exclude-chips" class="chips"></div></div></div></details><div><button class="button button--primary" id="to-compose">Nästa: Brev</button></div></div>`;
  for (const [type, arr] of groupedAreas()) {
    const all = arr.every((a) => state.selectedAreas.has(a.area_name));
    const b = button("", "secondary");
    b.classList.add("choice");
    b.setAttribute("aria-pressed", all ? "true" : "false");
    b.innerHTML = `<span><strong>${esc(labels[type] || type)}</strong><br><span class="muted">${num(arr.reduce((s, a) => s + Number(a.count || 0), 0))} poster</span></span>`;
    b.onclick = () => {
      for (const a of arr)
        all ? state.selectedAreas.delete(a.area_name) : state.selectedAreas.add(a.area_name);
      renderRecipients();
    };
    $("#area-groups").append(b);
  }
  $("#select-all").onclick = () => {
    const every =
      state.areas.length && state.areas.every((a) => state.selectedAreas.has(a.area_name));
    state.selectedAreas.clear();
    if (!every) for (const a of state.areas) state.selectedAreas.add(a.area_name);
    renderRecipients();
  };
  renderPrivateRecipients();
  renderAdvanced();
  recipientCount();
  $("#to-compose").onclick = () => {
    state.step = 2;
    location.hash = "send/2";
    renderSend($("#root"));
  };
}
function normalizeUiContact(email, name = "") {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e))
    throw new Error(`Ogiltig e-postadress: ${email || "(tom)"}`);
  return {
    email: e,
    name: String(name || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 160),
  };
}
function splitContactLine(line) {
  const outside = new Set();
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (c === "\t" || c === ";" || c === ",")) outside.add(c);
  }
  let delimiter = "";
  for (const d of ["\t", ";", ","])
    if (outside.has(d)) {
      delimiter = d;
      break;
    }
  if (!delimiter) return [line.trim()];
  const out = [];
  let value = "";
  quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      out.push(value.trim());
      value = "";
    } else value += c;
  }
  out.push(value.trim());
  return out;
}
function parseContactText(text) {
  const rows = [],
    seen = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const display = line.match(/^(.*?)\s*<([^<>]+)>$/);
    let email = "",
      name = "";
    if (display) {
      name = display[1];
      email = display[2];
    } else {
      const cols = splitContactLine(line),
        emailIndex = cols.findIndex((x) => x.includes("@"));
      if (emailIndex < 0) {
        if (/e-?post|email/i.test(line)) continue;
        throw new Error(`Hittar ingen e-postadress på raden: ${line.slice(0, 80)}`);
      }
      email = cols[emailIndex];
      name = cols.find((x, i) => i !== emailIndex && x && !/^(namn|name)$/i.test(x)) || "";
    }
    const c = normalizeUiContact(email, name);
    if (!seen.has(c.email)) {
      seen.add(c.email);
      rows.push(c);
    }
    if (rows.length > 5000) throw new Error("Högst 5 000 mottagare kan importeras åt gången");
  }
  if (!rows.length) throw new Error("Importen innehåller inga mottagare");
  return rows;
}
function renderPrivateRecipients() {
  initPrivateRecipientState();
  const host = $("#private-recipients");
  if (!host) return;
  const data = state.privateRecipientData || { contacts: [], lists: [] },
    selected = selectedPrivateRecipientMap();
  host.innerHTML = `<div class="notice"><strong><span id="private-selected-count">${num(selected.size)}</span> egna mottagare valda.</strong> De hålls privata för ditt konto och blandas inte in i den gemensamma offentliga mottagardatabasen.</div><div class="row"><button class="button button--secondary" id="private-only" type="button">Endast egna mottagare</button></div><div class="grid grid--2"><section class="card"><h3>Lägg till en adress</h3><div class="field"><label>Namn <span class="muted">(valfritt)</span></label><input class="input" id="private-name" autocomplete="off"></div><div class="field"><label>E-post</label><input class="input" id="private-email" type="email" autocomplete="off"></div><div class="row"><button class="button button--secondary" id="private-use-once" type="button">Använd bara i brevet</button><button class="button button--primary" id="private-save" type="button">Spara och använd</button></div></section><section class="card"><h3>Importera lista</h3><div class="field"><label>Listnamn <span class="muted">(krävs om listan sparas)</span></label><input class="input" id="private-list-name" placeholder="Till exempel Lokala journalister"></div><div class="field"><label>CSV/TXT eller inklistrade adresser</label><input class="input" type="file" id="private-import-file" accept=".csv,.txt,text/csv,text/plain"><textarea class="input" id="private-import-text" rows="5" placeholder="Anna Andersson,anna@example.com&#10;erik@example.com"></textarea></div><div class="row"><button class="button button--secondary" id="private-import-once" type="button">Använd bara i brevet</button><button class="button button--primary" id="private-import-save" type="button">Spara lista och använd</button></div></section></div><div class="grid grid--2"><section><h3>Sparade listor</h3><div id="private-lists" class="list"></div></section><section><h3>Sparade mottagare</h3><input class="input" id="private-contact-search" placeholder="Sök namn eller e-post"><div id="private-contacts" class="list section"></div></section></div><div><h3>Tillfälliga mottagare</h3><div id="private-once-chips" class="chips"></div></div>`;
  const updatePrivateSelectedCount = () => {
    const count = $("#private-selected-count");
    if (count) count.textContent = num(selectedPrivateRecipientMap().size);
  };
  $("#private-only").onclick = () => {
    state.selectedAreas.clear();
    state.includeRoles.clear();
    state.excludeBodies.clear();
    state.mediaCategories.clear();
    state.academicFields.clear();
    state.includeEmails.clear();
    state.excludeEmails.clear();
    state.excludeParties.clear();
    renderRecipients();
  };
  const addOnce = () => {
    try {
      const c = normalizeUiContact($("#private-email").value, $("#private-name").value);
      state.oneTimeRecipients.set(c.email, c.name || c.email);
      renderPrivateRecipients();
      recipientCount();
    } catch (err) {
      notice(err.message, "error");
    }
  };
  $("#private-use-once").onclick = addOnce;
  $("#private-save").onclick = async () => {
    try {
      const c = normalizeUiContact($("#private-email").value, $("#private-name").value),
        saved = await api("/api/private-contacts", { method: "POST", body: JSON.stringify(c) });
      await loadPrivateRecipientData(true);
      if (saved?.id) state.privateSelectedContactIds.add(saved.id);
      renderPrivateRecipients();
      recipientCount();
      notice("Mottagaren sparades på ditt konto.", "success");
    } catch (err) {
      notice(err.message, "error");
    }
  };
  $("#private-import-file").onchange = async (e) => {
    const f = e.target.files?.[0];
    if (f) $("#private-import-text").value = await f.text();
  };
  const parsedImport = () => parseContactText($("#private-import-text").value);
  $("#private-import-once").onclick = () => {
    try {
      for (const c of parsedImport()) state.oneTimeRecipients.set(c.email, c.name || c.email);
      renderPrivateRecipients();
      recipientCount();
    } catch (err) {
      notice(err.message, "error");
    }
  };
  $("#private-import-save").onclick = async () => {
    try {
      const name = $("#private-list-name").value.trim(),
        contacts = parsedImport();
      if (!name) throw new Error("Listnamn krävs när listan ska sparas");
      const result = await api("/api/private-contact-lists/import", {
        method: "POST",
        body: JSON.stringify({ name, contacts }),
      });
      applyPrivateRecipientData(result);
      state.privateRecipientLoaded = true;
      if (result?.importedListId) state.privateSelectedListIds.add(result.importedListId);
      renderPrivateRecipients();
      recipientCount();
      notice(`Listan sparades med ${num(contacts.length)} mottagare.`, "success");
    } catch (err) {
      notice(err.message, "error");
    }
  };
  const listHost = $("#private-lists");
  if (!data.lists.length) listHost.innerHTML = '<div class="muted">Inga sparade listor.</div>';
  for (const list of data.lists) {
    const row = document.createElement("div");
    row.className = "card";
    row.innerHTML = `<div class="row row--between"><label class="check"><input type="checkbox" ${state.privateSelectedListIds.has(list.id) ? "checked" : ""}><span>${esc(list.name)} <span class="muted">(${num((list.contactIds || []).length)})</span></span></label><button class="button button--quiet delete" type="button">Radera</button></div>`;
    $("input", row).onchange = (e) => {
      e.target.checked
        ? state.privateSelectedListIds.add(list.id)
        : state.privateSelectedListIds.delete(list.id);
      updatePrivateSelectedCount();
      recipientCount();
    };
    $(".delete", row).onclick = async () => {
      if (!confirm(`Radera listan ${list.name}? Kontakterna ligger kvar under Sparade mottagare.`))
        return;
      try {
        await api(`/api/private-contact-lists/${encodeURIComponent(list.id)}`, {
          method: "DELETE",
        });
        state.privateSelectedListIds.delete(list.id);
        await loadPrivateRecipientData(true);
        renderPrivateRecipients();
        recipientCount();
      } catch (err) {
        notice(err.message, "error");
      }
    };
    listHost.append(row);
  }
  const renderContacts = (q = "") => {
    const contactHost = $("#private-contacts"),
      needle = q.trim().toLowerCase();
    contactHost.innerHTML = "";
    const matches = data.contacts
      .filter(
        (c) =>
          !needle ||
          String(c.name || "")
            .toLowerCase()
            .includes(needle) ||
          String(c.email).toLowerCase().includes(needle),
      )
      .slice(0, 200);
    if (!matches.length) {
      contactHost.innerHTML = '<div class="muted">Inga sparade mottagare.</div>';
      return;
    }
    for (const c of matches) {
      const row = document.createElement("div");
      row.className = "card";
      row.innerHTML = `<div class="row row--between"><label class="check"><input type="checkbox" ${state.privateSelectedContactIds.has(c.id) ? "checked" : ""}><span>${esc(c.name || c.email)}${c.name ? `<br><span class="muted">${esc(c.email)}</span>` : ""}</span></label><button class="button button--quiet delete" type="button">Radera</button></div>`;
      $("input", row).onchange = (e) => {
        e.target.checked
          ? state.privateSelectedContactIds.add(c.id)
          : state.privateSelectedContactIds.delete(c.id);
        updatePrivateSelectedCount();
        recipientCount();
      };
      $(".delete", row).onclick = async () => {
        if (!confirm(`Radera ${c.name || c.email} från dina sparade mottagare?`)) return;
        try {
          await api(`/api/private-contacts/${encodeURIComponent(c.id)}`, { method: "DELETE" });
          state.privateSelectedContactIds.delete(c.id);
          await loadPrivateRecipientData(true);
          renderPrivateRecipients();
          recipientCount();
        } catch (err) {
          notice(err.message, "error");
        }
      };
      contactHost.append(row);
    }
  };
  renderContacts();
  $("#private-contact-search").oninput = (e) => renderContacts(e.target.value);
  const chipHost = $("#private-once-chips");
  chipHost.innerHTML = "";
  for (const [email, name] of state.oneTimeRecipients) {
    const x = document.createElement("span");
    x.className = "chip";
    x.innerHTML = `<span>${esc(name || email)}${name && name !== email ? ` &lt;${esc(email)}&gt;` : ""}</span>`;
    const b = button("×", "quiet", () => {
      state.oneTimeRecipients.delete(email);
      renderPrivateRecipients();
      recipientCount();
    });
    b.setAttribute("aria-label", `Ta bort ${name || email}`);
    x.append(b);
    chipHost.append(x);
  }
}
function checklist(host, rows, set, onchange = recipientCount) {
  host.innerHTML = "";
  for (const [key, label] of rows) {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox" ${set.has(key) ? "checked" : ""}><span>${esc(label)}</span>`;
    $("input", l).onchange = (e) => {
      e.target.checked ? set.add(key) : set.delete(key);
      onchange();
    };
    host.append(l);
  }
}
function renderAdvanced() {
  const renderAreas = (q = "") => {
    const host = $("#area-list");
    host.innerHTML = "";
    for (const a of state.areas
      .filter((x) => !q || x.area_name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 200)) {
      const l = document.createElement("label");
      l.className = "check";
      l.innerHTML = `<input type="checkbox" ${state.selectedAreas.has(a.area_name) ? "checked" : ""}><span>${esc(a.area_name)} <span class="muted">(${num(a.count)})</span></span>`;
      $("input", l).onchange = (e) => {
        e.target.checked
          ? state.selectedAreas.add(a.area_name)
          : state.selectedAreas.delete(a.area_name);
        renderAdvanced();
        recipientCount();
      };
      host.append(l);
    }
  };
  renderAreas();
  $("#area-search").oninput = (e) => renderAreas(e.target.value);
  checklist($("#body-list"), POLICY_AREAS, state.excludeBodies);
  const mediaNames = new Set(
      state.areas.filter((a) => a.area_type === "media").map((a) => a.area_name),
    ),
    hasMedia = [...state.selectedAreas].some((x) => mediaNames.has(x));
  $("#media-filter").hidden = !hasMedia;
  if (hasMedia) checklist($("#media-list"), MEDIA_CATEGORIES, state.mediaCategories);
  else state.mediaCategories.clear();
  const academicNames = new Set(
      state.areas.filter((a) => a.area_type === "academia").map((a) => a.area_name),
    ),
    hasAcademia = [...state.selectedAreas].some((x) => academicNames.has(x));
  $("#academic-filter").hidden = !hasAcademia;
  if (hasAcademia) checklist($("#academic-list"), ACADEMIC_FIELDS, state.academicFields);
  else state.academicFields.clear();
  const allowed = new Set(["ordförande", "gruppledare", "ledamot", "ersättare"]);
  const roles = (state.roles || [])
    .filter((r) => allowed.has(String(r.role_key || "").toLowerCase()))
    .map((r) => [r.role_key, `${r.role} (${num(r.count)})`]);
  checklist($("#role-list"), roles, state.includeRoles);
  const parties = [
    ...new Set(
      (state.parties || [])
        .filter((x) => !state.selectedAreas.size || state.selectedAreas.has(x.area_name))
        .map((x) => x.party)
        .filter(Boolean),
    ),
  ]
    .sort((a, b) => a.localeCompare(b, "sv-SE"))
    .map((x) => [x, x]);
  checklist($("#party-list"), parties, state.excludeParties);
  renderChips("#include-chips", state.includeEmails);
  renderChips("#exclude-chips", state.excludeEmails);
  let timer;
  $("#person-search").oninput = (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) {
      $("#person-results").innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      const rows = await api(`/api/public-contacts/search?q=${encodeURIComponent(q)}`).catch(
          () => [],
        ),
        host = $("#person-results");
      host.innerHTML = "";
      for (const p of rows.slice(0, 20)) {
        const d = document.createElement("div");
        d.className = "card";
        d.innerHTML = `<div class="row row--between"><div><div class="card__title">${esc(p.name)}</div><div class="card__meta">${esc(p.email)}</div></div><div class="row"><button class="button button--secondary add">Lägg till</button><button class="button button--quiet ex">Exkludera</button></div></div>`;
        $(".add", d).onclick = () => {
          const email = String(p.email).trim().toLowerCase();
          state.includeEmails.set(email, p.name);
          state.excludeEmails.delete(email);
          renderAdvanced();
          recipientCount();
        };
        $(".ex", d).onclick = () => {
          const email = String(p.email).trim().toLowerCase();
          state.excludeEmails.set(email, p.name);
          state.includeEmails.delete(email);
          renderAdvanced();
          recipientCount();
        };
        host.append(d);
      }
    }, 250);
  };
}
function renderChips(sel, map) {
  const host = $(sel);
  host.innerHTML = "";
  for (const [email, name] of map) {
    const x = document.createElement("span");
    x.className = "chip";
    x.innerHTML = `<span>${esc(name)} &lt;${esc(email)}&gt;</span>`;
    const b = button("×", "quiet", () => {
      map.delete(email);
      renderChips(sel, map);
      recipientCount();
    });
    b.setAttribute("aria-label", `Ta bort ${name}`);
    x.append(b);
    host.append(x);
  }
}

let mammothPromise;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothPromise) return mammothPromise;
  mammothPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mammoth/mammoth.browser.min.js";
    s.async = true;
    s.onload = () => resolve(window.mammoth);
    s.onerror = reject;
    document.head.append(s);
  });
  return mammothPromise;
}
async function fileToHtml(f) {
  const ext = f.name.toLowerCase().split(".").pop();
  if (ext === "docx") {
    const m = await loadMammoth();
    return (await m.convertToHtml({ arrayBuffer: await f.arrayBuffer() })).value || "";
  }
  if (ext === "html" || ext === "htm") return f.text();
  if (ext === "txt") return esc(await f.text()).replace(/\n/g, "<br>");
  throw new Error("Använd DOCX, HTML eller TXT.");
}
function renderCompose() {
  const el = $("#send-step");
  el.innerHTML = `<div class="stack"><div class="row row--between compose-head"><div><h2>Skriv brevet</h2><p class="muted">Texten sparas tillfälligt i den här webbläsarfliken tills utskicket startar.</p></div><button class="button button--danger" id="delete-draft" type="button">Radera brev</button></div><div class="field"><label>Ämne</label><input class="input" id="subject" value="${esc(sessionStorage.getItem("draft:subject") || "")}"></div><div class="field"><label>Brev</label><textarea class="input" id="body">${esc(sessionStorage.getItem("draft:body") || "")}</textarea></div><details class="details"><summary>Bilagor och dokumentimport</summary><div class="stack"><input class="input" type="file" id="files" multiple accept=".pdf,.txt,.docx,.html,.htm"><p id="file-info" class="muted">${state.files.length ? state.files.length + " filer valda" : "Max 10 MB per fil."}</p><button class="button button--secondary" id="use-file" type="button">Använd första filen som brev</button></div></details><div class="row"><button class="button button--secondary" id="back-rec">Tillbaka</button><button class="button button--primary" id="to-review">Nästa: Granska</button></div></div>`;
  const s = $("#subject"),
    b = $("#body");
  s.oninput = () => sessionStorage.setItem("draft:subject", s.value);
  b.oninput = () => sessionStorage.setItem("draft:body", b.value);
  $("#files").onchange = (e) => {
    state.files = [...e.target.files];
    $("#file-info").textContent = `${state.files.length} filer valda`;
  };
  $("#use-file").onclick = async () => {
    const f = $("#files").files?.[0];
    if (!f) return;
    try {
      b.value = await fileToHtml(f);
      s.value = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
      sessionStorage.setItem("draft:subject", s.value);
      sessionStorage.setItem("draft:body", b.value);
    } catch (err) {
      notice(err.message, "error");
    }
  };
  $("#delete-draft").onclick = () => {
    if (!s.value && !b.value && !state.files.length) return;
    if (!confirm("Radera brevet och valda bilagor?")) return;
    s.value = "";
    b.value = "";
    state.files = [];
    sessionStorage.removeItem("draft:subject");
    sessionStorage.removeItem("draft:body");
    const files = $("#files");
    if (files) files.value = "";
    $("#file-info").textContent = "Max 10 MB per fil.";
    notice("Brevet är raderat.", "success");
  };
  $("#back-rec").onclick = () => {
    state.step = 1;
    location.hash = "send/1";
    renderSend($("#root"));
  };
  $("#to-review").onclick = () => {
    if (!b.value.trim()) return notice("Skriv ett brev först.", "error");
    state.step = 3;
    location.hash = "send/3";
    renderSend($("#root"));
  };
}
function file64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
async function ensureCredentials(force = false) {
  if (state.credentials && !force) return;
  state.credentials = await api("/api/mail-credentials");
}
function renderReview() {
  const el = $("#send-step"),
    subject = sessionStorage.getItem("draft:subject") || "",
    body = sessionStorage.getItem("draft:body") || "";
  el.innerHTML = `<div class="stack"><h2>Granska och skicka</h2><div class="kpis"><div class="kpi"><strong id="review-count">…</strong><span>Mottagare</span></div><div class="kpi"><strong>${state.credentials?.length || 0}</strong><span>Mailkonton</span></div><div class="kpi"><strong>${state.files.length}</strong><span>Bilagor</span></div></div><div class="field"><label>Skicka från</label><select class="input" id="credential"><option value="">Välj mailkonto…</option>${(state.credentials || []).map((c) => `<option value="${esc(c.id)}">${esc(c.from_address)} · ${esc(c.provider)}</option>`).join("")}</select></div><div class="card"><div class="card__title">${esc(subject || "(utan ämne)")}</div><p class="muted">${esc(body.replace(/<[^>]+>/g, " ").slice(0, 340))}</p></div><details class="details"><summary>Avancerad utskickstakt</summary><div class="grid grid--3"><div class="field"><label>Högst per dag nu</label><input class="input" id="limit-now" type="number" min="1"></div><div class="field"><label>Växla efter dagar</label><input class="input" id="switch-days" type="number" min="1"></div><div class="field"><label>Högst per dag därefter</label><input class="input" id="limit-after" type="number" min="1"></div></div></details><div class="row"><button class="button button--secondary" id="back-compose">Tillbaka</button><button class="button button--primary" id="send-now">Starta utskick</button></div></div>`;
  recipientCount();
  $("#back-compose").onclick = () => {
    state.step = 2;
    location.hash = "send/2";
    renderSend($("#root"));
  };
  $("#send-now").onclick = async () => {
    const cred = $("#credential").value;
    if (!cred) return notice("Välj mailkonto.", "error");
    const attachments = [];
    for (const f of state.files)
      attachments.push({
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        mode: "attach",
        base64Data: await file64(f),
      });
    const val = (id) => ($(id).value.trim() ? Number($(id).value) : null);
    try {
      const d = await api("/api/send", {
        method: "POST",
        body: JSON.stringify({
          letterHtml: body,
          subject: subject || undefined,
          mailCredentialId: cred,
          ...filterPayload(),
          attachments,
          dailyLimit: val("#limit-now"),
          switchAfterDays: val("#switch-days"),
          nextDailyLimit: val("#limit-after"),
        }),
      });
      sessionStorage.removeItem("draft:subject");
      sessionStorage.removeItem("draft:body");
      state.files = [];
      state.jobs = null;
      state.oneTimeRecipients?.clear();
      notice(`Utskicket startades för ${num(d.totalRecipients)} mottagare.`, "success");
      state.step = 1;
      go("jobs");
    } catch (err) {
      notice(err.message, "error");
    }
  };
}

async function ensureJobs() {
  const rows = await api("/api/send-jobs"),
    unique = new Map();
  for (const j of rows || []) if (j?.id && !unique.has(j.id)) unique.set(j.id, j);
  state.jobs = [...unique.values()];
}
function statusLabel(s) {
  return (
    {
      pending: "Väntar",
      queued: "Köad",
      sending: "Skickar",
      done: "Klar",
      completed: "Klar",
      aborted: "Stoppad",
      stopped: "Stoppad",
      cancelled: "Avbruten",
      failed: "Misslyckad",
    }[s] || s
  );
}
function statusClass(s) {
  return ["done", "completed"].includes(s)
    ? "badge--success"
    : ["failed", "aborted", "cancelled", "stopped"].includes(s)
      ? "badge--warning"
      : "badge--accent";
}
async function renderJobs(root) {
  root.innerHTML = `<div class="page">${pageHead("Utskick", "Status, takt och åtgärder för dina utskick.")}<div id="jobs" class="list"></div></div>`;
  try {
    await Promise.all([ensureJobs(), ensureCredentials()]);
  } catch (err) {
    $("#jobs").innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    return;
  }
  const host = $("#jobs");
  if (!state.jobs.length) {
    host.innerHTML = '<div class="card empty">Inga utskick ännu.</div>';
    return;
  }
  for (const j of state.jobs) {
    const sent = Number(j.sent_count || 0),
      failed = Number(j.bounce_count || j.failed_count || 0),
      total = Number(j.total_recipients || 0),
      pct = total ? Math.min(1, (sent + failed) / total) : 0,
      d = document.createElement("article");
    d.className = "card";
    d.innerHTML = `<div class="row row--between"><span class="badge ${statusClass(j.status)}">${esc(statusLabel(j.status))}</span><span class="card__meta">${fmtDate(j.created_at)}</span></div><div class="kpis section"><div class="kpi"><strong>${num(sent)}</strong><span>Skickade</span></div><div class="kpi"><strong>${num(failed)}</strong><span>Misslyckade</span></div><div class="kpi"><strong>${num(Math.max(0, total - sent - failed))}</strong><span>Kvar</span></div></div><progress class="progress section" max="1" value="${pct}">${Math.round(pct * 100)}%</progress>${j.last_error ? `<div class="notice notice--error section">${esc(j.last_error)}</div>` : ""}<div class="row actions section"></div>`;
    const a = $(".actions", d);
    if (["pending", "queued", "sending"].includes(j.status)) {
      a.append(
        button("Ändra takt", "secondary", () => openRate(j)),
        button("Avbryt", "danger", () => jobAction(j, "cancel")),
      );
    } else a.append(button("Ta bort", "secondary", () => jobAction(j, "delete")));
    host.append(d);
  }
}
async function jobAction(j, action) {
  if (!confirm(action === "delete" ? "Ta bort utskicket?" : "Avbryt utskicket?")) return;
  const jobId = encodeURIComponent(String(j.id));
  try {
    await api(`/api/send-jobs/${jobId}/rate`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
    });
    await renderJobs($("#root"));
  } catch (err) {
    notice(err.message, "error");
  }
}
function openRate(j) {
  showModal(
    "Ändra utskickstakt",
    '<form id="rate-form" class="stack"><div class="field"><label>Högst per dag nu</label><input class="input" name="now" type="number" min="1"></div><div class="field"><label>Växla efter dagar</label><input class="input" name="days" type="number" min="1"></div><div class="field"><label>Högst per dag därefter</label><input class="input" name="after" type="number" min="1"></div><button class="button button--primary" type="submit">Spara</button></form>',
  );
  const form = $("#rate-form"),
    now = $('input[name="now"]', form),
    after = $('input[name="after"]', form);
  now.value = j.daily_limit ?? "";
  after.value = j.next_daily_limit ?? "";
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      v = (x) => (f.get(x) ? Number(f.get(x)) : null),
      jobId = encodeURIComponent(String(j.id));
    try {
      await api(`/api/send-jobs/${jobId}/rate`, {
        method: "PATCH",
        body: JSON.stringify({
          dailyLimit: v("now"),
          switchAfterDays: v("days"),
          nextDailyLimit: v("after"),
        }),
      });
      closeModal();
      await renderJobs($("#root"));
    } catch (err) {
      notice(err.message, "error");
    }
  };
}
