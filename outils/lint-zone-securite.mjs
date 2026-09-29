// Lint de zone de sécurité (R5) et de polices (R4), sur le DOM de la page
// chargée, AVANT capture. Coût : aucun rendu.
//
// Mesure TOUTES les frames : la timeline est seekée à frame / fps pour chaque
// frame, et à chaque frame chaque élément soumis à R5 et visible est mesuré.
// Aucun échantillonnage, donc aucune décision arbitraire ; la durée est
// chronométrée et reportée (brief §10).
//
// Éléments soumis à R5 : tout texte, toute couche de rôle logo (un cta est un
// texte). Pour chacun : boîte englobante (transformations comprises) contenue
// dans la zone utile, pas de débordement, lignes ≤ max_lines, taille finale ≥
// min_font_size_px. Débordement et lignes viennent de window.hmMesure, LA
// fonction du runtime : le lint ne réimplémente rien.
//
// Historique de seek (R11) : le moteur répartit les frames entre plusieurs
// workers, chacun sur sa propre page, qui seeke à partir d'où il en est. L'état
// d'une frame ne doit donc dépendre que de son temps. Le lint relève l'état
// (visibilité, opacité, boîte) de chaque scène et de chaque slot à chaque frame
// en passe avant, puis le recompare en passe arrière, et exige que l'état de
// la page fraîche, avant tout seek, soit celui de la frame 0. Mesuré le 28/09 :
// deux set() contradictoires à la position 0 donnaient une frame 0 vide dans
// tous les rendus, et les frames 150 à 224 vides dans un rendu sur six.
//
// Opacité animée (R11) : tout élément dont l'opacité varie au cours de la
// timeline doit porter will-change: opacity. Sans lui, Chrome choisit au
// lancement de composer l'élément sur sa couche ou non, et les deux chemins
// diffèrent de 1 à 2 niveaux (mesuré le 29/09 : deux hash_frames selon le
// lancement).
//
// Réseau : pendant le lint, toute requête autre que file: ou data: fait
// échouer (la page est ouverte depuis le disque, sans serveur).
//
// Usage : node outils/lint-zone-securite.mjs <dossier_rendu>
import path from "node:path";
import puppeteer from "puppeteer-core";
import { chromeDuMoteur } from "./chrome.mjs";

// Zone de sécurité constante du système (R5, T4) : la composition peut
// l'élargir, jamais la réduire.
export const ZONE_MIN = { top: 269, bottom: 672, left: 65, right: 108 };

