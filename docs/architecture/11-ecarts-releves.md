> Architecture d'exécution v1 — extrait du §11, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

## 11. Écarts relevés

Aucun de ces points ne modifie une décision ni un contrat. Ils signalent
des endroits où deux décisions se contredisent, où un contrat laisse un
trou que le runtime doit boucher, ou bien ils déclarent une décision
d'exécution prise ici.

### 11.1 Contradictions entre décisions

**É-1 — `generation_key` ne contient pas le `client_id`.** Le contrat la
définit comme `sha256(provider | model | prompt | negative_prompt | seed
| params)`. Deux clients qui demandent la même image avec le même modèle
et le même *seed* produisent donc la **même clé**. L'idempotence de R12
servirait alors au second client l'asset du premier, dont
`owner.client_id` est celui du premier : R17 le rejette au validateur,
donc la fuite ne passe pas en production — mais elle est détectée tard,
et la comptabilité de budget est fausse entre-temps. Correction minimale,
qui respecte le contrat à la lettre : **l'index d'unicité en base porte
sur `(client_id, generation_key)`**, et `provenance.generation_key` garde
exactement la valeur du contrat. La recherche d'idempotence est alors
toujours bornée au client, et deux clients paient chacun la leur — ce qui
est voulu (D30). **Appliqué aux contrats le 28/09** : le `$comment` de
`provenance.generation_key` porte désormais la règle, et R12 recherche
sur `(client_id, generation_key)`.

**É-2 — `FAILED` est terminal dans le diagramme, mais le canal admin
promet une relance « depuis le dernier état ».** Les deux ne peuvent pas
être vrais. J'ai tranché dans le sens de l'utilité :
`ops.projet.etat_avant_echec` et la transition T17. Écart **assumé et
signalé** ; sans lui, `E_QUOTA_FOURNISSEUR` détruirait un projet dont
tous les assets sont payés et valides, ce qui contredit la règle de
reprise.

**É-3 — D8 sur l'offre gratuite est incompatible avec D36.** Un projet
Supabase gratuit est mis en pause après inactivité ; un service 24 h/24
dont la base peut s'endormir n'est pas un service 24 h/24. Ce n'est pas
un point « à vérifier » mais une ligne de coût à accepter avant T3. D8
n'est pas remise en cause — seulement l'offre.

**É-4 — D26 et D27 se recouvrent exactement, et c'est trop juste.** La
correction factuelle est due 7 jours, la rétention est de 7 jours : le
client qui signale une erreur le septième jour trouve les assets purgés,
et la correction devient une régénération payante. D'où la fenêtre
différenciée du §2.10 : `clos_le + 10 jours` pour ce dont une correction
a besoin. Trois jours de R2 de plus pour une trentaine de projets coûtent
quelques centimes.

**É-5 — D7, D16 et D34 sont un seul pari, pas trois décisions.** Le lint
DOM pré-rendu (D16, donc R5/R7/R8) et les templates à emplacements
déclarés (D34, donc T11) présupposent tous deux un moteur à DOM. Si
HyperFrames n'en est pas un, ils tombent **ensemble** avec D7, et c'est
le bloc qualité au meilleur rapport effort/risque qui disparaît. T0 doit
tester le moteur contre ces deux décisions explicitement (§10.4), pas
seulement contre la qualité perçue.

**É-6 — D35 borne un projet, pas un mois.** Un plafond par type de job
n'empêche pas soixante projets d'échouer chacun à la limite de son
plafond. L'exposition réelle est `plafond × nombre de projets`, et une
boucle de relances reste invisible tant que chaque projet est dans les
clous. D'où `plafond_mois_c` et l'alerte P2 à 80 %. Condition de sûreté
de D35, pas modification.

**É-7 — R14 mesure le mauvais instant.** La règle exige que
`sfx.start_ms` égale le `start_ms` de l'événement à ±1 frame. Or
`start_ms` est la position du **fichier** sur la timeline, et l'instant
perçu est celui de l'**attaque**, qui peut arriver 90 ms plus tard. Un
son parfaitement calé à l'oreille échouerait donc la règle, et un son
conforme à la règle tomberait en retard. Le runtime résout en stockant
`attaque_ms` par piste (§2.6) et en calant l'attaque ; **le contrôle R14
doit porter sur `start_ms + attack_ms`**, pas sur `start_ms`.
**Appliqué aux contrats le 28/09** : `sfx.attack_ms` est désormais un
champ requis de la composition, et R14 contrôle la somme.

**É-8 — D24 fait valider au client une durée qui n'existe pas encore.**
Depuis D20 la durée est une conséquence de l'alignement ; le storyboard
n'en porte qu'une cible. Le client valide donc « 15 s » et peut recevoir
19 s. R13 le prévoit déjà — avertissement au-delà de ±25 %, sans rejet,
« le client a validé un texte, pas un chronométrage » — et S5 borne le
script en amont. La tension subsiste et elle est structurelle : à couvrir
par une durée annoncée arrondie (« ≈ 15 s ») plutôt que par un chiffre.

**É-9 — D32 protège notre coût, pas le client.** La licence Pixabay
autorise l'usage commercial mais n'accorde ni exclusivité ni transfert :
le client qui reçoit la pub n'acquiert aucun droit sur la musique, et une
revendication Content ID reste possible s'il la diffuse ailleurs.
L'architecture garde la preuve (`ops.usage_audio`, `licence_snap`, R16) ;
elle ne peut pas créer le droit. À dire au client en une phrase à la
livraison, et à considérer comme la vraie raison de passer à ACE-Step,
bien avant l'unicité sonore.

