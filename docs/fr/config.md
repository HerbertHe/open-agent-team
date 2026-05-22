# Référence de configuration `team.json` (dictionnaire complet de paramètres)

`team.json` est l'entrée de la configuration déclarative de votre équipe d'agents. Vous pouvez utiliser `oat init` pour générer rapidement un modèle dans le répertoire courant. Orchestrator lit et analyse ce fichier, démarre `Admin / Leader` et pré-crée un pool de `Worker` au démarrage.
Vous pouvez valider ce fichier avec le `schema/v1.json` à la racine du projet.

En parallèle, le loader effectue deux types de complétion/parsing à l'exécution :

- les champs `prompt` acceptent soit le texte du prompt directement, soit un chemin de fichier se terminant par `*.md` (le loader lit le fichier et remplace par son contenu)
- les champs `model` acceptent des alias ; les alias sont résolus via la map `models` (le loader remplace par le vrai id)

Voici le dictionnaire des champs (type / requis / défaut / usage).

## 1. Configuration au niveau supérieur

| Champ | Requis | Type | Valeur par défaut | Description |
| --- | --- | --- | --- | --- |
| `model` | Non | string | - | Modèle global par défaut (fallback pour admin/leader/worker) |
| `providers` | Non | object | Voir ci-dessous | Configuration globale d'intégration provider (entrée recommandée) |
| `project` | Oui | object | - | Méta du projet : utilisé pour logs/prompts, branche git, et chemin du dépôt |
| `models` | Oui | record<string, string> | - | Mapping d'alias de modèles (utilisé par admin/leader/worker) |
| `admin` | Oui | object | - | Définition de l'agent Admin : prompt, modèle et skills |
| `teams` | Oui | array | - | Chaque équipe contient un Leader et une définition Worker |
| `runtime` | Non | object | Voir les tableaux ci-dessous | Mode d'exécution et répertoire d'état |
| `workspace` | Non | object | Voir les tableaux ci-dessous | Stratégie workspace, root dir, comportement git lfs/sparse-checkout |

## 2. `project`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `project.name` | Oui | string | - | Nom du projet (utilisé pour prompts/logs) |
| `project.repo` | Oui | string | - | Chemin du dépôt git (utilisé par la gestion workspace et le chargement des skills ; les chemins relatifs sont résolus depuis le répertoire de `team.json`) |
| `project.base_branch` | Non | `main` \| `master` | `"main"` | Branche cible après le leader ; seules `main` et `master` sont autorisées (validées par le schéma) |

## 3. `models` (mappage d'alias de modèles)

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `models` | Oui | record<string, string> | - | Clé = alias (ex : `default`), valeur = vrai id de modèle (ex : `anthropic/...`) |

Comportement du loader :

- Chaîne d'héritage des modèles : `worker.model -> leader.model -> admin.model -> model` (priorité à gauche, fallback à droite)
- Si la valeur finale sélectionnée existe comme clé dans `models`, elle est remplacée par la valeur mappée
- Sinon, cette valeur finale est conservée telle quelle

## 4. `admin`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `admin.name` | Oui | string | - | Nom de l'agent Admin (écrit dans le meta markdown de l'agent dans le workspace) |
| `admin.description` | Oui | string | - | Texte de responsabilité Admin (à remplir dans `team.json`) |
| `admin.model` | Non | string | hérite du `model` de niveau supérieur | Modèle utilisé par Admin (peut être un alias) |
| `admin.prompt` | Oui | string | - | Prompt Admin (accepte un chemin de fichier `*.md`) |
| `admin.skills` | Non | SkillEntry[] | `[]` | Skills à installer dans le workspace Admin (chaque entry a `source` et optionnel `names`, installés via `npx skills add`) |
| `admin.push_channel` | Non | object | - | Cible de routage du canal de push (contient les chaînes `channel` et `account`, ex : `{"channel": "openclaw-slack", "account": "team-slack"}`) |

## 5. `runtime`

> `runtime` est optionnel ; s'il n'est pas fourni, le loader utilise les valeurs par défaut ci-dessous.

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `runtime.mode` | Non | enum (`local_process`) | `local_process` | Mode runtime (implémente actuellement seulement `local_process`) |
| `runtime.persistence.state_dir` | Non | string | `"<répertoire de team.json>/.oat/state"` | Répertoire d'état Orchestrator (utilisé par `status/stop` via `orchestrator.json`) |

Expansion de `~` :

- Si `runtime.persistence.state_dir` est omis, la valeur par défaut est `.oat/state` dans le même répertoire que `team.json`
- `runtime.persistence.state_dir` supporte le préfixe `~` ; le loader l'étend vers le home utilisateur réel
- Si `runtime.persistence.state_dir` est un chemin relatif, il est résolu par rapport au répertoire de `team.json`

