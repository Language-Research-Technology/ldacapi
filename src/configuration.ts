import config from './default.config.ts';
import { log } from './utils.ts';

//export const config = Object.create(defaultConfig);
export { config };
const nodeEnv = process.env.NODE_ENV || 'development';
const configPath = process.env.LDACAPI_CONFIG_PATH || `../${nodeEnv}.config.ts`;
(async function() {
  try {
    const actualConfig = await import(configPath);
    log.info(`Loaded config from ${configPath}`);
    merge(config, actualConfig.default);
  } catch (error) {
    log.error(error);
  }
})();

function merge(target: any, source: any) {
  for (const key in source) {
    const value = source[key];
    if (typeof value === 'object' && Object.is(value.constructor, Object)) {
      merge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}