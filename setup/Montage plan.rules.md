# Règles du montage plan — v1

> Nouveau contrat, créé le 26 septembre 2026 (décision D21). Aligné sur
> `montage_plan.schema.json` v1 et sur les contrats storyboard v2, template v1,
> Brand Pack v2 et composition v2.

## Rôle du contrat

Le Monteur est un LLM. Il **décide**, il ne résout rien. Le `montage_plan` est la
trace de ses décisions, toutes prises dans des listes fermées :

```
voix off (TTS + alignement) → durées de scène connues
code      → menu fermé par scène
Monteur   → montage_plan.json → CE VALIDATEUR → compilateur → composition.json
```

Trois propriétés tiennent le contrat :

1. **Vocabulaire fermé.** Chaque décision est une clé prise dans un menu que le
   code a calculé pour cette scène. Tout choix hors menu est rejeté.
2. **Zéro valeur résolue.** Aucun pixel, aucune milliseconde, aucune couleur, aucun
   décibel. Le compilateur les tire du Brand Pack et des templates.
3. **Zéro dépense.** Le plan ne peut référencer qu'un asset déjà présent sur R2.
   Aucune génération ne part d'ici. Un refus de Franco coûte donc un appel LLM et
   un rendu, jamais une génération.

Chaque décision porte un `decision_id`, repris dans `plan_decision_ref` de la
composition. C'est ce qui permet d'attribuer un défaut au Monteur ou au
compilateur (R3).

Chaque échec est bloquant. Le Monteur reçoit l'erreur et corrige **une fois**. Au
second échec, le projet passe en alerte pour Franco.

---

## Ce que reçoit le Monteur

Le prompt du Monteur contient, et seulement :

- le storyboard validé par le client : intentions, textes, scripts, rôles de scène ;
- les durées réelles des scènes et l'alignement mot à mot de la voix off ;
- le **menu fermé** de chaque scène (M3) ;
- le bloc `guidance` du Brand Pack ;
- la **table du flou** : correspondance entre les formulations courantes (« plus
  dynamique », « plus sobre », « plus luxe ») et le vocabulaire du plan ;
- en cas de reprise, le motif du refus de Franco et le plan parent.

Il ne reçoit **jamais** les images, ni un asset, un plan ou un exemple d'un autre
client (D30). Le catalogue d'assets est transmis sous forme de métadonnées
(`label`, `tags`, `kind`, dimensions).

---

## M1 — Correspondance avec les entrées

- `scenes[].scene_id` : même ensemble et même ordre que le storyboard
- `inputs.storyboard_hash` correspond à une validation client enregistrée (S11).
  Aucun plan n'est accepté pour un storyboard que le client n'a pas validé.
- `inputs.brand_pack_version` est la version référencée par le storyboard, pas la
  dernière publiée (B1)
- Si le storyboard a une voix off : `inputs.voiceover_alignment_hash` correspond à
  l'alignement stocké. Les durées et les `word_ref` en dépendent.
- `inputs.menu_hash` correspond au menu effectivement transmis au Monteur

## M2 — Unicité et traçabilité des décisions

- Tous les `decision_id` sont uniques dans le plan
- Toute décision a un `decision_id`, y compris celles imposées par le code
- Le `plan_hash`, calculé par le validateur, est le SHA-256 du JSON canonique du
  plan (clés triées, sans espaces, UTF-8), champs `why` **exclus**. Il est repris
  dans `composition.compiled_from.montage_plan_hash`.

Les `why` sont exclus du hash parce qu'ils n'influencent pas le rendu. Deux plans
aux décisions identiques mais aux justifications différentes produisent la même
vidéo.

## M3 — Menu fermé

Le code calcule, pour chaque scène, **avant** d'appeler le Monteur :

| Décision | Menu |
|---|---|
| Template | Ensemble éligible (T6) |
| Intensité | Clés de `reveal_map` (toujours les trois) |
| Caméra | Clés de `camera_map` ∩ `capabilities.camera` du template, filtrées par M5 |
| Profondeur | `true` seulement si M6 le permet |
| Transition | Clés de `transition_map`, filtrées par M8 |
| Effet | Clés de `effect_map` ∩ `capabilities.effects`, filtrées par M7 |
| B-roll | Assets existants du client compatibles avec les slots libres (M10) |
| Emphase sur un mot | Beats `on_word` du template × mots du segment de la scène (M9) |
| Son sémantique | Section sémantique de la bibliothèque audio (M11) |
| Musique | Pistes taguées dans `allowed_moods`, non livrées à un autre client (M12) |

Le menu dépend du template choisi. Le Monteur reçoit donc, pour chaque scène, un
menu **par template éligible**.

