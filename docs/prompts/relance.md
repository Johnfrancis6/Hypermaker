BRIEF DE RELANCE — projet HyperMaker

Agent WhatsApp qui produit des pubs verticales 9:16 pour marques et
startups. 3 clients, ~60 projets/mois. Développement solo. Un client
existe déjà.

═══ 1. LIS CECI AVANT TOUT ═══

- setup/*.schema.json et setup/*.rules.md
  Les cinq contrats de données (storyboard, montage_plan, composition,
  template, brand pack) et leurs règles S, M, R, T, B. Validés.
  Ne JAMAIS inventer, renommer ni « améliorer » un champ.
- docs/architecture_runtime_v1.md
  Ce qui exécute ces contrats : base, machine à états, services,
  adaptateurs, audio, canal admin, erreurs, plan T-1 → T4.
  Les décisions marquées [D-28/09] sont récentes et font foi.

═══ 2. OÙ EN EST LE PROJET ═══

Fait :
- Les contrats, avec deux corrections appliquées le 28/09 :
  l'idempotence est bornée au client (clé (client_id, generation_key)),
  et R14 se contrôle sur start_ms + attack_ms, pas sur start_ms.
- L'architecture d'exécution.
- Le plan de l'étape T0, validé.

Décidé et non rediscutable sans raison nouvelle :
- fps = 30 pour tous les projets
- moteur : hyperframes@0.8.83, épinglé exactement (0.x casse en mineur)
- l'adaptateur de rendu en T0 = un seul rendre.mjs qui renvoie les
  champs de ResultatRendu (duree_ms, frames, hash_frames, polices_ok).
  Pas d'interface, pas de classe. Les NOMS de champs sont figés.
- le moteur sort des frames PNG sans perte ; UNE seule commande FFmpeg
  de notre code produit l'aperçu et le master, avec piste anullsrc.
  Aucun remux après encodage.
- hash_frames se calcule sur les pixels décodés (framemd5), jamais sur
  les octets PNG. Le hash du fichier encodé est informatif.
- police : Inter, OFL, .woff2 commités dans assets/fonts/ avec OFL.txt.
  Jamais de CDN.
- couleurs de démo : --brand-fond #0E1116, --brand-texte #FFFFFF,
  --brand-accent #FF5A1F, --brand-secondaire #9AA4B2
- fixture d'entrée : sous-ensemble FIDÈLE de Composition.schema.json,
  noms et formes exacts, blocs requis omis listés en tête de fichier.

═══ 3. CE QUI VIENT DE CHANGER ═══

Les assets réels (photos produit, logos, textes) viendront du premier
client, à une date non fixée. On ne l'attend pas.

T0 se scinde :
- T0-technique : les 3 questions d'architecture + critères A et C.
  Se fait avec des placeholders fabriqués à la main (aplats, damiers,
  faux logo avec et sans alpha). Fabriquer une fixture n'est PAS une
  génération d'image.
- T0-qualité : critère B. Attend les assets du client.

Les décisions d'architecture dépendent de T0-technique uniquement.

═══ 4. ORDONNANCEMENT — CE QUI AVANCE, CE QUI ATTEND ═══

PEUT AVANCER MAINTENANT :
- T0-technique en entier : template, injection, lint de zone de
  sécurité, vérificateurs de conformité et de déterminisme, rapport.
- T1 : chaîne de livraison de bout en bout, composition écrite à la
  main, encodage, contrôles R9/R10, envoi WhatsApp.
- L'ossature de T3 qui ne dépend pas du moteur : schéma Postgres
  (ops + history), machine à états et baux, adaptateur de génération
  et idempotence, plafonds, canal admin.

PORTE FERMÉE jusqu'au verdict de T0-technique :
- le compilateur, en particulier C-5 (échelle typographique) et C-11
  (zone de sécurité) — leur nature dépend de l'inspectabilité du DOM
- l'authoring de templates supplémentaires (T2)

PORTE FERMÉE jusqu'à T0b :
- tout le pipeline audio : les constantes ne sont pas mesurées
- le Monteur : il consomme l'alignement mot à mot

PORTE FERMÉE jusqu'aux assets client :
- le critère B, donc le verdict complet sur D7

Si tu te trouves à devoir ouvrir une porte fermée, ARRÊTE et dis-le.

═══ 5. CONTRAINTES DURES ═══

- Toute animation est une timeline en pause, seekable. Jamais
  d'horloge murale, de requestAnimationFrame, ni d'aléa non graîné :
  ça casse le déterminisme SANS lever d'erreur.
- Aucun réseau pendant la capture. Assets sur disque, polices locales.
  Une police absente est une erreur, pas un repli silencieux.
- Conversion des temps : jamais ms/1000. Toujours numéro de frame,
  puis frame/fps, avec l'assertion round(secondes*fps) === frame.
- Le moteur et le compilateur ne DÉCIDENT rien. Si l'un doit choisir,
  le contrat en amont est incomplet : signale-le.
- Isolation : client_id sur chaque ligne, préfixe R2 par client, aucun
  contenu d'un client dans le contexte d'un autre.
- Aucune dépense sans generation_key consultée d'abord, et plafond
  décrémenté AVANT l'appel, dans la même transaction.
- Jamais désactiver ou contourner un contrôle pour faire passer un
  test. Un contrôle qui gêne se discute, il ne se neutralise pas.

═══ 6. MÉTHODE ═══

- Propose un plan court AVANT d'écrire du code. Attends ma validation.
- Si une information manque, DEMANDE. N'invente pas, ne suppose pas.
- Critère de conception : éviter la sur-ingénierie. 3 clients,
  2 projets par jour. Pas d'abstraction « au cas où ».
- Un commit par livrable, message en français, qui dit POURQUOI.
- Ce qui est vérifiable par code doit l'être. Les critères d'acceptation
  se mesurent, ils ne s'apprécient pas.
- Si une décision d'architecture te semble fausse, dis-le au lieu de la
  contourner silencieusement.

═══ 7. DÉCISIONS DU 28/09 SUR LE PLAN T0 ═══

Vidéo de 15 s :
- deux scènes de 7,5 s sur le même template, aucun second template.
  7,5 s × 30 = 225 frames par scène, 450 au total. Toujours choisir des
  durées qui tombent juste sur la grille de frames.
- deux scènes imposent une entrée dans transitions : elle n'est plus
  omissible de la fixture.
- les trois fixtures font varier la transition : la première en cut
  (duration_ms: 0), les deux autres en fade de 400 ms.

Police Inter :
- téléchargée depuis la release officielle, sha256 relevé dans le commit.
- les .woff2 sont commités, jamais un script de téléchargement.
- OFL.txt à côté, licence renseignée dans le manifeste (B4).
- instances statiques 400 et 700 uniquement, jamais la police variable :
  l'interpolation d'un axe variable est une source de divergence entre
  versions de Chromium.

Lectures pour T0 : Composition.schema.json en entier et B4 du Brand Pack.
Storyboard et Montage plan sont en amont du compilateur, hors T0.

Étape 1 (socle) : si HyperFrames n'expose ni la sortie PNG ni la coupure
du réseau, s'arrêter et le signaler au lieu de contourner.

═══ 8. DÉCISIONS DU 28/09 APRÈS L'INSPECTION DE HYPERFRAMES 0.8.83 ═══

Constat : sortie PNG disponible (--format png-sequence), aucune coupure
réseau exposée. Le moteur émet de la télémétrie (posthog), complète les
familles de police sans @font-face depuis son bundle (@fontsource/inter
400/700/900) ou depuis Google Fonts, avec repli silencieux si l'appel
échoue.

Polices :
- nom de famille PRIVÉ, jamais public : HM-Demo-Sans en démo,
  HM-{client}-{rôle} en production. @font-face explicites générés depuis
  composition.fonts[]. Règle écrite dans T11 (Template.rules.md).
- le contrôle de la source effective de la police reste en place, en
  défense en profondeur.
- licence : AUCUN fragment de Brand Pack (décision révisée, voir §9).

Réseau, quatre couches par coût croissant :
1. noms de famille privés + @font-face explicites
2. HYPERFRAMES_NO_TELEMETRY et DO_NOT_TRACK
3. espace de noms réseau vide (unshare -rn), garanti par le noyau
4. journal des requêtes : échec si l'une sort de file:// ou de la boucle
   locale. C'est le test des couches 1 à 3, donc un critère d'acceptation.
Faisabilité de unshare sur Cloud Run : question de T3, non traitée ici.
Si indisponible, les couches 1, 2 et 4 restent.

--variables / data-composition-variables existent dans la 0.8.83 (le §5.1
se trompe sur ce point), mais on ne s'en sert PAS : la composition est
déjà résolue, l'injection produit un HTML complet et autonome, et un
second système de variables couplerait au moteur (coût d'un changement
de moteur, D7).

═══ 9. DÉCISIONS DU 28/09 APRÈS LE TEST SANS RÉSEAU ═══

Mesuré : le rendu aboutit sous unshare -rn avec la boucle locale active
(8 s, 30 frames, pixels identiques au rendu avec réseau). Il échoue si la
boucle locale est coupée (ENETUNREACH) : le moteur sert les fichiers par
un serveur HTTP local et pilote Chrome par la boucle locale.

Couche 4 : voir §11 (règle reformulée au niveau des octets ; l'ancienne
formulation « toute requête dont l'hôte n'est ni 127.0.0.1 ni ::1 », au
niveau de l'appel système, était fausse).

Chrome n'est pas épinglé par hyperframes@0.8.83 : le moteur télécharge
son Chrome au premier rendu (~/.cache/hyperframes/chrome, 12 min ici ;
HeadlessChrome/152.0.7977.30 mesuré). Conséquences :
- ce qui est épinglé en production, c'est l'image du conteneur.
  ops.template.moteur_version seul ne reproduit pas un rendu : il faut le
  couple moteur + Chrome.
- la version de Chrome figure dans le rapport T0 et dans chaque relevé
  de déterminisme.
- l'image de job-produce DOIT embarquer Chrome : 12 min de téléchargement
  font dépasser le budget de 20 min d'ASSETS_READY, et le watchdog
  conclurait à un job mort. Condition de fonctionnement, pas optimisation.

Licence de police : la consigne « dans le manifeste » était une erreur
de catégorie (B4 ne gouverne que les Brand Packs, T0 n'en a pas). Le
commit 3d7d614 (fichiers, OFL.txt, origine et sha256) suffit. Pas de
fragment. La correspondance HM-Demo-Sans → fichier → OFL → Inter 4.1 vit
dans un commentaire à côté du @font-face ; elle rejoindra un vrai Brand
Pack en T2. Un client de démonstration est impossible (wa_phone_e164
NOT NULL, et la liste blanche D25 est cette table).

É-16, à trancher en T2 : typography.fonts[].asset_uri impose
^brand/cli_…/, faux pour le Brand Pack de démonstration de T13, qui est
une ressource partagée. Piste : élargir comme owner.scope le fait déjà.

═══ 10. DÉCISIONS DU 28/09 SUR L'ÉTAPE 2 ═══

É-17, BLOQUANT POUR T2 : layer et text_element n'ont pas de slot_id. La
liaison composition → [data-slot] se déduit par le rôle ; en T0 chaque
rôle est unique, l'injection échoue si deux slots acceptent le même rôle
au lieu de choisir. Correctif prévu : slot_id sur layer et text_element
(même motif que montage_plan.scenes[].broll[].slot_id), R3 étendue à
composition ↔ manifeste. Formulation pour le rapport : « T11 tient entre
le manifeste et le HTML, pas entre la composition et le HTML. »

É-18 : provenance.source n'a pas de valeur pour un asset de fixture ou de
démonstration (ast_demo_* de T13 compris). Correctif : un terme ajouté à
l'énumération, sans champ requis supplémentaire.

Fixtures : JSON strictement valide + fichier compagnon
fixture-X.omissions.json (chemin précis et raison de chaque omission).
Validation par ajv contre le vrai schéma, en ne relâchant que les
required déclarés. Jamais de commentaires en tête de JSON.

Fixture C : le rétrécissement doit aboutir au-dessus de
min_font_size_px. La voie de rejet de R5 se teste par un test unitaire du
lint (boîte fabriquée), pas par une quatrième vidéo.

Lint : toutes les frames (450 seeks), pas d'échantillonnage. Chronométré
et reporté au rapport : c'est la mesure qui dira s'il faut échantillonner
en production.

═══ 11. RÈGLE RÉSEAU DU RENDU (remplace la couche 4 du §9) ═══

Principe : c'est la donnée qui franchit, pas l'appel système. R11 parle
de fetch réseau et d'uri distante ; la formulation opérationnelle du §9
était plus stricte que le contrat. Correction du brief, pas un écart.

Un rendu échoue si une donnée franchit la frontière :
- toute connexion TCP vers une adresse hors boucle locale ;
- tout envoi d'octets sur un descripteur associé à une adresse hors
  boucle locale ;
- toute connexion UDP vers une adresse hors boucle locale, SAUF la sonde
  de joignabilité IPv6 de Chrome, définie par la conjonction de :
  AF_INET6 et SOCK_DGRAM ; connect() vers exactement
  2001:4860:4860::8888 port 443 ; zéro appel d'envoi (write, send,
  sendto, sendmsg, sendmmsg) sur ce descripteur de socket() à close().
Toute tolérance est nommée, pinée à une adresse, et se retourne en échec
dès qu'un octet part. Pas d'exception générique « UDP sans envoi ».
La sonde est consignée au rapport comme exception documentée, avec son
nombre d'occurrences.

Leçon à garder au rapport T0 : le premier rendu « propre » (seulement
127.0.0.1 ×21) était un faux négatif — le parseur ignorait l'IPv6. Un
détecteur non éprouvé raconte ce qu'on veut entendre. Même méthode sur
le lint, la conformité et le déterminisme : prouver que chaque contrôle
refuse.

Chiffres à consigner : lint 62 à 110 ms pour 450 frames (échantillonnage
inutile, en production aussi) ; rendu 29 s pour 15 s strace compris, à
remesurer sans strace pour le rapport.

═══ 12. DÉCISIONS DU 29/09 APRÈS LE RAPPORT T0 ═══

- Débit audio du silence : on garde le débit optimal. R9 amendée : « ≥ 128
  kbps » porte sur le débit déclaré, toujours ; le débit mesuré ne
  s'applique que hors silent_fallback (fcda566).
- R4 et B4 réécrites : la preuve de chargement est une FontFace « loaded »
  de la famille privée ; document.fonts.check() ne prouve rien (80231ec).
- Espace colorimétrique décidé par la composition : champ nouveau et requis
  encode.*.video.color, BT.709 partout, plage tv (ffcd8b3). Le compilateur
  de T3 devra le produire.
- Règles issues de T0 inscrites : T11 (état à t = 0 dans le DOM,
  will-change sur toute opacité animée) et §5.1 règles 6 et 7 (un worker,
  x264 à un thread) (13c9dc1).
- T0-technique clos : recette verte au commit 13c9dc1 (docs/rapport_T0.md).
  Portes ouvertes par ce verdict : compilateur, templates supplémentaires
  (T2). Toujours fermées : audio et Monteur (T0b), critère B (assets client).

═══ 13. É-17 CORRIGÉ (29/09) ═══

layer.slot_id et text_element.slot_id, requis, motif ^slot_[a-z0-9_]{2,32}$
(comme montage_plan.scenes[].broll[].slot_id). R3 étendue : composition ↔
manifeste (slot existant, nature compatible, rôle accepté, au plus un
élément par slot, slots requis remplis ou dégradation T9 journalisée).
L'injection suit slot_id, ne déduit plus rien du rôle.

É-20, à trancher : layer.role {background, subject, broll, logo, overlay}
et accepts_roles {subject, background, logo, supporting} ne se recouvrent
pas ; broll et overlay ne sont acceptés par aucun slot. Aucune
correspondance inventée : R3 exige le rôle littéralement.
