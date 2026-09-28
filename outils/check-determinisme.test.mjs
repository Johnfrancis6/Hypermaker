// Test du harnais de déterminisme : il doit DÉTECTER. Une page dont un
// pixel dépend de Math.random (T11 contourné en trafiquant la page après
// injection) doit donner deux hash_frames différents. Deux rendus complets.
// node --test outils/*.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injecter } from "./inject.mjs";
import { determinisme } from "./check-determinisme.mjs";

const RACINE = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(RACINE, "fixtures/t0/fixture-A.json");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-det-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("détecte : un aplat dont la couleur vient de Math.random → hash_frames différents", async () => {
  const dir = path.join(TMP, "alea");
  injecter(FIXTURE, dir);
  const p = path.join(dir, "index.html");
  fs.writeFileSync(
    p,
    fs.readFileSync(p, "utf8").replace(
      "</body>",
      `<div id="alea" style="position:absolute;left:400px;top:1500px;width:200px;height:200px;z-index:99"></div>
<script>var v = Math.floor(Math.random() * 256); document.getElementById("alea").style.background = "rgb(" + v + "," + v + "," + v + ")";</script></body>`,
    ),
  );
  const r = await determinisme(dir, FIXTURE);
  assert.equal(r.ok, false);
  assert.notEqual(r.rendus[0].hash_frames, r.rendus[1].hash_frames);
});
