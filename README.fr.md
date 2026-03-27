# Open Agent Team (Orchestrateur + OpenCode)

Ce projet vous permet de construire une équipe d'agents **déclarative** avec une hiérarchie en 3 couches :

`Admin -> Leader -> Worker`

Vous déclarez les rôles, modèles, skills partagées et les stratégies workspace/git dans `team.json`. À l'exécution, l'Orchestrateur démarre les agents statiques (`Admin` et tous les `Leader`) puis crée dynamiquement des `Worker` lorsque un `Leader` les demande. Chaque `Worker` doit mettre à jour un `CHANGELOG.md`, qui est fusionné vers le haut :

`Worker CHANGELOG` -> `Leader CHANGELOG` -> résumé final de `Admin`.

## Concepts clés

### Configuration déclarative (`team.json`)

- `team.json` définit :
  - le modèle global par défaut (`model`, optionnel)
  - l'intégration provider globale (`providers`, optionnel)
  - les métadonnées du projet (`project`)
  - le mapping d'alias de modèles (`models`)
  - la config de l'agent `Admin` (`admin`)
  - les configs par équipe (`teams[]`: `Leader` + `Worker`)
- Si `admin.prompt` / `leader.prompt` / `worker.prompt` se termine par `.md`, le loader considère qu'il s'agit d'un chemin de fichier et charge le contenu du fichier comme texte de prompt.
- Chaîne d'héritage des modèles : `worker.model -> leader.model -> admin.model -> model` (surcharge possible à chaque niveau).

Référence détaillée : `oat docs config --lang fr`.

### Workspaces isolés (git worktree)

Par défaut, chaque agent s'exécute dans un workspace isolé créé via `git worktree`, sous :

- `workspace.root_dir` (par défaut : `~/.oat/workspaces`)

Pour les dépôts volumineux, vous pouvez activer sparse-checkout ; les chemins de sparse-checkout côté worker viennent de `teams[].leader.repos`.

### Partage et injection des skills

Les skills suivent la convention OpenCode `SKILL.md` :

- Source : `skills/<skill-name>/SKILL.md` à la racine du dépôt (`project.repo`)
- Injecté dans chaque workspace à : `.opencode/skills/<skill-name>/SKILL.md`

### Collaboration basée sur `CHANGELOG.md`

Lorsqu'un `Worker` est créé, l'Orchestrateur injecte une contrainte système dans son prompt :

- créer/metttre à jour `CHANGELOG.md` à la racine du workspace (même s'il n'y a aucun changement de code)
- appeler `notify-complete` et transmettre le contenu préparé de `CHANGELOG.md`

## Démarrage rapide

### 1) Préparer les skills

Dans la racine de votre dépôt git, créez :

`skills/<skill-name>/SKILL.md`

### 2) Écrire `team.json`

Référez-vous à :

- `docs/fr/guide.md` (exemple minimal + étapes)
- `docs/fr/config.md` (référence détaillée des champs)

### 3) Démarrer l'Orchestrateur

```bash
oat start team.json "<goal>" --port 3100
```

Choisir la langue de sortie/docs :

```bash
oat start team.json "<goal>" --port 3100 --lang zh-CN
```

### 4) Commandes utiles

```bash
oat status "~/.oat/state"
oat stop "~/.oat/state"
oat docs architecture --lang fr
oat docs config --lang fr
oat docs guide --lang fr
```

## Fonctionnement de la collaboration (vue d'ensemble)

1. L'Orchestrateur injecte les skills/outils/plugins et démarre `Admin` ainsi que chaque `Leader`.
2. Un `Leader` appelle l'outil `request-workers` avec une liste de `tasks`.
3. L'Orchestrateur démarre un `Worker` par task :
   - crée/assure un workspace git worktree
   - injecte les skills du leader + `worker.extra_skills`
   - lance `opencode serve` et envoie le prompt de la tâche
4. Un `Worker` doit :
   - mettre à jour `CHANGELOG.md` à la racine du workspace
   - appeler `notify-complete` avec le contenu préparé de `CHANGELOG.md`
5. L'Orchestrateur fusionne `Worker -> Leader`, demande au `Leader` de résumer, puis fusionne `Leader -> project.base_branch`.
6. L'Orchestrateur nettoie le leader et ses workers (processus + workspaces).

## Notes actuelles (alignées avec le code)

- Runtime mode : `local_process` est implémenté (démarrage de plusieurs `opencode serve` sur des ports différents).
- Workspaces : le provider `worktree` est implémenté ; les autres providers sont des placeholders.
- Les intentions de `teams[].worker.max` et les champs lifecycle ne sont pas (encore) appliqués comme limites strictes dans la logique de worker dynamique (les workers sont nettoyés après la fin d'un leader).

## LICENSE

MIT &copy; Herbert He
