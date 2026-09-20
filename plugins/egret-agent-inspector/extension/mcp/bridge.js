// Egret Agent Inspector MCP 桥接：运行在扩展 service worker 中，作为 WebSocket 客户端连接本机 MCP server，
// 把 MCP 工具请求转发到目标标签页（在页面 MAIN world 中执行 mcp/pageAgent.js）。
const AGENT_VERSION = "1.0.7";
const AGENT_FILE = "mcp/pageAgent.js";
const BASE_PORT = 17800;
const PORT_COUNT = 5;
const FAST_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;

const sockets = new Map();
const retryState = new Map();
const frameCache = new Map();
let lastTabId = null;

function log(...args) {
    console.debug("[Egret MCP]", ...args);
}

function scheduleConnect(port) {
    const state = retryState.get(port) || { fails: 0, timer: 0 };
    if (state.timer) return;
    // 默认端口快速重试，保证 agent 启动 MCP server 后能很快连上；备用端口退避到较长间隔以减少无效连接
    const maxDelay = port === BASE_PORT ? FAST_RETRY_DELAY : MAX_RETRY_DELAY;
    const delay = Math.min(maxDelay, 1000 * Math.pow(2, state.fails));
    state.timer = setTimeout(() => {
        state.timer = 0;
        connect(port);
    }, delay);
    retryState.set(port, state);
}

// 先用 HTTP 探测端口上是否是本 MCP server：失败的 fetch 不会像失败的 WebSocket 那样被记入扩展的错误列表
async function probeServer(port) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal, cache: "no-store" });
        const info = await res.json();
        return info && info.server === "egret-agent-inspector";
    } catch (e) {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function connect(port) {
    if (sockets.has(port)) return;
    sockets.set(port, null);
    if (!(await probeServer(port))) {
        sockets.delete(port);
        const state = retryState.get(port) || { fails: 0, timer: 0 };
        state.fails++;
        retryState.set(port, state);
        scheduleConnect(port);
        return;
    }
    let ws;
    try {
        ws = new WebSocket(`ws://127.0.0.1:${port}/egret-agent-inspector`);
    } catch (e) {
        sockets.delete(port);
        scheduleConnect(port);
        return;
    }
    sockets.set(port, ws);
    ws.onopen = () => {
        const state = retryState.get(port);
        if (state) state.fails = 0;
        log("connected to MCP server on port", port);
        ws.send(JSON.stringify({
            type: "hello",
            extensionVersion: chrome.runtime.getManifest().version,
            agentVersion: AGENT_VERSION,
            extensionId: chrome.runtime.id,
            browser: browserName(),
            userAgent: navigator.userAgent
        }));
    };
    ws.onmessage = (ev) => onServerMessage(ws, ev.data);
    ws.onclose = () => {
        sockets.delete(port);
        const state = retryState.get(port) || { fails: 0, timer: 0 };
        state.fails++;
        retryState.set(port, state);
        scheduleConnect(port);
    };
    ws.onerror = () => {};
}

function browserName() {
    const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand);
    return brands.find((b) => !/Not|Chromium/i.test(b)) || "Chromium";
}

function connectAll() {
    for (let i = 0; i < PORT_COUNT; i++) {
        const port = BASE_PORT + i;
        const state = retryState.get(port);
        if (state && state.timer) {
            clearTimeout(state.timer);
            state.timer = 0;
        }
        connect(port);
    }
}

async function onServerMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (e) {
        return;
    }
    if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
    }
    if (msg.id === undefined) return;
    let reply;
    try {
        reply = { id: msg.id, result: await handleRequest(msg.method, msg.params || {}) };
    } catch (e) {
        reply = { id: msg.id, error: e && e.message ? e.message : e && e.stack || String(e) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

function isScriptableUrl(url) {
    return /^(https?|file):/i.test(url || "");
}

async function probeFrames(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => {
            const el = document.querySelector(".egret-player");
            const eg = window.egret;
            return !!(el && el["egret-player"] || eg && eg.MainContext && eg.MainContext.instance && eg.MainContext.instance.stage || window.lark_stages && window.lark_stages.length);
        }
    });
    const hit = results.find((r) => r.result === true);
    return hit ? hit.frameId : null;
}

async function resolveTab(tabId) {
    if (tabId !== undefined && tabId !== null) {
        const tab = await chrome.tabs.get(+tabId);
        lastTabId = tab.id;
        return tab;
    }
    const candidates = [];
    if (lastTabId !== null) {
        try {
            candidates.push(await chrome.tabs.get(lastTabId));
        } catch (e) {
            lastTabId = null;
        }
    }
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const all = await chrome.tabs.query({});
    for (const t of active.concat(all)) {
        if (!candidates.some((c) => c.id === t.id)) candidates.push(t);
    }
    for (const t of candidates) {
        if (!isScriptableUrl(t.url)) continue;
        try {
            const frameId = await probeFrames(t.id);
            if (frameId !== null) {
                frameCache.set(t.id, frameId);
                lastTabId = t.id;
                return t;
            }
        } catch (e) {}
    }
    const fallback = active[0] || candidates[0];
    if (!fallback) throw new Error("没有可用的浏览器标签页");
    return fallback;
}