**Une seule option** : le code l'impose sans consulter le Monteur, et marque la
décision `chosen_by: code` pour le template. Inutile de payer un LLM pour une
décision déjà prise.

**Menu vide** pour une décision obligatoire : échec avant l'appel au Monteur, qui
nomme la contrainte non satisfaite.

Le validateur vérifie chaque décision contre le menu dont le hash figure dans
`inputs.menu_hash`. C'est la seule vérification qui compte : les règles M4 à M12
décrivent comment le menu est construit, et sont rejouées ici par sécurité.

## M4 — Template

- `template_id` et `template_version` appartiennent à l'ensemble éligible de la
  scène (T6), calculé sur la durée réelle
- `template_version` est une version `published`

## M5 — Caméra et capacités

Anciennes règles R4 du storyboard, déplacées ici avec la décision.

- `preset` ∈ clés de `camera_map` du Brand Pack **et** `capabilities.camera` du
  template
- `orbit` exige un asset de rôle `subject` dont le `kind` est `sequence_360` ou
  `video`. Une photo plate ne tourne pas.
- `push_in` ou `pull_back` sur un asset `still` exige une résolution source
  ≥ 1,5 × la boîte du slot × l'échelle maximale de la caméra (T7, R7). Sinon le
  zoom révèle les pixels.
- Une scène de moins de 1,5 s : `static` ou `drift` uniquement. Un zoom sur une
  scène aussi courte se lit comme un sursaut.

## M6 — Profondeur

Ancienne règle R5 du storyboard.

`layered: true` exige :

- `capabilities.depth == true` pour le template choisi ;
- au moins un asset `background` **et** un asset `subject` distincts dans la scène.

Sans deux plans, il n'y a pas de parallaxe, seulement un coût de rendu
supplémentaire pour un résultat identique.

## M7 — Intensité et effets

**Intensité**

- `value` ∈ `subtle`, `standard`, `punchy`
- Avertissement si plus de la moitié des scènes sont `punchy`. Quand tout est mis en
  avant, rien ne l'est : c'est l'équivalent, à l'échelle de la vidéo, de la règle
  `primary` / `secondary` des templates (T8).

**Effet**

- Au plus un effet par scène
- `type` ∈ clés de `effect_map` du Brand Pack **et** `capabilities.effects` du
  template
- `confetti` réservé aux scènes dont le `purpose` est `offer`, `cta` ou `closing`
- Au plus deux effets dans toute la vidéo. Au-delà, l'effet devient un tic.

## M8 — Transitions

- `len(transitions) == len(scenes) - 1`
- `transitions[i].from_scene == scenes[i].scene_id` et
  `transitions[i].to_scene == scenes[i+1].scene_id`
- `type` ∈ clés de `transition_map` du Brand Pack
- Frontière du storyboard marquée `continuity: continue` : `zoom_punch` interdit.
  Une transition de rupture sur une idée qui se prolonge casse le sens.
- Durée de la transition (lue dans le Brand Pack) ≤ 50 % de la durée réelle de
  **chacune** des deux scènes. Même règle que R1 de la composition, vérifiée ici
  parce que les durées sont déjà connues : autant rejeter avant la compilation.
- `direction` : seulement pour `slide` et `zoom_punch`. À défaut, direction par
  défaut du Brand Pack.

## M9 — Emphases calées sur un mot

- `beat_id` existe dans le template choisi, en mode `on_word`
- Au plus un `word_ref` par beat
- `word_ref` existe dans l'alignement **et** appartient au segment de voix off de
  cette scène
- Sans voix off : `word_sync` est vide, les beats `on_word` retombent sur leur
  `fallback` (T8)
- Avertissement si le mot est un mot-outil (article, préposition, conjonction,
  détecté par liste). Une emphase sur « le » tombe à côté du sens.

## M10 — B-roll

- `asset_ref` existe déjà sur R2 : dans les assets du storyboard, ou dans
  `products` et `backgrounds` du Brand Pack du client
- L'asset appartient au client du plan (D30). Jamais un asset d'un autre client,
  jamais un asset généré pour un autre projet.
- `slot_id` existe dans le template choisi, est un slot `media` libre (non occupé
  par un asset du storyboard), et accepte le rôle `supporting` ou `background`
- Le `kind` de l'asset figure dans les `kinds` acceptés par les exigences du
  template

C'est la règle qui garantit la propriété « zéro dépense » : un B-roll manquant ne
se génère pas, il s'absente, et la dégradation du template (T9) s'applique.

## M11 — Sons sémantiques

- `asset_ref` existe dans la **section sémantique** de la bibliothèque audio
  partagée, avec provenance et licence (R16)
- Au plus 2 sons sémantiques par scène, et au plus 4 dans toute la vidéo. Au-delà,
  le sound design devient du bruit.
