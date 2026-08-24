var e=`# Environnement d'exécution Docker

Avec \`runtime.mode: "docker"\`, chaque session Admin, Leader ou Worker s'exécute dans son propre conteneur. La file de tâches, les branches Git, les demandes de revue et l'approbation de publication restent gérées par l'Orchestrator hôte.

La migration est à sens unique : \`local_process\` peut devenir \`docker\`, mais un projet Docker ne peut plus revenir aux processus locaux. La règle est persistée dans \`.oat/runtime-policy.json\`.

\`\`\`json
"runtime": {
  "mode": "docker",
  "docker": {
    "image": "node:22-bookworm",
    "network": "bridge",
    "extra_args": ["--cpus=2", "--memory=4g"]
  },
  "persistence": { "state_dir": ".oat/state" }
}
\`\`\`

L'image doit fournir Node.js 22 (ou une version compatible) et les outils nécessaires au projet. Seul le worktree Git de l'agent courant est monté en écriture dans \`/workspace\`; le runtime OAT et les données pi sont montés en lecture seule. Les appels d'outils reviennent à l'hôte via JSONL stdio et restent exécutés par l'Orchestrator.

- Le réseau par défaut est \`bridge\`; utilisez \`none\` pour un travail hors ligne ou un modèle local.
- Les variables \`OPENAI_*\` et \`ANTHROPIC_*\` ne sont transmises que si elles existent sur l'hôte.
- \`extra_args\` n'accepte que les limites CPU, mémoire, PID, ulimit, tmpfs \`/tmp\`, lecture seule, \`cap-drop=ALL\` et \`no-new-privileges\`. Les montages, privilèges, périphériques et sockets Docker sont refusés.
- Ne montez jamais le socket Docker, le répertoire home de l'hôte ni le dépôt principal : seul le worktree attribué à la tâche est autorisé.
- Une session utilise \`docker run --rm -i\`; elle est recréée lors d'une réinitialisation ou d'un changement de tâche. Les preuves Git et de revue persistent dans \`state_dir/git-collaboration/\` sur l'hôte.
- Desktop affiche le moteur, les conteneurs OAT étiquetés et les journaux bornés, et peut redémarrer en sécurité un Agent inactif.
`;export{e as default};