> Architecture d'exécution v1 — extrait du §3, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
