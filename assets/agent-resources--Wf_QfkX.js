var e=`# Agent Resources : création conversationnelle de projets et d'équipes

\`oat resources\` est le point d'entrée de l'administrateur des ressources de l'organisation, comparable à un rôle RH. Il recueille les informations par questions au lieu d'exiger l'écriture manuelle d'une configuration déclarative, puis génère et valide \`team.json\`.

## Utilisation

\`\`\`bash
oat resources
oat resources ./mon-projet/team.json
oat resources ./team.json --force
\`\`\`

Une configuration existante n'est pas écrasée sans \`--force\`.

## Entretien et résultat

L'assistant collecte :

1. le nom du projet, le dépôt et la branche de production ;
2. le modèle par défaut, le protocole fournisseur et les paramètres de connexion facultatifs ;
3. l'environnement \`local_process\` ou \`docker\`, y compris image, réseau et limites ;
4. l'identité de chaque équipe, la responsabilité du Leader, les chemins autorisés et la capacité des Workers.

Le prompt Admin généré est limité à la gouvernance du projet, l'affectation des équipes, l'analyse de l'état et l'approbation des livraisons. Les prompts Leader et Worker utilisent par défaut le flux Git avec revue.

La même \`TeamFileSchema\` que celle utilisée au démarrage valide le résultat avant son écriture : le fichier peut donc être passé directement à \`oat start\`. En production, injectez les clés API par variables d'environnement ou gestionnaire de secrets au lieu de les enregistrer dans le fichier.

Le tableau de bord offre également une entrée **Agent Resources** qui présente ce recueil sous forme de formulaire guidé et enregistre la configuration du projet sélectionné.
`;export{e as default};