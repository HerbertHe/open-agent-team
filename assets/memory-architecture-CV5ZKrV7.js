var e=`# Mémoire à trois niveaux pour Admin et Leader

> État : implémenté le 26 août 2026.

La mémoire concerne les agents Admin et Leader. Les événements utiles d'un Worker sont attribués à son Leader. Le contexte récupéré est signalé comme historique et faillible : il ne remplace jamais les instructions courantes.

Le stockage local utilise \`better-sqlite3\` en mode WAL, par défaut dans \`<state_dir>/memory/memory.db\`.

| Niveau | Rôle |
| --- | --- |
| L1 | Activité récente, progression, réponses et erreurs ; capacité et TTL limités |
| L2 | Épisodes, décisions et échecs consolidés pendant l'inactivité ; preuves et confiance cumulatives |
| L3 | Connaissances stables promues automatiquement selon le seuil de preuves ou manuellement |

Le mode rêve ne s'exécute que si aucun prompt n'est actif et si aucune tâche n'est en attente, en cours, bloquée ou en review. Il consolide un nombre borné d'événements, promeut L2 vers L3, expire L2 et nettoie L1. Un nouveau travail demande son annulation.

Les payloads bruts ne sont pas stockés. Le texte utile est limité à 4 000 caractères et les formes courantes de clés, tokens et secrets sont masquées. Admin consulte L2/L3 pour le projet ; un Leader ne consulte que sa mémoire.

API : \`GET /memory/overview\`, \`GET /memory\`, \`POST /memory/dream\`, \`POST /memory/:id/promote\`, \`POST /memory/:id/forget\`.

Desktop affiche une icône cerveau pour Admin et Leader. La boîte de dialogue présente L1/L2/L3, les preuves, sources, confiance, activité et exécutions du mode rêve ; elle permet la promotion et l'oubli. Cette entrée n'apparaît pas pour un Worker.

La recherche actuelle est déterministe (recouvrement lexical, importance, confiance et ancienneté). Les embeddings, le graphe temporel et le réflecteur LLM sont des évolutions possibles, pas des dépendances actuelles.

Validation : \`pnpm test:memory\`, \`pnpm exec tsc --noEmit\`, \`pnpm run build\`, \`pnpm --filter desktop run build\`.
`;export{e as default};