## 5.1 `providers` (intégration provider globale)

> Chaque **clé** sous `providers` est un nom de fournisseur. Elle doit correspondre au préfixe des entrées `models` résolues au format `<cléFournisseur>/<nomModèle>` (par ex. si `models.default` vaut `openai/gpt-4o-mini`, un bloc `providers.openai` est requis).

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `providers.<name>.compatible_type` | Oui | `openai` \| `anthropic` | - | `openai` mappe vers `OPENAI_BASE_URL` / `OPENAI_API_KEY` ; `anthropic` vers `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` |
| `providers.<name>.base_url` | Non | string | - | URL de base de l’API |
| `providers.<name>.api_key` | Non | string | - | Clé API (texte brut ; éviter de committer des secrets) |

Notes :

1. Au démarrage, l’orchestrateur parcourt chaque entrée `providers` et définit les variables d’environnement du processus à partir de `base_url` / `api_key`. Les processus enfants les héritent via `fork`.
2. Si plusieurs entrées partagent le même `compatible_type`, l’ordre des clés d’objet peut faire écraser les valeurs `OPENAI_*` / `ANTHROPIC_*` précédentes. En pratique, un fournisseur par protocole suffit.
3. Les valeurs de `models` peuvent utiliser `<cléProvider>/<nomModèle>` avec n’importe quelle clé déclarée dans `providers` (ex. `cli_proxy_api/deepseek-v4-pro`). À l’exécution, le loader réécrit automatiquement le préfixe selon `compatible_type` en `openai/<nomModèle>` ou `anthropic/<nomModèle>` avant de créer les sessions pi.

## 6. `workspace`

> `workspace` est optionnel ; s'il n'est pas fourni, le loader utilise les valeurs par défaut ci-dessous.

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `workspace.provider` | Non | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | Stratégie workspace (seul `worktree` est implémenté aujourd'hui) |
| `workspace.root_dir` | Non | string | `"<répertoire de team.json>/workspaces"` | Répertoire racine où les workspaces sont créés |
| `workspace.git.remote` | Non | string | `"origin"` | Placeholder : le code actuel ne réutilise pas directement remote pour créer les worktrees |
| `workspace.git.lfs` | Non | enum (`pull` \| `skip` \| `allow_pull_deny_change`) | `pull` | Pour le provider `worktree`, lance `git lfs pull` uniquement quand `pull` est choisi |
| `workspace.sparse_checkout.enabled` | Non | boolean | `true` | Activer sparse-checkout (nécessite `teams[].leader.repos` pour fixer les chemins) |

Expansion de `~` :

- Si `workspace.root_dir` est omis, la valeur par défaut est `workspaces` dans le même répertoire que `team.json`
- `workspace.root_dir` supporte le préfixe `~` ; le loader l'étend vers le home utilisateur réel
- Si `workspace.root_dir` est un chemin relatif, il est résolu par rapport au répertoire de `team.json`

## 7. `teams[]`

Chaque équipe contient :

- `team.name` : identifiant d'équipe
- `team.branch_prefix` : préfixe pour construire les branches leader/worker
- `team.leader` : définition du Leader (démarré statiquement)
- `team.worker` : définition du Worker (pré-créé au démarrage)

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
| `leader.model` | Non | string | hérite de `admin.model` (ou du `model` global) | Modèle utilisé par le leader (peut être un alias) |
| `leader.prompt` | Oui | string | - | Prompt du leader (accepte un chemin `*.md`) |
| `leader.skills` | Non | SkillEntry[] | `[]` | Skills partagées avec les workers (héritées et installées lors du spawn) |
| `leader.repos` | Non | string[] | `[]` | allowlist de chemins sparse-checkout (contrôle ce que le worker peut voir/modifier) |

### 7.3 `teams[].worker`

| Champ | Requis | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- | --- |
| `worker.total` | Oui | number(int, >0) | - | Taille du pool de workers. Workers pré-créés au démarrage de l'équipe et arrêt uniquement à la sortie de l'orchestrateur (`stopAll`) |
| `worker.model` | Non | string | hérite de `leader.model` | Modèle utilisé par les workers (peut être un alias) |
| `worker.prompt` | Oui | string | - | Prompt du worker (accepte un chemin `*.md`) |
| `worker.extra_skills` | Non | SkillEntry[] | `[]` | Skills additionnelles ajoutées au moment du spawn, au-dessus de `leader.skills` |
| `worker.skill_sync` | Non | enum | `inherit_and_inject_on_spawn` | Stratégie de synchronisation des skills lors du spawn (comportement actuel : “hériter et injecter”; `manual` n'est pas complètement implémenté) |
