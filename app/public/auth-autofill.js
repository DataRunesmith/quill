(() => {
  const root = document.querySelector("#root");
  if (!root) return;

  const watchedForms = new WeakSet();

  function isAutofilled(input) {
    try {
      if (input.matches(":autofill")) return true;
    } catch {}
    try {
      return input.matches(":-webkit-autofill");
    } catch {
      return false;
    }
  }

  function setupAutofillLogin() {
    const form = root.querySelector("#login-form");
    if (!(form instanceof HTMLFormElement) || watchedForms.has(form)) return;

    const email = form.querySelector("#login-email");
    const password = form.querySelector("#login-password");
    const totpRow = form.querySelector("#totp-row");
    if (
      !(email instanceof HTMLInputElement) ||
      !(password instanceof HTMLInputElement) ||
      !(totpRow instanceof HTMLElement)
    )
      return;

    watchedForms.add(form);
    let autoSubmitted = false;
    let pollTimer = 0;

    const stopPolling = () => {
      if (!pollTimer) return;
      window.clearInterval(pollTimer);
      pollTimer = 0;
    };

    const checkAutofill = () => {
      if (!document.contains(form)) {
        stopPolling();
        return;
      }
      if (autoSubmitted || !totpRow.hidden) {
        stopPolling();
        return;
      }
      if (!email.value || !password.value) return;
      if (!isAutofilled(email) || !isAutofilled(password)) return;

      autoSubmitted = true;
      stopPolling();
      form.requestSubmit();
    };

    const scheduleCheck = () => {
      queueMicrotask(checkAutofill);
      requestAnimationFrame(checkAutofill);
    };

    for (const input of [email, password]) {
      input.addEventListener("input", scheduleCheck);
      input.addEventListener("change", scheduleCheck);
      input.addEventListener("focus", scheduleCheck);
    }

    pollTimer = window.setInterval(checkAutofill, 250);
    window.setTimeout(stopPolling, 30000);
    scheduleCheck();
  }

  const observer = new MutationObserver(setupAutofillLogin);
  observer.observe(root, { childList: true, subtree: true });
  setupAutofillLogin();
})();
