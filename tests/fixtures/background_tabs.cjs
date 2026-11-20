const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(process.argv[2], "utf8").replace(/\nconnectAll\(\);\s*$/, "");

function event() {
    const listeners = new Set();
    return {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        emit: value => listeners.forEach(fn => fn(value))
    };
}

function fixture() {
    const tab = { id: 17, windowId: 5, active: false, status: "complete", url: "https://game.test/" };
    const doc = { hidden: true };
    const calls = [];
    const chrome = {
        tabs: {
            onUpdated: event(), onRemoved: event(), onActivated: event(),
            get: async id => { assert.equal(id, tab.id); return { ...tab }; },
            create: async opts => { calls.push(["create", opts]); return tab; },
            update: async (id, opts) => { calls.push(["update", id, opts]); return tab; },
            captureVisibleTab: async () => "visible"
        },
        windows: {
            get: async () => ({ state: "normal" }),
            create: async opts => { calls.push(["window", opts]); return { tabs: [tab] }; }
        },
        debugger: {
            onDetach: event(),
            attach: async ({ tabId }) => { calls.push(["attach", tabId]); },
            sendCommand: async ({ tabId }, command, options) => {
                calls.push([command, tabId, options]);
                if (command === "Page.captureScreenshot") return { data: "target" };
                doc.hidden = false;
            },
            detach: async ({ tabId }) => { calls.push(["detach", tabId]); doc.hidden = true; }
        },
        scripting: {
            executeScript: async ({ target, func, args }) => {
                assert.equal(target.tabId, tab.id);
                const result = await func(...(args || []));
                return [{ result }];
            }
        },
        alarms: { create() {}, onAlarm: event() },
        runtime: { onStartup: event(), onInstalled: event() }
    };
    // 空闲连接用手动时钟，其余回调沿用真实异步语义。
    let idle;
    const ctx = vm.createContext({ chrome, document: doc, window: {}, requestAnimationFrame: setImmediate,
        setTimeout(fn, ms) { if (ms === 15000) { idle = fn; return fn; } return setTimeout(fn, ms); },
        clearTimeout(timer) { if (timer && timer === idle) idle = null; else clearTimeout(timer); }
    });
    vm.runInContext(source, ctx);
    const agent = { version: vm.runInContext("AGENT_VERSION", ctx), call: async method => {
        calls.push(["page", method]); return { ok: true, result: "done" };
    } };
    ctx.window.__egretInspectorMcp = agent;
    return { chrome, tab, doc, calls, agent, run: ctx.handleRequest, capture: ctx.captureTab, expire: () => idle() };
}

test("导航保留用户的活动页签和窗口布局", async () => {
    const { run, calls, tab } = fixture();
    const url = tab.url;
    await run("navigate", { url });
    await run("navigate", { url });
    await run("navigate", { url, newTab: true });
    await run("navigate", { url, newWindow: true, tabId: tab.id });
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["create", { url, active: false }], ["update", tab.id, { url }], ["create", { url, active: false }],
        ["window", { tabId: tab.id, type: "normal", focused: false }], ["update", tab.id, { url }]
    ]);
});

test("两个 MCP 连接各自复用自己的页签，加载期间也不改选其他游戏", async () => {
    const { run, chrome, tab } = fixture();
    const a = {}, b = {}, tabs = new Map();
    let nextId = tab.id;
    chrome.tabs.create = async opts => {
        const created = { ...tab, ...opts, id: nextId++ };
        tabs.set(created.id, created);
        return created;
    };
    chrome.tabs.get = async id => tabs.get(id);
    chrome.tabs.query = async () => [...tabs.values()];
    chrome.tabs.update = async (id, opts) => Object.assign(tabs.get(id), opts);
    const first = await run("navigate", { url: "https://game.test/a" }, a);
    const second = await run("navigate", { url: "https://game.test/b" }, b);
    assert.notEqual(first.tabId, second.tabId);
    assert.equal(tabs.get(first.tabId).url, "https://game.test/a");
    const listed = await run("listTabs", {}, a);
    assert.equal(listed.find(t => t.lastUsed).tabId, first.tabId);
    const page = await run("page", { frameId: 0, method: "status" }, a);
    assert.equal(page.tabId, first.tabId);
    assert.equal((await run("navigate", { url: "https://game.test/b2" }, b)).tabId, second.tabId);
    chrome.tabs.onRemoved.emit(first.tabId);
    assert.notEqual((await run("navigate", { url: "https://game.test/a2" }, a)).tabId, first.tabId);
});

test("并发后台操作共享连接，按目标截图，空闲后断开", async () => {
    const { run, capture, expire, doc, calls, tab } = fixture();
    const page = method => run("page", { tabId: tab.id, frameId: 0, method });
    await page("runtimeStats");
    assert.equal(doc.hidden, true);
    const [observe, act, image] = await Promise.all([page("observe"), page("act"), capture(tab, "png", 70)]);
    assert.equal(observe.result, "done");
    assert.equal(act.result, "done");
    assert.equal(image, "data:image/png;base64,target");
    assert.equal(calls.filter(x => x[0] === "attach").length, 1);
    await expire();
    assert.equal(doc.hidden, true);
    assert.deepEqual(calls.at(-1), ["detach", tab.id]);
});

test("截图途中切走再切回，丢弃按窗口截得的图", async () => {
    const { chrome, calls, doc, tab, capture } = fixture();
    doc.hidden = false;
    tab.active = true;
    assert.equal(await capture(tab, "jpeg", 55), "visible");
    assert.equal(calls.length, 0);
    chrome.tabs.captureVisibleTab = async () => {
        chrome.tabs.onActivated.emit({ windowId: tab.windowId, tabId: 99 });
        chrome.tabs.onActivated.emit({ windowId: tab.windowId, tabId: tab.id });
        return "other tab";
    };
    assert.equal(await capture(tab, "jpeg", 55), "data:image/jpeg;base64,target");
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),
        ["Page.captureScreenshot", tab.id, { format: "jpeg", quality: 55 }]);
});

test("调试失败时不切前台，成功恢复后不重放已执行的动作", async () => {
    const { chrome, calls, run, tab, agent } = fixture();
    const params = { tabId: tab.id, frameId: 0, method: "act" };
    const attach = chrome.debugger.attach;
    chrome.debugger.attach = async () => { throw new Error("debugger busy"); };
    await assert.rejects(run("page", params), /debugger busy/);
    assert.deepEqual(calls, []);
    chrome.debugger.attach = attach;
    let clicks = 0;
    agent.call = async () => { clicks++; return { ok: false, error: "页面在后台" }; };
    await assert.rejects(run("page", params), /页面在后台/);
    assert.equal(clicks, 1);
});
