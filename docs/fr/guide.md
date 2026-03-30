# Guide de démarrage rapide

Ce guide vous aide à lancer localement la structure déclarative `Admin -> Leader -> Worker` avec le minimum d'étapes.

## 1. Préparer les skills (obligatoire)

Orchestrator lit les définitions de skills depuis le chemin `project.repo` de `team.json`, puis les injecte dans les workspaces de chaque agent.
Si `project.repo` est un chemin relatif, il est résolu par rapport au répertoire de `team.json`.

Dans la racine du dépôt définie par `project.repo`, préparez :

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

Ce projet fusionne vers `project.base_branch` (par défaut `main` ; seules `main` et `master` sont valides) et crée un worktree git pour chaque agent.

Avant de démarrer, vérifiez :

- `team.json -> project.repo` pointe vers un dépôt git (souvent `.`)
- si `project.repo` est relatif, il est résolu depuis le répertoire de `team.json`
- la branche indiquée par `project.base_branch` existe dans le dépôt (`main` ou `master`, selon la config)
- votre dépôt supporte `git worktree`

## 3. Écrire `team.json` (cœur du système)

`team.json` peut être placé n'importe où, mais il est recommandé de le garder dans la racine du dépôt ou dans un endroit facile à gérer.

Voici un exemple “squelette minimal” (remplacez modèles et prompts par les vôtres, et renseignez de vrais noms de skills) :

```json
{
  "model": "default",
  "project": { "name": "open-agent-team-demo", "repo": ".", "base_branch": "main" },
  "models": { "default": "anthropic/claude-3-5-sonnet-20240620" },
  "providers": { "openai_compatible": { "base_url": "https://api.openai.com/v1", "api_key_env": "OPENAI_API_KEY" } },
  "admin": {
    "name": "admin",
    "description": "Chef de projet responsable de l'agrégation finale et de la livraison",
    "model": "default",
    "prompt": "You are the project manager (Admin).\\nYour job is to summarize the final delivery and review team changelogs.",
    "skills": []
  },
  "teams": [
    {
      "name": "frontend",
      "branch_prefix": "team/frontend",
      "leader": {
        "name": "frontend-lead",
        "description": "Responsable frontend; décompose les tâches et demande aux workers de les exécuter",
        "model": "default",
        "prompt": "You are the Leader agent for the frontend team.",
        "skills": [],
        "repos": ["src/", "package.json"]
      },
      "worker": {
        "total": 3,
        "model": "default",
        "prompt": "You are a Worker engineer.",
        "extra_skills": []
      }
    }
  ]
}
```

Au minimum, vérifiez :

- `admin.prompt`, `leader.prompt`, `worker.prompt` ne sont pas vides (ou utilisez des chemins `*.md`)
- l'héritage des modèles est clair : `worker.model -> leader.model -> admin.model -> model` (vous pouvez ne définir que le `model` global puis surcharger au besoin)
- `teams[]` contient au moins une équipe
- `leader.repos` liste les chemins sur lesquels vous voulez que les workers se concentrent (mappé vers sparse-checkout allowlist)

## 4. Démarrer l'Orchestrateur

Lancez :

```bash
oat start team.json "<goal>" --port 3100
```

- `--port` : port HTTP de l'Orchestrateur (utilisé pour les callbacks d'outils)
- `<goal>` : objectif final injecté dans le prompt du Leader

Pour définir la langue de sortie/log :

```bash
oat start team.json "<goal>" --port 3100 --lang zh-CN
```

## 5. Observer le résultat

Points de contrôle courants :

- Orchestrator démarre et écoute sur le port indiqué
- Les workspaces worker apparaissent sous `workspace.root_dir` (par défaut `<répertoire de team.json>/workspaces/<agentId>`)
- Chaque worker met à jour le `CHANGELOG.md` à la racine lorsqu'il termine
- Les branches des workers sont fusionnées dans les branches correspondantes des leaders
- Après fusion du leader vers `project.base_branch`, Orchestrator nettoie le leader et ses workers (processus + workspace)

## 6. Statut / arrêt

Vérifier l'état de l'Orchestrateur (lire `orchestrator.json` dans `state_dir`) :

```bash
oat status
```

Sans argument, la commande déduit `state_dir` depuis `team.json` du dossier courant (même niveau `.oat/state`) ; si `team.json` est introuvable, une erreur est levée.

Arrêt (envoyer SIGTERM au pid de l'Orchestrateur) :

```bash
oat stop
```

## 7. Afficher la documentation (multi-langue)

Vous pouvez afficher le contenu via CLI, par exemple :

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```
