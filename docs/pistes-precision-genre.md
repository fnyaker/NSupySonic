# Rendre le modèle de genre plus précis — état des pistes

Ce document recense les pistes trouvées dans la littérature et ce qui en a été
retenu. Il sert de référence : chaque entrée dit **pourquoi** la piste marche,
**ce qu'elle coûte** ici, et **si elle a été implémentée**.

Le contexte compte pour juger les pistes : l'extracteur
(`discogs-effnet-bsdynamic-1.onnx`, MusiCNN) est gelé et ne sera jamais
ré-entraîné ; seule la petite tête linéaire posée dessus est apprise, sur
quelques centaines de morceaux tagués à la main. Toute amélioration doit donc
soit améliorer la **qualité du vecteur** (extraction), soit améliorer
l'**usage** qui en est fait (agrégation, calibration, entraînement).

---

## Implémenté

### 1. Calibration par température (fait)

**La piste.** Un softmax entraîné sur peu d'exemples est systématiquement
**trop confiant** : une tête juste à 70 % annonce volontiers 0,95. Guo et al.
(2017, *On Calibration of Modern Neural Networks*) montrent que diviser les
logits par un scalaire `T` ajusté sur un jeu tenu à l'écart — la « temperature
scaling » — corrige cette sur-confiance sans réentraîner quoi que ce soit.

**Pourquoi ça compte ici et pas seulement dans un benchmark.** Le serveur
(`deezer/analysis.py`) ne se contente pas de ranger la prédiction : il **agit
dessus**. Un label prédit remplace le style mesuré par les règles, donc
l'archétype visuel du morceau. Une tête sur-confiante fait donc appliquer ses
erreurs, pas seulement les afficher. La calibration transforme « 0,95 » en un
nombre qui veut dire quelque chose, et le seuil `MODEL_MIN_CONFIDENCE` se met à
signifier la même chose quelle que soit la quantité de tags.

**Pourquoi c'est sans risque.** Diviser tous les logits par le même `T` ne peut
pas changer leur ordre : l'argmax — donc le label affiché dans le studio — est
strictement invariant. Seule la *forme* de la distribution change. C'est
démontré par un test côté JS (`l'argmax ne bouge pas`) et côté serveur.

