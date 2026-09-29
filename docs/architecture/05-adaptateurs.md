> Architecture d'exécution v1 — extrait du §5, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

## 5. Les deux adaptateurs

Un adaptateur existe pour **isoler une décision non prise**. Le moteur de
rendu est un pari (D7, à tester en T0) ; le fournisseur de génération est
un poste de coût qui changera. Aucun des deux ne décide quoi que ce
soit : ils exécutent un contrat déjà entièrement résolu. S'ils
choisissent, le contrat en amont est incomplet — c'est la phrase
d'ouverture de `Composition.schema.json`.

### 5.1 Adaptateur de moteur de rendu

```
interface AdaptateurRendu {
  capacites() -> Capacites
  verifier(composition, dossier_assets) -> RapportLint
  rendre(composition, options) -> ResultatRendu
}

Capacites {
  moteur           : text          // 'hyperframes' | 'revideo' | 'remotion'
  version          : text
  fps_supportes    : int[]         // doit contenir composition.canvas.fps
  lint_dom         : bool          // R5, R7, R8 sont-ils exécutables ?
  slots_declares   : bool          // T11 : manifeste ↔ HTML
  polices_requises : text[]
  sorties          : text[]        // 'mp4_h264', 'png_sequence'
}

Options {
  sortie       : chemin
  taille       : {l: 1080, h: 1920}   // D12 ; jamais l'aperçu réduit
  graine       : int                  // consignée dans le résultat
  timeout_s    : int
  sans_reseau  : true                 // toujours (R11)
}

ResultatRendu {
  chemin_video : chemin           // MUETTE — voir ci-dessous
  duree_ms     : int
  frames       : int
  hash_frames  : sha256           // hash ordonné des hashs de frames
  polices_ok   : bool             // document.fonts.check(), R4
  captures     : [{t_ms, chemin}] // qa.frame_captures
  journal      : text
}

Erreurs : E_ASSET_MANQUANT · E_POLICE_MANQUANTE · E_SLOT_INCONNU
        · E_HORS_ZONE_SECURITE · E_DEBORDEMENT_TEXTE · E_CONTRASTE
        · E_TIMEOUT · E_NON_DETERMINISTE · E_MOTEUR
```

Sept règles, qui sont le contrat réel :

1. **La sortie est muette.** Le moteur rend l'image, jamais le son. Tout
   l'audio est assemblé par FFmpeg (§7), donc la garantie -14 LUFS /
   -1 dBTP (R10) ne dépend pas du moteur, et changer de moteur ne remet
   pas en jeu la conformité sonore. C'est la décision qui rend D7
   réversible à bon marché.
2. **Aucun réseau pendant la capture** (R11). Les assets sont hydratés
   sur disque, les polices sont dans l'image, et chaque police est
   prouvée chargée avant la première frame par une `FontFace` « loaded »
   de sa famille privée (R4 ; `document.fonts.check()` ne prouve rien,
   mesuré en T0). Une police absente est une
   erreur, pas un repli silencieux — un repli change le rendu sans le
   dire, et c'est le mode d'échec le plus discret du pipeline (R4).
3. **Déterminisme vérifiable** : mêmes composition, assets, version du
   moteur **et version de Chrome** ⇒ même `hash_frames`. Le moteur
   télécharge son propre Chrome : c'est l'image du conteneur qui épingle
   le couple. C'est le test d'acceptation de R11 et le
   critère C de T0.
4. **`verifier()` avant `rendre()`** : le bloc DOM (R5, R7, R8) tourne
   sur la page chargée, avant la première frame capturée, et son coût est
   nul. S'il échoue, on ne rend pas. Si `capacites().lint_dom` est faux,
   R5/R7/R8 ne sont pas exécutables et le moteur est **refusé** en
   production (§11, écart É-5).
5. **`rendre()` ne lit ni la base ni R2.** Il reçoit un dossier et une
   composition. C'est ce qui permet de l'exécuter à la main en T1, sans
   base.
