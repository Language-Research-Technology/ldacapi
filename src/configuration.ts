import config from './default.config.ts';
import { log } from './utils.ts';

//export const config = Object.create(defaultConfig);
export { config };

const nodeEnv = process.env.NODE_ENV || 'development';
const configPath = process.env.LDACAPI_CONFIG_PATH || `../${nodeEnv}.config.ts`;

try {
  const actualConfig = await import(configPath);
  log.info(`Loaded config from ${configPath}`);
  merge(config, actualConfig.default);
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code !== 'ERR_MODULE_NOT_FOUND') {
    log.error(error);
  }
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key in source) {
    const value = source[key];
    if (typeof value === 'object' && value !== null && Object.is(value.constructor, Object)) {
      target[key] = target[key] ?? {};
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}
