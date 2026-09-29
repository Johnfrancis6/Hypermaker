// Injection : composition (fixture) + template → dossier de rendu autonome.
//
// Tout ce qui peut être résolu l'est ici, côté Node, avant que la page
// n'existe : contrôle statique T11 du template, liaison couche → slot par
// slot_id (R3),
// cohérence des boîtes et des z_index avec le manifeste, conversion des
// temps par le numéro de frame, @font-face sous le nom privé, copie et
// vérification (octets, sha256) des assets et des polices.
//
// La page reçoit un HTML complet : le template, un bloc JSON de valeurs
// résolues, GSAP et le runtime, tous servis depuis le dossier. Aucune URL
// distante. On n'utilise PAS --variables du moteur (brief §8).
//
// Usage : node outils/inject.mjs <fixture.json> <dossier_sortie>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RACINE = path.resolve(import.meta.dirname, "..");
const lire = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export class ErreurInjection extends Error {}
function exiger(condition, message) {
  if (!condition) throw new ErreurInjection(message);
}

// Contrat de temps (brief §5) : jamais ms / 1000. Le ms doit tomber sur la
// grille de frames, on émet frame / fps, et on vérifie le retour.
export function versSecondes(ms, fps, quoi) {
  const frame = (ms * fps) / 1000;
  exiger(Number.isInteger(frame), `${quoi} : ${ms} ms ne tombe pas sur la grille de ${fps} fps (${frame} frames)`);
  const secondes = frame / fps;
  exiger(Math.round(secondes * fps) === frame, `${quoi} : aller-retour frame → secondes → frame faux (${frame} → ${secondes})`);
  return { frame, secondes };
}

