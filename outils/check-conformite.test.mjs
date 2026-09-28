// Tests du vérificateur de conformité : il doit REFUSER. Chaque fichier
// d'une seconde porte UN défaut ; le contrôle visé doit échouer, et lui seul
// si possible. Le fichier de référence passe.
// node --test outils/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifier } from "./check-conformite.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-conf-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Composition d'une seconde, mêmes profils que les fixtures.
const C = JSON.parse(fs.readFileSync(path.join(RACINE, "fixtures/t0/fixture-A.json"), "utf8"));
C.canvas.duration_ms = 1000;

const VIDEO = (o = {}) => [
  "-f", "lavfi", "-i", `testsrc2=s=${o.taille ?? "1080x1920"}:r=${o.fps ?? 30}`,
  ...(o.audio === false ? [] : ["-f", "lavfi", "-i", o.son ?? "anullsrc=r=48000:cl=stereo"]),
  "-t", String(o.duree ?? 1),
  "-c:v", o.codec ?? "libx264", ...(o.codec ? [] : ["-profile:v", o.profil ?? "main", "-level:v", o.level ?? "4.0", "-bf", String(o.bf ?? 0)]),
  "-pix_fmt", o.pix ?? "yuv420p", ...(o.vf ? ["-vf", o.vf] : []), ...(o.vfr ? ["-vsync", "passthrough"] : []), // ffmpeg 4.4 : -vsync (pas -fps_mode)
  ...(o.audio === false ? [] : ["-c:a", "aac", "-b:a", "128k", "-ar", String(o.ar ?? 48000), "-ac", String(o.ac ?? 2)]),
  ...(o.faststart === false ? [] : ["-movflags", "+faststart"]),
];
function fichier(nom, o) {
  const f = path.join(TMP, `${nom}.mp4`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...VIDEO(o), f]);
  if (r.status !== 0) throw new Error(`${nom} : ${r.stderr}`);
  return f;
}
const echecs = (r) => r.controles.filter((x) => x.ok === false).map((x) => x.controle);

let F;
before(() => {
  F = {
    reference: fichier("reference", {}),
    bframes: fichier("bframes", { bf: 2 }),
    high: fichier("high", { profil: "high", level: "4.0" }),
    yuv444: fichier("yuv444", { profil: "high444", pix: "yuv444p" }),
    sansAudio: fichier("sans-audio", { audio: false }),
    mono: fichier("mono", { ac: 1, son: "anullsrc=r=48000:cl=mono" }),
    k441: fichier("44k1", { ar: 44100, son: "anullsrc=r=44100:cl=stereo" }),
    sansFaststart: fichier("sans-faststart", { faststart: false }),
    tropLong: fichier("trop-long", { duree: 1.5 }),
    fps25: fichier("fps25", { fps: 25 }),
    // Une frame retirée, horodatages conservés : un paquet dure deux frames.
    // (Un simple décalage < 1 frame est réaligné par le muxer : pas VFR.)
    vfr: fichier("vfr", { vf: "select='not(eq(n\\,10))'", vfr: true }),
    petit: fichier("720", { taille: "720x1280", level: "3.1" }),
    mpeg4: fichier("mpeg4", { codec: "mpeg4" }),
    // sine sort à -18 dBFS. Mesuré après AAC : +18 dB → crête -3,0 dBTP ;
    // +20 dB → -1,0 (passe, la règle est ≤ -1) ; +21 dB → -0,1 dBTP, -3,0 LUFS.
    sonFort: fichier("son-fort", { son: "sine=f=1000:r=48000,volume=21dB,aformat=channel_layouts=stereo" }),
  };
});

test("référence : l'aperçu conforme passe", () => {
  const r = verifier(C, F.reference, "preview");
  assert.deepEqual(echecs(r), []);
  assert.equal(r.ok, true);
});

const cas = [
  ["bframes", "preview", /has_b_frames/],
  ["high", "preview", /^profile$/],
  ["yuv444", "preview", /pix_fmt/],
  ["sansAudio", "preview", /piste audio présente/],
  ["mono", "preview", /canaux/],
  ["k441", "preview", /fréquence d'échantillonnage/],
  ["sansFaststart", "preview", /moov en tête/],
  ["tropLong", "preview", /durée = canvas/],
  ["fps25", "preview", /fréquence d'images/],
  ["vfr", "preview", /durées de paquets toutes égales/],
  ["petit", "preview", /résolution/],
  ["mpeg4", "preview", /codec_name/],
];
for (const [nom, sortie, attendu] of cas) {
  test(`refuse : ${nom}`, () => {
    const r = verifier(C, F[nom], sortie);
    assert.equal(r.ok, false);
    assert.ok(echecs(r).some((x) => attendu.test(x)), `échecs : ${echecs(r).join(" | ")}`);
  });
}

test("refuse : taille au-dessus de encode.max_bytes", () => {
  const c = structuredClone(C);
  c.encode.preview.max_bytes = 1000;
  assert.ok(echecs(verifier(c, F.reference, "preview")).includes("taille ≤ encode.max_bytes"));
});

test("master : une piste silencieuse mesure ~2 kbps et échoue le seuil de 128 kbps (R9)", () => {
  const c = structuredClone(C);
  c.encode.master = structuredClone(c.encode.preview); // mêmes réglages vidéo que la référence
  const r = verifier(c, F.reference, "master");
  const debit = r.controles.find((x) => x.controle.startsWith("débit audio"));
  assert.equal(debit.ok, false);
  assert.ok(debit.mesure < 10, `mesuré ${debit.mesure} kbps`);
});

test("R10 non applicable en silent_fallback : consigné, jamais compté comme succès ni rejet", () => {
  const r = verifier(C, F.reference, "preview");
  const l = r.controles.filter((x) => x.regle === "R10" && /volume|crête/.test(x.controle));
  assert.equal(l.length, 2);
  for (const x of l) {
    assert.equal(x.ok, null);
    assert.match(x.attendu, /non applicable : silent_fallback/);
  }
});

test("R10 appliqué hors silent_fallback : un son à -0,1 dBTP et -3 LUFS est rejeté (volume et crête)", () => {
  const c = structuredClone(C);
  c.audio.silent_fallback = false;
  const e = echecs(verifier(c, F.sonFort, "preview"));
  assert.ok(e.some((x) => /volume intégré/.test(x)), e.join(" | "));
  assert.ok(e.some((x) => /crête vraie/.test(x)), e.join(" | "));
});