**Comment elle est mesurée.** `fitTemperature()` (dans `webapp/src/lib/genre/`
`train.js`, utilisée aussi par l'entraînement profond) ajuste `T` par minimum
de NLL sur les **logits des plis de validation** — jamais sur les données
d'entraînement, où le résultat serait mécaniquement 1 puisque c'est là qu'est
l'inflation. Grille grossière de 0,5 à 4, pas de solveur : sur quelques
centaines d'exemples, une précision plus fine ajuste du bruit.

**Ce que ça ne fait pas.** Ça ne rend pas le modèle plus *juste*, ça le rend
plus *honnête*. La justesse passe par les pistes ci-dessous.

### 2. Agrégation mean + écart-type (déjà en place avant ce chantier)

Le vecteur stocké fait 2×1280 : la moyenne **et** l'écart-type des patchs dans
le temps, chacun normalisé L2 avant concaténation. C'est l'agrégation que les
auteurs du modèle publient, et la littérature (voir ci-dessous) la mesure comme
un gain de justesse direct sur un extracteur gelé. Rien à faire, mais à ne pas
casser : la dimension du sidecar **est** la version du format.

---

## Le reste des pistes, par ordre d'intérêt

Chaque entrée dit désormais explicitement son état : certaines de cette section
ont été implémentées à la suite de ce chantier, d'autres non.

### 3. Fusionner plusieurs extracteurs — le gain le plus documenté

**La piste.** L'article *Music auto-tagging in the long tail: A few-shot
approach* (2024) compare VGGish, OpenL3 et PaSST en few-shot et conclut deux
choses : (a) PaSST > OpenL3 > VGGish, (b) **combiner les embeddings de
plusieurs modèles** donne des performances au niveau de l'état de l'art *et*
une meilleure efficacité en données — c'est-à-dire exactement la situation
d'ici. VGGish et OpenL3 sont en plus les plus complémentaires : l'un est
supervisé sur AudioSet, l'autre auto-supervisé audio-vidéo, ils se trompent
donc différemment.

**Ce que ça coûte.** Deux dépendances et deux modèles de plus, un sidecar par
extracteur, et un vecteur concaténé de dimension supérieure — donc un entraînement
plus lent et un risque accru de sur-apprentissage avec peu d'exemples. C'est un
chantier, pas un ajustement.

**Verdict.** À garder pour le jour où la tête linéaire sature vraiment. Le
rapport gain/complexité est réel mais l'investissement n'est pas marginal.

### 4. MERT à la place de MusiCNN — le meilleur plafond

**La piste.** MERT (Li et al., 2023, *Acoustic Music Understanding Model with
Large-Scale Self-supervised Training*) est un Transformer auto-supervisé
entraîné sur de la musique, avec des objectifs auxiliaires de hauteur, chroma et
tempo. Ses représentations atteignent l'état de l'art sur le tagging, le genre
et le rythme — ses auteurs notent explicitement qu'elles « reconnaissent bien
les motifs globaux », ce qui est précisément la faiblesse d'un extracteur de
patchs de 2 secondes.

**Ce que ça coûte.** Un modèle beaucoup plus gros, une fenêtre de 30 s (donc un
coût d'inférence bien supérieur par piste), et un format d'entrée différent à
revalider entièrement. Sur une bibliothèque locale, le coût de backfill devient
significatif.

**Verdict.** La piste au meilleur plafond, et la plus grosse facture. Si la
précision reste insuffisante après les pistes 3 et 5, c'est ici qu'il faut
aller — mais en acceptant que l'extraction se compte en heures, pas en minutes.

### 5. Pooling par attention apprise — la version « il suffit de changer l'agrégation »

**La piste.** Le mean+std est une agrégation **sans paramètres**. La
littérature (Temporal Attentive Pooling ; PMA, *Pooling by Multihead
Attention*) montre qu'apprendre *quels patchs compter* — une tête d'attention
qui donne un poids à chaque patch — bat systématiquement les poolings
statistiques classiques. Intuitivement : le pont d'un morceau et son drop ne
devraient pas peser autant dans la description du morceau.

**Pourquoi c'est malin dans ce contexte précis.** L'attention est une couche
*après* l'extracteur gelé. Elle s'entraînerait dans le même espace
d'embedding que la tête actuelle, donc avec les mêmes exemples — mais elle a
besoin des embeddings **par patch**, pas du vecteur moyenné, ce qui veut dire
changer le sidecar pour stocker les patchs. C'est le vrai coût : la dimension
du sidecar est aujourd'hui la version du format, il faudrait un v3.

**Verdict.** La piste qui rapporte le plus par unité de risque *si* on accepte
un v3 du format. Un bon candidat intermédiaire entre « ne rien faire » et
« changer d'extracteur ».

### 6. Augmentation de données à l'extraction

**La piste.** *Music genre classification using deep neural networks and data
augmentation* et les travaux de few-shot tagging en font une source de gain peu
coûteuse. Deux variantes :

- **Augmentation des entrées à l'entraînement** : avec 2×1280 dimensions pour
  quelques centaines d'exemples, ajouter du bruit gaussien léger aux vecteurs
  d'entraînement est un régularisateur simple et parfois efficace. C'est
  degré 1 en complexité.
- **Augmentation à l'extraction** : ré-extraire chaque morceau à deux ou trois
  hauteurs légèrement différentes (pitch-shift) et moyenner, ce qui se rapproche
  de l'effet d'un ensemble. Beaucoup plus coûteux, gain incertain.

**Verdict.** La variante bruit est triviale à essayer ; elle devrait être testée
avant toute décision d'architecture. La variante pitch-shift demande de
multiplier le coût de backfill.

**Ce qui a été fait.** Le bruit gaussien par entrée existe dans `train.js`,
**désactivé par défaut** (`noise: 0`) et limité aux vecteurs pleine dimension.
C'est délibéré : sur des vecteurs normalisés L2 en 2×1280 dimensions, du bruit
isotrope coûte vite plus de justesse qu'il n'en rend, et la piste n'a pas été
validée sur une bibliothèque réelle. Le réglage est donc offert, exposé dans les
métriques (`metrics.noise`), et **inerte** tant que personne ne l'allume. La
variante pitch-shift n'a pas été retenue (coût de backfill).

### 7. Étudier la marge plutôt que la confiance seule — déjà en place

`MODEL_MIN_MARGIN` exige déjà un écart avec le second. C'est la bonne pratique
mise en évidence par les travaux sur la sélection par rejet, et c'est le garde-fou
le plus important de la chaîne : il distingue « 0,6 sur uptempo, 0,55 sur
frenchcore » (rien décidé) de « 0,5 contre 0,02 » (décidé). Rien à changer,
mais c'est ce qui rend la calibration réellement utile plutôt que décorative.

---

## Pistes liées au fait de MIEUX TAGGER — le levier le plus sous-estimé

Tout ce qui précède améliore le modèle **à nombre d'étiquettes constant**. Mais ici la ressource rare n'est pas la puissance de calcul, c'est **ton temps de taggage**. La littérature d'apprentissage actif dit qu'à budget d'annotation égal, l'ordre dans lequel on étiquette change le résultat bien plus que l'architecture. Ces pistes sont donc souvent les plus rentables de toutes.

### 8. Trier les candidats par incertitude, pas par nombre d'écoutes — **la piste la plus rentable**

**Le problème actuel.** `genre_candidates()` (dans `webui/genre.py`) trie par `Track.play_count.desc()`. C'est un choix documenté et raisonnable : on annote d'abord ce qu'on écoute. Mais ces deux objectifs ne sont pas le même : le morceau le plus écouté est souvent le plus **évident**, donc celui dont l'étiquette n'apprend presque rien. Les cent premières étiquettes partent donc sur les cas les plus faciles, et le modèle reste fragile là où ça compte — sur les frontières hardtekk/frenchcore/zaag, qui sont exactement les cas rares.

**La piste.** L'*uncertainty sampling* (l'article de synthèse de Weng, la littérature active learning) est l'acquis le mieux établi du domaine : étiqueter en priorité les exemples où le modèle est **le moins sûr** rapporte le plus par étiquette. Sur des tâches audio, le gain typique est de plusieurs points de justesse à budget d'annotation identique — c'est-à-dire gratuit.

**Pourquoi c'est devenu possible exactement maintenant.** L'incertitude d'un softmax n'était pas une quantité comparable d'un morceau à l'autre tant qu'elle était mal calibrée : comparer « 0,52 » d'un morceau à « 0,55 » d'un autre n'a de sens que si ces nombres veulent dire la même chose. **La calibration par température qu'on vient d'implémenter est précisément ce qui rend ce tri légitime.** Les deux pistes se tiennent : la température rend la confiance interprétable, et l'apprentissage actif l'utilise comme critère de sélection.

**Ce qu'il faut faire.** Un tri des candidats par incertitude, en deux temps :

1. **Incertitude** : le plus simple est la **marge** (`p_top − p_second`), déjà calculée par `genre.predict`. La plus petite marge = le cas le plus ambigu. L'entropie de la distribution est une variante. Il faut échantillonner aussi un peu **au hasard** (10-20 %) : l'incertitude seule enferme le taggeur sur les mêmes cas limites et laisse des genres entiers non vus (« cold start » documenté dans la littérature).
2. **Diversité** : l'incertitude seule interroge cent fois le même cas limite. Un tour de *diversity sampling* — ou simplement un plafond par genre prédit — garantit la couverture.

**Le compromis à trancher.** Le tri par écoutes a une vraie vertu : il fait que le modèle s'améliore d'abord sur ce que tu écoutes vraiment. Le tri par incertitude optimise la justesse globale, ce qui peut passer du temps sur des morceaux que tu n'écoutes jamais. Un score mixte (incertitude × racine du nombre d'écoutes) capture les deux. **C'est un choix produit, pas un choix technique** — c'est pourquoi il n'est pas tranché à ta place : les deux ordres sont offerts, `plays` reste le défaut, et le studio porte un sélecteur explicite (« Les plus écoutés » / « Les plus incertains »). Le tri par incertitude laisse par ailleurs une **réserve aléatoire** dans la page, exactement pour la raison de « cold start » évoquée plus haut : sans elle, le taggeur tournerait indéfiniment autour du même amas de cas limites.

