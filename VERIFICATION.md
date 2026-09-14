# Vérification fonctionnelle — Quiz ETSIA

Dernière exécution : 14 septembre 2026, par revue de code + exécution réelle du serveur (Fastify + store JSON) dans un environnement isolé reproduisant `server/` à l'identique, complétée par un test de charge à 300 participants simultanés.

## 1. Règles métier vérifiées (comportement observé, pas seulement lu dans le code)

| Règle | Résultat |
|---|---|
| Inscription (nom + code de sécurité) | ✅ OK |
| Refus de la double inscription (même nom + code) | ✅ 409 |
| Reconnexion avec les mêmes informations | ✅ OK |
| Un seul quiz ouvert à la fois | ✅ 409 sur tentative d'ouverture d'un 2e quiz |
| Quiz fermé (DRAFT/CLOSED) : démarrage refusé | ✅ 409 |
| Chronomètre personnel démarré à l'entrée du participant, pas à l'ouverture du quiz | ✅ vérifié (`startedAt` propre à chaque participant) |
| Re-appel de "commencer" : ne réinitialise pas le chrono | ✅ `startedAt` identique à chaque rappel |
| Participation unique (impossible de refaire un quiz déjà soumis) | ✅ 409 |
| Score = 1 point par bonne réponse | ✅ vérifié |
| Finalisation par l'admin à tout moment | ✅ OK |
| Finalisation bloque les **nouveaux** participants | ✅ 409 sur `/start` après clôture |
| Un participant **déjà engagé** peut terminer et soumettre après la finalisation | ✅ soumission acceptée après clôture |
| Quiz finalisé non réouvrable directement (`/open` refusé sur CLOSED) | ✅ 400 |
| Top 10 + nombre de participants (admin) | ✅ OK |
| Modification d'un quiz finalisé | ✅ OK (PATCH accepté sur CLOSED) |
| Réinitialisation : efface tentatives + résultats, repasse en DRAFT, réouvrable | ✅ vérifié de bout en bout |

## 2. Test de charge réel — 300 participants simultanés

Scénario : 300 inscriptions concurrentes, puis les 300 mêmes participants démarrent le quiz **au même instant**, puis soumettent **au même instant** (pire cas réaliste : tout le monde clique en même temps après l'annonce de l'organisateur).

- Inscriptions : 300/300 réussies en ~0,7 s
- Démarrages : 300/300 réussis en ~0,8 s
- Soumissions : 300/300 réussies en ~0,8 s
- Temps total bout-en-bout : ~2,3 s
- Fichier `store.json` relu après le test : JSON valide, aucun identifiant en double, aucune perte de données

Test complémentaire de concurrence extrême : 50 requêtes **strictement simultanées** avec le même participant (inscription, démarrage, soumission) → une seule opération passe à chaque fois, les 49 autres sont rejetées proprement (409). Aucune double soumission n'a pu se glisser.

## 3. Bug trouvé et corrigé

**Avant correctif :** une entrée admin invalide (ex. titre ou intitulé de question trop court) provoquait une erreur 500 (Internal Server Error) au lieu d'un message clair.

**Correctif appliqué** (`server/src/index.ts`) : ajout d'un `setErrorHandler` qui intercepte les erreurs de validation Zod et renvoie un 400 avec le détail du champ en cause. Revérifié : les erreurs de saisie renvoient maintenant un message exploitable, le comportement normal n'est pas affecté.

## 4. JSON local vs base de données — verdict

**Le point clé de la conception : un seul quiz peut être ouvert à la fois.** Les 300 participants ne se répartissent donc jamais sur 9 quiz en parallèle — ils convergent tous sur *un seul* quiz actif à un instant donné. C'est la charge réelle à anticiper, et c'est exactement celle qui a été testée ci-dessus.

- Avec cette contrainte, **le stockage JSON actuel supporte 300 participants simultanés sur un quiz** : testé, 0 échec, réponses en moins d'une seconde, aucune corruption de fichier.
- Le fichier grossit vite mais reste léger (≈240 Ko après 300 participants + leurs tentatives/soumissions) — pas un problème de volume pour 9 quiz sur une seule journée d'événement.
- **La sécurité vient du fait que le serveur tourne en un seul processus Node.** Comme les vérifications (doublon, participation déjà faite) s'exécutent de façon synchrone avant l'écriture, l'event loop de Node garantit qu'aucune requête ne peut "doubler" une autre. **Ce n'est plus vrai si le serveur est un jour déployé en plusieurs instances/processus (cluster, PM2 en mode cluster, plusieurs conteneurs derrière un load balancer)** : chaque instance aurait sa propre copie en mémoire et les écritures fichier se marcheraient dessus. → **Ne pas faire de scaling horizontal avec ce store JSON.**

**Peut-on se passer d'une base de données pour l'événement ?**
Oui, à ces conditions précises :
1. Un seul processus serveur (pas de cluster), ce qui est de toute façon suffisant pour ce volume.
2. Un hébergement qui garde un disque persistant entre les requêtes (attention aux plateformes serverless/éphémères type certaines offres Vercel/Railway sans volume persistant : le fichier JSON disparaîtrait au redéploiement).
3. Une sauvegarde régulière de `data/store.json` pendant l'événement (copie automatique toutes les X minutes), pour ne pas tout perdre en cas de crash serveur.
4. Le README recommande déjà PostgreSQL pour la production — cette recommandation reste valable **si vous voulez de la robustesse long terme, des sauvegardes automatiques, ou si vous envisagez plusieurs éditions/événements**. Mais pour un événement ponctuel avec ces volumes (9 quiz, 300 participants), le JSON est objectivement suffisant techniquement, à condition de respecter les 3 points ci-dessus.

**Recommandation concrète :** garder le JSON pour cet événement (déploiement plus simple, testé et validé), mais mettre en place un script de sauvegarde du fichier `store.json` toutes les 5 minutes vers un second emplacement (ou un commit git automatique), pour parer à un crash serveur le jour J.

## 5. Checklist de préparation au déploiement

- [ ] Changer `ADMIN_PASSWORD` (ne pas garder `ETSIA-ADMIN-2027`)
- [ ] Définir `CLIENT_ORIGIN` avec l'URL HTTPS réelle du frontend
- [ ] Définir `VITE_API_URL` au moment du build du client avec l'URL HTTPS réelle du backend
- [ ] Déployer en **un seul processus** (pas de mode cluster) pour préserver la cohérence du store JSON
- [ ] Mettre en place une sauvegarde périodique de `server/data/store.json`
- [ ] Vérifier que l'hébergement choisi conserve un disque persistant (pas de perte du fichier JSON au redémarrage/redéploiement)
- [ ] Tester le QR code d'accès public et le mot de passe admin en conditions réelles avant l'événement
- [ ] Correctif de validation (erreurs 500→400) appliqué — voir `server/src/index.ts`
