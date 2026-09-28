// Tests du lint : il doit REFUSER. Les pages sont trafiquées APRÈS injection,
// pour contourner les garde-fous d'inject.mjs et atteindre le lint seul.
// Contient aussi le test unique de window.hmMesure, la mesure partagée par le
// runtime et le lint.
// node --test outils/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { injecter } from "./inject.mjs";
import { linter } from "./lint-zone-securite.mjs";
import { chromeDuMoteur } from "./chrome.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const lireFixture = (j) => JSON.parse(fs.readFileSync(path.join(RACINE, `fixtures/t0/fixture-${j}.json`), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-lint-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
// Injecte une fixture (éventuellement modifiée), puis trafique la page.
function rendu({ fixture = lireFixture("A"), donnees = null, html = null } = {}) {
  const dir = path.join(TMP, `r${n++}`);
  const f = path.join(TMP, `f${n}.json`);
  fs.writeFileSync(f, JSON.stringify(fixture));
  injecter(f, dir);
  const p = path.join(dir, "index.html");
  let h = fs.readFileSync(p, "utf8");
  if (donnees) {
    h = h.replace(/(<script type="application\/json" id="hm-donnees">)([\s\S]*?)(<\/script>)/, (_, a, json, b) => {
      const d = JSON.parse(json);
      donnees(d);
      return a + JSON.stringify(d) + b;
    });
  }
  if (html) h = html(h);
  fs.writeFileSync(p, h);
  return dir;
}
const slot = (d, scene, id) => d.scenes[scene].slots.find((s) => s.slot === id);
const raisons = (r) => r.violations.map((v) => `${v.regle} ${v.element ?? ""} ${v.raison}`).join("\n");

// --- La mesure partagée, testée une fois, sur des boîtes fabriquées ---
let navigateur, page;
before(async () => {
  navigateur = await puppeteer.launch({ executablePath: chromeDuMoteur().chemin });
  page = await navigateur.newPage();
  await page.setContent(`<div id="b" style="position:absolute;width:200px;height:50px;font:20px/25px monospace;overflow:hidden;overflow-wrap:break-word"></div>`);
  await page.addScriptTag({ path: path.join(RACINE, "runtime/hm-mesure.js") });
});
after(async () => navigateur && (await navigateur.close()));
const mesurer = (texte, maxLignes) =>
  page.evaluate((t, m) => {
    const b = document.getElementById("b");
    b.textContent = t;
    return { lignes: window.hmMesure.lignes(b), deborde: window.hmMesure.deborde(b, m) };
  }, texte, maxLignes);

test("hmMesure : une ligne courte tient", async () => {
  assert.deepEqual(await mesurer("court", 1), { lignes: 1, deborde: false });
});
test("hmMesure : deux lignes rendues, max 2 tient, max 1 déborde", async () => {
  const t = "aaaa bbbb cccc dddd eeee"; // 24 caractères de 12 px dans 200 px : 2 lignes
  assert.deepEqual(await mesurer(t, 2), { lignes: 2, deborde: false });
  assert.deepEqual(await mesurer(t, 1), { lignes: 2, deborde: true });
});
test("hmMesure : contenu plus haut que la boîte déborde, même sous max_lines", async () => {
  // 16 caractères de 12 px par ligne : trois mots par ligne, dix mots = 4 lignes
  // de 25 px dans 50 px. Les lignes masquées par overflow: hidden sont comptées.
  const r = await mesurer("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj", 4);
  assert.equal(r.lignes, 4);
  assert.equal(r.deborde, true);
});
test("hmMesure : les lignes ne dépendent pas de la hauteur de la boîte (piège scrollHeight)", async () => {
  const r = await page.evaluate(() => {
    const b = document.getElementById("b");
    b.textContent = "court";
    b.style.height = "500px";
    const l = window.hmMesure.lignes(b);
    b.style.height = "50px";
    return l;
  });
  assert.equal(r, 1);
});

// --- Le lint accepte les trois fixtures ---
for (const j of ["A", "B", "C"]) {
  test(`lint : fixture ${j} passe`, async () => {
    const r = await linter(rendu({ fixture: lireFixture(j) }));
    assert.equal(r.ok, true, raisons(r));
    assert.equal(r.frames, 450);
  });
}

