// Valide le manifeste du template contre Template.schema.json, et chaque
// fixture contre Composition.schema.json — le vrai schéma, pas une copie.
//
// Une fixture est un sous-ensemble FIDÈLE : seuls les chemins déclarés dans
// fixture-X.omissions.json sont relâchés, en retirant leur dernier segment du
// `required` du nœud de schéma qui le porte. Tout le reste s'applique tel quel.
// Un chemin déclaré omis mais présent dans la fixture est une erreur :
// l'omission doit être vraie, pas seulement déclarée.
//
// Usage : node outils/valider-contrats.mjs <manifest.json> <fixture.json>...
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const lire = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const RACINE = path.resolve(import.meta.dirname, "..");
const SCHEMA_TEMPLATE = lire(path.join(RACINE, "setup/Template.schema.json"));
const SCHEMA_COMPOSITION = lire(path.join(RACINE, "setup/Composition.schema.json"));

function valider(schema, doc) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const ok = ajv.validate(schema, doc);
  return ok ? [] : ajv.errors.map((e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`);
}

// Suit un chemin « a.*.b » dans le schéma : « * » descend dans items ou
// additionalProperties, les $ref locaux sont résolus.
function noeudParent(schema, segments) {
  const resoudre = (n) => (n.$ref ? resoudre(n.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], schema)) : n);
  let n = resoudre(schema);
  for (const s of segments) {
    if (s === "*") n = resoudre(n.items ?? n.additionalProperties);
    else n = resoudre(n.properties[s]);
    if (!n) throw new Error(`chemin introuvable dans le schéma : ${segments.join(".")}`);
  }
  return n;
}

function relacher(schema, chemins) {
  const copie = structuredClone(schema);
  for (const chemin of chemins) {
    const segments = chemin.split(".");
    const cle = segments.pop();
    const n = noeudParent(copie, segments);
    if (!n.required?.includes(cle)) throw new Error(`« ${chemin} » n'est pas requis par le schéma : rien à omettre`);
    n.required = n.required.filter((k) => k !== cle);
  }
  return copie;
}

// Valeurs présentes dans le document au chemin « a.*.b ».
function valeursAu(doc, segments) {
  if (segments.length === 0) return [doc];
  const [s, ...reste] = segments;
  if (doc === null || typeof doc !== "object") return [];
  if (s === "*") return Object.values(doc).flatMap((v) => valeursAu(v, reste));
  return s in doc ? valeursAu(doc[s], reste) : [];
}

let echecs = 0;
const [manifeste, ...fixtures] = process.argv.slice(2);
if (!manifeste || fixtures.length === 0) {
  console.error("usage : node outils/valider-contrats.mjs <manifest.json> <fixture.json>...");
  process.exit(2);
}

const erreursManifeste = valider(SCHEMA_TEMPLATE, lire(manifeste));
console.log(`${erreursManifeste.length ? "ÉCHEC" : "ok   "} ${manifeste} contre Template.schema.json`);
erreursManifeste.forEach((e) => console.log(`       ${e}`));
echecs += erreursManifeste.length;

for (const f of fixtures) {
  const doc = lire(f);
  const { omis } = lire(f.replace(/\.json$/, ".omissions.json"));
  const chemins = omis.map((o) => o.chemin);
  const erreurs = [];
  for (const c of chemins) {
    const n = valeursAu(doc, c.split(".")).length;
    if (n > 0) erreurs.push(`« ${c} » est déclaré omis mais présent (${n} valeur(s))`);
  }
  erreurs.push(...valider(relacher(SCHEMA_COMPOSITION, chemins), doc));
  console.log(`${erreurs.length ? "ÉCHEC" : "ok   "} ${f} contre Composition.schema.json, omis : ${chemins.join(", ")}`);
  erreurs.forEach((e) => console.log(`       ${e}`));
  echecs += erreurs.length;
}
process.exit(echecs ? 1 : 0);
