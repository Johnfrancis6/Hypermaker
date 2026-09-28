> Architecture d'exécution v1 — extrait du §6, texte inchangé. Sommaire : [architecture_runtime_v1.md](../architecture_runtime_v1.md)

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
