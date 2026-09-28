> Architecture d'exécution v1 — extrait du §2, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
