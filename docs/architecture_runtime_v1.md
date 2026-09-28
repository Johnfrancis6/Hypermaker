# Architecture d'exécution — v1

*Rédigé le 28/09/2026, à partir du document d'état du 26/09/2026 et des
contrats de `setup/`. Révisé le 28/09 au soir : sept décisions prises
en session sont intégrées et repérées par **[D-28/09]**. Les décisions D1 à D36 sont tenues pour acquises :
ce document les met en œuvre, il ne les rediscute pas. Les désaccords
sont rassemblés au §11, sans effet ailleurs.*

---

## 0. Où s'arrête ce document

`setup/` contient déjà la **couche contrats**, écrite le 26 septembre et
alignée sur D1–D36 :

| Contrat | Rôle | Règles |
|---|---|---|
| `Storyboard.schema.json` v2 | intention : quoi dire, dans quel ordre, avec quelle voix | S1–S11 |
| `Montage plan.schema.json` v1 | décisions du Monteur, vocabulaire fermé | M1–M15 |
| `Composition.schema.json` v2 | valeurs résolues, consommées par le moteur | R1–R17 |
| `Template.schema.json` v1 | structure, slots, beats, dégradation | T1–T13 |
| `Brandpack.schema.json` v2 | tokens, signature de mouvement, sons, voix | B1–B15 |

**Ce document ne réécrit aucun de ces contrats et n'en amende aucun.**
Les amendements que le document d'état demandait — durées cibles et
script de voix off dans le storyboard, pistes audio dans la composition,
nouveau `montage_plan` — **sont déjà appliqués** dans `setup/` :
`duration_target_s`, `voiceover_script`, le bloc `audio` complet avec
`voiceover.alignment`, et le contrat `montage_plan` v1. Il n'y a rien à
amender ; les écarts entre ce que j'aurais écrit et ce qui est écrit sont
au §11.

Ce document couvre ce que `setup/` ne couvre pas : **ce qui exécute les
contrats**.

| Couvert ici | Couvert par `setup/` |
|---|---|
| Schéma Postgres `ops` et `history` | forme des documents JSON |
| Machine à états, watchdog, reprises | règles de validation S/M/R/T/B |
| Services et Cloud Run Jobs, flux | — |
| Adaptateurs de rendu et de génération | `provenance.generation_key` |
| Production audio : TTS, alignement, mixage | validation audio (R10, R13–R15) |
| Orchestration du Monteur et du compilateur | vocabulaire et menu (M3) |
| Canal admin, erreurs, alertes | — |
| Plan d'implémentation T-1 → T4 | — |

**Critère de tri appliqué partout** : 3 clients, ~60 projets par mois,
soit **2 projets par jour**. À cette échelle, tout mécanisme qui n'existe
que pour absorber la charge est de la sur-ingénierie. Aucune file de
messages, aucun cache distribué, aucun service par étape. Postgres est la
file, le verrou et la source de vérité ; R2 porte les octets ; Cloud Run
exécute. Ce qui pilote réellement la conception est ailleurs :
l'**idempotence** (le coût dominant est la génération), l'**isolation**
(D30, R17, M15), le **délai de 4 h en 24/7** (D36) et la **conformité
binaire** de la sortie (R9, R10).

**Règle de reprise** : un état est un point de reprise, et aucun état
n'est franchi avant que ses artefacts soient durables sur R2 et inscrits
en base (D10, R12). Un job relancé depuis l'état courant ne repaie donc
jamais ce qui précède. À l'intérieur d'un état, c'est la
`generation_key` qui protège chaque appel payant. Les deux mécanismes
sont complémentaires : l'un est grossier, l'autre fin.

---

## 1. Vue d'ensemble

### 1.1 Trois unités de déploiement

| Unité | Type | Machine | Rôle |
|---|---|---|---|
| `svc-conversation` | Cloud Run Service | 1 vCPU, 512 Mo, `min-instances=1`, **CPU toujours alloué** | webhook, classifieur, clarificateur, Storyboard, canal admin, envois WhatsApp, watchdog, purge |
| `job-produce` | Cloud Run Job | 4 vCPU, 8 Go, Node + FFmpeg + Chrome headless | menu, Monteur, compilateur, validateurs, rendu, mixage, encodage, livraison |
| `job-tts` | Cloud Run Job | GPU L4 24 Go, `europe-west4` | synthèse Chatterbox + alignement forcé |

`svc-conversation` a **CPU toujours alloué** parce qu'il fait trois
choses qui ne tiennent pas dans le cycle requête/réponse : copier le
média entrant sur R2 avant expiration de l'URL, tenir le watchdog toutes
les 60 s, vider la file d'envoi. Déléguer cela à un Job ajouterait un
démarrage à froid de 10 à 15 s sur le chemin le plus sensible — le média
entrant, qui est perdu s'il n'est pas copié — pour économiser une
vingtaine de dollars par mois.

Le GPU est séparé parce que la machine est différente et chère : il est
tenu ~2 min par projet au lieu de l'être pendant tout le rendu.

**Un seul Job CPU pour trois pipelines.** D28 exige que la retouche
photo soit un pipeline séparé ; elle l'est, comme chemin de code disjoint
qui ne passe ni par le storyboard, ni par le Monteur, ni par
`ASSETS_READY`. Trois images de conteneur pour trois chemins qui
partagent la prise de bail, l'adaptateur de génération, les contrôles de
format et la livraison coûteraient trois déploiements pour zéro
isolation supplémentaire.

### 1.2 Flux nominal, projet vidéo

```
WhatsApp ──► svc-conversation ──────────────────► Postgres / R2
   POST webhook
   ├─ vérif X-Hub-Signature-256
   ├─ INSERT message_entrant (PK = wa_message_id)   ← dédup structurelle
   ├─ 200 en moins d'une seconde
   ├─ média entrant → R2 (immédiat : URL périssable)
   ├─ numéro admin ? ──────────────► §8
   ├─ hors liste blanche ? ────────► message fixe, fin
   ├─ Classifieur (LLM) ──────────► video | visuel | retouche | hors périmètre
   ├─ Clarificateur (slots, boutons, brouillon)
   ├─ Storyboard (LLM) → S1–S11 → storyboard v_n
   └─ envoi au client pour validation (D24, S11)
            │
       validation client
            │
            ├─ plafond copié dans projet.budget_restant (D35)
            └─ exécute job-produce
                   │
              job-produce ─── ÉTAT: GENERATING
                   ├─ générations fal.ai (generation_key, R12)   ─┐ en
                   └─ exécute job-tts ────────────────────────────┘ parallèle
                          voix off par scène + alignement mot à mot
                   ─── ÉTAT: ASSETS_READY ◄── point de reprise
                   ├─ menu fermé par scène (M3)
                   ├─ Monteur (LLM) → montage_plan → M1–M15
                   ├─ compilateur → composition → R1–R8, R13–R17
                   ├─ rendu (adaptateur) → lint DOM R5, R7, R8
                   ├─ mixage audio → normalisation → R10
                   ├─ encodage preview + master → R9 bloquant
                   └─ ÉTAT: RENDERED_VERIFIED ◄── point de reprise
            │
   svc ──► aperçu + qa.checklist + dégradations T9 → Franco (D22)
            │
       validation Franco
            │
            └─ livraison double : video + document (D23)
```

### 1.3 Ce que le runtime garantit aux contrats

Les contrats décrivent des documents valides. Le runtime doit garantir
quatre choses qu'aucun schéma ne peut exprimer :

| Garantie | Mécanisme | Où |
|---|---|---|
| un appel payant n'est jamais payé deux fois | `generation_key` unique en base, réservation avant appel | §2.4, §5.2 |
| un job mort est repris sans perte | bail + transition gardée | §3.1, §3.5 |
| aucun document d'un client n'entre dans le contexte d'un autre | `client_id` sur chaque ligne, clé étrangère composite, prompt assemblé par projet | §2.1 |
| un échec est visible | `FAILED` documenté, alerte Franco, watchdog | §3.5, §9 |

---

## 2. Schéma Postgres

Un seul Postgres (D8), deux schémas dont la frontière est un **cycle de
vie**, pas un domaine :

- **`ops`** : l'ensemble de travail. Mutable, petit, purgé après la
  clôture du projet (D27). Porte des clés R2 vers des octets eux-mêmes
  périssables.
- **`history`** : métadonnées permanentes, **append-only**, sans média et
  sans clé R2 vivante. C'est ce qui reste quand R2 a été purgé : les
  transitions, l'audit, les livraisons, les dépenses, et les paires
  *plan refusé / motif / plan accepté* qui serviront à calibrer un juge
  automatique (D22, fin de `Montage plan.rules.md`).

Volumétrie à 12 mois : ~720 projets, ~8 000 générations, ~20 000
messages. Tout tient dans la plus petite instance. Aucun
partitionnement, aucune recherche plein texte.

### 2.1 Identifiants et isolation

Les identifiants **sont ceux des contrats**, pas des UUID : `proj_`,
`cli_`, `bp_`, `tpl_`, `ast_`, `sc_`, `dec_`, `voice_`, `fnt_`. Les
colonnes sont donc du `text` avec la contrainte de motif du schéma JSON.
Le bénéfice est direct : une clé lue dans un `composition.json` se colle
telle quelle dans une requête SQL, sans table de correspondance et sans
risque de confondre deux espaces de noms.

L'isolation (D30, R17, M15) repose sur trois mécanismes, par fiabilité
décroissante :

1. **`client_id NOT NULL` partout, et clé étrangère composite** vers
   `ops.projet (projet_id, client_id)`. Une ligne d'un client rattachée
   au projet d'un autre est *impossible*, pas seulement interdite : la
   base la rejette. C'est le mécanisme central et il ne coûte qu'une
   colonne dénormalisée.
2. **Préfixe R2 par client**, vérifié par contrainte `CHECK` sur la clé
   (§2.3) : `clients/{client_id}/…`, `brand/{client_id}/…`. La
   bibliothèque audio partagée vit sous `library/audio/…` et n'a pas de
   `client_id` — c'est le `scope: shared` de `resolved_asset.owner`.
3. **Contexte LLM assemblé par projet, jamais cumulatif.** La charte
   (D5) vient du Brand Pack du client courant. Aucun cache de prompt
   partagé entre clients, aucun exemple d'un autre client, conformément à
   M15 et à la section « ce que reçoit le Monteur ».

**RLS écarté.** Un seul backend de confiance, trois clients, aucun accès
direct à la base depuis l'extérieur : des politiques RLS à maintenir et à
déboguer pour une menace qui n'existe pas dans ce déploiement. Les clés
étrangères composites attrapent la seule erreur réaliste, qui est une
erreur de code. À reconsidérer le jour où un client obtient un accès
direct.

### 2.2 Types