**É-10 — « réduire le délai vers quelques minutes » reste hors
d'atteinte.** Le plancher technique est de 6 à 10 min : démarrage à froid
du Job GPU (2 à 4 min, sauf si É-15 le supprime), générations fal.ai,
rendu (cible T0 : 5 min), mixage, deux encodages, envois. C'est une
ambition produit, pas une contrainte d'architecture : il ne faut pas
concevoir contre elle aujourd'hui.

**D22 ∧ D36 : résolu, mais par un engagement, pas par l'architecture**
[D-28/09]. Franco valide lui-même, y compris la nuit. La machine à états
se ferme donc telle qu'elle est dessinée : `PENDING_REVIEW` garde
`abandon_apres_s = NULL`, aucune arête automatique n'est ajoutée, et le
point ouvert B1 disparaît. Deux instruments restent en place, et il ne
faut pas les retirer sous prétexte que la décision est prise :
`PENDING_REVIEW` continue de compter dans l'horloge de service (§3.4),
ce qui **mesure le prix réel de cet engagement** ; et `history.revue`
continue d'accumuler les paires refus / motif / plan accepté, sans quoi
l'automatisation promise par D22 n'aura jamais de données. Au quatrième
client, cette décision se rediscutera avec des chiffres.

**É-11 — « voix off au choix du client » (D19) n'a pas encore d'objet.**
D31 fixe le moteur mais pas le nombre de voix françaises réellement
utilisables. Si T0b en donne deux, « au choix » est un mot de trop dans
la promesse commerciale.

**É-12 — deux écarts de lettre, assumés, sur D2 et D3.** D2 confie au
classifieur l'aiguillage du canal admin : ici le numéro admin est reconnu
**avant** tout appel de LLM (§4.1, §8.1), car faire dépendre la surface
d'administration d'une décision de LLM est une mauvaise idée pour un gain
nul. D3 place les deux agents LLM « dans le Job » : le Storyboard tourne
dans `svc-conversation`, puisque D24 exige que le client le valide
**avant** que le Job ne démarre. Le Monteur, lui, est bien dans le Job.

**É-13 — R10 mélange deux obligations qui n'ont pas le même domaine**
[D-28/09]. La règle exige à la fois qu'une piste audio existe **dans tous
les cas** — y compris silencieuse, via `anullsrc`, parce qu'un MP4 sans
piste est refusé silencieusement par certains clients — et que le volume
intégré vaille -14 LUFS ±1. Or une piste silencieuse mesure -∞ LUFS :
elle ne peut, par construction, jamais satisfaire la seconde. R10 se lit
donc comme **deux contrôles indépendants** : présence, format, canaux et
fréquence d'échantillonnage s'appliquent toujours ; volume intégré et
crête vraie ne s'appliquent que si `audio.silent_fallback` est faux. Le
vérificateur consigne « non applicable : silent_fallback » — ni un succès,
ni un rejet. Ce n'est pas une concession de T0, c'est le comportement
permanent et correct.

**É-14 — R11 confond le déterminisme du moteur et celui de l'encodeur**
[D-28/09]. Le test d'acceptation dit « comparer les checksums vidéo et
audio ». Mais deux choses distinctes peuvent diverger : les **frames
capturées**, qui mesurent le moteur, et le **fichier encodé**, qui mesure
x264 — lequel n'est pas garanti reproductible selon le *threading*, sans
qu'une seule image diffère. Le `hash_frames` du contrat d'adaptateur
(§5.1) et de `history.livraison` porte sur **les frames** : c'est lui qui
fait foi. Le hash de fichier est informatif ; s'il diffère alors que les
frames concordent, on épingle le *threading* de l'encodeur, on ne déclare
pas un échec de déterminisme. Les deux se mesurent séparément.

**É-15 — le GPU du Job TTS n'est peut-être pas nécessaire** [D-28/09].
D31 fixe « Chatterbox Multilingual sur Cloud Run Job avec GPU L4 ». Le
modèle est sous licence MIT : ce qui coûte, c'est la machine. Or le
besoin réel est d'environ 30 secondes de parole deux fois par jour, et
l'inférence CPU tiendrait probablement dans le budget de 30 minutes de
`GENERATING`. L'intérêt n'est pas l'économie — 2 min de L4 coûtent peu —
mais la suppression de **cinq dépendances** : la carte acceptée par
Google Cloud (B5), le quota L4, une image de plusieurs gigaoctets, un
démarrage à froid de 2 à 4 min dans le plancher de latence, et une unité
de déploiement entière. **Écart à trancher par la mesure en T0b**, pas
par délibération. Seuil : si 8 scènes de 4 secondes se synthétisent en
moins de 5 minutes sur 8 vCPU, `job-tts` disparaît et B5 avec lui.

### 11.2 Décisions d'exécution prises par ce document

Elles ne contredisent rien ; elles ferment un choix que les contrats
laissent ouvert.

| Décision | Motif |
|---|---|
| `canvas.fps = 30` pour tous les projets, alors que le contrat admet 24, 25 et 30 | une seule valeur retire une variable des tests de déterminisme et des contrôles de fréquence fixe. À rouvrir si une plateforme l'exige. |
| `ops.musique_livree` n'est écrite qu'à la **livraison** | une piste choisie pour un projet qui échoue ne doit pas être consommée pour un an |
| Pas de plan par défaut si le Monteur échoue deux fois | livrer un montage plat en prétendant que le Monteur a travaillé est pire qu'une alerte (§6.1) |
| Prompt du Monteur sans aucun horodatage | empêche à la source un raisonnement en millisecondes (§6.2) |
| Un seul Job CPU pour les trois pipelines | D28 est satisfaite par la disjonction du code, pas par celle du déploiement (§1.1) |
| RLS écartée au profit de clés étrangères composites | un seul backend de confiance ; la menace visée est l'erreur de code (§2.1) |

---
