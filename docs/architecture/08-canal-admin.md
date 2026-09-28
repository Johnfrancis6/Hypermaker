> Architecture d'exécution v1 — extrait du §8, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
