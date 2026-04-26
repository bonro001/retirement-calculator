/**
 * Tiny ESM bootstrap that gives a node:worker_thread the ability to
 * import `.ts` files. We do it here (not in execArgv) because tsx's
 * `--import tsx` flag is unreliable across Node versions for workers —
 * registering the loader explicitly via `node:module` works on every
 * Node ≥ 20.6 and stays inside the well-documented public API.
 *
 * Once `register()` returns, subsequent `import(...)` calls resolve
 * `.ts` extensions through tsx's hook. We use a dynamic import for
 * the actual worker entry so that registration happens BEFORE the
 * static-import graph of `host-worker.ts` is walked.
 */

// tsx exposes its own `register()` from `tsx/esm/api` — that's the
// supported entry point. Calling Node's `register('tsx/esm', ...)`
// directly trips an internal "use --import" guard (Node 23). The tsx
// API does the right `--import`-equivalent registration internally.
import { register } from 'tsx/esm/api';

register();

// Dynamic import — registration must happen before any `.ts` static
// imports are walked.
await import('./host-worker.ts');