6. **Un seul worker de capture** (`--workers 1`) [T0, 29/09]. Le mode
   « auto » du moteur calibre le nombre de workers sur la vitesse de la
   machine, et le découpage des frames entre pages Chrome change les
   pixels : `hash_frames` dépendrait de la machine et varierait d'un
   rendu à l'autre (mesuré : 1, 3 et 4 workers, deux hashes). Coût nul
   mesuré : 15 à 16,6 s pour 15 s de vidéo, plus rapide que « auto ».
7. **x264 à un thread** (`-threads 1`) [T0, 29/09, É-14]. x264
   multi-thread n'est pas reproductible octet pour octet : mêmes PNG, deux
   fichiers. À un thread, les fichiers encodés sont identiques ; coût
   mesuré, 27 s au lieu de 15 s pour les deux sorties.

Les règles d'écriture qui rendent une page déterministe (état à t = 0
dans le DOM, `will-change` sur toute opacité animée) appartiennent au
template et au runtime : T11 de `Template.rules.md`. Le lint les vérifie.

**Ce que HyperFrames fournit, et ce qu'il ne fournit pas** [D-28/09].
Le moteur est confirmé : projet open source de HeyGen, licence Apache
2.0, aucun frais par rendu, rendu local, Node 22 + FFmpeg + Chrome
headless — exactement l'image de `job-produce`. Une composition y est un
**fichier HTML ordinaire**, sans étape de build, dont le temps vit dans
des attributs `data-start` / `data-duration` / `data-track-index`. Le
renderer ne joue pas : il **cherche chaque frame**, la capture, puis
encode. Trois conséquences :

- **D34 n'est pas fourni par le moteur.** Il n'a pas de système de props
  JSON. Les « emplacements déclarés remplis par JSON » sont **notre
  code** : le manifeste déclare les `slot_id`, le HTML porte des
  `data-slot`, et le compilateur injecte avant capture. T11 est une
  vérification que nous écrivons, pas une propriété du moteur.
- **Les temps se convertissent, et c'est là que naissent les décalages.**
  Les contrats sont en millisecondes entières, le moteur attend des
  secondes. Ne jamais émettre `ms / 1000` : partir du numéro de frame,
  émettre `frame / fps`, et vérifier le retour —
  `round(secondes × fps) === frame`.
- **Toute animation doit être seekable** : timeline en pause, scrubée par
  le renderer. Une animation pilotée par l'horloge murale, par
  `requestAnimationFrame` ou par un aléa non graîné casse le déterminisme
  **sans lever d'erreur**. C'est la forme concrète de R11 pour ce moteur,
  et elle appartient à `Template.rules.md`.

Le moteur sait aussi mixer l'audio, y compris le ducking. **Nous ne
l'utilisons pas** : la composition résout déjà le mix (A2, R10, R15), et
déplacer cette décision dans le moteur rouvrirait la conformité sonore à
chaque changement de moteur.

Les deux profils d'encodage (`encode.preview`, `encode.master`) sont
appliqués **dans la commande FFmpeg du moteur**, jamais en
post-traitement séparé : un remux ultérieur peut réintroduire des
B-frames, ce que dit déjà le `$comment` du contrat.

### 5.2 Adaptateur de génération

```
interface AdaptateurGeneration {
  estimer(demande) -> {cout_c: int, latence_p50_s: int}
  produire(demande, contexte) -> ResultatGeneration     // idempotent
  reconcilier(generation_key) -> StatutGeneration
}

Demande {
  kind       : 'image' | 'image_animee' | 'retouche' | 'tts'
  modele     : text
  prompt     : text?
  negative_prompt : text?
  entrees    : [{asset_ref, sha256}]
  parametres : {seed, taille, …}     // normalisés, clés triées
}

Contexte { client_id, projet_id }

ResultatGeneration {
  generation_key : sha256
  asset_ref      : text
  r2_key         : text
  sha256         : sha256
  cout_reel_c    : int
  deja_paye      : bool          // true = servi par l'idempotence
  ref_fournisseur: text
}

Erreurs : E_BUDGET · E_QUOTA_FOURNISSEUR · E_FOURNISSEUR_INDISPO
        · E_REFUS_CONTENU · E_ENTREE_INVALIDE · E_TIMEOUT
```

