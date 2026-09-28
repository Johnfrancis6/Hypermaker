# Règles de validation du storyboard

> Version réécrite le 26 septembre 2026, alignée sur le registre des décisions D1–D36.
> Les noms de champs sont indicatifs et doivent être alignés sur
> `storyboard.schema.json` réécrit.

Le schéma JSON attrape la forme. Ces règles attrapent le reste. Elles s'exécutent
dans un validateur déterministe (pas un LLM), **entre la sortie de l'agent
Storyboard et la présentation du storyboard au client** (D24).

```
Storyboard (LLM) → storyboard.json → CE VALIDATEUR → résumé client (code)
  → STORYBOARD_PENDING_CLIENT → validé par le client → génération → Monteur
```

Un storyboard qui échoue ici n'est **jamais montré au client**. C'est le point
important du nouveau circuit : la validation du client déclenche la dépense. Ce
qu'on lui présente doit donc déjà être réalisable, dans le budget, avec ses assets.

Chaque échec est bloquant. L'agent Storyboard reçoit l'erreur et corrige, une fois.
Au second échec, le projet passe en alerte pour Franco.

## Ce que le storyboard contient désormais

La séparation des couches a changé avec D21. Le storyboard porte l'**intention** :
texte à l'écran, script de voix off, ordre des scènes, rôle de chaque scène, durées
**cibles**, assets à montrer. Il ne contient plus aucun choix de montage : ni
mouvement de caméra, ni transition, ni profondeur, ni effet, ni musique. Ces choix
appartiennent au Monteur, dans le vocabulaire fermé du `montage_plan`.

Conséquence : les anciennes règles R4 (préconditions de capacité : `orbit`,
`push_in`, `celebration`) et R5 (profondeur `layered`) quittent ce fichier. Elles
deviennent des règles de `montage_plan.rules.md`, là où ces décisions sont prises.

---

## S1 — Isolation entre clients

Règle issue de D30. Elle passe en premier.

- Le `client_id` du storyboard est celui du projet
- Chaque `asset_ref` appartient à ce client, ou à une ressource partagée déclarée
- Le Brand Pack référencé appartient à ce client
- Le contexte fourni à l'agent Storyboard ne contenait aucun asset ni exemple d'un
  autre client : vérifié sur le journal de l'appel LLM, pas sur la sortie

Échec : blocage et alerte Franco, sans correction automatique. C'est une fuite,
pas une erreur de rédaction.

## S2 — Type de job et périmètre

- Le storyboard n'existe que pour un job de type `video`. Un visuel statique ou une
  retouche photo (D28) ne passe jamais par ici.
- `delivery.format` vaut `9:16` (D12)
- `delivery.platforms` ⊆ {`tiktok_shop`, `facebook_ads`, `whatsapp_status`}
- Nombre de scènes : 1 à 8, plafond de la composition

## S3 — Résolution des assets

Pour chaque `asset_slot` :

| source | exigence | échec |
|---|---|---|
| `client` | `asset_ref` présent **et** existant sur R2, sous le préfixe du client | rejet |
| `brand_pack` | `asset_ref` présent **et** existant dans le Brand Pack à la version référencée | rejet |
| `generated` | `generation_brief` présent | rejet |

`asset_ref` et `generation_brief` sont mutuellement exclusifs.

Rejet si le Brand Pack référencé n'existe pas, ou si sa version dépasse la dernière
version validée par Franco.

Un asset client reçu en **photo** WhatsApp (recompressé en JPEG) et utilisé comme
logo : avertissement, avec demande de renvoi en document intégrée au résumé client.

## S4 — Voix off

La voix off est choisie par le client (D19) et devient l'horloge du montage (D20).

- `voiceover.enabled` est explicite, `true` ou `false`
- Si activée :
  - `voiceover.voice_id` existe dans le catalogue de voix
  - la langue du script est prise en charge par cette voix
  - chaque scène parlée porte un `voiceover.script` non vide
  - le script ne contient **ni chiffre, ni symbole, ni abréviation** (`%`, `€`,
    `FCFA`, `n°`, `km`…) : tout est écrit sous sa forme parlée
    (« quinze mille francs CFA »)

