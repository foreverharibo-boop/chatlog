const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const control = require('../server/runtime-control');
const sourcePath = path.resolve(__dirname, '../server/index.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const originalRequire = createRequire(sourcePath);
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, { disabled = false, jobs = [], runtimeState = {}, generateComment = async () => 'hello' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-test-'));
    const serverDir = path.join(root, 'plugins/chatlog');
    const userDir = path.join(root, 'data/default-user');
    for (const folder of [serverDir, path.join(userDir, 'extensions/chatlog'), path.join(root, 'public')]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(root, 'server.js'), '');
    fs.writeFileSync(path.join(userDir, 'extensions/chatlog/manifest.json'), JSON.stringify({ display_name: '챗로그', js: 'index.js' }));
    const setDisabled = flag => fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ extension_settings: { disabledExtensions: flag ? ['third-party/chatlog'] : [] } }));
    setDisabled(disabled);
    const room = { id: 'room_test', name: 'test', createdAt: Date.now(), members: [{ avatar: 'a.png', name: 'A' }], schedule: { activeFrom: 0, activeTo: 24, cutIntervalHours: 2, jitter: false }, nextSlotAt: Date.now() + 3600000 };
    const post = { id: 'post_test', author: 'user', createdAt: Date.now(), comments: [], reactions: [] };
    fs.writeFileSync(path.join(serverDir, 'data.json'), JSON.stringify({ rooms: { room_test: room }, posts: { room_test: [post] }, jobs, runtime: runtimeState }));
    const ai = { safeUserHandle: x => x || 'default-user', userDataDir: () => userDir, setDebugEnabled() {}, generateComment, repeatsExistingComment: () => false, violatesPresenceClaim: () => false };
    const timers = [];
    const sandbox = {
        require(name) {
            if (name === './ai') return ai;
            if (name === './paths') return { findSillyTavernRoot: () => root };
            return originalRequire(name);
        },
        module: { exports: {} }, __dirname: serverDir, process, Buffer, URL,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {},
    };
    const routes = {}, middleware = [];
    const router = { use: fn => middleware.push(fn), get: (p, fn) => { routes['GET ' + p] = fn; }, post: (p, fn) => { routes['POST ' + p] = fn; } };
    vm.runInNewContext(source + '\nthis.testing = { tick, executeJob, retryableJobError, getDb: () => db, flushDbSave };', sandbox, { filename: sourcePath });
    await sandbox.module.exports.init(router);
    await settle();
    t.after(() => { sandbox.module.exports.exit(); fs.rmSync(root, { recursive: true, force: true }); });
    return { ...sandbox.testing, setDisabled, root, userDir, routes, middleware, timers, ai };
}
const job = (id = 'job_test', runAt = Date.now() + 100000) => ({ id, type: 'comment', roomId: 'room_test', postId: 'post_test', charId: 'a.png', runAt });
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.value = value; return this; } }; }

test('disabled on startup discards persisted queue and keeps existing posts', async t => {
    let calls = 0;
    const f = await fixture(t, { disabled: true, jobs: [job()], generateComment: async () => { calls++; return 'hello'; } });
    assert.equal(f.getDb().jobs.length, 0);
    assert.equal(f.getDb().rooms.room_test.nextSlotAt, null);
    assert.equal(f.getDb().posts.room_test.length, 1);
    await f.tick();
    assert.equal((await f.executeJob(job())).status, 'cancelled');
    assert.equal(calls, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'plugins/chatlog/data.json')));
    assert.equal(saved.jobs.length, 0);
    assert.equal(saved.runtime.extensionEnabled, false);
});

test('enabled background jobs run with no browser heartbeat', async t => {
    let calls = 0;
    const f = await fixture(t, { jobs: [job()], generateComment: async () => { calls++; return 'hello'; } });
    assert.equal(f.getDb().jobs.length, 1);
    assert.equal((await f.executeJob(job())).status, 'commented');
    assert.equal(calls, 1);
    assert.equal(f.getDb().posts.room_test[0].comments.length, 1);
});

test('OFF then ON cancels in-flight results and resumes only future schedules', async t => {
    const waiting = deferred();
    const f = await fixture(t, { jobs: [job()], generateComment: () => waiting.promise });
    const running = f.executeJob(job());
    await settle();
    f.setDisabled(true); control.refresh();
    f.setDisabled(false); control.refresh();
    waiting.resolve('stale result');
    assert.equal((await running).status, 'cancelled');
    assert.equal(f.getDb().jobs.length, 0);
    assert.equal(f.getDb().posts.room_test[0].comments.length, 0);
    assert.ok(f.getDb().rooms.room_test.nextSlotAt > Date.now());
    assert.equal(f.getDb().runtime.lastErrorAt, null);
});

test('due batch stops after OFF/ON even when first operation finishes late', async t => {
    const waiting = deferred(); let calls = 0;
    const f = await fixture(t, { jobs: [job('job_one', 0), job('job_two', 0)], generateComment: () => { calls++; return waiting.promise; } });
    assert.equal(calls, 1);
    f.setDisabled(true); control.refresh();
    f.setDisabled(false); control.refresh();
    waiting.resolve('late');
    await settle(); await settle();
    assert.equal(calls, 1);
    assert.equal(f.getDb().posts.room_test[0].comments.length, 0);
    assert.equal(f.getDb().jobs.length, 0);
});

