> Architecture d'exécution v1 — extrait du §0, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