**Ce qui a été fait.** `genre_candidates()` accepte `sort=active` ; la fenêtre de scan est alors élargie (`CANDIDATE_SCAN_ACTIVE`) parce que trier par incertitude sur le seul dessus du classement par écoutes ne réordonnerait que la musique qui a le moins besoin d'être tagguée. L'incertitude (`1 − marge`) est servie sur chaque candidat, y compris sans tête chargée.

### 9. Classifieur par plus proche centroïde (« nearest class mean »)

**La piste.** Sans aucun entraînement : chaque genre est représenté par la moyenne des vecteurs de ses exemples, et on classe au plus proche. C'est le classifieur « prototype » des travaux few-shot (on le retrouve dans la comparaison VGGish/OpenL3/PaSST et dans toute la littérature few-shot), et il est **étonnamment fort** quand il y a peu d'exemples — précisément le régime où le MLP n'a rien à mordre.

**Pourquoi c'est intéressant ici, concrètement.** Le studio refuse d'entraîner une classe à moins de trois exemples (`"deep training needs at least three examples per genre"`), et la tête linéaire est instable en dessous. Le plus proche centroïde n'a **pas de minimum** : avec un seul exemple il fait déjà quelque chose de sensé. Il est aussi **incrémental** : ajouter une étiquette met à jour une moyenne, sans réentraîner.