// --- Le lint refuse ---
test("lint refuse (R5) : texte qui ne tient pas au plancher", async () => {
  const c = lireFixture("C");
  c.scenes[0].text_elements[0].min_font_size_px = 90; // le titre de C tient à 60 px, pas à 90
  const r = await linter(rendu({ fixture: c }));
  assert.equal(r.ok, false);
  assert.match(raisons(r), /R5 sc_01\/slot_headline débordement/);
});

test("lint refuse (R5) : texte hors zone utile (boîte fabriquée)", async () => {
  const r = await linter(rendu({ donnees: (d) => (slot(d, 0, "slot_headline").box.x = 20) }));
  assert.equal(r.ok, false);
  assert.match(raisons(r), /R5 sc_01\/slot_headline boîte \[20,/);
});

test("lint refuse (R5) : logo dans les 35 % du bas", async () => {
  const r = await linter(rendu({ donnees: (d) => (slot(d, 1, "slot_logo").box.y = 1300) }));
  assert.equal(r.ok, false);
  assert.match(raisons(r), /R5 sc_02\/slot_logo boîte/);
});

test("lint refuse (R5) : sortie de zone par transformation, visible à certaines frames seulement", async () => {
  // Un déplacement GSAP en milieu de scène : seul un seek frame par frame le voit.
  const r = await linter(
    rendu({
      html: (h) =>
        h.replace(
          "</body>",
          `<script>(function w(){ if(!window.__timelines||!window.__timelines.root) return setTimeout(w,5);
             var el=document.querySelectorAll('[data-slot="slot_support"]')[0];
             window.__timelines.root.to(el,{x:200,duration:0.1},3).to(el,{x:0,duration:0.1},3.5); })();</script></body>`,
        ),
    }),
  );
  assert.equal(r.ok, false);
  const v = r.violations.find((x) => x.element === "sc_01/slot_support");
  assert.ok(v && v.frame >= 90 && v.frame <= 105, raisons(r));
});

test("lint refuse (R5) : safe_area réduite sous la constante du système", async () => {
  const r = await linter(rendu({ donnees: (d) => (d.safe_area.left = 10) }));
  assert.equal(r.ok, false);
  assert.match(raisons(r), /safe_area\.left = 10/);
});

test("lint refuse (R4) : @font-face absent, malgré document.fonts.check() vrai", async () => {
  const r = await linter(rendu({ html: (h) => h.replace(/@font-face[^\n]*\n/g, "") }));
  assert.equal(r.ok, false);
  assert.equal(r.polices_ok, false);
  assert.match(raisons(r), /R4/);
});

test("lint refuse (R11) : requête réseau depuis la page", async () => {
  const r = await linter(rendu({ html: (h) => h.replace("</body>", '<img src="http://example.invalid/pixel.png"></body>') }));
  assert.equal(r.ok, false);
  assert.match(raisons(r), /R11 .*example\.invalid/);
});

test("lint refuse (R11) : état dépendant de l'historique de seek (motif fautif du runtime avant correctif)", async () => {
  // Reproduit la sc_02 d'avant le correctif : visible par le CSS au
  // chargement, set() « caché » à la position 0, « visible » à 7,5 s. Sur page
  // fraîche, seek(0) ne rend rien : la frame 0 dépend du chemin. Le motif est
  // greffé au moment où le runtime enregistre sa timeline.
  const greffe = `<script>window.__timelines = new Proxy({}, { set: function (t, k, tl) {
      var s = document.createElement("section");
      s.className = "hm-scene"; s.setAttribute("data-scene", "sc_test");
      s.style.cssText = "position:absolute;inset:0;background:var(--brand-fond)";
      document.getElementById("root").appendChild(s);
      tl.set(s, { autoAlpha: 0 }, 0); tl.set(s, { autoAlpha: 1 }, 7.5);
      t[k] = tl; return true; } });</script>
<script src="hm-runtime.js"></script>`;
  const r = await linter(rendu({ html: (h) => h.replace('<script src="hm-runtime.js"></script>', greffe) }));
  assert.equal(r.ok, false);
  assert.match(raisons(r), /R11 .*(historique de seek|page fraîche).*sc_test/);
});