Le dernier point est une règle de qualité, pas de style. Un modèle de synthèse
vocale lit mal les nombres et les symboles, de façon différente d'une langue à
l'autre et d'un modèle à l'autre. L'erreur ne se voit qu'à l'écoute, donc au
moment de la validation par Franco, après la dépense de génération.

- Si désactivée : au moins une scène porte du texte à l'écran, sinon la vidéo ne
  transmet rien. Avertissement si aucune musique n'est demandée non plus.

## S5 — Durées cibles

Les durées du storyboard sont des **cibles** (D20). La durée réelle de chaque scène
sera dérivée de la voix off générée. Le validateur estime donc la durée probable,
pour éviter de présenter au client une vidéo impossible à tenir en 30 s.

**Avec voix off :**

```
durée_voix_estimée_s = nb_mots(script) / 2,3
durée_scène_estimée  = max(duration_target_s, durée_voix_estimée_s + 0,2)
```

2,3 mots par seconde est volontairement lent pour du français publicitaire. Une
estimation prudente surévalue la durée, ce qui est le bon sens d'erreur : mieux
vaut raccourcir un script avant validation qu'après la génération.

**Sans voix off, pour une scène avec texte :** le plancher de temps de lecture
s'applique, comme dans la version muette.

```
temps_lecture_s = nb_caractères_affichés / 12
durée_min_s     = text_delay + reveal_duration + max(1,2 ; temps_lecture_s)
```

`text_delay` et `reveal_duration` viennent de la signature de mouvement du Brand
Pack. Rejet si `duration_target_s < durée_min_s`.

**Pour la vidéo entière :**

```
durée_totale_estimée = Σ durée_scène_estimée
```

- Rejet si `durée_totale_estimée > 30` : limite commune aux trois plateformes
- Avertissement au-delà de 27 s : la marge est absorbée par les respirations en fin
  de scène
- Écart de plus de 15 % avec `delivery.target_duration_s` : avertissement

## S6 — Texte à l'écran

- `source: "client"` interdit toute reformulation : le contenu correspond au
  verbatim client enregistré
- Toute chaîne contenant un montant, un pourcentage, une notation (`★`, `/5`,
  `4,8`), une durée de garantie ou une mention légale **doit** porter
  `source: "client"`. Détection par motif, rejet sinon.
- **Cohérence voix et écran** : un montant ou un pourcentage présent à l'écran et
  dans le script de voix off désigne la même valeur. Le script est normalisé (forme
  parlée → nombre) avant comparaison. Rejet si les valeurs diffèrent : un prix
  affiché à 15 000 et annoncé à 50 000 est l'erreur factuelle la plus coûteuse
  possible pour une pub.
- `headline` ≤ 60 caractères recommandé en 9:16. Au-delà : avertissement.
- Avec voix off, texte à l'écran ≤ 40 caractères par scène recommandé. Le
  spectateur écoute et lit en même temps : un long texte à l'écran concurrence la
  voix au lieu de la souligner. Avertissement.

## S7 — Intégrité des frontières

- `len(boundaries) == len(scenes) - 1`
- `boundaries[i].from_scene == scenes[i].scene_id` et
  `boundaries[i].to_scene == scenes[i+1].scene_id`
- Tous les `scene_id` sont uniques
- Une seule scène : `boundaries` est un tableau vide, pas absent

Une frontière ne porte plus de type de transition, seulement une intention de
rythme éventuelle (`continuity` : `continue`, `break`). Le type de transition est
une décision du Monteur.

## S8 — Plafond de coût projeté

Calculé **avant** la présentation au client, puisque sa validation déclenche la
dépense.

```
coût_projeté = Σ coût(generation_brief) + coût(voix off sur GPU)
```

- Comparé au plafond du type de job `video` (D35). Dépassement : rejet, avec
  notification. Jamais de dégradation silencieuse (moins de scènes, modèle moins
  cher) sans que Franco l'ait décidé.
- Le plafond doit couvrir la génération initiale **plus** une correction factuelle
  (D26) portant sur une scène. Sinon, une seule correction le fait sauter.

