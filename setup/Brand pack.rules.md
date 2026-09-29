# Règles du Brand Pack

> Version réécrite le 26 septembre 2026, alignée sur le registre des décisions D1–D36.
> Les noms de champs sont indicatifs et doivent être alignés sur
> `brand-pack.schema.json` réécrit.

## Ce qui a changé depuis la version précédente

- **Onboarding automatisé** : un LLM extrait couleurs, polices et signature à partir
  des assets du client, puis Franco valide depuis WhatsApp avant publication. D'où
  le statut `pending_review` et la nouvelle règle B15.
- **Audio (D19)** : le Brand Pack porte désormais un **jeu de sons structurels**
  (B13), des préférences de voix et un lexique de prononciation (B14), et les
  ambiances musicales autorisées. Il ne contient jamais une piste de musique.
- **Monteur LLM (D21)** : les tables de la signature de mouvement ne traduisent plus
  les enums du storyboard, mais le **vocabulaire fermé du `montage_plan`**. Elles
  définissent aussi ce vocabulaire pour le client : le Monteur ne peut choisir que
  ce que la marque autorise. B5 et B8 sont réécrites.
- **Zone de sécurité** : constante du système (14 % haut, 35 % bas, 6 % gauche,
  10 % droite). Elle sort du Brand Pack. B3 est réécrite.
- **Isolation (D30) et rétention (D27)** : les assets du Brand Pack vivent sous le
  préfixe permanent `brand/` du client, et ne sont jamais visibles d'un autre
  client.

Deux familles de règles, aux moments opposés du cycle de vie :

- **B1–B7, B13–B15 : à la publication.** Un Brand Pack passe de `draft` à
  `published`. Ces règles s'exécutent une fois, à l'onboarding, et calculent tout ce
  qui peut l'être d'avance. Un `draft` n'est jamais compilable.
- **B8–B12 : à la compilation et en amont.** Le compilateur résout le `montage_plan`
  contre le Brand Pack, et le Storyboard en reçoit les contraintes.

La logique générale ne change pas : **déplacer le maximum de travail vers la
publication**. Ce qui est calculé une fois à l'onboarding ne peut plus échouer sur
les 20 projets mensuels qui suivent.

---

## B1 — Immuabilité et statut

Cycle de vie : `draft` → `pending_review` → `published` → `archived`.

Un Brand Pack `published` ne se modifie jamais. Toute évolution crée `version + 1`,
y compris une modification demandée par Franco depuis le canal admin : la commande
crée un brouillon, elle ne modifie jamais une version publiée.

La raison est concrète : une composition référence `brand_pack_version`, et les
`content_hash` de scène **ne couvrent pas** le Brand Pack. Sans immuabilité, une
correction factuelle (D26) recompilerait contre une charte modifiée et produirait
une vidéo différente de celle livrée, sans qu'aucun hash ne change.

Une version publiée ne peut passer qu'à `archived`. Une composition référençant une
version archivée reste compilable : c'est le but.

Un nouveau projet utilise toujours la dernière version publiée. Un projet en cours
garde la version avec laquelle son storyboard a été validé par le client.

## B2 — Calcul de la matrice de contraste

À la publication, pour chaque paire ordonnée (token texte, token surface) :

```
ratio = (L_clair + 0.05) / (L_sombre + 0.05)
```

avec L la luminance relative WCAG. `approved = ratio >= 4.5`, et `min_size_px`
relevé à la valeur du rôle `body` si `ratio < 7`.

Rejet de la publication si aucune paire approuvée n'existe pour `text_on_dark` sur
`surface_dark`, ni pour `text_on_light` sur `surface_light`, ni pour `cta_text` sur
`cta_background`. Un Brand Pack qui ne peut pas produire de texte lisible sur ses
propres surfaces n'est pas publiable.

La matrice est calculée par le code, jamais par le LLM d'onboarding. Le LLM propose
des couleurs ; le code décide lesquelles peuvent se superposer.

