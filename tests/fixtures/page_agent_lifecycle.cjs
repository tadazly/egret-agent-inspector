const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const originalSource = fs.readFileSync(process.argv[2], 'utf8');
const mode = process.argv[3];
const seam = '\n    installErrorHooks();';
assert.ok(originalSource.includes(seam));
const source = originalSource.replace(seam,
    '\n    window.__lifecycleTest = { walk, cacheObject, hashCache, findBindKey, lastEntries, pendingSleeps, sleep, getBindCache: function () { return bindCache; } };' + seam);

function environment(weak = true) {
    const listeners = new Map();
    const nativeCalls = [];
    const nativeWarn = (...args) => nativeCalls.push(['warn', args]);
    const nativeError = (...args) => nativeCalls.push(['error', args]);
    const stage = { hashCode: 1, children: [], visible: true, alpha: 1,
        get numChildren() { return this.children.length; },
        getChildAt(i) { return this.children[i]; } };
    stage.stage = stage;
    const window = {
        egret: { getQualifiedClassName(value) { return value.constructor?.name || 'Object'; } },
        addEventListener(type, listener, capture = false) {
            if (!listeners.has(type)) listeners.set(type, []);
            const list = listeners.get(type);
            if (!list.some(x => x.listener === listener && x.capture === capture)) list.push({ listener, capture });
        },
        removeEventListener(type, listener, capture = false) {
            const list = listeners.get(type) || [];
            const index = list.findIndex(x => x.listener === listener && x.capture === capture);
            if (index >= 0) list.splice(index, 1);
        }
    };
    const context = vm.createContext({ window, console: { warn: nativeWarn, error: nativeError },
        document: { visibilityState: 'visible', querySelector(selector) {
            return selector === '.egret-player' ? { 'egret-player': { stage } } : null;
        } },
        location: { href: 'https://game.example.test/' },
        performance: { now: () => 1000 }, setTimeout, clearTimeout,
        WeakRef: weak ? WeakRef : undefined });
    const env = { context, window, stage, listeners, nativeCalls, nativeWarn, nativeError,
        inject(version) {
            vm.runInContext(version ? source.replace(/var VERSION = "[^"]+"/, `var VERSION = "${version}"`) : source, context);
            return window.__egretInspectorMcp;
        },
        count(type) { return (listeners.get(type) || []).length; },
        emit(type, event) { for (const x of [...(listeners.get(type) || [])]) x.listener(event); }
    };
    return env;
}

async function lifecycle() {
    const env = environment(false);
    const first = env.inject();
    const test = env.window.__lifecycleTest;
    const child = { hashCode: 2, stage: env.stage, numChildren: 0 };
    env.stage.child = child;
    env.stage.children = [child];
    test.walk(env.stage, () => {});
    test.findBindKey(env.stage, child);
    test.lastEntries.push({ _o: child });
    assert.equal(test.hashCache.size, 2);
    const bindings = test.getBindCache();
    assert.equal(bindings.size, 1);
    const pending = test.sleep(60000).then(() => 'resolved', error => error.message);
    assert.equal(test.pendingSleeps.size, 1);
    assert.strictEqual(env.inject(), first);
    assert.equal(env.count('error'), 1);
    const next = env.inject('9.0.1');
    assert.equal(first.disposed, true);
    assert.equal(test.hashCache.size, 0);
    assert.equal(test.lastEntries.length, 0);
    assert.equal(bindings.size, 0);
    assert.equal(test.pendingSleeps.size, 0);
    assert.match(await pending, /已卸载/);
    assert.equal((await first.call('status', {})).ok, false);
    test.cacheObject(child, 2);
    test.walk(env.stage, () => {});
    assert.equal(test.hashCache.size, 0);
    assert.equal(env.count('error'), 1);
    assert.equal(env.count('unhandledrejection'), 1);
    const stats = await next.call('runtimeStats', {});
    assert.equal(stats.result.agentLifecycle.requiresReload, false);
    assert.equal(stats.result.agentLifecycle.previousDisposal.clearedCacheEntries, 2);
    assert.equal(stats.result.agentLifecycle.previousDisposal.cancelledSleeps, 1);
    const receipt = next.dispose();
    assert.equal(receipt.errorHooks.removedListeners, 2);
    assert.equal(env.count('error'), 0);
    assert.equal(env.count('unhandledrejection'), 0);
    assert.strictEqual(env.context.console.warn, env.nativeWarn);
    assert.strictEqual(env.context.console.error, env.nativeError);
    assert.equal(next.dispose().alreadyDisposed, true);
    const latest = env.inject();
    assert.equal(latest.requiresReload, false);
    latest.dispose();
    return { passed: true };
}

async function errors() {
    const env = environment();
    env.inject();
    for (let i = 0; i < 12; i++) env.inject(`9.1.${i}`);
    assert.equal(env.count('error'), 1);
    assert.equal(env.count('unhandledrejection'), 1);
    env.context.console.warn('one warning');
    env.emit('error', { target: env.window, message: 'one error' });
    env.emit('unhandledrejection', { reason: { message: 'one rejection' } });
    env.emit('error', { target: { src: 'missing.png' } });
    assert.equal(env.window.__egretInspectorErrors.length, 4);
    assert.equal(env.window.__egretInspectorErrors[0].count, 1);
    assert.equal(env.nativeCalls.length, 1);
    for (let i = 0; i < 240; i++) env.context.console.error(`failure ${i}`);
    assert.equal(env.window.__egretInspectorErrors.length, 200);
    env.context.console.warn('repeat');
    env.context.console.warn('repeat');
    assert.equal(env.window.__egretInspectorErrors.at(-1).count, 2);
    const circular = { value: 'safe' }; circular.self = circular;
    env.context.console.warn(circular);
    assert.match(env.window.__egretInspectorErrors.at(-1).message, /Circular/);
    const wrapper = env.context.console.warn;
    const outer = (...args) => wrapper(...args);
    env.context.console.warn = outer;
    env.window.__egretInspectorMcp.dispose();
    assert.strictEqual(env.context.console.warn, outer);
    const before = env.window.__egretInspectorErrors.length;
    outer('after dispose');
    env.emit('error', { message: 'after dispose' });
    assert.equal(env.window.__egretInspectorErrors.length, before);
    return { passed: true };
}

async function legacy() {
    const env = environment();
    const oldWarn = env.context.console.warn;
    const legacyError = () => {};
    env.window.addEventListener('error', legacyError, true);
    env.window.__egretInspectorErrorHooks = 123;
    env.window.__egretInspectorMcp = { version: '1.7.67', call() {} };
    const api = env.inject();
    assert.equal(api.requiresReload, true);
    assert.strictEqual(env.context.console.warn, oldWarn);
    assert.equal(env.count('error'), 1);
    assert.equal(env.count('unhandledrejection'), 0);
    assert.equal((await api.call('runtimeStats', {})).result.agentLifecycle.errorHooks.managed, false);
    api.dispose();
    assert.equal(env.count('error'), 1);
    assert.equal(env.window.__egretInspectorErrorHooks, 123);
    assert.equal(env.inject('9.2.1').requiresReload, true);
    return { passed: true };
}

async function gc() {
    const env = environment(false);
    env.inject();
    const savedWarn = env.context.console.warn;
    const savedErrorHandler = env.listeners.get('error')[0].listener;
    const refs = [];
    for (let i = 0; i < 200; i++) {
        let node = { hashCode: i + 2, stage: env.stage, numChildren: 0, payload: new Uint8Array(65536) };
        refs.push(new WeakRef(node));
        env.stage.children = [node];
        env.window.__lifecycleTest.walk(env.stage, () => {});
        node.stage = null;
        env.stage.children = [];
        node = null;
    }
    // 保留退役钩子模拟第三方日志包装，卸载不应再依赖其被 GC。
    // 即使入口丢失而未调用代理 dispose，轻量错误钩子也不能持有旧代理缓存。
    if (mode === 'hook_gc') delete env.window.__egretInspectorMcp;
    env.inject('9.3.1');
    delete env.window.__lifecycleTest;
    for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
    }
    const alive = refs.reduce((n, ref) => n + (ref.deref() ? 1 : 0), 0);
    assert.equal(typeof savedWarn, 'function');
    assert.equal(typeof savedErrorHandler, 'function');
    assert.equal(alive, 0);
    env.window.__egretInspectorMcp.dispose();
    return { passed: true, survivingRemovedObjects: alive };
}

({ lifecycle, errors, legacy, gc, hook_gc: gc }[mode] || (() => { throw new Error('未知场景'); }))()
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
