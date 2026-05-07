export type EngineRuntime =
  | 'ts'
  | 'rust-shadow'
  | 'rust-dry-run'
  | 'rust-native-shadow'
  | 'rust-native-compact-shadow'
  | 'rust-native-compact';

export type ShadowEngineRuntime = Exclude<
  EngineRuntime,
  'ts' | 'rust-native-compact'
>;

export type TelemetryEngineRuntime = Exclude<EngineRuntime, 'ts'>;

export const DEFAULT_ENGINE_RUNTIME: EngineRuntime = 'rust-native-compact';

const ENGINE_RUNTIMES = new Set<EngineRuntime>([
  'ts',
  'rust-shadow',
  'rust-dry-run',
  'rust-native-shadow',
  'rust-native-compact-shadow',
  'rust-native-compact',
]);

type RuntimeEnv = Readonly<{
  ENGINE_RUNTIME?: string;
  ENGINE_RUNTIME_DEFAULT?: string;
}>;

export function isEngineRuntime(value: string | undefined): value is EngineRuntime {
  return ENGINE_RUNTIMES.has(value as EngineRuntime);
}

export function resolveEngineRuntime(env: RuntimeEnv = {}): EngineRuntime {
  const configured = env.ENGINE_RUNTIME ?? env.ENGINE_RUNTIME_DEFAULT;
  return isEngineRuntime(configured) ? configured : DEFAULT_ENGINE_RUNTIME;
}

export function isShadowRuntime(
  runtime: EngineRuntime,
): runtime is ShadowEngineRuntime {
  return (
    runtime === 'rust-shadow' ||
    runtime === 'rust-dry-run' ||
    runtime === 'rust-native-shadow' ||
    runtime === 'rust-native-compact-shadow'
  );
}