C'est la règle qui fait de la lisibilité une propriété **structurelle** : le
compilateur ne choisit que parmi des paires approuvées, et le texte illisible
devient inexprimable plutôt que détectable a posteriori.

## B3 — Format et géométrie

- Un seul profil : 9:16 (D12). Toute demande d'un autre format fait échouer la
  compilation avec un message explicite.
- La **zone de sécurité ne figure plus dans le Brand Pack**. C'est une constante du
  système, identique pour toutes les marques, parce qu'elle dépend de l'interface
  des plateformes et non de la marque.
- Le Brand Pack garde ce qui relève de la marque : `grid_unit_ratio`, marges
  internes, `clear_space_ratio` du logo.
- Contrôle à la publication : le logo, avec sa marge de protection, tient dans la
  zone utile (environ 907×979 px) à la taille minimale de son rôle.

## B4 — Résolution et licence des polices

À la publication :

- Chaque `asset_uri` existe, taille > 0, et se parse comme une police valide
- Chaque `font_ref` de `typography.scale` existe dans `typography.fonts`
- `license.type != "unknown"` : bloquant

Le dernier point reste délibérément strict. Une police redistribuée dans une image
Docker et utilisée commercialement engage une licence, et la responsabilité est la
tienne, pas celle du client.

Conséquence pour l'onboarding automatisé : le LLM peut **identifier** une police
sur un visuel, mais il ne peut pas en connaître la licence. Deux chemins seulement :

- le client fournit le fichier de police **et** confirme sa licence (réponse
  enregistrée) ;
- sinon, le LLM propose la police libre la plus proche (licence OFL, par exemple),
  que Franco valide.

**Test de chargement effectif** : rendre une page de contrôle qui déclare chaque
police par un `@font-face` sous son nom privé (T11), puis exiger dans
`document.fonts` une `FontFace` de cette famille, de ce poids et de ce style, à
l'état `loaded`. Une police présente sur disque et correctement déclarée peut
quand même ne pas se charger : Chrome bascule alors en fallback sans la moindre
erreur.

`document.fonts.check()` n'est pas ce test. Mesuré en T0 (Chrome 152) : il
répond vrai pour une famille qui n'existe nulle part, sur une page sans aucun
`@font-face`.

## B5 — Signature de mouvement et vocabulaire du client

La signature de mouvement définit **deux choses** : les valeurs que le compilateur
applique, et la liste des choix que le Monteur a le droit de faire pour ce client.

Tables obligatoires :

| Table | Clés | Contenu |
|---|---|---|
| `reveal_map` | `subtle`, `standard`, `punchy` | animation de texte, durée, courbe |
| `transition_map` | sous-ensemble de `cut`, `fade`, `slide`, `zoom_punch` | durée, courbe, direction par défaut |
| `camera_map` | sous-ensemble de `static`, `push_in`, `pull_back`, `drift`, `orbit` | échelles de début et de fin, courbe |
| `timing` | `stagger_ms`, `text_delay_ms` | amplitudes du rythme (T8 des templates) |

Règles de complétude :

- `reveal_map` est **totale** : les trois intensités existent pour toute marque
- `transition_map` contient au moins `cut` et une autre transition ; `camera_map`
  contient au moins `static` et un autre mouvement
- **Les clés présentes forment le vocabulaire du Monteur pour ce client.** Une
  marque sans `zoom_punch` ne recevra jamais de `zoom_punch` : le validateur du
  `montage_plan` rejette tout choix absent de ces tables.

Une clé absente n'est donc plus une erreur, c'est une restriction volontaire. En
revanche, une clé présente doit être complète : un compilateur qui doit inventer une
valeur est un compilateur non déterministe.

Contraintes de cohérence :

