# Triage dashboard frontend

React + TypeScript + Vite + Tailwind. Design: [docs/ui-design.md](../docs/ui-design.md).

```sh
pnpm install
pnpm dev      # http://127.0.0.1:5173, mock API with fixture data
pnpm build    # tsc, then dist/ (no inline scripts or styles; fonts bundled)
```

The app runs against `createMockApi()` (`src/api/mock/`). Pick the signed-in role
with `?as=operator|maintainer|maintainer-off|viewer` or the user menu.

A feature is a module in `src/modules/<name>/` listed in `src/registry/index.ts`.
