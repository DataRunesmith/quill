(function installLetterEditor() {
  const tools = () => {
    if (!window.QuillLetterImport)
      throw new Error("Dokumentimporten kunde inte laddas. Ladda om sidan.");
    return window.QuillLetterImport;
  };
  let editorMammothPromise;

  function loadEditorMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (editorMammothPromise) return editorMammothPromise;
    editorMammothPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mammoth/mammoth.browser.min.js";
      s.async = true;
      s.onload = () => resolve(window.mammoth);
      s.onerror = () => reject(new Error("Word-importen kunde inte laddas."));
      document.head.append(s);
    });
    return editorMammothPromise;
  }

  function storedToEditorHtml(value, t) {
    const stored = String(value || "");
    if (!stored) return "";
    if (/<\/?(?:p|br|div|strong|em|b|i|u|ul|ol|li|blockquote|h[1-3]|span|a)\b/i.test(stored))
      return t.sanitizeHtml(stored, { validate: false });
    return t.textToHtml(stored);
  }

  function editorHtml(editor, t, { requireContent = true } = {}) {
    const html = t.sanitizeHtml(editor.innerHTML);
    const text = t.htmlToText(html, { validate: false });
    if (requireContent && !text.trim()) throw new Error("Skriv ett brev först.");
    return html;
  }

  function insertHtmlAtSelection(html) {
    if (document.execCommand("insertHTML", false, html)) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const template = document.createElement("template");
    template.innerHTML = html;
    const fragment = template.content;
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function wireRichEditor(editor, t, onChange) {
    editor.addEventListener("input", onChange);
    editor.addEventListener("paste", (event) => {
      const html = event.clipboardData?.getData("text/html") || "";
      const text = event.clipboardData?.getData("text/plain") || "";
      if (!html && !text) return;
      event.preventDefault();
      try {
        const safeHtml = html ? t.sanitizeHtml(html) : t.textToHtml(t.validateText(text));
        insertHtmlAtSelection(safeHtml);
        onChange();
      } catch (error) {
        notice(
          error instanceof Error ? error.message : "Den inklistrade texten kunde inte användas.",
          "error",
        );
      }
    });
  }

  async function importedFileToHtml(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    const t = tools();
    if (ext === "docx") {
      const mammoth = await loadEditorMammoth();
      const html =
        (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value || "";
      return t.sanitizeHtml(html);
    }
    if (ext === "html" || ext === "htm") {
      const html = await t.readFileText(file, { html: true });
      return t.sanitizeHtml(html);
    }
    if (ext === "txt") return t.textToHtml(t.validateText(await t.readFileText(file)));
    throw new Error(
      "Den filen kan bifogas, men bara DOCX, HTML och TXT kan användas som brevtext.",
    );
  }

  function sameFile(a, b) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  }
  function renderSelectedFiles() {
    const host = $("#file-list"),
      info = $("#file-info"),
      use = $("#use-file");
    if (!host || !info) return;
    host.innerHTML = "";
    for (const [index, file] of state.files.entries()) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const name = document.createElement("span");
      name.textContent = file.name;
      chip.append(name);
      const remove = button("Ta bort", "quiet", () => {
        state.files.splice(index, 1);
        renderSelectedFiles();
      });
      remove.setAttribute("aria-label", `Ta bort ${file.name}`);
      chip.append(remove);
      host.append(chip);
    }
    info.textContent = state.files.length
      ? `${state.files.length} filer valda`
      : "Max 10 MB per fil.";
    if (use) use.disabled = !state.files.length;
  }

  renderCompose = async function () {
    const el = $("#send-step"),
      t = tools(),
      intros = window.QuillLetterIntros;
    await intros.prepare();
    const stored = sessionStorage.getItem("draft:body") || "";
    const bodyHtml = storedToEditorHtml(stored, t);
    if (stored !== bodyHtml) sessionStorage.setItem("draft:body", bodyHtml);
    el.innerHTML = `<div class="stack"><div class="row row--between compose-head"><div><h2>Skriv brevet</h2><p class="muted">Texten sparas tillfälligt i den här webbläsarfliken tills utskicket startar.</p></div><button class="button button--danger" id="clear-draft" type="button">Rensa formulär</button></div><div class="field"><label>Ämne</label><input class="input" id="subject" value="${esc(sessionStorage.getItem("draft:subject") || "")}"></div><div class="field"><label for="body">Brev</label><div class="input rich-text-editor" id="body" contenteditable="true" style="min-height:220px;resize:vertical;overflow:auto" role="textbox" aria-multiline="true" spellcheck="true"></div><span class="field__hint">Fetstil, kursiv och understrykning från formaterad text behålls. Import kontrolleras för trasiga tecken innan brevet kan skickas.</span></div><section class="card"><div class="row row--between"><div><h3>Börja mejlet med</h3><p class="muted">Valfritt. Vald text läggs efter den automatiska hälsningen “Hej {namn}!” och före brevet.</p></div><button class="button button--quiet" id="manage-intros" type="button">Hantera inledningar</button></div><div id="intro-options" class="stack section"></div></section><details class="details"><summary>Bilagor och dokumentimport</summary><div class="stack"><input class="input" type="file" id="files" multiple accept=".pdf,.txt,.docx,.html,.htm"><div id="file-list" class="chips"></div><p id="file-info" class="muted"></p><button class="button button--secondary" id="use-file" type="button">Använd första filen som brev</button></div></details><div class="row"><button class="button button--secondary" id="back-rec">Tillbaka</button><button class="button button--primary" id="to-review">Nästa: Granska</button></div></div>`;
    const subject = $("#subject"),
      body = $("#body"),
      files = $("#files");
    body.innerHTML = bodyHtml;
    const saveBody = () =>
      sessionStorage.setItem("draft:body", t.sanitizeHtml(body.innerHTML, { validate: false }));
    subject.oninput = () => sessionStorage.setItem("draft:subject", subject.value);
    wireRichEditor(body, t, saveBody);
    intros.renderOptions($("#intro-options"));
    $("#manage-intros").onclick = () => {
      saveBody();
      state.settings = "intros";
      location.hash = "settings/intros";
    };
    files.onchange = (e) => {
      for (const file of [...e.target.files])
        if (!state.files.some((existing) => sameFile(existing, file))) state.files.push(file);
      files.value = "";
      renderSelectedFiles();
    };
    renderSelectedFiles();
    $("#use-file").onclick = async () => {
      const file = state.files[0];
      if (!file) return;
      try {
        const html = await importedFileToHtml(file);
        const text = t.htmlToText(html);
        if (!text.trim()) throw new Error("Dokumentet innehåller ingen brevtext.");
        body.innerHTML = html;
        subject.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
        sessionStorage.setItem("draft:subject", subject.value);
        sessionStorage.setItem("draft:body", html);
        notice(
          "Dokumentet importerades med formatering och teckenkodningen kontrollerades.",
          "success",
        );
      } catch (error) {
        notice(
          error instanceof Error ? error.message : "Dokumentet kunde inte importeras.",
          "error",
        );
      }
    };
    $("#clear-draft").onclick = () => {
      const hasBody = t
        .htmlToText(t.sanitizeHtml(body.innerHTML, { validate: false }), { validate: false })
        .trim();
      if (!subject.value && !hasBody && !state.files.length && !intros.hasSelection()) return;
      if (!confirm("Rensa ämne, brevtext, inledningsval och alla valda filer?")) return;
      subject.value = "";
      body.innerHTML = "";
      state.files = [];
      sessionStorage.removeItem("draft:subject");
      sessionStorage.removeItem("draft:body");
      intros.clearSelection();
      intros.renderOptions($("#intro-options"));
      files.value = "";
      renderSelectedFiles();
      notice("Formuläret är rensat.", "success");
    };
    $("#back-rec").onclick = () => {
      saveBody();
      state.step = 1;
      location.hash = "send/1";
      renderSend($("#root"));
    };
    $("#to-review").onclick = () => {
      try {
        const html = editorHtml(body, t);
        sessionStorage.setItem("draft:body", html);
      } catch (error) {
        notice(error instanceof Error ? error.message : "Kontrollera brevtexten.", "error");
        return;
      }
      state.step = 3;
      location.hash = "send/3";
      renderSend($("#root"));
    };
  };

  renderReview = async function () {
    const el = $("#send-step"),
      t = tools(),
      intros = window.QuillLetterIntros,
      subject = sessionStorage.getItem("draft:subject") || "";
    await intros.prepare();
    const bodyHtml = storedToEditorHtml(sessionStorage.getItem("draft:body") || "", t);
    const introText = intros.selectedText();
    const previewHtml = intros.previewLetter(bodyHtml, introText);
    const bodyText = t.htmlToText(bodyHtml, { validate: false });
    let contentError = "";
    try {
      t.validateText(bodyText);
      if (!bodyText.trim()) contentError = "Brevtext saknas.";
    } catch (error) {
      contentError = error instanceof Error ? error.message : "Kontrollera brevtexten.";
    }
    el.innerHTML = `<div class="stack"><h2>Granska och skicka</h2>${contentError ? `<div class="notice notice--error">${esc(contentError)}</div>` : ""}<div class="kpis"><div class="kpi"><strong id="review-count">…</strong><span>Mottagare</span></div><div class="kpi"><strong>${state.credentials?.length || 0}</strong><span>Mailkonton</span></div><div class="kpi"><strong>${state.files.length}</strong><span>Bilagor</span></div></div><div class="field"><label>Skicka från</label><select class="input" id="credential"><option value="">Välj mailkonto…</option>${(state.credentials || []).map((c) => `<option value="${esc(c.id)}">${esc(c.from_address)} · ${esc(c.provider)}</option>`).join("")}</select></div><div class="card"><div class="card__title">${esc(subject || "(utan ämne)")}</div><div class="muted letter-preview-text rich-text-preview">${previewHtml}</div></div><details class="details"><summary>Avancerad utskickstakt</summary><div class="grid grid--3"><div class="field"><label>Högst per dag nu</label><input class="input" id="limit-now" type="number" min="1"></div><div class="field"><label>Växla efter dagar</label><input class="input" id="switch-days" type="number" min="1"></div><div class="field"><label>Högst per dag därefter</label><input class="input" id="limit-after" type="number" min="1"></div></div></details><div class="row"><button class="button button--secondary" id="back-compose">Tillbaka</button><button class="button button--primary" id="send-now" ${contentError ? "disabled" : ""}>Starta utskick</button></div></div>`;
    recipientCount();
    $("#back-compose").onclick = () => {
      state.step = 2;
      location.hash = "send/2";
      renderSend($("#root"));
    };
    $("#send-now").onclick = async () => {
      const credential = $("#credential").value;
      if (!credential) return notice("Välj mailkonto.", "error");
      let letterHtml;
      try {
        letterHtml = t.sanitizeHtml(bodyHtml);
        const text = t.htmlToText(letterHtml, { validate: false });
        if (!text.trim()) throw new Error("Skriv ett brev först.");
      } catch (error) {
        return notice(error instanceof Error ? error.message : "Kontrollera brevtexten.", "error");
      }
      const attachments = [];
      for (const file of state.files)
        attachments.push({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          mode: "attach",
          base64Data: await file64(file),
        });
      const val = (id) => ($(id).value.trim() ? Number($(id).value) : null);
      try {
        const data = await api("/api/send", {
          method: "POST",
          body: JSON.stringify({
            letterHtml,
            introText: introText || undefined,
            subject: subject || undefined,
            mailCredentialId: credential,
            ...filterPayload(),
            attachments,
            dailyLimit: val("#limit-now"),
            switchAfterDays: val("#switch-days"),
            nextDailyLimit: val("#limit-after"),
          }),
        });
        sessionStorage.removeItem("draft:subject");
        sessionStorage.removeItem("draft:body");
        intros.clearSelection();
        state.files = [];
        state.jobs = null;
        notice(`Utskicket startades för ${num(data.totalRecipients)} mottagare.`, "success");
        state.step = 1;
        go("jobs");
      } catch (error) {
        notice(error instanceof Error ? error.message : "Utskicket kunde inte startas.", "error");
      }
    };
  };

  function openLetterEditor(job) {
    if (!job.letter_html)
      return notice("Brevtexten är inte längre tillgänglig för redigering.", "error");
    const t = tools();
    const html = storedToEditorHtml(job.letter_html, t);
    showModal(
      "Redigera kvarvarande brev",
      `<form id="letter-edit-form" class="stack"><div class="notice notice--warning">Ändringen gäller bara mottagare som ännu inte har skickats.</div><div class="field"><label>Ämne</label><input class="input" name="subject" value="${esc(job.subject || "")}"></div><div class="field"><label for="job-letter-body">Brev</label><div class="input rich-text-editor" id="job-letter-body" contenteditable="true" style="min-height:220px;resize:vertical;overflow:auto" role="textbox" aria-multiline="true" spellcheck="true"></div><span class="field__hint">Formatering behålls. Trasiga tecken måste rättas innan ändringen kan sparas.</span></div><button class="button button--primary" type="submit">Uppdatera kvarvarande brev</button></form>`,
    );
    const editor = $("#job-letter-body");
    editor.innerHTML = html;
    wireRichEditor(editor, t, () => {});
    $("#letter-edit-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      let letterHtml;
      try {
        letterHtml = editorHtml(editor, t);
      } catch (error) {
        return notice(error instanceof Error ? error.message : "Kontrollera brevtexten.", "error");
      }
      try {
        await api(`/api/send-jobs/${job.id}/rate`, {
          method: "PATCH",
          body: JSON.stringify({ letterHtml, subject: String(form.get("subject") || "") }),
        });
        closeModal();
        state.jobs = null;
        await renderJobs($("#root"));
        notice("Kvarvarande mottagare använder nu den uppdaterade texten.", "success");
      } catch (error) {
        notice(error instanceof Error ? error.message : "Brevet kunde inte uppdateras.", "error");
      }
    };
  }

  renderJobs = async function (root) {
    root.innerHTML = `<div class="page">${pageHead("Utskick", "Status, takt och åtgärder för dina utskick.")}<div id="jobs" class="list"></div></div>`;
    try {
      await Promise.all([ensureJobs(), ensureCredentials()]);
    } catch (error) {
      $("#jobs").innerHTML =
        `<div class="notice notice--error">${esc(error instanceof Error ? error.message : String(error))}</div>`;
      return;
    }
    const host = $("#jobs");
    if (!state.jobs.length) {
      host.innerHTML = '<div class="card empty">Inga utskick ännu.</div>';
      return;
    }
    for (const job of state.jobs) {
      const sent = Number(job.sent_count || 0),
        failed = Number(job.bounce_count || job.failed_count || 0),
        total = Number(job.total_recipients || 0),
        pct = total ? Math.min(1, (sent + failed) / total) : 0,
        card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `<div class="row row--between"><span class="badge ${statusClass(job.status)}">${esc(statusLabel(job.status))}</span><span class="card__meta">${fmtDate(job.created_at)}</span></div>${job.subject ? `<div class="card__title section">${esc(job.subject)}</div>` : ""}<div class="kpis section"><div class="kpi"><strong>${num(sent)}</strong><span>Skickade</span></div><div class="kpi"><strong>${num(failed)}</strong><span>Misslyckade</span></div><div class="kpi"><strong>${num(Math.max(0, total - sent - failed))}</strong><span>Kvar</span></div></div><progress class="progress section" max="1" value="${pct}">${Math.round(pct * 100)}%</progress>${job.last_error ? `<div class="notice notice--error section">${esc(job.last_error)}</div>` : ""}<div class="row actions section"></div>`;
      const actions = $(".actions", card);
      if (["pending", "queued", "sending"].includes(job.status))
        actions.append(
          button("Redigera brev", "secondary", () => openLetterEditor(job)),
          button("Ändra takt", "secondary", () => openRate(job)),
          button("Avbryt", "danger", () => jobAction(job, "cancel")),
        );
      else actions.append(button("Ta bort", "secondary", () => jobAction(job, "delete")));
      host.append(card);
    }
  };
})();
