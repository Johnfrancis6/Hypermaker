> Architecture d'exécution v1 — extrait du §9, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
