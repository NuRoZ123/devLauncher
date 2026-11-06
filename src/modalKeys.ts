// Clavier commun à toutes les boîtes modales (`.modal-backdrop > .modal`) :
// Entrée déclenche le bouton principal, Échap le bouton de fermeture/secondaire.
// Écouté en phase de capture sur window pour passer avant les raccourcis de la
// page (Échap de App fermerait sinon aussi la vue située sous la modale).

/** Modale la plus haute (la dernière montée dans le DOM). */
function topModal(): HTMLElement | null {
  const backdrops = document.querySelectorAll<HTMLElement>(".modal-backdrop:not(.motion-ghost)");
  const top = backdrops[backdrops.length - 1];
  return top?.querySelector<HTMLElement>(".modal") ?? null;
}

/** Bouton principal : `.btn-primary` du pied, à défaut l'action destructive d'une confirmation. */
function primaryButton(modal: HTMLElement) {
  const footer = modal.querySelector(".modal-footer");
  if (!footer) return null;
  const primaries = footer.querySelectorAll<HTMLButtonElement>("button.btn-primary");
  if (primaries.length) return primaries[primaries.length - 1];
  const stops = footer.querySelectorAll<HTMLButtonElement>("button.btn-stop");
  return stops[stops.length - 1] ?? null;
}

/** Bouton de sortie : la croix de l'en-tête, sinon le premier bouton discret du pied. */
function secondaryButton(modal: HTMLElement) {
  return (
    modal.querySelector<HTMLButtonElement>(".modal-head button.tab-close") ??
    modal.querySelector<HTMLButtonElement>(".modal-footer button.btn-ghost")
  );
}

/** Entrée garde son rôle natif sur ces éléments (retour à la ligne, activation, liste ouverte). */
function keepsEnter(el: EventTarget | null, ctrl: boolean) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return !ctrl;
  switch (el.tagName) {
    case "TEXTAREA":
      return !ctrl; // Ctrl+Entrée valide même depuis une zone de texte
    case "BUTTON":
    case "A":
    case "SELECT":
      return true;
  }
  return false;
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.repeat) return;
  if (e.key !== "Enter" && e.key !== "Escape") return;
  if (e.altKey || e.shiftKey || e.metaKey) return;
  const modal = topModal();
  if (!modal) return;

  let btn: HTMLButtonElement | null;
  if (e.key === "Escape") {
    if (e.ctrlKey) return;
    btn = secondaryButton(modal);
  } else {
    if (keepsEnter(e.target, e.ctrlKey)) return;
    btn = primaryButton(modal);
  }
  if (!btn) return; // modale sans bouton reconnu : on laisse ses propres gestionnaires agir
  // Un bouton désactivé consomme quand même la touche : rien ne doit fuir sous la modale.
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!btn.disabled) btn.click();
}

/** À appeler une fois au démarrage ; renvoie la fonction de désinscription. */
export function installModalKeys() {
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
