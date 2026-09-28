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
