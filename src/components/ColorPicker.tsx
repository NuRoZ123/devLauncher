import { useEffect, useRef, useState } from "react";

// Palette de 16 couleurs majeures, lisibles sur fond sombre (spectre complet).
const PALETTE = [
  "#f85149", // rouge
  "#ff7b39", // orange
  "#f0a72a", // ambre
  "#e6d534", // jaune
  "#a5d64c", // vert-lime
  "#3fb950", // vert
  "#1fbd95", // émeraude
  "#24c3d4", // cyan
  "#4aa8ff", // bleu clair
  "#4f8cff", // bleu
  "#7a6cff", // indigo
  "#a371f7", // violet
  "#d472e0", // magenta
  "#f778ba", // rose
  "#b3855e", // brun
  "#c9d1d9", // gris clair
];

interface Props {
  value?: string;
  onChange: (color: string) => void;
}

// Sélecteur de couleur : palette prédéfinie + couleur personnalisée + « Aucune ».
export function ColorPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const w = 196;
      const m = 8;
      setPos({
        x: Math.max(m, Math.min(r.left, window.innerWidth - w - m)),
        y: r.bottom + 4,
      });
      setOpen(true);
    }
  }

  const pick = (c: string) => {
    onChange(c);
    setOpen(false);
  };

  return (
    <span className="colorpick">
      <button
        ref={btnRef}
        type="button"
        className={"colorpick-swatch" + (value ? "" : " none")}
        style={value ? { background: value } : undefined}
        title={value ? "Modifier la couleur" : "Attribuer une couleur"}
        onClick={toggle}
      />
      {open && pos && (
        <div ref={popRef} className="colorpick-pop" style={{ left: pos.x, top: pos.y }}>
          <div className="colorpick-grid">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={"colorpick-cell" + (value?.toLowerCase() === c ? " on" : "")}
                style={{ background: c }}
                title={c}
                onClick={() => pick(c)}
              />
            ))}
          </div>
          <div className="colorpick-foot">
            <label className="colorpick-custom" title="Couleur personnalisée">
              <input
                type="color"
                value={value || "#4f8cff"}
                onChange={(e) => onChange(e.target.value)}
              />
              <span>Perso.</span>
            </label>
            <button
              type="button"
              className="colorpick-reset"
              disabled={!value}
              onClick={() => pick("")}
            >
              Aucune
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