Les autres allers-retours ne coûtent pas de génération : une correction du
storyboard par le client se fait avant toute dépense, et un refus de Franco
renvoie au montage sans regénération.

## S9 — Hash de contenu

Calculé par le validateur, jamais écrit par le LLM.

```
content_hash = sha256(json_canonique(scene sans content_hash))
```

JSON canonique : clés triées, pas d'espaces, UTF-8, flottants normalisés
(`4.0` → `4`). Le hash couvre le script de voix off et le `voice_id` : changer un
mot du script impose de regénérer la voix off de cette scène.

Le hash ne couvre **pas** le Brand Pack. Un changement de charte invalide toutes
les scènes, ce qui est le comportement voulu, et se gère par la version du Brand
Pack.

Usage : une scène dont le `content_hash` est inchangé par rapport à la version
parente n'est ni régénérée, ni re-rendue, et sa voix off est réutilisée.

## S10 — Cohérence de révision

Deux sortes de révision existent désormais.

**Correction par le client avant génération** (`revision.reason = "client_feedback"`,
depuis `STORYBOARD_PENDING_CLIENT`) :

- `storyboard_version == revision.parent_version + 1`
- Le storyboard parent existe en base et n'a **pas** été validé par le client
- Au moins un `content_hash` diffère du parent, sinon la révision est vide et rejetée
- Aucun coût : aucune génération n'a encore eu lieu

**Correction factuelle après livraison** (`revision.reason = "correction"`, D26) :

- Le projet est à l'état `DELIVERED` depuis 7 jours au plus
- Le parent est le storyboard validé par le client
- La correction ne touche **que** des champs factuels : texte à l'écran, script de
  voix off, `asset_ref` d'un asset client ou Brand Pack
- Le nombre de scènes, leur ordre, leur `purpose` et les `generation_brief` sont
  identiques au parent

Si une de ces conditions structurelles tombe, ce n'est plus une correction mais une
question de goût, donc un **nouveau projet**. Cette règle est ce qui rend D26
applicable par le code plutôt que par la négociation.

## S11 — Présentation au client et engagement

C'est la règle qui rend la validation du client (D24) opposable.

- Le résumé envoyé au client est **généré par du code** à partir du storyboard
  (gabarit fixe), jamais par un LLM. Ce que le client valide est exactement ce qui
  sera produit.
- Le résumé tient dans un message WhatsApp : 4 096 caractères au plus, dans la
  langue du client, sans identifiant interne ni vocabulaire technique
- Il mentionne : la durée estimée, la voix choisie, le texte à l'écran et le script
  de chaque scène, les assets utilisés, et les assets manquants à envoyer
- La validation du client est enregistrée en base avec le **hash du storyboard
  complet** et l'horodatage
- Le Monteur n'accepte qu'un storyboard dont le hash correspond à une validation
  client enregistrée

Sans ce dernier point, un storyboard modifié après validation (par un bug, une
reprise, une révision mal chaînée) partirait en génération sans accord du client.

---

## Ordre d'exécution

```
S1  isolation                    bloque et alerte, sans correction
S2  type de job et périmètre
S3  résolution des assets
S4  voix off
S6  texte à l'écran
S7  frontières
S5  durées estimées
S8  plafond de coût projeté
S9  hash de contenu
S10 cohérence de révision        si révision
S11 résumé client                après toutes les autres
```

S3 et S8 sont les deux règles qui évitent de promettre au client ce qu'on ne peut
pas produire : une vidéo sans ses assets, ou une vidéo hors budget.

## Ce que le validateur ne fait pas

Il ne juge pas la qualité narrative, l'esthétique ou la pertinence marketing.

Deux personnes en décident, à deux moments différents : le **client**, qui valide
l'intention avant la génération (D24), et **Franco**, qui valide le résultat avant
la livraison (D22), contre les `must_show` déclarés ici et repris dans
`qa.checklist` de la composition.

Un storyboard valide n'est pas un bon storyboard. C'est un storyboard qu'on peut
montrer au client sans risque de promettre l'impossible.