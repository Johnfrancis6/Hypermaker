// rendre() — l'adaptateur de rendu de T0, réduit à une fonction (brief §2).
// Renvoie les champs de ResultatRendu (§5.1) : duree_ms, frames,
// hash_frames, polices_ok — noms figés — plus journal.
//
// 1. verifier() avant rendre() (§5.1, règle 4) : le lint (R4, R5, R11) passe
//    d'abord ; s'il échoue, on ne rend pas.
// 2. Le moteur sort des PNG sans perte (--format png-sequence). Il ne produit
//    ni son ni MP4 : l'encodage est une commande FFmpeg de notre code.
// 3. Réseau, couches 2 à 4 du brief (§8, §9) :
//    - télémétrie coupée (HYPERFRAMES_NO_TELEMETRY, DO_NOT_TRACK) ;
//    - espace de noms réseau vide (unshare -rn), boucle locale seule active :
//      le moteur en a besoin (serveur de fichiers, pilotage de Chrome) ;
//    - journal : strace trace sockets, connexions, envois, fermetures, dup et
//      clone de TOUT l'arbre de processus (Node du moteur et Chrome).
//      journal-reseau.mjs applique la règle au niveau des octets : le rendu
//      échoue si une donnée franchit la frontière, avec une seule tolérance
//      nommée et pinée (la sonde IPv6 de Chrome). Tous les hôtes et toutes
//      les sondes sont journalisés.
// 4. hash_frames : sha256 des md5 de frames, dans l'ordre, calculés par
//    framemd5 sur les pixels DÉCODÉS, jamais sur les octets PNG.
//
// Usage : node outils/rendre.mjs <dossier_rendu> <dossier_png>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { linter } from "./lint-zone-securite.mjs";
import { analyserTrace, SONDE_IPV6_CHROME } from "./journal-reseau.mjs";
import { chromeDuMoteur, VERSION_MOTEUR } from "./chrome.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const HYPERFRAMES = path.join(RACINE, "node_modules/.bin/hyperframes");

export class ErreurRendu extends Error {}

export function hashFrames(dossierPng, fps) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-framerate", String(fps), "-i", path.join(dossierPng, "frame_%06d.png"), "-f", "framemd5", "-"], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new ErreurRendu(`framemd5 : ${r.stderr}`);
  const md5 = r.stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
  return { frames: md5.length, hash_frames: crypto.createHash("sha256").update(md5.join("\n")).digest("hex") };
}

// verifier / isoler ne sont désactivables que pour prouver que le détecteur
// réseau détecte (rendre.test.mjs). La commande en ligne ne les expose pas.
export async function rendre(dossier, dossierPng, { verifier = true, isoler = true } = {}) {
  const donnees = JSON.parse(
    fs.readFileSync(path.join(dossier, "index.html"), "utf8").match(/<script type="application\/json" id="hm-donnees">([\s\S]*?)<\/script>/)[1],
  );
  const chrome = chromeDuMoteur();

  let polices_ok = null;
  if (verifier) {
    const lint = await linter(dossier);
    if (!lint.ok) throw new ErreurRendu(`lint en échec, rendu refusé :\n${JSON.stringify(lint.violations, null, 2)}`);
    polices_ok = lint.polices_ok;
  }

  fs.rmSync(dossierPng, { recursive: true, force: true });
  const trace = `${dossierPng}.strace`;
  const moteur = [HYPERFRAMES, "render", path.resolve(dossier), "--format", "png-sequence", "--fps", String(donnees.fps), "-o", path.resolve(dossierPng)];
  const commande = isoler ? ["unshare", "-rn", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", ...moteur] : moteur;
  const debut = Date.now();
  const r = spawnSync("strace", ["-f", "-qq", "--seccomp-bpf", "-e", "trace=socket,connect,close,write,writev,sendto,sendmsg,sendmmsg,dup,dup2,dup3,clone,clone3,fork,vfork", "-o", trace, ...commande], {
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    maxBuffer: 1 << 26,
  });
  const dureeRenduMs = Date.now() - debut;
  const sortie = r.stdout.toString() + r.stderr.toString();

  const reseau = analyserTrace(fs.readFileSync(trace, "utf8"));
  fs.rmSync(trace);
  const hotes = [...reseau.hotes].map(([a, n]) => `${a} ×${n}`).join(", ") || "aucun";
  const chromeCapture = sortie.match(/HeadlessChrome\/([\d.]+)/)?.[1] ?? "inconnu";
  const journal = [
    `moteur hyperframes ${VERSION_MOTEUR}, Chrome de capture ${chromeCapture}, Chrome du lint « ${chrome.version} »`,
    `isolation réseau : ${isoler ? "unshare -rn, boucle locale seule" : "AUCUNE"} ; hôtes contactés : ${hotes}`,
    `exception documentée : ${reseau.sondes} sonde(s) de joignabilité IPv6 de Chrome (UDP, ${SONDE_IPV6_CHROME.adresse}:${SONDE_IPV6_CHROME.port}, zéro envoi), tolérée(s)`,
    `rendu PNG : ${dureeRenduMs} ms, code de sortie ${r.status}`,
  ].join("\n");

  if (reseau.violations.length) throw new ErreurRendu(`R11 : une donnée a tenté de franchir la frontière :\n  ${[...new Set(reseau.violations)].slice(0, 20).join("\n  ")}\n${journal}`);
  if (r.status !== 0) throw new ErreurRendu(`moteur en échec :\n${sortie.slice(-2000)}\n${journal}`);
  if (!chrome.version.includes(chromeCapture)) throw new ErreurRendu(`le lint a mesuré dans « ${chrome.version} », la capture a tourné dans ${chromeCapture}\n${journal}`);

  const { frames, hash_frames } = hashFrames(dossierPng, donnees.fps);
  if (frames !== donnees.frames) throw new ErreurRendu(`${frames} frames capturées, ${donnees.frames} attendues\n${journal}`);
  return { duree_ms: Math.round((frames * 1000) / donnees.fps), frames, hash_frames, polices_ok, journal };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dossier, dossierPng] = process.argv.slice(2);
  if (!dossier || !dossierPng) {
    console.error("usage : node outils/rendre.mjs <dossier_rendu> <dossier_png>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await rendre(dossier, dossierPng), null, 2));
  } catch (e) {
    if (!(e instanceof ErreurRendu)) throw e;
    console.error(`ÉCHEC rendu : ${e.message}`);
    process.exit(1);
  }
}
