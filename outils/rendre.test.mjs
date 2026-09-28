// Tests d'intégration de rendre() : rendus complets (~1 min 30).
// Un journal propre sous unshare -rn ne prouve rien sur la capacité du
// détecteur à voir une sortie : on rend donc aussi une page qui émet une
// requête sortante délibérée, avec réseau puis sous isolation, et on exige
// l'échec. Le lint est sauté (verifier: false), sinon il intercepterait la
// requête avant le moteur.
// node --test outils/*.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injecter } from "./inject.mjs";
import { rendre, ErreurRendu } from "./rendre.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-rendre-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function page({ requeteSortante }) {
  const dir = path.join(TMP, `r${n++}`);
  injecter(path.join(RACINE, "fixtures/t0/fixture-A.json"), dir);
  if (requeteSortante) {
    const p = path.join(dir, "index.html");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("</body>", '<img src="http://example.com/hm-sonde.png" alt=""></body>'));
  }
  return dir;
}

test("rendu propre, isolé : passe, sonde IPv6 tolérée et journalisée", async () => {
  const r = await rendre(page({ requeteSortante: false }), path.join(TMP, "png-propre"));
  assert.equal(r.frames, 450);
  assert.equal(r.duree_ms, 15000);
  assert.equal(r.polices_ok, true);
  assert.match(r.hash_frames, /^[0-9a-f]{64}$/);
  assert.match(r.journal, /exception documentée : [1-9]\d* sonde/);
});

test("détecteur : requête sortante, AVEC réseau → échec R11", async () => {
  await assert.rejects(
    rendre(page({ requeteSortante: true }), path.join(TMP, "png-reseau"), { verifier: false, isoler: false }),
    (e) => e instanceof ErreurRendu && /R11 : une donnée a tenté de franchir la frontière/.test(e.message) && /TCP vers/.test(e.message),
  );
});

test("détecteur : requête sortante, SOUS unshare -rn → la tentative est vue, échec R11", async () => {
  await assert.rejects(
    rendre(page({ requeteSortante: true }), path.join(TMP, "png-isole"), { verifier: false, isoler: true }),
    (e) => e instanceof ErreurRendu && /R11 : une donnée a tenté de franchir la frontière/.test(e.message),
  );
});
