# Règles de validation de la composition

> Version réécrite le 26 septembre 2026, alignée sur le registre des décisions D1–D36.
> Les noms de champs reprennent ceux de la version de référence. Ils sont indicatifs
> et doivent être alignés sur `composition.schema.json` réécrit.

Ces règles s'exécutent dans un validateur déterministe, **entre la sortie du
compilateur et le lancement du rendu** (D21). Aucune n'appelle de LLM.

Rappel de la chaîne :

```
Monteur (LLM) → montage_plan.json → validateur du plan (vocabulaire fermé)
compilateur   → composition.json  → CE VALIDATEUR → rendu
```

Le compilateur est déterministe. Une règle qui échoue ici signale donc soit un
défaut du compilateur, soit une décision du plan impossible à résoudre avec les
assets du client. R3 permet de distinguer les deux.

Les règles se répartissent en trois familles, et l'ordre compte :

- **Pré-rendu, document seul** (R1–R4, R6, R13–R17) : coût nul.
- **Pré-rendu, page chargée** (R5, R7, R8) : DOM dans Chrome headless, avant la
  première frame capturée. Coût nul.
- **Post-rendu** (R9–R10) : sur les fichiers produits.

R11 et R12 sont transverses.

Toute règle pré-rendu qui échoue bloque **avant** dépense de rendu. Ne jamais
reporter une vérification pré-rendu en post-rendu pour « aller plus vite » : c'est
l'inversion qui coûte cher.

---

## R1 — Continuité de la timeline

- `canvas.width == 1080`, `canvas.height == 1920` (D12 : 9:16 uniquement)
- `canvas.fps` fixe, entier
- `scenes[0].start_ms == 0`
- Pour tout i : `scenes[i+1].start_ms == scenes[i].start_ms + scenes[i].duration_ms`
- `canvas.duration_ms == Σ scenes[].duration_ms`
- `canvas.duration_ms` est un multiple exact de `1000 / fps` (tolérance ±1 ms)
- `canvas.duration_ms <= 30 000` : durée maximale qui passe sur les trois
  plateformes cibles

Les transitions **ne créent pas de durée**. Une transition entre `sc_01` et `sc_02`
vérifie :

```
transition.start_ms + transition.duration_ms <= scenes[i+1].start_ms + transition.duration_ms
transition.start_ms >= scenes[i].start_ms + (scenes[i].duration_ms / 2)
```

Autrement dit : elle chevauche la fin de la scène sortante et le début de la
suivante. Un `type: "cut"` impose `duration_ms == 0`.

Rejet si une transition dépasse 50 % de la durée de l'une des deux scènes qu'elle
relie : au-delà, la scène n'a plus de temps de lecture propre.

## R2 — Budget d'encodage

La livraison est double (D23). Chaque sortie a son propre budget.

```
bitrate_total_kbps = (max_bytes × 8) / (duration_ms / 1000) / 1000
bitrate_video_max  = bitrate_total_kbps − audio.bitrate_kbps − overhead
```

`overhead` : 3 % du total, pour le conteneur et le moov atom.

| Sortie | `max_bytes` | Audio | Cible vidéo |
|---|---|---|---|
| `preview` (type WhatsApp `video`) | 16 Mo, marge de sécurité incluse | AAC stéréo 128 kbps | au plus `bitrate_video_max` |
| `master` (type WhatsApp `document`) | 100 Mo | AAC stéréo 128 kbps minimum | 16 Mbps par défaut, au plus `bitrate_video_max` |

Pour les deux sorties :

- Rejet si `encode.<sortie>.video.bitrate_kbps > bitrate_video_max`
- `maxrate_kbps` ≤ 1,45 × `bitrate_kbps`, `bufsize_kbps` = 2 × `maxrate_kbps`

Pour `preview` uniquement :

- Rejet si `bitrate_video_max < 800`, avec recommandation explicite de descendre
  en 720×1280 pour l'aperçu seul (le master reste en 1080×1920)
