// Incrémente la version patch (a.b.c -> a.b.c+1) dans tous les fichiers concernés.
// Node pur (aucun appel npm) pour éviter le crash « Exit handler never called! »
// de npm sous Git Bash sur les runners Windows.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const bump = (v) => {
  const [a, b, c] = v.split(".").map(Number);
  return `${a}.${b}.${c + 1}`;
};

// package.json
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const NEW = bump(pkg.version);
pkg.version = NEW;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// package-lock.json (version racine + packages[""] pour rester en phase avec npm ci)
try {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  lock.version = NEW;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = NEW;
  writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
} catch {
  /* pas de lockfile : ignoré */
}

// src-tauri/tauri.conf.json
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = NEW;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// src-tauri/Cargo.toml (1re occurrence de `version = "..."`, celle de [package])
const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8").replace(/^version = ".*"$/m, `version = "${NEW}"`);
writeFileSync(cargoPath, cargo);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${NEW}\n`);
console.log("Nouvelle version:", NEW);