**Verdict.** À considérer comme le socle et le repli, pas comme un remplaçant : il donne une prédiction utilisable dès la première étiquette, ce qui rend le studio utile immédiatement au lieu de « après vingt tags ». Coût d'implémentation faible.

**Ce qui a été fait.** `centroids()` / `prototype_predict()` (`deezer/genre.py`) : moyenne des vecteurs étiquetés par genre, normalisés L2 **avant** moyenne (la longueur du vecteur n'est pas un signal de genre), puis similarité cosinus. Le résultat est une paire `(genre, ressemblance)` affichée dans le studio comme **seconde opinion**, jamais comme proposition : le prototype n'a pas de confiance à seuiller, donc il a le droit de suggérer et pas celui de décider. Il n'alimente jamais le style servi par l'analyse — c'est ce que vérifie un test. Une précision de sûreté : un prototype n'est comparé qu'à un vecteur de **même largeur**. Une bibliothèque dont les sidecars n'ont pas tous été ré-extractés contient encore des vecteurs v1 (1280) à côté de centroïdes v2 (2560) ; ce sont deux espaces de descripteurs différents, et les croiser était la cause du 500 sur `/api/genre/candidates`. Un morceau dans ce cas n'obtient simplement **pas d'avis**, pas un avis faux — et pas une erreur. La table est mise en cache avec une signature du **jeu** d'étiquettes (noms *et* effectifs par genre, parce qu'une deuxième étiquette sur un genre existant ne change aucun nom mais déplace bien son centroïde) et invalidée à chaque écriture d'étiquette.

### 10. Semi-supervision et pseudo-étiquetage — exploiter la bibliothèque non étiquetée

**La piste.** C'est la piste la plus citée pour exactement cette situation (« peu d'exemples étiquetés, beaucoup de données brutes ») : l'approche semi-supervisée de la classification de genre, et le *self-training* / *pseudo-labelling* décrit dans le tutoriel de classification musicale. Un modèle « enseignant » étiquette les morceaux non étiquetés dont il est **sûr**, et un modèle « élève » réentraîne sur étiquettes réelles + pseudo-étiquettes. Les auteurs notent que les étiquettes **douces** (distributions) marchent un peu mieux que les dures, surtout quand les données non étiquetées viennent d'une autre distribution.

**Pourquoi c'est crédible ici.** La bibliothèque contient des milliers de morceaux dont on n'étiquettera jamais qu'une fraction. Le vecteur de chacun est déjà calculé. C'est donc uniquement du calcul, pas d'annotation.

