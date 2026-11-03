const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

// Only chatlog operations use this scope; never change global fetch or RP state.
const scope = new AsyncLocalStorage();
let readEnabled = () => false;
let onChange = () => {};
let enabled = null;
let controller = new AbortController();
let epoch = randomUUID();

function stoppedError() {
    const error = new Error('챗로그 웹확장이 꺼져 작업을 중단했습니다');
    error.code = 'CHATLOG_DISABLED';
    return error;
}

function configure(options) {
    controller.abort(stoppedError());
    controller = new AbortController();
    enabled = null;
    readEnabled = options.readEnabled;
    onChange = options.onChange;
    refresh();
}

function refresh() {
    let next = false;
    try { next = readEnabled() === true; } catch { /* fail closed */ }
    if (next !== enabled) {
        const previous = enabled;
        enabled = next;
        epoch = randomUUID();
        controller.abort(stoppedError());
        controller = new AbortController();
        if (!next) controller.abort(stoppedError());
        onChange(next, previous);
    }
    return enabled;
}

function checkpoint() {
    const active = refresh();
    const signal = scope.getStore();
    if (!active || signal?.aborted) throw stoppedError();
    return signal || controller.signal;
}

async function run(callback) {
    const signal = checkpoint();
    return scope.run(signal, async () => {
        checkpoint();
        try {
            const result = await callback();
            checkpoint();
            return result;
        } catch (error) {
            checkpoint();
            throw error;
        }
    });
}

async function request(url, options) {
    const signal = checkpoint();
    return fetch(url, {
        ...options,
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
}

function stop() {
    readEnabled = () => false;
    refresh();
}

function abort() { controller.abort(stoppedError()); }
function currentEpoch() { refresh(); return epoch; }

module.exports = { configure, refresh, checkpoint, run, request, stop, abort, currentEpoch, stoppedError };
