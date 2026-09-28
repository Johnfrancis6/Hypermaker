> Architecture d'exécution v1 — extrait du §4, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

## 4. Services, Jobs et flux

### 4.1 `svc-conversation`

Une instance, toujours chaude, CPU toujours alloué, `max-instances=2`
pour ne pas perdre le webhook pendant un déploiement. Le watchdog et la
purge sont protégés par `pg_try_advisory_lock`, donc une seconde
instance ne les double pas.

| Entrée HTTP | Rôle | Contrainte |
|---|---|---|
| `POST /webhook` | réception Meta | vérifie `X-Hub-Signature-256` (HMAC-SHA256 du corps **brut**, comparaison à temps constant), insère `ops.message_entrant`, répond **200 en moins d'une seconde**, ne traite rien avant d'avoir répondu |
| `GET /webhook` | vérification Meta (`hub.challenge`) | — |
| `GET /sante` | contrôle de disponibilité | 503 si watchdog en retard |
| `POST /interne/job-fini` | fin de `job-produce` | OIDC, compte de service dédié |

Boucles internes : **watchdog** (60 s) et **maintenance** quotidienne
(purge §2.10, archivage, relevé des dépenses du mois).

Le traitement d'un message entrant a lieu *après* la réponse HTTP, dans
la même instance, et son ordre n'est pas négociable :

1. **Copier le média sur R2** s'il y en a un. L'URL Meta expire en
   quelques minutes et il n'existe pas de boîte de réception : ce qui
   n'est pas copié est perdu. Cette étape passe **avant** toute logique,
   avant même de savoir si le numéro est en liste blanche — on jette
   ensuite si nécessaire.
2. **Aiguiller** : numéro admin (§8) → liste blanche (D25) →
   classifieur.
3. **Traiter** l'état courant du projet.
4. `traite_le = now()`.

Si l'instance meurt entre 1 et 4, le message reste non traité et la
boucle de maintenance le reprend. Le média, lui, est déjà sauvé.

### 4.2 `job-produce`

Image : Node 22, FFmpeg 7, Chrome headless, **polices du Brand Pack
installées dans l'image** — aucune police téléchargée à l'exécution
(R4, R11).

Paramètres : `PROJET_ID`, `ETAT_ATTENDU`, `EXECUTION_ID`.
`--task-timeout=45m`, `--max-retries=0` : les relances sont décidées par
le watchdog, pas par Cloud Run, qui ne sait pas si l'échec est
rattrapable et relancerait un appel payant.

Le job commence par **prendre le bail** (`UPDATE … WHERE projet_id = $1
AND etat = $2 AND (bail_jusqu_a IS NULL OR bail_jusqu_a < now())`) ;
zéro ligne modifiée ⇒ il sort immédiatement en succès. C'est ce qui rend
inoffensif un double déclenchement (client + watchdog).

Trois pipelines disjoints après le bail :

- **`video`** : §6 et §7, la seule qui appelle `job-tts` ;
- **`visuel`** : génération d'image, composition d'une frame par le même
  moteur, lint de zone de sécurité (R5), export JPEG/PNG ≤ 5 Mo sans
  transparence, livraison ;
- **`retouche`** : pipeline séparé (D28) — ni storyboard, ni Monteur, ni
  template. Entrée : photo du client + consigne. Il partage la prise de
  bail, l'adaptateur de génération, `ops.generation`, les contrôles de
  format et la livraison, et ne passe jamais par `ASSETS_READY`.

### 4.3 `job-tts`

Image : Python, Chatterbox Multilingual, **poids du modèle inclus dans
l'image** (pas de téléchargement au démarrage : déterminisme et
démarrage à froid), aligneur forcé embarqué. `europe-west4` ou
`europe-west1` selon la disponibilité L4, `--task-timeout=15m`,
`--max-retries=0`.

Paramètres : `PROJET_ID`, `SCENES` (identifiants à synthétiser ; vide =
toutes celles qui manquent).

Entrée et sortie par R2 et Postgres uniquement, **jamais par HTTP** : le
job lit le storyboard (script, voix, lexique de prononciation du Brand
Pack — B14), écrit les `voix_scene`, l'`alignement`, inscrit ses lignes
`ops.objet` et `ops.generation`, puis sort. Il n'a le droit d'écrire que
ces rôles, et **il ne touche jamais `ops.projet.etat`** : c'est
`job-produce` qui décide de la transition. Un seul écrivain d'état par
projet, c'est ce qui permet de se passer de verrou distribué.

**Qui attend qui.** `job-produce` déclenche `job-tts` par l'API Cloud Run
Admin et **attend sa fin** en interrogeant l'exécution toutes les 10 s.
La variante « `job-tts` rappelle `job-produce` » économiserait quelques
minutes de CPU à 2 projets par jour et ajouterait un point de reprise, un
rappel HTTP et une transition : écartée. En revanche `job-produce`
**lance les générations fal.ai en parallèle de la synthèse** — ce sont
les deux dépenses les plus lentes et elles sont indépendantes.

### 4.4 Flux entre unités

| Flux | Transport | Idempotence assurée par |
|---|---|---|
| Meta → `svc` | HTTPS + HMAC | PK `wa_message_id` |
| `svc` → Meta | HTTPS + token permanent (System User) | `cle_envoi` unique |
| `svc` → `job-produce` | API Cloud Run Admin, OIDC | bail + garde d'état |
| `job-produce` → `job-tts` | API Cloud Run Admin, OIDC | `generation_key` + `ops.objet` |
| `job-*` → `svc` | **rien** : uniquement Postgres | transition gardée |
| `job-*` ↔ R2 | S3 API, préfixe par client | `sha256` + `objet_r2_unique` |
| fal.ai, LLM | HTTPS via adaptateur | `generation_key` |

Il n'y a **aucun appel HTTP d'un job vers le service** dans le chemin
nominal : `/interne/job-fini` n'est qu'une accélération, et sans lui le
watchdog verrait l'état changer dans les 60 s. Les jobs communiquent par
la base. C'est la simplification qui supprime le besoin d'une file de
messages, d'un bus d'événements et de leur supervision.

### 4.5 Identités et secrets

Un compte de service par unité, droits minimaux : `svc-conversation`
peut exécuter les deux jobs, lire et écrire `ops`, insérer dans
`history` ; `job-produce` peut exécuter `job-tts` ; `job-tts` n'a aucun
droit d'exécution.

Secret Manager porte : token permanent Meta, `app_secret` Meta
(vérification de signature), clé fal.ai, clé LLM, identifiants R2,
empreinte de la phrase de passe admin (§8.4), URL Postgres. Aucun secret
en variable d'environnement en clair, aucune clé dans une image.

---
