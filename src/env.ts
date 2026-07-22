/** Parse le contenu d'un fichier .env en map clé → valeur.
 *  Ignore les lignes vides et les commentaires (#), gère le préfixe `export`
 *  et retire les guillemets simples/doubles entourant la valeur. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Liste ordonnée des clés définies dans un .env. */
export function envKeys(content: string): string[] {
  return Object.keys(parseEnv(content));
}
