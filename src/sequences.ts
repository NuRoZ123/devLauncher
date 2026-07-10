import type { ActionDef, Sequence } from "./types";

// Une étape de séquence (dans `Sequence.actionIds`) est soit un id d'action, soit
// une référence à une autre séquence, préfixée par "seq:". Les séquences par
// projet ne contiennent que des actions ; les séquences générales peuvent aussi
// référencer des séquences (par projet) à jouer sur plusieurs cibles.
export const SEQ_PREFIX = "seq:";

export const isSeqRef = (ref: string) => ref.startsWith(SEQ_PREFIX);
export const seqRef = (id: string) => `${SEQ_PREFIX}${id}`;

export interface StepInfo {
  ref: string;
  kind: "action" | "sequence";
  id: string;
  label: string;
  color?: string;
  /** false = l'action ou la séquence référencée a été supprimée. */
  valid: boolean;
}

export function resolveStep(
  ref: string,
  actions: ActionDef[],
  sequences: Sequence[],
  seen: Set<string> = new Set(),
): StepInfo {
  if (isSeqRef(ref)) {
    const id = ref.slice(SEQ_PREFIX.length);
    const seq = sequences.find((s) => s.id === id);
    return {
      ref,
      kind: "sequence",
      id,
      label: seq?.name ?? id,
      color: seq?.color,
      valid: !!seq && isSequenceValid(seq, actions, sequences, seen),
    };
  }
  const a = actions.find((x) => x.id === ref);
  return { ref, kind: "action", id: ref, label: a?.label ?? ref, color: a?.color, valid: !!a };
}

/** Une séquence est valide si chacune de ses étapes (action ou sous-séquence) existe encore. */
export function isSequenceValid(
  seq: Sequence,
  actions: ActionDef[],
  sequences: Sequence[],
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(seq.id)) return true; // garde-fou anti-cycle
  const next = new Set(seen).add(seq.id);
  return seq.actionIds.every((ref) => resolveStep(ref, actions, sequences, next).valid);
}

/**
 * Aplati une séquence en sa liste ordonnée d'actions résolues, en développant les
 * étapes qui référencent une sous-séquence. Les éléments supprimés sont ignorés
 * (utiliser `isSequenceValid` pour détecter l'invalidité en amont).
 */
export function expandActions(
  seq: Sequence,
  actions: ActionDef[],
  sequences: Sequence[],
  seen: Set<string> = new Set(),
): ActionDef[] {
  if (seen.has(seq.id)) return [];
  const next = new Set(seen).add(seq.id);
  const out: ActionDef[] = [];
  for (const ref of seq.actionIds) {
    if (isSeqRef(ref)) {
      const sub = sequences.find((s) => s.id === ref.slice(SEQ_PREFIX.length));
      if (sub) out.push(...expandActions(sub, actions, sequences, next));
    } else {
      const a = actions.find((x) => x.id === ref);
      if (a) out.push(a);
    }
  }
  return out;
}
