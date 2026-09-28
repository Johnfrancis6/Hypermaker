#!/usr/bin/env bash
# Recette T0-technique : les trois jeux, même commit, arbre propre avant et
# après. Chaque étape échoue franchement ; les relevés vont dans $SORTIE.
# Usage : outils/recette-t0.sh <dossier_sortie>
set -uo pipefail
cd "$(dirname "$0")/.."
SORTIE=${1:?usage : outils/recette-t0.sh <dossier_sortie>}
mkdir -p "$SORTIE"
propre() { [ -z "$(git status --porcelain -- ':!rendus')" ]; }
propre || { echo "arbre de travail modifié : la recette exige un commit propre"; exit 1; }
COMMIT=$(git rev-parse HEAD)
echo "commit $COMMIT" | tee "$SORTIE/recette.txt"
node outils/valider-contrats.mjs templates/tpl_t0_hero/1.0.0/manifest.json fixtures/t0/fixture-{A,B,C}.json | tee -a "$SORTIE/recette.txt"
for J in A B C; do
  D="$SORTIE/$J"; mkdir -p "$D"
  node outils/inject.mjs "fixtures/t0/fixture-$J.json" "$D/page" | tee -a "$SORTIE/recette.txt"
  node outils/lint-zone-securite.mjs "$D/page" > "$D/lint.json"; echo "$J lint : code $?" | tee -a "$SORTIE/recette.txt"
  node outils/rendre.mjs "$D/page" "$D/png" > "$D/rendu.json"; echo "$J rendre : code $?" | tee -a "$SORTIE/recette.txt"
  node outils/encoder.mjs "fixtures/t0/fixture-$J.json" "$D/png" "$D/mp4" > "$D/encodage.json"; echo "$J encodage : code $?" | tee -a "$SORTIE/recette.txt"
  node outils/check-conformite.mjs "fixtures/t0/fixture-$J.json" "$D/mp4/preview.mp4" "$D/mp4/master.mp4" > "$D/conformite.txt"; echo "$J conformité : code $?" | tee -a "$SORTIE/recette.txt"
  node outils/check-determinisme.mjs "fixtures/t0/fixture-$J.json" > "$D/determinisme.json"; echo "$J déterminisme : code $?" | tee -a "$SORTIE/recette.txt"
done
propre && [ "$(git rev-parse HEAD)" = "$COMMIT" ] && echo "aucune ligne de code modifiée entre les trois jeux : commit $COMMIT, arbre propre" | tee -a "$SORTIE/recette.txt"
