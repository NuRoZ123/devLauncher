// Branches protégées : un commit ou un push direct dessus demande confirmation
// (la branche principale du dépôt distant l'est toujours, en plus de cette liste).

/** Liste par défaut, tant que l'utilisateur ne l'a pas modifiée dans les réglages. */
export const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "develop", "release/*"];

/** Motif « * » (n'importe quelle suite de caractères) → expression régulière. */
function toRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

/** Premier motif qui couvre la branche, null sinon. */
export function protectedMatch(branch: string, patterns: string[]): string | null {
  return patterns.find((p) => p.trim() && toRegex(p.trim()).test(branch)) ?? null;
}