**Le risque, et pourquoi la calibration aide encore.** Le danger du pseudo-étiquetage est le **biais de confirmation** : le modèle renforce ses propres erreurs. La parade standard est un seuil de confiance élevé — et ce seuil n'est fiable que si la confiance est calibrée, ce qui boucle sur la piste 1. Un seuil naïf (« au-dessus de 0,9 ») sur un softmax sur-confiant laisse passer exactement les erreurs bruyantes qu'il était censé filtrer.

**Verdict.** Fort potentiel, complexité modérée, mais à faire *après* l'apprentissage actif : mieux vaut d'abord étiqueter intelligemment que de fabriquer des étiquettes synthétiques.

### 11. Classifieur hiérarchique et « jeu de confusion »

**La piste.** L'approche hiérarchique est un classique (la classification à deux niveaux grossier/fin, le « confusion set » où, après un premier regroupement, un classifieur ne départage que les quelques candidats plausibles). Elle « réduit la probabilité d'erreurs coûteuses » : se tromper entre deux sous-genres voisins est moins grave que confondre rap et techno, et la structure le dit au modèle.

**Pourquoi c'est presque gratuit ici.** Le studio calcule **déjà** une matrice de confusion complète à chaque entraînement (`metrics.confusion`). Cette matrice *est* le regroupement : elle dit quelles classes se confondent, mesuré sur les données réelles, sans avoir à écrire une taxonomie à la main. On peut donc dériver automatiquement la hiérarchie au lieu de la demander.

**Bénéfice secondaire, peut-être le plus utile.** La même matrice, présentée dans le studio, dit à l'utilisateur *quels genres il confond lui-même* en taggant. C'est une information d'audit : un rappel faible entre uptempo et frenchcore peut vouloir dire que le modèle est faible **ou** que les deux étiquettes sont appliquées de façon incohérente. Aujourd'hui le studio affiche la matrice ; il ne la commente pas.

**Ce qui a été fait.** Les paires confondues sont dérivées de la matrice à
l'entraînement (`metrics.confusions`, triées du pire au moindre) et affichées
dans le studio sous la matrice. La formulation est volontairement une
**question** et non un verdict : deux genres qui se confondent sont soit deux
sons vraiment proches, soit un seul genre nommé de deux façons. Le modèle ne
peut pas trancher entre les deux — l'utilisateur, si. La partie *hiérarchique*
(un second classifieur qui ne départage que les paires confondues) n'est en
revanche **pas** faite : elle ajoute une seconde tête et un second format de
modèle pour un gain modéré. L'audit, lui, était gratuit.

### 12. Concaténer les couches intermédiaires de l'extracteur

**La piste.** L'extracteur actuel ne prend que la couche pénultième. Les travaux de transfert musical (le « convnet feature » multi-niveaux, `musicnn` avec classifieur linéaire) montrent qu'**agréger les activations de plusieurs couches** — typiquement les couches 3 et 4 d'un ConvNet — surpasse systématiquement une seule couche : les basses couches portent le timbre, les hautes la structure globale.

**Ce que ça coûte ici.** Contrairement aux pistes 3 et 4 qui changent de modèle, celle-ci garde le **même** modèle : il suffit de lire une sortie supplémentaire, puis de concaténer. C'est le gain multi-échelle le moins cher de la liste. Le coût réel est un **v3 du format** de sidecar (vecteur plus large) et une ré-extraction de la bibliothèque.

**Verdict.** Bon candidat si l'on accepte un changement de format, mais moins bien documenté que l'attention (piste 5) pour ce modèle précis. À mettre derrière la piste 5.

### 13. Ensemble de têtes (plusieurs graines)

**La piste.** Entraîner N têtes avec des initialisations et des plis différents, puis moyenner leurs probabilités. Réduction de variance pure, bien connue, sans changement de format : l'interface `GenreModel` fonctionne telle quelle avec une tête de plus.

**Pourquoi c'est abordable ici.** L'entraînement d'une tête linéaire prend ~1 s et la profonde ~5-10 s. En entraîner cinq reste confortable dans un worker.

**Ce que ça n'apporte pas.** C'est un gain modeste et il ne corrige aucun problème de fond. À garder comme raffinement optionnel, pas comme piste structurante.

