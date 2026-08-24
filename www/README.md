# Open Agent Team — Website

This directory contains the Open Agent Team (OAT) product and documentation website, built with React, TypeScript, and Vite.

It presents the declarative `Admin -> Leader -> Worker` collaboration model: tasks queue per agent, Workers develop on isolated Git branches, Leaders review, and Admin controls releases to `main`/`master`.

## Development

From the repository root:

```bash
pnpm --dir www dev
pnpm --dir www build
pnpm --dir www lint
```

## Languages and documentation

The interface is available in English, Simplified Chinese, French, and Japanese. UI translations live in `src/i18n/locales/`. The documentation viewer loads Markdown from `../docs/<language>/`; it falls back to English when a translated page is unavailable.

The highlighted documentation covers Git-reviewed collaboration, Docker-isolated sessions, the Agent Resources project/team setup assistant, and the proposed L1/L2/L3 memory architecture.

## Deployment

Vite emits the static site to `www/dist/`. `public/CNAME` defines the custom domain used by static hosting.
