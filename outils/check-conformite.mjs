// Conformité des fichiers produits : R9 (ffprobe) et R10 (ebur128), sur
// l'aperçu ET le master, avant tout envoi.
//
// Chaque contrôle est consigné avec l'attendu et la mesure. Les attendus
// viennent de la composition (encode, canvas, audio) et des règles R9/R10,
// jamais d'une valeur choisie ici.
//
// R10 se lit comme deux contrôles indépendants (É-13) : présence, codec,
// canaux et fréquence s'appliquent toujours ; volume intégré et crête vraie
// seulement si audio.silent_fallback est faux. Sinon : « non applicable :
// silent_fallback », ni succès ni rejet — la mesure est quand même relevée.
//
// Usage : node outils/check-conformite.mjs <fixture.json> <preview.mp4> <master.mp4>
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function ffprobe(fichier) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", fichier]);
  if (r.status !== 0) throw new Error(`ffprobe ${fichier} : ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Durées de tous les paquets vidéo : une fréquence fixe les veut toutes égales.
function dureesPaquetsVideo(fichier) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=duration", "-of", "csv=p=0", fichier], { maxBuffer: 1 << 26 });
  return r.stdout.toString().trim().split("\n").filter(Boolean).map(Number);
}

// Ordre des boîtes de premier niveau du MP4 : moov avant mdat = faststart.
function boitesMp4(fichier) {
  const buf = fs.readFileSync(fichier);
  const boites = [];
  for (let i = 0; i + 8 <= buf.length; ) {
    let taille = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    if (taille === 1) taille = Number(buf.readBigUInt64BE(i + 8));
    else if (taille === 0) taille = buf.length - i;
    if (taille < 8) break;
    boites.push(type);
    i += taille;
  }
  return boites;
}

function ebur128(fichier) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", fichier, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const s = r.stderr.toString();
  const resume = s.slice(s.lastIndexOf("Summary:"));
  const lire = (re) => {
    const m = resume.match(re);
    return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null;
  };
  return { integre_lufs: lire(/I:\s+(-?[\d.]+|-inf) LUFS/), crete_vraie_dbtp: lire(/Peak:\s+(-?[\d.]+|-inf) dBFS/) };
}

const NIVEAUX = { 30: "3.0", 31: "3.1", 40: "4.0", 41: "4.1", 42: "4.2" };

export function verifier(composition, fichier, sortie) {
  const e = composition.encode[sortie];
  const canvas = composition.canvas;
  const controles = [];
  const c = (regle, controle, attendu, mesure, ok) => controles.push({ regle, controle, attendu, mesure, ok: ok === null ? null : Boolean(ok) });

  const p = ffprobe(fichier);
  const v = p.streams.filter((s) => s.codec_type === "video");
  const a = p.streams.filter((s) => s.codec_type === "audio");
  const taille = Number(p.format.size);
  const duree = Number(p.format.duration);

  c("R9", "une seule piste vidéo", 1, v.length, v.length === 1);
  const vv = v[0] ?? {};
  c("R9", "codec_name", "h264", vv.codec_name, vv.codec_name === "h264");
  const profilsAdmis = sortie === "preview" ? ["Main"] : ["Main", "High"];
  c("R9", "profile", profilsAdmis.join(" ou "), vv.profile, profilsAdmis.includes(vv.profile));
  c("R2", "profile conforme à encode", e.video.profile, vv.profile, (vv.profile ?? "").toLowerCase() === e.video.profile);
  c("R2", "level conforme à encode", e.video.level, NIVEAUX[vv.level] ?? vv.level, NIVEAUX[vv.level] === e.video.level);
  if (sortie === "preview") c("R9", "has_b_frames", 0, vv.has_b_frames, vv.has_b_frames === 0);
  else c("R9", "has_b_frames ≤ encode.master.video.b_frames", `≤ ${e.video.b_frames}`, vv.has_b_frames, vv.has_b_frames <= e.video.b_frames);
  c("R9", "pix_fmt", "yuv420p", vv.pix_fmt, vv.pix_fmt === "yuv420p");
  const col = e.video.color;
  c("R9", "color_space (matrice)", col.matrix, vv.color_space, vv.color_space === col.matrix);
  c("R9", "color_primaries", col.primaries, vv.color_primaries, vv.color_primaries === col.primaries);
  c("R9", "color_transfer", col.transfer, vv.color_transfer, vv.color_transfer === col.transfer);
  c("R9", "color_range", col.range, vv.color_range, vv.color_range === col.range);
  c("D12", "résolution", e.resolution, `${vv.width}x${vv.height}`, `${vv.width}x${vv.height}` === e.resolution);
  const fps = `${canvas.fps}/1`;
  c("R9", "fréquence d'images (r_frame_rate)", fps, vv.r_frame_rate, vv.r_frame_rate === fps);
  c("R9", "fréquence d'images (avg_frame_rate)", fps, vv.avg_frame_rate, vv.avg_frame_rate === fps);
  const durees = dureesPaquetsVideo(fichier);
  const distinctes = [...new Set(durees)];
  c("R9", "fréquence fixe : durées de paquets toutes égales", "1 valeur", `${distinctes.length} valeur(s) : ${distinctes.slice(0, 5).join(", ")}`, distinctes.length === 1);
  const framesAttendues = (canvas.duration_ms * canvas.fps) / 1000;
  c("R9", "nombre de frames", framesAttendues, durees.length, durees.length === framesAttendues);

  c("R9/R10", "piste audio présente (une seule)", 1, a.length, a.length === 1);
  const aa = a[0] ?? {};
  c("R9", "codec audio", "aac", aa.codec_name, aa.codec_name === "aac");
  c("R9/R10", "canaux", 2, aa.channels, aa.channels === 2);
  c("R10", "fréquence d'échantillonnage", 48000, Number(aa.sample_rate), Number(aa.sample_rate) === 48000);
  // R9 : ≥ 128 kbps porte sur le débit déclaré, toujours ; sur le débit
  // mesuré seulement hors silent_fallback (une piste silencieuse à 128 kbps
  // mesure ~2 kbps, et c'est le bon débit pour du silence).
  const kbps = Math.round(Number(aa.bit_rate) / 100) / 10;
  if (sortie === "master") {
    c("R9", "débit audio déclaré ≥ 128 kbps", "≥ 128", e.audio.bitrate_kbps, e.audio.bitrate_kbps >= 128);
    if (composition.audio.silent_fallback) c("R9", "débit audio mesuré ≥ 128 kbps", "non applicable : silent_fallback", kbps, null);
    else c("R9", "débit audio mesuré ≥ 128 kbps", "≥ 128", kbps, kbps >= 128);
  } else c("R9", "débit audio mesuré (informatif pour l'aperçu)", "—", kbps, null);

  c("R9", "taille ≤ encode.max_bytes", `≤ ${e.max_bytes}`, taille, taille <= e.max_bytes);
  c("R9", "durée = canvas.duration_ms ± 100 ms", canvas.duration_ms, Math.round(duree * 1000), Math.abs(duree * 1000 - canvas.duration_ms) <= 100);
  c("R1", "durée ≤ 30 s", "≤ 30000", Math.round(duree * 1000), duree * 1000 <= 30000);
  const boites = boitesMp4(fichier);
  const iMoov = boites.indexOf("moov");
  const iMdat = boites.indexOf("mdat");
  c("R9", "moov en tête (avant mdat)", "moov < mdat", boites.join(" "), iMoov >= 0 && iMdat >= 0 && iMoov < iMdat);

  const l = ebur128(fichier);
  if (composition.audio.silent_fallback) {
    c("R10", "volume intégré -14 LUFS ± 1", "non applicable : silent_fallback", l.integre_lufs, null);
    c("R10", "crête vraie ≤ -1 dBTP", "non applicable : silent_fallback", l.crete_vraie_dbtp, null);
  } else {
    const { target_lufs: cible, tolerance_lu: tol, true_peak_dbtp: crete } = composition.audio.loudness;
    c("R10", `volume intégré ${cible} LUFS ± ${tol}`, cible, l.integre_lufs, Math.abs(l.integre_lufs - cible) <= tol);
    c("R10", `crête vraie ≤ ${crete} dBTP`, `≤ ${crete}`, l.crete_vraie_dbtp, l.crete_vraie_dbtp <= crete);
  }
  return { fichier, sortie, ok: controles.every((x) => x.ok !== false), controles };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixture, preview, master] = process.argv.slice(2);
  if (!fixture || !preview || !master) {
    console.error("usage : node outils/check-conformite.mjs <fixture.json> <preview.mp4> <master.mp4>");
    process.exit(2);
  }
  const c = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const resultats = [verifier(c, preview, "preview"), verifier(c, master, "master")];
  for (const r of resultats) {
    console.log(`${r.ok ? "ok   " : "ÉCHEC"} ${r.sortie} ${r.fichier}`);
    for (const x of r.controles) {
      const etat = x.ok === null ? "n/a " : x.ok ? "ok  " : "NON ";
      console.log(`  ${etat} ${x.regle.padEnd(6)} ${x.controle} — attendu ${x.attendu}, mesuré ${x.mesure}`);
    }
  }
  process.exit(resultats.every((r) => r.ok) ? 0 : 1);
}