**Ce qui a été fait.** La tête expédiée est la **moyenne** des têtes d'un sac
(par défaut 3, à partir d'un seuil d'exemples). Une précision de fond : plutôt
que d'entraîner N fois puis de moyenner les *probabilités* — ce qui exigerait
d'envoyer N jeux de poids et de changer le format du modèle — on **moyenne les
poids** et on n'envoie qu'une tête. Même réduction de variance, à format
constant, ce qui est exactement la contrainte du `GenreModel` évoquée
ci-dessus. Le sac est visible dans les métriques (`metrics.bagged`).

### 14. Adaptation au domaine (audio bruyant)

La littérature sur les représentations robustes (entraînement adversarial de domaine) traite l'écart entre audio propre et audio dégradé. **Peu pertinent ici** : une bibliothèque locale est faite de fichiers propres, et il n'y a pas de décalage de domaine à corriger. Mentionné pour mémoire, à ne pas poursuivre.

### Note : le multi-étiquette est un non-objectif assumé

Le format « une étiquette par morceau » est un choix explicite et documenté (`genre_label` : « une piste qui est frenchcore ET uptempo apprend à la tête que ces deux étiquettes décrivent le même son »). Certaines pistes ci-dessus — la classification hiérarchique, la pseudo-étiquette douce — se déclinent naturellement en multi-étiquette, mais **cela irait contre cette décision**. Si l'envie vient un jour de la rouvrir, il faut la rouvrir comme telle, pas l'introduire par la bande.

---

## Ce qu'il ne faut **pas** faire

**Fine-tuner l'extracteur.** L'idée est tentante et c'est la mauvaise forme du
problème : quelques centaines d'exemples contre un modèle entraîné sur des
millions de morceaux. Le consensus de la littérature est net — un extracteur
gelé avec une petite tête bat l'entraînement de bout en bout à cette taille de
données, et le fine-tuning *dégrade* alors ce que le modèle savait. C'est déjà
la décision documentée dans l'en-tête de `deezer/embedding.py`, et ces
recherches ne font que la confirmer.

**Ajouter des couches parce qu'on peut.** Le classifieur profond (MLP, noyau
WASM) existe déjà et est justifié pour les frontières non linéaires
(hardtekk/frenchcore, zaag/uptempo). L'augmenter — plus de largeur, plus de
profondeur — sur des classes qui manquent d'exemples ne fait qu'accélérer le
sur-apprentissage. Le champ `hidden2` est là pour quand c'est nécessaire ; le
laisser à 0 est la bonne valeur par défaut.

---

## Résumé