**La clé d'idempotence est celle du contrat** :
`sha256(provider | model | prompt | negative_prompt | seed | params)`,
ou `sha256(model | voice_id | texte | params)` pour la voix off. Elle est
inscrite dans `provenance.generation_key` de la composition, ce qui rend
la réutilisation vérifiable *depuis le document livré* et non seulement
depuis la base. Elle ne contient ni `client_id` ni `projet_id` : c'est un
choix qui a une conséquence d'isolation, traitée au §11, écart É-1.

**Séquence de `produire()`** — l'ordre *est* la garantie (R12) :

1. calculer `generation_key` ;
2. `SELECT` : si `reussie` **et** l'objet R2 est présent, renvoyer
   l'existant avec `deja_paye = true`. **Aucun appel réseau.** Si
   `reserve`/`en_cours`, appeler `reconcilier()` ;
3. transaction unique : `UPDATE ops.projet SET budget_restant =
   budget_restant - cout_estime_c` **puis** `INSERT ops.generation (…,
   'reserve')`. La contrainte `budget_restant >= 0` fait échouer la
   transaction avant tout appel → `E_BUDGET`. **Le plafond est décrémenté
   avant l'appel** (D35, R12) parce qu'il l'est dans la même transaction
   que la réservation ;
4. appel fournisseur ; `ref_fournisseur` écrit **dès réception de
   l'identifiant**, avant d'attendre le résultat — sans quoi un timeout
   laisse un appel payé et anonyme ;
5. téléchargement, `sha256`, écriture R2 sous le préfixe du client,
   `INSERT ops.objet`, `UPDATE ops.generation → 'reussie'` avec
   `cout_reel_c` : écrit sur R2 **et** en base avant l'étape suivante
   (D10, R12) ;
6. si `cout_reel_c < cout_estime_c`, la différence est rendue au budget.
   L'estimation est le **prix maximal** du modèle appelé, jamais une
   moyenne : ainsi le budget n'est jamais dépassé après coup et la
   contrainte de la base n'a jamais à être contournée.

**Fournisseur LLM** [D-28/09] : Groq, `openai/gpt-oss-120b`, palier
gratuit. Deux conséquences portées ailleurs dans ce document — le budget
de reprise du Monteur se scinde (§6.1) parce que `strict` est ignoré sur
ce modèle, et le plafond de coût **ne protège plus d'une boucle LLM**
puisque les appels sont gratuits : cette protection repose désormais
entièrement sur les deux bornes de reprise. Un palier gratuit n'étant
assorti d'aucun engagement de service, **l'adaptateur porte deux
fournisseurs** et bascule sur `E_FOURNISSEUR_INDISPO` avant la reprise du
watchdog ; `ops.generation.fournisseur` enregistre lequel a servi.

**Reprises** : uniquement sur erreur réseau, 5xx ou timeout, deux fois,
2 s puis 8 s. Jamais sur 4xx. Jamais de nouvelle soumission sans
`reconcilier()` quand `ref_fournisseur` existe — c'est la seule façon de
ne pas payer deux fois un appel qui a réussi côté fournisseur et échoué
côté réseau.

**D11 dans l'adaptateur** : `kind = 'image_animee'` ne produit pas de
vidéo chez le fournisseur. Il produit une image, et c'est le moteur qui
l'anime — `camera.keyframes`, `parallax_factor`. Aucune valeur du
vocabulaire du Monteur ne se résout en vidéo générée : le jour où ce sera
le cas, les plafonds seront à revoir, une vidéo générée coûtant un ordre
de grandeur de plus qu'une image.

---
