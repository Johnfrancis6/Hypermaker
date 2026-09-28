> Architecture d'exécution v1 — extrait du §12, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
