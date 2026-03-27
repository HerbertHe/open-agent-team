# Référence de configuration `team.yaml` (dictionnaire complet de paramètres)

`team.yaml` est l'entrée de la configuration déclarative de votre équipe d'agents. Orchestrator lit et analyse ce fichier, démarre `Admin / Leader` statiques, puis crée dynamiquement des agents `Worker` lorsqu'ils sont demandés par `Leader`.

En parallèle, le loader effectue deux types de complétion/parsing à l'exécution :

- les champs `prompt` acceptent soit le texte du prompt directement, soit un chemin de fichier se terminant par `*.md` (le loader lit le fichier et remplace par son contenu)
- les champs `model` acceptent des alias ; les alias sont résolus via la map `models` (le loader remplace par le vrai id)

Voici le dictionnaire des champs (type / requis / défaut / usage).

## 1. Configuration au niveau supérieur

| Champ | Requis | Type | Valeur par défaut | Description |
| --- | --- | --- | --- | --- |
| `project` | Oui | object | - | Méta du projet : utilisé pour logs/prompts, branche git, et chemin du dépôt |
| `models` | Oui | record<string, string> | - | Mapping d'alias de modèles (utilisé par admin/leader/worker) |
| `admin` | Oui | object | - | Définition de l'agent Admin : prompt, modèle et skills |
| `teams` | Oui | array | - | Chaque équipe contient un Leader et une définition Worker |
| `runtime` | Non | object | Voir les tableaux ci-dessous | Mode d'exécution, ports de base, répertoire d'état |
| `workspace` | Non | object | Voir les tableaux ci-dessous | Stratégie workspace, root dir, comportement git lfs/sparse-checkout |

## 2. `project`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `project.name` | Oui | string | - | Nom du projet (utilisé pour prompts/logs) |
| `project.repo` | Oui | string | - | Chemin du dépôt git (utilisé par la gestion workspace et le chargement des skills) |
| `project.base_branch` | Non | string | `"main"` | Branche cible pour la fusion `leader -> main` |

## 3. `models` (mappage d'alias de modèles)

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `models` | Oui | record<string, string> | - | Clé = alias (ex : `default`), valeur = vrai id de modèle (ex : `anthropic/...`) |

Comportement du loader :

- si `admin.model / leader.model / worker.model` correspond à une clé de `models`, il est remplacé par la valeur mappée
- sinon, la valeur reste telle quelle

## 4. `admin`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `admin.name` | Oui | string | - | Nom de l'agent Admin (écrit dans le meta markdown de l'agent dans le workspace) |
| `admin.description` | Oui | string | - | Texte de responsabilité Admin (à remplir dans `team.yaml`) |
| `admin.model` | Oui | string | - | Modèle utilisé par Admin (peut être un alias) |
| `admin.prompt` | Oui | string | - | Prompt Admin (accepte un chemin de fichier `*.md`) |
| `admin.skills` | Non | string[] | `[]` | Skills à injecter dans le workspace Admin |

## 5. `runtime`

> `runtime` est optionnel ; s'il n'est pas fourni, le loader utilise les valeurs par défaut ci-dessous.

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `runtime.mode` | Non | enum (`local_process` \| `flue`) | `local_process` | Mode runtime (implémente actuellement seulement `local_process`) |
| `runtime.opencode.executable` | Non | string | `"opencode"` | Nom/chemin de l'exécutable `opencode` |
| `runtime.ports.base` | Non | number | `4096` | Port de base pour serveurs d'agents (Admin utilise `base`, Leader utilise `base + 1 + index`) |
| `runtime.ports.max_agents` | Non | number | `10` | Non appliqué strictement dans le code actuel (placeholder/préférence) |
| `runtime.persistence.state_dir` | Non | string | `"~/.oat/state"` | Répertoire d'état Orchestrator (utilisé par `status/stop` via `orchestrator.json`) |

Expansion de `~` :

- `runtime.persistence.state_dir` supporte le préfixe `~` ; le loader l'étend vers le home utilisateur réel

## 6. `workspace`

> `workspace` est optionnel ; s'il n'est pas fourni, le loader utilise les valeurs par défaut ci-dessous.

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `workspace.provider` | Non | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | Stratégie workspace (seul `worktree` est implémenté aujourd'hui) |
| `workspace.root_dir` | Non | string | `"~/.oat/workspaces"` | Répertoire racine où les workspaces sont créés |
| `workspace.persistent` | Non | boolean | `true` | Non implémenté comme comportement différencié (placeholder) |
| `workspace.git.remote` | Non | string | `"origin"` | Placeholder : le code actuel ne réutilise pas directement remote pour créer les worktrees |
| `workspace.git.lfs` | Non | enum (`pull` \| `skip` \| `allow_pull_deny_change`) | `pull` | Pour le provider `worktree`, lance `git lfs pull` uniquement quand `pull` est choisi |
| `workspace.sparse_checkout.enabled` | Non | boolean | `true` | Activer sparse-checkout (nécessite `teams[].leader.repos` pour fixer les chemins) |

Expansion de `~` :

- `workspace.root_dir` supporte le préfixe `~` ; le loader l'étend vers le home utilisateur réel

## 7. `teams[]`

Chaque équipe contient :

- `team.name` : identifiant d'équipe
- `team.branch_prefix` : préfixe pour construire les branches leader/worker
- `team.leader` : définition du Leader (démarré statiquement)
- `team.worker` : définition du Worker (créé dynamiquement pendant l'exécution du Leader)

### 7.1 Champs de base `team`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `teams[].name` | Oui | string | - | Nom d'équipe (utilisé pour les identifiants workspace/scope et le nommage des agents) |
| `teams[].branch_prefix` | Oui | string | - | Base du nommage de branches pour worker/leader |

### 7.2 `teams[].leader`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `leader.name` | Oui | string | - | Nom du leader dans l'équipe (utilisé pour le contexte du prompt) |
| `leader.description` | Oui | string | - | Texte de responsabilité du leader |
| `leader.model` | Oui | string | - | Modèle utilisé par le leader (peut être un alias) |
| `leader.prompt` | Oui | string | - | Prompt du leader (accepte un chemin `*.md`) |
| `leader.skills` | Non | string[] | `[]` | Skills partagées avec les workers (héritées et injectées lors du spawn) |
| `leader.repos` | Non | string[] | `[]` | allowlist de chemins sparse-checkout (contrôle ce que le worker peut voir/modifier) |

### 7.3 `teams[].worker`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `worker.max` | Oui | number(int, >0) | - | Nombre maximal de workers attendu. Dans le code actuel, le nombre est surtout piloté par `tasks.length` |
| `worker.model` | Oui | string | - | Modèle utilisé par les workers (peut être un alias) |
| `worker.prompt` | Oui | string | - | Prompt du worker (accepte un chemin `*.md`) |
| `worker.extra_skills` | Non | string[] | `[]` | Skills additionnelles ajoutées au moment du spawn, au-dessus de `leader.skills` |
| `worker.lifecycle` | Non | enum | `ephemeral_after_merge_to_main` | Stratégie de cleanup attendue après merge dans main (actuellement le cleanup s'exécute toujours quand le leader finit) |
| `worker.skill_sync` | Non | enum | `inherit_and_inject_on_spawn` | Stratégie de synchronisation des skills lors du spawn (comportement actuel : “hériter et injecter”; `manual` n'est pas complètement implémenté) |
