import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENGINE_RUNTIME,
  isShadowRuntime,
  resolveEngineRuntime,
} from '../cluster/engine-runtime';

describe('cluster engine runtime config', () => {
  it('defaults Node hosts to TypeScript while Rust compact is under audit', () => {
    expect(resolveEngineRuntime({})).toBe('ts');
    expect(DEFAULT_ENGINE_RUNTIME).toBe('ts');
  });

  it('keeps TypeScript available as an explicit reference runtime', () => {
    expect(resolveEngineRuntime({ ENGINE_RUNTIME: 'ts' })).toBe('ts');
  });

  it('lets the explicit runtime override the default', () => {
    expect(
      resolveEngineRuntime({
        ENGINE_RUNTIME: 'rust-dry-run',
        ENGINE_RUNTIME_DEFAULT: 'rust-native-compact',
      }),
    ).toBe('rust-dry-run');
  });

  it('falls back to TypeScript when configured with an unknown runtime', () => {
    expect(resolveEngineRuntime({ ENGINE_RUNTIME_DEFAULT: 'nope' })).toBe('ts');
  });

  it('classifies comparison modes as shadow runtimes', () => {
    expect(isShadowRuntime('rust-shadow')).toBe(true);
    expect(isShadowRuntime('rust-native-compact-shadow')).toBe(true);
    expect(isShadowRuntime('rust-native-compact')).toBe(false);
    expect(isShadowRuntime('ts')).toBe(false);
  });
});
