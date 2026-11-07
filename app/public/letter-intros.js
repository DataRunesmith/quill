(function installLetterIntros() {
  const BROAD_AUDIENCE_INTRO =
    "Detta brev skickas till politiker, journalister och akademiker. Det är inte anpassat efter någon särskild grupp mer än riksdagen, justitiedepartementet eller konstitutionsutskottet.";
  const BROAD_KEY = "draft:broadAudienceIntro";
  const PRESET_IDS_KEY = "draft:introPresetIds";
  let selectionRestored = false;

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || "Okänt fel");
  }

  function restoreSelection() {
    if (selectionRestored) return;
    selectionRestored = true;
    state.useBroadAudienceIntro = sessionStorage.getItem(BROAD_KEY) === "1";
    try {
      const ids = JSON.parse(sessionStorage.getItem(PRESET_IDS_KEY) || "[]");
      state.selectedIntroIds = new Set(Array.isArray(ids) ? ids : []);
    } catch {
      state.selectedIntroIds = new Set();
    }
  }

  function persistSelection() {
    sessionStorage.setItem(BROAD_KEY, state.useBroadAudienceIntro ? "1" : "0");
    sessionStorage.setItem(PRESET_IDS_KEY, JSON.stringify([...state.selectedIntroIds]));
  }

  function clearSelection() {
    state.useBroadAudienceIntro = false;
    state.selectedIntroIds.clear();
    sessionStorage.removeItem(BROAD_KEY);
    sessionStorage.removeItem(PRESET_IDS_KEY);
  }

  function hasSelection() {
    return state.useBroadAudienceIntro || state.selectedIntroIds.size > 0;
  }

  async function ensurePresets(force = false) {
    if (state.introPresets && !force) return state.introPresets;
    state.introPresets = await api("/api/letter-intro-presets");
    return state.introPresets;
  }

  function pruneSelection() {
    const available = new Set((state.introPresets || []).map((preset) => preset.id));
    for (const id of [...state.selectedIntroIds])
      if (!available.has(id)) state.selectedIntroIds.delete(id);
    persistSelection();
  }

  async function prepare() {
    restoreSelection();
    await ensurePresets();
    pruneSelection();
  }

  function selectedText() {
    const parts = [];
    if (state.useBroadAudienceIntro) parts.push(BROAD_AUDIENCE_INTRO);
    for (const preset of state.introPresets || []) {
      if (state.selectedIntroIds.has(preset.id)) parts.push(String(preset.body || "").trim());
    }
    return parts.filter(Boolean).join("\n\n");
  }

  function previewLetter(bodyHtml, introText) {
    const greeting = "Hej {namn}!";
    const safeIntro = esc(introText).replace(/\n/g, "<br>");
    const greetingWithIntro = safeIntro ? `${greeting}<br><br>${safeIntro}` : greeting;
    if (/\{GREETING\}/i.test(bodyHtml))
      return bodyHtml.replace(/\{GREETING\}/gi, greetingWithIntro);
    if (/Hej\s+\[förnamn\]!/i.test(bodyHtml))
      return bodyHtml.replace(/Hej\s+\[förnamn\]!/gi, greetingWithIntro);
    return `<p>${greeting}</p>${safeIntro ? `<p>${safeIntro}</p>` : ""}${bodyHtml}`;
  }

  function createOption(title, description, checked, onChange) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.onchange = () => onChange(input.checked);

    const text = document.createElement("span");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const detail = document.createElement("span");
    detail.className = "muted";
    detail.textContent = description;
    text.append(heading, document.createElement("br"), detail);
    label.append(input, text);
    return label;
  }

  function renderOptions(host) {
    host.replaceChildren();
    host.append(
      createOption(
        "Brett mottagarbrev",
        BROAD_AUDIENCE_INTRO,
        state.useBroadAudienceIntro,
        (checked) => {
          state.useBroadAudienceIntro = checked;
          persistSelection();
        },
      ),
    );
    for (const preset of state.introPresets || []) {
      host.append(
        createOption(
          preset.title,
          preset.body,
          state.selectedIntroIds.has(preset.id),
          (checked) => {
            checked
              ? state.selectedIntroIds.add(preset.id)
              : state.selectedIntroIds.delete(preset.id);
            persistSelection();
          },
        ),
      );
    }
  }

  function appendMultilineText(element, value) {
    const lines = String(value || "").split("\n");
    lines.forEach((line, index) => {
      if (index) element.append(document.createElement("br"));
      element.append(document.createTextNode(line));
    });
  }

  function renderError(host, error) {
    const message = document.createElement("div");
    message.className = "notice notice--error";
    message.textContent = errorMessage(error);
    host.replaceChildren(message);
  }

  function openPresetForm(preset = null) {
    const editing = Boolean(preset);
    showModal(
      editing ? "Redigera inledning" : "Ny inledning",
      '<form id="intro-preset-form" class="stack"><div class="field"><label>Rubrik</label><input class="input" name="title" maxlength="80" required></div><div class="field"><label>Text</label><textarea class="input" name="body" rows="8" maxlength="4000" required></textarea><span class="field__hint">Texten läggs efter “Hej {namn}!” och före brevets egen text.</span></div><button class="button button--primary" type="submit"></button></form>',
    );
    const form = $("#intro-preset-form");
    form.elements.title.value = preset?.title || "";
    form.elements.body.value = preset?.body || "";
    $('button[type="submit"]', form).textContent = editing ? "Spara ändring" : "Spara inledning";
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const payload = {
        title: String(data.get("title") || ""),
        body: String(data.get("body") || ""),
      };
      try {
        await api(
          editing
            ? `/api/letter-intro-presets/${encodeURIComponent(preset.id)}`
            : "/api/letter-intro-presets",
          {
            method: editing ? "PATCH" : "POST",
            body: JSON.stringify(payload),
          },
        );
        state.introPresets = null;
        closeModal();
        await renderSettings();
        notice(editing ? "Inledningen uppdaterades." : "Inledningen sparades.", "success");
      } catch (error) {
        notice(errorMessage(error), "error");
      }
    };
  }

  function createPresetRow(preset) {
    const row = document.createElement("article");
    row.className = "card";

    const layout = document.createElement("div");
    layout.className = "row row--between";
    const copy = document.createElement("div");
    const title = document.createElement("div");
    title.className = "card__title";
    title.textContent = preset.title;
    const body = document.createElement("div");
    body.className = "muted section";
    appendMultilineText(body, preset.body);
    copy.append(title, body);

    const actions = document.createElement("div");
    actions.className = "row";
    const edit = button("Redigera", "secondary", () => openPresetForm(preset));
    const remove = button("Radera", "danger", async () => {
      if (!confirm(`Radera inledningen “${preset.title}”?`)) return;
      try {
        await api(`/api/letter-intro-presets/${encodeURIComponent(preset.id)}`, {
          method: "DELETE",
        });
        state.selectedIntroIds.delete(preset.id);
        persistSelection();
        state.introPresets = null;
        await renderSettings();
        notice("Inledningen raderades.", "success");
      } catch (error) {
        notice(errorMessage(error), "error");
      }
    });
    actions.append(edit, remove);
    layout.append(copy, actions);
    row.append(layout);
    return row;
  }

  async function renderSettings() {
    const panel = $("#settings-panel");
    panel.innerHTML =
      '<section class="card"><div class="row row--between"><div><div class="card__eyebrow">Brev</div><h2>Inledningar</h2><p class="muted">Spara återanvändbara alternativ som kan väljas när du skriver eller importerar ett brev. De placeras efter den personliga hälsningen och före själva brevet.</p></div><button class="button button--primary" id="intro-new" type="button">Ny inledning</button></div><div id="intro-preset-list" class="list section"><div class="empty">Laddar…</div></div></section>';
    $("#intro-new").onclick = () => openPresetForm();
    const host = $("#intro-preset-list");
    try {
      const presets = await ensurePresets(true);
      host.replaceChildren();
      if (!presets.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Inga egna inledningar sparade ännu.";
        host.append(empty);
        return;
      }
      for (const preset of presets) host.append(createPresetRow(preset));
    } catch (error) {
      renderError(host, error);
    }
  }

  window.QuillLetterIntros = {
    clearSelection,
    hasSelection,
    prepare,
    previewLetter,
    renderOptions,
    renderSettings,
    selectedText,
  };
})();
