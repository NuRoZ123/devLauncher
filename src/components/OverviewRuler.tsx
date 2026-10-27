import { memo } from "react";

/** Une marque de la barre d'aperçu : lignes [start, end) et classe de couleur. */
export interface RulerMark {
  start: number;
  end: number;
  /** Classe de couleur (mv-hl-modified / added / deleted / conflict…). */
  cls: string;
  /** Changement déjà traité : marque atténuée. */
  done?: boolean;
}

/**
 * Barre d'aperçu des changements, à droite d'un volet de code (comme la marge
 * de droite des IDE) : chaque changement y est placé en proportion de sa
 * position dans le fichier, pour voir d'un coup d'œil où ils sont. Un clic
 * amène le volet à la ligne correspondante.
 */
export const OverviewRuler = memo(function OverviewRuler({
  marks,
  total,
  onJump,
}: {
  marks: RulerMark[];
  /** Nombre total de lignes du volet. */
  total: number;
  onJump: (line: number) => void;
}) {
  const n = Math.max(1, total);
  return (
    <div
      className="mv-ruler"
      title="Aperçu des changements — cliquer pour y aller"
      onMouseDown={(e) => {
        // Clic n'importe où : saut à la ligne correspondante (proportionnel).
        const r = e.currentTarget.getBoundingClientRect();
        onJump(Math.floor(((e.clientY - r.top) / r.height) * n));
      }}
    >
      {marks.map((m, i) => (
        <div
          key={i}
          className={"mv-ruler-mark " + m.cls + (m.done ? " mv-ruler-done" : "")}
          style={{
            top: `${(m.start / n) * 100}%`,
            // Hauteur proportionnelle, mais toujours visible (au moins 3 px).
            height: `max(3px, ${((Math.max(1, m.end - m.start)) / n) * 100}%)`,
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onJump(m.start);
          }}
        />
      ))}
    </div>
  );
});
