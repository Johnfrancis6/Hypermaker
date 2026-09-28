> Architecture d'exécution v1 — extrait du §1, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