- `transition_map.cut.duration_ms == 0`
- `camera_map.static.scale_start == camera_map.static.scale_end`
- `camera_map.push_in.scale_end > scale_start`, l'inverse pour `pull_back`
- Tout `scale` > 1,0 impose une exigence de résolution source, propagée en R7 de la
  composition et en T7 des templates

**Jamais depuis une page blanche (D14).** Il existe 3 ou 4 signatures de départ
(par exemple : nerveuse, posée, premium). Le LLM d'onboarding en choisit une selon
le ton de la marque, puis propose des ajustements sur quelques paramètres
(`text_delay_ms`, durées de transition, amplitude du `push_in`, transitions
retirées). Franco valide sur un rendu de démonstration (B15).

Si la signature est identique à un preset sur toutes les valeurs : avertissement,
pas rejet. La marque n'a simplement pas encore de signature propre.

## B6 — Normalisation et stockage des assets

Chaque asset du Brand Pack est **dérivé**, jamais le fichier brut du client. La
recette est fixe, rejouable et exécutée automatiquement :

| Type | Traitement |
|---|---|
| Logo | Détourage, fond transparent, `clear_space_ratio` intégré au fichier, variantes clair et sombre |
| Produit | Recadrage en 9:16 autour du `focal_point`, normalisation colorimétrique |
| Fond | Redimensionnement avec sur-cadrage suffisant pour `parallax_spread`, calcul de `dominant_luminance` |

`source_ref` pointe vers le brut conservé. Si la recette change, on rejoue sans
redemander l'asset au client.

**Stockage** : bruts et dérivés vivent sous `brand/<client_id>/` sur R2, préfixe
**exclu du cycle de suppression à 7 jours** (D27). Aucun asset de ce préfixe n'est
jamais référencé par le projet d'un autre client (D30, R17 de la composition).

**Collecte par WhatsApp** : un logo envoyé en **photo** arrive recompressé en JPEG,
redimensionné, sans transparence. Le clarificateur demande explicitement l'envoi en
**document**, et un asset de rôle logo arrivé en photo est refusé avec une nouvelle
demande. Le média entrant est copié sur R2 dès sa réception, car son URL de
téléchargement expire en quelques minutes.

Le détourage automatique peut échouer sans erreur (bords rongés, ombre conservée).
Le résultat fait partie de ce que Franco valide en B15.

## B7 — Assets minimaux publiables

- `logos.on_dark` et `logos.on_light` obligatoires. Sans `on_light`, une scène à
  fond clair affiche un logo invisible, et le lint DOM ne le verra pas, puisque
  techniquement tout est correct.
- `products` peut être vide : les produits arrivent souvent par projet, pas à
  l'onboarding.
- Tout asset audio référencé (B13) porte une licence commerciale traçable. Règle
  bloquante au même titre que celle des polices : une musique ou un son non libre
  dans une pub livrée à un client engage **ta** responsabilité.

## B13 — Jeu de sons structurels

Le Brand Pack associe un son à chaque type d'événement que les templates peuvent
déclarer (T12) et à chaque transition autorisée.

- Table **totale** sur les événements `text_in`, `media_in`, `logo_in`, `emphasis`,
  `scene_out`, et sur chaque clé de `transition_map`
- Chaque entrée vaut soit un `asset_ref` de la bibliothèque audio, avec un gain en
  dB, soit `none` **explicite**. Une marque sobre peut n'avoir presque aucun son ;
  elle doit le dire, pas le laisser au compilateur.
- Chaque son référencé existe dans la bibliothèque partagée, avec provenance et
  licence (Pixabay Content License ou CC0, R16 de la composition)
- Gain de chaque son ≤ 0 dB ; le plafond sous la voix off est appliqué par la
  composition (R14)

Le jeu de sons est choisi par le LLM d'onboarding dans la bibliothèque taguée, selon
le ton de la marque, et validé par Franco à l'écoute du rendu de démonstration.

Les effets **sémantiques** (verre brisé, vent) ne sont pas dans le Brand Pack : ce
sont des décisions du Monteur, projet par projet.