- Ancre valide :
  - `word` : le mot existe dans le segment de voix off de la scène ;
  - `beat` : le beat existe dans le template choisi ;
  - `scene_start` : aucune référence.
- Avertissement si un son sémantique tombe au même instant qu'un son structurel
  (B13) : deux sons superposés se masquent

## M12 — Musique

- Storyboard `music.enabled == false` : `mode: none` obligatoire
- Storyboard `music.enabled == true` : `mode: track` obligatoire, avec :
  - `mood` ∈ `allowed_moods` du Brand Pack ;
  - `asset_ref` tagué avec cette ambiance dans la bibliothèque ;
  - piste assez longue pour la durée réelle de la vidéo, ou taguée « bouclable » ;
  - **non livrée à un autre client** sur la période configurée (D32)

La non-réutilisation est vérifiée ici, en base, puis revérifiée par R15 de la
composition juste avant le rendu. Deux projets de clients différents peuvent être
en cours en même temps : la seconde vérification attrape la course.

## M13 — Révisions

**`review_rework`** (Franco a refusé l'aperçu) :

- `revision.parent_version` existe et `revision.reviewer_feedback` est présent
- `montage_plan_version == parent_version + 1`
- Même `storyboard_hash` et même `voiceover_alignment_hash` que le parent : un
  refus de Franco ne modifie ni le texte validé par le client, ni la voix off
- Au moins une décision diffère du parent (hors `why`). Un plan identique produirait
  la même vidéo : rejet.
- Au plus **deux** reprises par projet. À la troisième, le problème n'est pas le
  montage : alerte à Franco, qui décide.

**`correction`** (erreur factuelle, D26) :

- Pour chaque scène dont le `content_hash` du storyboard est inchangé : décisions
  **recopiées à l'identique** du plan parent, sans appel au Monteur
- Pour chaque scène modifiée : le code rejoue d'abord les décisions du parent
  contre le nouveau menu. Si elles passent, elles sont conservées sans appel au
  Monteur. Sinon seulement, le Monteur est appelé **pour ces scènes-là**.

Une correction factuelle change un prix ou un nom. Elle ne doit pas changer le
montage que le client a déjà vu et accepté.

## M14 — Zéro dépense

- Aucun champ de génération n'existe dans le schéma, et aucun `asset_ref` du plan
  ne peut désigner un asset absent de R2 au moment de la validation
- Le plafond de coût (D35) n'est donc jamais décrémenté par le plan. Seuls les
  appels au Monteur lui-même sont comptés, au titre du coût LLM du projet.

## M15 — Isolation

Règle issue de D30, exécutée en premier.

- `client_id` du plan = `client_id` du projet, du storyboard et du Brand Pack
- Chaque `asset_ref` appartient au client ou à une ressource partagée déclarée
  (bibliothèque audio, assets de démonstration exclus)
- Le journal de l'appel au Monteur ne contient aucun contenu d'un autre client

Échec : blocage et alerte Franco, sans correction automatique.

---

## Ordre d'exécution

```
M15 isolation                    bloque et alerte, sans correction
M1  correspondance des entrées
M2  unicité des décisions
M3  appartenance au menu         la vérification centrale
M4  template
M5  caméra                       ─┐
M6  profondeur                    │ rejouées par sécurité,
M7  intensité et effets           │ déjà garanties par le menu
M8  transitions                   │
M9  emphases sur un mot           │
M10 B-roll                        │
M11 sons sémantiques              │
M12 musique                      ─┘
M13 cohérence de révision        si reprise ou correction
M14 zéro dépense
M2  calcul du plan_hash          en dernier
```

## Ce que le validateur ne fait pas

Il ne juge pas si le montage est bon. Il garantit que chaque décision est
**réalisable** avec cette marque, ces templates, ces assets et cette voix off, et
qu'aucune ne coûte une génération.

Le jugement revient à Franco (D22), sur l'aperçu. Quand il refuse, les `why` du
plan lui montrent ce que le Monteur a voulu faire, et son motif de refus devient
l'entrée de la reprise (M13). Les paires plan refusé / motif / plan accepté sont
les données qui permettront un jour de calibrer un juge automatique.

## Ce qui reste à affiner

À trancher pendant T0b et T3, sur de vrais montages :

- La table du flou : quelles formulations reviennent réellement dans les refus de
  Franco et les demandes des clients, et vers quelles décisions elles pointent.
- Les plafonds (2 effets, 4 sons sémantiques, 2 B-roll par scène) sont des
  hypothèses de goût. Ils se règlent à l'écoute et au visionnage.
- Faut-il laisser le Monteur choisir l'intensité **par scène**, ou seulement un
  profil d'intensité pour toute la vidéo (montée, plateau, pic final) ? Le second
  est plus simple à valider et produit souvent un meilleur rythme.