// Encodage : UNE commande FFmpeg de notre code produit l'aperçu et le master
// depuis les PNG du moteur, avec la piste audio (brief §2).
//
// Tous les paramètres viennent de composition.encode (R2, R9) : l'encodeur
// ne décide rien. Les profils sont appliqués dans cette commande même,
// jamais par un remux ultérieur, qui pourrait réintroduire des B-frames.
//
// Audio en T0 : silent_fallback, piste AAC silencieuse (anullsrc), jamais
// absente (R10). Le mixage réel est T0b.
//
// Usage : node outils/encoder.mjs <fixture.json> <dossier_png> <dossier_sortie>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { versSecondes } from "./inject.mjs";

export class ErreurEncodage extends Error {}

function profilVideo(e, entree) {
  const v = e.video;
  const [l, h] = e.resolution.split("x").map(Number);
  return {
    filtre: `${entree}scale=${l}:${h}:flags=lanczos,format=${v.pix_fmt}`,
    options: [
      // -threads 1 : x264 multi-thread n'est pas reproductible octet pour
      // octet (mesuré : mêmes PNG, deux fichiers différents ; -threads 1,
      // deux fichiers identiques). Épinglé comme le prévoit É-14.
      "-c:v", "libx264", "-threads", "1", "-profile:v", v.profile, "-level:v", v.level, "-pix_fmt", v.pix_fmt,
      "-bf", String(v.b_frames), "-b:v", `${v.bitrate_kbps}k`, "-maxrate", `${v.maxrate_kbps}k`, "-bufsize", `${v.bufsize_kbps}k`,
      "-g", String(v.keyint), "-preset", v.preset,
    ],
  };
}

function profilAudio(a) {
  if (a.codec !== "aac") throw new ErreurEncodage(`codec audio ${a.codec} non géré`);
  return ["-c:a", "aac", "-b:a", `${a.bitrate_kbps}k`, "-ar", String(a.sample_rate), "-ac", String(a.channels)];
}

export function commandeEncodage(c, dossierPng, sortie) {
  if (!c.audio.silent_fallback) throw new ErreurEncodage("audio non silencieux : le mixage est T0b, hors périmètre");
  const duree = versSecondes(c.canvas.duration_ms, c.canvas.fps, "canvas.duration_ms");
  const p = profilVideo(c.encode.preview, "[a]");
  const m = profilVideo(c.encode.master, "[b]");
  const sorties = [];
  for (const [nom, e, profil, etiquette] of [["preview", c.encode.preview, p, "[vp]"], ["master", c.encode.master, m, "[vm]"]]) {
    if (e.container !== "mp4") throw new ErreurEncodage(`${nom} : conteneur ${e.container} non géré`);
    sorties.push(
      "-map", etiquette, "-map", "1:a",
      ...profil.options, ...profilAudio(e.audio),
      "-frames:v", String(duree.frame), "-t", String(duree.secondes),
      ...(e.faststart ? ["-movflags", "+faststart"] : []),
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1",
      path.join(sortie, `${nom}.mp4`),
    );
  }
  return [
    "-v", "error", "-y",
    "-framerate", String(c.canvas.fps), "-i", path.join(dossierPng, "frame_%06d.png"),
    "-f", "lavfi", "-i", `anullsrc=r=${c.encode.master.audio.sample_rate}:cl=stereo`,
    "-filter_complex", `[0:v]split=2[a][b];${p.filtre}[vp];${m.filtre}[vm]`,
    ...sorties,
  ];
}

export function encoder(fixture, dossierPng, sortie) {
  const c = JSON.parse(fs.readFileSync(fixture, "utf8"));
  fs.mkdirSync(sortie, { recursive: true });
  const args = commandeEncodage(c, dossierPng, sortie);
  const debut = Date.now();
  const r = spawnSync("ffmpeg", args, { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new ErreurEncodage(`ffmpeg : ${r.stderr}`);
  return { preview: path.join(sortie, "preview.mp4"), master: path.join(sortie, "master.mp4"), duree_encodage_ms: Date.now() - debut, commande: ["ffmpeg", ...args].join(" ") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixture, dossierPng, sortie] = process.argv.slice(2);
  if (!fixture || !dossierPng || !sortie) {
    console.error("usage : node outils/encoder.mjs <fixture.json> <dossier_png> <dossier_sortie>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(encoder(fixture, dossierPng, sortie), null, 2));
  } catch (e) {
    if (!(e instanceof ErreurEncodage)) throw e;
    console.error(`ÉCHEC encodage : ${e.message}`);
    process.exit(1);
  }
}
