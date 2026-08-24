# Collaboration Git et livraison

OAT utilise Git comme frontière unique de collaboration du code. L'Admin tient le plan de contrôle, le Leader est responsable de la revue et de l'intégration, et le Worker ne livre que des branches éphémères vérifiables.

## Flux de travail

1. L'Admin attribue un WorkItem à un Leader.
2. Le Leader ne confie aux Workers que des tâches d'implémentation réellement indépendantes. Une tâche en conflit est mise en file ou redécoupée.
3. Pour chaque tâche, le Worker crée `oat/<team>/<taskId>/attempt-<n>` depuis le SHA de `main`/`master` figé à la création de la tâche.
4. Le Worker implémente, s'auto-teste, commit, puis appelle `submit-review`. La demande stocke le commit, les fichiers modifiés, les tests et les chemins des livrables ; elle ne fusionne rien.
5. Le Leader consulte `list-review-requests`, vérifie les preuves et utilise `review-worker-branch` pour approuver l'intégration dans `oat/<team>/<workItem>/integration`, ou demande une correction.
6. Après les tests d'intégration, le Leader appelle `submit-release-proposal`.
7. L'Admin accepte ou refuse avec `approve-release`. En cas d'accord, le MergeController verrouille globalement l'opération et met à jour `main`/`master` atomiquement avec Git `update-ref`.
8. La publication distante est facultative. Après configuration de `workspace.git.push_enabled`, de l'identité et du dépôt distant, Admin appelle explicitement `push-release`, sans force et uniquement pour la version fusionnée courante.

Si la branche de production a changé, la publication échoue sans écraser le nouveau commit.

Les URL de push sont désactivées dans tous les worktrees Agent et les processus Agent n'héritent pas des variables d'identification Git/SSH. La seule écriture distante prise en charge passe par l'outil Admin contrôlé par rôle dans l'Orchestrateur.

## File de tâches et absence de conflits

Chaque agent possède sa propre file FIFO. La création d'une tâche vérifie d'abord les tâches déjà en attente, la clé `conflictKey` et les ressources déclarées. Un Leader ne doit pas envoyer à plusieurs Workers des tâches qui modifient les mêmes fichiers, API, migrations ou tests. Les Workers ne remplacent jamais un Worker occupé ni le Leader : ils attendent leur tour.

## Livrables et fichiers temporaires

Les données d'exécution sont conservées hors des worktrees, dans `<runtime.persistence.state_dir>/git-collaboration/` :

- `tasks/` : branche, SHA de base, preuves de tests et fichiers modifiés ;
- `reviews/` : demandes de revue et décisions du Leader ;
- `releases/` : décisions Admin et commit de fusion ;
- `worktrees/` : worktrees temporaires des Workers, Leaders et du MergeController.

Les worktrees de tâche ne contiennent que le code, les tests et la documentation volontairement versionnée. Les journaux, métadonnées d'agent, brouillons et fichiers de session ne doivent jamais devenir des artefacts Git.

## API

- `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`
- `GET /reviews?leaderId=<id>` et `POST /reviews/<id>`
- `GET /releases` et `POST /releases/<id>/approval`
- `GET /git/status` et `PUT /git/config` (aucune API HTTP générique de push)

Les rapports vers le haut référencent `artifactPath`, la branche, les SHA base/tête, `changedFiles` et `tests`, plutôt qu'un journal de travail complet.
