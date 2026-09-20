// Egret Agent Inspector MCP 页面代理：由扩展通过 chrome.scripting.executeScript 注入到页面 MAIN world，
// 为 MCP 工具提供显示对象查询、点击、等待等能力。所有返回值均为可 JSON 序列化的普通对象。
(function () {
    var VERSION = "1.0.7";
    if (window.__egretInspectorMcp && window.__egretInspectorMcp.version === VERSION) return;

    var BIND_IGNORE = { parent: 1, stage: 1, skin: 1, hostComponent: 1, owner: 1, root: 1 };
    var TOUCH_ID = 1001;
    var hashCache = new Map();
    var bindCache = null;
    var bindCacheTime = 0;

    function egretNs() {
        return window.egret;
    }

    function getPlayer() {
        var el = document.querySelector(".egret-player");
        return el && el["egret-player"] || null;
    }

    function getStage() {
        var player = getPlayer();
        if (player && player.stage) return player.stage;
        var eg = egretNs();
        if (eg && eg.MainContext && eg.MainContext.instance && eg.MainContext.instance.stage) return eg.MainContext.instance.stage;
        if (window.lark_stages && window.lark_stages.length) return window.lark_stages[0];
        return null;
    }

    function requireStage() {
        var stage = getStage();
        if (!stage) throw new Error("页面中未找到 Egret stage（游戏尚未加载，或不是 Egret 页面）");
        return stage;
    }

    function getCanvas() {
        var player = getPlayer();
        if (player && player.canvas) return player.canvas;
        return document.querySelector(".egret-player canvas") || document.querySelector("canvas");
    }

    function className(o) {
        var eg = egretNs();
        try {
            if (eg && eg.getQualifiedClassName) return eg.getQualifiedClassName(o);
        } catch (e) {}
        return o && o.constructor && o.constructor.name || typeof o;
    }

    function hashOf(o) {
        return o && o.hashCode !== undefined ? o.hashCode : o && o.$hashCode;
    }

    function numChildren(o) {
        try {
            return typeof o.numChildren === "number" ? o.numChildren : 0;
        } catch (e) {
            return 0;
        }
    }

    function childAt(o, i) {
        try {
            return o.getChildAt(i);
        } catch (e) {
            return null;
        }
    }

    function findBindKey(host, target) {
        var now = Date.now();
        if (!bindCache || now - bindCacheTime > 1000) {
            bindCache = new Map();
            bindCacheTime = now;
        }
        var map = bindCache.get(host);
        if (!map) {
            map = new Map();
            var keys = Object.keys(host);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var c = k.charAt(0);
                if (c === "$" || c === "_" || BIND_IGNORE[k]) continue;
                var v;
                try {
                    v = host[k];
                } catch (e) {
                    continue;
                }
                if (v && typeof v === "object" && !map.has(v)) map.set(v, k);
            }
            bindCache.set(host, map);
        }
        return map.get(target) || null;
    }

    // 找到持有该对象引用的最近宿主及其属性名（宿主为某个父级或其 skin）
    function bindInfo(o) {
        var p = o.parent;
        for (var depth = 0; p && depth < 12; depth++) {
            var key = findBindKey(p, o);
            if (key) return { host: p, key: key };
            var skin = null;
            try {
                skin = p.skin;
            } catch (e) {}
            if (skin && typeof skin === "object" && skin !== p) {
                key = findBindKey(skin, o);
                if (key) return { host: p, key: key };
            }
            p = p.parent;
        }
        return null;
    }

    // 与面板中“显示id”一致：优先对象自身 id，否则取持有该对象引用的最近宿主上的属性名
    function bindId(o) {
        try {
            if (typeof o.id === "string" && o.id) return o.id;
        } catch (e) {}
        var info = bindInfo(o);
        return info ? info.key : null;
    }

    function shortClass(o) {
        var c = className(o) || "";
        var i = c.lastIndexOf(".");
        return i >= 0 ? c.slice(i + 1) : c;
    }

    // QA 定位标识：优先对象自身的 qaName（部分项目在 debug 构建中写入），
    // 否则按同样的「宿主短类名__部件名」规则推导，使正式构建也能得到稳定标识
    function qaNameOf(o) {
        try {
            if (typeof o.qaName === "string" && o.qaName) return o.qaName;
        } catch (e) {}
        var info = bindInfo(o);
        return info ? shortClass(info.host) + "__" + info.key : null;
    }

    // ---- 运行期错误收集：让 agent 能发现操作过程中出现的异常、资源缺失和报错日志 ----
    // 缓冲区挂在 window 上，页面代理重新注入后仍然保留；只记录注入之后发生的错误
    var ERROR_LIMIT = 200;

    function errorBuffer() {
        if (!window.__egretInspectorErrors) window.__egretInspectorErrors = [];
        return window.__egretInspectorErrors;
    }

    function pushError(type, message, stack) {
        var buf = errorBuffer();
        var text = String(message === undefined || message === null ? "" : message).slice(0, 500);
        var last = buf[buf.length - 1];
        if (last && last.type === type && last.message === text) {
            last.count++;
            last.lastAt = Date.now();
            return;
        }
        buf.push({ type: type, message: text, at: Date.now(), lastAt: Date.now(), count: 1,
            stack: stack ? String(stack).slice(0, 800) : null });
        while (buf.length > ERROR_LIMIT) buf.shift();
    }

    function formatArg(v) {
        if (v instanceof Error) return v.message;
        if (v === null || v === undefined || typeof v !== "object") return String(v);
        try {
            return JSON.stringify(serialize(v, 1)).slice(0, 200);
        } catch (e) {
            return Object.prototype.toString.call(v);
        }
    }

    function installErrorHooks() {
        if (window.__egretInspectorErrorHooks) return;
        window.__egretInspectorErrorHooks = Date.now();
        window.addEventListener("error", function (e) {
            var t = e && e.target;
            if (t && t !== window && (t.src || t.href)) pushError("resource", "资源加载失败：" + (t.src || t.href));
            else pushError("error", e && e.message || "未捕获异常", e && e.error && e.error.stack);
        }, true);
        window.addEventListener("unhandledrejection", function (e) {
            var r = e && e.reason;
            pushError("unhandledrejection", r && r.message || r, r && r.stack);
        });
        ["error", "warn"].forEach(function (level) {
            var orig = console[level];
            if (typeof orig !== "function") return;
            console[level] = function () {
                try {
                    pushError("console." + level, Array.prototype.map.call(arguments, formatArg).join(" "));
                } catch (e) {}
                return orig.apply(console, arguments);
            };
        });
    }

    function textOf(o) {
        var t = null;
        try {
            if (typeof o.text === "string") t = o.text;
            else if (typeof o.label === "string") t = o.label;
        } catch (e) {}
        if (t && t.length > 200) t = t.slice(0, 200) + "…";
        return t;
    }

    // eui.Image 等组件的资源名，便于定位没有绑定 id 的图片按钮
    function sourceOf(o) {
        var s;
        try {
            s = o.source;
        } catch (e) {
            return null;
        }
        return typeof s === "string" && s ? s : null;
    }

    function visualAlpha(o) {
        var stage = getStage();
        var alpha = 1;
        // 读取 stage.alpha/visible 会让 Egret 打出 Warning #1009，遍历到舞台就停下
        for (var cur = o; cur && cur !== stage; cur = cur.parent) alpha *= cur.alpha;
        return round(alpha * 100);
    }

    function effectiveVisible(o) {
        var stage = getStage();
        var cur = o;
        while (cur) {
            if (cur === stage) return true;
            if (!cur.visible || cur.alpha === 0) return false;
            cur = cur.parent;
        }
        return false;
    }

    function effectiveTouchable(o) {
        if (!o.touchEnabled) return false;
        var p = o.parent;
        while (p) {
            if (p.touchChildren === false) return false;
            p = p.parent;
        }
        return true;
    }

    function round(n) {
        return Math.round(n * 10) / 10;
    }

    // Egret 舞台坐标 → 页面视口（CSS 像素）坐标，与 WebTouchHandler.getLocation 互逆
    function stageToClient(x, y) {
        var canvas = getCanvas();
        var stage = getStage();
        if (!canvas || !stage) return null;
        var rect = canvas.getBoundingClientRect();
        var player = getPlayer();
        var wth = player && player.webTouchHandler;
        var docEl = document.documentElement;
        var ox, oy;
        if (wth && wth.scaleX) {
            var sx = x * wth.scaleX;
            var sy = y * wth.scaleY;
            if (wth.rotation == 90) {
                ox = rect.width - sy;
                oy = sx;
            } else if (wth.rotation == -90) {
                ox = sy;
                oy = rect.height - sx;
            } else {
                ox = sx;
                oy = sy;
            }
        } else {
            ox = x * rect.width / stage.stageWidth;
            oy = y * rect.height / stage.stageHeight;
        }
        return { x: round(rect.left - docEl.clientLeft + ox), y: round(rect.top - docEl.clientTop + oy) };
    }

    function clientToStage(cx, cy) {
        var canvas = getCanvas();
        var stage = getStage();
        if (!canvas || !stage) return null;
        var rect = canvas.getBoundingClientRect();
        var player = getPlayer();
        var wth = player && player.webTouchHandler;
        var docEl = document.documentElement;
        var ox = cx - (rect.left - docEl.clientLeft);
        var oy = cy - (rect.top - docEl.clientTop);
        if (wth && wth.scaleX) {
            var sx = ox, sy = oy;
            if (wth.rotation == 90) {
                sx = oy;
                sy = rect.width - ox;
            } else if (wth.rotation == -90) {
                sx = rect.height - oy;
                sy = ox;
            }
            return { x: round(sx / wth.scaleX), y: round(sy / wth.scaleY) };
        }
        return { x: round(ox * stage.stageWidth / rect.width), y: round(oy * stage.stageHeight / rect.height) };
    }

    function stageRect(o) {
        var stage = getStage();
        try {
            var r = o.getTransformedBounds(stage);
            return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
        } catch (e) {
            return null;
        }
    }

    function screenRect(sr) {
        if (!sr) return null;
        var a = stageToClient(sr.x, sr.y);
        var b = stageToClient(sr.x + sr.width, sr.y + sr.height);
        if (!a || !b) return null;
        var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        return {
            x: round(x),
            y: round(y),
            width: round(Math.abs(b.x - a.x)),
            height: round(Math.abs(b.y - a.y)),
            centerX: round(x + Math.abs(b.x - a.x) / 2),
            centerY: round(y + Math.abs(b.y - a.y) / 2)
        };
    }

    function pathOf(o) {
        var parts = [];
        var stage = getStage();
        var cur = o;
        while (cur && cur !== stage) {
            parts.push(bindId(cur) || cur.name || className(cur).split(".").pop());
            cur = cur.parent;
        }
        return parts.reverse().join("/");
    }

    function describe(o, opts) {
        opts = opts || {};
        var info = {
            hash: hashOf(o),
            className: className(o),
            id: bindId(o),
            name: o.name || null
        };
        var qa = qaNameOf(o);
        if (qa) info.qaName = qa;
        var t = textOf(o);
        if (t !== null) info.text = t;
        var src = sourceOf(o);
        if (src) info.source = src;
        info.visible = !!o.visible;
        info.onStageVisible = effectiveVisible(o);
        info.touchable = effectiveTouchable(o);
        info.childCount = numChildren(o);
        if (opts.bounds !== false) {
            var sr = stageRect(o);
            info.stageRect = sr;
            info.screenRect = screenRect(sr);
        }
        if (opts.path) info.path = pathOf(o);
        return info;
    }

    function walk(root, fn) {
        var stack = [root];
        while (stack.length) {
            var o = stack.pop();
            if (!o) continue;
            var h = hashOf(o);
            if (h !== undefined) hashCache.set(String(h), o);
            if (fn(o) === false) continue;
            for (var i = numChildren(o) - 1; i >= 0; i--) stack.push(childAt(o, i));
        }
    }

    function byHash(hash) {
        var stage = requireStage();
        var key = String(hash);
        var cached = hashCache.get(key);
        if (cached && (cached === stage || cached.stage)) return cached;
        var found = null;
        walk(stage, function (o) {
            if (found) return false;
            if (String(hashOf(o)) === key) found = o;
        });
        if (!found) throw new Error("未找到 hash 为 " + hash + " 的显示对象（可能已从舞台移除）");
        return found;
    }

    function makeMatcher(value, mode) {
        if (value === undefined || value === null || value === "") return null;
        if (mode === "regex") {
            var re = new RegExp(value, "i");
            return function (s) {
                return s != null && re.test(String(s));
            };
        }
        var v = String(value);
        if (mode === "exact") return function (s) {
            return s != null && String(s) === v;
        };
        var lv = v.toLowerCase();
        return function (s) {
            return s != null && String(s).toLowerCase().indexOf(lv) >= 0;
        };
    }

    function hasCriteria(p) {
        return ["hash", "id", "name", "className", "text", "source", "qaName"].some(function (k) {
            return p[k] !== undefined && p[k] !== null && p[k] !== "";
        });
    }

    function query(p) {
        var stage = requireStage();
        var mode = p.match || "contains";
        var mId = makeMatcher(p.id, mode);
        var mName = makeMatcher(p.name, mode);
        var mClass = makeMatcher(p.className, mode);
        var mText = makeMatcher(p.text, mode);
        var mSource = makeMatcher(p.source, mode);
        var mQa = makeMatcher(p.qaName, mode);
        var visibleOnly = p.visibleOnly !== false;
        var root = p.rootHash !== undefined && p.rootHash !== null ? byHash(p.rootHash) : stage;
        var results = [];
        walk(root, function (o) {
            if (visibleOnly && o !== stage && (!o.visible || o.alpha === 0)) return false;
            if (p.hash !== undefined && p.hash !== null && String(hashOf(o)) !== String(p.hash)) return;
            if (mName && !mName(o.name)) return;
            if (mClass && !mClass(className(o))) return;
            if (mText && !mText(textOf(o))) return;
            if (mSource && !mSource(sourceOf(o))) return;
            if (mId && !mId(bindId(o))) return;
            if (mQa && !mQa(qaNameOf(o))) return;
            if (p.touchableOnly && !effectiveTouchable(o)) return;
            if (visibleOnly && !effectiveVisible(o)) return;
            results.push(o);
        });
        return results;
    }

    function resolveTarget(p) {
        if (p.hash !== undefined && p.hash !== null) return byHash(p.hash);
        if (!hasCriteria(p)) return null;
        var list = query(p);
        if (!list.length) throw new Error("没有找到匹配的显示对象：" + JSON.stringify(pick(p, ["id", "name", "className", "text", "source", "qaName"])));
        var index = p.index || 0;
        if (index >= list.length) throw new Error("匹配到 " + list.length + " 个对象，index " + index + " 越界");
        return list[index];
    }

    function pick(o, keys) {
        var r = {};
        keys.forEach(function (k) {
            if (o[k] !== undefined) r[k] = o[k];
        });
        return r;
    }

    function serialize(v, depth, seen) {
        if (v === null || v === undefined) return v === undefined ? null : v;
        var t = typeof v;
        if (t === "number") return isFinite(v) ? v : String(v);
        if (t === "string" || t === "boolean") return v;
        if (t === "function") return "[function " + (v.name || "anonymous") + "]";
        if (t !== "object") return String(v);
        if (hashOf(v) !== undefined && (typeof v.numChildren === "number" || v.parent !== undefined) && depth < 3) {
            return { $displayObject: className(v), hash: hashOf(v), id: bindId(v), name: v.name || null };
        }
        seen = seen || [];
        if (seen.indexOf(v) >= 0) return "[circular]";
        if (depth <= 0) return "[" + className(v) + "]";
        seen.push(v);
        var out;
        if (Array.isArray(v)) {
            out = v.slice(0, 50).map(function (x) {
                return serialize(x, depth - 1, seen);
            });
            if (v.length > 50) out.push("… " + (v.length - 50) + " more");
        } else {
            out = {};
            var keys = Object.keys(v).slice(0, 60);
            keys.forEach(function (k) {
                var x;
                try {
                    x = v[k];
                } catch (e) {
                    x = "[getter error]";
                }
                if (typeof x !== "function") out[k] = serialize(x, depth - 1, seen);
            });
            var cn = className(v);
            if (cn && cn !== "Object") out.$class = cn;
        }
        seen.pop();
        return out;
    }

    var DEFAULT_PROPS = ["x", "y", "width", "height", "scaleX", "scaleY", "rotation", "anchorOffsetX", "anchorOffsetY", "alpha", "visible",
        "touchEnabled", "touchChildren", "enabled", "selected", "currentState", "skinName", "text", "label", "source", "textColor", "size"];

    // 读取对象属性；withDefaults 为真时附带 DEFAULT_PROPS，显式指定的键展开得更深
    function readProps(o, keys, withDefaults) {
        var props = {};
        (withDefaults ? DEFAULT_PROPS.concat(keys) : keys).forEach(function (k) {
            var v;
            try {
                v = o[k];
            } catch (e) {
                return;
            }
            if (v === undefined || typeof v === "function") return;
            props[k] = serialize(v, keys.indexOf(k) >= 0 ? 2 : 1);
        });
        return props;
    }

    function sleep(ms) {
        return new Promise(function (r) {
            setTimeout(r, ms);
        });
    }

    function stagePointOf(p, target) {
        if (p.stageX !== undefined && p.stageY !== undefined) return { x: +p.stageX, y: +p.stageY };
        if (p.clientX !== undefined && p.clientY !== undefined) return clientToStage(+p.clientX, +p.clientY);
        if (target) {
            var r = stageRect(target);
            if (!r) throw new Error("无法计算目标对象的边界");
            var ox = p.offsetX !== undefined ? +p.offsetX : r.width / 2;
            var oy = p.offsetY !== undefined ? +p.offsetY : r.height / 2;
            return { x: round(r.x + ox), y: round(r.y + oy) };
        }
        throw new Error("需要提供 hash/查询条件，或 stageX/stageY，或 clientX/clientY");
    }

    function touchHandler() {
        var player = getPlayer();
        var h = player && player.webTouchHandler && player.webTouchHandler.touch;
        if (h && typeof h.onTouchBegin === "function") return h;
        var stage = getStage();
        return stage && stage.$touchHandler || null;
    }

    function hitTest(x, y) {
        var th = touchHandler();
        try {
            if (th && th.findTarget) return th.findTarget(x, y);
        } catch (e) {}
        var stage = getStage();
        try {
            if (stage.$hitTest) return stage.$hitTest(x, y) || stage;
        } catch (e) {}
        return null;
    }

    function isSelfOrAncestor(ancestor, o) {
        while (o) {
            if (o === ancestor) return true;
            o = o.parent;
        }
        return false;
    }

    function domMouse(type, cx, cy, buttons) {
        var canvas = getCanvas();
        canvas.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: buttons
        }));
    }

    function domTouch(type, cx, cy) {
        var canvas = getCanvas();
        var touch = new Touch({ identifier: TOUCH_ID, target: canvas, clientX: cx, clientY: cy, pageX: cx + window.pageXOffset, pageY: cy + window.pageYOffset });
        var list = type === "touchend" ? [] : [touch];
        canvas.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [touch] }));
    }

    function dispatchEgretTouch(target, type, x, y, down) {
        var eg = egretNs();
        var TE = eg.TouchEvent;
        if (TE.dispatchTouchEvent) return TE.dispatchTouchEvent(target, TE[type], true, true, x, y, TOUCH_ID, down);
        return target.dispatchEvent(new TE(TE[type], true, true, x, y, TOUCH_ID));
    }

    // 按 method 执行一次按下-(移动)-抬起；points 为舞台坐标序列
    async function performGesture(points, method, holdMs, target) {
        var first = points[0], last = points[points.length - 1];
        var stepDelay = points.length > 2 ? holdMs / (points.length - 1) : holdMs;
        if (method === "touch") {
            var th = touchHandler();
            if (!th) throw new Error("未找到 Egret TouchHandler，请改用 method=dom");
            th.onTouchBegin(first.x, first.y, TOUCH_ID);
            for (var i = 1; i < points.length; i++) {
                await sleep(stepDelay);
                th.onTouchMove(points[i].x, points[i].y, TOUCH_ID);
            }
            if (points.length < 3) await sleep(stepDelay);
            th.onTouchEnd(last.x, last.y, TOUCH_ID);
        } else if (method === "dom" || method === "dom-touch") {
            var useTouch = method === "dom-touch";
            var c = stageToClient(first.x, first.y);
            if (useTouch) domTouch("touchstart", c.x, c.y);
            else domMouse("mousedown", c.x, c.y, 1);
            for (var j = 1; j < points.length; j++) {
                await sleep(stepDelay);
                c = stageToClient(points[j].x, points[j].y);
                if (useTouch) domTouch("touchmove", c.x, c.y);
                else domMouse("mousemove", c.x, c.y, 1);
            }
            if (points.length < 3) await sleep(stepDelay);
            c = stageToClient(last.x, last.y);
            if (useTouch) domTouch("touchend", c.x, c.y);
            else domMouse("mouseup", c.x, c.y, 0);
        } else if (method === "event") {
            if (!target) throw new Error("method=event 需要指定目标对象");
            dispatchEgretTouch(target, "TOUCH_BEGIN", first.x, first.y, true);
            await sleep(stepDelay);
            dispatchEgretTouch(target, "TOUCH_END", last.x, last.y, false);
            dispatchEgretTouch(target, "TOUCH_TAP", last.x, last.y, false);
        } else {
            throw new Error("未知的 method：" + method);
        }
    }

    var handlers = {
        getErrors: function (p) {
            var since = p.sinceTs !== undefined && p.sinceTs !== null ? +p.sinceTs : 0;
            var types = p.types && p.types.length ? p.types : null;
            var buf = errorBuffer();
            var list = buf.filter(function (e) {
                if (e.lastAt < since) return false;
                return !types || types.some(function (t) {
                    return e.type === t || e.type.indexOf(t) === 0;
                });
            });
            var limit = p.limit !== undefined ? +p.limit : 50;
            var out = { total: list.length, collectingSince: window.__egretInspectorErrorHooks || null, now: Date.now(),
                errors: list.slice(-limit) };
            if (p.clear) window.__egretInspectorErrors = [];
            return out;
        },

        status: function () {
            var eg = egretNs();
            var stage = getStage();
            var canvas = getCanvas();
            var info = {
                url: location.href,
                title: document.title,
                egretFound: !!eg,
                stageFound: !!stage,
                agentVersion: VERSION
            };
            if (eg && eg.Capabilities) info.engineVersion = eg.Capabilities.engineVersion || null;
            if (eg && eg.Capabilities) info.renderMode = eg.Capabilities.renderMode || null;
            if (stage) {
                info.stageWidth = stage.stageWidth;
                info.stageHeight = stage.stageHeight;
                info.scaleMode = stage.scaleMode || null;
                info.frameRate = stage.frameRate;
                var count = 0;
                walk(stage, function () {
                    count++;
                });
                info.displayObjectCount = count;
            }
            if (canvas) {
                var r = canvas.getBoundingClientRect();
                info.canvasScreenRect = { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
            }
            var player = getPlayer();
            if (player && player.webTouchHandler) info.screenRotation = player.webTouchHandler.rotation || 0;
            info.touchHandler = !!touchHandler();
            info.devicePixelRatio = window.devicePixelRatio;
            return info;
        },

        getTree: function (p) {
            var stage = requireStage();
            var root = p.hash !== undefined && p.hash !== null ? byHash(p.hash) : stage;
            var maxDepth = p.depth !== undefined ? +p.depth : 3;
            var maxNodes = p.maxNodes !== undefined ? +p.maxNodes : 300;
            var visibleOnly = !!p.visibleOnly;
            var withBounds = p.bounds !== false;
            var count = 0, truncated = false;
            var rootNode = describe(root, { bounds: withBounds, path: true });
            count++;
            var stack = [{ o: root, node: rootNode, depth: 0 }];
            while (stack.length) {
                var item = stack.shift();
                var n = numChildren(item.o);
                if (!n || item.depth >= maxDepth) continue;
                item.node.children = [];
                for (var i = 0; i < n; i++) {
                    var c = childAt(item.o, i);
                    if (!c) continue;
                    if (visibleOnly && (!c.visible || c.alpha === 0)) continue;
                    if (count >= maxNodes) {
                        truncated = true;
                        item.node.childrenTruncated = true;
                        break;
                    }
                    var cn = describe(c, { bounds: withBounds });
                    delete cn.onStageVisible;
                    item.node.children.push(cn);
                    count++;
                    stack.push({ o: c, node: cn, depth: item.depth + 1 });
                }
            }
            return { nodeCount: count, truncated: truncated, tree: rootNode };
        },

        find: function (p) {
            if (!hasCriteria(p)) throw new Error("至少提供 id / qaName / name / className / text / source / hash 之一");
            var list = query(p);
            var limit = p.limit !== undefined ? +p.limit : 20;
            var keys = p.props || [];
            return {
                total: list.length,
                results: list.slice(0, limit).map(function (o) {
                    var info = describe(o, { path: true });
                    if (keys.length) info.props = readProps(o, keys);
                    return info;
                })
            };
        },

        getNode: function (p) {
            var o = resolveTarget(p);
            if (!o) throw new Error("需要提供 hash 或查询条件");
            var info = describe(o, { path: true });
            info.props = readProps(o, p.props || [], true);
            var ancestors = [];
            var cur = o.parent;
            while (cur) {
                ancestors.push({ hash: hashOf(cur), className: className(cur), id: bindId(cur), name: cur.name || null });
                cur = cur.parent;
            }
            info.ancestors = ancestors;
            var children = [];
            for (var i = 0; i < Math.min(numChildren(o), 50); i++) {
                var c = childAt(o, i);
                if (c) children.push({ hash: hashOf(c), className: className(c), id: bindId(c), name: c.name || null, visible: !!c.visible });
            }
            info.children = children;
            return info;
        },

        hitTest: function (p) {
            requireStage();
            var pt = p.stageX !== undefined ? { x: +p.stageX, y: +p.stageY } : clientToStage(+p.clientX, +p.clientY);
            var o = hitTest(pt.x, pt.y);
            var chain = [];
            var cur = o;
            while (cur && chain.length < 30) {
                chain.push({ hash: hashOf(cur), className: className(cur), id: bindId(cur), name: cur.name || null, touchEnabled: !!cur.touchEnabled });
                cur = cur.parent;
            }
            return { stagePoint: pt, target: o ? describe(o, { path: true }) : null, ancestors: chain.slice(1) };
        },

        tap: async function (p) {
            requireStage();
            var target = resolveTarget(p);
            var pt = stagePointOf(p, target);
            var method = p.method || (touchHandler() ? "touch" : "dom");
            var warnings = [];
            var hit = hitTest(pt.x, pt.y);
            // 命中目标自身、其子节点或其祖先（点击常由父容器接管）都算能点到。某些 UI 框架（如 FairyGUI）
            // 的父链上带着 visible=false 的容器，此时 effectiveVisible 会误判，不要据此判断
            var reachable = target && hit && (isSelfOrAncestor(target, hit) || isSelfOrAncestor(hit, target));
            if (target && !reachable && !effectiveVisible(target)) warnings.push("目标对象在舞台上不可见");
            if (target && hit && method !== "event" && !reachable) {
                var blocker = className(hit) + (bindId(hit) ? "#" + bindId(hit) : "");
                // 挡住了还照点只会点到遮挡物上，不如直接失败，让调用方先处理遮挡再重试
                if (!p.force) {
                    throw new Error("目标被遮挡，未执行点击：该位置命中的是 " + blocker +
                        "（通常是弹窗或全屏遮罩，先关闭它再重试；确需照点可传 force: true）");
                }
                warnings.push("点击位置命中的对象不在目标内部（可能被遮挡）：" + blocker);
            }
            var times = p.count || 1;
            for (var i = 0; i < times; i++) {
                if (i) await sleep(80);
                await performGesture([pt], method, p.holdMs !== undefined ? +p.holdMs : 50, target);
            }
            return {
                method: method,
                stagePoint: pt,
                screenPoint: stageToClient(pt.x, pt.y),
                target: target ? describe(target, { path: true }) : null,
                hit: hit ? describe(hit, { path: true, bounds: false }) : null,
                warnings: warnings
            };
        },

        drag: async function (p) {
            requireStage();
            var fromTarget = resolveTarget(p);
            var from = stagePointOf(p, fromTarget);
            var to;
            if (p.toStageX !== undefined) to = { x: +p.toStageX, y: +p.toStageY };
            else if (p.toClientX !== undefined) to = clientToStage(+p.toClientX, +p.toClientY);
            else if (p.dx !== undefined || p.dy !== undefined) to = { x: from.x + (+p.dx || 0), y: from.y + (+p.dy || 0) };
            else throw new Error("需要提供 toStageX/toStageY、toClientX/toClientY 或 dx/dy");
            var steps = Math.max(2, p.steps ? +p.steps : 10);
            var pts = [];
            for (var i = 0; i <= steps; i++) {
                pts.push({ x: round(from.x + (to.x - from.x) * i / steps), y: round(from.y + (to.y - from.y) * i / steps) });
            }
            var method = p.method || (touchHandler() ? "touch" : "dom");
            if (method === "event") throw new Error("drag 不支持 method=event");
            await performGesture(pts, method, p.durationMs !== undefined ? +p.durationMs : 300, fromTarget);
            return { method: method, from: from, to: to, screenFrom: stageToClient(from.x, from.y), screenTo: stageToClient(to.x, to.y) };
        },

        setProps: function (p) {
            var o = resolveTarget(p);
            if (!o) throw new Error("需要提供 hash 或查询条件");
            var props = p.props || {};
            var result = {};
            Object.keys(props).forEach(function (k) {
                o[k] = props[k];
                result[k] = serialize(o[k], 1);
            });
            if (p.dispatchChange) {
                var eg = egretNs();
                if (eg.Event && eg.Event.CHANGE) o.dispatchEventWith ? o.dispatchEventWith(eg.Event.CHANGE) : o.dispatchEvent(new eg.Event(eg.Event.CHANGE));
            }
            return { hash: hashOf(o), className: className(o), id: bindId(o), props: result };
        },

        waitFor: async function (p) {
            var timeout = p.timeoutMs !== undefined ? +p.timeoutMs : 10000;
            var interval = p.intervalMs !== undefined ? +p.intervalMs : 200;
            var state = p.state || "visible";
            var q = Object.assign({}, p, { visibleOnly: state === "visible" || state === "hidden" });
            var start = Date.now();
            var stableMs = p.stableMs ? +p.stableMs : 0;
            var lastKey = null;
            var stableSince = 0;
            while (true) {
                var list = getStage() ? query(q) : [];
                var ok = state === "visible" || state === "exists" ? list.length > 0 : list.length === 0;
                if (ok && stableMs && list.length) {
                    // 位置、尺寸和透明度在 stableMs 内保持不变才算满足，用于等待面板打开动画结束
                    var key = JSON.stringify(stageRect(list[0])) + "|" + visualAlpha(list[0]);
                    if (key !== lastKey) {
                        lastKey = key;
                        stableSince = Date.now();
                    }
                    ok = Date.now() - stableSince >= stableMs;
                }
                if (ok) {
                    return {
                        matched: true,
                        state: state,
                        elapsedMs: Date.now() - start,
                        total: list.length,
                        results: list.slice(0, 5).map(function (o) {
                            return describe(o, { path: true });
                        })
                    };
                }
                if (Date.now() - start >= timeout) {
                    return { matched: false, state: state, elapsedMs: Date.now() - start, total: list.length };
                }
                await sleep(interval);
            }
        },

        evaluate: async function (p) {
            var stage = getStage();
            var helpers = {
                $stage: stage,
                $obj: byHash,
                $find: function (q) {
                    return query(q || {});
                },
                $describe: function (o) {
                    return describe(o, { path: true });
                }
            };
            var names = Object.keys(helpers);
            var args = names.map(function (k) {
                return helpers[k];
            });
            // 先按表达式编译；若不是合法表达式则作为语句块（需显式 return）
            var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            var fn;
            try {
                fn = AsyncFunction.apply(null, names.concat(["return (" + p.expression + "\n)"]));
            } catch (e) {
                fn = AsyncFunction.apply(null, names.concat([p.expression]));
            }
            var value = await fn.apply(window, args);
            return { value: serialize(value, p.depth !== undefined ? +p.depth : 3) };
        }
    };

    installErrorHooks();

    window.__egretInspectorMcp = {
        version: VERSION,
        call: async function (method, params) {
            var h = handlers[method];
            if (!h) return { ok: false, error: "未知的页面方法：" + method };
            try {
                return { ok: true, result: await h(params || {}) };
            } catch (e) {
                return { ok: false, error: e && e.message ? e.message : String(e) };
            }
        }
    };
})();