export async function linter(dossier) {
  const chrome = chromeDuMoteur();
  const navigateur = await puppeteer.launch({ executablePath: chrome.chemin, args: ["--allow-file-access-from-files"] });
  const hotes = [];
  try {
    const page = await navigateur.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const url = r.url();
      if (/^(file|data):/.test(url)) return r.continue();
      hotes.push(url);
      r.abort("blockedbyclient");
    });
    await page.goto("file://" + path.resolve(dossier, "index.html"));
    await page.waitForFunction(() => window.__hm && (window.__hm.pret || window.__hm.erreurs.length > 0), { timeout: 30000 });

    const debut = process.hrtime.bigint();
    const r = await page.evaluate((ZONE_MIN) => {
      const hm = window.__hm;
      const d = JSON.parse(document.getElementById("hm-donnees").textContent);
      const res = { pret: hm.pret, polices_ok: hm.polices_ok, polices: hm.polices, erreurs_runtime: hm.erreurs, violations: [], mesures: 0, frames: d.frames };
      if (!hm.pret) return res;
      if (typeof window.hmMesure !== "object") {
        res.violations.push({ regle: "lint", raison: "window.hmMesure absent : mesure partagée non chargée" });
        return res;
      }
      const sa = d.safe_area;
      for (const k of Object.keys(ZONE_MIN)) {
        if (!(sa[k] >= ZONE_MIN[k])) res.violations.push({ regle: "R5", raison: `safe_area.${k} = ${sa[k]} < ${ZONE_MIN[k]} : la marge ne peut pas être réduite` });
      }
      const zone = { gauche: sa.left, haut: sa.top, droite: 1080 - sa.right, bas: 1920 - sa.bottom };

      // Éléments soumis à R5, avec leur contrat.
      const cibles = [];
      const sections = [...document.querySelectorAll(".hm-scene")];
      d.scenes.forEach((sc, i) => {
        for (const s of sc.slots) {
          if (s.nature === "texte" || s.role === "logo") {
            cibles.push({ el: sections[i].querySelector(`[data-slot="${s.slot}"]`), id: `${sc.scene_id}/${s.slot}`, s });
          }
        }
      });
      // Tailles finales du rétrécissement, contrôlées une fois (statiques).
      const finales = Object.fromEntries(hm.textes.map((t) => [t.text_id, t.taille_finale_px]));
      for (const c of cibles) {
        if (c.s.nature === "texte" && !(finales[c.s.text_id] >= c.s.taille_min_px)) {
          res.violations.push({ regle: "R5", element: c.id, raison: `taille finale ${finales[c.s.text_id]} px < plancher ${c.s.taille_min_px} px` });
        }
      }

      const visible = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
        }
        return true;
      };
      const tl = window.__timelines.root;
      const suivis = [...document.querySelectorAll(".hm-scene, [data-slot]")];
      const signature = () =>
        suivis
          .map((el) => {
            const cs = getComputedStyle(el);
            const b = el.getBoundingClientRect();
            return `${cs.visibility}|${Math.round(parseFloat(cs.opacity) * 1000)}|${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`;
          })
          .join(";");
      const nomDe = (i) => suivis[i].dataset.scene ?? `${suivis[i].closest(".hm-scene").dataset.scene}/${suivis[i].dataset.slot}`;
      const ecart = (a, b) => {
        const x = a.split(";"), y = b.split(";");
        const i = x.findIndex((v, k) => v !== y[k]);
        return `${nomDe(i)} : ${x[i]} contre ${y[i]}`;
      };
      const initiale = signature(); // page fraîche, avant tout seek
      const opacites = suivis.map(() => new Set());
      const signatures = [];
      const vus = new Set();
      const dejaSignale = new Set();
      for (let f = 0; f < d.frames; f++) {
        tl.seek(f / d.fps, false);
        signatures.push(signature());
        suivis.forEach((el, i) => opacites[i].add(getComputedStyle(el).opacity));
        for (const c of cibles) {
          if (!visible(c.el)) continue;
          vus.add(c.id);
          res.mesures++;
          const b = c.el.getBoundingClientRect();
          const raisons = [];
          if (b.left < zone.gauche || b.top < zone.haut || b.right > zone.droite || b.bottom > zone.bas) {
            raisons.push(`boîte [${Math.round(b.left)}, ${Math.round(b.top)}, ${Math.round(b.right)}, ${Math.round(b.bottom)}] hors zone utile [${zone.gauche}, ${zone.haut}, ${zone.droite}, ${zone.bas}]`);
          }
          if (c.s.nature === "texte" && window.hmMesure.deborde(c.el, c.s.max_lignes)) {
            raisons.push(`débordement : ${window.hmMesure.lignes(c.el)} ligne(s) pour ${c.s.max_lignes} max, scroll ${c.el.scrollWidth}×${c.el.scrollHeight} pour ${c.el.clientWidth}×${c.el.clientHeight}`);
          }
          for (const raison of raisons) {
            const cle = c.id + raison;
            if (dejaSignale.has(cle)) continue; // une violation par élément et par cause, avec sa première frame
            dejaSignale.add(cle);
            res.violations.push({ regle: "R5", element: c.id, frame: f, raison });
          }
        }
      }
      for (const c of cibles) {
        if (!vus.has(c.id)) res.violations.push({ regle: "R5", element: c.id, raison: "jamais visible : non mesuré" });
      }
      suivis.forEach((el, i) => {
        if (opacites[i].size > 1 && !/\bopacity\b/.test(getComputedStyle(el).willChange)) {
          res.violations.push({ regle: "R11", element: nomDe(i), raison: `opacité animée (${opacites[i].size} valeurs) sans will-change: opacity : chemin de composition choisi par Chrome au lancement` });
        }
      });
      // Passe arrière : même état à chaque frame, quel que soit le chemin.
      for (let f = d.frames - 1; f >= 0; f--) {
        tl.seek(f / d.fps, false);
        const s = signature();
        if (s !== signatures[f]) {
          res.violations.push({ regle: "R11", frame: f, raison: `état dépendant de l'historique de seek (passe arrière ≠ passe avant) — ${ecart(s, signatures[f])}` });
          break;
        }
      }
      const zero = signature();
      if (initiale !== zero) {
        res.violations.push({ regle: "R11", frame: 0, raison: `l'état de la page fraîche n'est pas celui de la frame 0 — ${ecart(initiale, zero)}` });
      }
      tl.seek(0, false);
      return res;
    }, ZONE_MIN);
    const dureeMs = Number(process.hrtime.bigint() - debut) / 1e6;

    const violations = [...r.violations];
    if (!r.pret) violations.push({ regle: "R4", raison: `runtime non prêt : ${JSON.stringify(r.erreurs_runtime)}` });
    if (!r.polices_ok) violations.push({ regle: "R4", raison: `polices non chargées : ${JSON.stringify(r.polices)}` });
    for (const h of hotes) violations.push({ regle: "R11", raison: `requête réseau pendant le lint : ${h}` });
    return {
      ok: violations.length === 0,
      chrome: chrome.version,
      frames: r.frames,
      mesures: r.mesures,
      duree_seeks_ms: Math.round(dureeMs),
      polices_ok: r.polices_ok,
      violations,
    };
  } finally {
    await navigateur.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dossier = process.argv[2];
  if (!dossier) {
    console.error("usage : node outils/lint-zone-securite.mjs <dossier_rendu>");
    process.exit(2);
  }
  const r = await linter(dossier);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
