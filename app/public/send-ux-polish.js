(function installSendUxPolish() {
  const NOTICE_LIFETIME_MS = { info: 8000, success: 8000, warning: 12000, error: 12000 };
  let noticeTimer = null;

  function readStoredNotice() {
    try {
      return JSON.parse(sessionStorage.getItem("ui:lastNotice") || "null");
    } catch {
      return null;
    }
  }

  function clearStoredNotice() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    sessionStorage.removeItem("ui:lastNotice");
    if (typeof originalRenderNotice === "function") originalRenderNotice();
  }

  function scheduleNoticeExpiry() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    const item = readStoredNotice();
    if (!item) return;
    const lifetime = NOTICE_LIFETIME_MS[item.type] || NOTICE_LIFETIME_MS.info;
    const remaining = lifetime - (Date.now() - Number(item.ts || 0));
    if (remaining <= 0) {
      clearStoredNotice();
      return;
    }
    noticeTimer = setTimeout(clearStoredNotice, remaining);
  }

  const originalNotice = typeof window.notice === "function" ? window.notice : null;
  const originalRenderNotice =
    typeof window.renderNotice === "function" ? window.renderNotice : null;

  if (originalNotice) {
    window.notice = function (text, type = "info") {
      originalNotice(text, type);
      scheduleNoticeExpiry();
    };
  }

  if (originalRenderNotice) {
    window.renderNotice = function () {
      originalRenderNotice();
      scheduleNoticeExpiry();
    };
  }

  function signatureNotice(text, kind) {
    const note = document.createElement("div");
    note.className = "notice";
    note.dataset.signatureNote = kind;
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = "Signatur: ";
    span.append(strong, document.createTextNode(text));
    note.append(span);
    return note;
  }

  function installSignatureNotes() {
    const editor = document.querySelector("#body");
    if (editor) {
      const field = editor.closest(".field");
      if (field && !field.querySelector('[data-signature-note="compose"]')) {
        field.append(
          signatureNotice(
            "Mail-appens vanliga signatur läggs inte till automatiskt vid utskick. Lägg din signatur i brevet här om du vill att den ska följa med.",
            "compose",
          ),
        );
      }
    }

    const preview = document.querySelector(".letter-preview-text")?.closest(".card");
    if (preview && !document.querySelector('[data-signature-note="review"]')) {
      preview.insertAdjacentElement(
        "afterend",
        signatureNotice(
          "Det du ser i brevet ovan är det som skickas. Ingen extra signatur från Mail-appen läggs till.",
          "review",
        ),
      );
    }
  }

  scheduleNoticeExpiry();
  installSignatureNotes();

  const root = document.querySelector("#root");
  if (root)
    new MutationObserver(installSignatureNotes).observe(root, { childList: true, subtree: true });
})();
