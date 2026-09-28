# Règles du template — v1

> Version réécrite le 26 septembre 2026, alignée sur le registre des décisions D1–D36.
> Les noms de champs sont indicatifs et doivent être alignés sur
> `template.schema.json` réécrit.

**Statut : avant-première.** T1–T6 et T11–T13 sont structurelles et devraient
survivre. T7–T10 encodent des hypothèses sur ce qui rend un rendu professionnel :
ce sont elles que le premier template réel (T0) corrigera.

## Ce qui a changé depuis la v0

- **Format d'authoring (D34)** : un template est un fichier HTML à emplacements
  déclarés (attributs `data-*`), accompagné d'un manifeste JSON. Le compilateur
  remplit les emplacements. D'où la nouvelle règle T11.
- **Sélection (D21)** : le Monteur, un LLM, choisit le template d'une scène. Le code
  ne choisit plus : il calcule l'**ensemble des templates éligibles**, et le Monteur
  choisit dans cet ensemble fermé. T6 est réécrite.
- **Durées (D20)** : la durée d'une scène est dérivée de la voix off, et elle est
  **connue** au moment où le Monteur choisit. L'éligibilité se calcule sur la durée
  réelle, plus sur une cible.
- **Zone de sécurité** : unique pour les trois plateformes (14 % haut, 35 % bas,
  6 % gauche, 10 % droite). Elle ne vient plus du Brand Pack. T4 est réécrite.
- **Audio (D19)** : un template déclare ses points d'accroche sonores, sans jamais
  contenir de son. Nouvelle règle T12.
- **Production du catalogue** : un LLM rédige les templates, Franco valide avant
  publication, et chaque template publié produit automatiquement son extrait de
  démonstration. Nouvelle règle T13.
- Le `reveal` n'est plus déclaré par le storyboard : c'est une décision du Monteur.
  T8 est ajustée.

Trois moments :

- **T1–T5, T11–T13 : à la publication.** Un template passe de `draft` à `published`.
- **T6–T7 : à la sélection.** Le code calcule les templates éligibles, le Monteur
  en choisit un.
- **T8–T10 : à la compilation.** Le template devient une composition.

---

## T1 — Immuabilité et statut

Cycle de vie : `draft` → `pending_review` → `published` → `deprecated`.

Un template `published` ne se modifie jamais : une composition le référence par
`template_version`, et une scène inchangée doit se recompiler à l'identique des mois
plus tard, par exemple lors d'une correction factuelle (D26). Toute évolution
incrémente la version. La version couvre le manifeste **et** le fichier HTML : le
hash des deux est enregistré à la publication.

Changement **mineur** : ajout d'un slot optionnel, d'une règle de dégradation,
élargissement des bornes de durée. Changement **majeur** : retrait ou déplacement
d'un slot, modification de la chorégraphie, changement de `focal_slot`, modification
des points d'accroche sonores.

`deprecated` reste compilable pour les compositions existantes, mais sort de
l'ensemble éligible.

## T2 — Intégrité des slots

- `slot_id` unique
- `focal_slot` existe et est de `kind` media ou logo. Un slot texte n'est jamais
  focal, parce qu'il ne porte pas le mouvement de caméra.
- `focal_slot.required == true`
- Chaque `slot_id` du `layer_stack` existe, et réciproquement : tout slot est placé
  en profondeur
- `z_index` unique dans le stack
- `kind: "text"` impose `copy_field` ; `kind: "media"` ou `"logo"` impose
  `accepts_roles`
- Au plus un slot par `copy_field` et par template
- Plafonds de la composition respectés : 6 slots media ou logo au plus, 4 slots
  texte au plus, 2 effets au plus. Un template qui les dépasse produit une
  composition invalide à chaque utilisation.

## T3 — Cohérence de la pile de profondeur

L'ordre de `parallax_tier` suit l'ordre de `z_index` :
`far < mid < subject < overlay`. Une couche déclarée `far` mais posée au-dessus du
sujet produit une parallaxe inversée : le fond avance plus vite que le premier plan,
défaut immédiatement perceptible et difficile à diagnostiquer après coup.

Tout slot `kind: "logo"` est en tier `overlay`. Un logo ne passe jamais derrière un
produit, quel que soit le contenu.

## T4 — Zone de sécurité

La zone de sécurité est une constante du système, la même que dans la composition :

| Bord | Marge | En 1080×1920 |
|---|---|---|
| Haut | 14 % | 269 px |
| Bas | 35 % | 672 px |
| Gauche | 6 % | 65 px |
| Droite | 10 % | 108 px |

