# Rapport T0-technique : le moteur HyperFrames

*29/09/2026. Recette de référence : commit `13c9dc1`, arbre propre avant et
après, `outils/recette-t0.sh`. Les quatre décisions prises après la première
version de ce rapport y sont appliquées. Toutes les valeurs ci-dessous sont mesurées.
Celles qui ne le sont pas sont signalées comme telles.*

Périmètre : T0-technique (brief §3), c'est-à-dire Q1, Q2, Q3 et les
critères A et C, sur des placeholders fabriqués à la main. Le critère B
(qualité perçue sur de vrais assets) attend les assets du client et n'est
pas traité ici.

## Verdict

| Question | Réponse | En une ligne |
|---|---|---|
| **Q1**, DOM pré-rendu inspectable | **Oui** | Lint R5 sur les 450 frames, dans le Chrome de la capture, en 75 à 162 ms |
| **Q2**, correspondance manifeste ↔ HTML (T11) | **Oui, mais seulement entre le manifeste et le HTML** | **T11 tient entre le manifeste et le HTML, pas entre la composition et le HTML** (É-17) |
| **Q3**, deux rendus, même hash de frames | **Oui, après quatre correctifs** | 3 rendus sur 3 identiques par jeu dans la recette, 16 sur 16 sur C en expérience |

`capacites()` pour hyperframes 0.8.83 :
- `lint_dom` : vrai ;
- `slots_declares` : vrai (notre code, pas le moteur) ;
- `sorties` : `png_sequence` (le MP4 est produit par notre commande FFmpeg) ;
- `fps_supportes` : contient 30.

Le pari D7 est techniquement tenable. Le verdict complet attend le critère B.

## Environnement

| | |
|---|---|
| Moteur | hyperframes 0.8.83 (épinglé exactement) |
| Chrome de capture et du lint | Chrome for Testing **152.0.7977.30**, headless-shell, **téléchargé par le moteur** (non épinglé par nous) |
| GSAP | 3.15.0, depuis le disque |
| Node / FFmpeg / strace | 22.23.1 / 4.4.2 / 5.16 |
| Machine | WSL2 (noyau 6.6.87.2), **12 cœurs**, 11 Go ; `job-produce` aura 4 vCPU |

Deux rendus faits sur deux versions de Chrome peuvent diverger légitimement.
Ce qui reproduit un rendu, c'est le couple moteur + Chrome, donc l'image du
conteneur, et pas `moteur_version` seul (brief §9).

## Critères d'acceptation

| Critère | Mesure (A / B / C) | Verdict |
|---|---|---|
| 1080×1920, H.264, 30 fps fixe, ≤ 30 s | 1080×1920, h264, `30/1`, **durées de paquets toutes égales (512)**, 450 frames, 15 000 ms | ✔ |
| Aperçu : profil Main, `has_b_frames` = 0, yuv420p, ≤ 16 Mo | Main 4.0, 0, yuv420p ; 1,02 / 0,96 / 1,87 Mo (plafond déclaré 15 Mio) | ✔ |
| Piste audio AAC stéréo présente même si silencieuse | aac, 2 canaux, 48 kHz sur les deux sorties | ✔ |
| … à ≥ 128 kb/s | Débit **déclaré** 128 kbps (contrôlé) ; débit **mesuré** 2,3 kbps en silence, « non applicable : silent_fallback » selon R9 amendée (`fcda566`) | ✔ |
| Espace colorimétrique (ajouté le 29/09) | BT.709 converti et étiqueté, plage tv, sur les deux sorties ; `#FF5A1F` relu à 2 niveaux près | ✔ |
| Deux rendus → hashs identiques | rendu seul, puis deux rendus du harnais : 3 sur 3 identiques par jeu ; fichiers encodés identiques aussi | ✔ |
| Rendu d'une vidéo de 15 s en ≤ 5 min | rendu PNG **15,0 / 16,5 / 16,6 s** sans strace ; encodage des deux sorties 22,7 / 22,8 / 26,2 s | ✔ |
| Aucune ligne de code modifiée entre les 3 jeux | recette au commit `13c9dc1`, arbre propre vérifié avant et après | ✔ |

