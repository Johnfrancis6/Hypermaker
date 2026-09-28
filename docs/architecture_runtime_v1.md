# Architecture d'exécution — v1

*Rédigé le 28/09/2026, à partir du document d'état du 26/09/2026 et des
contrats de `setup/`. Révisé le 28/09 au soir : sept décisions prises
en session sont intégrées et repérées par **[D-28/09]**. Les décisions D1 à D36 sont tenues pour acquises :
ce document les met en œuvre, il ne les rediscute pas. Les désaccords
sont rassemblés au §11, sans effet ailleurs.*


Ce document est découpé en un fichier par section, dans `docs/architecture/`.
Le texte de chaque section est repris sans modification ; les renvois
« §N » restent valides, le numéro de section est le préfixe du fichier.

| Section | Sous-sections |
|---|---|
| [0. Où s'arrête ce document](architecture/00-perimetre.md) | — |
| [1. Vue d'ensemble](architecture/01-vue-ensemble.md) | 1.1 Trois unités de déploiement · 1.2 Flux nominal, projet vidéo · 1.3 Ce que le runtime garantit aux contrats |
| [2. Schéma Postgres](architecture/02-schema-postgres.md) | 2.1 Identifiants et isolation · 2.2 Types · 2.3 Clients, projets, objets · 2.4 Générations payantes · 2.5 Marque, templates, voix · 2.6 Bibliothèque audio, licences, non-réutilisation · 2.7 Messages WhatsApp · 2.8 Exécutions, budgets d'état, plafonds, commandes · 2.9 `history` — permanent, append-only · 2.10 Purge (D27) |
| [3. Machine à états](architecture/03-machine-a-etats.md) | 3.1 Ce qu'un état garantit · 3.2 Les états · 3.3 Transitions · 3.4 Horloge de service et délai de 4 h (D36) · 3.5 Watchdog · 3.6 Ce que coûte une relance, état par état |
| [4. Services, Jobs et flux](architecture/04-services-jobs-flux.md) | 4.1 `svc-conversation` · 4.2 `job-produce` · 4.3 `job-tts` · 4.4 Flux entre unités · 4.5 Identités et secrets |
| [5. Les deux adaptateurs](architecture/05-adaptateurs.md) | 5.1 Adaptateur de moteur de rendu · 5.2 Adaptateur de génération |
| [6. Orchestration du Monteur et du compilateur](architecture/06-monteur-compilateur.md) | 6.1 La séquence dans `ASSETS_READY` · 6.2 Ce que reçoit le Monteur, et rien d'autre · 6.3 Le compilateur |
| [7. Production audio](architecture/07-production-audio.md) | 7.1 Chaîne complète · 7.2 Voix off · 7.3 Alignement mot à mot · 7.4 Effets sonores · 7.5 Musique et ducking · 7.6 Mixage, normalisation, encodage · 7.7 Reprise dans le pipeline audio |
| [8. Canal admin WhatsApp (D29)](architecture/08-canal-admin.md) | 8.1 Chaîne de traitement · 8.2 Les douze commandes · 8.3 Schéma de validation · 8.4 Garde-fous · 8.5 Audit · 8.6 Alertes hors fenêtre de 24 h |
| [9. Erreurs et alertes (O4-B, D33)](architecture/09-erreurs-alertes.md) | 9.1 Taxonomie · 9.2 Messages neutres au client · 9.3 Alertes à Franco · 9.4 Ce qui est hors du système |
| [10. Plan d'implémentation](architecture/10-plan-implementation.md) | 10.1 Où chaque partie est construite · 10.2 Prérequis, avant tout code · 10.3 T-1 — ce que veut vraiment le client existant · 10.4 T0 — le moteur rend-il pro ? · 10.5 T0b — la synchronisation audio tient-elle ? · 10.6 T1 — peut-on livrer de bout en bout ? · 10.7 T2 — est-ce reproductible d'une marque à l'autre ? · 10.8 T3 — la compilation s'automatise-t-elle ? · 10.9 T4 — la conversation s'automatise-t-elle ? |
| [11. Écarts relevés](architecture/11-ecarts-releves.md) | 11.1 Contradictions entre décisions · 11.2 Décisions d'exécution prises par ce document |
| [12. Points ouverts qui bloquent une partie de l'architecture](architecture/12-points-ouverts.md) | — |
| [13. Ce que ce document ne contient pas](architecture/13-hors-contenu.md) | — |
