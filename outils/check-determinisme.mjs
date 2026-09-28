// Harnais de déterminisme (Q3, R11) : rendre deux fois la même page,
// comparer hash_frames.
//
// hash_frames (pixels décodés) FAIT FOI : il mesure le moteur. Le hash des
// fichiers encodés est INFORMATIF (É-14) : il mesure x264, qui n'est pas
// garanti reproductible selon le threading sans qu'une image diffère. S'il
// diffère alors que les frames concordent, on épingle le threading de
// l'encodeur ; ce n'est pas un échec de déterminisme.
//
// Chaque relevé porte les versions du moteur et de Chrome : deux rendus sur
// deux Chrome différents peuvent diverger légitimement (brief §9).
//
// Usage : node outils/check-determinisme.mjs <fixture.json>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { injecter } from "./inject.mjs";
import { rendre } from "./rendre.mjs";
import { encoder } from "./encoder.mjs";

const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// Deux rendus + deux encodages d'un dossier déjà injecté.
export async function determinisme(dossier, fixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-det-"));
  try {
    const rendus = [];
    for (const i of [1, 2]) {
      const debut = Date.now();
      const r = await rendre(dossier, path.join(tmp, `png${i}`));
      const e = encoder(fixture, path.join(tmp, `png${i}`), path.join(tmp, `mp4-${i}`));
      rendus.push({ ...r, duree_totale_ms: Date.now() - debut, preview_sha256: sha256(e.preview), master_sha256: sha256(e.master) });
    }
    const [a, b] = rendus;
    return {
      ok: a.hash_frames === b.hash_frames,
      frames_identiques: a.hash_frames === b.hash_frames,
      fichiers_identiques_informatif: a.preview_sha256 === b.preview_sha256 && a.master_sha256 === b.master_sha256,
      rendus: rendus.map((r) => ({
        frames: r.frames, duree_ms: r.duree_ms, hash_frames: r.hash_frames, polices_ok: r.polices_ok,
        preview_sha256: r.preview_sha256, master_sha256: r.master_sha256, duree_totale_ms: r.duree_totale_ms, journal: r.journal,
      })),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = process.argv[2];
  if (!fixture) {
    console.error("usage : node outils/check-determinisme.mjs <fixture.json>");
    process.exit(2);
  }
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "hm-det-page-"));
  try {
    injecter(fixture, dossier);
    const r = await determinisme(dossier, fixture);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}