- `safe_area_exempt` interdit sur tout slot `text` ou `logo`, et sur tout slot dont
  le `copy_field` est un appel à l'action : rejet à la publication
- Toute boîte de slot texte, logo ou appel à l'action est **entièrement contenue**
  dans la zone utile (environ 907×979 px)
- À `max_camera_scale`, aucun de ces slots ne sort de la zone

Ces trois points sont calculables exactement à la publication, depuis les boîtes et
le plafond de zoom. Les vérifier ici évite de les découvrir scène par scène en
production, dans R5 de la composition.

Conséquence de conception : le bas de l'écran (35 %) n'accueille que des éléments
décoratifs ou des médias. Un template qui place son appel à l'action en bas est
rejeté, alors que c'est le réflexe naturel en 9:16.

## T5 — Bornes de durée et budget de mouvement

- `min_s <= recommended_s <= max_s`, avec `max_s <= 12` (plafond d'une scène)
- La chorégraphie complète tient dans `min_s` en laissant au moins `settle_ratio`
  de repos :

```
fin_dernier_beat <= min_s × (1 − settle_ratio)
```

- Nombre de beats `enter` simultanés ≤ `motion_budget.max_concurrent`, vérifié sur
  toute la fenêtre de simulation

Rejet si la chorégraphie ne tient pas. Un template dont l'entrée déborde de sa durée
minimale sera systématiquement tronqué sur les scènes courtes.

Avec la voix off, `min_s` prend un sens concret : c'est le plus court segment parlé
que ce template peut accueillir. Un template à `min_s` élevé n'est éligible que
pour les scènes à script long.

## T6 — Éligibilité, puis choix du Monteur

Le code calcule l'ensemble éligible **après** la génération de la voix off, quand
les durées réelles sont connues :

```
éligibles(scène) = templates published où
    purpose ∈ purpose_affinity
  ∧ assets disponibles satisfont requirements.assets      (T7)
  ∧ min_s <= durée_réelle_s <= max_s
  ∧ longueur du texte ≤ requirements.copy.max_chars
```

Le Monteur reçoit cette liste, et **seulement** elle, dans son prompt. Il choisit un
`template_id` par scène dans le `montage_plan`. Le validateur du plan rejette tout
choix hors de l'ensemble éligible.

Les capacités du template (`capabilities.camera`, `capabilities.depth`) bornent
ensuite les autres décisions du Monteur pour cette scène : un preset de caméra
absent des capacités du template choisi est rejeté par les règles du `montage_plan`.

**Ensemble éligible vide** : échec de compilation qui nomme la contrainte non
satisfaite, jamais un repli sur un template approximatif. Le cas le plus probable
est une scène dont la voix off dépasse tous les `max_s` : c'est ce que S5 du
storyboard doit empêcher en amont, par son estimation de durée.

**Un seul template éligible** : le code l'impose sans appeler le Monteur pour ce
choix. Inutile de payer un LLM pour une décision déjà prise.

## T7 — Préconditions d'assets

Pour chaque slot media :

```
résolution_source >= box × min_source_scale × max_camera_scale
```

En dessous : `degradation` s'applique, ou le template sort de l'ensemble éligible.
Le mouvement révèle les pixels bien avant que l'œil ne s'en plaigne sur une image
fixe, d'où le facteur cumulé.

L'ordre du pipeline a changé : les assets **générés** existent déjà quand le
Monteur choisit. Leur résolution de génération est donc fixée à l'avance, par
configuration, au niveau du template le plus exigeant pour chaque `purpose`. Ce
sont les assets **client** qui déclenchent réellement cette règle.

`requires_alpha` non satisfait sur un slot logo → le template sort de l'ensemble
éligible. Un logo sur fond opaque posé en overlay produit un rectangle blanc au
milieu de la scène, typiquement le défaut qu'un client relève en premier.

## T8 — Résolution de la chorégraphie

Les beats se résolvent en millisecondes absolues à la compilation :

```
mode = scene_ratio  → t = scene_ratio × duration_ms
mode = after_beat   → t = t(beat référencé) + stagger_steps × stagger_ms
mode = on_word      → t = start_ms du mot désigné dans l'alignement de la voix off
```

`on_word` est nouveau (D20). Il permet à une emphase visuelle de tomber sur le mot
prononcé. Le template déclare qu'un beat **peut** être calé sur un mot ; le Monteur
choisit **lequel** (`sync.word_ref` dans la composition). Sans voix off, un beat
`on_word` retombe sur son `fallback_mode` déclaré, qui est obligatoire.

`stagger_ms` vient du Brand Pack : **la structure du décalage appartient au template,
son amplitude à la marque**. C'est cette séparation qui permet au même template de
paraître nerveux chez un client et posé chez un autre.

Résolution de `reveal_binding` :

- `primary` → l'intensité d'apparition choisie par le Monteur pour la scène
  (`subtle`, `standard` ou `punchy`, vocabulaire fermé du `montage_plan`)
- `secondary` → rabaissé d'un cran (`punchy` → `standard`, `standard` → `subtle`,
  `subtle` inchangé)