- Avertissement si `bitrate_video_max < 2500` en 1080×1920 : tenable, mais sans
  marge. À 30 s et 16 Mo, le budget total est d'environ 4 200 kbps.

## R3 — Correspondance avec le storyboard et le montage plan

- L'ensemble des `scene_id` est **identique** à celui du storyboard validé par le
  client **et** à celui du `montage_plan`, au même ordre
- Chaque `storyboard_scene_hash` correspond au `content_hash` de la scène source
- `montage_plan_hash` correspond au hash du plan validé
- Chaque élément de la composition issu d'une décision du Monteur porte un
  `plan_decision_ref` qui pointe vers cette décision dans le plan
- Chaque `qa.checklist[].scene_id` référence une scène existante
- Tout `must_show` du storyboard apparaît dans `qa.checklist`

Cette correspondance un-pour-un permet de désigner **quelle** scène a échoué, et,
grâce à `plan_decision_ref`, **si** l'échec vient d'une décision du Monteur ou du
compilateur. Sans elle, tout échec est global et donc inexploitable pour une
réparation ciblée.

## R4 — Résolution des polices

- Chaque `font_ref` utilisé par un `text_element` existe dans `fonts`
- Chaque `fonts[].uri` est présent sur le disque du conteneur, avec une taille > 0
- **Vérification de chargement effectif** : après injection dans la page, contrôler
  via `document.fonts.check()` que la police demandée est bien active

Le dernier point n'est pas redondant. Une police déclarée, présente sur disque et
référencée dans le CSS peut quand même échouer à se charger, et Chrome bascule
alors en fallback **sans erreur**. Le rendu part en production avec la mauvaise
typographie. C'est le mode d'échec le plus discret du pipeline.

## R5 — Zone de sécurité et débordement

La zone de sécurité est **unique** pour les trois plateformes cibles (TikTok Shop,
Facebook Ads, statut WhatsApp). Elle correspond à l'union de leurs contraintes :

| Bord | Marge | En 1080×1920 |
|---|---|---|
| Haut | 14 % | 269 px |
| Bas | 35 % | 672 px |
| Gauche | 6 % | 65 px |
| Droite | 10 % | 108 px |

Zone utile : environ 907×979 px. Elle couvre aussi la carte produit TikTok Shop
et l'interface du statut WhatsApp.

- Les marges déclarées dans `canvas.safe_area` sont **supérieures ou égales** à ces
  valeurs. Un compilateur ne peut pas les réduire.

Sur la page rendue, avant capture, pour chaque `text_element`, chaque couche de
`role` logo et chaque appel à l'action :

- Boîte englobante entièrement contenue dans la zone de sécurité
- `scrollHeight <= clientHeight` et `scrollWidth <= clientWidth`
- Nombre de lignes rendues ≤ `max_lines`
- Si `overflow: "shrink"` : la taille finale après ajustement ≥ `min_font_size_px`

Rejet si le texte ne tient pas au plancher. Livrer un texte tronqué ou illisible
est un échec plus coûteux qu'un rejet : il arrive chez le client.

## R6 — Intégrité des couches

- `z_index` unique à l'intérieur d'une scène. Deux couches au même niveau
  produisent un ordre dépendant de l'implémentation, donc non reproductible.
- Chaque `asset_ref` existe dans la table `assets`
- `kind: "vector"` interdit sur une couche de `role` background (sur-étirement)
- Pour une couche vidéo : `media_start_ms + scene.duration_ms <= asset.duration_ms`,
  sinon la couche gèle sur sa dernière frame en fin de scène

## R7 — Cohérence géométrique du mouvement

Pour toute couche avec `parallax_factor != 1` ou toute scène avec une caméra dont
le `scale` minimal est < 1,0 :

```
surface_couverte >= surface_canvas × (1 + amplitude_déplacement)
```

