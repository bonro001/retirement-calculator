/**
 * ESM bootstrap for the Node-side policy certification worker.
 * Mirrors host-worker-loader.mjs: register tsx before importing the
 * TypeScript worker entry.
 */

import { register } from 'tsx/esm/api';

register();

await import('./certify-worker.ts');