```sql
CREATE SCHEMA ops;
CREATE SCHEMA history;

CREATE TYPE ops.statut_client AS ENUM ('actif', 'pause', 'retire');

CREATE TYPE ops.type_job AS ENUM ('video', 'visuel', 'retouche');

-- Valeurs du diagramme du document d'état.
CREATE TYPE ops.etat_projet AS ENUM (
  'RECEIVED', 'REJECTED', 'CLARIFYING', 'BRIEF_READY',
  'STORYBOARD_PENDING_CLIENT', 'GENERATING', 'ASSETS_READY',
  'RENDERED_VERIFIED', 'PENDING_REVIEW', 'DELIVERED',
  'CORRECTION', 'FAILED'
);

-- Mêmes valeurs que montage_plan.revision_reason et
-- composition.revision_reason : un seul vocabulaire pour la reprise.
CREATE TYPE ops.motif_revision AS ENUM
  ('initial', 'review_rework', 'correction');

CREATE TYPE ops.role_objet AS ENUM (
  'asset_client', 'brand_asset', 'police',
  'storyboard', 'montage_plan', 'composition',
  'asset_genere', 'voix_scene', 'alignement',
  'rendu_muet', 'mix_final', 'master', 'apercu',
  'frame_capture', 'trace_resolution', 'rapport_conformite',
  'visuel', 'retouche'
);

CREATE TYPE ops.statut_generation AS ENUM
  ('reserve', 'en_cours', 'reussie', 'echouee', 'abandonnee');

CREATE TYPE ops.statut_publication AS ENUM
  ('brouillon', 'en_validation', 'publie', 'retire');

CREATE TYPE ops.statut_envoi AS ENUM ('en_file', 'envoye', 'echoue');

CREATE TYPE ops.kind_envoi AS ENUM
  ('texte', 'interactif', 'video', 'document', 'image', 'template_utility');

CREATE TYPE ops.commande_admin_nom AS ENUM (
  'client_ajouter', 'client_retirer', 'client_pause', 'client_reprendre',
  'plafond_modifier', 'livraison_valider', 'livraison_refuser',
  'style_approuver', 'job_relancer', 'etat_lire', 'depenses_lire',
  'donnees_supprimer'
);

CREATE TYPE ops.statut_commande AS ENUM
  ('proposee', 'confirmee', 'executee', 'refusee', 'expiree');

CREATE TYPE ops.au_depassement AS ENUM ('relancer', 'alerter');

CREATE TYPE ops.kind_job AS ENUM ('produce', 'tts');
```

### 2.3 Clients, projets, objets

```sql
CREATE TABLE ops.client (
  client_id      text PRIMARY KEY
                 CHECK (client_id ~ '^cli_[a-z0-9]{6,32}$'),
  wa_phone_e164  text NOT NULL
                 CHECK (wa_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  nom_affiche    text NOT NULL,
  statut         ops.statut_client NOT NULL DEFAULT 'actif',
  langue         text NOT NULL DEFAULT 'fr',
  -- Brand Pack courant : raccourci de lecture. La version qui FAIT FOI
  -- pour un projet est figée dans ops.projet (M1 : le plan utilise la
  -- version référencée par le storyboard, pas la dernière publiée).
  brand_pack_id       text,
  brand_pack_version  integer,
  cree_le        timestamptz NOT NULL DEFAULT now(),
  maj_le         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_bp_coherent
    CHECK ((brand_pack_id IS NULL) = (brand_pack_version IS NULL))
);

-- La liste blanche (D25) EST cette table : un numéro joignable est un
-- client non retiré. Pas de table dédiée.
CREATE UNIQUE INDEX client_phone_unique
  ON ops.client (wa_phone_e164) WHERE statut <> 'retire';

CREATE TABLE ops.projet (
  projet_id           text PRIMARY KEY
                      CHECK (projet_id ~ '^proj_[a-z0-9]{6,32}$'),
  client_id           text NOT NULL REFERENCES ops.client (client_id),
  type_job            ops.type_job NOT NULL,
  etat                ops.etat_projet NOT NULL DEFAULT 'RECEIVED',
  etat_depuis         timestamptz NOT NULL DEFAULT now(),
  tentatives_etat     smallint NOT NULL DEFAULT 0,

  -- horloge de service : n'accumule que le temps qui nous appartient (§3.4)
  sla_cumul_ms        bigint NOT NULL DEFAULT 0,
  sla_alerte_envoyee  boolean NOT NULL DEFAULT false,

  -- plafond D35 / R12 : copié à l'entrée en GENERATING, décrémenté
  -- avant chaque appel payant, dans la transaction de réservation
  budget_centimes     integer NOT NULL DEFAULT 0,
  budget_restant      integer NOT NULL DEFAULT 0,

  brief               jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand_pack_id       text,
  brand_pack_version  integer,
  voix_id             text CHECK (voix_id ~ '^voice_[a-z0-9_]{2,32}$'),

  -- versions courantes des trois contrats du projet
  storyboard_version  integer,
  montage_plan_version integer,
  composition_version integer,
  reworks             smallint NOT NULL DEFAULT 0,   -- M13 : 2 au maximum

  -- bail d'exécution : empêche deux jobs sur le même projet
  bail_par            text,
  bail_jusqu_a        timestamptz,

  code_echec          text,
  detail_echec        jsonb,
  etat_avant_echec    ops.etat_projet,   -- voir §11, écart É-2

  cree_le             timestamptz NOT NULL DEFAULT now(),
  livre_le            timestamptz,
  clos_le             timestamptz,

  CONSTRAINT projet_client_unique UNIQUE (projet_id, client_id),
  CONSTRAINT projet_budget_positif CHECK (budget_restant >= 0),
  CONSTRAINT projet_budget_borne   CHECK (budget_restant <= budget_centimes),
  CONSTRAINT projet_bail_coherent
    CHECK ((bail_par IS NULL) = (bail_jusqu_a IS NULL)),
  CONSTRAINT projet_echec_documente
    CHECK (etat <> 'FAILED' OR code_echec IS NOT NULL),
  CONSTRAINT projet_reworks_bornes CHECK (reworks BETWEEN 0 AND 2)
);
```

Trois contraintes portent à elles seules une décision :

- `budget_restant >= 0` **est** D35 et R12. Le décrément et l'insertion
  de la ligne `ops.generation` sont dans la même transaction : un
  dépassement fait échouer la transaction **avant** l'appel au
  fournisseur. La limite stricte chez fal.ai (O6-B) reste la seconde
  ligne, hors de notre contrôle.
- `projet_echec_documente` interdit un `FAILED` muet : c'est la moitié de
  O4-B écrite dans la base.
- `projet_reworks_bornes` est M13 : au plus deux reprises après un refus
  de Franco. À la troisième, le problème n'est pas le montage.

```sql
CREATE INDEX projet_a_surveiller
  ON ops.projet (etat, etat_depuis)
  WHERE etat NOT IN ('DELIVERED', 'REJECTED', 'FAILED');

CREATE INDEX projet_bail_expire
  ON ops.projet (bail_jusqu_a) WHERE bail_jusqu_a IS NOT NULL;

CREATE INDEX projet_par_client ON ops.projet (client_id, cree_le DESC);
```

**`ops.objet` : l'inventaire R2.** Une seule table pour tout ce qui a des
octets — assets entrants, assets générés, contrats, voix par scène,
master, aperçu. C'est ici que se lit la reprise : avant de produire un
artefact, on cherche la ligne ; si elle existe avec le bon `sha256`, on
saute l'étape.

```sql
CREATE TABLE ops.objet (
  asset_ref    text NOT NULL
               CHECK (asset_ref ~ '^ast_[a-z0-9_]{3,40}$'),
  client_id    text NOT NULL REFERENCES ops.client (client_id),
  projet_id    text,                  -- NULL pour brand/ et polices
  role         ops.role_objet NOT NULL,
  scene_id     text CHECK (scene_id ~ '^sc_[a-z0-9]{2,16}$'),
  version      integer NOT NULL DEFAULT 1,
  r2_key       text NOT NULL,
  mime         text NOT NULL,
  octets       bigint NOT NULL CHECK (octets > 0),
  sha256       char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  duree_ms     integer CHECK (duree_ms IS NULL OR duree_ms > 0),
  largeur      integer,
  hauteur      integer,
  -- copie jsonb des petits contrats, pour requêter sans passer par R2
  contenu      jsonb,
  cree_le      timestamptz NOT NULL DEFAULT now(),
  expire_le    timestamptz,           -- NULL = permanent (brand/, library/)

  PRIMARY KEY (asset_ref),
  FOREIGN KEY (projet_id, client_id)
    REFERENCES ops.projet (projet_id, client_id) ON DELETE CASCADE,
  CONSTRAINT objet_prefixe_client
    CHECK (r2_key LIKE 'clients/' || client_id || '/%'
        OR r2_key LIKE 'brand/'   || client_id || '/%'),
  CONSTRAINT objet_contenu_petit
    CHECK (contenu IS NULL OR pg_column_size(contenu) < 262144),
  CONSTRAINT objet_permanent_justifie
    CHECK (expire_le IS NOT NULL OR role IN ('brand_asset', 'police'))
);

CREATE UNIQUE INDEX objet_unique_par_role
  ON ops.objet (projet_id, role, coalesce(scene_id, ''), version)
  WHERE projet_id IS NOT NULL;

CREATE UNIQUE INDEX objet_r2_unique ON ops.objet (r2_key);
CREATE INDEX objet_a_expirer ON ops.objet (expire_le)
  WHERE expire_le IS NOT NULL;
```

`objet_prefixe_client` traduit le préfixe R2 en contrainte : une clé mal
préfixée ne s'écrit pas en base, donc l'inventaire ne peut pas désigner
l'espace d'un autre client. C'est R17 rendu structurel, un cran avant le
validateur.

La bibliothèque audio partagée n'est **pas** dans `ops.objet` : elle a sa
table (§2.6), parce qu'elle n'a pas de `client_id` et qu'elle porte des
licences.

### 2.4 Générations payantes

```sql
CREATE TABLE ops.generation (
  generation_id    bigserial PRIMARY KEY,
  generation_key   char(64) NOT NULL
                   CHECK (generation_key ~ '^[a-f0-9]{64}$'),
  client_id        text NOT NULL REFERENCES ops.client (client_id),
  projet_id        text NOT NULL,
  fournisseur      text NOT NULL,      -- 'fal.ai', 'job-tts', 'llm:…'
  modele           text NOT NULL,
  kind             text NOT NULL,      -- 'image', 'video', 'tts', 'llm'
  requete          jsonb NOT NULL,
  statut           ops.statut_generation NOT NULL DEFAULT 'reserve',
  cout_estime_c    integer NOT NULL CHECK (cout_estime_c >= 0),
  cout_reel_c      integer CHECK (cout_reel_c >= 0),
  ref_fournisseur  text,               -- id distant, pour réconcilier
  asset_ref        text REFERENCES ops.objet (asset_ref),
  tentatives       smallint NOT NULL DEFAULT 0,
  code_erreur      text,
  cree_le          timestamptz NOT NULL DEFAULT now(),
  fini_le          timestamptz,

  FOREIGN KEY (projet_id, client_id)
    REFERENCES ops.projet (projet_id, client_id) ON DELETE CASCADE,
  CONSTRAINT generation_cle_unique UNIQUE (generation_key),
  CONSTRAINT generation_reussie_a_un_objet
    CHECK (statut <> 'reussie' OR asset_ref IS NOT NULL)
);

CREATE INDEX generation_par_projet ON ops.generation (projet_id, cree_le);
CREATE INDEX generation_en_vol ON ops.generation (statut, cree_le)
  WHERE statut IN ('reserve', 'en_cours');
```

`generation_cle_unique` est le cœur de R12 : **l'insertion est la
réservation**. Une seconde tentative avec la même clé viole l'unicité,
lit la ligne existante et réutilise son `asset_ref`. Une ligne restée
`reserve` ou `en_cours` plus de 30 min est réconciliée contre
`ref_fournisseur` avant toute relance — on ne relance jamais un appel
payant sur la foi d'un timeout.

