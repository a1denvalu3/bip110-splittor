export type LogLevel = 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

function normalize(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    return value;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
    const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, normalize(value)]))
    });
    if (level === 'error') console.error(entry);
    else if (level === 'warn') console.warn(entry);
    else console.log(entry);
}

export const logInfo = (event: string, fields?: LogFields) => log('info', event, fields);
export const logWarn = (event: string, fields?: LogFields) => log('warn', event, fields);
export const logError = (event: string, fields?: LogFields) => log('error', event, fields);
