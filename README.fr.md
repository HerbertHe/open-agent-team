# Open Agent Team

Ce projet vous permet de construire une équipe d'agents **déclarative** avec une hiérarchie en 3 couches :

`Admin -> Leader -> Worker`

Vous déclarez les rôles, modèles, skills partagées et les stratégies workspace/git dans `team.json`. À l'exécution, l'Orchestrateur démarre les agents statiques (`Admin` et tous les `Leader`) puis crée dynamiquement des `Worker` lorsque un `Leader` les demande. Chaque `Worker` doit mettre à jour un `CHANGELOG.md`, qui est fusionné vers le haut :

`Worker CHANGELOG` -> `Leader CHANGELOG` -> résumé final de `Admin`. Tous les rôles (Admin, Leader, Worker) sont strictement tenus d'**AJOUTER (APPEND)** leurs notes à leur fichier `CHANGELOG.md` respectif.

## Concepts clés

### Configuration déclarative (`team.json`)

- `team.json` définit :
  - le modèle global par défaut (`model`, optionnel)
  - l'intégration provider globale (`providers`, optionnel)
  - les métadonnées du projet (`project` ; `project.base_branch` doit être `main` ou `master`, défaut `main`)
  - le mapping d'alias de modèles (`models`)
  - la config de l'agent `Admin` (`admin`)
  - les configs par équipe (`teams[]`: `Leader` + `Worker`)
- Si `admin.prompt` / `leader.prompt` / `worker.prompt` se termine par `.md`, le loader considère qu'il s'agit d'un chemin de fichier et charge le contenu du fichier comme texte de prompt.
- Chaîne d'héritage des modèles : `worker.model -> leader.model -> admin.model -> model` (surcharge possible à chaque niveau).

Référence détaillée : `oat docs config --lang fr`.

### Workspaces isolés (git worktree)

Par défaut, chaque agent s'exécute dans un workspace isolé créé via `git worktree`, sous :

- `workspace.root_dir` (par défaut : `<répertoire de team.json>/workspaces`)

Pour les dépôts volumineux, vous pouvez activer sparse-checkout ; les chemins de sparse-checkout côté worker viennent de `teams[].leader.repos`.

### Gestion des skills (`npx skills`)

Les skills sont gérées via [`npx skills`](https://github.com/vercel-labs/skills) et déclarées dans `team.json` en tant qu'objets `SkillEntry` :

- Chaque entry spécifie un `source` (dépôt GitHub, URL, ou chemin local) et un filtre `names` optionnel
- Au démarrage, OAT exécute `npx skills add` pour chaque entry et installe les skills dans `<workspace>/skills/`
- Un lien symbolique `.pi/skills` est créé pour la compatibilité pi-coding-agent

### Collaboration basée sur `CHANGELOG.md`

Lors de l'initialisation des agents, l'Orchestrateur injecte des contraintes système :

- Tous les rôles (Admin, Leader, Worker) DOIVENT ajouter (append) leurs notes à `CHANGELOG.md` à la racine de leur workspace (même s'il n'y a aucun changement de code, enregistrez le raisonnement).
- Toutes les sorties intermédiaires quotidiennes (notes, brouillons, logs) doivent être enregistrées sous `.oat/workspaces/<agentId>/records/<date>/`.
- Worker et Leader appellent `notify-complete` et transmettent le contenu préparé de `CHANGELOG.md` pour le propager vers le haut.

## Démarrage rapide

### 1) Configurer les skills (optionnel)

Déclarez les sources de skills dans `team.json` au format `SkillEntry` :

```json
"skills": [{ "source": "vercel-labs/agent-skills", "names": ["frontend-design"] }]
```

### 2) Écrire `team.json`

Référez-vous à :

- `docs/fr/guide.md` (exemple minimal + étapes)
- `docs/fr/config.md` (référence détaillée des champs)

### 3) Démarrer l'Orchestrateur

```bash
oat start team.json "<goal>"
```

Le flag `--port` est optionnel — OAT scanne automatiquement un port disponible à partir de 8787.

Choisir la langue de sortie/docs :

```bash
oat start team.json "<goal>" --lang zh-CN
```

Un **tableau de bord web** intégré est disponible à `http://localhost:<port>` après le démarrage, offrant l'observabilité en temps réel, l'édition de configuration projet (avec aperçu JSON Shiki), la gestion des paramètres globaux et la gestion multi-projets. Il propose également une page **Réalisations du projet (Project Achievements)** pour parcourir les enregistrements de travail quotidiens et l'historique `CHANGELOG.md` de chaque agent. Le tableau de bord utilise le chargement différé et la séparation du code (code splitting) pour des performances optimales.

### 4) Commandes utiles

```bash
oat status
oat stop
oat docs architecture --lang fr
oat docs config --lang fr
oat docs guide --lang fr
```

## Fonctionnement de la collaboration (vue d'ensemble)

1. L'Orchestrateur installe les skills via `npx skills add` et démarre `Admin` ainsi que chaque `Leader`.
2. Un `Leader` appelle l'outil `request-workers` avec une liste de `tasks`.
3. L'Orchestrateur envoie les tâches à un pool de `Worker` déjà pré-créé (taille = `teams[].worker.total`) :
   - se connecte au worker ciblé
   - envoie le prompt de la tâche
4. Un `Worker` doit :
   - ajouter (append) ses notes au `CHANGELOG.md` à la racine du workspace
   - appeler `notify-complete` avec le contenu préparé de `CHANGELOG.md`
5. L'Orchestrateur auto-commit toutes les modifications (`git add -A && git commit`), puis fusionne `Worker -> Leader`, demande au `Leader` de résumer, puis fusionne `Leader -> project.base_branch`.
6. Chaque commit git d'un agent est attribué avec une identité locale unique (ex : `worker-0-teamName@project-projectName.oat`).
7. L'Orchestrateur conserve le pool de workers jusqu'au shutdown ; seul `stopAll` à la sortie de l'orchestrateur arrête/détruit les processus.

## Notes actuelles (alignées avec le code)

- Runtime mode : `local_process` est implémenté (démarrage de plusieurs processus agents sur des ports différents).
- Workspaces : le provider `worktree` est implémenté ; les autres providers sont des placeholders.
- La taille du pool de workers (`teams[].worker.total`) est appliquée via un pré-démarrage au lancement de l'équipe ; les workers ne sont pas nettoyés après la fin d'un leader (uniquement à la sortie de l'orchestrateur).

## Remerciements

- [CLIProxyAPI Management Console (CPAMC)](https://github.com/router-for-me/CLIProxyAPI) — Le système de design du Dashboard (thème, mise en page et effets glass) est porté depuis l'UI de CPAMC.

## LICENSE

MIT &copy; Herbert He