La valeur de `generation_key` est celle du contrat
(`provenance.generation_key`) : `sha256(provider | model | prompt |
negative_prompt | seed | params)`, ou `sha256(model | voice_id | texte |
params)` pour la voix off. Elle ne contient **pas** le `client_id` — voir
§11, écart É-1.

### 2.5 Marque, templates, voix

```sql
CREATE TABLE ops.brand_pack (
  brand_pack_id  text NOT NULL
                 CHECK (brand_pack_id ~ '^bp_[a-z0-9]{6,32}$'),
  version        integer NOT NULL,
  client_id      text NOT NULL REFERENCES ops.client (client_id),
  payload        jsonb NOT NULL,       -- Brandpack.schema.json
  statut         ops.statut_publication NOT NULL DEFAULT 'brouillon',
  publie_par     text,
  publie_le      timestamptz,
  cree_le        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_pack_id, version),
  CONSTRAINT bp_publie_signe
    CHECK (statut <> 'publie' OR (publie_par IS NOT NULL
                              AND publie_le IS NOT NULL))
);

ALTER TABLE ops.client
  ADD CONSTRAINT client_brand_pack_fk
  FOREIGN KEY (brand_pack_id, brand_pack_version)
  REFERENCES ops.brand_pack (brand_pack_id, version);

CREATE TABLE ops.template (
  template_id    text NOT NULL
                 CHECK (template_id ~ '^tpl_[a-z0-9_]{3,40}$'),
  version        text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  manifeste      jsonb NOT NULL,       -- Template.schema.json
  r2_key         text NOT NULL,        -- source HTML figée (D15, T1)
  sha256         char(64) NOT NULL,
  moteur         text NOT NULL,
  moteur_version text NOT NULL,
  statut         ops.statut_publication NOT NULL DEFAULT 'brouillon',
  publie_par     text,
  publie_le      timestamptz,
  cree_le        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version),
  CONSTRAINT tpl_publie_signe
    CHECK (statut <> 'publie' OR (publie_par IS NOT NULL
                              AND publie_le IS NOT NULL))
);

CREATE INDEX template_catalogue ON ops.template (statut, template_id, version DESC);
```

La « file de validation » de D15 et T1 est `statut = 'en_validation'` ;
la commande admin `style_approuver` la vide. Aucune table de file : une
colonne suffit. Un template publié n'est **jamais** modifié (T1) ; on
publie `version + 1`. `ops.projet` retient la version utilisée, donc un
projet relancé six jours plus tard rend le même montage même si le
catalogue a avancé.

Le catalogue de voix, la table du flou et les messages neutres vivent
dans une table de réglages : ils changent sans migration, n'ont ni
contraintes propres ni relations.

```sql
CREATE TABLE ops.parametre (
  cle       text PRIMARY KEY,   -- 'catalogue_voix', 'table_flou', …
  valeur    jsonb NOT NULL,
  maj_le    timestamptz NOT NULL DEFAULT now(),
  maj_par   text NOT NULL
);
```

### 2.6 Bibliothèque audio, licences, non-réutilisation

```sql
CREATE TABLE ops.piste_audio (
  asset_ref    text PRIMARY KEY
               CHECK (asset_ref ~ '^ast_[a-z0-9_]{3,40}$'),
  section      text NOT NULL CHECK (section IN ('structurel','semantique','musique')),
  titre        text NOT NULL,
  r2_key       text NOT NULL,          -- library/audio/…
  sha256       char(64) NOT NULL,
  duree_ms     integer NOT NULL CHECK (duree_ms > 0),
  -- instant de l'attaque, mesuré à l'import : c'est lui qu'on cale sur
  -- l'événement, pas le premier échantillon (§7.4)
  attaque_ms   integer NOT NULL DEFAULT 0 CHECK (attaque_ms >= 0),
  lufs         numeric(5,2),
  bouclable    boolean NOT NULL DEFAULT false,
  tags         text[] NOT NULL DEFAULT '{}',
  moods        text[] NOT NULL DEFAULT '{}',
  -- licence obligatoire : sans elle, la piste n'entre pas (R16)
  source       text NOT NULL,
  licence      text NOT NULL
               CHECK (licence IN ('pixabay_content_license','cc0')),
  source_url   text NOT NULL CHECK (source_url LIKE 'http%'),
  releve_le    date NOT NULL,
  CONSTRAINT piste_r2_unique UNIQUE (r2_key)
);

CREATE INDEX piste_par_tags  ON ops.piste_audio USING gin (tags);
CREATE INDEX piste_par_moods ON ops.piste_audio USING gin (moods);

-- D32 / M12 / R15 : une musique n'est pas livrée à deux clients sur la
-- période configurée : 30 jours [D-28/09]. La table enregistre les
-- livraisons ; la fenêtre est un paramètre (ops.parametre), pas une
-- contrainte figée.
CREATE TABLE ops.musique_livree (
  asset_ref  text NOT NULL REFERENCES ops.piste_audio (asset_ref),
  client_id  text NOT NULL REFERENCES ops.client (client_id),
  projet_id  text NOT NULL,
  livre_le   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_ref, projet_id)
);

CREATE INDEX musique_par_piste ON ops.musique_livree (asset_ref, livre_le DESC);

-- Trace d'usage : survit à la purge R2, part dans history à la clôture.
CREATE TABLE ops.usage_audio (
  projet_id     text NOT NULL,
  client_id     text NOT NULL,
  asset_ref     text NOT NULL REFERENCES ops.piste_audio (asset_ref),
  role          text NOT NULL CHECK (role IN ('structurel','semantique','musique')),
  licence_snap  jsonb NOT NULL,       -- copie de la licence au moment du mix
  PRIMARY KEY (projet_id, asset_ref, role),
  FOREIGN KEY (projet_id, client_id)
    REFERENCES ops.projet (projet_id, client_id) ON DELETE CASCADE
);
```

**Pourquoi une table de livraisons et non une contrainte d'unicité.**
M12 et R15 disent « non livrée à un autre client **sur la période
configurée** » : c'est une fenêtre glissante, qu'aucun index unique
n'exprime. Le choix se fait donc par requête (§7.5), et la course entre
deux projets simultanés est attrapée exactement là où les règles le
prévoient : M12 choisit, R15 revérifie juste avant le rendu. La ligne
n'est écrite qu'à la **livraison** (T12 de la machine à états), pas à la
compilation — une musique choisie pour un projet qui échoue ne doit pas
être consommée.

`licence_snap` est une copie, pas une jointure : si Pixabay change ses
conditions, la vidéo livrée garde la trace de ce qui était vrai le jour
du mix. C'est ce qui rend défendable une réclamation six mois plus tard
(R16).

### 2.7 Messages WhatsApp

```sql
CREATE TABLE ops.message_entrant (
  wa_message_id  text PRIMARY KEY,     -- dédup structurelle des retries Meta
  client_id      text REFERENCES ops.client (client_id),   -- NULL si inconnu
  wa_from        text NOT NULL,
  projet_id      text,
  kind           text NOT NULL,        -- text, image, audio, document, button
  corps          text,
  r2_key         text,                 -- média copié dès réception
  brut           jsonb NOT NULL,
  recu_le        timestamptz NOT NULL DEFAULT now(),
  traite_le      timestamptz,
  code_erreur    text
);

CREATE INDEX entrant_a_traiter ON ops.message_entrant (recu_le)
  WHERE traite_le IS NULL;

CREATE TABLE ops.message_sortant (
  envoi_id      bigserial PRIMARY KEY,
  destinataire  text NOT NULL,         -- client ou numéro admin
  client_id     text REFERENCES ops.client (client_id),
  projet_id     text,
  kind          ops.kind_envoi NOT NULL,
  payload       jsonb NOT NULL,
  cle_envoi     text NOT NULL,         -- idempotence applicative
  statut        ops.statut_envoi NOT NULL DEFAULT 'en_file',
  tentatives    smallint NOT NULL DEFAULT 0,
  wa_message_id text,
  code_erreur   text,
  cree_le       timestamptz NOT NULL DEFAULT now(),
  envoye_le     timestamptz,
  CONSTRAINT sortant_cle_unique UNIQUE (cle_envoi)
);

CREATE INDEX sortant_a_envoyer ON ops.message_sortant (cree_le)
  WHERE statut = 'en_file';
```

`cle_envoi` est déterministe — par exemple
`proj_a1b2c3:apercu_franco:v2` — donc une relance de job ne renvoie pas
deux fois le même aperçu à Franco ni deux fois la même livraison au
client. C'est le pendant, en sortie, de la dédup en entrée.

### 2.8 Exécutions, budgets d'état, plafonds, commandes

```sql
CREATE TABLE ops.execution_job (
  execution_id  bigserial PRIMARY KEY,
  projet_id     text NOT NULL,
  client_id     text NOT NULL,
  kind          ops.kind_job NOT NULL,
  etat_depart   ops.etat_projet NOT NULL,
  nom_execution text,                  -- nom Cloud Run, pour les logs
  declencheur   text NOT NULL,         -- 'client' | 'watchdog' | 'admin'
  demarre_le    timestamptz NOT NULL DEFAULT now(),
  fini_le       timestamptz,
  ok            boolean,
  code_erreur   text,
  FOREIGN KEY (projet_id, client_id)
    REFERENCES ops.projet (projet_id, client_id) ON DELETE CASCADE
);

-- Le watchdog est déclaratif : cette table EST sa configuration (§3.5).
CREATE TABLE ops.budget_etat (
  etat            ops.etat_projet PRIMARY KEY,
  duree_max_s     integer NOT NULL CHECK (duree_max_s > 0),
  au_depassement  ops.au_depassement NOT NULL,
  relances_max    smallint NOT NULL DEFAULT 1 CHECK (relances_max >= 0),
  -- délai au bout duquel le projet part en FAILED quoi qu'il arrive.
  -- NULL = jamais : le seul cas est PENDING_REVIEW, car on n'abandonne
  -- pas un rendu déjà payé parce que Franco dort.
  abandon_apres_s integer CHECK (abandon_apres_s IS NULL
                                 OR abandon_apres_s > duree_max_s),
  compte_sla      boolean NOT NULL
);

CREATE TABLE ops.plafond_cout (
  type_job        ops.type_job PRIMARY KEY,
  plafond_c       integer NOT NULL CHECK (plafond_c > 0),
  plafond_mois_c  integer NOT NULL CHECK (plafond_mois_c > 0),
  maj_le          timestamptz NOT NULL DEFAULT now(),
  maj_par         text NOT NULL
);

CREATE TABLE ops.commande_admin (
  commande_id     bigserial PRIMARY KEY,
  wa_message_id   text NOT NULL REFERENCES ops.message_entrant (wa_message_id),
  texte_brut      text NOT NULL,       -- expurgé du code de confirmation
  nom             ops.commande_admin_nom NOT NULL,
  parametres      jsonb NOT NULL,
  reformulation   text NOT NULL,
  exige_code      boolean NOT NULL,
  statut          ops.statut_commande NOT NULL DEFAULT 'proposee',
  essais_code     smallint NOT NULL DEFAULT 0,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  expire_le       timestamptz NOT NULL CHECK (expire_le > cree_le),
  execute_le      timestamptz,
  resultat        jsonb,
  CONSTRAINT commande_executee_datee
    CHECK ((statut = 'executee') = (execute_le IS NOT NULL))
);

CREATE INDEX commande_en_attente ON ops.commande_admin (expire_le)
  WHERE statut = 'proposee';
```

