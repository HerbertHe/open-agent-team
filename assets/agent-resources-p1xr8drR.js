var e=`# Agent Resources: conversational project and team creation

\`oat resources\` is the interactive entry point for an organization resource administrator, similar to an HR role. Instead of requiring a hand-written declarative configuration, it gathers project, model, runtime, team responsibility, and Worker-capacity information through questions, then generates and validates \`team.json\`.

## Usage

\`\`\`bash
oat resources
oat resources ./my-project/team.json
oat resources ./team.json --force
\`\`\`

An existing configuration is not overwritten unless \`--force\` is supplied.

## Interview and output

The assistant collects:

1. project name, repository location, and production branch;
2. default model, provider protocol, and optional connection details;
3. a \`local_process\` or \`docker\` runtime, including Docker image, network, and resource limits;
4. each team's identifier, Leader responsibility, allowed paths, and Worker capacity.

The generated Admin prompt is limited to project governance, team assignment, status analysis, and release approval. Leader and Worker prompts use the Git-review collaboration workflow by default.

The same \`TeamFileSchema\` used at startup validates the output before it is written, so the resulting file can be passed directly to \`oat start\`. In production, provide API keys through secure environment variables or a secret manager instead of storing them in the generated file.

Desktop also provides an **Agent Resources** entry point with a guided form that saves the generated configuration to the selected project.
`;export{e as default};