// T11, par analyse statique du HTML et du CSS du template.
export function verifierT11(html, manifeste) {
  const erreurs = [];
  const sansCommentaires = html.replace(/<!--[\s\S]*?-->/g, "");
  const styles = [...sansCommentaires.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const scripts = [...sansCommentaires.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const attributsStyle = [...sansCommentaires.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]).join(";");
  const css = styles + ";" + attributsStyle;

  // Correspondance manifeste ↔ HTML, dans les deux sens, exactement une fois.
  const dansHtml = [...sansCommentaires.matchAll(/data-slot="([^"]+)"/g)].map((m) => m[1]);
  for (const s of manifeste.slots) {
    const n = dansHtml.filter((x) => x === s.slot_id).length;
    if (n !== 1) erreurs.push(`slot ${s.slot_id} : ${n} élément(s) data-slot dans le HTML, 1 attendu`);
  }
  for (const x of new Set(dansHtml)) {
    if (!manifeste.slots.some((s) => s.slot_id === x)) erreurs.push(`data-slot="${x}" absent du manifeste`);
  }
  for (const b of manifeste.choreography.beats) {
    if (!dansHtml.includes(b.slot_id)) erreurs.push(`beat ${b.beat_id} : cible ${b.slot_id} inexistante dans le HTML`);
  }

  // Aucune valeur de marque en dur : toute propriété de couleur passe par var().
  for (const m of css.matchAll(/(^|[;{\s])([a-z-]*(?:color|background)[a-z-]*)\s*:\s*([^;}]+)/g)) {
    const valeur = m[3].trim();
    if (!/^var\(--brand-[a-z-]+\)$/.test(valeur) && !/^(transparent|inherit|none)$/.test(valeur)) {
      erreurs.push(`couleur en dur : ${m[2]}: ${valeur}`);
    }
  }
  if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(css)) erreurs.push("valeur de couleur littérale (hex, rgb, hsl) dans le CSS");
  if (/\bfont(-family)?\s*:/.test(css)) erreurs.push("font-family littéral : la police vient de composition.fonts[]");
  if (/\b(transition|animation)[a-z-]*\s*:/.test(css)) erreurs.push("durée CSS en dur (transition / animation)");
  if (/https?:\/\/|(src|href)\s*=\s*["']\/\//i.test(sansCommentaires)) erreurs.push("ressource distante dans le template");
  if (/Math\.random|Date\.now|new Date|performance\.now|requestAnimationFrame/.test(scripts)) erreurs.push("source de non-déterminisme dans un script");

  // Aucun texte visible en dur.
  const texte = sansCommentaires
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  if (texte) erreurs.push(`texte visible en dur : « ${texte.slice(0, 60)} »`);
  return erreurs;
}

// Liaison couche / texte → slot : NOMMÉE par slot_id dans la composition
// (É-17), jamais déduite du rôle. R3 : le slot existe dans le manifeste, sa
// nature convient, et il accepte le rôle de l'élément.
function lierSlot(manifeste, el, compatible, quoi) {
  const slot = manifeste.slots.find((s) => s.slot_id === el.slot_id);
  exiger(slot, `${quoi} : slot_id ${el.slot_id} absent du manifeste ${manifeste.template_id} ${manifeste.version} (R3)`);
  exiger(compatible(slot), `${quoi} : le slot ${slot.slot_id} (${slot.kind}${slot.accepts_roles ? `, accepte ${slot.accepts_roles.join("/")}` : `, text_role ${slot.text_role}`}) n'accepte pas le rôle ${el.role} (R3)`);
  return slot;
}

function boiteManifeste(slot, canvas) {
  return {
    x: Math.round(slot.box.x * canvas.width),
    y: Math.round(slot.box.y * canvas.height),
    width: Math.round(slot.box.width * canvas.width),
    height: Math.round(slot.box.height * canvas.height),
  };
}

function verifierBoite(slot, box, canvas, quoi) {
  const attendu = boiteManifeste(slot, canvas);
  for (const k of ["x", "y", "width", "height"]) {
    exiger(Math.abs(attendu[k] - box[k]) <= 1, `${quoi} : box.${k} = ${box[k]}, le manifeste donne ${attendu[k]} (±1 px)`);
  }
}

export function injecter(fichierFixture, sortie) {
  const c = lire(fichierFixture);
  const fps = c.canvas.fps;

  // Un seul template par composition en T0.
  const refs = new Set(c.scenes.map((s) => `${s.template_id}/${s.template_version}`));
  exiger(refs.size === 1, `T0 ne gère qu'un template par composition, trouvé : ${[...refs].join(", ")}`);
  const dossierTemplate = path.join(RACINE, "templates", [...refs][0]);
  const html = fs.readFileSync(path.join(dossierTemplate, "index.html"), "utf8");
  const manifeste = lire(path.join(dossierTemplate, "manifest.json"));

  const t11 = verifierT11(html, manifeste);
  exiger(t11.length === 0, `T11 :\n  ${t11.join("\n  ")}`);

  const zParSlot = Object.fromEntries(manifeste.layer_stack.map((l) => [l.slot_id, l.z_index]));
  const duree = versSecondes(c.canvas.duration_ms, fps, "canvas.duration_ms");

  // Copie vérifiée d'un fichier : octets et sha256 doivent correspondre.
  fs.rmSync(sortie, { recursive: true, force: true });
  fs.mkdirSync(path.join(sortie, "assets"), { recursive: true });
  fs.mkdirSync(path.join(sortie, "polices"), { recursive: true });
  function copier(uri, dossier, attendu) {
    const source = path.join(RACINE, uri);
    exiger(fs.existsSync(source), `fichier absent : ${uri}`);
    const buf = fs.readFileSync(source);
    exiger(buf.length > 0, `fichier vide : ${uri}`);
    if (attendu) {
      exiger(buf.length === attendu.bytes, `${uri} : ${buf.length} octets, la composition en déclare ${attendu.bytes}`);
      exiger(sha256(buf) === attendu.checksum, `${uri} : sha256 différent de la composition`);
    }
    const cible = `${dossier}/${path.basename(uri)}`;
    fs.writeFileSync(path.join(sortie, cible), buf);
    return { cible, sha256: sha256(buf) };
  }

  const srcAsset = {};
  for (const [ref, a] of Object.entries(c.assets)) srcAsset[ref] = copier(a.uri, "assets", a).cible;

  const fontParRef = Object.fromEntries(c.fonts.map((f) => [f.font_ref, f]));
  const faces = c.fonts.map((f) => {
    const { cible, sha256: h } = copier(f.uri, "polices");
    return `/* ${f.font_ref} : ${f.family} ${f.weight} ${f.style ?? "normal"} ← ${f.uri} (sha256 ${h}) */
@font-face { font-family: "${f.family}"; src: url("${cible}") format("${f.format}"); font-weight: ${f.weight}; font-style: ${f.style ?? "normal"}; font-display: block; }`;
  });

  // Fenêtres de visibilité : une transition chevauche la fin de la scène
  // sortante et le début de la suivante sans créer de durée (R1).
  const scenes = c.scenes.map((sc) => {
    const q = (ms, quoi) => versSecondes(ms, fps, `${sc.scene_id} ${quoi}`).secondes;
    const entrante = c.transitions.find((t) => t.to_scene === sc.scene_id);
    const sortante = c.transitions.find((t) => t.from_scene === sc.scene_id);
    const fin = sc.start_ms + sc.duration_ms;
    const donnees = {
      scene_id: sc.scene_id,
      visible_debut_s: q(entrante && entrante.type !== "cut" ? entrante.start_ms : sc.start_ms, "début visible"),
      visible_fin_s: q(sortante && sortante.type !== "cut" ? sortante.start_ms + sortante.duration_ms : fin, "fin visible"),
      fondu_entree: null,
      slots: [],
    };
    if (entrante && entrante.type !== "cut") {
      exiger(entrante.type === "fade", `${entrante.transition_id} : transition ${entrante.type} non gérée en T0`);
      donnees.fondu_entree = {
        debut_s: q(entrante.start_ms, "début transition"),
        duree_s: q(entrante.duration_ms, "durée transition"),
        easing: entrante.easing,
      };
    }

    const remplis = new Set();
    for (const ly of sc.layers) {
      const quoi = `${sc.scene_id}/${ly.layer_id} (role ${ly.role})`;
      const slot = lierSlot(manifeste, ly, (s) => s.kind !== "text" && s.accepts_roles.includes(ly.role), quoi);
      exiger(!remplis.has(slot.slot_id), `${quoi} : ${slot.slot_id} déjà rempli dans la scène (R3)`);
      remplis.add(slot.slot_id);
      verifierBoite(slot, ly.box, c.canvas, quoi);
      exiger(ly.z_index === zParSlot[slot.slot_id], `${quoi} : z_index ${ly.z_index}, le manifeste donne ${zParSlot[slot.slot_id]}`);
      exiger(ly.media_start_ms === undefined || c.assets[ly.asset_ref].kind === "still", `${quoi} : couche vidéo non gérée en T0`);
      exiger(c.assets[ly.asset_ref]?.kind === "still", `${quoi} : seules les images fixes sont gérées en T0`);
      donnees.slots.push({
        slot: slot.slot_id, nature: "image", role: ly.role, src: srcAsset[ly.asset_ref], box: ly.box,
        z_index: ly.z_index, fit: ly.fit, opacity: ly.opacity ?? 1,
      });
    }
    for (const t of sc.text_elements ?? []) {
      const quoi = `${sc.scene_id}/${t.text_id} (role ${t.role})`;
      const slot = lierSlot(manifeste, t, (s) => s.kind === "text" && s.text_role === t.role, quoi);
      exiger(!remplis.has(slot.slot_id), `${quoi} : ${slot.slot_id} déjà rempli dans la scène (R3)`);
      remplis.add(slot.slot_id);
      verifierBoite(slot, t.box, c.canvas, quoi);
      const f = fontParRef[t.font_ref];
      exiger(f, `${quoi} : font_ref ${t.font_ref} absent de fonts (R4)`);
      exiger(!t.background, `${quoi} : background de texte non géré en T0`);
      exiger(
        sc.start_ms <= t.animation.start_ms && t.animation.start_ms <= sc.start_ms + sc.duration_ms,
        `${quoi} : animation.start_ms ${t.animation.start_ms} hors de la scène [${sc.start_ms}, ${sc.start_ms + sc.duration_ms}] — start_ms est global (É-19)`,
      );
      donnees.slots.push({
        slot: slot.slot_id, nature: "texte", text_id: t.text_id, box: t.box, z_index: zParSlot[slot.slot_id],
        contenu: t.content, famille: f.family, poids: f.weight, style: f.style ?? "normal",
        taille_px: t.font_size_px, taille_min_px: t.min_font_size_px, interligne: t.line_height,
        max_lignes: t.max_lines, overflow: t.overflow, couleur: t.color, align: t.align,
        // animation.start_ms est un temps GLOBAL (confirmé le 28/09) : sync
        // l'égale au start_ms d'un mot, et l'alignement est sur la timeline
        // globale (R13). Asymétrie avec camera.keyframes[].t_ms, relatif à la
        // scène : É-19. Confinement vérifié juste au-dessus.
        animation: {
          type: t.animation.type,
          debut_s: q(t.animation.start_ms, `${t.text_id} animation.start_ms`),
          duree_s: q(t.animation.duration_ms, `${t.text_id} animation.duration_ms`),
          easing: t.animation.easing,
        },
      });
    }
    for (const s of manifeste.slots) {
      exiger(!s.required || remplis.has(s.slot_id), `${sc.scene_id} : slot requis ${s.slot_id} vide (T9 hors périmètre T0)`);
    }
    return donnees;
  });

  const donnees = {
    fps,
    safe_area: c.safe_area,
    duree_s: duree.secondes,
    frames: duree.frame,
    polices: c.fonts.map((f) => ({ famille: f.family, poids: f.weight, style: f.style ?? "normal" })),
    scenes,
  };

  for (const f of ["gsap.min.js", "CustomEase.min.js"]) {
    fs.copyFileSync(path.join(RACINE, "node_modules/gsap/dist", f), path.join(sortie, f));
  }
  for (const f of ["hm-mesure.js", "hm-runtime.js"]) {
    fs.copyFileSync(path.join(RACINE, "runtime", f), path.join(sortie, f));
  }

  const tete = `<style>
${faces.join("\n")}
:root { --brand-fond: ${c.canvas.background_color}; }
</style>`;
  const fin = `<script type="application/json" id="hm-donnees">${JSON.stringify(donnees).replace(/</g, "\\u003c")}</script>
<script src="gsap.min.js"></script>
<script src="CustomEase.min.js"></script>
<script src="hm-mesure.js"></script>
<script src="hm-runtime.js"></script>`;
  const sortieHtml = html
    .replace("</head>", `${tete}\n</head>`)
    .replace(
      /<div id="root" data-composition-id="root">/,
      `<div id="root" data-composition-id="root" data-width="${c.canvas.width}" data-height="${c.canvas.height}" data-start="0" data-duration="${duree.secondes}">`,
    )
    .replace("</body>", `${fin}\n</body>`);
  exiger(sortieHtml.includes(`data-duration="${duree.secondes}"`), "racine du template introuvable : <div id=\"root\" data-composition-id=\"root\">");
  fs.writeFileSync(path.join(sortie, "index.html"), sortieHtml);
  return donnees;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixture, sortie] = process.argv.slice(2);
  if (!fixture || !sortie) {
    console.error("usage : node outils/inject.mjs <fixture.json> <dossier_sortie>");
    process.exit(2);
  }
  try {
    const d = injecter(fixture, sortie);
    console.log(`ok ${sortie} : ${d.scenes.length} scènes, ${d.frames} frames, ${d.duree_s} s`);
  } catch (e) {
    if (!(e instanceof ErreurInjection)) throw e;
    console.error(`ÉCHEC injection : ${e.message}`);
    process.exit(1);
  }
}