`plafond_mois_c` n'est pas une extension de D35 mais sa condition de
sûreté : un plafond par projet borne un projet, pas une suite de projets
(§11, écart É-6).

### 2.9 `history` — permanent, append-only

Aucune de ces tables n'est mise à jour ni supprimée. L'interdiction est
appliquée par les droits : le rôle applicatif n'a que `INSERT` et
`SELECT` sur `history`.

```sql
CREATE TABLE history.transition (
  id           bigserial PRIMARY KEY,
  projet_id    text NOT NULL,
  client_id    text NOT NULL,
  etat_avant   ops.etat_projet,
  etat_apres   ops.etat_projet NOT NULL,
  declencheur  text NOT NULL,      -- 'client'|'franco'|'job'|'watchdog'
  acteur       text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  duree_etat_s integer,
  le           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transition_par_projet ON history.transition (projet_id, id);

CREATE TABLE history.audit (
  id            bigserial PRIMARY KEY,
  le            timestamptz NOT NULL DEFAULT now(),
  acteur        text NOT NULL,      -- numéro admin ou 'systeme'
  source        text NOT NULL,      -- 'admin_wa'|'systeme'|'migration'
  action        text NOT NULL,
  objet_type    text NOT NULL,
  objet_id      text NOT NULL,
  valeur_avant  jsonb,
  valeur_apres  jsonb,
  commande_id   bigint,
  client_id     text
);

CREATE INDEX audit_par_objet ON history.audit (objet_type, objet_id, id);

CREATE TABLE history.livraison (
  id               bigserial PRIMARY KEY,
  projet_id        text NOT NULL,
  client_id        text NOT NULL,
  type_job         ops.type_job NOT NULL,
  apercu_octets    bigint,
  master_octets    bigint,
  duree_ms         integer,
  lufs             numeric(5,2),
  dbtp             numeric(5,2),
  hash_frames      char(64),
  reworks          smallint NOT NULL DEFAULT 0,
  valide_par       text NOT NULL,     -- 'franco' (D22), plus tard 'auto'
  valide_le        timestamptz NOT NULL,
  livre_le         timestamptz NOT NULL,
  delai_sla_s      integer NOT NULL
);

CREATE TABLE history.generation (
  id            bigserial PRIMARY KEY,
  projet_id     text NOT NULL,
  client_id     text NOT NULL,
  fournisseur   text NOT NULL,
  modele        text NOT NULL,
  kind          text NOT NULL,
  statut        ops.statut_generation NOT NULL,
  cout_reel_c   integer,
  cree_le       timestamptz NOT NULL,
  archive_le    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generation_hist_par_mois
  ON history.generation (client_id, cree_le);

CREATE TABLE history.message (
  id          bigserial PRIMARY KEY,
  projet_id   text,
  client_id   text,
  sens        text NOT NULL CHECK (sens IN ('entrant','sortant')),
  kind        text NOT NULL,
  corps       text,                  -- texte seul, jamais de média
  le          timestamptz NOT NULL
);

-- Les contrats survivent aux octets : c'est ce qui permettra de
-- calibrer un juge automatique (D22) et de trancher un litige.
CREATE TABLE history.projet (
  projet_id      text PRIMARY KEY,
  client_id      text NOT NULL,
  type_job       ops.type_job NOT NULL,
  etat_final     ops.etat_projet NOT NULL,
  code_echec     text,
  cout_total_c   integer NOT NULL,
  brief          jsonb NOT NULL,
  storyboard     jsonb,
  montage_plan   jsonb,
  composition_qa jsonb,               -- bloc qa seul, pas la composition
  cree_le        timestamptz NOT NULL,
  clos_le        timestamptz NOT NULL
);

-- Données de calibration du futur juge (D22) : la paire refus/motif.
CREATE TABLE history.revue (
  id             bigserial PRIMARY KEY,
  projet_id      text NOT NULL,
  client_id      text NOT NULL,
  montage_plan_version integer NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('valide','refuse')),
  motif          text,               -- liste fermée (§8.2)
  precision      text,
  plan_hash      char(64),
  le             timestamptz NOT NULL DEFAULT now()
);
```

`history.revue` est la table la plus stratégique du schéma alors qu'elle
ne sert à rien aujourd'hui : D22 promet une automatisation « plus tard,
avec des données de calibration ». Ces données n'existeront que si on les
écrit dès la première livraison. Un refus non enregistré est une donnée
perdue pour toujours.

### 2.10 Purge (D27)

Un passage quotidien dans `svc-conversation`, en trois temps, dans cet
ordre :

1. **Archiver** les projets clos depuis plus de 7 jours vers
   `history.projet`, `history.generation`, `history.message` — les
   transitions, l'audit, les livraisons et les revues y sont déjà,
   écrites au fil de l'eau.
2. **Supprimer sur R2** les objets dont `expire_le < now()`, par préfixe
   de projet, en lisant `ops.objet`.
3. **Supprimer en base** les lignes `ops.projet` archivées ; les cascades
   emportent `ops.objet`, `ops.generation`, `ops.usage_audio`,
   `ops.execution_job`.

L'ordre importe : jamais de suppression R2 avant archivage réussi, et
jamais de suppression de l'inventaire avant celle des octets — sinon
l'objet devient orphelin, invisible, et payé pour toujours.

`expire_le` se calcule **à partir de la clôture**, pas de la création, et
la fenêtre n'est pas uniforme : `clos_le + 10 jours` pour ce dont une
correction a besoin (`composition`, `alignement`, `voix_scene`,
`asset_genere`, `master`), `clos_le + 7 jours` pour le reste. La raison
est au §11, écart É-4 : D26 donne 7 jours pour signaler une erreur
factuelle et D27 purge à 7 jours — le client qui écrit le septième jour
trouverait les assets déjà effacés.

---

## 3. Machine à états

### 3.1 Ce qu'un état garantit

Un état est un **contrat de reprise** : quand un projet est dans l'état
E, tout ce que les états antérieurs devaient produire existe sur R2 et
est inscrit dans `ops.objet`. La transition est donc toujours écrite
*en dernier*, dans la transaction qui inscrit les artefacts :

```
BEGIN;
  INSERT INTO ops.objet (…);              -- artefacts déjà sur R2
  UPDATE ops.projet
     SET etat = 'ASSETS_READY', etat_depuis = now(), tentatives_etat = 0,
         sla_cumul_ms = sla_cumul_ms + …,
         bail_par = NULL, bail_jusqu_a = NULL
   WHERE projet_id = $1 AND etat = 'GENERATING';   -- garde optimiste
  INSERT INTO history.transition (…);
COMMIT;
```

La garde `AND etat = 'GENERATING'` rend la transition idempotente : deux
jobs concurrents — celui qu'on croyait mort et le relancé — ne peuvent
pas avancer deux fois. Le second voit zéro ligne modifiée, constate que
l'état attendu est déjà atteint, et se termine sans rien envoyer au
client.

Corollaire, qui est la règle de reprise du §0 : **dans un état, l'ordre
des opérations va du plus cher au moins cher, et chaque dépense est
inscrite avant la suivante.** Une relance ne repaie rien parce qu'elle
retrouve soit l'état suivant déjà atteint, soit les lignes
`ops.generation` et `ops.objet` de ce qui a déjà été payé.

### 3.2 Les états

| État | Propriétaire | Travail | Artefacts écrits (= reprise) | Durée max | Au dépassement | Abandon | SLA |
|---|---|---|---|---|---|---|---|
| `RECEIVED` | svc | classifieur (D2) : type de job, périmètre | `brief.type_job` | 120 s | relancer ×2 | 1 h | oui |
| `REJECTED` | — | terminal : message fixe envoyé | — | — | — | — | — |
| `CLARIFYING` | svc | slots + brouillon (D4), collecte des assets | `asset_client` sur R2 | 12 h | relancer le client ×1 | 48 h | non |
| `BRIEF_READY` | svc | Storyboard (LLM) + S1–S11 | `storyboard` v_n | 300 s | relancer ×2 | 1 h | oui |
| `STORYBOARD_PENDING_CLIENT` | client | validation (D24, S11) | — | 24 h | relancer le client ×1 | 48 h | non |
| `GENERATING` | job-produce + job-tts | générations fal.ai, voix off, alignement | `asset_genere`, `voix_scene` (par scène), `alignement` | 30 min | relancer ×1 | 2 h | oui |
| `ASSETS_READY` | job-produce | menu, Monteur, compilateur, rendu, mixage, encodage | `montage_plan`, `composition`, `rendu_muet`, `mix_final`, `master`, `apercu`, `frame_capture`, `rapport_conformite` | 20 min | relancer ×1 | 1 h 30 | oui |
| `RENDERED_VERIFIED` | svc | envoi à Franco : aperçu + `qa.checklist` + dégradations T9 | `message_sortant` | 300 s | relancer ×2 | 1 h | oui |
| `PENDING_REVIEW` | Franco | décision par boutons (D22) | `history.revue` | 1 h | alerter ×3 | **jamais** | oui |
| `DELIVERED` | — | terminal pour le goût (D26) | `history.livraison`, `ops.musique_livree` | — | — | — | — |
| `CORRECTION` | job-produce | correction factuelle ≤ 7 j (D26, M13) | contrats v_n+1, `master`/`apercu` v_n+1 | 30 min | relancer ×1 | 2 h | oui |
| `FAILED` | — | terminal : message neutre envoyé, Franco alerté (D33) | `code_echec`, `detail_echec` | — | — | — | — |

Ces valeurs peuplent `ops.budget_etat` ; elles se changent par migration,
pas par commande admin — un plafond de temps n'est pas un réglage
d'exploitation.

Justification des trois durées qui comptent : `GENERATING` à 30 min
couvre 3 à 6 générations fal.ai **plus** le démarrage à froid du Job GPU
(image et poids, 2 à 4 min) et la synthèse ; `ASSETS_READY` à 20 min
laisse 4× la cible T0 de 5 min pour le rendu, plus le mixage et deux
encodages ; `PENDING_REVIEW` à 1 h est un seuil de **rappel**, pas
d'échec.

### 3.3 Transitions

