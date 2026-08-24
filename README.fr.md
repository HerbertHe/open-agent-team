# Open Agent Team

<p align="center">
  <img src="./logo/logo.svg" width="200" alt="Open Agent Team Logo" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/v/open-agent-team?style=flat-square" alt="NPM Version" /></a>
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/dt/open-agent-team?style=flat-square" alt="NPM Downloads" /></a>
</p>


Ce projet vous permet de construire une équipe d'agents **déclarative** avec une hiérarchie en 3 couches :

`Admin -> Leader -> Worker`

Vous déclarez les rôles, modèles, skills partagées et les stratégies workspace/git dans `team.json`. À l'exécution, l'Orchestrateur démarre tous les agents (`Admin`, `Leader`s et un pool de `Worker` pré-créé) et les `Leader`s distribuent les tâches aux `Worker`s. Chaque `Worker` doit mettre à jour un `CHANGELOG.md`, qui est fusionné vers le haut :

`Worker CHANGELOG` -> `Leader CHANGELOG` -> résumé final de `Admin`. Tous les rôles (Admin, Leader, Worker) sont strictement tenus d'**AJOUTER (APPEND)** leurs notes à leur fichier `CHANGELOG.md` respectif.

## Démarrage rapide

### 1. Installation

**Via script en une ligne (Recommandé) :**

**macOS & Linux :**
```bash
curl -fsSL https://oat.ibert.me/install.sh | bash
```

**Windows :**
```powershell
powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
```

**Via NPM :**

```bash
npm i open-agent-team -g
```

### 2. Créer `team.json`

Créez un `team.json` à la racine de votre projet (voir [team.example.json](./team.example.json) pour un exemple complet) :

```bash
oat init
```

### 3. Lancer votre équipe

```bash
oat start team.json
```

### 4. Ouvrir OAT Desktop

Utilisez Desktop pour gérer les projets, tâches, observations en direct, configurations, statistiques, résultats, extensions, canaux, livraisons Git et runtimes Docker.

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
oat start team.json [goal]
```


Choisir la langue de sortie/docs :

```bash
oat start team.json [goal] --lang zh-CN
```

**OAT Desktop** fournit l'observabilité en temps réel, l'édition de configuration, les paramètres globaux, la gestion multi-projets, les opérations de tâches et les réalisations du projet.

### 4) Commandes utiles

```bash
oat list
oat stop
oat docs architecture --lang fr
oat docs config --lang fr
oat docs guide --lang fr
```

## Fonctionnement de la collaboration (vue d'ensemble)

1. L'Orchestrateur installe les skills via `npx skills add`, démarre `Admin`, chaque `Leader`, et pré-crée un pool de `Worker` (taille = `teams[].worker.total`).
2. Un `Leader` appelle l'outil `dispatch-worker-tasks` avec une liste de `tasks`.
3. L'Orchestrateur envoie les tâches au pool de `Worker` pré-créé :
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

## Notifications de Canal de Push & Plugins OpenClaw

OAT prend en charge l'envoi de la progression des tâches, des plantages d'agents et des réalisations finales vers des canaux de discussion externes (par exemple Slack, Discord, WeChat), entièrement compatible avec l'écosystème de plugins OpenClaw.

### 1) Fichier de Configuration (`~/.oat/oat.json`)
Tous les paramètres globaux sont stockés nativement au format JSON standard dans `~/.oat/oat.json`. Une structure typique pour les canaux est :

```json
{
  "channels": {
    "openclaw-slack": {
      "accounts": {
        "team-slack": {
          "webhookUrl": "https://hooks.slack.com/services/..."
        }
      }
    }
  }
}
```

Pour acheminer les notifications de push du gestionnaire de tâches vers un canal, déclarez la cible dans `team.json` sous `admin.push_channel` :
```json
"admin": {
  "name": "AdminAgent",
  "push_channel": {
    "channel": "openclaw-slack",
    "account": "team-slack"
  }
}
```

### 2) Commandes CLI
Gériez les plugins de compatibilité et les comptes directement depuis le terminal :

- `oat channels` - Affiche tous les plugins chargés, les comptes configurés et les sessions WeChat actives.
- `oat channel login <channelId> <accountId>` - Guide et configuration du scanner interactif QR ASCII de terminal pour les canaux avec état (ex. WeChat) :
  ```bash
  oat channel login weixin my-wechat
  ```
- `oat plugins install <packageName>` - Télécharge et installe à chaud un plugin compatible OpenClaw depuis NPM :
  ```bash
  oat plugins install @tencent-weixin/openclaw-weixin
  ```
- `oat plugins uninstall <pluginId>` - Supprime physiquement un plugin du disque, en effaçant ses sessions en cache et ses informations d'identification.

### 3) Centre de Plugins Visuel (Tableau de Bord Web)
Le tableau de bord Web d'OAT comprend une page premium **Plugin Center** (`/plugins`) avec un effet de glassmorphism pour visuellement :
- Afficher les cartes d'état des plugins installés et des comptes actifs.
- Saisir les noms de paquets NPM pour télécharger et installer dynamiquement des plugins à chaud en un clic.
- Configurer de nouveaux comptes dynamiquement via des champs de formulaire visuels compilés directement à partir du schéma de configuration du plugin (`configSchema`).
- Guider les utilisateurs sur la numérisation des codes QR interactifs WeChat dans leurs terminaux CLI.

## Remerciements


## Star History

<a href="https://star-history.com/#HerbertHe/open-agent-team&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HerbertHe/open-agent-team&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HerbertHe/open-agent-team&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HerbertHe/open-agent-team&type=Date" />
  </picture>
</a>

## LICENSE

MIT &copy; Herbert He
