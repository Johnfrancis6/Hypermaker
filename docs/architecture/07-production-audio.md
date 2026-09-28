> Architecture d'exécution v1 — extrait du §7, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

## 7. Production audio

D20 renverse l'ordre habituel : l'audio est produit **avant** le montage
et lui impose son horloge. Le pipeline se lit donc en deux moitiés, de
part et d'autre du point de reprise `ASSETS_READY`. Les contrôles (R10,
R13, R14, R15) sont dans `Composition.rules.md` ; ici, la production.

### 7.1 Chaîne complète

```
GENERATING — job-tts, GPU L4
  script voix off du storyboard (+ lexique de prononciation, B14)
   └─ synthèse Chatterbox, UNE PASSE PAR SCÈNE ──► voix_scene[sc_xx]
        ├─ rognage des silences de bord
        ├─ passe-haut 80 Hz
        └─ gain statique vers -18 LUFS par scène
   └─ alignement forcé (texte connu, audio) ────► alignement.json
                                                  mots, ms LOCAUX, confiance

ASSETS_READY — job-produce, CPU
  compilateur :
     durées de scène        ← segments de voix + tail_ms (R13)
     audio.voiceover        ← segments et alignement sur timeline globale
     audio.sfx structurels  ← jeu de sons du Brand Pack (B13) × événements
     audio.sfx sémantiques  ← décisions du plan (M11)
     audio.music            ← piste, gain, boucle, fondus (M12, R15)
  FFmpeg :
     voix ── effets ── musique ──► amix ──► loudnorm 2 passes
                                            -14 LUFS ±1 / -1 dBTP (R10)
  mux avec le rendu muet ──► master + aperçu ──► R9 bloquant
```

Ce qui vit sur le GPU est **exactement** ce qui a besoin du GPU. Le
mixage est du FFmpeg sur CPU, donc il est refait gratuitement à chaque
refus de Franco.

### 7.2 Voix off

**Une passe de synthèse par scène**, pas une passe pour le script
entier. Trois raisons, par ordre d'importance :

1. une correction de texte sur une scène ne resynthétise que cette scène
   (§3.6, M13) — c'est la seule dépense GPU qu'une relance peut engager ;
2. les bornes de segments sont exactes par construction, sans découper un
   fichier long sur des silences ;
3. l'alignement forcé est bien plus fiable sur 3 s de texte connu que sur
   30 s.