Rejet si le calcul laisse apparaître un bord vide à un instant quelconque de la
scène. C'est calculable exactement depuis les keyframes : inutile d'attendre le
rendu pour le découvrir.

Rejet également si `camera.keyframes[].scale > 1.0` sur une couche `still` dont la
résolution source est inférieure à `1,5 × scale_max ×` la dimension cible : le zoom
révèle les pixels.

## R8 — Contraste

- `contrast_ratio` de chaque `text_element` est **recalculé** par le validateur,
  jamais lu tel quel. Une valeur déclarée n'est pas une mesure, qu'elle vienne du
  compilateur ou d'un LLM.
- Rejet si `contrast_ratio < qa.min_contrast_ratio`
- Le calcul se fait contre la couleur effective derrière le texte : `background`
  du text_element s'il existe, sinon échantillonnage de la couche sous-jacente
  dans la zone de la boîte, sinon `canvas.background_color`
- Sur une couche image ou vidéo : échantillonner le pire cas sur la durée
  d'affichage du texte, pas la première frame

---

## R13 — Voix off et timeline audio

L'audio est l'horloge du montage (D20). Les durées de scènes sont **dérivées** de
la voix off, pas lues dans le storyboard, qui ne donne que des cibles.

- Si le projet a une voix off : `audio.voiceover.asset_ref` existe, et
  `audio.voiceover.alignment` (horodatage mot à mot) est présent et non vide
- Chaque segment de voix off est rattaché à un `scene_id` existant
- Pour chaque scène : `scene.duration_ms >= segment.end_ms − segment.start_ms + tail_ms`,
  avec `tail_ms` défini par le template (200 ms par défaut). Une voix coupée par
  la transition suivante est un rejet.
- Aucun segment de voix off ne déborde de `canvas.duration_ms`
- Chaque emphase visuelle calée sur un mot (`sync.word_ref`) référence un mot qui
  existe dans l'alignement, et son `start_ms` égale celui du mot ±1 frame
- Écart entre durée dérivée et durée cible du storyboard : avertissement au-delà
  de ±25 %. Ce n'est pas un rejet : le client a validé un texte, pas un
  chronométrage.

## R14 — Effets sonores

- Chaque `sfx[]` référence un asset de la bibliothèque audio
- Chaque effet est rattaché à un événement de la timeline (`event_ref` : une
  transition, l'apparition d'un élément, une emphase) qui existe dans la
  composition
- `sfx.start_ms + sfx.attack_ms` égale le `start_ms` de l'événement ±1 frame.
  C'est l'**attaque** du son qui doit tomber sur l'événement, pas le début de son
  fichier. `attack_ms` est mesuré une fois, à l'import de la bibliothèque (premier
  échantillon à -20 dBFS du pic), et recopié dans la composition par le
  compilateur. Sans lui, un whoosh dont le fichier commence par 90 ms de souffle
  passe la règle et s'entend en retard, tandis qu'un son calé à l'oreille échoue.
  Un son décalé d'un demi-temps se remarque plus qu'une absence de son.
- Les effets **structurels** (transitions, apparitions) proviennent du Brand Pack
  ou du template ; les effets **sémantiques** proviennent d'une décision du plan
  (`plan_decision_ref` obligatoire)
- Pendant un segment de voix off, le gain de chaque effet est ≤ `audio.sfx_gain_under_voice_db`

## R15 — Musique

- `audio.music.asset_ref` référence un asset de la bibliothèque audio
- La musique couvre `canvas.duration_ms` : durée suffisante, ou boucle déclarée
  avec fondu enchaîné
- Fondu de sortie déclaré sur la fin du canvas
- Ducking déclaré sous **chaque** segment de voix off, d'au moins
  `audio.ducking_db` (-12 dB par défaut)
- **Non-réutilisation entre clients** (D32) : la piste n'a pas été livrée à un
  autre `client_id` sur la période configurée. Vérification en base, avant rendu.

