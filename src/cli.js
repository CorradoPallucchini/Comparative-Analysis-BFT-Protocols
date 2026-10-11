'use strict';

/**
 * Minimal CLI option parser shared by the generator and the benchmark.
 *
 * Each option is resolved in this order: `--name value` / `--name=value`
 * on the command line, then the environment variable `env`, then `default`.
 * Values are validated by `type` so that a typo fails loudly instead of
 * silently falling back to a default.
 */

function parseRawArgs(argv) {
    const raw = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            throw new Error(`Unexpected positional argument "${arg}"`);
        }
        const eq = arg.indexOf('=');
        if (eq !== -1) {
            raw[arg.slice(2, eq)] = arg.slice(eq + 1);
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
            raw[arg.slice(2)] = argv[++i];
        } else {
            raw[arg.slice(2)] = 'true';
        }
    }
    return raw;
}

function coerce(name, value, spec) {
    switch (spec.type) {
        case 'int': {
            if (!/^-?\d+$/.test(String(value).trim())) {
                throw new Error(`--${name} must be an integer (got "${value}")`);
            }
            const n = parseInt(value, 10);
            if (spec.min !== undefined && n < spec.min) throw new Error(`--${name} must be >= ${spec.min} (got ${n})`);
            if (spec.max !== undefined && n > spec.max) throw new Error(`--${name} must be <= ${spec.max} (got ${n})`);
            return n;
        }
        case 'float': {
            const n = Number(value);
            if (!Number.isFinite(n)) throw new Error(`--${name} must be a number (got "${value}")`);
            if (spec.min !== undefined && n < spec.min) throw new Error(`--${name} must be >= ${spec.min} (got ${n})`);
            if (spec.max !== undefined && n > spec.max) throw new Error(`--${name} must be <= ${spec.max} (got ${n})`);
            return n;
        }
        case 'enum': {
            const v = String(value).toLowerCase();
            if (!spec.values.includes(v)) {
                throw new Error(`--${name} must be one of ${spec.values.join(', ')} (got "${value}")`);
            }
            return v;
        }
        case 'list':
            return String(value).split(',').map(s => s.trim()).filter(Boolean);
        case 'bool':
            return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
        default:
            return String(value);
    }
}

function parseOptions(specs, argv = process.argv.slice(2), env = process.env) {
    const raw = parseRawArgs(argv);
    if ('help' in raw) return { help: true };

    const unknown = Object.keys(raw).filter(k => !(k in specs));
    if (unknown.length > 0) {
        throw new Error(`Unknown option(s): ${unknown.map(k => `--${k}`).join(', ')}`);
    }

    const opts = {};
    for (const [name, spec] of Object.entries(specs)) {
        let value = raw[name];
        if (value === undefined && spec.env && env[spec.env] !== undefined && env[spec.env] !== '') {
            value = env[spec.env];
        }
        if (value === undefined) {
            opts[name] = spec.default;
        } else {
            opts[name] = coerce(name, value, spec);
        }
    }
    return opts;
}

function formatHelp(title, specs) {
    const lines = [title, '', 'Options:'];
    for (const [name, spec] of Object.entries(specs)) {
        const env = spec.env ? ` [env: ${spec.env}]` : '';
        const def = spec.default !== undefined ? ` (default: ${spec.default})` : '';
        lines.push(`  --${name.padEnd(22)} ${spec.description || ''}${def}${env}`);
    }
    return lines.join('\n');
}

module.exports = { parseOptions, parseRawArgs, formatHelp };
