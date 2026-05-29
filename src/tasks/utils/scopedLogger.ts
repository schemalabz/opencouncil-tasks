export type ScopedLog = (...args: unknown[]) => void;

export function createScopedLogger(scope: string): ScopedLog {
    const prefix = `[${scope}]`;
    return (...args: unknown[]) => {
        if (typeof args[0] === 'string') {
            console.log(`${prefix} ${args[0]}`, ...args.slice(1));
        } else {
            console.log(prefix, ...args);
        }
    };
}

createScopedLogger.fromCallbackUrl = function (callbackUrl: string): ScopedLog {
    const match = callbackUrl.match(/\/cities\/([^/]+)\/meetings\/([^/]+)\//);
    const scope = match
        ? `pollDecisions:${match[1]}/${match[2]}`
        : 'pollDecisions:unknown';
    return createScopedLogger(scope);
};