| # | De → Vers | Déclencheur | Garde | Effets |
|---|---|---|---|---|
| T1 | ∅ → `RECEIVED` | message d'un numéro en liste blanche | `client.statut = 'actif'` | création du projet |
| T2 | `RECEIVED` → `REJECTED` | hors périmètre (D2, D25) | — | message fixe, `clos_le` |
| T3 | `RECEIVED` → `CLARIFYING` | type de job reconnu | type ∈ {video, visuel, retouche} | premier message de clarification |
| T4 | `CLARIFYING` → `BRIEF_READY` | slots requis remplis | assets minimaux sur R2 | — |
| T5 | `BRIEF_READY` → `STORYBOARD_PENDING_CLIENT` | storyboard écrit et valide | S1–S11 passent | envoi du résumé client (S11) |
| T6 | `STORYBOARD_PENDING_CLIENT` → `BRIEF_READY` | correction demandée par le client | itérations < 3 | `storyboard_version + 1`, `revision.reason = client_feedback` |
| T7 | `STORYBOARD_PENDING_CLIENT` → `GENERATING` | validation du client (D24) | plafond copié, plafond mensuel non atteint | hash du storyboard validé enregistré (M1), exécution de `job-produce` |
| T8 | `GENERATING` → `ASSETS_READY` | assets + voix off + alignement durables | toutes les `ops.generation` du plan sont `reussie` | — |
| T9 | `ASSETS_READY` → `RENDERED_VERIFIED` | R9 et R10 conformes sur les deux fichiers | conformité binaire | — |
| T10 | `RENDERED_VERIFIED` → `PENDING_REVIEW` | aperçu envoyé à Franco | envoi accepté par Meta | — |
| T11 | `PENDING_REVIEW` → `ASSETS_READY` | Franco refuse | `reworks < 2` (M13) | `reworks + 1`, motif fermé → `revision.reviewer_feedback`, `history.revue` |
| T12 | `PENDING_REVIEW` → `DELIVERED` | Franco valide | — | livraison double (D23), `history.livraison`, `ops.musique_livree`, `clos_le` |
| T13 | `DELIVERED` → `CORRECTION` | erreur factuelle signalée ≤ 7 j (D26) | `now() < livre_le + 7 j` | rouvre le projet, budget **non** rechargé |
| T14 | `CORRECTION` → `RENDERED_VERIFIED` | nouveau master conforme | R9, R10 | — |
| T15 | états de travail → `FAILED` | erreur non rattrapable, ou watchdog après relance | `code_echec` renseigné | message neutre au client, alerte Franco (D33) |
| T16 | attentes client → `FAILED` | `abandon_apres_s` dépassé | — | `code_echec = 'ABANDON_CLIENT'`, pas d'alerte P1 |
| T17 | `FAILED` → `etat_avant_echec` | commande admin `job_relancer` | `etat_avant_echec` non nul, cause traitée | reprise sans repaiement. Sur un échec `E_BUDGET`, **recharge `budget_centimes` et `budget_restant` au plafond courant** et écrit une ligne d'audit [D-28/09]. **Absent du diagramme du document d'état** : §11, écart É-2 |

**T11 est le point sensible.** Un refus de Franco revient en
`ASSETS_READY`, donc au menu et au Monteur — pas en `GENERATING`. Les
assets et la voix off sont conservés et ne sont **jamais** repayés :
c'est la propriété « zéro dépense » du plan (M14) qui rend un refus
gratuit en API. Seuls le montage, le rendu et le mixage sont refaits,
avec le motif de refus en `revision.reviewer_feedback` (M13). Si le motif
porte sur un asset — « la photo produit est floue » — le plan ne peut
rien : il faut un nouveau projet, ou une génération explicitement
autorisée par commande admin, qui consomme le budget restant.

M13 borne les reprises à **deux**. À la troisième, le problème n'est pas
le montage : alerte à Franco, qui décide. C'est `projet_reworks_bornes`
en base.

**T13 ne recharge pas le budget** : une correction factuelle est à notre
charge (D26), donc elle tient dans ce qui reste, sinon elle alerte
Franco. Décision de conception, pas contrainte technique : elle empêche
qu'un enchaînement de « corrections » double le coût d'un projet sans que
personne ne le voie. M13 la rend de toute façon quasi gratuite : les
scènes dont le `content_hash` est inchangé recopient les décisions du
plan parent **sans appel au Monteur**, et les assets inchangés sont
réutilisés par `generation_key`.

### 3.4 Horloge de service et délai de 4 h (D36)

Le délai de 4 h ne peut pas se mesurer de bout en bout, sinon un client
qui met deux jours à valider son storyboard nous met en faute. Chaque
projet porte donc `sla_cumul_ms`, qui **n'accumule que le temps passé
dans les états dont nous sommes propriétaires** (colonne `compte_sla`).
Les deux états d'attente client en sont exclus, et le client est prévenu
à l'entrée dans ces états que le délai repart de sa réponse.

L'incrément est fait à chaque transition, dans la transaction du §3.1 :
`sla_cumul_ms += (now() - etat_depuis)` si l'état quitté compte.

`PENDING_REVIEW` compte, lui : c'est **notre** attente, pas celle du
client. Et c'est exactement ce qui rend D22 et D36 incompatibles la nuit
(§11, écart É-1 bis, et §12, B1).

### 3.5 Watchdog

Une boucle dans `svc-conversation`, toutes les **60 s**, sans état
propre : tout ce dont elle a besoin est dans `ops.projet` et
`ops.budget_etat`. Cinq contrôles, du plus spécifique au plus général.

**1. Bail expiré — le job est mort.** Un job renouvelle son bail toutes
les 60 s (`bail_jusqu_a = now() + 3 min`). Un bail périmé signifie une
exécution perdue, pas une exécution lente : on relance immédiatement,
sans attendre `duree_max_s`. C'est ce qui ramène le temps de
récupération d'un crash de 20 min à 3 min.

```sql
-- prédicat, pas une implémentation
SELECT projet_id FROM ops.projet
 WHERE etat IN ('GENERATING','ASSETS_READY','CORRECTION')
   AND bail_jusqu_a IS NOT NULL AND bail_jusqu_a < now()
 FOR UPDATE SKIP LOCKED;
```

**2. Durée maximale dépassée.**
- `au_depassement = 'relancer'` et `tentatives_etat < relances_max` →
  libère le bail, `tentatives_etat + 1`, relance, écrit
  `ops.execution_job` avec `declencheur = 'watchdog'` ;
- `au_depassement = 'relancer'` et quota épuisé → `FAILED` (T15) :
  message neutre au client, alerte P1 ;
- `au_depassement = 'alerter'` → rappel (au client pour les attentes
  client, à Franco pour `PENDING_REVIEW`), au plus `relances_max` fois.
  **Jamais de `FAILED`.**

**3. Abandon.** `abandon_apres_s` dépassé → `FAILED` avec
`ABANDON_CLIENT` ou `ABANDON_TECHNIQUE`. Le premier n'alerte pas en P1 :
ce n'est pas une panne, il entre dans le digest quotidien.

**4. Alerte de service à T+3 h.** `sla_cumul_ms + (now() - etat_depuis)`
dépasse 3 h, état non terminal, alerte non encore envoyée → alerte
Franco avec l'état courant et la commande suggérée, puis
`sla_alerte_envoyee = true`. Une seule fois par projet.

**5. Réconciliations.** Trois balayages courts, chacun empêchant une
perte d'argent ou de message :
- `ops.generation` en `reserve`/`en_cours` depuis plus de 30 min →
  interroger le fournisseur par `ref_fournisseur` **avant** toute
  relance ; si l'appel a abouti, on récupère le résultat et on ne repaie
  pas ; sinon `abandonnee` et le budget réservé est rendu ;
- `ops.message_sortant` en file → envoi avec reprise exponentielle
  (2 s, 8 s, 30 s, 2 min, 10 min), `echoue` à 5 tentatives, alerte P1 si
  le message était une livraison ;
- `ops.commande_admin` proposée et expirée → `expiree`.

**Qui surveille le watchdog ?** Rien, dans le système. Si
`svc-conversation` tombe, plus aucune alerte ne part : c'est le seul
point unique de défaillance de l'architecture, et il est couvert **hors**
système — un contrôle de disponibilité Cloud Monitoring sur `GET /sante`
toutes les 5 min, avec alerte vers l'e-mail et le SMS de Franco.
`/sante` renvoie 503 si la dernière boucle de watchdog a plus de 5 min,
ce qui couvre aussi le cas « le service répond mais la boucle est
bloquée ».

### 3.6 Ce que coûte une relance, état par état

C'est la vérification de la règle de reprise, cas par cas.

| Relance depuis | Repaie | Ne repaie pas |
|---|---|---|
| `RECEIVED`, `CLARIFYING`, `BRIEF_READY` | un appel LLM (centimes) | — |
| `GENERATING` | les seules générations sans ligne `reussie` | les assets produits, et toute scène dont la `voix_scene` existe |
| `ASSETS_READY` | un appel LLM (Monteur), le CPU de rendu et de mixage | **toutes** les générations, la voix off, l'alignement |
| `RENDERED_VERIFIED` | un envoi WhatsApp | le rendu et le mixage |
| `PENDING_REVIEW` | rien | rien |
| `CORRECTION` | le Monteur sur les seules scènes modifiées (M13), le rendu, le mixage | les générations, la voix off des scènes inchangées |

Le seul cas où une relance coûte du GPU est la correction du texte d'une
voix off : on resynthétise **la scène concernée uniquement** (§7.2), pas
le script entier.

---

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

Cinq règles, qui sont le contrat réel :

1. **La sortie est muette.** Le moteur rend l'image, jamais le son. Tout
   l'audio est assemblé par FFmpeg (§7), donc la garantie -14 LUFS /
   -1 dBTP (R10) ne dépend pas du moteur, et changer de moteur ne remet
   pas en jeu la conformité sonore. C'est la décision qui rend D7
   réversible à bon marché.
2. **Aucun réseau pendant la capture** (R11). Les assets sont hydratés
   sur disque, les polices sont dans l'image, `document.fonts.check()`
   est vérifié avant la première frame. Une police absente est une
   erreur, pas un repli silencieux — un repli change le rendu sans le
   dire, et c'est le mode d'échec le plus discret du pipeline (R4).
3. **Déterminisme vérifiable** : mêmes composition, assets et version du
   moteur ⇒ même `hash_frames`. C'est le test d'acceptation de R11 et le
   critère C de T0.
4. **`verifier()` avant `rendre()`** : le bloc DOM (R5, R7, R8) tourne
   sur la page chargée, avant la première frame capturée, et son coût est
   nul. S'il échoue, on ne rend pas. Si `capacites().lint_dom` est faux,
   R5/R7/R8 ne sont pas exécutables et le moteur est **refusé** en
   production (§11, écart É-5).
5. **`rendre()` ne lit ni la base ni R2.** Il reçoit un dossier et une
   composition. C'est ce qui permet de l'exécuter à la main en T1, sans
   base.

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

## 6. Orchestration du Monteur et du compilateur

`Montage plan.rules.md` dit **ce qui est valide**. Cette section dit **ce
qui s'exécute, dans quel ordre, et ce que ça coûte**. Elle n'ajoute
aucune règle.

### 6.1 La séquence dans `ASSETS_READY`

```
1. menu fermé par scène            code, sans LLM          M3
2. décisions à une seule option    code, sans LLM          M3 → chosen_by: code
3. appel Monteur                   1 appel LLM             prompt = §6.2
4. validation du plan              code                    M15, M1…M14, plan_hash
   └─ échec → 1 reprise avec l'erreur → échec → alerte Franco
5. compilation                     code, déterministe      B8, T8, T9
6. validation document seul        code, coût nul          R17, R3, R16, R4,
                                                           R6, R13, R14, R15,
                                                           R2, R1
7. hydratation des assets sur disque                       R11
8. rendu : page chargée            Chrome                  R7, R5, R8
9. capture                         moteur                  hash_frames
10. mixage audio → normalisation                           R10
11. encodage preview + master                              R2
12. ffprobe bloquant sur les deux                          R9
```

Trois choses méritent d'être dites sur cet ordre.

**Le menu est calculé avant l'appel, pas vérifié après.** C'est la
différence entre un LLM contraint et un LLM corrigé. Le code construit,
pour chaque scène et chaque template éligible, l'ensemble exact des clés
admissibles (M3) ; le Monteur ne peut donc pas choisir hors menu
autrement qu'en inventant une chaîne, ce que le validateur attrape
immédiatement. Le `menu_hash` inscrit dans `inputs` rend la vérification
postérieure exacte : on revalide contre **le** menu transmis, pas contre
un menu recalculé qui aurait pu bouger entre-temps.

