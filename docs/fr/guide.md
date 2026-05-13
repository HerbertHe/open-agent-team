# Guide de démarrage rapide

Ce guide vous aide à lancer localement la structure déclarative `Admin -> Leader -> Worker` avec le minimum d'étapes.

## 1. Installation

```bash
npm i open-agent-team -g
```

Cela installe le CLI `oat` globalement. Vous pouvez vérifier l'installation avec :

```bash
oat --help
```

## 2. Configurer les skills (optionnel)

Les skills sont gérées via [`npx skills`](https://github.com/vercel-labs/skills). Vous déclarez les sources de skills dans `team.json` au format `SkillEntry`, et OAT les installe automatiquement dans le workspace de chaque agent au démarrage.

Chaque `SkillEntry` contient :
- `source` : source du skill (GitHub shorthand comme `vercel-labs/agent-skills`, URL complète, ou chemin local)
- `names` (optionnel) : noms des skills spécifiques à installer ; omettez ou utilisez `["*"]` pour tout installer

Exemple dans `team.json` :
```json
"skills": [
  { "source": "vercel-labs/agent-skills", "names": ["frontend-design"] },
  { "source": "./my-local-skills" }
]
```

Au démarrage, OAT exécute `npx skills add` pour chaque entrée, installe les skills dans `<workspace>/skills/`, et crée un lien symbolique `.pi/skills` pour la compatibilité pi-coding-agent. L'agent découvre et charge automatiquement les skills depuis son workspace.

> Astuce : Vous pouvez démarrer sans skills — laissez simplement `"skills": []` dans votre config.

## 2. Préparer votre dépôt Git et les branches (recommandé)

Ce projet fusionne vers `project.base_branch` (par défaut `main` ; seules `main` et `master` sont valides) et crée un worktree git pour chaque agent.

Avant de démarrer, vérifiez :

- `team.json -> project.repo` pointe vers un dépôt git (souvent `.`)
- si `project.repo` est relatif, il est résolu depuis le répertoire de `team.json`
- la branche indiquée par `project.base_branch` existe dans le dépôt (`main` ou `master`, selon la config)
- votre dépôt supporte `git worktree`

## 3. Écrire `team.json` (cœur du système)

`team.json` peut être placé n'importe où, mais il est recommandé de le garder dans la racine du dépôt ou dans un endroit facile à gérer.

Voici un exemple "squelette minimal" (remplacez modèles et prompts par les vôtres) :

```json
{
  "model": "default",
  "project": { "name": "open-agent-team-demo", "repo": ".", "base_branch": "main" },
  "models": { "default": "openai/gpt-4o-mini" },
  "providers": { "openai": { "compatible_type": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-..." } },
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
oat start team.json [goal]
```

- `[goal]` : objectif final injecté dans le prompt du Leader
- `--port` (optionnel) : port HTTP de l'Orchestrateur. **Si omis, OAT scanne automatiquement un port disponible à partir de 8787**

Pour définir la langue de sortie/log :

```bash
oat start team.json [goal] --lang zh-CN
```

Au démarrage, OAT crée un lien symbolique sous `~/.oat/projects/` pointant vers le répertoire du projet, permettant la gestion multi-projets.

## 5. Utiliser le tableau de bord

OAT embarque un tableau de bord web, automatiquement disponible après le démarrage de l'Orchestrateur. Ouvrez `http://localhost:<port>` dans votre navigateur.

Vous pouvez également lancer le tableau de bord indépendamment (sans démarrer l'Orchestrateur) :

```bash
oat dashboard
oat dashboard --port 9090  # port personnalisé (par défaut : 3737)
```

Cette commande démarre un serveur statique local et ouvre automatiquement le tableau de bord dans votre navigateur par défaut.

Le tableau de bord comprend :

- **Tableau de bord** : vue d'ensemble du projet, liste des projets en cours (avec suppression)
- **État du projet** : flux SSE en temps réel, topologie des agents, rapports de progression. Supporte le basculement entre différentes instances
- **Configuration projet** : édition en ligne du `team.json` avec aperçu JSON coloré via Shiki. La sauvegarde redémarre automatiquement le projet
- **Paramètres** : paramètres globaux (rétention des logs, etc.)

### Support multi-projets

Le tableau de bord gère plusieurs projets simultanément. Dans les pages « État du projet » et « Configuration projet », utilisez le sélecteur pour basculer. L'affichage suit le format `Nom de config (ID projet)`.

## 6. Observer le résultat

Points de contrôle courants :

- L'Orchestrateur démarre et écoute sur le port attribué automatiquement ou spécifié
- Les workspaces worker apparaissent sous `workspace.root_dir` (par défaut `<répertoire de team.json>/workspaces/<agentId>`)
- Chaque worker met à jour le `CHANGELOG.md` à la racine lorsqu'il termine
- Les branches des workers sont fusionnées dans les branches correspondantes des leaders
- Après fusion du leader vers `project.base_branch`, l'Orchestrateur nettoie le leader et ses workers (processus + workspace)

## 7. Statut / arrêt

Vérifier l'état de l'Orchestrateur (lire `orchestrator.json` dans `state_dir`) :

```bash
oat list
```

Sans argument, la commande déduit `state_dir` depuis `team.json` du dossier courant (même niveau `.oat/state`) ; si `team.json` est introuvable, une erreur est levée.

Arrêt (envoyer SIGTERM au pid de l'Orchestrateur) :

```bash
oat stop
```

## 8. Référence API REST

L'Orchestrateur expose les API de gestion suivantes :

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/projects` | Lister tous les projets enregistrés |
| DELETE | `/api/projects/:name` | Supprimer un projet (doit être arrêté) |
| GET | `/api/projects/:name/config` | Lire le team.json du projet |
| PUT | `/api/projects/:name/config` | Mettre à jour le team.json du projet |
| POST | `/api/projects/:name/restart` | Redémarrer un projet |
| GET | `/api/team-config` | Lire le team.json du projet courant |
| PUT | `/api/team-config` | Mettre à jour le team.json du projet courant |
| GET | `/api/global-config` | Lire la config globale (oat.yaml) |
| PUT | `/api/global-config` | Mettre à jour la config globale |

## 9. Afficher la documentation (multi-langue)

Vous pouvez afficher le contenu via CLI, par exemple :

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```