Tous les paramètres entrent dans la `generation_key` : `voice_id`,
langue, texte, lexique de prononciation appliqué (B14), `seed =
sha256(projet_id + scene_id) mod 2^31`. Deux synthèses de la même scène
donnent le même fichier — mais c'est **le fichier stocké** qui garantit
la reproductibilité, pas le modèle (R11 le dit explicitement : le TTS
n'est pas déterministe).

Le script est déjà en forme parlée : S4 interdit chiffres et symboles
dans `voiceover_script` (« quinze mille francs CFA », pas
« 15 000 FCFA »). Le lexique de prononciation du Brand Pack s'applique
**à la synthèse uniquement** ; le texte à l'écran garde l'orthographe
réelle.

**Post-traitement identique pour toutes les scènes**, sinon elles ne se
ressemblent pas : rognage des bords sous -45 dBFS en gardant 40 ms de
respiration, passe-haut 80 Hz, puis **gain statique** vers -18 LUFS
mesuré. Gain statique et non compresseur : un compresseur dépend du
contenu, donc du hasard de la synthèse, donc n'est pas reproductible
d'une scène à l'autre.

Le tatouage inaudible de Chatterbox reste en place : il n'est ni retiré
ni contourné. Sa survie au réencodage AAC est à constater en T0b (§12).

### 7.3 Alignement mot à mot

Alignement **forcé** — le texte est connu, donc pas de reconnaissance
libre : un aligneur CTC sur modèle français, dans le même job GPU, modèle
déjà chargé.

Les millisecondes produites sont **locales à la scène**. Les positions
globales n'existent qu'après la compilation, qui place chaque segment sur
la timeline : c'est ce qui permet de déplacer une scène sans toucher à
l'alignement. Le contrat, lui, porte l'alignement **global**
(`audio.voiceover.alignment`, avec `segment_id`) : la conversion local →
global est une étape du compilateur, pas du job GPU.

**Mode dégradé** : si l'aligneur échoue, ou si plus de 20 % des mots ont
une confiance inférieure à 0,5, la scène est marquée non alignée et les
mots reçoivent une répartition proportionnelle au nombre de caractères.
Le menu du Monteur retire alors les emphases `on_word` de cette scène
(M9 exige un `word_ref` valide), et les beats `on_word` du template
retombent sur leur `fallback_mode` (T8). Une emphase mal calée est plus
visible qu'une emphase au début de scène.

### 7.4 Effets sonores

Deux origines, deux chemins, comme le dit le contrat : les **structurels**
viennent du jeu de sons du Brand Pack (B13, table totale sur `text_in`,
`media_in`, `logo_in`, `emphasis`, `scene_out` et chaque transition) ; les
**sémantiques** viennent d'une décision du Monteur (M11) et portent donc
un `plan_decision_ref` obligatoire.

**Calage sur l'attaque, pas sur le début du fichier.** Un « whoosh » dont
le fichier commence par 90 ms de souffle tombe à côté si on aligne le
premier échantillon sur l'événement. On cale `attaque_ms`, mesuré à
l'import (premier échantillon à -20 dBFS du pic) :

```
start_ms = evenement_ms - attaque_ms + offset_role
```

R14 exige que `sfx.start_ms` égale le `start_ms` de l'événement à ±1
frame. La valeur écrite dans la composition est donc la position du
**fichier**, et c'est l'attaque qui tombe sur l'événement : à
l'implémentation, c'est `start_ms` qui porte le décalage, et le contrôle
R14 doit se faire sur l'instant d'attaque, pas sur le début du fichier
(§11, écart É-7).

| Rôle | Événement naturel | `offset_role` |
|---|---|---|
| impact, ting, pop, clic | `text_in`, `emphasis`, mot | 0 |
| whoosh | transition | −60 ms |
| riser | transition (il *monte vers* elle) | −(durée du son) |
| souffle | `scene_out` | 0 |

**Élagage**, dans cet ordre : au plus 2 sons sémantiques par scène et 4
par vidéo (M11) ; deux attaques distantes de moins de 300 ms → on garde
la plus prioritaire (`impact` > `whoosh` > `riser` > `ting` > `pop` >
`clic`) ; un son sémantique qui tombe au même instant qu'un son
structurel déclenche l'avertissement de M11. Tout élagage est écrit dans
`trace_resolution`.

**Gains** : piste normalisée au pic à -18 dBFS, puis le gain du Brand
Pack (B13), plafonné à `audio.sfx_gain_under_voice_db` (-6 dB par
défaut) pendant tout segment de voix off (R14).

### 7.5 Musique et ducking

**Élection** : `mood` ∈ `allowed_moods` du Brand Pack (B14, M12) →
requête sur `ops.piste_audio.moods`, en excluant les pistes livrées à un
autre client sur la période configurée — **30 jours** [D-28/09], valeur
portée par `ops.parametre`, pas en dur :

```sql
-- prédicat, pas une implémentation
SELECT p.asset_ref FROM ops.piste_audio p
 WHERE p.section = 'musique' AND p.moods && $moods
   AND (p.duree_ms >= $duree OR p.bouclable)
   AND NOT EXISTS (
     SELECT 1 FROM ops.musique_livree m
      WHERE m.asset_ref = p.asset_ref
        AND m.client_id <> $client
        AND m.livre_le > now() - interval '30 days')
 ORDER BY p.asset_ref;
```

Le choix dans l'ensemble restant se fait par hachage stable
(`sha256(client_id + projet_id + mood) mod n`) : arbitraire mais
reproductible et tracé. R15 revérifie juste avant le rendu, ce qui
attrape la course entre deux projets simultanés — c'est exactement ce que
prévoit M12, et c'est la raison pour laquelle la ligne
`ops.musique_livree` n'est écrite qu'à la **livraison**.

Effet de bord utile : un client qui repasse commande retrouve sa piste,
puisqu'elle n'est exclue que pour *les autres* clients. La cohérence
sonore d'une marque d'une vidéo à l'autre est gratuite.

**Mise en longueur** : boucle avec fondu croisé jusqu'à
`canvas.duration_ms`, fondu d'entrée, fondu de sortie obligatoire sur la
fin (R15). Lit de musique par gain statique depuis `piste_audio.lufs`.

**Ducking par enveloppe, pas par compresseur.** Un `sidechaincompress`
dépend de l'attaque réelle du signal : deux mixages de la même
composition peuvent différer, ce que R11 interdit. Une enveloppe est une
donnée, donc reproductible et **inspectable** — et la composition la
porte déjà.

Construction : intervalles de mots de la voix off → fusion de deux
intervalles séparés de moins de 400 ms (sinon la musique remonte entre
deux mots, ce qui s'entend comme un défaut) → pour chaque région,
`audio.ducking_db` (-12 dB par défaut, R15), attaque 120 ms **avant** le
début de la région, retour 300 ms après la fin. L'enveloppe commence et
finit à 0 dB. Elle est appliquée par un fichier de commandes `asendcmd`
sur un filtre `volume` : des données, pas un traitement adaptatif.

Les effets sonores ne duckent rien : ils sont courts, et une musique qui
plonge à chaque « clic » respire mal. Leur plafond sous la voix est déjà
assuré par `sfx_gain_under_voice_db`.

### 7.6 Mixage, normalisation, encodage

**Mixage** : les trois pistes sont placées par `adelay` aux positions
absolues de la composition, puis `amix` **sans** normalisation
automatique — elle dépend du nombre d'entrées, donc elle est traître.

**Normalisation** : `loudnorm` en **deux passes**, mode linéaire — passe
1 mesure, passe 2 applique les valeurs mesurées : `I = -14`, `TP = -1`,
`LRA = 11`. Le mode linéaire est le seul déterministe ; le mode dynamique
par défaut change le son selon l'historique du signal. Tolérance ±1 LU
(R10).

**Piste audio dans tous les cas** : un projet sans voix off ni musique
garde une piste AAC silencieuse (`anullsrc`), parce que certains clients
refusent un MP4 sans piste audio et que ce refus est lui aussi silencieux
(R10, `silent_fallback`).

**Un seul mixage, deux encodages**, aux profils `encode.preview` et
`encode.master` déjà résolus par R2. L'aperçu peut descendre en
720×1280 quand le budget vidéo tombe sous 800 kbps ; le master reste en
1080×1920.

**Contrôle bloquant** : R9 sur les **deux** fichiers, avant tout envoi.
Le contrôle `has_b_frames = 0` sur l'aperçu est le plus important du
pipeline, parce que son échec est **totalement silencieux** : l'API
accepte l'upload, ne renvoie aucune erreur, et le client Android échoue
simplement à lire la vidéo. Si un ré-encodage est déclenché pour
dépassement de taille, **R9 est relancée en entier** : un remux peut
réintroduire des B-frames selon les paramètres hérités. Deux
ré-encodages au maximum, puis `E_CONFORMITE` et `FAILED`.

Le résultat part dans `history.livraison` (LUFS, dBTP, durée, octets,
`hash_frames`) : c'est la preuve qu'on a livré conforme, et une partie
des données de calibration du futur juge (D22).

### 7.7 Reprise dans le pipeline audio

| Ce qui change | Resynthèse | Remixage |
|---|---|---|
| refus de Franco sur le montage (T11) | rien | tout |
| refus sur une intonation | la scène concernée (nouveau `seed`) | tout |
| correction factuelle d'un mot (T13) | les seules scènes dont le `content_hash` a changé | tout |
| changement de voix | toutes les scènes | tout |
| relance après crash | les scènes sans `voix_scene` | tout |

Le remixage complet est systématique et assumé : il coûte moins d'une
minute de CPU, alors qu'un mixage partiel exigerait de savoir quelles
parties du mix dépendent de quoi — une complexité qui ne se rentabilise
jamais à 60 projets par mois.

---