## B14 — Voix, prononciation et musique

**Voix off.** Le client choisit la voix à chaque projet (D19). Le Brand Pack peut
fixer :

- `voice.default_voice_id` : la voix proposée par défaut dans le brouillon du
  clarificateur
- `voice.allowed_voice_ids` : sous-ensemble du catalogue, facultatif

Chaque `voice_id` existe dans le catalogue et parle la langue principale de la
marque.

**Lexique de prononciation.** Table `pronunciation` : nom de marque, de produit ou
de lieu → forme phonétique réécrite, utilisée **uniquement** au moment de la
synthèse vocale. Le texte à l'écran et le script du storyboard gardent
l'orthographe réelle.

C'est la règle audio la plus rentable. Un modèle de synthèse vocale prononce mal
les noms propres, les sigles et les mots en langues locales, et l'erreur ne se
révèle qu'à l'écoute. Un nom de marque mal prononcé dans sa propre pub est
immédiatement relevé par le client.

- Chaque clé de `pronunciation` est présente telle quelle dans `guidance`,
  `products` ou le nom de la marque
- La forme phonétique respecte la règle S4 du storyboard : ni chiffre, ni symbole

**Musique.** Le Brand Pack ne contient **aucune piste**. Il fixe
`music.allowed_moods`, sous-ensemble des ambiances taguées de la bibliothèque. Le
Monteur choisit une piste dans ces ambiances, et le compilateur applique la règle
de non-réutilisation entre clients (D32, R15).

## B15 — Onboarding et publication

Le Brand Pack d'un nouveau client est produit en trois temps :

1. **Collecte** par WhatsApp : logo, polices si disponibles, 2 ou 3 visuels de
   marque, ton souhaité
2. **Proposition** par le LLM d'onboarding : couleurs extraites, polices, preset de
   signature et ajustements, jeu de sons, ambiances musicales, lexique de
   prononciation. Statut `draft`.
3. **Validation** par Franco. Le Brand Pack passe en `pending_review`, et le
   système envoie à Franco :
   - une planche de marque (couleurs, paires de contraste approuvées, polices,
     logos détourés) ;
   - un rendu de démonstration d'un template publié, avec le contenu de démonstration
     du template (T13) habillé par ce Brand Pack, voix off et sons compris.

Le rendu de démonstration passe **toutes** les règles de la composition. Un Brand
Pack dont le rendu échoue n'est pas publiable.

Passage à `published` uniquement après approbation par commande admin (D29), avec
entrée dans le journal d'audit.

Toutes les propositions du LLM restent des propositions. Les calculs qui engagent
la lisibilité ou le droit (contraste, licences, existence des assets) sont faits
par le code, et la décision finale appartient à Franco.

---

## B8 — Ordre de résolution à la compilation

Le compilateur résout le `montage_plan` contre le Brand Pack dans cet ordre, et
chaque étape est déterministe :

```
1. géométrie      zone de sécurité (constante) × grid_unit     → boîtes en px
2. typographie    emphasis → rôle → size_ratio                  → font_size_px
3. couleur        rôle + surface                                → paire approuvée
4. mouvement      intensité / transition / caméra du plan       → specs + Bézier
                  (clés de reveal_map, transition_map, camera_map)
5. rythme         timing.stagger_ms, text_delay_ms              → beats en ms (T8)
6. assets         asset_ref du storyboard                       → variante 9:16
7. sons           événements des templates + transitions        → sound_set (B13)
8. voix           voice_id du storyboard + pronunciation         → entrée du TTS
9. musique        piste choisie par le Monteur                  → contrôle allowed_moods
                                                                   et non-réutilisation
```

L'étape 8 s'exécute en réalité **avant** le Monteur, puisque la voix off fixe les
durées (D20). Elle figure ici parce qu'elle lit le Brand Pack.

