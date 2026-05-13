# Référence du CLI OAT

L'interface en ligne de commande `oat` fournit des outils pour gérer votre Orchestrateur Open Agent Team, inspecter les états et consulter la documentation.

## Options globales

- `-v, --version` : Affiche le numéro de version.
- `--lang <lang>` : Langue de sortie pour les messages CLI et les documents. Valeurs supportées : `en`, `zh-CN`, `fr`, `ja`.
- `-h, --help` : Affiche l'aide pour le CLI ou une commande spécifique.

---

## `oat init`

Initialiser un nouveau fichier de configuration `team.json` dans le répertoire courant (en copiant la configuration d'exemple intégrée).

**Utilisation :**
```bash
oat init
```

## `oat start`

Démarre l'Orchestrateur en tant que démon en arrière-plan pour gérer et planifier l'équipe d'Agents en fonction du fichier de configuration. Utilisez `oat dashboard` pour le voir en temps réel.

**Utilisation :**
```bash
oat start [options]
```

**Options :**
- `--config <path>` : Chemin vers votre fichier de configuration `team.json`. Si omis, prend par défaut `./team.json` dans le répertoire courant, ou le chemin spécifié par la variable d'environnement `OAT_TEAM_JSON`.
- `--goal <text>` : Un objectif final de projet (optionnel) injecté dans les agents Leader. Vous pouvez également le passer en argument de fin : `oat start team.json "Mon objectif"`.
- `--port <number>` : Numéro de port pour le serveur HTTP de l'Orchestrateur (API du tableau de bord d'observabilité). La valeur par défaut est `0` (scanne automatiquement un port disponible à partir de 8787).

---

## `oat list` / `oat ls`

Vérifie l'état actuel de tous les Orchestrateurs OAT locaux (s'ils sont en cours d'exécution, le PID, le port, etc.). Il s'agit d'une commande globale.

**Utilisation :**
```bash
oat list
# ou
oat ls
```

---

## `oat stop`

Envoie un signal d'arrêt en douceur (SIGINT) à l'Orchestrateur en cours d'exécution. L'Orchestrateur arrêtera tous les runtimes d'agents et les workspaces en toute sécurité.

**Utilisation :**
```bash
oat stop [options] [projectId]
```

**Options :**
- `--all` : Arrêter tous les projets OAT en cours d'exécution. Si `--all` est utilisé, `projectId` n'est pas requis.

**Arguments :**
- `projectId` : L'ID du projet, qui peut être trouvé à l'aide de la commande `oat list`. Requis si `--all` n'est pas spécifié.

---

## `oat rm`

Supprime complètement toutes les données d'état OAT et les répertoires d'espace de travail pour le projet spécifié. Le projet doit être arrêté avant de pouvoir être supprimé. Cela ne supprimera PAS votre dépôt d'origine.

**Utilisation :**
```bash
oat rm [options] <projectId>
```

**Arguments :**
- `projectId` : L'ID du projet, qui peut être trouvé à l'aide de la commande `oat list`.

---

## `oat inspect`

Inspecte les workspaces locaux créés par l'Orchestrateur et liste leurs états actuels.

**Utilisation :**
```bash
oat inspect [options] [stateDir] [workspaceRoot]
```

**Arguments :**
- `stateDir` : Le répertoire d'état.
- `workspaceRoot` : Le répertoire où les workspaces sont stockés (par défaut `workspaces`).

**Options :**
- `--limit <number>` : Nombre maximal d'entrées de workspace à afficher (défaut : 50).

---

## `oat dashboard`

Ouvre le tableau de bord web OAT global dans votre navigateur par défaut. Le tableau de bord se connecte automatiquement aux instances de l'Orchestrateur en cours d'exécution pour fournir une observabilité en temps réel, une gestion de projet et un suivi des réalisations.

**Utilisation :**
```bash
oat dashboard
```

---

## `oat docs`

Affiche le contenu de la documentation directement dans le terminal.

**Utilisation :**
```bash
oat docs [options] <name>
```

**Arguments :**
- `name` : Nom du document à afficher. Documents disponibles : `architecture`, `config`, `guide`, `cli`.

**Exemple :**
```bash
oat docs config --lang fr
```
