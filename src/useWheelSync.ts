import { useEffect, useRef, type RefObject } from "react";

/**
 * Défilement vertical à la molette piloté en JavaScript dans les vues à volets
 * reliés (comparaison, conflits).
 *
 * Dans WebView2, la molette fait défiler le volet sur le fil du compositeur,
 * AVANT que JavaScript ne reçoive l'événement `scroll` : les liaisons colorées
 * des gouttières (dessinées en JS) avaient donc toujours une image de retard.
 * Ici la molette est interceptée et le défilement appliqué par le script, image
 * par image (glissement court), en appelant `onScrolled` à chaque pas : volets
 * voisins et gouttières sont mis à jour dans la même image que le texte.
 *
 * Seule la molette verticale simple est prise : Maj / Ctrl / horizontal restent
 * gérés par le navigateur et le relais global (wheel.ts).
 */
export function useWheelSync(
  hostRef: RefObject<HTMLElement>,
  onScrolled: (el: HTMLElement) => void,
  lineHeight: number,
) {
  // Toujours la dernière version du rappel (il dépend de l'état du composant).
  const cb = useRef(onScrolled);
  cb.current = onScrolled;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let el: HTMLElement | null = null;
    let target = 0;
    let raf = 0;

    const step = () => {
      raf = 0;
      if (!el) return;
      const d = target - el.scrollTop;
      // Glissement : 35 % du reste à chaque image, au moins 1 px.
      const next = Math.abs(d) <= 1 ? target : el.scrollTop + Math.sign(d) * Math.max(1, Math.abs(d) * 0.35);
      el.scrollTop = Math.round(next);
      cb.current(el);
      if (Math.abs(target - el.scrollTop) > 0.5 && el.scrollTop !== (d > 0 ? el.scrollHeight - el.clientHeight : 0))
        raf = requestAnimationFrame(step);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.shiftKey || e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const pane = (e.target as Element | null)?.closest?.(".mv-scroll") as HTMLElement | null;
      if (!pane || !host.contains(pane)) return;
      const max = pane.scrollHeight - pane.clientHeight;
      if (max <= 0) return;
      e.preventDefault();
      const px =
        e.deltaMode === 1 ? e.deltaY * lineHeight * 3 : e.deltaMode === 2 ? e.deltaY * pane.clientHeight : e.deltaY;
      // Crans rapprochés : on cumule vers la cible au lieu de repartir de la position actuelle.
      const from = el === pane && raf ? target : pane.scrollTop;
      el = pane;
      target = Math.max(0, Math.min(max, from + px));
      if (!raf) raf = requestAnimationFrame(step);
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, lineHeight]);
}
