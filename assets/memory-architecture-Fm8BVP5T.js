var e=`# Architecture mémoire agent à trois niveaux

> Statut : proposition de conception, non encore implémentée. Elle remplace l'idée que \`CHANGELOG.md\` serait l'unique mémoire de collaboration, sans supprimer ce journal lisible par les humains.

## Objectif

La mémoire doit restaurer les objectifs et tests après redémarrage, détecter les conflits avant la création d'une tâche, relier décisions et preuves, et limiter l'injection de contexte. Chaque information possède une portée, une source, une version et un statut de revue.

## Niveaux

| Niveau | Rôle | Stockage et durée |
| --- | --- | --- |
| L1 | Contexte chaud de la session et de la tâche : objectif, tests, blocages, prochaine étape | \`Map\` en mémoire, TTL court, budget de 1 000–2 000 tokens |
| L2 | Faits collaboratifs structurés : tâches, réclamations de ressources, décisions, revues | SQLite WAL + FTS5 dans \`<state_dir>/memory.sqlite\` |
| L3 | Archives et recherche sémantique : CHANGELOG, événements, commits, diffs et versions validées | fichiers/index local, puis vector store remplaçable si nécessaire |

L1 est propre à \`agentId + taskId + sessionId\`. L2 partage uniquement les éléments révisables dans les portées \`task → agent → team → project → global\`. L3 n'est consulté qu'à la demande afin de ne pas surcharger le contexte.

## Contrôle, preuves et conflit

Un Worker peut écrire son L1 et proposer un transfert L2; un Leader révise et promeut les faits d'équipe; seul l'Admin publie un fait ou une décision de projet. Toute promotion cite au moins une preuve : tâche, commit, test, événement, fichier ou revue. Une correction crée une nouvelle version et marque l'ancienne \`superseded\`.

Avant \`create task\`, une barrière L2 consulte les \`resource_claims\`, contextes actifs et \`conflictKey\`. En cas de conflit, elle refuse la tâche, l'ordonne en série ou demande un redécoupage réellement indépendant.

## Interface prévue

Les outils proposés sont \`memory-context-get\`, \`memory-search\`, \`memory-propose\`, \`memory-promote\`, \`memory-supersede\`, \`memory-claim-resources\`, \`memory-check-conflicts\` et \`memory-forget\`, avec des API REST équivalentes. Le tableau de bord affichera le contexte L1, les éléments L2 en attente de revue et les archives L3 avec leurs sources, dates, niveaux de confiance et chaîne de versions.

## Déploiement progressif

1. définir les contrats \`MemoryProvider\`, l'audit et les migrations ;
2. livrer L1 + L2 avec SQLite/FTS5 et contrôle de conflit dans la file ;
3. indexer les archives L3 et ajouter recherche hybride mot-clé/vecteur ;
4. n'évaluer un graphe temporel (par exemple Graphiti) que si les requêtes multi-sauts deviennent un besoin démontré.

Références de conception : [Letta](https://github.com/letta-ai/letta), [Mem0](https://github.com/mem0ai/mem0), [LangGraph Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx), [Graphiti](https://github.com/getzep/graphiti) et [OpenMemory](https://github.com/CaviraOSS/OpenMemory).
`;export{e as default};