test('disabled middleware blocks queue and generation while allowing status/settings repair', async t => {
    const f = await fixture(t, { disabled: true });
    const gate = f.middleware.at(-1);
    for (const route of ['/force', '/force/now', '/jobs/requeue', '/jobs/claim', '/test/image', '/room/relationships/refresh', '/comment/push', '/cleanup']) {
        const res = response(); gate({ method: 'POST', path: route }, res, () => assert.fail(route)); assert.equal(res.statusCode, 409);
    }
    let passed = 0;
    gate({ method: 'GET', path: '/status' }, response(), () => passed++);
    gate({ method: 'POST', path: '/settings' }, response(), () => passed++);
    assert.equal(passed, 2);
});

test('404/410 do not requeue while transient 503 still retries', async t => {
    let message = 'vertex-express 404 (missing model)';
    const f = await fixture(t, { generateComment: async () => { throw new Error(message); } });
    for (const code of [404, 410]) {
        message = `vertex-express ${code} (missing model)`;
        await assert.rejects(f.executeJob(job()), new RegExp(String(code)));
        assert.equal(f.getDb().jobs.length, 0);
    }
    message = 'vertex-express 503 unavailable';
    assert.equal((await f.executeJob(job())).status, 'retrying');
    assert.equal(f.getDb().jobs.length, 1);
});

test('old browser claims cannot requeue or publish after OFF/ON', async t => {
    const f = await fixture(t, { jobs: [job()] });
    const claimed = response();
    f.routes['POST /jobs/claim']({ body: { type: 'comment' } }, claimed);
    const oldJob = claimed.value[0];
    assert.equal(typeof oldJob.runtimeEpoch, 'string');
    f.setDisabled(true); control.refresh(); f.setDisabled(false); control.refresh();
    const requeue = response(); f.routes['POST /jobs/requeue']({ body: { job: oldJob } }, requeue);
    assert.equal(requeue.statusCode, 409);
    const push = response(); f.routes['POST /comment/push']({ body: { ...oldJob, text: 'late', runtimeEpoch: oldJob.runtimeEpoch } }, push);
    assert.equal(push.statusCode, 409);
});

test('renamed extension is detected and absent/unreadable settings stop work', async t => {
    const f = await fixture(t);
    fs.renameSync(path.join(f.userDir, 'extensions/chatlog'), path.join(f.userDir, 'extensions/custom-log'));
    fs.writeFileSync(path.join(f.userDir, 'settings.json'), JSON.stringify({ extension_settings: { disabledExtensions: ['third-party/custom-log'] } }));
    assert.equal(control.refresh(), false);
    f.setDisabled(false); assert.equal(control.refresh(), true);
    fs.writeFileSync(path.join(f.userDir, 'settings.json'), '{'); assert.equal(control.refresh(), false);
    f.setDisabled(false); fs.rmSync(path.join(f.userDir, 'extensions/custom-log'), { recursive: true }); assert.equal(control.refresh(), false);
});

test('scoped network request aborts on OFF without altering unrelated fetch', async t => {
    let active = true; let observedSignal;
    const previous = global.fetch;
    t.after(() => { global.fetch = previous; });
    global.fetch = async (_url, options) => {
        observedSignal = options.signal;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    };
    control.configure({ readEnabled: () => active, onChange() {} });
    const running = control.run(() => control.request('https://example.invalid', {}));
    const rejected = assert.rejects(running, { code: 'CHATLOG_DISABLED' });
    assert.equal(observedSignal.aborted, false);
    active = false; control.refresh();
    await rejected;
    assert.equal(observedSignal.aborted, true);
});

test('scheduler catches unexpected errors instead of rejecting its timer promise', async t => {
    const f = await fixture(t);
    f.getDb().rooms.room_test = null;
    await assert.doesNotReject(f.tick());
});


test('forced batch also drops its remaining work across OFF/ON', async t => {
    const waiting = deferred(); let calls = 0;
    const f = await fixture(t, { jobs: [job('job_one'), job('job_two')], generateComment: () => { calls++; return waiting.promise; } });
    const res = response();
    const running = f.routes['POST /force']({ body: { what: 'comments' } }, res);
    await settle();
    assert.equal(calls, 1);
    f.setDisabled(true); control.refresh(); f.setDisabled(false); control.refresh();
    waiting.resolve('late'); await running;
    assert.equal(res.value.cancelled, true);
    assert.equal(res.value.comments, 0);
    assert.equal(calls, 1);
});

test('persisted OFF state resumes with empty queue after server restart', async t => {
    const f = await fixture(t, { jobs: [job()], runtimeState: { extensionEnabled: false } });
    assert.equal(f.getDb().jobs.length, 0);
    assert.ok(f.getDb().rooms.room_test.nextSlotAt > Date.now());
});

test('current browser claim can publish a comment normally', async t => {
    const f = await fixture(t, { jobs: [job()] });
    const claimed = response();
    f.routes['POST /jobs/claim']({ body: { type: 'comment' } }, claimed);
    const current = claimed.value[0];
    const push = response();
    f.routes['POST /comment/push']({ body: { ...current, text: 'hello', runtimeEpoch: current.runtimeEpoch } }, push);
    assert.equal(push.statusCode, 200);
    assert.equal(push.value.ok, true);
    assert.equal(f.getDb().posts.room_test[0].comments.length, 1);
});
