# Architecture de l'équipe d'agents (Orchestrateur + OpenCode)

## 1. Vue d'ensemble : comment l'équipe déclarative est concrétisée

Ce projet fournit un flux de travail « équipe d'agents déclarative » : vous déclarez les rôles `Admin / Leader / Worker`, les modèles, les skills, ainsi que les stratégies de branche/du workspace pour chaque équipe dans `team.yaml`. À l'exécution, l'Orchestrateur lit la configuration et réalise :

- Démarrer `Admin` statique et le `Leader` de chaque équipe (ils restent en cours d'exécution jusqu'à ce qu'un leader termine et déclenche le nettoyage)
- Quand un `Leader` a besoin de « plus d'exécutants de type ingénieur », il demande à l'Orchestrateur de créer dynamiquement des agents `Worker` via des outils
- `Worker` travaille dans son propre workspace git isolé (worktree), fait les changements concrets et produit `CHANGELOG.md`
- L'Orchestrateur fusionne la branche du `Worker` dans la branche correspondante du `Leader`, puis demande à `Leader` de résumer les `CHANGELOG.md` des workers
- Après l'agrégation finale du `Leader`, l'Orchestrateur fusionne la branche du leader vers `project.base_branch` et demande à `Admin` le résumé final de livraison et le rapport

Les relations peuvent se comprendre ainsi :

- `Admin` : le chef de projet (agrégation finale & livraison)
- `Leader` : responsable d'équipe (décompose les tâches, planifie les workers, agrège les résultats)
- `Worker` : l'ingénieur (exécute les tâches, soumet les changements, écrit le CHANGELOG)

## 2. Découpage des composants (responsabilités des modules)

### Orchestrateur (point d'entrée)

L'Orchestrateur se trouve dans `src/orchestrator/orchestrator.ts` et est principalement responsable de :

- Calculer `workspacePath`, ports, modèles et skills de chaque agent à partir de `ResolvedConfig`
- Injecter et démarrer `Admin` et tous les `Leader`
- Enregistrer les routes HTTP d'outils Orchestrateur (pour que les outils OpenCode puissent faire des callbacks)
- Écrire dans chaque workspace les informations attendues par OpenCode : « agent markdown / outils / plugins / meta » (via `workspace-inject`)

Au démarrage, l'Orchestrateur fait surtout :

1. Générer et démarrer `Admin` et les `Leader` (agents statiques)
2. Démarrer un serveur HTTP et attendre les callbacks d'outils (création, fusion et rapports des workers sont gérés via ces endpoints)

### TaskManager (planification dynamique et retour de fusion)

La partie dynamique est gérée par `src/orchestrator/task-manager.ts`. Ses responsabilités clés :

- Accepter les requêtes `Leader` : `POST /tool/request_workers`
- Créer dynamiquement localement un `Worker` pour chaque tâche (worktree workspace + injection de skills + démarrage runtime)
- Accepter les notifications de complétion : `POST /tool/notify_complete`
- Exécuter les fusions git :
  - Branche `Worker` -> Branche `Leader`
  - Branche `Leader` -> `project.base_branch`
- Demander à `Leader`/`Admin` de résumer à partir des CHANGELOG
- Nettoyer (arrêter le runtime + supprimer le workspace)

### RuntimeProvider (démarrage des processus OpenCode)

L'implémentation par défaut est `local_process`, dans `src/sandbox/local-process.ts` :

- Démarrer un processus `opencode serve --port <agentPort>` distinct pour chaque agent
- Lancer le processus avec le `workspacePath` correspondant comme répertoire de travail
- `stop` envoie `SIGTERM` au processus concerné

> Point d'extension : `RuntimeModeEnum.flue` existe comme valeur d'enum, mais l'implémentation actuelle se concentre sur `local_process`.

### WorkspaceProvider (isolement du workspace et gestion git worktree)

La stratégie de workspace est fournie par `src/workspace/workspace-provider.ts` (factory). Par défaut : `WorktreeWorkspaceProvider` :

- Créer un worktree git par agent/branche : dossier comme `<workspace.root_dir>/<spec.id>`
- Utiliser `sparse-checkout` pour réduire l'empreinte des gros dépôts (chemins autorisés via `team.leader.repos`)
- Optionnellement exécuter `git lfs pull`
- Nettoyer via `git worktree remove --force` et supprimer le dossier

> Point d'extension : `workspace.provider` n'instancie actuellement que `worktree`. Les stratégies (`shared_clone/full_clone`) restent en placeholder dans la factory.

### SkillResolver (synchronisation des skills vers le workspace)

Implémenté dans `src/skills/skill-resolver.ts` :

- Lire `skills/<skill-name>/SKILL.md` à la racine du dépôt (en utilisant `config.project.repo` comme root)
- Copier chaque `SKILL.md` sélectionné dans `<workspacePath>/.opencode/skills/<skill-name>/SKILL.md`

### Pipeline Git + documentation : MergeManager / ChangelogManager

- `src/git/merge-manager.ts` : exécute `merge --no-ff`, en charge des fusions `worker->leader` et `leader->main`
- `src/changelog/changelog-manager.ts` : lit `CHANGELOG.md` à la racine du workspace

## 3. Flux d'exécution (du démarrage à la livraison)

Ci-dessous le « flux principal » :

```mermaid
flowchart TD
  U[Utilisateur] --> CLI[oat start team.yaml "<goal>" --port PORT]
  CLI --> O[Orchestrator.start()]
  O --> A[Démarrer l'agent Admin]
  O --> L[Démarrer l'agent Leader]
  L -->|outil request-workers(tasks[])| O
  O --> W[Créer les Workers dynamiquement]
  W -->|outil notify-complete(changelog)| O
  O -->|fusion worker->leader + demander au leader de résumer| L
  L -->|outil notify-complete(changelog)| O
  O -->|fusion leader->main + demander à admin de résumer| A
  O --> C[Nettoyer workspace & processus des leaders/workers]
```

### 3.1 Phase de démarrage : injection de Admin + Leader

L'Orchestrateur configure chaque agent statique :

- Calculer les ports :
  - `Admin` utilise `config.runtime.ports.base`
  - `Leader` utilise `base + 1 + index`
- Créer le workspace (worktree provider)
- Injecter skills, outils, plugins, agent markdown et le meta `.oat/*`

L'injection clé est implémentée dans `src/opencode/workspace-inject.ts` :

- `writeAgentMarkdown()` : écrit `<workspacePath>/.opencode/agents/<agentName>.md`
- `writeCustomTools()` : écrit `<workspacePath>/.opencode/tools/*.ts` (incluant request-workers, notify-complete, etc.)
- `writeCustomPlugins()` : écrit `.opencode/plugins/commit-guard.ts` et `scope-guard.ts`
- `writeOatOrchestratorMeta()` : écrit `.oat/orchestrator.json` (pour que les outils récupèrent le baseUrl)
- `writeOatAgentMeta()` : écrit `.oat/agent.json` (inclut le rôle et la liste allowlist de push pour les workers)

### 3.2 Création dynamique des Workers : le Leader demande des tasks

`Leader` appelle l'outil `request-workers` avec une charge de type :

```json
{ "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }
```

L'Orchestrateur gère `POST /tool/request_workers` dans `TaskManager.requestWorkers()` :

- Utilise `tasks.length` comme nombre de workers
- Pour chaque task :
  - `workerId = <team.name>-worker-<index>`
  - `branch = <team.branch_prefix>/worker-<index>`
  - `port = allocatePort()` (basé sur le prochain port disponible côté runtime)
  - `workspacePath = <workspace.root_dir>/<workerId>`
- Créer le workspace du worker : `workspaceProvider.ensureWorkspace(spec, team.leader.repos)`
- Injecter les skills :
  - skills du worker = `leader.skills` + `team.worker.extra_skills`
- Injecter le meta oat, agent markdown, et outils/plugins
- Démarrer le runtime `opencode serve` et créer une session OpenCode
- Envoyer le prompt au worker :
  - le prompt concret depuis `tasks[i].prompt`
  - le worker doit mettre à jour `CHANGELOG.md` à la racine du workspace
  - au moment de terminer, le worker doit appeler `notify-complete` en définissant l'argument `changelog` avec le contenu du CHANGELOG préparé

### 3.3 Fusion et rapport : worker->leader->admin

Quand `Worker` appelle `POST /tool/notify_complete` :

1. `TaskManager.handleWorkerComplete()` :
   - lit/utilise le `changelog` fourni (si absent, lit `CHANGELOG.md` dans le workspace du worker)
   - exécute la fusion git : `worker.spec.branch -> leader.spec.branch`
   - utilise la session du leader pour lui demander d'agréger le CHANGELOG du worker dans son propre CHANGELOG

2. Quand le `Leader` appelle finalement `notify-complete` :
   - `TaskManager.handleLeaderComplete()` exécute la fusion git : `leader.spec.branch -> project.base_branch`
   - lit le `CHANGELOG.md` du leader (ou utilise le changelog passé via notify-complete)
   - demande à `Admin` via sa session de produire le résumé final en incluant le CHANGELOG de l'équipe
   - nettoie le leader et les workers (stop + remove)

## 4. Isolement des workspaces et stratégie git

### 4.1 Organisation worktree

Le provider par défaut est `worktree`. Les workspaces sont créés sous :

- `<workspace.root_dir>/<agentId>` (par exemple: `~/.oat/workspaces/frontend-worker-0`)

Chaque workspace d'agent provient du même dépôt git :

- `config.project.repo` définit la racine du dépôt git
- Si le workspace n'existe pas :
  - pour une branche existante : `git worktree add <path> <branch>`
  - pour une branche inexistante : `git worktree add <path> -b <branch>` (créée depuis le HEAD courant)

### 4.2 sparse-checkout et allowlist `teams[].leader.repos`

Quand `workspace.sparse_checkout.enabled=true` et que le leader fournit `leader.repos` :

- le workspace worker exécute :
  - `sparse-checkout init --cone`
  - `sparse-checkout set <leader.repos...>`

Cela signifie :

- `leader.repos` agit comme une « allowlist de chemins » pour ce que le worker peut voir/modifier

### 4.3 Stratégie LFS

Si `workspace.git.lfs=pull` :

- après création du workspace, exécuter `git lfs pull`

En cas d'échec : un warning est enregistré, puis Orchestrator continue.

### 4.4 Sécurité de soumission : commit-guard et push autorisé

Les restrictions de push du worker sont imposées par le plugin injecté :

- `writeCustomPlugins()` écrit `commit-guard.ts` dans le workspace worker
- push autorisé (pattern par défaut) :
  - `.*\/worker-\d+`
- pour Admin/Leader : push est autorisé par défaut

En plus, commit-guard bloque `git add -A` / `git add --all` (encourage le staging via allowlist).

> Note : les merges finaux de l'Orchestrateur reposent sur un `git merge` local (via `MergeManager`), pas sur le fait d'obliger les workers à pousser sur un remote.

## 5. API d'outils Orchestrateur (pour les appels OpenCode)

Après démarrage, Orchestrator écoute `--port <PORT>` et enregistre les routes d'outils :

- `POST /tool/request_workers`
  - Utilisation : le leader demande la création de workers et dispatch des tâches
  - Entrée : `{ "leaderId": "<leaderId>", "tasks": [{ "index": 0, "prompt": "..." }] }`
  - Sortie : `{ "workerIds": ["<team>-worker-0", ...] }`
- `POST /tool/notify_complete`
  - Utilisation : worker/leader notifie la complétion ; Orchestrator déclenche merge et synthèse
  - Entrée : `{ "agentRole": "worker|leader|admin", "agentId": "<id>", "changelog"?: "<string>" }`
- `POST /tool/report_progress`
  - Utilisation : placeholder, renvoie ok
- `POST /tool/generate_changelog`
  - Utilisation : lit `CHANGELOG.md` dans le workspace correspondant à `agentId`

## 6. Points de pilotage de configuration et valeurs clés

Le comportement est principalement lié à ces champs de `team.yaml` :

- Rôles et prompts :
  - `admin.prompt`, `teams[].leader.prompt`, `teams[].worker.prompt`
  - prompt peut être un chemin `*.md` (le loader lit et substitue)
- Modèles :
  - le champ top-level `model` fournit un modèle global par défaut
  - chaîne d'héritage : `worker.model -> leader.model -> admin.model -> model`
  - `models` sert à mapper l'alias de la valeur de modèle finalement sélectionnée (ex : `default -> anthropic/...`)
  - si un model ne contient pas `/`, le provider par défaut est `anthropic`
- Workspaces :
  - `workspace.root_dir` détermine où sont créés les worktrees
  - `teams[].leader.repos` détermine les chemins du sparse-checkout
- Branches cibles :
  - `project.base_branch` détermine la branche de fusion `leader->main`

## 7. Limites actuelles de l'implémentation et points d'extension

Pour éviter des promesses qui dépassent l'implémentation, voici les limites actuelles :

- `runtime.mode` : seule `local_process` est pleinement implémentée ; `flue` n'est pas déployé
- `workspace.provider` : seule `worktree` est implémentée ; autres stratégies non implémentées
- `team.worker.max` : le nombre de workers dépend de `tasks.length` envoyé par `Leader` ; `worker.max` n'est pas appliqué comme une limite stricte
- `team.worker.lifecycle` / `team.worker.skill_sync` : valeurs par défaut existent, mais la logique de création/nettoyage des workers ne se branche pas encore correctement sur ces champs

Si vous voulez que ces intentions de config soient réellement appliquées côté code, je peux aider à étendre `TaskManager` pour gérer les limites, le lifecycle, et la logique `skill_sync`.