## R16 — Licences et provenance

- Chaque asset audio porte `provenance.source`, `provenance.license` et
  `provenance.source_url`
- La licence figure dans la liste des licences autorisées pour un usage
  publicitaire commercial (Pixabay Content License, CC0)
- Chaque asset généré porte `provenance.generation_key` et `provenance.provider`

Sans provenance, une réclamation de droits sur une pub diffusée est indéfendable.

## R17 — Isolation entre clients

Règle issue de D30.

- Chaque asset référencé appartient au `client_id` de la composition, **ou** à une
  ressource partagée déclarée comme telle (bibliothèque audio, templates)
- Aucun asset du préfixe `brand/` d'un autre client
- Le Brand Pack référencé appartient au `client_id` de la composition

Un échec ici est une fuite de données entre clients. Il bloque et alerte Franco,
sans relance automatique.

---

## R9 — Conformité des fichiers produits (ffprobe, bloquant)

À exécuter sur **les deux** fichiers, **avant tout envoi**.

| Contrôle | `preview` (`video`) | `master` (`document`) | Échec |
|---|---|---|---|
| `codec_name` | `h264` | `h264` | rejet |
| `profile` | `Main` | `Main` ou `High` | rejet |
| `has_b_frames` | `0` | libre | rejet (preview) |
| `pix_fmt` | `yuv420p` | `yuv420p` | rejet |
| fréquence d'images | fixe | fixe | rejet |
| piste audio | `aac`, stéréo | `aac`, stéréo, ≥ 128 kbps | rejet |
| `size` | ≤ `encode.preview.max_bytes` | ≤ `encode.master.max_bytes` | ré-encodage à bitrate réduit, une fois |
| `duration` | `canvas.duration_ms` ±100 ms | idem | rejet |
| `moov` en tête | oui | oui | remux faststart |

Le contrôle `has_b_frames` sur l'aperçu reste le plus important du pipeline. Un
échec de compatibilité WhatsApp est **totalement silencieux** : l'API accepte
l'upload, ne renvoie aucun code d'erreur, et le client Android échoue simplement à
lire la vidéo. Sans ce contrôle, tu l'apprends par le client.

Le master part en `document` : WhatsApp ne le transcode pas et ne le lit pas en
ligne, d'où la tolérance sur le profil et les B-frames. Il reste en H.264 et AAC,
exigés par les plateformes publicitaires.

**Débit audio du master : déclaré ou mesuré.** « ≥ 128 kbps » porte sur le débit
d'encodage déclaré, `encode.master.audio.bitrate_kbps`, toujours. Le débit
**mesuré** ne s'applique que si `audio.silent_fallback` est faux. Une piste
silencieuse encodée à 128 kbps mesure environ 2 kbps (mesuré en T0 : 2,3 kbps) :
l'encodeur n'a rien à coder, et on garde ce débit, qui est le bon pour du
silence. Le vérificateur consigne alors « non applicable : silent_fallback »,
ni succès ni rejet, comme pour le volume en R10.

Si un ré-encodage est déclenché pour dépassement de taille, **relancer R9 en
entier** sur le fichier concerné : un remux peut réintroduire des B-frames selon
les paramètres hérités.

## R10 — Mixage et volume sonore

Mesuré sur le mix final (après voix off, effets, musique et normalisation), avec
`ebur128` ou `loudnorm` en mode mesure :

- Volume intégré : -14 LUFS ±1
- Crête vraie : ≤ -1 dBTP
- 48 kHz, stéréo
- Piste audio présente sur les deux sorties, **dans tous les cas**. Un projet sans
  voix off ni musique garde une piste AAC silencieuse (`anullsrc`), car certains
  clients refusent un MP4 sans piste audio, et ce refus est lui aussi silencieux.

Rejet si hors tolérance : la normalisation est une étape du pipeline, un écart
signale qu'elle a été sautée ou mal paramétrée.