async function resolveFrame(tabId, frameId) {
    if (frameId !== undefined && frameId !== null) return +frameId;
    if (frameCache.has(tabId)) return frameCache.get(tabId);
    const found = await probeFrames(tabId);
    if (found === null) return 0;
    frameCache.set(tabId, found);
    return found;
}

async function runInPage(tabId, frameId, method, params) {
    const target = { tabId, frameIds: [frameId] };
    const exec = async () => {
        const [res] = await chrome.scripting.executeScript({
            target,
            world: "MAIN",
            func: (m, p, v) => {
                const agent = window.__egretInspectorMcp;
                if (!agent || agent.version !== v) return { needInject: true };
                return agent.call(m, p);
            },
            args: [method, params, AGENT_VERSION]
        });
        return res && res.result;
    };
    let result = await exec();
    if (result && result.needInject) {
        await chrome.scripting.executeScript({ target, world: "MAIN", files: [AGENT_FILE] });
        result = await exec();
    }
    if (!result) throw new Error("页面脚本没有返回结果（页面可能正在跳转）");
    if (!result.ok) throw new Error(result.error || "页面返回了异常结果：" + JSON.stringify(result).slice(0, 300));
    return result.result;
}

function waitTabComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        };
        const listener = (id, info) => {
            if (id === tabId && info.status === "complete") done();
        };
        const timer = setTimeout(done, timeoutMs);
        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function handleRequest(method, params) {
    switch (method) {
        case "listTabs": {
            const tabs = await chrome.tabs.query({});
            const out = [];
            for (const t of tabs) {
                const item = { tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url };
                if (params.probe && isScriptableUrl(t.url)) {
                    try {
                        item.egret = (await probeFrames(t.id)) !== null;
                    } catch (e) {
                        item.egret = false;
                    }
                }
                item.lastUsed = t.id === lastTabId;
                out.push(item);
            }
            return out;
        }
        case "navigate": {
            let tab;
            if (params.newTab) {
                tab = await chrome.tabs.create({ url: params.url, active: true });
            } else {
                const target = params.tabId !== undefined && params.tabId !== null ? await chrome.tabs.get(+params.tabId) :
                    lastTabId !== null ? await chrome.tabs.get(lastTabId).catch(() => null) : null;
                const t = target || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
                tab = t ? await chrome.tabs.update(t.id, { url: params.url, active: true }) : await chrome.tabs.create({ url: params.url });
            }
            frameCache.delete(tab.id);
            lastTabId = tab.id;
            await waitTabComplete(tab.id, params.timeoutMs || 30000);
            const t = await chrome.tabs.get(tab.id);
            return { tabId: t.id, url: t.url, title: t.title, status: t.status };
        }
        case "screenshot": {
            const tab = await resolveTab(params.tabId);
            if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
            // 窗口不在前台时合成器可能不更新，截到的是旧帧；如实告知，不要让断言依赖截图
            const warnings = [];
            try {
                const win = await chrome.windows.get(tab.windowId);
                if (!win.focused) warnings.push("浏览器窗口不在前台，截图可能是过期画面；请以显示列表（find / get_tree）为准");
                if (win.state === "minimized") warnings.push("浏览器窗口已最小化，截图不可用");
            } catch (e) { /* 窗口信息拿不到就不加警告 */ }
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: params.format === "jpeg" ? "jpeg" : "png", quality: 80 });
            const comma = dataUrl.indexOf(",");
            return {
                tabId: tab.id,
                mimeType: dataUrl.slice(5, dataUrl.indexOf(";")),
                data: dataUrl.slice(comma + 1),
                warnings
            };
        }
        case "page": {
            const tab = await resolveTab(params.tabId);
            if (!isScriptableUrl(tab.url)) throw new Error(`标签页 ${tab.id} 的地址无法注入脚本：${tab.url}`);
            let frameId = await resolveFrame(tab.id, params.frameId);
            try {
                const result = await runInPage(tab.id, frameId, params.method, params.params || {});
                return { tabId: tab.id, frameId, result };
            } catch (e) {
                // 页面刷新或 iframe 变化后帧缓存可能失效，重新探测后再试一次
                if (params.frameId === undefined && frameCache.has(tab.id) && /frame|No tab/i.test(String(e && e.message))) {
                    frameCache.delete(tab.id);
                    frameId = await resolveFrame(tab.id);
                    const result = await runInPage(tab.id, frameId, params.method, params.params || {});
                    return { tabId: tab.id, frameId, result };
                }
                throw e;
            }
        }
        case "reloadExtension": {
            // 未打包扩展会从磁盘重新读取文件，用于插件更新后生效
            setTimeout(() => chrome.runtime.reload(), 300);
            return { reloading: true, extensionVersion: chrome.runtime.getManifest().version };
        }
        default:
            throw new Error("未知的桥接方法：" + method);
    }
}

chrome.tabs.onRemoved.addListener((tabId) => {
    frameCache.delete(tabId);
    if (lastTabId === tabId) lastTabId = null;
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "loading") frameCache.delete(tabId);
});

// service worker 可能被挂起：用 alarm 定期唤醒并补连，连接建立后由 server 的心跳保持存活
chrome.alarms.create("egret-mcp-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "egret-mcp-reconnect") connectAll();
});
chrome.runtime.onStartup.addListener(connectAll);
chrome.runtime.onInstalled.addListener(connectAll);
connectAll();