Hashes de référence (`hash_frames`, inchangés de `6dc5e5d` à `13c9dc1` : seuls
l'encodage et la vérification ont changé depuis) :
- A : `47c4879e5c7c…`
- B : `43191ebfa67c…`
- C : `145984882f69…`

**Mesures de temps à relativiser.** Elles viennent d'une machine à 12 cœurs,
et le rendu n'utilise qu'un seul worker (voir Q3), donc peu de cœurs.
Mesurer sur 4 vCPU reste nécessaire, mais la marge sur 5 minutes est
d'environ ×10.

## Q1 : le DOM pré-rendu est inspectable

`lint-zone-securite.mjs` ouvre la page injectée dans **le même binaire
Chrome que la capture**. Le rendu échoue si les versions diffèrent. Le lint
seeke la timeline à chaque frame (`frame / fps`) et mesure chaque texte et
chaque logo visible :
- boîte englobante, transformations comprises, contenue dans la zone utile (65–972 × 269–1248) ;
- pas de débordement ;
- nombre de lignes ≤ `max_lines` ;
- taille finale ≥ `min_font_size_px`.

Il contrôle aussi :
- que `safe_area` est ≥ à la constante ;
- les polices (R4) ;
- le réseau : toute requête hors `file:` et `data:` fait échouer ;
- l'**historique de seek** : même état en passe avant et en passe arrière, et page fraîche = frame 0 ;
- l'**opacité animée** : `will-change` exigé.

| | A | B | C |
|---|---|---|---|
| Frames | 450 | 450 | 450 |
| Éléments mesurés | 1 274 | 1 297 | 1 297 |
| Durée du lint complet | 162 ms | 75 ms | 81 ms |

**Pas d'échantillonnage, en production non plus.** Toutes les frames coûtent
moins de 0,2 s, et une sortie de zone passagère n'est visible que frame par
frame. Testé avec un déplacement de 0,1 s en milieu de scène, attrapé à sa
frame.

Le lint refuse, et c'est testé :
- texte qui ne tient pas au plancher ;
- texte hors zone ;
- logo dans les 35 % du bas ;
- sortie de zone passagère ;
- `safe_area` réduite ;
- `@font-face` absent ;
- requête réseau ;
- état dépendant de l'historique de seek ;
- opacité animée sans `will-change`.

**Une seule mesure des lignes**, partagée par le rétrécissement et R5
(`runtime/hm-mesure.js`). Elle compte les lignes réellement rendues, jamais
à partir de `scrollHeight`, et la première version était fausse pour cette
raison. Fixture C après correction :
- titres à 60 et 72 px (plancher 48) ;
- texte d'appui à 40 px (plancher 32).

**Limite.** Le lint mesure le DOM, pas les pixels. Il ne peut pas voir une
différence de composition dans Chrome : seul le harnais de déterminisme la
voit (voir Q3).

## Q2 : manifeste ↔ HTML, oui ; composition ↔ HTML, non

**Ce qui tient, et qui est vérifié par code** :
- `outils/valider-contrats.mjs` valide le manifeste contre `Template.schema.json` et les fixtures contre `Composition.schema.json` (ajv, vrais schémas). Seuls les chemins déclarés dans `fixture-X.omissions.json` sont relâchés. Il rejette 6 fixtures cassées exprès.
- `verifierT11` fait l'analyse statique du template : correspondance slots ↔ `data-slot` dans les deux sens et exactement une fois, aucune couleur, police, durée, URL, aléa ni texte en dur. 13 violations sont testées et refusées.
- L'injection vérifie en plus que les boîtes de la composition concordent avec le manifeste à ±1 px, ainsi que les `z_index`.

**Ce qui ne tenait pas, corrigé le 29/09 (É-17)** : la composition ne nommait
pas le slot, et l'injection devait déduire la liaison du rôle. `layer` et
`text_element` portent désormais un `slot_id` requis, et R3 vérifie la
correspondance composition ↔ manifeste : slot existant, nature compatible, rôle
accepté, au plus un élément par slot. L'injection suit `slot_id` et ne déduit
plus rien. Les pages injectées des trois jeux sont identiques octet pour octet
à celles d'avant la correction.

**Écart restant (É-20, à trancher)** : `layer.role` (`background`, `subject`,
`broll`, `logo`, `overlay`) et `accepts_roles` (`subject`, `background`,
`logo`, `supporting`) ne se recouvrent pas. Une couche `broll` ou `overlay`
n'est acceptée par aucun slot, et R3 la rejette (testé).

La composition v2 ne sait pas non plus exprimer ce qui suit. En T0, j'ai
contourné chaque point par le cas le plus simple ; aucun n'est corrigé :

| Manque | Conséquence en T0 |
|---|---|
| Animation d'entrée d'une couche média | Beats du manifeste sur les textes seulement ; le sujet entre sans mouvement |
| Amplitude de `slide_in`, `scale_in`, `mask_reveal` | Seul `fade_in` est rendable ; les autres sont refusés par le runtime |
| Couches auxquelles s'applique la caméra | `capabilities.camera = ["static"]`, non exercé |
| `provenance.source` pour un placeholder (**É-18**) | `assets.*.provenance` omis, déclaré |
| `animation.start_ms` global contre `camera.keyframes[].t_ms` relatif (**É-19**) | Global confirmé, confiné à sa scène par assertion |

## Q3 : le déterminisme tient, après quatre correctifs

Méthode :
- `hash_frames` = sha256 des md5 `framemd5` des pixels décodés, dans l'ordre ; c'est lui qui fait foi ;
- le hash des fichiers encodés est informatif (É-14).

Le harnais a été éprouvé : une page avec `Math.random` donne deux hashes
différents.

| # | Défaut mesuré | Cause établie | Correctif | Contrôle ajouté |
|---|---|---|---|---|
| 1 | Frame 0 **vide dans tous les rendus** ; frames 150 à 224 vides dans environ un rendu de A sur six | Deux `set()` contradictoires à la position 0 : le résultat dépendait du chemin de seek. Sur une page fraîche, `seek(0)` ne rend rien | État à t = 0 posé en style inline, timeline faite uniquement de changements (`a5f2254`) | Lint : passe arrière et page fraîche = frame 0. L'ancien runtime réel est rejeté |
| 2 | Le hash dépend du nombre de workers : B donne `a194` avec 1 worker, `51d1` avec 3, et le mode « auto » varie | Le découpage des frames entre pages Chrome ; « auto » calibre selon la vitesse de la machine | `--workers 1` (`8844b19`). **Insuffisant seul** : ce commit a conclu trop vite, sur deux rendus | Aucun ; épinglé dans `rendre.mjs` |
| 3 | Deux hashes stables selon le lancement (C : `d06a` ou `575c`), écart de 1 à 2 niveaux sur 255, **uniquement là où l'opacité s'anime** | Chrome choisit au lancement de composer ou non l'élément sur sa couche. Ce n'est pas la valeur : l'opacité arrondie au 1/255 donne les mêmes deux hashes | `will-change: opacity` sur toute opacité animée (`6dc5e5d`) : 16 rendus sur 16 identiques | Lint : opacité variable sans `will-change` → rejet |
| 4 | Fichiers encodés différents avec des frames identiques | x264 multi-thread (mêmes PNG, deux fichiers ; `-threads 1` : identiques) | `-threads 1` (`a46a9f2`), comme prévu par É-14. Coût : encodage 27 s au lieu de 15 s | Aucun ; informatif |

**Le défaut 1 était invisible au harnais**, parce que le même défaut se
reproduisait à chaque rendu. **Le défaut 3 lui échappait souvent**, parce que
ses deux rendus tombaient sur le même état. C'est un troisième rendu, celui
de la recette, qui l'a montré. Un harnais à deux rendus prouve peu contre un
défaut rare.

**Risque résiduel.** Si le défaut 3 survivait à la fréquence mesurée
pendant la chasse (environ 1 rendu sur 13), il resterait environ 27 % de
chances qu'il n'ait pas été vu en 16 rendus. À surveiller en CI sur plus de
rendus.

## Réseau

Règle (brief §11) : un rendu échoue si **une donnée franchit la
frontière**. Couches :
- noms de famille privés ;
- télémétrie coupée ;
- `unshare -rn`, le moteur exigeant la boucle locale ;
- journal strace, dont les descripteurs sont suivis processus par processus.

- **Rendu propre** : 127.0.0.1 ×6, ::1 ×4, aucune violation.
- **Exception documentée** : **1 sonde de joignabilité IPv6 de Chrome par
  rendu** (4 avec plusieurs workers) : UDP, `2001:4860:4860::8888:443`,
  zéro envoi, tolérée.
- **Le détecteur est éprouvé** : une requête délibérée vers example.com fait
  échouer, avec réseau (connexion TCP vers Cloudflare, DNS) comme sous
  isolation (tentatives DNS). 16 tests unitaires portent sur les formats
  réels de strace, et chaque condition de la sonde, retirée seule, fait
  échouer.
- **Faux négatif corrigé** : le premier rendu « propre » (« 127.0.0.1 ×21 »)
  était faux, parce que le parseur ignorait l'IPv6. Un détecteur non éprouvé
  raconte ce qu'on veut entendre.
- **Limites** : `fcntl(F_DUPFD)` et le passage de descripteurs par
  `SCM_RIGHTS` ne sont pas suivis.

## Découvertes qui changent quelque chose ailleurs

1. **`document.fonts.check()` ne prouve pas le chargement.** Il répond vrai
   pour une famille inexistante, sur une page sans aucun `@font-face`. La
   preuve est une `FontFace` de la famille privée à l'état `loaded`.
   **R4 et B4 réécrites** (`80231ec`), T11 corrigé (`e0167fb`).
2. **Chrome n'est pas épinglé par le moteur**, qui le télécharge : 12 min au
   premier rendu. L'image de `job-produce` **doit** embarquer Chrome, faute
   de quoi le budget d'`ASSETS_READY` saute (brief §9).
3. **Le moteur a des variables JSON** (`--variables`), contrairement à ce
   qu'écrit le §5.1. Non utilisées, par décision (brief §8).
4. **L'espace colorimétrique n'était décidé par personne.** swscale
   convertissait en BT.601 sans étiquette, et l'accent `#FF5A1F` relu en
   BT.709 ressortait en 255,99,25. **Réglé dans le contrat**
   (`ffcd8b3`) : `encode.*.video.color` fixé à BT.709 en plage tv,
   appliqué par l'encodeur (matrice et étiquettes), et vérifié par R9 et par
   un test sur la couleur elle-même.
5. **Les règles d'écriture et d'exécution issues de T0 sont inscrites**
   (`13c9dc1`) :
   - dans T11 : état à t = 0 dans le DOM, `will-change` sur toute opacité animée ;
   - dans le §5.1 : un seul worker, x264 à un thread.

## Décisions prises le 29/09

| Question | Décision | Commit |
|---|---|---|
| Débit audio du silence | Débit optimal gardé ; R9 contrôle le débit déclaré, le débit mesuré est « non applicable » en `silent_fallback` | `fcda566` |
| R4 / B4 | Réécrites : preuve `FontFace loaded` | `80231ec` |
| Espace colorimétrique | Dans la composition : BT.709, plage tv | `ffcd8b3` |
| Où inscrire les règles de T0 | T11 et §5.1 | `13c9dc1` |

**Changement de contrat à signaler** : `encode.*.video.color` est un **champ
nouveau** et requis dans `Composition.schema.json`, ajouté sur décision
explicite. Le compilateur de T3 devra le produire.

## Limites de ce rapport

- **Placeholders seulement** : rien sur la qualité perçue (critère B).
- **Une machine, un Chrome, une version du moteur.**
- **Pas d'audio réel** (T0b), **pas de caméra**, **`fade_in` seulement**.
- **La preuve de déterminisme est statistique** : voir le risque résiduel.

## Reproduire

```sh
npm ci
node --test outils/*.test.mjs        # 79 tests ; 4 lancent de vrais rendus (5 rendus, ~4 min)
outils/recette-t0.sh <dossier>       # les trois jeux, même commit (~10 min)
```
