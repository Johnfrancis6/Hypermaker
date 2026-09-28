// Le Chrome du moteur. hyperframes@0.8.83 télécharge et choisit lui-même son
// Chrome (~/.cache/hyperframes/chrome) : épingler le moteur n'épingle pas
// Chrome (brief §9). Le lint doit mesurer dans LE MÊME navigateur que celui
// qui capture, et chaque relevé porte sa version.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function chromeDuMoteur() {
  const base = path.join(os.homedir(), ".cache/hyperframes/chrome/chrome-headless-shell");
  if (!fs.existsSync(base)) throw new Error(`Chrome du moteur absent (${base}) : lancer un premier rendu hyperframes pour qu'il le télécharge`);
  const versions = fs.readdirSync(base);
  if (versions.length !== 1) throw new Error(`${versions.length} Chrome du moteur dans ${base} (${versions.join(", ")}) : lequel capture est ambigu`);
  const chemin = path.join(base, versions[0], "chrome-headless-shell-linux64/chrome-headless-shell");
  const version = execFileSync(chemin, ["--version"]).toString().trim();
  return { chemin, version };
}

export const VERSION_MOTEUR = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../node_modules/hyperframes/package.json"), "utf8"),
).version;