**Une décision à option unique ne vaut pas un appel LLM.** M3 impose déjà
`chosen_by: code` pour le template ; la même logique s'applique partout
où le menu est un singleton. À 8 scènes, cela retire régulièrement la
moitié des décisions du prompt, ce qui le raccourcit et réduit la surface
d'erreur.

**Une seule reprise du Monteur.** `Montage plan.rules.md` le pose :
« le Monteur reçoit l'erreur et corrige une fois ; au second échec, le
projet passe en alerte pour Franco ». C'est appliqué tel quel, et
j'écarte donc l'idée d'un *plan par défaut* qui compilerait quand même
(coupes franches, intensité `standard`, aucune emphase). Ce serait
techniquement facile et cela éviterait un `FAILED`, mais cela livrerait à
Franco un montage plat en prétendant que le Monteur a travaillé. Mieux
vaut une alerte : à 2 projets par jour, un échec de Monteur est un
événement, pas un bruit de fond.

**Mais deux échecs ne se valent pas** [D-28/09]. Le fournisseur retenu
(Groq, `openai/gpt-oss-120b`) **ignore `response_format` en mode
`strict`** : rien ne garantit la forme du JSON. Un document malformé
n'est pas une mauvaise décision de montage, c'est du bruit de
génération, et le faire compter comme un échec de jugement réveillerait
Franco pour rien. Le budget se scinde donc :

| Échec | Nature | Budget |
|---|---|---|
| le JSON ne parse pas, ou viole la **forme** du schéma | transport — le modèle n'a rien décidé | **3 tentatives**, hors budget du Monteur |
| JSON bien formé mais violant le menu (M3) ou M4–M12 | vraie erreur de décision | **1 reprise**, puis alerte Franco |

La règle de `Montage plan.rules.md` est conservée à l'identique là où
elle a du sens : sur les décisions.

### 6.2 Ce que reçoit le Monteur, et rien d'autre

Le prompt est assemblé **par projet**, jamais cumulé (M15, D30) :
storyboard validé, durées réelles et alignement mot à mot, menu fermé par
scène, bloc `guidance` du Brand Pack, table du flou, et — en reprise
seulement — le motif de refus de Franco et le plan parent.

Le catalogue d'assets est transmis en **métadonnées** (`label`, `tags`,
`kind`, dimensions), jamais en images : c'est moins cher, et cela retire
la question de savoir si un asset d'un autre client pourrait se glisser
dans un contexte visuel.

**Aucun horodatage n'entre dans le prompt.** Le Monteur reçoit les mots
et leurs `word_ref` (`w_0012`), pas leurs millisecondes. C'est ainsi
qu'on empêche à la source qu'il raisonne en temps : il ne peut pas, il
n'a pas les nombres. La résolution en millisecondes appartient à T8
(`mode: on_word` → `start_ms` du mot).

### 6.3 Le compilateur

Déterministe, sans réseau, sans LLM, sans horloge. Il ne fait que
**résoudre**, dans l'ordre fixé par B8 (Brand Pack) et T8 (chorégraphie).
Les seules libertés qu'il s'autorise sont bornées et tracées :

| Situation | Résolution | Trace |
|---|---|---|
| plusieurs assets candidats pour un slot | tri stable, puis `sha256(client_id + projet_id + scene_id + slot_id) mod n` | `trace_resolution` |
| slot vide | dégradation T9, une seule passe, sans récursion | journalisée sur la scène **et** signalée à Franco avec l'aperçu |
| texte trop long | échelle typographique du Brand Pack jusqu'à `min_font_size_px` | `overflow: shrink` |
| transition qui ne tient pas | ramenée à `cut` | `trace_resolution` |

`trace_resolution` est écrit sur R2 comme rôle dédié : pour chaque valeur
produite, la règle appliquée, la source (`brand_pack v3 >
motion_signature.camera_map.push_in`) et la valeur. C'est le seul moyen
de répondre à « pourquoi cette vidéo est-elle comme ça » sans relire
quatre fichiers, et cela rend deux rendus diffables. Il ne remplace pas
`plan_decision_ref`, qui répond à une autre question : *qui* a décidé,
le Monteur ou le compilateur (R3).

**Sérialisation canonique** : clés triées, entiers pour les temps, UTF-8
NFC, saut de ligne final. Deux compilations des mêmes entrées produisent
la même composition **à l'octet**. Sans cela, le test de déterminisme de
R11 ne prouve rien sur la chaîne complète.

---

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

## 8. Canal admin WhatsApp (D29)

### 8.1 Chaîne de traitement

```
message du numéro admin (constante de déploiement, jamais modifiable
                         par WhatsApp — garde-fou 4)
  │
  ├─ réponse à un bouton ? ──► aucun LLM : la charge utile du bouton EST
  │                            la commande (commande_id + oui/non)
  │
  └─ texte libre
       └─ LLM contraint ──► JSON validé par commande_admin.schema.json
            ├─ invalide ou hors vocabulaire → question de clarification
            │                                 prise dans une liste fixe
            └─ valide → ops.commande_admin ('proposee')
                 └─ reformulation + boutons [oui] [annuler]
                      ├─ commande sensible → + phrase de passe
                      └─ exécution transactionnelle + history.audit
```

Le LLM **traduit**, il n'exécute pas. Sa sortie est une valeur de
`ops.commande_admin_nom` et un objet de paramètres validé par schéma ; il
n'a accès à aucun outil d'écriture. Une phrase qu'il ne sait pas traduire
produit `nom: null`, et le système répond avec la liste des commandes —
jamais avec une tentative d'interprétation.

### 8.2 Les douze commandes

| Commande | Paramètres | Effet | Code | Réversible |
|---|---|---|---|---|
| `client_ajouter` | `telephone`, `nom_affiche` | entre en liste blanche (D25) | **oui** | oui |
| `client_retirer` | `client_id` | `statut = 'retire'` | **oui** | oui |
| `client_pause` | `client_id` | bloque les **nouveaux** projets ; ceux en cours vont au bout | non | oui |
| `client_reprendre` | `client_id` | `statut = 'actif'` | non | oui |
| `plafond_modifier` | `type_job`, `plafond_c`, `plafond_mois_c?` | change `ops.plafond_cout` ; s'applique aux projets **futurs** | **oui** | oui |
| `livraison_valider` | `projet_id` | T12 : livraison double | non | non |
| `livraison_refuser` | `projet_id`, `motif`, `precision?` | T11 : retour au Monteur | non | oui |
| `style_approuver` | `template_id`, `version` | `statut = 'publie'` (D15, T1) | non | oui |
| `job_relancer` | `projet_id` | reprise depuis l'état courant, ou `etat_avant_echec` si `FAILED` (É-2) | non | — |
| `etat_lire` | `client_id?`, `projet_id?` | lecture seule | non | — |
| `depenses_lire` | `mois?`, `client_id?` | lecture seule | non | — |
| `donnees_supprimer` | `client_id`, `portee` | purge ciblée | **oui** | **non** |

Les plafonds ne s'appliquent qu'aux projets futurs : changer le plafond
d'un projet en cours casserait `budget_restant <= budget_centimes` ou
rendrait du budget déjà consommé. `budget_centimes` est une **copie**
faite à l'entrée en `GENERATING`, justement pour cela.

`livraison_valider` et `livraison_refuser` arrivent normalement par
bouton, donc sans LLM et sans ambiguïté. Le motif de refus est une liste
fermée — `montage`, `rythme`, `texte`, `voix`, `musique`, `asset`,
`marque`, `autre` — pour trois raisons : il est réinjecté dans
`revision.reviewer_feedback` (M13), un motif libre ferait dériver le
vocabulaire fermé, et ces motifs sont les **données de calibration** du
juge promis par D22, écrites dans `history.revue`.

### 8.3 Schéma de validation

