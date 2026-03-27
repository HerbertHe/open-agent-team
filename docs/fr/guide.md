# Guide de démarrage rapide

Ce guide vous aide à lancer localement la structure déclarative `Admin -> Leader -> Worker` avec le minimum d'étapes.

## 1. Préparer les skills (obligatoire)

Orchestrator lit les définitions de skills depuis le chemin `project.repo` de `team.yaml`, puis les injecte dans les workspaces de chaque agent.

Dans la racine de votre dépôt git, préparez :

- `skills/<skill-name>/SKILL.md`

Exemple :

```text
skills/
  doc-search/
    SKILL.md
  coding-assistant/
    SKILL.md
```

> Astuce : si vous n'avez pas encore de skills, vous pouvez créer un `SKILL.md` vide ou minimal pour tester de bout en bout l'injection et l'appel des outils.

## 2. Préparer votre dépôt Git et les branches (recommandé)

Ce projet fusionne vers `project.base_branch` (par défaut `main`) et crée un worktree git pour chaque agent.

Avant de démarrer, vérifiez :

- `team.yaml -> project.repo` pointe vers un dépôt git (souvent `.`)
- `project.base_branch` existe (par exemple `main`)
- votre dépôt supporte `git worktree`

## 3. Écrire `team.yaml` (cœur du système)

`team.yaml` peut être placé n'importe où, mais il est recommandé de le garder dans la racine du dépôt ou dans un endroit facile à gérer.

Voici un exemple “squelette minimal” (remplacez modèles et prompts par les vôtres, et renseignez de vrais noms de skills) :

```yaml
model: default

project:
  name: open-agent-team-demo
  repo: .
  base_branch: main

models:
  default: anthropic/claude-3-5-sonnet-20240620

admin:
  name: admin
  description: Chef de projet responsable de l'agrégation finale et de la livraison
  model: default
  prompt: |
    You are the project manager (Admin).
    Your job is to summarize the final delivery and review team changelogs.
  skills: []

teams:
  - name: frontend
    branch_prefix: team/frontend
    leader:
      name: frontend-lead
      description: Responsable frontend; décompose les tâches et demande aux workers de les exécuter
      model: default
      prompt: |
        You are the Leader agent for the frontend team.
        When you need engineers to implement tasks in parallel, call tool request-workers with a JSON body:
        { "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }

        After workers finish, summarize all worker CHANGELOGs into your own CHANGELOG.
      skills: []
      repos:
        - src/
        - package.json
    worker:
      max: 3
      model: default
      prompt: |
        You are a Worker engineer.
        For your assigned task:
        1) Modify code in this workspace.
        2) Update CHANGELOG.md at the workspace root with what you did and why.
        3) Call tool notify-complete with changelog set to the CHANGELOG content.
      extra_skills: []
```

Au minimum, vérifiez :

- `admin.prompt`, `leader.prompt`, `worker.prompt` ne sont pas vides (ou utilisez des chemins `*.md`)
- l'héritage des modèles est clair : `worker.model -> leader.model -> admin.model -> model` (vous pouvez ne définir que le `model` global puis surcharger au besoin)
- `teams[]` contient au moins une équipe
- `leader.repos` liste les chemins sur lesquels vous voulez que les workers se concentrent (mappé vers sparse-checkout allowlist)

## 4. Démarrer l'Orchestrateur

Lancez :

```bash
oat start team.yaml "<goal>" --port 3100
```

- `--port` : port HTTP de l'Orchestrateur (utilisé pour les callbacks d'outils)
- `<goal>` : objectif final injecté dans le prompt du Leader

Pour définir la langue de sortie/log :

```bash
oat start team.yaml "<goal>" --port 3100 --lang zh-CN
```

## 5. Observer le résultat

Points de contrôle courants :

- Orchestrator démarre et écoute sur le port indiqué
- Les workspaces worker apparaissent sous `workspace.root_dir` (par défaut `~/.oat/workspaces/<agentId>`)
- Chaque worker met à jour le `CHANGELOG.md` à la racine lorsqu'il termine
- Les branches des workers sont fusionnées dans les branches correspondantes des leaders
- Après fusion du leader vers `project.base_branch`, Orchestrator nettoie le leader et ses workers (processus + workspace)

## 6. Statut / arrêt

Vérifier l'état de l'Orchestrateur (lire `orchestrator.json` dans `state_dir`) :

```bash
oat status "~/.oat/state"
```

Arrêt (envoyer SIGTERM au pid de l'Orchestrateur) :

```bash
oat stop "~/.oat/state"
```

## 7. Afficher la documentation (multi-langue)

Vous pouvez afficher le contenu via CLI, par exemple :

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```
