# Mémoire privée des Agents et maintenance par propriétaire

> État : implémenté, schéma SQLite v9.

Admin, Leader et Worker disposent chacun d'une mémoire privée isolée entre les tâches. Les événements d'un Worker lui appartiennent et ne sont plus transférés au Leader. Le contexte récupéré reste une indication historique faillible et ne remplace jamais les instructions courantes.

Le stockage de référence utilise `better-sqlite3` en mode WAL dans `<state_dir>/memory/memory.db`. L1 conserve l'activité récente, L2 les faits et épisodes gouvernés, et L3 les connaissances privées stables. Seuls les éléments actifs peuvent être injectés. La recherche lexicale reste le mode par défaut ; Zvec peut être activé par Project avec un repli lexical et une autorisation globale explicite.

Il n'existe pas d'Agent de rêve central. À la fin d'une tâche ou pendant une période d'inactivité, chaque Agent exécute séparément une maintenance limitée à ses propres événements. Les exécutions sont enregistrées dans `maintenance_runs` et diffusées via `agent.memory_maintenance.*`. L'ancien chemin `dream_runs` n'est conservé que pour la migration et les tests de compatibilité.

API principales : `GET /memory/overview`, `GET /memory`, `POST /memory/maintenance` avec `{ "agentId": "..." }`, `POST /memory/:id/promote`, `POST /memory/:id/confirm` et `POST /memory/:id/forget`.

Desktop affiche l'entrée mémoire pour tout Agent interne sélectionné, y compris les Workers. L'utilisateur local peut consulter et administrer chaque propriétaire, tandis que les Agents eux-mêmes ne peuvent lire que leur propre mémoire.

Les connaissances partagées sont distinctes de la mémoire privée. Elles proviennent de fichiers de projet ou d'équipe révisés, ainsi que de fichiers importés par l'utilisateur, puis sont découpées et vectorisées dans la même base SQLite et le même pipeline sémantique/Zvec. Voir la documentation chinoise `knowledge-architecture.md` pour le contrat complet.

Validation : `pnpm test:memory`, `pnpm exec tsc --noEmit`, `pnpm run build`, `pnpm --filter ./desktop run build`.