Un seul fichier, `commande_admin.schema.json`, discriminé par `nom`,
`additionalProperties: false` partout — c'est ce qui empêche un paramètre
inventé de passer.

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "commande_admin.schema.json",
  "type": "object",
  "required": ["nom"],
  "additionalProperties": false,
  "properties": {
    "nom": { "enum": ["client_ajouter", "client_retirer", "client_pause",
                      "client_reprendre", "plafond_modifier",
                      "livraison_valider", "livraison_refuser",
                      "style_approuver", "job_relancer", "etat_lire",
                      "depenses_lire", "donnees_supprimer", null] },
    "parametres": { "type": "object" },
    "confiance": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "allOf": [
    {
      "if":   { "properties": { "nom": { "const": "client_ajouter" } } },
      "then": { "properties": { "parametres": {
                  "type": "object", "additionalProperties": false,
                  "required": ["telephone", "nom_affiche"],
                  "properties": {
                    "telephone":   { "type": "string",
                                     "pattern": "^\\+[1-9][0-9]{7,14}$" },
                    "nom_affiche": { "type": "string", "minLength": 2,
                                     "maxLength": 60 }
                  } } } }
    },
    {
      "if":   { "properties": { "nom": { "const": "plafond_modifier" } } },
      "then": { "properties": { "parametres": {
                  "type": "object", "additionalProperties": false,
                  "required": ["type_job", "plafond_c"],
                  "properties": {
                    "type_job":       { "enum": ["video","visuel","retouche"] },
                    "plafond_c":      { "type": "integer",
                                        "minimum": 1, "maximum": 500000 },
                    "plafond_mois_c": { "type": "integer",
                                        "minimum": 1, "maximum": 5000000 }
                  } } } }
    },
    {
      "if":   { "properties": { "nom": { "const": "livraison_refuser" } } },
      "then": { "properties": { "parametres": {
                  "type": "object", "additionalProperties": false,
                  "required": ["projet_id", "motif"],
                  "properties": {
                    "projet_id": { "type": "string",
                                   "pattern": "^proj_[a-z0-9]{6,32}$" },
                    "motif": { "enum": ["montage","rythme","texte","voix",
                                        "musique","asset","marque","autre"] },
                    "precision": { "type": "string", "maxLength": 200 }
                  } } } }
    },
    {
      "if":   { "properties": { "nom": { "const": "donnees_supprimer" } } },
      "then": { "properties": { "parametres": {
                  "type": "object", "additionalProperties": false,
                  "required": ["client_id", "portee"],
                  "properties": {
                    "client_id": { "type": "string",
                                   "pattern": "^cli_[a-z0-9]{6,32}$" },
                    "portee": { "enum": ["projet","client_travail",
                                         "client_tout"] },
                    "projet_id": { "type": "string",
                                   "pattern": "^proj_[a-z0-9]{6,32}$" }
                  } } } }
    }
    // … un bloc par commande, même forme
  ]
}
```

`plafond_c` a un **maximum** dans le schéma : une faute de frappe — un
zéro de trop — ne doit pas pouvoir devenir un plafond de 5 000 €. Ce
garde-fou coûte une ligne et sauve un mois de marge.

`confiance` est renseignée par le LLM ; sous 0,8, la reformulation est
posée comme une **question fermée** (« Tu veux bien retirer le client
X ? ») au lieu d'une confirmation (« Je retire le client X, c'est
bon ? »). La différence n'est pas cosmétique : une affirmation obtient
« oui » par réflexe.

### 8.4 Garde-fous

1. **Confirmation systématique.** Toute commande qui écrit est reformulée
   et attend un « oui » explicite, par bouton. Une proposition expire en
   **10 minutes**, et il ne peut y en avoir qu'**une à la fois** : « oui »
   ne doit jamais être ambigu.
2. **Phrase de passe** pour les quatre commandes sensibles
   (`client_ajouter`, `client_retirer`, `plafond_modifier`,
   `donnees_supprimer`). C'est une phrase **mémorisée par Franco**, ni un
   code envoyé par message, ni un TOTP : la menace visée est le vol du
   téléphone ou le clonage de SIM, or un code reçu sur le téléphone volé
   et une application d'authentification installée sur ce même téléphone
   ne protègent de rien. Stockée **hachée** (Argon2id) dans Secret
   Manager, jamais en base. Trois essais, puis verrouillage du canal
   15 minutes et alerte P1 — laquelle partant vers le même numéro, elle
   est doublée par e-mail.
3. **Expurgation.** Le message contenant la phrase est stocké avec
   `corps = '[code expurgé]'` et n'entre jamais dans `history.message`
   ni dans les journaux.
4. **Numéro admin non modifiable par WhatsApp** : constante de
   déploiement. Le changer demande un déploiement, donc un accès Google
   Cloud, donc un second facteur qui n'est pas le téléphone.
5. **Pas d'exécution libre.** Il n'existe aucune commande « exécuter »,
   « SQL », « shell » ni « prompt ». Le vocabulaire des douze commandes
   est la surface d'attaque totale du canal.
6. **Trace avant l'acte.** `donnees_supprimer` écrit dans
   `history.audit` la liste des clés R2 et des identifiants concernés
   **avant** de supprimer. Après, l'information n'existe plus.

### 8.5 Audit

`history.audit` est écrit **dans la même transaction que la mutation** :
pas d'écriture après coup, donc pas de mutation sans trace. Une ligne par
commande exécutée, avec acteur, source, action, objet, valeur avant,
valeur après. Les lectures sont aussi auditées, valeurs nulles : savoir
qui a consulté quoi coûte une ligne et répond à une question qu'on se
pose toujours trop tard.

Le rôle applicatif n'a que `INSERT` et `SELECT` sur `history` (§2.9) :
l'audit n'est donc pas modifiable par le code qui l'écrit.

### 8.6 Alertes hors fenêtre de 24 h

La fenêtre de service WhatsApp se compte depuis le dernier message de
Franco. Au-delà, un message libre est refusé par Meta : les alertes
passent par le **template utility** approuvé, avec au plus trois
variables (projet, état, cause courte). C'est pour cela que ce template
est bloquant dès T1 : sans lui, une panne à 3 h du matin est silencieuse
jusqu'à ce que Franco écrive de lui-même.

Le système suit la dernière activité admin et choisit seul entre message
libre et template. Toute alerte P1 part **aussi** par e-mail : si la
panne est dans l'envoi WhatsApp, l'alerte WhatsApp ne partira pas.

---

## 9. Erreurs et alertes (O4-B, D33)

O4-B tient en trois obligations, rendues structurelles plutôt que
déclaratives : **message neutre au client**, **alerte à Franco**,
**watchdog**. Le watchdog est au §3.5 ; les deux autres sont ici.

### 9.1 Taxonomie

| Code | Classe | Action automatique | Client | Franco |
|---|---|---|---|---|
| `E_BUDGET` | argent | arrêt immédiat, `FAILED` | neutre 3 | **P1** + plafond courant |
| `E_QUOTA_FOURNISSEUR` | argent | `FAILED`, reprise possible par T17 | neutre 3 | **P1** + « recharger » |
| `E_FOURNISSEUR_INDISPO` | externe | 2 reprises, relance watchdog, puis `FAILED` | neutre 2 puis 3 | P2, **P1** si `FAILED` |
| `E_REFUS_CONTENU` | contenu | retour en `CLARIFYING` | neutre 4 | P3 |
| `E_TIMEOUT` | externe | reprise, réconciliation obligatoire | neutre 2 | P2 |
| `E_CONFORMITE` (R9, R10) | sortie | 2 ré-encodages, puis `FAILED` | neutre 3 | **P1** + rapport |
| `E_DEBORDEMENT_TEXTE` (R5) | sortie | échelle typographique jusqu'au plancher, puis `FAILED` | neutre 3 | **P1** + scène fautive |
| `E_HORS_ZONE_SECURITE` (R5) | template | `FAILED` | neutre 3 | **P1** — bug de template |
| `E_CONTRASTE` (R8) | template ou marque | `FAILED` | neutre 3 | **P1** — paire de couleurs à revoir |
| `E_POLICE_MANQUANTE` (R4) | déploiement | `FAILED` | neutre 3 | **P1** — bug d'image |
| `E_NON_DETERMINISTE` (R11) | moteur | `FAILED` | neutre 3 | **P1** — régression moteur |
| `E_ISOLATION` (R17, M15) | sécurité | `FAILED`, **aucune relance automatique** | neutre 3 | **P1** immédiat |
| `E_MENU_VIDE` (M3) | contraintes | `FAILED` | neutre 3 | **P1** + contrainte non satisfaite |
| `E_PLAN_INVALIDE` (M1–M14) | LLM | 1 reprise, puis alerte | neutre 2 | **P1** au second échec |
| `E_ASSET_MANQUANT` (client) | entrée | retour en `CLARIFYING` | neutre 4 | — |
| `E_ASSET_MANQUANT` (généré) | interne | régénération idempotente | — | P3 |
| `E_ALIGNEMENT` | audio | mode dégradé (§7.3) | — | P3 |
| `E_DEGRADATION` (T9) | template | dégradation appliquée, rendu poursuivi | — | signalée **avec l'aperçu** |
| `E_WA_ENVOI` | externe | reprise exponentielle, 5 essais | — | **P1** si livraison |
| `E_SIGNATURE_WEBHOOK` | sécurité | 403, rien traité | — | P2 (dédupliqué) |
| `ABANDON_CLIENT` | client | `FAILED` | — | P3 (digest) |
| `E_INTERNE` | inconnu | `FAILED`, pile dans `detail_echec` | neutre 3 | **P1** |

Deux principes se lisent dans cette table. **Ce qui est réparable seul
n'alerte pas** — alignement dégradé, régénération, dégradation T9 : une
alerte sans action possible entraîne qu'on cesse de lire les alertes.
**Ce qui coûte de l'argent, casse une livraison ou touche à l'isolation
alerte tout de suite**, même si le client n'a rien vu.

`E_ISOLATION` est le seul code qui interdit la relance automatique :
R17 et M15 le disent tous les deux, et c'est la bonne règle — une fuite
entre clients ne se répare pas en réessayant.

### 9.2 Messages neutres au client

Catalogue fermé, dans `ops.parametre`, cinq messages, aucun autre
autorisé dans le code :

1. **accusé** — « Bien reçu. Je regarde ça et je reviens vers vous. »
2. **en cours** — « C'est en production, je vous envoie l'aperçu dès
   qu'il est prêt. »
3. **incident** — « Un imprévu technique de notre côté sur cette vidéo.
   Je reprends la main et je reviens vers vous rapidement. »
4. **il me manque** — « Il me manque *{élément}* pour continuer. »
5. **hors périmètre** — description fixe du service rendu. Elle sert
   aussi de réponse aux numéros hors liste blanche (D25) et de défense
   vis-à-vis de la politique Meta du 15 janvier 2026.

Aucun code d'erreur, aucun nom de fournisseur, aucun délai chiffré qu'on
ne peut pas tenir, et **jamais** de mention de l'IA ou du pipeline. Le
message 3 ne promet pas de correction gratuite : c'est D26 qui la
définit, sur l'erreur factuelle, et c'est Franco qui l'accorde.

### 9.3 Alertes à Franco

| Niveau | Quand | Livraison |
|---|---|---|
| **P1** | argent, livraison cassée, isolation, bug de template ou de déploiement, verrouillage admin | immédiate : WhatsApp (template utility hors fenêtre) **+ e-mail** |
| **P2** | incident externe absorbé, 80 % du plafond mensuel atteint, signature invalide | lot horaire |
| **P3** | dégradations, abandons client, régénérations | digest quotidien à heure fixe |

**Anti-noyade** : déduplication par `(projet_id, code)` avec au plus une
alerte par heure ; plafond global de 10 P1 par heure, au-delà un seul
message « N alertes supprimées, voir `etat_lire` » ; et toute P1 contient
**la commande admin à taper** (`job_relancer proj_…`), pour que lire
l'alerte suffise à agir depuis le téléphone.

Contenu d'une P1 : projet, client, état, code, une ligne de cause,
commande suggérée. Rien de plus — c'est lu sur un téléphone, souvent la
nuit.

### 9.4 Ce qui est hors du système

Deux surveillances, parce qu'un système ne constate pas sa propre mort :

- **contrôle de disponibilité** Cloud Monitoring sur `GET /sante` toutes
  les 5 min → e-mail + SMS ;
- **alertes de solde** chez fal.ai et Google Cloud (50 %, 80 %, 100 %),
  parce que D35 borne ce que *nous* dépensons, pas ce que coûte
  l'infrastructure.

Rien d'autre : pas de collecte de métriques, pas de tableau de bord, pas
de traçage distribué. Les questions d'exploitation à cette échelle se
répondent par trois requêtes SQL — projets non terminaux, dépenses du
mois, échecs des 7 derniers jours — et le journal Cloud Logging du Job
suffit au diagnostic. Le jour où on lit ces requêtes plus de deux fois
par jour, il sera temps d'en faire un écran. Pas avant.

---

## 10. Plan d'implémentation

### 10.1 Où chaque partie est construite

| Section | T-1 | T0 | T0b | T1 | T2 | T3 | T4 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| §2 Postgres `ops` + `history` | | | | | | ● | |
| §3 Machine à états, watchdog | | | | | | ● | |
| §4 `svc-conversation` | | | | | | | ● |
| §4 `job-produce` | | | | ○ | ○ | ● | |
| §4 `job-tts` (GPU) | | | ○ | | | ● | |
| §5.1 Adaptateur de rendu | | ● | | ● | ● | | |
| §5.2 Adaptateur de génération | | | | | ○ | ● | |
| §6 Menu, Monteur, compilateur | | | | | ○ | ● | |
| §7 Production audio | | | ● | ● | | ● | |
| R9 / R10 (contrôles de sortie) | | ● | | ● | | | |
| §8 Canal admin | | | | | | | ● |
| §9 Erreurs et alertes | | | | ○ | | ● | ● |

● construit — ○ ébauché à la main, sans automatisation

**T0 et T1 travaillent sans base de données.** L'état d'un projet y vit
dans un `projet.json` sur R2 qui porte **exactement les noms de colonnes**
de `ops.projet`. T3 est alors une migration mécanique, pas une
réécriture — et si les noms divergent, on l'aura su tôt.

### 10.2 Prérequis, avant tout code

Ils ne sont dans aucune tranche parce qu'ils ne dépendent de rien et
bloquent tout le reste.

| Prérequis | Bloque | Quand |
|---|---|---|
| System User + token permanent | T1 (tout envoi) | maintenant |
| Template utility approuvé | §8.6, donc toute alerte nocturne | maintenant (délai Meta) |
| Carte de paiement Google Cloud acceptée | `job-tts`, donc T3 | à tester tôt |
| Offre Supabase payante (É-3) | 24/7, donc T3 | avant T3 |
| Webhook HTTPS + champ `messages` + signature | T4 | avec T4 |
| Mode Live + profil business explicite | premier client hors développement | avant T4 |

### 10.3 T-1 — ce que veut vraiment le client existant

*En parallèle de T0.* 3 à 5 vidéos produites à la main.

À produire en plus des vidéos : un relevé par vidéo — assets fournis
(nombre, qualité), corrections demandées et **leur nature** (les motifs
fermés du §8.2), délai réellement accepté, usage final. Ce relevé est la
première source du Brand Pack (B15) et de la table du flou, et la seule
mesure honnête du délai avant que D36 ne devienne un engagement.

**Sortie** : un Brand Pack rédigé, une liste de motifs de refus réels, un
délai observé.

### 10.4 T0 — le moteur rend-il pro ?

*Le pari D7.* Un template, 3 jeux d'assets, aucun pipeline.

Au-delà des critères A/B/C du document d'état, T0 doit répondre à **trois
questions d'architecture** qui décident du reste :

1. `capacites().lint_dom` — le DOM pré-rendu est-il inspectable ? Sinon
   R5, R7 et R8 ne sont pas exécutables, et c'est le bloc qualité au
   meilleur rapport effort/risque de tout le pipeline qui tombe (É-5).
2. `capacites().slots_declares` — le manifeste correspond-il au HTML
   (T11) ? Sinon c'est `Template.schema.json` qui change.
3. Le `hash_frames` est-il stable entre deux rendus identiques ? Sinon le
   déterminisme n'est pas une propriété du moteur, et le test
   d'acceptation de R11 est inatteignable.

**À construire en T0, et pas plus** : l'adaptateur de rendu réduit à
`capacites()` et `rendre()`, le lint de zone de sécurité, et les
contrôles R9/R10 — le critère A du document d'état exige qu'ils soient
vérifiés par code, et ils serviront jusqu'en production.

**Sortie** : le format d'authoring figé, un verdict sur D7, sur le lint
DOM et sur les emplacements déclarés.

### 10.5 T0b — la synchronisation audio tient-elle ?

*Sur Colab (D31), sur un des jeux d'assets de T0.*

À décider ici, parce que tout le §7 en dépend : le **choix de
l'aligneur** forcé, la mesure réelle du **débit de parole** en français
(la valeur utilisée par S5 est une hypothèse), le **catalogue de voix**
effectivement utilisable, et les constantes du §7 — amorce, `tail_ms`,
ducking à -12 dB, fusion à 400 ms, lit à -30 LUFS, effets à -18 dBFS,
espacement minimal de 300 ms.

Contrôle supplémentaire : le tatouage inaudible de Chatterbox survit-il à
l'encodage AAC à 128 kb/s ?

**Sortie** : les constantes du §7 mesurées et non supposées, le catalogue
de voix, l'aligneur choisi, l'image du futur `job-tts` esquissée.

### 10.6 T1 — peut-on livrer de bout en bout ?

`composition.json` écrit à la main → rendu → mixage → R10 → R9 →
livraison double. Pas de webhook : Franco déclenche, le système envoie.

Ordre : disposition R2 et préfixes → adaptateur de rendu complet
(`verifier()` inclus) → chaîne FFmpeg du §7.6 → envoi WhatsApp avec
`cle_envoi` → aperçu et master sur un vrai téléphone.

**Sortie** : une vidéo livrée en deux pièces, l'aperçu qui se lit dans le
fil, le master qui se télécharge intact, R9 et R10 vertes sur les deux.
C'est aussi le premier test de la contrainte des 16 Mo, celle qui se
découvre toujours trop tard, et de `has_b_frames = 0`, dont l'échec est
silencieux.

### 10.7 T2 — est-ce reproductible d'une marque à l'autre ?

Brand Pack du client réel + 3 ou 4 templates. C'est ici que se règlent
l'échelle typographique, la `motion_signature` (B5), les `transition_map`
et `camera_map`, le jeu de sons structurels (B13) — tout ce que le
compilateur **lira** au lieu de calculer.

**Sortie** : deux marques rendues par la même structure de composition,
sans une ligne de code modifiée. Le critère du document d'état — « code
modifié entre les 3 jeux d'assets : aucun » — s'applique ici aussi, et il
est plus dur.

### 10.8 T3 — la compilation s'automatise-t-elle ?

La tranche la plus lourde. Ordre imposé par le risque, chaque étape
utilisable avant la suivante :

1. **Base** : les deux schémas, les contraintes, les index, et un test
   qui prouve l'isolation — une ligne d'un client rattachée au projet
   d'un autre doit être **rejetée par la base**, pas par le code.
2. **Machine à états et baux** : transitions gardées (§3.1),
   `ops.execution_job`, `job-produce` réduit à prendre le bail et
   avancer. Testable en injectant des états à la main.
3. **Adaptateur de génération et plafonds** ensemble : ils partagent une
   transaction. Test : une relance après coupure ne crée pas de seconde
   ligne `ops.generation`.
4. **`job-tts`** : image GPU avec poids embarqués, synthèse par scène,
   alignement, écriture R2 + base.
5. **Menu (M3) et compilateur** : testables **sans LLM**, avec des
   `montage_plan` écrits à la main. C'est la pièce à tester le plus
   durement, puisque c'est elle qui ne doit rien décider.
6. **Monteur** : prompt à vocabulaire fermé, validateur M1–M15, une
   reprise. Le pipeline doit être complet **avant** lui : le LLM est la
   dernière pièce, pas la première.
7. **Watchdog** et alertes (§3.5, §9), puis contrôle de disponibilité
   externe.

**Sortie** : un projet lancé par une insertion en base et un storyboard
conforme arrive livré, sans intervention hors revue de Franco. Et le test
qui compte : **relancer le job depuis chaque état et vérifier que
`count(ops.generation)` ne bouge pas.** C'est la règle de reprise, rendue
mesurable.

### 10.9 T4 — la conversation s'automatise-t-elle ?

Ordre imposé par ce qu'on perd en cas d'absence :

1. **Webhook** : signature, dédup, 200 immédiat, **copie du média sur R2
   avant toute logique** — ce qui n'est pas copié est définitivement
   perdu.
2. **Canal admin** (§8) : avant le reste, parce que c'est ce qui permet
   d'exploiter le système pendant qu'on construit la suite.
3. **Classifieur** + liste blanche + message hors périmètre (D2, D25).
4. **Clarificateur** : slots, boutons, listes, brouillon par défaut,
   extraits de démonstration, échantillons de voix.
5. **Storyboard LLM** + règles S1–S11 + boucle de validation client.

**Sortie** : un message WhatsApp réel devient une vidéo livrée, avec une
seule intervention humaine — la validation de Franco. Et le canal admin
permet d'ajouter un client et de relancer un job depuis le téléphone.

---

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

## 12. Points ouverts qui bloquent une partie de l'architecture

Classés par ce qu'ils empêchent d'écrire, pas par urgence ressentie.

**B1 — Validation nocturne. RÉSOLU le 28/09** : Franco valide lui-même,
24 h/24. Aucune arête automatique à construire, la machine à états se
ferme telle quelle. Voir §11.1, D22 ∧ D36, pour les deux instruments à
conserver.

**B2 — Moteur de rendu (D7, T0). BLOQUE** le gel de `capacites()`, la
validité de R5/R7/R8 et de T11, et la règle de dimensionnement
typographique. Rien en aval du §5.1 ne doit être figé avant le verdict de
T0.

**B3 — Aligneur forcé non choisi. BLOQUE** le §7.3 et l'image de
`job-tts`. Sans lui, pas d'ancre `on_word` : les emphases et les sons
sémantiques se dégradent tous en début de scène, et le montage perd ce
qui le distingue d'un diaporama. À choisir en T0b.

**B4 — Constantes audio non mesurées. BLOQUE** la calibration de S5 (le
débit de parole est une hypothèse) et les constantes du §7. Conséquence
concrète : tant qu'elles ne sont pas mesurées, un storyboard accepté par
S5 peut produire une vidéo qui dépasse 30 s, donc un rejet tardif. À
mesurer en T0b.

**B5 — Carte de paiement Google Cloud. BLOQUE** `job-tts`, donc toute la
voix off, donc D19 et D20, donc T3 entier. C'est le blocage le plus
grossier de la liste et le plus facile à découvrir trop tard : à tester
dès maintenant, avec le risque connu sur les cartes prépayées.

**B6 — Offre Supabase (É-3). BLOQUE** le 24/7 à partir de T3.

**B7 — Template utility Meta. BLOQUE** le §8.6, donc toute alerte hors
fenêtre de 24 h, donc le watchdog nocturne — c'est-à-dire précisément le
cas où le watchdog sert. Le délai est celui de l'approbation Meta : à
déposer maintenant.

**B8 — Catalogue de voix (É-11). BLOQUE** le slot « voix » du
clarificateur, la règle S4 et `brand_pack.voice.allowed_voice_ids`
(B14). Livrable de T0b.

**B9 — Fenêtre de non-réutilisation musicale. RÉSOLU le 28/09 : 30
jours.** Conséquence de dimensionnement : l'exclusion ne joue qu'entre
clients, et un client qui repasse commande garde sa piste. La demande
simultanée est donc « 3 clients × ambiances réellement utilisées », pas
60 pistes par an — de l'ordre de **8 à 10 pistes par ambiance**, soit 50
à 60 au téléchargement initial. Effet de bord à connaître : au bout de 30
jours, une piste livrée au client A redevient éligible pour le client B.

**B10 — Plafonds de coût : valeurs d'amorçage proposées, à confirmer.**
D35 fixe le principe, pas les montants. Proposition en attente
d'acceptation : 200 c par vidéo, 50 c par visuel, 30 c par retouche ;
15 000 c, 3 000 c et 2 000 c par mois. Devise unique : **le cent de
dollar**, jamais le franc CFA — les fournisseurs facturent en USD, et
figer un taux de change dans une colonne `integer` est une erreur qu'on
ne découvre qu'au moment où le disjoncteur ne se déclenche pas. Depuis
le 28/09, le plafond ne protège **plus** d'une boucle LLM (appels
gratuits chez Groq) : cette protection repose entièrement sur les deux
bornes de reprise du §6.1. **BLOQUE** l'amorçage de `ops.plafond_cout` et donc T7 : sans
valeur, `budget_centimes` vaut zéro et aucune génération ne part. Une
valeur provisoire suffit pour T3, mais elle doit exister, et le document
d'état la renvoie au modèle commercial, qui est reporté.

**Non bloquants**, pour mémoire : fournisseur LLM (n'affecte que
l'estimation de coût du §5.2 et le budget de prompt du Monteur) ;
couverture audio de l'API Pixabay (l'import manuel est déjà le plan) ;
survie du tatouage Chatterbox à l'AAC (à constater, sans effet sur
l'architecture) ; durée maximale du statut WhatsApp au Burkina (30 s est
déjà la plus basse des trois plateformes) ; langues locales et clonage de
voix (hors v1) ; modèle commercial (les plafonds sont des paramètres, pas
une structure) ; statistiques de diffusion (elles alimenteraient
`history`, qui les accueille déjà).

---

## 13. Ce que ce document ne contient pas

- **Aucun code applicatif.** Le DDL et les schémas JSON sont des
  contrats, pas du code.
- **Aucune réécriture des contrats de `setup/`.** Les règles S, M, R, T
  et B sont citées, jamais recopiées : une règle recopiée est une règle
  qui dérivera.
- **Aucun jugement esthétique.** Il appartient à Franco (D22), et le
  système lui donne de quoi l'exercer : l'aperçu, la `qa.checklist`, les
  dégradations T9 appliquées et les `why` du Monteur.