C'est le garde-fou contre l'erreur la plus courante du motion amateur : trois
éléments qui entrent tous avec la même intensité maximale. Le Monteur choisit
l'intensité d'une scène, jamais celle de chaque élément.

Rejet si un cycle existe dans les références `after_beat_id`.

## T9 — Application de la dégradation

Évaluée dans l'ordre de déclaration, une seule passe, sans récursion : une action de
dégradation ne peut pas en déclencher une autre. Les cascades produisent des mises
en page imprévisibles, ce qui est exactement ce qu'on cherche à éviter.

| Action | Effet |
|---|---|
| `collapse` | Slot retiré, beats et points d'accroche sonores associés supprimés, chorégraphie resserrée |
| `substitute` | `target_slot_id` fournit l'asset |
| `expand_sibling` | `target_slot_id` absorbe la boîte libérée, ancrage conservé |
| `solid_fill` | Surface pleine depuis `fallback_token` du Brand Pack |
| `reject` | Échec explicite |

Après dégradation, **T2, T4, T5 et T12 sont réévaluées**. Un `collapse` qui vide le
`focal_slot` est un échec, pas une dégradation : une scène sans élément dominant n'a
plus de sujet.

Toute dégradation appliquée est journalisée sur la scène **et** signalée dans le
message de validation envoyé à Franco avec l'aperçu. C'est la première chose à
regarder quand un rendu déçoit sans être techniquement faux.

## T10 — Remontée des contraintes vers le Storyboard

Le Storyboard écrit avant que le Monteur ne choisisse les templates. Les contraintes
des templates doivent donc lui parvenir **dans son prompt**, pas seulement être
vérifiées après coup.

Pour chaque `purpose`, le code calcule à partir des templates publiés :

- `max_chars` : le plus grand `requirements.copy.max_chars` parmi les templates de
  ce `purpose`. Au-delà, aucun template ne peut accueillir le texte.
- `max_words_voiceover` : `(max_s − tail_s) × 2,3`, sur le plus grand `max_s` des
  templates de ce `purpose`. Même coefficient que S5 du storyboard.
- Le catalogue d'assets transmis, filtré par les `requirements` des templates de ce
  `purpose`. Le Storyboard ne peut alors pas demander ce qui n'existe pas.

Un texte trop long corrigé par shrink-to-fit reste un texte trop long : il tient
dans la boîte et ne se lit pas. Le corriger en amont coûte un prompt. Le corriger en
aval coûte un storyboard à refaire **après** la validation du client, ce qui n'est
plus possible sans le recontacter.

## T11 — Correspondance entre manifeste et HTML

Règle issue de D34 (templates HTML à emplacements déclarés). Vérifiée à la
publication, par analyse statique du HTML et du CSS.

- Chaque slot du manifeste correspond à exactement un élément
  `data-slot="<slot_id>"` dans le HTML, et réciproquement
- Chaque beat du manifeste cible un élément qui existe
- **Aucune valeur de marque en dur** : pas de couleur hex, `rgb()` ni nom de
  couleur, pas de `font-family` littéral. Tout passe par des variables CSS
  (`var(--brand-…)`) résolues par le compilateur depuis le Brand Pack.
- **Familles de police sous un nom privé** : un template ne nomme jamais une
  famille publique (`Inter`, `Montserrat`…). Il nomme une famille privée
  (`HM-Demo-Sans`, puis `HM-{client}-{rôle}` en production), déclarée par un
  `@font-face` explicite généré depuis `composition.fonts[]`. Le moteur ne peut
  alors compléter la famille ni depuis son propre paquet de polices, ni depuis
  Google Fonts. `document.fonts.check()` vrai signifie donc « notre fichier s'est
  chargé », et un `@font-face` oublié produit un échec franc au lieu d'un repli
  silencieux vers une homonyme publique.