Échec à une étape = échec de compilation, jamais de valeur par défaut inventée. Un
défaut silencieux du compilateur est indétectable en aval.

## B9 — Sélection de la paire de couleurs

Pour chaque `text_element`, le compilateur détermine la surface effective derrière
le texte, puis :

1. **Surface = token** (couleur pleine) → chercher une paire approuvée. Absente →
   échec.
2. **Surface = image ou vidéo** → appliquer `on_image_policy` :
   - `always_scrim` : voile à `scrim_opacity`, contraste recalculé contre le
     composite
   - `adaptive_scrim` : voile seulement si `dominant_luminance` de l'asset dépasse
     `luminance_threshold`
   - `text_plate` : fond plein depuis `cta_background`, paire vérifiée normalement
3. Contraste final < 4,5 → échec de compilation, pas d'avertissement

`always_scrim` est le choix sûr avec des assets clients imprévisibles. Le coût
esthétique est réel mais borné ; le coût d'un texte illisible livré ne l'est pas.

## B10 — Calcul des tailles

```
font_size_px = round(scale[rôle].size_ratio × canvas.height)
```

Puis shrink-to-fit sous contrôle de R5, avec pour plancher
`max(scale[rôle].min_size_px, contrast_pair.min_size_px)`. La seconde borne est
souvent la plus contraignante, et c'est voulu : un ratio de contraste juste
suffisant ne tient pas sur du petit texte.

## B11 — Catalogue transmis au Storyboard

Le Storyboard reçoit le **catalogue du client uniquement** (`label`, `tags`,
`focal_point`, dimensions), jamais les images, et jamais le catalogue d'un autre
client (D30).

Il émet un `asset_ref`. Le compilateur vérifie qu'il existe et qu'une variante 9:16
a été produite en B6. Absente : recadrage à la volée autour du `focal_point`. Le
dérivé est stocké sous `brand/<client_id>/` et rejoint le Brand Pack en
`version + 1` à la prochaine publication validée par Franco.

## B12 — Application du bloc guidance

`guidance` (ton, termes interdits, mentions requises) est injecté dans le prompt du
Storyboard et du Monteur. Il n'est **jamais** lu par le compilateur.

Mais `forbidden_terms` et `required_mentions` sont en plus **vérifiés
déterministement**, après génération du storyboard, sur :

- le texte à l'écran ;
- le script de voix off, sous sa forme parlée ;
- le résumé présenté au client (S11 du storyboard).

Résultats :

- Terme interdit détecté → rejet du storyboard, régénération, une fois
- Mention requise absente sur une scène du `purpose` concerné → rejet

La comparaison se fait après normalisation (casse, accents, forme parlée des
nombres). Un terme interdit contourné par une variante orthographique reste un
terme interdit.

Un LLM à qui l'on demande d'éviter un terme l'évite la plupart du temps. « La
plupart du temps » n'est pas un contrôle, et la différence se voit chez le client.

---

## Ce que le Brand Pack ne contient pas

**Les templates.** Un template définit une structure. Le Brand Pack définit une
apparence, un rythme et un son. Le même template sert toutes les marques.

**La zone de sécurité et les paramètres d'encodage.** Ce sont des constantes du
système, liées aux plateformes, pas à la marque.

**Les durées de scène.** Elles viennent de la voix off. Le Brand Pack n'influence
que les durées de transition, de révélation et de décalage.

**Les pistes de musique et les effets sonores sémantiques.** La musique est choisie
par projet dans la bibliothèque partagée ; les effets sémantiques sont des décisions
du Monteur.

**Le choix de voix d'un projet.** Il appartient au client ; le Brand Pack propose
seulement une voix par défaut.

**Le jugement esthétique.** Un Brand Pack valide garantit la lisibilité, la
cohérence, la bonne prononciation et la conformité juridique. Il ne garantit pas que
la vidéo soit belle : cela reste la responsabilité du template, du Monteur, et de la
validation de Franco.