---

## R11 — Déterminisme

- Tout `effect` possède un `seed`. Sans lui, un effet à particules produit un
  fichier différent à chaque exécution : le déterminisme est perdu, et avec lui la
  possibilité de ne pas re-rendre une scène inchangée.
- Aucune `assets[].uri` ne pointe vers une URL distante. Les assets sont hydratés
  sur le disque du conteneur avant le lancement de la page : un fetch réseau
  pendant la capture introduit du non-déterminisme et des frames manquantes.
- Aucune animation ne dépend de l'horloge murale. Tout est fonction du temps de
  composition.
- La voix off est générée **une seule fois** puis lue depuis R2. Le TTS n'est pas
  déterministe : c'est le fichier stocké qui garantit la reproductibilité, pas le
  modèle.
- Le mixage audio est entièrement décrit par la composition (gains, ducking,
  fondus, positions). Deux mixages de la même composition donnent le même fichier.

**Test d'acceptation** : rendre deux fois la même composition, comparer les
checksums vidéo et audio. Différents = une des conditions est violée. À faire une
fois lors du test HyperFrames (T0), puis en CI.

## R12 — Idempotence de la reprise et plafond de coût

Avant chaque appel payant ou coûteux (génération fal.ai, voix off sur GPU) :

```
si (client_id, assets[ref].provenance.generation_key) existe déjà en base
   et l'objet R2 correspondant est présent
alors réutiliser, ne pas régénérer
sinon décrémenter le plafond du type de job (D35), PUIS appeler
```

Le plafond est décrémenté **avant** l'appel. Un plafond atteint bloque l'appel et
alerte Franco.

Le système de fichiers d'un Cloud Run Job est éphémère et ne survit pas à une
reprise. Chaque asset généré, voix off comprise, est donc écrit sur R2 **et**
enregistré en base **avant** l'étape suivante. Sans cette règle, une relance
automatique repaie l'intégralité de la génération, soit le coût dominant du projet.

Une correction factuelle (état `CORRECTION`, D26) réutilise tous les assets
inchangés via leur `generation_key`, et repasse **toutes** les règles.

---

## Ordre d'exécution

```
R17 isolation                       ─┐
R3  correspondance storyboard/plan   │
R16 licences et provenance           │
R4  polices                          │ document seul
R6  couches                          │ coût nul
R13 voix off et timeline audio       │
R14 effets sonores                   │
R15 musique                          │
R2  budget d'encodage                │
R1  timeline                        ─┘

R7  géométrie du mouvement          ─┐ page chargée
R5  zone de sécurité et débordement  │ DOM, avant capture
R8  contraste                       ─┘ coût nul

    ─── rendu vidéo → mixage audio → normalisation → mux → encodage des 2 sorties ───

R10 mixage et volume sonore
R9  ffprobe sur preview et master   bloquant avant envoi
R11 déterminisme                    CI uniquement
R12 idempotence et plafond          à chaque appel payant
```

R17 passe en premier : une fuite entre clients n'a pas à attendre le résultat des
autres règles.

Le bloc DOM (R5, R7, R8) reste le meilleur rapport effort/risque de toute la
couche qualité : il attrape la majorité des défauts visuels, il est déterministe,
et il ne consomme ni token ni seconde de rendu.

## Ce que le validateur ne fait pas

Il ne juge pas l'esthétique. Une composition valide est une composition dont
l'échec éventuel sera visuel ou éditorial, pas technique.

Ce périmètre revient à Franco (D22) : il reçoit l'aperçu, et valide ou refuse la
livraison depuis WhatsApp. Un refus renvoie le projet à l'état `ASSETS_READY`
pour un nouveau montage, sans regénération. Le juge VLM est abandonné (D17) ; les
`qa.frame_captures` restent produites comme support de revue et comme données de
calibration pour une automatisation future.