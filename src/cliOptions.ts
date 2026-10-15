import { InvalidArgumentError } from 'commander';
import { isRunEnv, RUN_ENVS, type RunEnv } from './lib/telemetry/context.js';

export const parseIntOption = (value: string): number => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) throw new InvalidArgumentError('expected a number');
    return parsed;
};

export const parseEnvOption = (value: string): RunEnv => {
    if (!isRunEnv(value)) throw new InvalidArgumentError(`expected one of ${RUN_ENVS.join(', ')}`);
    return value;
};
