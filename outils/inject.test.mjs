// Tests de l'injection : ce qui compte, c'est qu'elle REFUSE.
// node --test outils/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { versSecondes, verifierT11, injecter, ErreurInjection } from "./inject.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const TPL = path.join(RACINE, "templates/tpl_t0_hero/1.0.0");
const HTML = fs.readFileSync(path.join(TPL, "index.html"), "utf8");
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(TPL, "manifest.json"), "utf8"));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(RACINE, "fixtures/t0/fixture-A.json"), "utf8"));

test("temps : sur la grille, aller-retour exact", () => {
  assert.deepEqual(versSecondes(7500, 30, "x"), { frame: 225, secondes: 7.5 });
  assert.deepEqual(versSecondes(7300, 30, "x"), { frame: 219, secondes: 7.3 });
  assert.deepEqual(versSecondes(0, 30, "x"), { frame: 0, secondes: 0 });
});

test("temps : hors grille refusé", () => {
  assert.throws(() => versSecondes(7510, 30, "x"), ErreurInjection);
  assert.throws(() => versSecondes(375, 30, "x"), ErreurInjection);
});

test("T11 : le template livré passe", () => {
  assert.deepEqual(verifierT11(HTML, MANIFESTE), []);
});

const violations = {
  "couleur hex": (h) => h.replace("background: var(--brand-fond)", "background: #0E1116"),
  "couleur nommée": (h) => h.replace("#root {", "#root { color: white;"),
  "rgb()": (h) => h.replace("#root {", "#root { border: 1px solid rgb(0,0,0);"),
  "font-family littéral": (h) => h.replace(".hm-text {", '.hm-text { font-family: "Inter";'),
  "durée CSS": (h) => h.replace(".hm-text {", ".hm-text { transition: opacity 300ms;"),
  "URL distante": (h) => h.replace("</head>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>'),
  "URL sans protocole": (h) => h.replace("</head>", '<script src="//cdn.example/x.js"></script></head>'),
  "Math.random": (h) => h.replace("</body>", "<script>var x = Math.random();</script></body>"),
  requestAnimationFrame: (h) => h.replace("</body>", "<script>requestAnimationFrame(function(){});</script></body>"),
  "texte en dur": (h) => h.replace('class="hm-text"></p>', 'class="hm-text">Promo -50 %</p>'),
  "slot manquant": (h) => h.replace('<img data-slot="slot_logo" alt="">', ""),
  "slot en double": (h) => h.replace('<img data-slot="slot_logo" alt="">', '<img data-slot="slot_logo" alt=""><img data-slot="slot_logo" alt="">'),
  "slot hors manifeste": (h) => h.replace('<img data-slot="slot_logo" alt="">', '<img data-slot="slot_logo" alt=""><img data-slot="slot_cta" alt="">'),
};
for (const [nom, casser] of Object.entries(violations)) {
  test(`T11 refuse : ${nom}`, () => {
    const h = casser(HTML);
    assert.notEqual(h, HTML, "la mutation doit modifier le template");
    assert.ok(verifierT11(h, MANIFESTE).length > 0);
  });
}

// Injection de bout en bout sur une fixture et/ou un template modifiés.
function injecterAvec({ fixture = FIXTURE, manifeste = MANIFESTE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-inject-"));
  const tplDir = path.join(RACINE, "templates/tpl_t0_test/1.0.0");
  const f = path.join(dir, "fixture.json");
  const c = structuredClone(fixture);
  for (const s of c.scenes) s.template_id = "tpl_t0_test";
  fs.writeFileSync(f, JSON.stringify(c));
  fs.mkdirSync(tplDir, { recursive: true });
  fs.writeFileSync(path.join(tplDir, "index.html"), HTML);
  fs.writeFileSync(path.join(tplDir, "manifest.json"), JSON.stringify(manifeste));
  try {
    return injecter(f, path.join(dir, "sortie"));
  } finally {
    fs.rmSync(path.join(RACINE, "templates/tpl_t0_test"), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("injection : la fixture A passe", () => {
  const d = injecterAvec();
  assert.equal(d.frames, 450);
  assert.equal(d.scenes[1].visible_debut_s, 7.5);
});

test("É-17 : deux slots acceptant le même rôle ne sont plus ambigus, la liaison suit slot_id", () => {
  const m = structuredClone(MANIFESTE);
  m.slots.find((s) => s.slot_id === "slot_bg").accepts_roles.push("subject");
  const d = injecterAvec({ manifeste: m });
  const sujet = d.scenes[0].slots.find((s) => s.role === "subject");
  assert.equal(sujet.slot, "slot_subject");
});

test("injection refuse (R3) : slot_id absent du manifeste", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].layers[1].slot_id = "slot_inconnu";
  assert.throws(() => injecterAvec({ fixture: c }), /slot_inconnu absent du manifeste/);
});

test("injection refuse (R3) : couche liée à un slot texte", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].layers[1].slot_id = "slot_headline";
  assert.throws(() => injecterAvec({ fixture: c }), /n'accepte pas le rôle subject/);
});

test("injection refuse (R3) : rôle non accepté par le slot nommé", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].layers[0].slot_id = "slot_subject"; // un fond dans le slot du sujet
  assert.throws(() => injecterAvec({ fixture: c }), /n'accepte pas le rôle background/);
});

test("injection refuse (R3) : rôle broll, accepté par aucun slot (vocabulaires disjoints)", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].layers[1].role = "broll";
  assert.throws(() => injecterAvec({ fixture: c }), /n'accepte pas le rôle broll/);
});

test("injection refuse (R3) : deux éléments dans le même slot", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].text_elements[1].slot_id = "slot_headline";
  c.scenes[0].text_elements[1].role = "headline";
  assert.throws(() => injecterAvec({ fixture: c }), /déjà rempli dans la scène/);
});

test("injection refuse : boîte incohérente avec le manifeste", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].text_elements[0].box.x = 60;
  assert.throws(() => injecterAvec({ fixture: c }), /box\.x/);
});

test("injection refuse : z_index incohérent avec le manifeste", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].layers[2].z_index = 5;
  assert.throws(() => injecterAvec({ fixture: c }), /z_index/);
});

test("injection refuse : temps hors grille dans une animation", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].text_elements[0].animation.start_ms = 410;
  assert.throws(() => injecterAvec({ fixture: c }), /grille/);
});

test("injection refuse : sha256 d'asset différent", () => {
  const c = structuredClone(FIXTURE);
  Object.values(c.assets)[0].checksum = "0".repeat(64);
  assert.throws(() => injecterAvec({ fixture: c }), /sha256/);
});

test("injection refuse : font_ref inconnu (R4)", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].text_elements[0].font_ref = "fnt_absente";
  assert.throws(() => injecterAvec({ fixture: c }), /R4/);
});

test("injection refuse : slot requis vide", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[0].layers.pop();
  assert.throws(() => injecterAvec({ fixture: c }), /slot requis slot_logo vide/);
});

test("injection refuse : animation.start_ms hors de sa scène (lu comme relatif)", () => {
  const c = structuredClone(FIXTURE);
  c.scenes[1].text_elements[0].animation.start_ms = 400; // relatif à sc_02, donc hors [7500, 15000]
  assert.throws(() => injecterAvec({ fixture: c }), /hors de la scène/);
});
