// Tests de l'encodeur : la couleur doit survivre à la conversion RGB → YUV.
// Les étiquettes BT.709 ne prouvent rien seules : on encode un aplat de
// couleur de marque, on le décode en BT.709, et on compare. Témoin : la même
// couleur convertie en BT.601 mais étiquetée BT.709 doit, elle, dériver.
// node --test outils/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commandeEncodage } from "./encoder.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-enc-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ACCENT = [0xff, 0x5a, 0x1f]; // --brand-accent de démo, #FF5A1F
// Plancher MESURÉ, pas choisi : même sans perte (-crf 0), avec la bonne
// matrice, l'aller-retour RGB → YUV 8 bits plage tv rend #FF5A1F en
// 253,88,30, soit 2 niveaux ; accurate_rnd côté encodeur n'y change rien. La
// mauvaise matrice donne 99 au lieu de 90 sur le vert : 9 niveaux.
const TOLERANCE = 2;

const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
};
// Pixel central décodé en RGB, en interprétant le flux en BT.709 plage tv.
const pixelCentral = (f) =>
  [...ff(["-i", f, "-frames:v", "1", "-vf", "crop=2:2:539:959,scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "-"]).subarray(0, 3)];
const ecart = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

const C = JSON.parse(fs.readFileSync(path.join(RACINE, "fixtures/t0/fixture-A.json"), "utf8"));
C.canvas.duration_ms = 1000;
let png;
before(() => {
  png = path.join(TMP, "png");
  fs.mkdirSync(png);
  ff(["-f", "lavfi", "-i", "color=c=0xFF5A1F:s=1080x1920:r=30", "-frames:v", "30", path.join(png, "frame_%06d.png")]);
});

test("l'accent de marque survit à l'encodage, aperçu et master (≤ 2 niveaux, le plancher 8 bits)", () => {
  const sortie = path.join(TMP, "enc");
  fs.mkdirSync(sortie);
  ff(commandeEncodage(C, png, sortie).slice(3));
  for (const f of ["preview", "master"]) {
    const p = pixelCentral(path.join(sortie, `${f}.mp4`));
    assert.ok(ecart(p, ACCENT) <= TOLERANCE, `${f} : décodé ${p}, attendu ${ACCENT}`);
  }
});

test("témoin : conversion BT.601 étiquetée BT.709 → la couleur dérive au-delà de la tolérance", () => {
  const f = path.join(TMP, "temoin.mp4");
  ff(["-framerate", "30", "-i", path.join(png, "frame_%06d.png"), "-vf", "format=yuv420p", "-c:v", "libx264",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", f]);
  const p = pixelCentral(f);
  assert.ok(ecart(p, ACCENT) > TOLERANCE, `témoin : décodé ${p}, écart ${ecart(p, ACCENT)} — le test ne distinguerait pas les matrices`);
});
