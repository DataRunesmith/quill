(() => {
  const root = document.querySelector("#root");
  if (!root) return;

  function setupCollapsedSignup() {
    const auth = root.querySelector(".auth");
    if (!auth || auth.dataset.signupCollapsed === "1") return;

    const cards = auth.querySelectorAll(":scope > .card");
    if (cards.length < 2) return;

    const signup = cards[1];
    const anchor = document.createComment("signup-panel-anchor");
    const toggle = document.createElement("button");

    auth.dataset.signupCollapsed = "1";
    auth.classList.add("auth--single");
    signup.id = "signup-panel";
    signup.classList.add("auth-signup-panel");
    signup.before(anchor);
    signup.remove();

    toggle.type = "button";
    toggle.id = "signup-toggle";
    toggle.className = "button button--secondary button--block auth-signup-toggle";
    toggle.textContent = "Skapa konto";
    toggle.setAttribute("aria-controls", "signup-panel");
    toggle.setAttribute("aria-expanded", "false");
    anchor.after(toggle);

    toggle.addEventListener("click", () => {
      const opening = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", opening ? "true" : "false");
      toggle.textContent = opening ? "Dölj skapa konto" : "Skapa konto";

      if (opening) {
        toggle.after(signup);
        if (typeof window.renderTurnstiles === "function") window.renderTurnstiles();
        requestAnimationFrame(() => signup.scrollIntoView({ block: "start", behavior: "smooth" }));
      } else {
        signup.remove();
        toggle.focus({ preventScroll: true });
      }
    });
  }

  const observer = new MutationObserver(setupCollapsedSignup);
  observer.observe(root, { childList: true, subtree: true });
  setupCollapsedSignup();
})();