Par ordre de rentabilité réelle (gain rapporté à l'effort), pas d'élégance :

| Piste | Gain attendu | Coût | État |
|---|---|---|---|
| Calibration par température | Confiance exploitable, moins d'erreurs appliquées | Faible | **Fait** |
| Tri des candidats par incertitude (8) | Fort à budget d'annotation égal | **Faible** | **Fait** (sélecteur dans le studio ; `plays` reste le défaut) |
| Plus proche centroïde (9) | Débloque le studio dès 1 étiquette | Faible | **Fait** (seconde opinion, jamais décisionnaire) |
| Audit des paires confondues (11) | Modéré, réduit les erreurs coûteuses | Faible | **Fait** (audit seul ; pas de 2ᵉ étage hiérarchique) |
| Bruit gaussien à l'entraînement (6) | Faible à modéré | Très faible | **Fait, désactivé par défaut** (à valider sur une vraie bibliothèque) |
| Ensemble de têtes (13) | Modeste | Faible | **Fait** (poids moyennés, format inchangé) |
| Pseudo-étiquetage (10) | Fort | Modéré | Non fait — après validation de (8) |
| Attention pooling, v3 du sidecar (5) | Modéré à fort | Moyen | Non fait — après (8) |
| Couches concaténées, v3 du sidecar (12) | Modéré | Moyen | Non fait — après (5) |
| Fusion d'extracteurs (3) | Fort | Élevé | Plus tard |
| MERT (4) | Fort | Très élevé | Si nécessaire |
| Agrégation mean + std | Justesse directe | — | Déjà en place |
| Adaptation au domaine (14) | Nul ici | — | À ne pas faire |
| Fine-tuning de l'extracteur | **Négatif** | Élevé | À éviter |

**Si une seule piste devait être retenue : la (8).** Elle ne coûte presque rien,
elle ne dépend d'aucun modèle nouveau, et — contrairement aux pistes 3 à 6 — elle
accélère le travail là où il se passe vraiment, c'est-à-dire à la main, en train
d'étiqueter. La calibration (1) en est le préalable : sans confiances comparables
d'un morceau à l'autre, trier par incertitude revient à trier sur du bruit.

**Ce qui reste, et pourquoi.** Les pistes non faites (5, 10, 12, 3, 4) ont un
point commun : elles demandent soit un **format de sidecar v3** et donc une
ré-extraction complète de la bibliothèque (5, 12), soit un **second modèle**
entraîné sur des étiquettes fabriquées par le premier (10), soit un changement
d'extracteur (3, 4). Aucune n'est mauvaise ; toutes coûtent un aller-retour
d'infrastructure dont l'intérêt se juge *après* avoir mesuré ce que (8) et (9)
donnent sur une bibliothèque réelle. Le bruit (6) est le seul réglage laissé
allumé à la main, précisément parce qu'il est le seul dont le bénéfice n'est pas
établi ici.

## Sources

- Guo, Pleiss, Sun, Weinberger (2017), *On Calibration of Modern Neural
  Networks*, ICML — la méthode de température appliquée ici.
- Li et al. (2023), *MERT: Acoustic Music Understanding Model with Large-Scale
  Self-supervised Training* — état de l'art du tagging ;
  <https://arxiv.org/abs/2306.00107>
- *Music auto-tagging in the long tail: A few-shot approach* (2024) —
  comparaison VGGish/OpenL3/PaSST et effet de leur fusion en peu d'exemples ;
  <https://arxiv.org/html/2409.07730v2>
- Won, Ferraro, Salamon, Serra (2019), *musicnn: pre-trained convolutional
  neural networks for music audio tagging* — comparaison des embeddings avec un
  classifieur linéaire (SVM) ;
  <https://ar5iv.labs.arxiv.org/html/1909.06654>
- Kim, Lee, Nam (2017), *Multi-Level and Multi-Scale Feature Aggregation Using
  Pre-trained Convolutional Neural Networks for Music Auto-tagging* — pourquoi
  l'agrégation temporelle et multi-échelle est le levier principal ;
  <https://arxiv.org/pdf/1703.01793>
- *Audio Embeddings as Teachers for Music Classification* (2023) — les
  embeddings récents surpassent les anciens, et l'écart entre teacher et
  student se referme pour VGGish/OpenL3 ;
  <https://arxiv.org/html/2306.17424v1>
- Documentation Essentia des modèles discogs-effnet — le modèle utilisé ;
  <https://essentia.upf.edu/models/music-style-classification/discogs-effnet/>
- Weng, *Learning with not Enough Data Part 2: Active Learning* — synthèse des
  stratégies de sélection (incertitude, diversité, cold start) ;
  <https://lilianweng.github.io/posts/2022-02-20-active-learning/>
- *Music Classification: Beyond Supervised Learning, Towards Real-world
  Applications* — chapitre semi-supervisé : enseignant/élève, pseudo-étiquettes
  dures et douces, place de l'augmentation forte ;
  <https://music-classification.github.io/tutorial/part4_beyond/semi-supervised-learning.html>
- *Music Genre Classification: A Semi-supervised Approach* (Springer) — peu
  d'exemples étiquetés plus beaucoup de données non étiquetées, avec clusters
  flous et « confusion set » ;
  <https://link.springer.com/chapter/10.1007/978-3-642-38989-4_26>
- *A Hierarchical Approach To Automatic Musical Genre Classification* — la
  structure en arbre, l'expansion facile et la réduction des erreurs coûteuses.
- *Transfer learning for music classification and regression tasks* — le
  « convnet feature » concaténé sur plusieurs couches et plusieurs échelles.
- *Music Auto-tagging with Robust Music Representation Learned via Domain
  Adversarial Training* — robustesse au bruit de domaine (peu pertinent ici,
  mentionné pour mémoire) ; <https://arxiv.org/html/2401.15323v1>