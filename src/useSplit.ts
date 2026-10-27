import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Séparateur redimensionnable entre deux volets (même principe que celui
 * projets / console) : renvoie la part du 1er volet en %, la réf du conteneur
 * et le gestionnaire `onMouseDown` de la barre. La position est mémorisée
 * (par `key`) d'une ouverture à l'autre.
 * `axis` : "x" = volets côte à côte (barre verticale), "y" = empilés.
 */
export function useSplit(key: string, initial: number, min = 15, max = 85, axis: "x" | "y" = "x") {
  const storeKey = "devlauncher.split." + key;
  const [pct, setPct] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storeKey));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pctRef = useRef(pct);
  pctRef.current = pct;

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const p = axis === "x" ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100;
      const next = Math.max(min, Math.min(max, p));
      // Réf à jour tout de suite : un relâchement immédiat enregistre la bonne valeur.
      pctRef.current = next;
      setPct(next);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(storeKey, String(Math.round(pctRef.current * 10) / 10));
      } catch {
        /* stockage indisponible : position non mémorisée */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [axis, min, max, storeKey]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [axis],
  );

  return { pct, ref, onMouseDown };
}
