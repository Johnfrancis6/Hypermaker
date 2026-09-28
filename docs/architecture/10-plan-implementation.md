> Architecture d'exécution v1 — extrait du §10, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
