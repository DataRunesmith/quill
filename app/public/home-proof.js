(() => {
  const root = document.querySelector("#root");
  if (!root) return;

  const items = [
    ["/icon-lock.png", "Säkert", "Via ditt eget mailkonto"],
    ["/icon-many.png", "Nå många", "Politiker samtidigt"],
    ["/icon-send.png", "Enkelt", "Snabbt & kostnadsfritt"],
    ["/icon-shield.png", "Dina uppgifter", "Respekteras 100%"],
  ];

  function installHomeProof() {
    const hero = root.querySelector(".hero");
    if (!hero || hero.querySelector(".hero-proof")) return;
    const actions = hero.querySelector(".row");
    if (!actions) return;

    const proof = document.createElement("div");
    proof.className = "hero-proof";
    proof.setAttribute("aria-label", "Varför Quill");

    for (const [src, title, detail] of items) {
      const item = document.createElement("div");
      item.className = "hero-proof__item";

      const icon = document.createElement("img");
      icon.className = "hero-proof__icon";
      icon.src = src;
      icon.alt = "";
      icon.setAttribute("aria-hidden", "true");

      const copy = document.createElement("div");
      copy.className = "hero-proof__copy";
      const strong = document.createElement("strong");
      strong.textContent = title;
      const span = document.createElement("span");
      span.textContent = detail;
      copy.append(strong, span);
      item.append(icon, copy);
      proof.append(item);
    }

    actions.after(proof);
  }

  new MutationObserver(installHomeProof).observe(root, { childList: true, subtree: true });
  installHomeProof();
})();