- **Aucune durée en dur** dans une animation ou une transition CSS : les durées
  viennent de la chorégraphie résolue (T8)
- **Aucune ressource distante** : pas d'URL `http(s)` dans le HTML, le CSS ou le
  script
- **Aucune source de non-déterminisme** : pas de `Math.random`, `Date.now`,
  `performance.now` ni `requestAnimationFrame` piloté par l'horloge murale.
  Toute animation est fonction du temps de composition.
- Aucun texte visible en dur : tout texte vient d'un slot

Ces règles traduisent R11 (déterminisme) et la séparation des couches au niveau du
fichier source. Une couleur en dur dans un template, c'est une marque qui s'affiche
chez tous les clients.

## T12 — Points d'accroche sonores

Un template ne contient **aucun son**. Il déclare où un son structurel peut tomber.

- Chaque point d'accroche référence un beat ou une frontière de scène existants
- Il porte un type d'événement dans une liste fermée : `text_in`, `media_in`,
  `logo_in`, `emphasis`, `scene_out`
- Le son réel est résolu à la compilation depuis le jeu de sons du Brand Pack pour
  ce type d'événement (R14 de la composition, effets `structural`)
- Au plus 1 point d'accroche par beat, et au plus 4 par template : au-delà, le
  sound design devient du bruit
- Le template déclare `voice_tail_ms`, la respiration minimale après le dernier mot
  de la scène (repris dans `audio.voiceover.tail_ms` de la composition)

Les effets **sémantiques** (verre brisé, vent) ne passent jamais par le template :
ce sont des décisions du Monteur.

## T13 — Publication, isolation et démonstration

Un template est rédigé par un LLM ou par Franco, puis validé par Franco dans la file
de validation (D15) avant publication.

- Passage à `published` uniquement après une approbation enregistrée par la
  commande admin correspondante (D29), avec entrée dans le journal d'audit
- **Isolation (D30)** : un template est une ressource partagée entre tous les
  clients. Il ne contient ni asset, ni nom, ni texte, ni couleur d'un client, même
  quand il a été créé à la suite de la demande d'un client précis.
- **Démonstration** : chaque template porte un `demo_fixture`, un jeu de contenu
  neutre (textes et assets de démonstration, Brand Pack de démonstration). À la
  publication, le système compile et rend ce fixture, passe **toutes** les règles
  de la composition (R1–R17), et produit l'extrait de démonstration de 5 s du
  catalogue client.

Un template dont le fixture ne passe pas la composition n'est pas publiable. C'est
le seul test qui vérifie le template de bout en bout avant qu'un client ne le
rencontre, et il produit en même temps ce que le clarificateur montre au client.

---

## Ce qu'un template ne contient pas

Ni couleur, ni police, ni durée de transition, ni amplitude de mouvement, ni son :
cela vient du Brand Pack. Ni durée de scène, ni texte, ni script de voix off, ni
choix d'asset : cela vient du storyboard et de la voix off. Ni caméra choisie, ni
transition, ni intensité, ni effet sonore sémantique, ni musique : cela vient du
Monteur. Ni paramètre d'encodage, ni zone de sécurité : ce sont des constantes du
système.

Un template est une **structure** et un **rythme**. Rien d'autre. C'est cette
discipline qui fait qu'un template sert toutes les marques, et qui rend une
bibliothèque rentable au lieu d'être une collection de cas particuliers.

## Ce qui reste à affiner

`choreography` reste le bloc le plus spéculatif : le modèle beats + budget de
mouvement + settle est une hypothèse raisonnable, mais il n'a pas encore rencontré
un rendu réel. Questions à trancher sur le premier template (T0 et T0b) :

- `stagger_steps` suffit-il, ou faut-il un décalage par élément d'une liste (puces,
  étoiles, cartes) ?
- `exit_policy` à `hold` tient-il avant une transition marquée choisie par le
  Monteur, ou faut-il un beat de sortie explicite avant un `zoom_punch` ?
- `on_word` : l'alignement mot à mot est-il assez précis pour caler une emphase à
  la frame près, ou faut-il une tolérance plus large que ±1 frame ?
- Quatre points d'accroche sonores par template : trop, ou pas assez pour une pub
  de 15 s au rythme TikTok ?

Construis le premier template à la main dans HyperFrames, regarde-le tourner,
écoute-le avec la voix off, **puis** reviens amender ce fichier. Une abstraction
écrite avant son premier cas concret ne colle jamais.