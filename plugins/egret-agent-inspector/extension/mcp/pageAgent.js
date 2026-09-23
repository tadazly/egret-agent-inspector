// Egret Agent Inspector MCP 页面代理：由扩展通过 chrome.scripting.executeScript 注入到页面 MAIN world，
// 为 MCP 工具提供显示对象查询、点击、等待等能力。所有返回值均为可 JSON 序列化的普通对象。
(function () {
    var VERSION = "1.7.14";
    // 标识「这一次页面加载」：扩展重载会重新注入页面代理，但游戏对象和 hash 都还在，不能算重载；
    // 挂在 window 上，重新注入沿用，只有页面真的重载才换新的
    var BOOT_ID = window.__egretInspectorBootId ||
        (window.__egretInspectorBootId = Math.random().toString(36).slice(2, 10));
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
            if (t === null || t === "") {
                var w = ownerOf(o);
                if (w && typeof w.text === "string" && w.text) t = w.text;
            }
        } catch (e) {}
        if (t && t.length > 200) t = t.slice(0, 200) + "…";
        return t;
    }

    // eui.Image 等组件的资源名，便于定位没有绑定 id 的图片按钮
    function sourceOf(o) {
        var s;
        try {
            s = o.source;
            if (!s) {
                var w = ownerOf(o);
                if (w && typeof w.url === "string") s = w.url;
            }
        } catch (e) {
            return null;
        }
        return typeof s === "string" && s ? s : null;
    }

    // FairyGUI 这类框架把组件数据挂在显示对象的 $owner 上，显示对象本身没有 name/text/source
    function ownerOf(o) {
        try {
            var w = o.$owner || o._owner;
            return w && typeof w === "object" ? w : null;
        } catch (e) {
            return null;
        }
    }

    function nameOf(o) {
        var n = null;
        try {
            n = o.name || null;
            if (!n) {
                var w = ownerOf(o);
                if (w && typeof w.name === "string") n = w.name || null;
            }
        } catch (e) {}
        return n;
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

    // 纯热区容器（有 width/height、没有任何子渲染对象的 Group）的内容包围盒会退化成 0，
    // 但 Egret 命中测试认的是 width/height，玩家点得到。这种情况改用布局盒，否则整行会被丢掉。
    function layoutRect(o) {
        try {
            if (!o || !o.localToGlobal || !(o.width >= 2) || !(o.height >= 2)) return null;
            var a = o.localToGlobal(0, 0);
            var b = o.localToGlobal(o.width, o.height);
            var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
            var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
            if (!(w >= 2) || !(h >= 2)) return null;
            return { x: round(x), y: round(y), width: round(w), height: round(h) };
        } catch (e) {
            return null;
        }
    }

    function stageRect(o) {
        var stage = getStage();
        try {
            var r = o.getTransformedBounds(stage);
            if (r.width < 2 || r.height < 2) {
                var box = layoutRect(o);
                if (box) return box;
            }
            return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
        } catch (e) {
            return layoutRect(o);
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
            name: nameOf(o)
        };
        var qa = qaNameOf(o);
        if (qa) info.qaName = qa;
        var t = textOf(o);
        if (t !== null) info.text = t;
        var src = sourceOf(o);
        if (src) info.source = src;
        info.visible = o === getStage() ? true : !!o.visible;
        info.onStageVisible = effectiveVisible(o);
        info.touchable = effectiveTouchable(o);
        ["enabled", "selected", "currentState"].forEach(function (k) {
            try {
                var v = o[k];
                if (v !== undefined && (typeof v === "boolean" || typeof v === "string" || typeof v === "number")) info[k] = v;
            } catch (e) {}
        });
        info.childCount = numChildren(o);
        if (opts.bounds !== false) {
            var sr = stageRect(o);
            info.stageRect = sr;
            info.screenRect = screenRect(sr);
        }
        if (opts.center && info.stageRect) {
            info.center = { x: round(info.stageRect.x + info.stageRect.width / 2), y: round(info.stageRect.y + info.stageRect.height / 2) };
        }
        if (opts.path) info.path = pathOf(o);
        return info;
    }

    // 只保留调用方要的字段：批量结果的完整描述很容易把上下文撑爆
    function project(info, fields) {
        if (!fields || !fields.length) return info;
        var out = {};
        fields.forEach(function (k) {
            if (info[k] !== undefined) out[k] = info[k];
        });
        return out;
    }

    // topFirst 为真时按「最上层子节点优先」遍历：显示列表里后加入的子节点画在上面，
    // 有扫描预算上限时必须先走它们，否则预算会被背景和地图吃光，顶层弹窗的按钮一个都收不到。
    function walk(root, fn, topFirst) {
        var stack = [root];
        while (stack.length) {
            var o = stack.pop();
            if (!o) continue;
            var h = hashOf(o);
            if (h !== undefined) hashCache.set(String(h), o);
            if (fn(o) === false) continue;
            var n = numChildren(o);
            if (topFirst) for (var k = 0; k < n; k++) stack.push(childAt(o, k));
            else for (var i = n - 1; i >= 0; i--) stack.push(childAt(o, i));
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
            if (mName && !mName(nameOf(o))) return;
            if (mClass && !mClass(className(o))) return;
            if (mText && !mText(textOf(o))) return;
            if (mSource && !mSource(sourceOf(o))) return;
            if (mId && !mId(bindId(o))) return;
            if (mQa && !mQa(qaNameOf(o))) return;
            if (p.touchableOnly && !effectiveTouchable(o)) return;
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

    // 给点过的控件找一个下次还能用的查询条件：编号只在这一张表里有效，hash 面板一重开就变。
    // 路线复用时 server 拿它拼多步 act，所以要能唯一回到同一个控件；实在不唯一就带上是第几个
    function stableSelector(o) {
        var qa = qaNameOf(o), id = bindId(o), nm = nameOf(o), tx = textOf(o);
        var cands = [];
        if (qa) cands.push({ qaName: qa, match: "exact" });
        if (id) cands.push({ id: id, match: "exact" });
        if (nm && !/^(instance)?\d*$/.test(nm)) cands.push({ name: nm, match: "exact" });
        if (tx && String(tx).length <= 16) cands.push({ text: String(tx), match: "exact" });
        var fallback = null;
        for (var k = 0; k < cands.length; k++) {
            var hits = query(cands[k]), at = hits.indexOf(o);
            if (at < 0) continue;
            if (hits.length === 1) return cands[k];
            if (!fallback && at < 10) fallback = Object.assign({}, cands[k], { index: at });
        }
        return fallback;
    }

    // 面板身份：hash 每次打开都变，类名 + 实例名才认得出「又回到了背包」
    function panelKey(o) {
        return o ? shortClass(o) + ":" + stackEntryLabel(o) : "stage";
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

    // 等目标的位置/尺寸/透明度在 settleMs 内不再变化：入场动画期间点上去会点偏
    async function waitStable(o, settleMs) {
        var key = null, since = Date.now(), deadline = since + Math.max(settleMs * 6, 2000);
        while (Date.now() < deadline) {
            var k = JSON.stringify(stageRect(o)) + "|" + visualAlpha(o);
            if (k !== key) {
                key = k;
                since = Date.now();
            } else if (Date.now() - since >= settleMs) {
                return true;
            }
            await sleep(Math.min(80, settleMs));
        }
        return false;
    }

    function visibleChildren(o) {
        var out = [];
        for (var i = 0; i < numChildren(o); i++) {
            var c = childAt(o, i);
            if (c && c.visible && c.alpha !== 0) out.push(c);
        }
        return out;
    }

    // 当前界面结构：跳过只起包裹作用的根容器，按渲染顺序找出最上层那个“占地够大、有内容”的面板，
    // 它的兄弟节点就是当前的面板/弹窗栈。只看舞台的直接子节点会停在空的层上。
    function sceneInfo() {
        var stage = requireStage();
        var area = stage.stageWidth * stage.stageHeight;
        var kids = visibleChildren(stage);
        var root = kids.length === 1 && numChildren(kids[0]) ? kids[0] : stage;
        var layers = visibleChildren(root);
        var top = null, best = null, serial = 0;
        var queue = [{ o: root, d: 0 }];
        while (queue.length) {
            var it = queue.pop();
            var children = visibleChildren(it.o);
            if (it.o !== root) {
                var r = stageRect(it.o);
                // 优先保留更深的面板，避免遍历到后面的 uiLayer/topLayer 等基础层时把真实弹窗覆盖掉。
                var tag = className(it.o) + " " + (nameOf(it.o) || "") + " " + (bindId(it.o) || "");
                var semantic = /panel|pop|dialog|alert|view|window|fui|loading|transition|overlay/i.test(tag);
                var structural = layers.indexOf(it.o) >= 0;
                if (r && r.width * r.height >= area * 0.2 && children.length && (semantic || structural)) {
                    var score = (semantic ? 10000000 : 0) + it.d * 100000 + serial;
                    if (!best || score > best.score) best = { o: it.o, score: score };
                }
            }
            serial++;
            if (it.d >= 8) continue;
            for (var i = children.length - 1; i >= 0; i--) queue.push({ o: children[i], d: it.d + 1 });
        }
        top = best && best.o;

        // FairyGUI/UIContainer 的 getChildAt 树与 parent 链可能不完全一致；用真实命中结果回溯到
        // ui/top 层的直属子项，能稳定识别盖在最上面的 ApplicationView/弹窗包装器。
        var hitCounts = [];
        var points = [[stage.stageWidth * 0.5, stage.stageHeight * 0.5],
            [stage.stageWidth * 0.08, stage.stageHeight * 0.08], [stage.stageWidth * 0.92, stage.stageHeight * 0.08],
            [stage.stageWidth * 0.08, stage.stageHeight * 0.92], [stage.stageWidth * 0.92, stage.stageHeight * 0.92]];
        points.forEach(function (pt) {
            var hit = hitTest(pt[0], pt[1]);
            if (!hit) return;
            var cur = hit, layer = null;
            while (cur && cur !== root && cur !== stage) {
                if (cur.parent && layers.indexOf(cur.parent) >= 0) {
                    layer = cur.parent;
                    break;
                }
                cur = cur.parent;
            }
            if (!cur || !layer) return;
            var layerTag = className(layer) + " " + (nameOf(layer) || "") + " " + (bindId(layer) || "");
            var panelTag = className(cur) + " " + (nameOf(cur) || "") + " " + (bindId(cur) || "");
            if (!/ui|top|popup|modal|dialog|alert|loading|transition|overlay/i.test(layerTag) &&
                !/panel|pop|dialog|alert|view|window|fui|container|loading|transition|overlay|mask/i.test(panelTag)) return;
            var rect = stageRect(cur);
            if (!rect || rect.width * rect.height < area * 0.05) return;
            var found = hitCounts.filter(function (x) { return x.o === cur; })[0];
            if (found) found.count++;
            else hitCounts.push({ o: cur, count: 1, layer: layer });
        });
        hitCounts.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return layers.indexOf(b.layer) - layers.indexOf(a.layer);
        });
        if (hitCounts.length) {
            top = hitCounts[0].o;
            // 命中点常先落到全屏 BackgroundMask；同一层里渲染顺序更靠后的语义面板或
            // 紧凑内容块才是要操作的弹窗。后者兼容“全屏 Popup 根节点 + 通用 eui.Group 内容”。
            var layerChildren = visibleChildren(hitCounts[0].layer);
            for (var j = layerChildren.length - 1; j >= 0; j--) {
                var candidate = layerChildren[j];
                var candidateTag = className(candidate) + " " + (nameOf(candidate) || "") + " " + (bindId(candidate) || "");
                var candidateRect = stageRect(candidate);
                var candidateArea = candidateRect && candidateRect.width * candidateRect.height;
                var semanticPanel = /panel|pop|dialog|alert|view|window|fui|loading|transition|overlay/i.test(candidateTag);
                var compactContent = candidate !== hitCounts[0].o && candidateArea >= area * 0.03 &&
                    candidateArea < area * 0.82 && !BACKDROP_RE.test(candidateTag);
                if ((semanticPanel || compactContent) && candidateArea >= area * 0.03) {
                    top = candidate;
                    break;
                }
            }
        }
        var siblings = top && top.parent ? visibleChildren(top.parent) : layers;
        var stack = siblings.filter(function (o) {
            var r = stageRect(o);
            return r && r.width * r.height >= area * 0.05;
        });
        if (!top) top = layers.length ? layers[layers.length - 1] : null;
        return { stage: stage, layers: layers, stack: stack.length ? stack : siblings, top: top };
    }

    var CLOSE_RE = /close|关闭|關閉|quit|cancel|dismiss|guanbi|(?:^|[\s_-])btn_no(?:$|[\s_-])/i;
    var CLOSE_TEXTS = ["关闭", "取消", "确定", "确认", "知道了", "我知道了", "好的", "×", "X", "x"];
    // 全屏面板常常只有「返回」没有 ×。back 要避开 background / backdrop / bg 这类背景命名。
    var BACK_RE = /(?:^|[\s_-])(?:back|return)(?:$|[\s_-])|返回|回退|返 回/i;
    var BACK_TEXTS = ["返回", "返 回", "back", "Back", "BACK"];

    // 弹窗里的关闭控件：命名五花八门，按关键字 + 体积 + 靠右上角的程度打分。
    // allowBack 只给 op=close 这种明确要关掉当前面板的场景用，dismiss 保持严格，免得误点场景里的返回。
    function closeScore(o, pr, allowBack) {
        var r = stageRect(o);
        if (!r || r.width < 10 || r.height < 10) return null;
        if (r.width * r.height > pr.width * pr.height * 0.35) return null;
        var tag = [bindId(o), qaNameOf(o), nameOf(o), sourceOf(o)].filter(Boolean).join(" ");
        var t = textOf(o);
        var score = 0;
        if (CLOSE_RE.test(tag)) score += 10;
        // 明确叫 back 的压过只叫 return 的：后者可能是「返还」
        else if (allowBack && BACK_RE.test(tag)) score += STRONG_BACK_RE.test(ownIds(o)) ? 8 : 6;
        if (t && CLOSE_TEXTS.indexOf(String(t).trim()) >= 0) score += 8;
        else if (allowBack && t && BACK_TEXTS.indexOf(String(t).trim()) >= 0) score += 6;
        if (!score) return null;
        if (effectiveTouchable(o)) score += 2;
        // 同分时取更靠右上、体积更小的，通常就是那个 X
        score += (r.x - pr.x) / Math.max(pr.width, 1) - (r.y - pr.y) / Math.max(pr.height, 1);
        return { o: o, score: score, rect: r };
    }

    function findCloseControl(panel, allowBack) {
        var pr = stageRect(panel);
        if (!pr) return null;
        var best = null;
        walk(panel, function (o) {
            if (o === panel) return;
            if (!o.visible || o.alpha === 0) return false;
            var s = closeScore(o, pr, allowBack);
            if (s && (!best || s.score > best.score)) best = s;
        });
        if (best) return best;
        // FairyGUI 这类面板的父链上夹着 visible=false 的容器，遍历在那里被剪断，关闭键整个漏掉；
        // 动作表靠网格命中扫描能看到它。这里按同一套办法在四边和角上补扫，
        // 否则动作表第一行明明是 close，dismiss / close 和 mode 判断却说「没有关闭控件」。
        var seen = {};
        [0.03, 0.06, 0.1, 0.5, 0.9, 0.94, 0.97].forEach(function (fx) {
            [0.03, 0.06, 0.1, 0.15, 0.22, 0.5, 0.88, 0.94].forEach(function (fy) {
                var hit = hitTest(round(pr.x + pr.width * fx), round(pr.y + pr.height * fy));
                for (var o = hit, hops = 0; o && o !== panel && hops < 6; o = o.parent, hops++) {
                    var key = String(hashOf(o));
                    if (seen[key]) break;
                    seen[key] = true;
                    if (!isSelfOrAncestor(panel, o)) continue;
                    var s = closeScore(o, pr, allowBack);
                    if (s && (!best || s.score > best.score)) best = s;
                }
            });
        });
        return best;
    }

    var BACKDROP_RE = /mask|遮罩|shade|shadow|scrim|backdrop|overlay|cover|dim|modal.?bg|dark.?bg|black.?bg/i;

    function pointInRect(x, y, r) {
        return !!r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    }

    function backdropEvidence(o, stageArea) {
        if (!o) return false;
        var r = stageRect(o);
        if (!r || r.width * r.height < stageArea * 0.45) return false;
        var tag = [className(o), bindId(o), qaNameOf(o), nameOf(o), sourceOf(o)].filter(Boolean).join(" ");
        if (BACKDROP_RE.test(tag)) return true;
        var alphaValues = [];
        ["alpha", "fillAlpha", "backgroundAlpha"].forEach(function (key) {
            try {
                var value = Number(o[key]);
                if (isFinite(value)) alphaValues.push(value);
            } catch (e) {}
        });
        // 大面积半透明 Rect/Bitmap 是常见的黑色遮罩；普通不透明场景背景不能据此误判。
        return alphaValues.some(function (value) { return value > 0 && value < 0.95; });
    }

    function modalContentRect(panel) {
        var stage = getStage();
        var pr = stageRect(panel);
        if (!stage || !pr) return null;
        var area = stage.stageWidth * stage.stageHeight;
        if (pr.width * pr.height < area * 0.82) return pr;
        var best = null;
        function consider(o) {
            if (!o || o === panel || !effectiveVisible(o)) return;
            var r = stageRect(o);
            if (!r) return;
            var ratio = r.width * r.height / area;
            if (ratio < 0.03 || ratio >= 0.82) return;
            var tag = [className(o), bindId(o), qaNameOf(o), nameOf(o), sourceOf(o)].filter(Boolean).join(" ");
            if (BACKDROP_RE.test(tag)) return;
            if (!best || ratio > best.ratio) best = { rect: r, ratio: ratio };
        }
        // 中心命中链通常从按钮/正文一路回到真正的弹窗内容容器。
        var cur = hitTest(stage.stageWidth / 2, stage.stageHeight / 2);
        for (var depth = 0; cur && depth < 12; depth++, cur = cur.parent) {
            if (!isSelfOrAncestor(panel, cur)) break;
            consider(cur);
            if (cur === panel) break;
        }
        // 中心可能恰好落在镂空区域；再从子树中选择最大的非遮罩内容块。
        if (!best) walk(panel, consider);
        return best && best.rect;
    }

    // 识别内容区外的大面积半透明/遮罩背景，并区分它是否真的注册了点击监听。
    // 兼容“内容面板 + 遮罩兄弟节点”和“全屏根节点内含遮罩”两种常见结构。
    function backdropPointOutside(panel) {
        var stage = getStage();
        var pr = stageRect(panel);
        if (!stage || !pr) return null;
        var w = stage.stageWidth, h = stage.stageHeight;
        var area = w * h;
        var contentRect = modalContentRect(panel);
        if (!contentRect) {
            if (!backdropEvidence(panel, area)) return null;
            return { x: round(w / 2), y: round(h / 2), hit: panel, evidence: panel, contentRect: null,
                listenerOwner: interactionListenersOf(panel).length ? panel : null,
                actionable: interactionListenersOf(panel).length > 0 };
        }
        var pts = [[w * 0.5, h * 0.06], [w * 0.5, h * 0.94], [w * 0.06, h * 0.5], [w * 0.94, h * 0.5],
            [w * 0.06, h * 0.06], [w * 0.94, h * 0.06], [w * 0.06, h * 0.94], [w * 0.94, h * 0.94]];
        var passiveCandidate = null;
        for (var i = 0; i < pts.length; i++) {
            var x = round(pts[i][0]), y = round(pts[i][1]);
            if (pointInRect(x, y, contentRect)) continue;
            var hit = hitTest(x, y);
            if (!hit) continue;
            var related = isSelfOrAncestor(panel, hit) || !!(panel.parent && isSelfOrAncestor(panel.parent, hit));
            if (!related) continue;
            var evidence = null, listenerOwner = null, cursor = hit;
            for (var depth = 0; cursor && depth < 12; depth++, cursor = cursor.parent) {
                if (!listenerOwner && interactionListenersOf(cursor).length) listenerOwner = cursor;
                if (!evidence && backdropEvidence(cursor, area)) evidence = cursor;
                if (cursor === panel.parent || cursor === stage) break;
            }
            // 有些全屏 Dialog/Popup 把遮罩点击监听直接挂在根节点上，没有可辨识的 mask 子节点。
            var panelTag = className(panel) + " " + (nameOf(panel) || "") + " " + (bindId(panel) || "");
            var rootCatchesBackdrop = pr.width * pr.height >= area * 0.82 &&
                /popup|modal|dialog|alert|window/i.test(panelTag) &&
                isSelfOrAncestor(panel, hit) && interactionListenersOf(panel).length > 0;
            if (evidence || rootCatchesBackdrop) {
                var candidate = { x: x, y: y, hit: hit, evidence: evidence || panel, contentRect: contentRect,
                    listenerOwner: listenerOwner || (rootCatchesBackdrop ? panel : null),
                    actionable: !!listenerOwner || rootCatchesBackdrop };
                if (candidate.actionable) return candidate;
                if (!passiveCandidate) passiveCandidate = candidate;
            }
        }
        return passiveCandidate;
    }

    // 只有真实点击监听证明这个遮罩能处理点击时，才把它作为“关闭弹窗”目标。
    function maskPointOutside(panel) {
        var candidate = backdropPointOutside(panel);
        return candidate && candidate.actionable ? candidate : null;
    }

    function backdropDismissTargetOf(panel) {
        if (!panel || findCloseControl(panel)) return null;
        var mp = maskPointOutside(panel);
        if (!mp) return null;
        var result = recommendationAt(panel, { x: mp.x, y: mp.y }, "modal-backdrop-dismiss", mp.hit);
        result.actionHint = "当前顶层弹窗没有关闭控件，可点击内容区外的半透明遮罩关闭；点击后确认弹窗 hash 已消失";
        if (mp.contentRect) result.contentRect = {
                x: round(mp.contentRect.x), y: round(mp.contentRect.y),
                width: round(mp.contentRect.width), height: round(mp.contentRect.height)
            };
        return result;
    }

    function transientOverlayOf(panel) {
        if (!panel || findCloseControl(panel) || continueTargetOf(panel)) return null;
        var tags = [], cur = panel;
        for (var depth = 0; cur && depth < 4; depth++, cur = cur.parent) {
            tags.push(className(cur), nameOf(cur), bindId(cur), qaNameOf(cur), sourceOf(cur));
        }
        var namedTransition = /loading|transition|fade|switch.?map|map.?title|scene.?title|chapter.?title|location.?title|过场|转场/i
            .test(tags.filter(Boolean).join(" "));
        // 面板里有带文字的可点控件（对白选项、功能按钮）就不是过场：有东西可点，不该让调用方空等。
        // 但加载页上的「Tips：…」提示常挂着监听，不能因此把战斗加载页当成可以点遮罩关掉的弹窗
        if (!namedTransition && dialogueHasDecision(panel)) return null;
        var backdrop = backdropPointOutside(panel);
        // 有点击监听的普通遮罩由 modal-backdrop-dismiss 处理；已知 loading/转场层即使可点也不应盲点跳过。
        if (!namedTransition && (!backdrop || backdrop.actionable)) return null;
        var result = {
            reason: "transient-overlay",
            action: "wait",
            waitMs: 3000,
            panel: project(describe(panel, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "center", "currentState"]),
            actionHint: "这是没有安全点击目标的全屏暗化、地图标题或加载过场；先短等再重新观察，不要点遮罩。若 3 秒后同一 hash 仍存在，再截图和 hit_test 排查"
        };
        if (backdrop && backdrop.evidence) result.backdrop = project(describe(backdrop.evidence, { center: true }),
            ["hash", "className", "id", "name", "qaName", "text", "center"]);
        return result;
    }

    function eventMaps(o) {
        var maps = [];
        try {
            // Egret 5 把监听表存在 $EventDispatcher 上，并压成数字键：0=目标、1=普通监听、2=捕获监听
            var props = o.$EventDispatcher_props_ || o.$EventDispatcher;
            if (props) {
                [props.eventsMap, props.captureEventsMap, props[1], props[2]].forEach(function (m) {
                    if (m && typeof m === "object" && maps.indexOf(m) < 0) maps.push(m);
                });
            }
        } catch (e) {}
        return maps;
    }

    function fnSource(fn, maxChars) {
        var src;
        try {
            src = Function.prototype.toString.call(fn);
        } catch (e) {
            return null;
        }
        src = src.replace(/\s+/g, " ").trim();
        return src.length > maxChars ? src.slice(0, maxChars) + "…" : src;
    }

    // 对象自身类（不含引擎基类）上定义的方法名，便于按名字在项目源码里检索
    function methodsOf(o) {
        var proto = Object.getPrototypeOf(o);
        if (!proto) return [];
        if (/^(egret|eui|fairygui)\./.test(className(o) || "")) return [];
        var names = [];
        try {
            Object.getOwnPropertyNames(proto).forEach(function (k) {
                if (k === "constructor") return;
                var d = Object.getOwnPropertyDescriptor(proto, k);
                if (d && typeof d.value === "function") names.push(k);
            });
        } catch (e) {}
        return names.slice(0, 80);
    }

    function listenersOf(o, maxChars) {
        var out = [];
        eventMaps(o).forEach(function (map) {
            Object.keys(map).forEach(function (type) {
                var bins = map[type];
                if (!bins) return;
                (bins.length !== undefined ? Array.prototype.slice.call(bins) : [bins]).forEach(function (bin) {
                    if (!bin || typeof bin.listener !== "function") return;
                    out.push({
                        type: type,
                        fn: bin.listener.name || null,
                        thisClass: bin.thisObject ? className(bin.thisObject) : null,
                        source: fnSource(bin.listener, maxChars)
                    });
                });
            });
        });
        return out;
    }

    function interactionListenersOf(o) {
        var out = [];
        eventMaps(o).forEach(function (map) {
            Object.keys(map).forEach(function (type) {
                if (!/touch|tap|mouse|click/i.test(type)) return;
                var bins = map[type];
                if (!bins) return;
                (bins.length !== undefined ? Array.prototype.slice.call(bins) : [bins]).forEach(function (bin) {
                    if (!bin || typeof bin.listener !== "function") return;
                    out.push({ type: type, fn: bin.listener.name || null,
                        thisClass: bin.thisObject ? className(bin.thisObject) : null });
                });
            });
        });
        return out;
    }

    // 按下才生效一半的控件：自己只挂 touchBegin，按下时才临时挂 touchEnd / touchReleaseOutside / touchMove，
    // 成不成看在哪松手。战斗里的换宠卡就是这样：拖出卡片上沿才换上场，原地点一下什么都不发生。
    // 只在松手回调里认得出唯一一个方向（globalToLocal 之后 y < 0 = 拖出上沿）时返回方向，否则返回 null。
    // 按下时挂松手回调的不一定是拖动：项目里的通用按钮工具（按下缩放、松手在按钮内才算点击）也这么写，
    // 它要么不看方向，要么四条边都判——主城一排按钮曾因此全被标成「按住拖出去」
    var dragCache = typeof WeakMap === "function" ? new WeakMap() : null;
    var DRAG_DIRS = [
        ["up", /\.y\s*<\s*(?:0(?![.\d])|-)/],
        ["down", /\.y\s*>\s*[\w$.]*height/i],
        ["left", /\.x\s*<\s*(?:0(?![.\d])|-)/],
        ["right", /\.x\s*>\s*[\w$.]*width/i]
    ];

    function dragGestureOf(o) {
        var types = {}, begins = [];
        eventMaps(o).forEach(function (map) {
            Object.keys(map).forEach(function (type) {
                var bins = map[type];
                if (!bins) return;
                (bins.length !== undefined ? Array.prototype.slice.call(bins) : [bins]).forEach(function (bin) {
                    if (!bin || typeof bin.listener !== "function") return;
                    types[type] = true;
                    if (type === "touchBegin") begins.push(bin);
                });
            });
        });
        // 同时挂着 touchTap / touchEnd 的是普通按钮，点一下就行；滚动容器这类引擎组件另有「可滚」处理
        if (!begins.length || types.touchTap || types.touchEnd || types.click || types.mouseUp) return null;
        for (var i = 0; i < begins.length; i++) {
            var bin = begins[i];
            if (/^(egret|eui|fairygui)\./.test(className(bin.thisObject) || "")) continue;
            if (dragCache && dragCache.has(bin.listener)) {
                var cached = dragCache.get(bin.listener);
                if (cached) return cached;
                continue;
            }
            var found = null;
            try {
                var src = String(bin.listener);
                var later = /TOUCH_(?:END|RELEASE_OUTSIDE|MOVE)\b|["']touch(?:End|ReleaseOutside|Move)["']/;
                if (later.test(src)) {
                    // 按下时挂上的松手回调多半是 this.xxx 方法，方向判断写在那里面
                    var body = src, re = /addEventListener\(\s*[^,]*,\s*(?:this|_this|self|that)\.([\w$]+)/g, m;
                    while ((m = re.exec(src))) {
                        var fn = bin.thisObject && bin.thisObject[m[1]];
                        if (typeof fn === "function") body += "\n" + String(fn);
                    }
                    var dirs = DRAG_DIRS.filter(function (d) { return d[1].test(body); });
                    found = dirs.length === 1 ? dirs[0][0] : null;
                }
            } catch (e) {}
            if (dragCache) dragCache.set(bin.listener, found);
            if (found) return found;
        }
        return null;
    }

    // 动作表那一行常是卡片里的头像、文字，监听挂在上面几层的卡片本身：往上找第一个挂着触摸监听的，
    // 松手位置也按它的边界算
    function dragTargetOf(o) {
        for (var cur = o, depth = 0; cur && depth < 4 && cur !== getStage(); depth++, cur = cur.parent) {
            if (!interactionListenersOf(cur).length) continue;
            var dir = dragGestureOf(cur);
            return dir ? { dir: dir, owner: cur } : null;
        }
        return null;
    }

    // 拖到目标上：先按住不动 holdMs（不少拖动要长按才起步：技能格按住 0.6 秒才开始拖），
    // 再每 40ms 挪一步、分 14 步挪过去，到了停 150ms 再松手，让拖动代理跟得上、落点判定看得到最后的位置
    // 起点在滚动列表里时（技能列表是竖着滚的），斜着拖的竖直分量会先够到列表的滚动阈值，
    // 列表把这次触摸当成滚动、拖动还没起步就被取消（验收里第一次拖技能只把列表滚了一下）。
    // 这时先沿着和滚动方向垂直的方向挪出去，再走另一段
    function dragToPath(from, to, holdMs, axis) {
        var pts = [{ x: from.x, y: from.y }, { x: from.x, y: from.y, wait: holdMs }];
        var corner = axis === "v" ? { x: to.x, y: from.y } : axis === "h" ? { x: from.x, y: to.y } : null;
        var legs = corner ? [[from, corner, 7], [corner, to, 7]] : [[from, to, 14]];
        legs.forEach(function (leg) {
            for (var i = 1; i <= leg[2]; i++) {
                pts.push({ x: round(leg[0].x + (leg[1].x - leg[0].x) * i / leg[2]),
                    y: round(leg[0].y + (leg[1].y - leg[0].y) * i / leg[2]), wait: 40 });
            }
        });
        pts.push({ x: to.x, y: to.y, wait: 150 });
        return pts;
    }

    // 往上找最近的滚动容器，看它往哪个方向滚：v 竖、h 横，不在滚动容器里是 null
    function scrollAxisOf(o) {
        for (var c = o, depth = 0; c && depth < 10; c = c.parent, depth++) {
            var vp = c.viewport;
            if (!vp) continue;
            try {
                if (vp.contentHeight - c.height > 1 && c.scrollPolicyV !== "off") return "v";
                if (vp.contentWidth - c.width > 1 && c.scrollPolicyH !== "off") return "h";
            } catch (e) {}
            return null;
        }
        return null;
    }

    // 从 pt 按住，拖出 owner 的边界再松手：多给 40px，免得正好落在边上
    function dragPath(pt, owner, dir) {
        var r = stageRect(owner) || { x: pt.x, y: pt.y, width: 0, height: 0 };
        var stage = getStage();
        var end = dir === "down" ? { x: pt.x, y: r.y + r.height + 40 }
            : dir === "left" ? { x: r.x - 40, y: pt.y }
            : dir === "right" ? { x: r.x + r.width + 40, y: pt.y }
            : { x: pt.x, y: r.y - 40 };
        end.x = round(Math.max(1, Math.min(stage.stageWidth - 1, end.x)));
        end.y = round(Math.max(1, Math.min(stage.stageHeight - 1, end.y)));
        var pts = [];
        for (var i = 0; i <= 6; i++) {
            pts.push({ x: round(pt.x + (end.x - pt.x) * i / 6), y: round(pt.y + (end.y - pt.y) * i / 6) });
        }
        return pts;
    }

    function watchSnapshot(o, props) {
        if (!o) return null;
        var out = { hash: hashOf(o) };
        (props && props.length ? props : ["text", "selected", "currentState", "enabled"]).forEach(function (k) {
            try {
                var v = k === "text" ? textOf(o) : o[k];
                if (v !== undefined && v !== null && (typeof v !== "object" || Array.isArray(v))) out[k] = serialize(v, 1);
            } catch (e) {}
        });
        return out;
    }

    function snapshotsEqual(after, before) {
        if (before === null || before === undefined) return after === null || after === undefined;
        if (after === null || after === undefined) return false;
        if (typeof before !== "object") return JSON.stringify(after) === JSON.stringify(before);
        return Object.keys(before).every(function (k) {
            return JSON.stringify(after[k]) === JSON.stringify(before[k]);
        });
    }

    // GuideMask 常挂在 guideMaskLayer 这类与顶层面板平级的图层下，顺着顶层面板找不到，要在舞台范围内找
    function guideMaskIn(panel) {
        // 舞台本身不读 visible/alpha：debug 版 Egret 一读就打 Warning #1009，每次 act 都报「页面报错」
        var stage = getStage();
        function search(root) {
            if (!root) return null;
            if (/guideMask\.GuideMask/i.test(className(root))) return root;
            var found = null;
            walk(root, function (o) {
                if (found) return false;
                if (o !== stage && (!o.visible || o.alpha === 0)) return false;
                if (/guideMask\.GuideMask/i.test(className(o))) found = o;
            });
            return found;
        }
        return search(panel) || search(stage);
    }

    // 挖洞区域：优先用 imgKuang 边框；没有边框时由 shapN 遮罩碎片反推没被盖住的那一格
    function guideHoleRect(panel) {
        var stage = getStage();
        if (!stage) return null;
        var frame = null, bands = [];
        walk(panel, function (o) {
            if (o === panel) return;
            if (!o.visible || o.alpha === 0) return false;
            if (!frame && bindId(o) === "imgKuang") frame = o;
            if (!/^shap\d+$/i.test(nameOf(o) || "")) return;
            var r = stageRect(o);
            if (r && r.width > 2 && r.height > 2) bands.push(r);
        });
        if (frame) {
            var fr = stageRect(frame);
            if (fr && fr.width >= 4 && fr.height >= 4) return fr;
        }
        if (bands.length < 3) return null;
        var xs = [0, stage.stageWidth], ys = [0, stage.stageHeight];
        bands.forEach(function (r) {
            xs.push(Math.max(0, r.x), Math.min(stage.stageWidth, r.x + r.width));
            ys.push(Math.max(0, r.y), Math.min(stage.stageHeight, r.y + r.height));
        });
        var uniq = function (a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }).sort(function (x, y) { return x - y; }); };
        xs = uniq(xs);
        ys = uniq(ys);
        if (xs.length > 10 || ys.length > 10) return null;
        var hole = null;
        for (var xi = 0; xi < xs.length - 1; xi++) {
            for (var yi = 0; yi < ys.length - 1; yi++) {
                if (xs[xi + 1] - xs[xi] < 8 || ys[yi + 1] - ys[yi] < 8) continue;
                var cx = (xs[xi] + xs[xi + 1]) / 2, cy = (ys[yi] + ys[yi + 1]) / 2;
                var covered = bands.some(function (r) {
                    return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
                });
                if (covered) continue;
                var cell = { x: xs[xi], y: ys[yi], width: xs[xi + 1] - xs[xi], height: ys[yi + 1] - ys[yi] };
                hole = hole ? { x: Math.min(hole.x, cell.x), y: Math.min(hole.y, cell.y),
                    width: Math.max(hole.x + hole.width, cell.x + cell.width) - Math.min(hole.x, cell.x),
                    height: Math.max(hole.y + hole.height, cell.y + cell.height) - Math.min(hole.y, cell.y) } : cell;
            }
        }
        if (!hole || (hole.width >= stage.stageWidth * 0.9 && hole.height >= stage.stageHeight * 0.9)) return null;
        return hole;
    }

    function guideTargetOf(topPanel) {
        var panel = guideMaskIn(topPanel);
        if (!panel) return null;
        var r = guideHoleRect(panel);
        if (!r || r.width < 4 || r.height < 4) return null;
        var fractions = [0.5, 0.3, 0.7];
        for (var yi = 0; yi < fractions.length; yi++) {
            for (var xi = 0; xi < fractions.length; xi++) {
                var point = { x: round(r.x + r.width * fractions[xi]), y: round(r.y + r.height * fractions[yi]) };
                var hit = hitTest(point.x, point.y);
                if (!hit || isSelfOrAncestor(panel, hit)) continue;
                var owner = hit, cur = hit;
                for (var depth = 0; cur && depth < 8; depth++) {
                    if (interactionListenersOf(cur).length) {
                        owner = cur;
                        break;
                    }
                    if (/^(egret\.Stage|RootLayer)$/.test(className(cur))) break;
                    cur = cur.parent;
                }
                return {
                    reason: "guide-hole",
                    stagePoint: point,
                    screenPoint: stageToClient(point.x, point.y),
                    hole: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) },
                    target: project(describe(owner, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "source",
                        "touchable", "enabled", "selected", "currentState"]),
                    hit: project(describe(hit, { bounds: false }), ["hash", "className", "id", "name", "qaName", "text", "source"])
                };
            }
        }
        return null;
    }

    function recommendationAt(panel, point, reason, preferred) {
        var hit = hitTest(point.x, point.y);
        var owner = preferred || hit || panel;
        var cur = hit;
        for (var depth = 0; cur && depth < 8 && isSelfOrAncestor(panel, cur); depth++) {
            if (interactionListenersOf(cur).length) {
                owner = cur;
                break;
            }
            cur = cur.parent;
        }
        return {
            reason: reason,
            stagePoint: { x: round(point.x), y: round(point.y) },
            screenPoint: stageToClient(point.x, point.y),
            target: project(describe(owner, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "source",
                "touchable", "enabled", "selected", "currentState"]),
            hit: hit ? project(describe(hit, { bounds: false }), ["hash", "className", "id", "name", "qaName", "text", "source"]) : null
        };
    }

    function dialogueHasDecision(panel) {
        var found = false;
        var pr = stageRect(panel);
        walk(panel, function (o) {
            if (found || o === panel || !effectiveVisible(o)) return;
            var r = stageRect(o);
            if (!r || !pr || r.width * r.height > pr.width * pr.height * 0.45) return;
            var tag = className(o) + " " + (nameOf(o) || "") + " " + (bindId(o) || "") + " " + (qaNameOf(o) || "");
            var text = textOf(o) || "";
            if (!interactionListenersOf(o).length) return;
            if (/auto|skip|speed|close|自动|跳过|倍速|关闭/i.test(tag + " " + text)) return;
            // Dialogue text itself commonly owns the tap listener used to continue.
            // Exclude known continuation labels; other interactive text or option-like
            // controls remain decisions so advance still stops safely at choices.
            if (/talk_txt|talk_name|dialogue.*text|txt.*talk|content.*text|op_tip/i.test(tag)) return;
            // 没有规范命名的对白正文：整句话很长且横跨对话框，不是选项，它自己接管「继续」点击
            if (text.length >= 12 && r.width >= pr.width * 0.4) return;
            if (!text && !/button|btn|option|choice|select|answer|reply|branch|item/i.test(tag)) return;
            found = true;
        });
        return found;
    }

    // 新手遮罩的纯文案提示和 NPC 对话都由整块界面接收点击；把安全点击点直接暴露给 agent，
    // 避免它枚举遮罩碎片，或反复等待复用中的对话面板消失。
    function passiveContinueTargetOf(panel) {
        if (!panel) return null;
        var panelTag = className(panel) + " " + (nameOf(panel) || "") + " " + (bindId(panel) || "");
        var guide = /guideMask\.GuideMask/i.test(panelTag);
        var dialogue = /dialogueIntegration|dialogue(?:Buttom|Bottom)Mixed|npcDialog|plotDialog/i.test(panelTag);
        if (!guide && !dialogue) return null;
        // 出现选项或功能按钮时必须交还给 agent 做语义定位，不能把整块对话面板当“继续”盲点。
        if (dialogue && dialogueHasDecision(panel)) return null;

        var preferred = null, preferredRect = null, largestListener = null, largestArea = 0;
        walk(panel, function (o) {
            if (!effectiveVisible(o)) return false;
            var r = stageRect(o);
            if (!r || r.width < 4 || r.height < 4) return;
            var tag = className(o) + " " + (nameOf(o) || "") + " " + (bindId(o) || "") + " " + (qaNameOf(o) || "");
            if (dialogue && !preferred && /talk_txt|dialogue.*text|txt.*talk|content.*text/i.test(tag)) {
                preferred = o;
                preferredRect = r;
            }
            if (interactionListenersOf(o).length && r.width * r.height > largestArea) {
                largestListener = o;
                largestArea = r.width * r.height;
            }
        });
        var point;
        if (preferredRect) point = { x: preferredRect.x + preferredRect.width / 2, y: preferredRect.y + preferredRect.height / 2 };
        else if (largestListener) {
            var probed = probePoint(largestListener, false);
            var lr = stageRect(largestListener);
            point = probed ? probed.point : { x: lr.x + lr.width / 2, y: lr.y + lr.height / 2 };
            preferred = largestListener;
        } else {
            var stage = requireStage();
            point = { x: stage.stageWidth / 2, y: stage.stageHeight / 2 };
        }
        return recommendationAt(panel, point, dialogue ? "dialogue-continue" : "guide-continue", preferred);
    }

    function continueTargetOf(panel) {
        return guideTargetOf(panel) || passiveContinueTargetOf(panel);
    }

    function continuationSignature(panel, recommendation) {
        var texts = [];
        walk(panel, function (o) {
            if (texts.length >= 6) return false;
            var t = effectiveVisible(o) && textOf(o);
            if (t && texts.indexOf(t) < 0) texts.push(t);
        });
        return [hashOf(panel), recommendation && recommendation.reason, texts.join("|")].join("::");
    }

    function normalizeSemantic(value) {
        return String(value === undefined || value === null ? "" : value).toLowerCase()
            .replace(/[\s\-_./\\:：,，。！？!?()（）\[\]【】]+/g, "");
    }

    function semanticTerms(description) {
        var raw = String(description || "").toLowerCase();
        var phrases = [];
        // Preserve semantic keywords as independent terms before removing filler.
        // Otherwise Chinese task descriptions collapse into one unmatchable token.
        ["任务目标", "主线目标", "剧情目标", "进入游戏", "开始游戏", "立即前往", "回到基地", "返回基地"]
            .concat(Object.keys(SEMANTIC_ALIASES || {}).sort(function (a, b) { return b.length - a.length; }))
            .forEach(function (phrase) {
                if (raw.indexOf(phrase) < 0) return;
                phrases.push(phrase);
                raw = raw.split(phrase).join(" ");
            });
        var ordinal = null;
        var ordinalMatch = raw.match(/第\s*([一二三四五六七八九十\d]+)\s*(?:个|项|只|名)?/);
        if (ordinalMatch) {
            var nums = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
            ordinal = /^\d+$/.test(ordinalMatch[1]) ? +ordinalMatch[1] : nums[ordinalMatch[1]];
            if (ordinal) ordinal--;
        }
        raw = raw.replace(/第\s*[一二三四五六七八九十\d]+\s*(?:个|项|只|名)?/g, " ")
            .replace(/点击|点一下|打开|选择|找到|查找|查看|定位|进入|前往|当前|界面|里面|中的|按钮|控件|入口|图标|那个|这个|一个|目标|角色|地点|的|或|请/g, " ");
        var terms = raw.split(/[^0-9a-z\u3400-\u9fff]+/i).map(normalizeSemantic).filter(function (x) { return x.length >= 2; });
        terms = phrases.concat(terms);
        return { terms: terms.filter(function (x, i) { return terms.indexOf(x) === i; }), ordinal: ordinal };
    }

    var SEMANTIC_ALIASES = {
        "公告": ["notice", "announcement"], "下载": ["download"], "任务": ["task", "quest"],
        "剧情": ["story", "plot"], "主线": ["mainstory", "maintask", "mainquest"],
        "关闭": ["close", "quit", "cancel", "dismiss"], "返回": ["back", "return"],
        "确认": ["confirm", "ok", "yes"], "取消": ["cancel", "no"], "继续": ["continue", "next"],
        "设置": ["setting", "settings", "option"], "登录": ["login", "signin"],
        "账号": ["account"], "客服": ["customer", "service"], "奖励": ["reward", "award"],
        "战斗": ["battle", "fight"], "自动": ["auto"], "跳过": ["skip"],
        "地图": ["map"], "传送": ["transmap", "portal", "teleport", "transfer"],
        "任务目标": ["cachetip", "maptip", "questmarker", "taskmarker"],
        "主线目标": ["cachetip", "maptip", "questmarker", "taskmarker"],
        "剧情目标": ["cachetip", "maptip", "questmarker", "taskmarker"],
        "进入游戏": ["start", "entergame"], "开始游戏": ["start", "entergame"],
        "立即前往": ["go", "goto", "enter"], "回到基地": ["backbase", "returnbase"], "返回基地": ["backbase", "returnbase"],
        "npc": ["npc", "storyinteractobject"],
        // 游戏里常见的入口：图标按钮多半只有英文实例名（btn_petBag、btn_shop），中文描述靠这些对上
        "背包": ["bag", "pack", "knapsack"], "商店": ["shop", "store", "mall"], "商城": ["shop", "store", "mall"],
        "好友": ["friend"], "邮件": ["mail"], "邮箱": ["mail"], "聊天": ["chat"], "签到": ["sign", "checkin"],
        "活动": ["activity", "event"], "排行": ["rank"], "图鉴": ["handbook", "book", "atlas"], "仓库": ["storage", "warehouse", "depot"],
        "宠物": ["pet"], "精灵": ["pet", "spirit", "elf"], "技能": ["skill"], "装备": ["equip"], "队伍": ["team", "lineup"],
        "阵容": ["lineup", "team"], "挑战": ["challenge", "fight"], "扫荡": ["sweep"], "探索": ["explore"], "升级": ["upgrade", "levelup"]
    };

    function semanticVariants(term) {
        return [term].concat(SEMANTIC_ALIASES[term] || []);
    }

    function semanticValues(o, includeDescendants) {
        var out = [];
        function add(kind, value, direct) {
            if (value === undefined || value === null || value === "") return;
            var text = String(value).trim();
            if (!text || out.some(function (x) { return x.kind === kind && x.value === text; })) return;
            out.push({ kind: kind, value: text, direct: !!direct });
        }
        add("text", textOf(o), true);
        add("qaName", qaNameOf(o), true);
        add("id", bindId(o), true);
        add("name", nameOf(o), true);
        add("source", sourceOf(o), true);
        add("className", className(o), true);
        if (includeDescendants) {
            var stack = [], scanned = 0;
            for (var i = numChildren(o) - 1; i >= 0; i--) stack.push(childAt(o, i));
            while (stack.length && out.length < 24 && scanned < 160) {
                var child = stack.pop();
                scanned++;
                if (!child || !effectiveVisible(child)) continue;
                add("text", textOf(child), false);
                add("qaName", qaNameOf(child), false);
                add("id", bindId(child), false);
                add("name", nameOf(child), false);
                add("source", sourceOf(child), false);
                for (var ci = numChildren(child) - 1; ci >= 0; ci--) stack.push(childAt(child, ci));
            }
        }
        return out;
    }

    function semanticActionOwner(o, root) {
        var cur = o, fallback = null;
        // All descendants of one StoryInteractObject represent the same NPC.
        // Resolve the canonical NPC before considering child listeners.
        for (var ownerDepth = 0; cur && ownerDepth < 8; ownerDepth++) {
            var ownerTag = className(cur) + " " + (nameOf(cur) || "");
            if (/storyInteractObject/i.test(ownerTag) || /(^|[_-])npc(?:[_-]|$)/i.test(ownerTag)) return cur;
            if (cur === root || cur === getStage()) break;
            cur = cur.parent;
        }
        cur = o;
        var delegated = null, aboveRoot = 0;
        for (var depth = 0; cur && depth < 12; depth++) {
            if (!aboveRoot) {
                var tag = className(cur) + " " + (nameOf(cur) || "") + " " + (bindId(cur) || "") + " " + (qaNameOf(cur) || "");
                if (!fallback && /button|btn|item|tab|check|toggle|close/i.test(tag)) fallback = cur;
                if (!delegated && depth < 3 && isDelegateTarget(cur)) delegated = cur;
            }
            if (interactionListenersOf(cur).length) {
                // 监听挂在面板根之上：面板按点中的是谁分发（结算页的「再战一次」只是一张有名字的图），只有委托目标算数
                if (aboveRoot) return fallback || delegated;
                if (fallback) return fallback;
                // 监听挂在比它大得多的容器上（地图容器、列表）也是委托：点中的那个有名字的控件才是动作
                if (delegated && delegated !== cur && areaOf(cur) >= areaOf(delegated) * 12) return delegated;
                return cur;
            }
            if (cur === getStage()) break;
            if (cur === root || aboveRoot) {
                if (++aboveRoot > 3) break;
            }
            cur = cur.parent;
        }
        return fallback;
    }

    // 事件委托的目标：自己开着 touchEnabled、有名字（skin part / name，代码里多半靠它判断点的是谁）、
    // 尺寸像个控件而不是背景
    function isDelegateTarget(o) {
        if (!o || o.touchEnabled !== true) return false;
        var name = bindId(o) || nameOf(o);
        if (!name || /^(instance)?\d+$/i.test(name)) return false;
        // 只装着字的容器是标题（地图建筑下面的「星际探索」），不是被委托的按钮：
        // 提成一行正好把 agent 引去点那个点了没反应的标签
        if (onlyText(o)) return false;
        // 底板、底座、选中态、空态这类装饰图也常开着 touchEnabled，名字一看就不是按钮
        if (DECOR_NAME.test(name)) return false;
        var stage = getStage(), a = areaOf(o);
        return a >= 150 && (!stage || a <= stage.stageWidth * stage.stageHeight * 0.15);
    }

    var DECOR_NAME = /(bg|base|empty|shadow|glow|light|effect|frame|line|mask|select|selected|deco|decor)\d*$/i;

    function onlyText(o) {
        if (TEXT_CLASS.test(className(o))) return true;
        var n = numChildren(o);
        if (!n) return false;
        for (var i = 0; i < n; i++) {
            if (!onlyText(childAt(o, i))) return false;
        }
        return true;
    }

    function soleConfirmOf(panel) {
        var rows = (buildActionTable({ peek: true, rootHash: hashOf(panel), limit: 20 })._entries || [])
            .filter(function (e) { return e.role !== "text"; });
        return rows.length === 1 && rows[0].role === "confirm" && rows[0].point ? rows[0] : null;
    }

    function areaOf(o) {
        var r = stageRect(o);
        return r ? r.width * r.height : 0;
    }

    // 把自然语言描述、子树文案/资源名和真实点击监听在页面侧一次聚合，避免 agent 逐个 find/get_tree 试探。
    function locateSemantic(p) {
        var stage = requireStage();
        var root = p.rootHash !== undefined && p.rootHash !== null ? byHash(p.rootHash) : stage;
        var parsed = semanticTerms(p.description);
        var limit = Math.min(Math.max(p.limit !== undefined ? +p.limit : 8, 1), 20);
        var map = {}, serial = 0;
        walk(root, function (o) {
            if (!effectiveVisible(o)) return false;
            var r = stageRect(o);
            if (!r || r.width < 4 || r.height < 4 || r.x + r.width <= 0 || r.y + r.height <= 0 ||
                r.x >= stage.stageWidth || r.y >= stage.stageHeight) return;
            var owner = semanticActionOwner(o, root);
            if (!owner) return;
            var key = String(hashOf(owner));
            if (!map[key]) map[key] = { o: owner, values: [], order: serial++ };
            semanticValues(o, false).forEach(function (value) {
                if (o !== owner) value.direct = false;
                if (!map[key].values.some(function (x) { return x.kind === value.kind && x.value === value.value; })) {
                    map[key].values.push(value);
                }
            });
        });
        var candidates = Object.keys(map).map(function (key) {
            var entry = map[key], o = entry.o;
            semanticValues(o, true).forEach(function (value) {
                if (!entry.values.some(function (x) { return x.kind === value.kind && x.value === value.value; })) entry.values.push(value);
            });
            var ocrText = p.ocrByHash && p.ocrByHash[String(hashOf(o))];
            if (ocrText) entry.values.push({ kind: "ocr", value: String(ocrText), direct: true });
            var direct = semanticValues(o, false);
            var score = 0, evidence = [], matchedTerms = [];
            parsed.terms.forEach(function (term) {
                var best = null, bestScore = 0, bestVariant = null;
                entry.values.forEach(function (value) {
                    var normalized = normalizeSemantic(value.value);
                    if (!normalized) return;
                    semanticVariants(term).forEach(function (variant) {
                        if (normalized.indexOf(variant) < 0) return;
                        var valueScore = value.direct ? 24 : 12;
                        if (normalized === variant) valueScore += 12;
                        if (value.kind === "text") valueScore += 8;
                        else if (/qaName|id|name/.test(value.kind)) valueScore += 5;
                        if (valueScore > bestScore) { bestScore = valueScore; best = value; bestVariant = variant; }
                    });
                });
                if (best) {
                    score += bestScore * (term.length >= 4 ? 2 : 1);
                    matchedTerms.push(term);
                    evidence.push({ term: term, matchedAs: bestVariant, field: best.kind, value: best.value });
                }
            });
            var semanticBlob = entry.values.map(function (value) { return normalizeSemantic(value.value); }).join(" ");
            var ownerTag = className(o) + " " + (nameOf(o) || "");
            var npc = /storyInteractObject/i.test(ownerTag) || /(^|[_-])npc(?:[_-]|$)/i.test(ownerTag);
            var questMarker = npc && /cachetip|maptip|questmarker|taskmarker/.test(semanticBlob);
            var wantsQuestNpc = parsed.terms.some(function (term) {
                return /^(任务目标|主线目标|剧情目标)$/.test(term);
            });
            if (questMarker && wantsQuestNpc) {
                score += 30;
                matchedTerms.push("任务目标");
                evidence.push({ term: "任务目标", matchedAs: "quest-marker", field: "role", value: "quest-npc" });
            }
            var description = normalizeSemantic(p.description);
            direct.forEach(function (value) {
                var normalized = normalizeSemantic(value.value);
                if (description && normalized && (normalized === description || description.indexOf(normalized) >= 0)) score += 10;
            });
            var info = project(describe(o, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "source", "center", "screenRect",
                "touchable", "enabled", "selected", "currentState"]);
            info.score = score;
            info.matchedTerms = matchedTerms;
            info.evidence = evidence.slice(0, 6);
            info.labels = entry.values.filter(function (x) { return /text|source|qaName|id|name|ocr/.test(x.kind); })
                .slice(0, 10).map(function (x) { return { field: x.kind, value: x.value }; });
            info.listeners = interactionListenersOf(o);
            if (questMarker) {
                info.role = "quest-npc";
                info.actionHint = "主线任务标记 NPC，可直接点击 recommendedTarget";
            } else if (/plotguidance|txtdesc/.test(semanticBlob)) {
                info.role = "task-tracker";
                info.actionHint = "先点击任务追踪触发游戏导航，再等待任务文字或地图状态变化";
            }
            info._order = entry.order;
            var hit = info.center ? hitTest(info.center.x, info.center.y) : null;
            if (!reaches(o, hit)) {
                var alt = probePoint(o, true);
                if (alt) info.center = alt.point;
                else {
                    info.occluded = true;
                    info.blocker = hit ? className(hit) + "#" + hashOf(hit) : null;
                }
            }
            return info;
        });
        candidates.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (a.center && b.center && a.center.y !== b.center.y) return a.center.y - b.center.y;
            if (a.center && b.center && a.center.x !== b.center.x) return a.center.x - b.center.x;
            return a._order - b._order;
        });
        var matched = candidates.filter(function (x) { return x.score > 0 && !x.occluded; });
        var selected = parsed.ordinal !== null ? matched[parsed.ordinal] : matched[0];
        var unique = !!selected && parsed.terms.length > 0 && (parsed.ordinal !== null ? matched.length > parsed.ordinal && parsed.terms.length > 1 :
            (!matched[1] || selected.score >= matched[1].score + 12));
        candidates.forEach(function (x) { delete x._order; });
        var canvas = getCanvas();
        var canvasRect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
        return {
            description: p.description,
            terms: parsed.terms,
            requestedIndex: parsed.ordinal,
            devicePixelRatio: window.devicePixelRatio || 1,
            viewportSize: { width: window.innerWidth, height: window.innerHeight },
            captureSize: canvasRect ? {
                width: Math.max(window.innerWidth, canvasRect.left + canvasRect.width),
                height: Math.max(window.innerHeight, canvasRect.top + canvasRect.height)
            } : { width: window.innerWidth, height: window.innerHeight },
            total: candidates.length,
            matched: matched.length,
            ambiguous: !unique,
            reason: unique ? "unique-semantic-match" : selected ? "多个候选接近，请根据 evidence/labels 明确目标后再点" : "没有语义匹配，请缩小 rootHash 或提供界面文案/资源名",
            recommendedTarget: unique ? selected : null,
            candidates: candidates.slice(0, limit)
        };
    }

    function actionableOverlayFor(targets) {
        var top = sceneInfo().top;
        if (!top) return null;
        var recommendedTarget = continueTargetOf(top) || backdropDismissTargetOf(top);
        // 等待的对象若就是当前对话/引导面板，也必须提前返回其继续点击点。
        if (!recommendedTarget && targets.some(function (o) { return isSelfOrAncestor(top, o); })) return null;
        var actionable = !!recommendedTarget || interactionListenersOf(top).length > 0 || !!findCloseControl(top);
        if (!actionable) {
            walk(top, function (o) {
                if (actionable) return false;
                if (effectiveVisible(o) && interactionListenersOf(o).length) actionable = true;
            });
        }
        if (!actionable) return null;
        var result = project(describe(top, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "center",
            "touchable", "enabled", "selected", "currentState"]);
        if (recommendedTarget) result.recommendedTarget = recommendedTarget;
        return result;
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

    // 命中 h 是否等价于点到了 target：目标自身、其子节点或其祖先（点击常由父容器接管）
    function reaches(target, h) {
        return !!(target && h && (isSelfOrAncestor(target, h) || isSelfOrAncestor(h, target)));
    }

    // 在目标包围盒内寻找一个真正能命中目标的点：中心被遮挡、或中心落在名字条等空白处时使用
    function probePoint(target, skipCenter) {
        var r = stageRect(target);
        if (!r || r.width < 2 || r.height < 2) return null;
        var fs = [0.5, 0.35, 0.65, 0.2, 0.8];
        for (var i = 0; i < fs.length; i++) {
            for (var j = 0; j < fs.length; j++) {
                if (skipCenter && i === 0 && j === 0) continue;
                var x = round(r.x + r.width * fs[j]);
                var y = round(r.y + r.height * fs[i]);
                var h = hitTest(x, y);
                if (reaches(target, h)) return { point: { x: x, y: y }, hit: h };
            }
        }
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
    // 点上带 wait 时用它作为到这个点之前的停顿（拖动要先按住一会儿），否则总时长平均分
    async function performGesture(points, method, holdMs, target) {
        var first = points[0], last = points[points.length - 1];
        var stepDelay = points.length > 2 ? holdMs / (points.length - 1) : holdMs;
        var delayAt = function (k) { return points[k].wait !== undefined ? points[k].wait : stepDelay; };
        if (method === "touch") {
            var th = touchHandler();
            if (!th) throw new Error("未找到 Egret TouchHandler，请改用 method=dom");
            th.onTouchBegin(first.x, first.y, TOUCH_ID);
            for (var i = 1; i < points.length; i++) {
                await sleep(delayAt(i));
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
                await sleep(delayAt(j));
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

    // ---------------------------------------------------------------- 高速动作表（observe / act）
    // 借鉴 browser-use/jev-ultrafast：一次快照产出带编号的动作表；执行时按编号复用同一批对象引用，
    // 并用「语义指纹」而不是几何变化判断还是不是决策时看到的那一页，因此持续播放的动画不会让决策作废。

    var lastTable = null;
    // 动作表对外只给编号和标签；hash、坐标和对象引用留在这里，编号靠它解析回真实对象
    var lastEntries = [];

    // 整张表（截断前）每一行的「角色|标签」，挂成不可枚举属性，不进序列化结果。
    // act 前后各取一次对比：页签切换、列表滑入、技能栏上锁这些变化不改面板栈也不改文案，
    // 只看指纹会误报「界面没有变化」，还会劝 agent 再点一次——页签就又切回去了。
    function hideRowKeys(out, keys, entries) {
        try {
            Object.defineProperty(out, "_rowKeys", { value: keys, enumerable: false, configurable: true });
            Object.defineProperty(out, "_entries", { value: entries || [], enumerable: false, configurable: true });
        } catch (e) {}
        return out;
    }

    // peek=true 只看不记：act 执行前要取一次「之前的样子」，不能把 agent 手里的编号冲掉
    function rememberEmpty(p, out) {
        if (!p.peek) {
            lastEntries = [];
            lastTable = out;
        }
        return hideRowKeys(out, ["mode|" + out.mode]);
    }

    // 回合制界面：出招后整组按钮被锁住（父容器 touchChildren=false 或 enabled=false），演出播完才解锁。
    // 这时就返回，agent 看到的是半截演出，只能再 observe / wait 好几轮——回合还带倒计时，慢了直接丢回合。
    // 所以点完之后只要点中的控件被「整组锁住」，就在这里等到能再操作为止。
    function lockedAncestor(o) {
        var stage = getStage();
        for (var q = o && o.parent; q && q !== stage; q = q.parent) {
            if (q.touchChildren === false || q.enabled === false) return q;
        }
        return null;
    }

    // 纯数字的行多是倒计时、血量、计数，变了不代表出现了新的可选项
    var COUNTER_LABEL = /^[\d\s.:/%+\-×x]*$/i;

    // 演出途中冒出来的 buff 图标、状态角标、血条都是没字的小东西，不算「游戏在等你做别的决定」；
    // 换宠栏、选项按钮要么自己带字，要么是头像这种够大的块。借来的标签（nearText）不算自己带字
    function decisionLike(e) {
        if (e.from === "text" || e.from === "childText") return true;
        return Math.min(e._w, e._h) >= 32;
    }

    // 按对象比，不按标签比：演出里血量、换上场的精灵名会让同一个控件的标签一直变，那不是新选项；
    // 新冒出来的控件、原来被挡住现在露出来的控件才是
    function outsideKeys(entries, lock, info) {
        return (entries || []).filter(function (e) {
            return e.role !== "text" && !e.occluded && !COUNTER_LABEL.test(e.label) && decisionLike(e) &&
                !isSelfOrAncestor(lock, e._o);
        }).map(function (e) {
            if (info) {
                var alpha = visualAlpha(e._o);
                if (!(alpha >= 0)) alpha = 100;
                info[e.hash] = { label: e.label, role: e.role, alpha: alpha,
                    textual: e.from === "text" || e.from === "childText",
                    // 位置、大小、透明度：横幅滑入淡出时一直在变，等你选的栏摆好就不动了
                    sig: [round(e._x), round(e._y), round(e._w), round(e._h), alpha].join(",") };
            }
            return String(e.hash);
        });
    }

    function actionableOutside(lock, info) {
        return outsideKeys(buildActionTable({ peek: true, limit: 60 })._entries, lock, info);
    }

    // 冒出来的东西是不是「游戏在等你做决定」：换宠栏是一排带字的选项，提示框有确定 / 关闭；
    // 对手出招时弹出的招式名横幅只有一段字加一个图标（「留情·即无情」「激励·铁碎阵」），验收里 agent 被引去点它
    function looksLikeDecision(list) {
        var textual = list.filter(function (x) { return x.textual; }).length;
        var prompt = list.some(function (x) { return x.role === "confirm" || x.role === "close"; });
        return textual >= 2 || prompt;
    }

    // 见过被锁住的控件组（技能栏）：游戏往往等服务端回包、点完一秒左右才上锁，
    // 只有这些组值得在点完后多等一会儿看锁来不来；普通按钮不白等
    var lockableSeen = {};

    // 锁上过又解开过的组才是「回合锁」；一直锁着的多半是真禁用，不值得等
    var lockToggled = {};

    // 按 hash 记，新开一场战斗技能栏就是新对象，第一招又不等回合（验收里第一招出完 agent 只好自己 observe + wait）。
    // 再按「类名:实例名」记一份，挂在 window 上，扩展重载、换场战斗都还认得：1 = 见过锁住，2 = 锁上过又解开过
    var lockKinds = window.__egretInspectorLockKinds || (window.__egretInspectorLockKinds = {});

    // 没名字的通用容器记下来会一竿子打翻所有 Group 里的点击，这种只按 hash 记
    var GENERIC_CONTAINER = /^(Group|Component|Sprite|DisplayObjectContainer|UIContainer|GComponent|GGroup|Scroller|List)$/;

    function lockKind(q) {
        var cls = shortClass(q), nm = nameOf(q) || "";
        if (GENERIC_CONTAINER.test(cls) && (!nm || /^(instance)?\d*$/.test(nm))) return null;
        return cls + ":" + nm;
    }

    // 转场时整层界面（RootLayer、sceneLayer）也会整个锁一下。它们是所有控件的祖先，记成「会上锁的组」之后，
    // 每次点击都要多等 1.5 秒宽限期看锁来不来（验收里锁类型表混进了 RootLayer:）。回合锁是技能栏这种局部的一组
    function wholeScreen(q) {
        var stage = getStage(), r = stageRect(q);
        return !r || r.width * r.height >= stage.stageWidth * stage.stageHeight * 0.5;
    }

    function noteLock(q, toggled) {
        if (wholeScreen(q)) return;
        var k = lockKind(q);
        if (k) lockKinds[k] = Math.max(lockKinds[k] || 0, toggled ? 2 : 1);
    }

    function rememberLocks(entries) {
        var stage = getStage();
        entries.forEach(function (e) {
            var lock = lockedAncestor(e._o);
            if (lock && !wholeScreen(lock)) {
                lockableSeen[hashOf(lock)] = true;
                noteLock(lock, false);
            }
            for (var q = e._o && e._o.parent; q && q !== stage; q = q.parent) {
                var h = hashOf(q);
                if (lockableSeen[h] && q.touchChildren !== false && q.enabled !== false) {
                    lockToggled[h] = true;
                    noteLock(q, true);
                }
            }
        });
    }

    function turnLock(q) {
        return lockToggled[hashOf(q)] || lockKinds[lockKind(q)] === 2;
    }

    // 点上去时整组还锁着：可能是上一回合的演出没播完（等它解开再点），
    // 也可能是游戏在等你先做别的决定（精灵倒下后的换宠栏）——技能栏会一直锁到你选完，干等只会等到倒计时替你选。
    // 所以和出招后一样盯着新冒出的选项；基准用 agent 做决策时看到的那张表，那之后冒出来的它都没见过
    async function waitForUnlock(o, lock, cap, seenEntries) {
        var top = sceneInfo().top;
        var baseline = seenEntries ? outsideKeys(seenEntries, lock) : actionableOutside(lock);
        return watchLock(o, lock, cap, baseline, top && hashOf(top));
    }

    function knownLockable(o) {
        var stage = getStage();
        for (var q = o && o.parent; q && q !== stage; q = q.parent) {
            // 只见过锁着、没见过解开的多半是真禁用（金币不够的购买组），不是回合锁
            if (turnLock(q) && !wholeScreen(q)) return true;
        }
        return false;
    }

    async function waitForTurn(o, cap, graceMs) {
        var lock = lockedAncestor(o);
        var top = sceneInfo().top, topHash = top && hashOf(top);
        for (var g0 = Date.now(); !lock && graceMs > 0 && Date.now() - g0 < graceMs && o.stage;) {
            await sleep(100);
            lock = lockedAncestor(o);
            // 最后一击直接结算：锁还没来，界面先换了
            var then = sceneInfo().top;
            if (!then || hashOf(then) !== topHash) return { waitedMs: Date.now() - g0, reason: "panel" };
        }
        if (!lock) return null;
        lockableSeen[hashOf(lock)] = true;
        noteLock(lock, false);
        // 锁住的那一块之外、此刻就能点的东西；之后多出来的（比如精灵倒下后的换宠栏）说明游戏在等你做别的决定
        return watchLock(o, lock, cap, actionableOutside(lock), topHash);
    }

    async function watchLock(o, lock, cap, baseline, topHash) {
        var start = Date.now(), polls = 0, reason = "timeout", added = null;
        // 出招名、伤害数字这类横幅一闪就没；等你做决定的东西（换宠栏）会一直摆着。持续 1s 都在才算；
        // 平时隔 400ms 看一次，冒出候选后每 200ms 盯一次，换宠倒计时只有十来秒，发现得越早越好
        var firstSeen = {}, firstSig = {}, pending = false;
        while (Date.now() - start < cap) {
            await sleep(200);
            polls++;
            if (!o.stage) { reason = "rebuilt"; break; }
            if (!lockedAncestor(o)) {
                reason = "unlocked";
                lockToggled[hashOf(lock)] = true;
                noteLock(lock, true);
                break;
            }
            var now = sceneInfo().top;
            if (!now || hashOf(now) !== topHash) { reason = "panel"; break; }
            if (pending || polls % 2 === 0) {
                var info = {}, seen = {}, sigs = {}, at = Date.now();
                added = rowDiff(baseline, actionableOutside(lock, info)).added.filter(function (h) {
                    // 位置或透明度一变就重新计时：还在动的是演出，不是摆好等你选的东西
                    seen[h] = firstSeen[h] && firstSig[h] === info[h].sig ? firstSeen[h] : at;
                    sigs[h] = info[h].sig;
                    return at - seen[h] >= 1000 && info[h].alpha >= 60;
                });
                firstSeen = seen;
                firstSig = sigs;
                pending = Object.keys(seen).length > 0;
                var picked = added.map(function (h) { return info[h]; });
                if (added.length && looksLikeDecision(picked)) {
                    reason = "new-controls";
                    added = picked.slice(0, 4).map(function (x) { return x.label; });
                    break;
                }
            }
        }
        var out = { waitedMs: Date.now() - start, reason: reason };
        if (reason === "new-controls") out.added = added;
        return out;
    }

    function rowDiff(before, after) {
        var left = {};
        (before || []).forEach(function (k) { left[k] = (left[k] || 0) + 1; });
        var added = [];
        (after || []).forEach(function (k) {
            if (left[k]) left[k]--;
            else added.push(k);
        });
        var removed = [];
        Object.keys(left).forEach(function (k) {
            for (var c = 0; c < left[k]; c++) removed.push(k);
        });
        return { added: added, removed: removed };
    }

    // 「少了 challenge_normal；多了 explore_normal」：文字行（血量、计数）变化只算有变化，不逐条列
    function describeRowDiff(diff) {
        function labels(list) {
            return list.filter(function (k) { return k.indexOf("text|") !== 0; })
                .map(function (k) { return k.slice(k.indexOf("|") + 1); }).slice(0, 3);
        }
        var parts = [], gone = labels(diff.removed), come = labels(diff.added);
        if (gone.length) parts.push("少了 " + gone.join("、"));
        if (come.length) parts.push("多了 " + come.join("、"));
        if (!parts.length) parts.push("文字有变化");
        return parts.join("；");
    }

    function hashString(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    function baseName(value) {
        if (!value) return null;
        var s = String(value);
        var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        if (i >= 0) s = s.slice(i + 1);
        s = s.replace(/\.(png|jpg|jpeg|webp|json)$/i, "").trim();
        return s || null;
    }

    function tidy(value, max) {
        if (value === undefined || value === null) return null;
        var s = String(value).replace(/\s+/g, " ").trim();
        return s ? s.slice(0, max || 32) : null;
    }

    // 动作表标签：自身文案 > 子树文案 > qaName 部件名 > id > name > 图片资源名 > 短类名。
    // from 为 text/childText 时是人类可读文案；其余是弱标签，图片字要靠 OCR 补。
    function actionLabelOf(o) {
        var own = tidy(textOf(o));
        if (own) return { label: own, from: "text" };
        var texts = [], source = null, stack = [], scanned = 0;
        for (var i = numChildren(o) - 1; i >= 0; i--) stack.push(childAt(o, i));
        while (stack.length && scanned < 140 && texts.length < 3) {
            var c = stack.pop();
            scanned++;
            if (!c || !c.visible || c.alpha === 0) continue;
            var t = tidy(textOf(c));
            if (t && texts.indexOf(t) < 0) texts.push(t);
            if (!source) source = baseName(sourceOf(c));
            for (var j = numChildren(c) - 1; j >= 0; j--) stack.push(childAt(c, j));
        }
        if (texts.length) return { label: texts.join(" ").slice(0, 32), from: "childText" };
        var qa = qaNameOf(o);
        if (qa) return { label: String(qa).split("__").pop().slice(0, 32), from: "qaName" };
        var id = tidy(bindId(o));
        if (id) return { label: id, from: "id" };
        var nm = tidy(nameOf(o));
        if (nm) return { label: nm, from: "name" };
        var src = baseName(sourceOf(o)) || source;
        if (src) return { label: src.slice(0, 32), from: "source" };
        return { label: shortClass(o), from: "className" };
    }

    var BACK_ROLE_RE = /(?:^|[\s_.\-])(?:back|return)(?:$|[\s_.\-])|返回/i;
    var BACK_ROLE_CAMEL = /[a-z](?:Back|Return)(?:$|[A-Z_\s])/;
    // 明确是「返回」的叫法；只有 return 的可能是「返还」（经验舱的 btn_return 打开的是经验返还）
    var STRONG_BACK_RE = /(?:^|[\s_.\-])back(?:$|[\s_.\-])|[a-z]Back(?:$|[A-Z_\s])|返回/;

    // 控件自己的名字：qaName 的前半截是宿主类名，ExpDeviceReturnSupply__imgFill 不能因为宿主叫 Return 就成了返回键
    function ownIds(o) {
        var qa = qaNameOf(o);
        return (nameOf(o) || "") + " " + (bindId(o) || "") + " " + (qa ? String(qa).split("__").pop() : "");
    }

    // egret.TextField 是所有文字的基类，标题、关卡名也是它：只有 type=input 或输入类组件才算输入框
    function inputLike(o) {
        if (!o) return false;
        var cls = className(o);
        if (/TextInput|EditableText|InputText|EditText/i.test(cls)) return true;
        return /TextField/i.test(cls) && o.type === "input";
    }

    // 关闭 / 确定只从控件名或按钮字上认：「确定要返回基地吗？」是提示正文，不是确定键。
    // 验收里一张提示框被标出两个 confirm，agent 把「返回基地」点成了取消
    function captionRole(re) {
        return function (blob, ids, o, label, tag) {
            return re.test(tag) || (!!label && label.replace(/\s+/g, "").length <= 6 && re.test(label));
        };
    }

    var FAST_ROLES = [
        ["npc", /storyInteractObject|(^|[_-])npc(?:[_-]|$)/i],
        ["input", function (blob, ids, o) { return inputLike(o); }],
        ["close", captionRole(/close|关闭|關閉|quit|dismiss|(?:^|[\s_-])btn_no(?:$|[\s_-])/i)],
        ["confirm", captionRole(/confirm|btn_yes|btn_ok|确定|確定|确认|確認|知道了|好的/i)],
        // 只认实例名 / qaName / 文案，且要成词：类名里的 Return（SeerReturn2Component 是「老兵回归」）
        // 和 background 这类前缀都不算返回键
        ["back", function (blob, ids, o, label) {
            var own = ownIds(o) + " " + (label || "");
            return BACK_ROLE_RE.test(own) || BACK_ROLE_CAMEL.test(own);
        }],
        ["tab", /tab|toggle|switch|radio|check/i],
        ["item", /item|cell|slot|card|grid|list/i]
    ];

    var TEXT_CLASS = /label|textfield|bitmaptext|richtext/i;
    // 红点、角标只是状态指示，从来不是点击目标，但名字里带 red/point/tab 会被当成控件收进来
    var INDICATOR_TAG = /redpoint|red_point|reddot|tab_red|img_red|_red$|(^|[_\-])point$/i;
    // 同一块地方有多行时留谁：界面真文案最有用，其次是角色明确的关闭/确定/返回
    var ROLE_RANK = { confirm: 3, close: 3, back: 3, input: 3, npc: 2, tab: 1, button: 1, item: 0, text: 0 };

    function rowScore(e) {
        return (e.from === "text" || e.from === "childText" ? 4 : 0) + (ROLE_RANK[e.role] || 0);
    }

    var BUTTON_TAG = /button|btn|tab|close|confirm|item|cell/i;

    function actionRoleOf(o, label, from) {
        var ids = (nameOf(o) || "") + " " + (bindId(o) || "") + " " + (qaNameOf(o) || "");
        var tag = className(o) + " " + ids;
        var blob = tag + " " + (label || "");
        var idBlob = ids + " " + (label || "");
        for (var i = 0; i < FAST_ROLES.length; i++) {
            var match = FAST_ROLES[i][1];
            if (typeof match === "function" ? match(blob, idBlob, o, label, tag) : match.test(blob)) return FAST_ROLES[i][0];
        }
        if (BUTTON_TAG.test(tag)) return "button";
        // 弹窗正文、健康游戏忠告这类文字常常也挂着监听，标成 button 会诱导 agent 去点它。
        // 只看界面上真实的文案：qaName/资源名这类弱标签再长也不是正文。
        var realText = from === "text" || from === "childText";
        if (TEXT_CLASS.test(className(o)) || (realText && label.length >= 12)) return "text";
        return "button";
    }

    // 面板里的可见文案：给 agent 当页面正文用（任务描述、对白、数量）
    function panelTexts(root, budget, sink) {
        var texts = [], stack = [], scanned = 0, total = 0, seen = {};
        // 从最上层的子节点开始：弹窗正文是最后加入的子节点，从底层扫会被背景和地图吃光预算
        for (var i = 0; i < numChildren(root); i++) stack.push(childAt(root, i));
        // 输出的文案有字数预算，但给动作表配标签的候选要一直收到扫描上限为止。
        // 收候选时上限放宽：整个舞台当根时 HUD 在最上层，400 个对象扫完了还轮不到地图上的建筑标题
        var scanCap = sink ? 1500 : 400;
        while (stack.length && scanned < scanCap && (total < budget || sink)) {
            var c = stack.pop();
            scanned++;
            if (!c || !c.visible || c.alpha === 0) continue;
            var t = tidy(textOf(c), 60);
            if (t && !seen["#" + t]) {
                seen["#" + t] = 1;
                if (total < budget) {
                    texts.push(t);
                    total += t.length;
                }
                // sink 里带上矩形：给动作表把「压在控件上的那段文字」当标签用
                if (sink) {
                    var tr = stageRect(c);
                    if (tr) sink.push({ text: t, rect: tr, o: c });
                }
            }
            for (var j = 0; j < numChildren(c); j++) stack.push(childAt(c, j));
        }
        return texts;
    }

    // 轻量指纹：只看面板栈、顶层面板与其文案。等待界面稳定时每 60ms 采一次，不能太贵。
    function quickSignature() {
        if (!getStage()) return "nostage";
        var si;
        try {
            si = sceneInfo();
        } catch (e) {
            return "nostage";
        }
        if (!si.top) return "empty#" + si.layers.length;
        return hashString([si.stack.length, hashOf(si.top), className(si.top), numChildren(si.top),
            si.top.currentState || "", panelTexts(si.top, 400).join("|")].join("#"));
    }

    // 列表条目的字段名：只挑标量。名字、等级、数量这类一眼能用来筛选的排最前，
    // 其次是各种 xxxId，其它字段垫后——否则 modelId、featureId 会把 nick、level 挤出前几位
    var FIELD_NAME = /^(name|nick|nickname|title|label|text|desc|level|lv|star|count|num|price|cost|type|state|status|quality|rank)$|name$|level$/i;
    var FIELD_ID = /id$/i;

    function fieldRank(k) {
        return FIELD_NAME.test(k) ? 2 : FIELD_ID.test(k) ? 1 : 0;
    }

    function scalarFields(item, max) {
        if (!item || typeof item !== "object") return [];
        var keys = [];
        for (var k in item) {
            if (k.charAt(0) === "_" || k.charAt(0) === "$") continue;
            var v;
            try { v = item[k]; } catch (e) { continue; }
            var t = typeof v;
            if (t === "string" || t === "number" || t === "boolean") keys.push(k);
        }
        keys.sort(function (a, b) { return fieldRank(b) - fieldRank(a); });
        return keys.slice(0, max);
    }

    // Scroller / List / DataGroup 都可以：返回真正持有 dataProvider 的那一层
    function listOf(target) {
        var o = typeof target === "number" || typeof target === "string" ? byHash(+target) : target;
        if (!o) return null;
        if (o.dataProvider && typeof o.dataProvider.getItemAt === "function") return o;
        var vp = o.viewport;
        if (vp && vp.dataProvider && typeof vp.dataProvider.getItemAt === "function") return vp;
        return null;
    }

    // 读列表背后的全量数据：滚动一屏只看得到几条，靠它去数、去找目标既慢又会漏
    function itemsOf(target, where, opts) {
        var list = listOf(target);
        if (!list) throw new Error("$items 需要 eui.List / DataGroup，或包着它的 Scroller（传 hash 或对象）");
        opts = opts || {};
        var dp = list.dataProvider;
        var total = +dp.length || 0;
        var limit = Math.min(Math.max(opts.limit !== undefined ? +opts.limit : 30, 1), 500);
        var fields = opts.fields || scalarFields(total ? dp.getItemAt(0) : null, 6);
        var pred = null;
        if (typeof where === "function") pred = where;
        else if (where && typeof where === "object") {
            pred = function (it) {
                return !!it && Object.keys(where).every(function (k) { return it[k] === where[k]; });
            };
        }
        var rows = [], matched = 0;
        for (var i = 0; i < total; i++) {
            var it = dp.getItemAt(i);
            if (pred) {
                var ok = false;
                try { ok = !!pred(it, i); } catch (e) {}
                if (!ok) continue;
            }
            matched++;
            if (rows.length >= limit) continue;
            var row = { index: i };
            if (it !== null && typeof it === "object") {
                fields.forEach(function (f) {
                    try { row[f] = it[f]; } catch (e) {}
                });
            } else {
                row.value = it;
            }
            rows.push(row);
        }
        var result = { list: hashOf(list), total: total, matched: matched, fields: fields, rows: rows };
        if (matched > rows.length) result.truncated = true;
        return result;
    }

    // 把列表滚到第 index 条：先按比例跳，再用可见渲染器的 itemIndex 校正
    async function scrollToIndex(scroller, index) {
        var list = listOf(scroller);
        var vp = scroller.viewport || list;
        if (!list || !vp) throw new Error("toIndex 需要一个带 dataProvider 的列表");
        var total = +list.dataProvider.length || 0;
        if (!total) throw new Error("列表是空的");
        index = Math.min(Math.max(Math.round(+index) || 0, 0), total - 1);
        var viewH = scroller.height || vp.height || 0;
        function maxScroll() { return Math.max((vp.contentHeight || 0) - viewH, 0); }
        function visibleRange() {
            var lo = Infinity, hi = -Infinity;
            for (var c = 0; c < numChildren(vp); c++) {
                var r = childAt(vp, c);
                if (!r || !r.visible || typeof r.itemIndex !== "number" || r.itemIndex < 0) continue;
                // 虚拟布局会多留几个渲染器在视口外，按坐标筛掉
                if (r.y + (r.height || 0) <= vp.scrollV || r.y >= vp.scrollV + viewH) continue;
                lo = Math.min(lo, r.itemIndex);
                hi = Math.max(hi, r.itemIndex);
            }
            return lo <= hi ? { lo: lo, hi: hi } : null;
        }
        vp.scrollV = round(maxScroll() * index / Math.max(total - 1, 1));
        for (var pass = 0; pass < 4; pass++) {
            if (typeof vp.validateNow === "function") vp.validateNow();
            await sleep(60);
            var range = visibleRange();
            if (!range || (index >= range.lo && index <= range.hi)) break;
            var span = Math.max(range.hi - range.lo + 1, 1);
            var pitch = viewH / span;
            var delta = index < range.lo ? (index - range.lo) * pitch : (index - range.hi) * pitch;
            vp.scrollV = round(Math.min(Math.max(vp.scrollV + delta, 0), maxScroll()));
        }
        return { index: index, total: total, visible: visibleRange() };
    }

    function scrollersIn(root) {
        var out = [];
        walk(root, function (o) {
            if (out.length >= 4) return false;
            // root 可能就是舞台：舞台的 visible / alpha 一读 debug 版 Egret 就打 Warning #1009
            if (o !== root && (!o.visible || o.alpha === 0)) return false;
            var vp = o.viewport;
            if (!vp) return;
            var r = stageRect(o);
            if (!r || r.width < 40 || r.height < 40) return;
            var entry = { hash: hashOf(o), label: actionLabelOf(o).label,
                size: [round(r.width), round(r.height)] };
            try {
                if (vp.scrollV > 1) entry.canUp = true;
                if (vp.contentHeight - o.height > 1 && vp.scrollV < vp.contentHeight - o.height - 1) entry.canDown = true;
                if (vp.scrollH > 1) entry.canLeft = true;
                if (vp.contentWidth - o.width > 1 && vp.scrollH < vp.contentWidth - o.width - 1) entry.canRight = true;
            } catch (e) {}
            // 列表背后有多少条、每条有哪些字段：模型看到这个才会想到去读数据，而不是滚着数
            try {
                var list = listOf(o);
                if (list && list.dataProvider.length) {
                    entry.items = +list.dataProvider.length;
                    entry.list = hashOf(list);
                    entry.fields = scalarFields(list.dataProvider.getItemAt(0), 6);
                }
            } catch (e) {}
            out.push(entry);
        });
        return out;
    }

    // 列表项（技能条、关卡行、奖励格）里的零件——底图、图标、名字、次数、星星——各挂一个监听，
    // 一个技能就拆成五六行，agent 得自己拼出哪几行是同一个技能。按「最近的列表项祖先」把零件并成一行，
    // 标签是零件上的文字拼起来。带独立文案的按钮（领取、购买、详情）不并，免得把真正要点的动作藏起来。
    var ITEM_CLASS = /item|renderer|cell|slot|card/i;
    var STANDALONE_ROLES = { button: 1, confirm: 1, close: 1, back: 1, tab: 1, input: 1 };

    function isItemHost(o) {
        return !!o && ((typeof o.itemIndex === "number" && o.itemIndex >= 0) || ITEM_CLASS.test(className(o)));
    }

    function itemHostOf(o, stage) {
        if (isItemHost(o)) return o;
        for (var q = o && o.parent, hops = 0; q && q !== stage && hops < 6; q = q.parent, hops++) {
            if (isItemHost(q)) return q;
        }
        return null;
    }

    function realTextRow(e) {
        return e.from === "text" || e.from === "childText" || e.from === "nearText";
    }

    function mergeItemParts(entries, stage) {
        var stageArea = stage.stageWidth * stage.stageHeight;
        var groups = {};
        entries.forEach(function (e) {
            if (STANDALONE_ROLES[e.role] && realTextRow(e) && !COUNTER_LABEL.test(e.label)) return;
            var host = itemHostOf(e._o, stage);
            if (!host) return;
            var hr = stageRect(host);
            if (!hr || hr.width * hr.height > stageArea * 0.2) return;
            var key = String(hashOf(host));
            (groups[key] = groups[key] || { host: host, members: [] }).members.push(e);
        });
        var gone = {};
        Object.keys(groups).forEach(function (key) {
            var g = groups[key];
            if (g.members.length < 2) return;
            var rep = g.members.filter(function (e) { return e._o === g.host; })[0] ||
                g.members.slice().sort(function (a, b) { return b._w * b._h - a._w * a._h; })[0];
            // 列表项自己已经有一段真文字（背包格子「LV.57 闪光阿兹 无」）：留它，别再把悬浮详情里的字拼上去
            if (rep._o === g.host && realTextRow(rep)) {
                if (rep.role === "text") rep.role = "item";
                g.members.forEach(function (e) { if (e !== rep) gone[e.hash] = true; });
                return;
            }
            var texts = [];
            g.members.slice().sort(function (a, b) {
                return Math.abs(a._y - b._y) > 8 ? a._y - b._y : a._x - b._x;
            }).forEach(function (e) {
                if ((realTextRow(e) || e.role === "text") && texts.indexOf(e.label) < 0) texts.push(e.label);
            });
            if (texts.length) {
                if (rep.label !== texts.join(" ")) rep.alt = rep.alt || rep.label;
                rep.label = tidy(texts.join(" "), 32);
                rep.from = "childText";
            } else if (/^(UIContainer|Group|Component|Image|Sprite|DisplayObjectContainer)$/.test(rep.label)) {
                // 零件上一个字都没有（名字是贴图）：至少告诉 agent 这是哪一类列表项
                rep.label = shortClass(g.host);
            }
            if (rep.role === "text") rep.role = "item";
            g.members.forEach(function (e) { if (e !== rep) gone[e.hash] = true; });
        });
        return entries.filter(function (e) { return !gone[e.hash]; });
    }

    // 弱标签的行借用「挂在它身上的那段字」当标签。两种常见摆法：列表项、菜单把名字放在同级 Label 里、压在行上；
    // 地图建筑把名字放在热区正下方或跨在底边上（星际探索、星际邮箱）。此前只认完全落在框内、且面积占 3% 以上的字，
    // 「太空站」「战队」这种短名字和框外的标题都借不到，agent 只能去点那个点了没反应的标题。
    // 每段字只归最近的一个热区；借走之后，标题自己那一行从表里去掉。
    var CAPTION_MAX = 16;
    // 专门用来接点击的透明热区的命名习惯
    var HOTSPOT_NAME = /(?:^|[_\-\s])(?:rect|hit|hitarea|hotspot|hot|area|touch|click)\d*(?:$|\s)|hitArea/i;

    // 像标题的行：标签就是它自己的字、短、矮、自己没挂监听（被上层容器委托才进的表）。
    // 地图建筑下面「底板 + 文字」的「星际探索」就是这样，结构上和靠委托的按钮分不开，只能靠旁边有没有热区来判断
    function captionLike(e) {
        return (e.from === "text" || e.from === "childText") && e.label.length <= CAPTION_MAX &&
            e._h <= 48 && !interactionListenersOf(e._o).length;
    }

    function borrowCaptions(entries, textNodes, stage) {
        var stageArea = stage.stageWidth * stage.stageHeight;
        // 已经是别的按钮自己的文案，就不是谁的标题
        var owned = {};
        entries.forEach(function (e) {
            if ((e.from === "text" || e.from === "childText") && e.role !== "text" && !captionLike(e)) owned[e.label] = true;
        });
        // 文字挂在哪个控件里：HUD 图标下面的「限时签到」是那个图标自己的字，不能被地图上的热区借走
        var controls = {};
        entries.forEach(function (e) {
            if (e.role !== "text" && !captionLike(e) && e._w * e._h <= stageArea * 0.25) controls[e.hash] = e;
        });
        textNodes.forEach(function (t) {
            for (var q = t.o, hops = 0; q && hops < 10; q = q.parent, hops++) {
                if (controls[hashOf(q)]) {
                    t.ownerHash = hashOf(q);
                    break;
                }
            }
        });
        // 专门做点击用的热区（pve_rect、hitArea）和压在它上面的动画体、图片抢同一个名字时，名字归热区：
        // 验收里「星际探索」被飞船的 Spine 本体 pve 借走，agent 点了没反应，真正响应的是 pve_rect
        var hotspots = entries.filter(function (e) { return !e.occluded && HOTSPOT_NAME.test(ownIds(e._o)); });
        function coveredByHotspot(e) {
            if (HOTSPOT_NAME.test(ownIds(e._o))) return false;
            return hotspots.some(function (h) {
                var w = Math.min(e._x + e._w, h._x + h._w) - Math.max(e._x, h._x);
                var hh = Math.min(e._y + e._h, h._y + h._h) - Math.max(e._y, h._y);
                return w > 0 && hh > 0 && w * hh >= 0.3 * Math.min(e._w * e._h, h._w * h._h);
            });
        }
        var pairs = [];
        entries.forEach(function (e, ei) {
            // 被挡住的行默认不出现在表里：让它借走标题，标题就跟着一起消失了（飞船的 Spine 本体和它的热区抢「星际探索」）。
            // 只有类名、没有实例名的对象多是地图上走动的角色（跟随精灵 Pet、Nono），走到哪个建筑旁边就会抢走它的名字
            if (e.from === "text" || e.from === "childText" || e.from === "className" || e.occluded) return;
            if (coveredByHotspot(e)) return;
            var area = e._w * e._h;
            if (!area || area > stageArea * 0.25) return;
            var bottom = e._y + e._h, centerX = e._x + e._w / 2;
            textNodes.forEach(function (t, ti) {
                var s = String(t.text || "").trim();
                if (!s || s.length > CAPTION_MAX || COUNTER_LABEL.test(s) || owned[s]) return;
                if (t.ownerHash !== undefined && t.ownerHash !== e.hash) return;
                var tr = t.rect, cx = tr.x + tr.width / 2;
                if (cx < e._x - 2 || cx > e._x + e._w + 2) return;
                var inside = tr.x >= e._x - 1 && tr.y >= e._y - 1 &&
                    tr.x + tr.width <= e._x + e._w + 1 && tr.y + tr.height <= bottom + 1;
                var below = tr.y >= e._y + e._h * 0.5 && tr.y <= bottom + Math.max(36, e._h * 0.35);
                if (!inside && !below) return;
                // 越贴底边、越居中越像它的名字；框内的同分时取字大的
                var score = (inside ? 0 : 5 + Math.max(0, tr.y - bottom)) +
                    20 * Math.abs(cx - centerX) / Math.max(e._w, 1) - Math.min(tr.width * tr.height / 1000, 2);
                pairs.push({ ei: ei, ti: ti, score: score });
            });
        });
        pairs.sort(function (a, b) { return a.score - b.score; });
        var usedEntry = {}, usedText = {}, captions = {};
        pairs.forEach(function (pr) {
            if (usedEntry[pr.ei] || usedText[pr.ti]) return;
            usedEntry[pr.ei] = usedText[pr.ti] = true;
            var e = entries[pr.ei], t = textNodes[pr.ti];
            e.alt = e.label;
            e.label = tidy(t.text, 32);
            e.from = "nearText";
            captions[e.label] = true;
        });
        // 被借走的标题自己那一行（点了没反应）去掉，免得 agent 去点它
        return entries.filter(function (e) {
            return e.from === "nearText" || !((e.role === "text" || captionLike(e)) && captions[e.label]);
        });
    }

    // 全屏 HUD（主城工具栏）只在四周摆按钮，中间是透明的，点下去落在地图上。按面积它是「全屏面板」，
    // 当成模态就把地图上的入口（星际探索的飞船、各种建筑）整个挡在动作表外面，agent 只能去点地图上的文字标签。
    // 在中间区域打一片点：大多数点穿过它落到下层、且下层不是遮罩，它就不是模态。
    // 占住大半个舞台、点不穿的才算模态面板；主城 HUD 这种四周摆按钮、中间透明的不算
    function isModalPanel(o) {
        var stage = getStage(), r = o && stageRect(o);
        return !!(r && r.width * r.height >= stage.stageWidth * stage.stageHeight * 0.6) && !passesThrough(o, r);
    }

    function passesThrough(panel, r) {
        // 取样只在面板和舞台的交集里：滚动列表的内容能把面板包围盒撑到几百万像素宽（星际探索面板实测 7864355px），
        // 按比例取的点全落在舞台外，命中的是 stage 本身，会被误算成「穿透」
        var stage = getStage();
        var x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0);
        var x1 = Math.min(r.x + r.width, stage.stageWidth), y1 = Math.min(r.y + r.height, stage.stageHeight);
        if (x1 - x0 < 20 || y1 - y0 < 20) return false;
        var through = 0, total = 0;
        [0.25, 0.375, 0.5, 0.625, 0.75].forEach(function (fx) {
            [0.3, 0.5, 0.7].forEach(function (fy) {
                var hit = hitTest(round(x0 + (x1 - x0) * fx), round(y0 + (y1 - y0) * fy));
                total++;
                if (!hit || hit === stage || isSelfOrAncestor(panel, hit)) return;
                for (var q = hit, hops = 0; q && hops < 4; q = q.parent, hops++) {
                    if (BACKDROP_RE.test(className(q) + " " + (nameOf(q) || "") + " " + (qaNameOf(q) || ""))) return;
                }
                through++;
            });
        });
        return total > 0 && through >= total * 0.6;
    }

    // 超出 limit 时按重要性挑，而不是按阅读顺序切：列表项上的小字标签（role text）一个面板能有几十条，
    // 按顺序切会把真正的按钮挤出表外（经验舱的「快速升级」曾排到第 51 位，默认 30 行根本轮不到）。
    // 挑完仍按阅读顺序排回去，编号照旧从上到下。
    var TRUNCATE_RANK = { close: 0, back: 0, confirm: 0, input: 1, button: 2, tab: 2, npc: 2, item: 3, text: 4 };

    // 没字的小图标（buff、状态角标、属性图标）占着行却很少是要点的；
    // 战斗里一排十几个，会把「请选择替换的精灵」这种真选项挤出表外
    // 只认长宽都小的方块：精灵详情里的升级键是 51×23 的扁按钮，按「最短边 < 28」会被当成图标挤出表外，
    // agent 在详情页找不到升级键，整轮验收一只都没升成
    function tinyIcon(e) {
        if (e.from === "text" || e.from === "childText" || e.from === "nearText") return false;
        return e.role === "button" && e._w !== undefined && Math.max(e._w, e._h) < 32;
    }

    function pickWithinLimit(entries, limit) {
        if (entries.length <= limit) return entries;
        var ranked = entries.map(function (e, at) {
            var rank = TRUNCATE_RANK[e.role] !== undefined ? TRUNCATE_RANK[e.role] : 2;
            if (tinyIcon(e)) rank = 5;
            return { at: at, rank: rank + (e.occluded ? 10 : 0) };
        });
        ranked.sort(function (a, b) { return a.rank - b.rank || a.at - b.at; });
        var chosen = {};
        ranked.slice(0, limit).forEach(function (x) { chosen[x.at] = true; });
        return entries.filter(function (e, at) { return chosen[at]; });
    }

    function panelBrief(o, stage) {
        var out = { hash: hashOf(o), className: shortClass(o) };
        var qa = qaNameOf(o) || bindId(o) || nameOf(o);
        if (qa) out.name = tidy(qa);
        if (o.currentState) out.state = o.currentState;
        var r = stageRect(o);
        if (r && r.width >= stage.stageWidth * 0.9 && r.height >= stage.stageHeight * 0.9) out.fullscreen = true;
        return out;
    }

    // 一次快照产出带编号的动作表：语义动作宿主去重、标签、状态、已解遮挡的点击点和语义指纹。
    function buildActionTable(p) {
        var stage = requireStage();
        var si = sceneInfo();
        var scoped = p.rootHash !== undefined && p.rootHash !== null;
        // 顶层「面板」可能只是一块浮动提示；这种时候把整个舞台都收进动作表，
        // 否则地图上的 NPC、入口这些真正的目标会被漏掉。占住大半个舞台的才当模态处理。
        var modal = isModalPanel(si.top);
        var root = scoped ? byHash(p.rootHash) : (modal ? si.top : stage);
        // 整个舞台进表时（主城：HUD + 地图）三十行装不下：按阅读顺序截，屏幕最下面那排工具栏（背包、商店、任务）
        // 整排被挤掉，agent 找背包花了十一次调用。没指定行数时给到上限
        var limit = Math.min(Math.max(p.limit !== undefined && p.limit !== null ? +p.limit : (scoped || modal ? 30 : 60), 1), 60);
        var out = {
            // 每次注入换一个：页面一重载，server 就能看出上一轮的 i 编号和 hash 全部作废
            bootId: BOOT_ID,
            // Splan 项目（页面有全局 MFC）：server 据此在 observe 里指向 splan-control 技能
            project: window.MFC ? "splan" : undefined,
            // server 记路线用：和 act 每步记下的 from 同一口径
            topKey: panelKey(si.top),
            stageSize: [stage.stageWidth, stage.stageHeight],
            panel: si.top ? panelBrief(si.top, stage) : null,
            stack: si.stack.map(function (o) { return panelBrief(o, stage); }),
            mode: "normal",
            scope: scoped ? "subtree" : modal ? "panel" : "stage",
            actions: []
        };
        // 后台标签页里 rAF 会被节流，加载和动画会看起来卡住：明确告诉调用方，而不是让它一直等
        if (document.hidden) out.warnings = ["页面在后台，浏览器会节流游戏动画与加载；请用户把浏览器窗口恢复到前台"];
        if (!root) {
            out.mode = "empty";
            out.marker = "empty";
            return rememberEmpty(p, out);
        }
        var textNodes = [];
        out.text = panelTexts(root, 600, textNodes);

        // 只有一个合法目标时就只给这一个：与 jev「只提供受支持的操作与目标」一致，避免瞎点遮罩碎片
        // 顺序有讲究：对白/引导 > 加载过场 > 只能点遮罩关闭的弹窗。
        // 否则战斗/地图的加载页会被当成「可以点遮罩关掉的弹窗」。
        var recommendedTarget = scoped ? null : continueTargetOf(si.top);
        var transientOverlay = null;
        if (!scoped && !recommendedTarget) {
            transientOverlay = transientOverlayOf(si.top);
            if (!transientOverlay) recommendedTarget = backdropDismissTargetOf(si.top);
        }
        if (recommendedTarget) {
            out.mode = recommendedTarget.reason;
            out.recommendedTarget = recommendedTarget;
            // 引导挖洞和点任意处继续的对白确实只有一个合法目标，直接给它，不要让 agent 乱点。
            // 「只能点遮罩关闭」只是推测，弹窗里通常仍有关闭/确定/领取按钮：继续把动作表一起给出，
            // 否则遮罩点不动时 agent 手里什么都没有，只能空转。
            if (recommendedTarget.reason !== "modal-backdrop-dismiss") {
                out.marker = hashString([out.mode, si.top && hashOf(si.top), out.text.join("|")].join("#"));
                out.hint = recommendedTarget.reason === "guide-hole"
                    ? "引导挖洞：只能点 recommendedTarget，用 egret_act 的 {op:\"recommended\"}"
                    : "连续对白/引导：用 egret_act 的 op=advance 一次推完，不要逐次点击";
                return rememberEmpty(p, out);
            }
            out.hint = "没有识别到关闭控件：优先用动作表里的关闭/确定/领取按钮，都不行再用 egret_act 的 {op:\"recommended\"} 点遮罩";
        }
        if (transientOverlay) {
            out.mode = "transient";
            out.transientOverlay = transientOverlay;
            out.marker = hashString(["transient", si.top && hashOf(si.top), out.text.join("|")].join("#"));
            out.hint = "地图标题/加载过场，没有安全点击目标：用 op=wait 短等后看返回的新动作表";
            return rememberEmpty(p, out);
        }

        // 发现阶段的上限不能跟展示 limit 绑死：limit 调小只应该少显示几行，
        // 不能让还没扫到的弹窗按钮整个消失（limit=10 时「确定」按钮曾经就这样丢掉）。
        // 整个舞台当根时（主城 HUD + 地图）控件多得多，HUD 在最上层会先把名额用光，地图入口就轮不到了
        var discoverCap = Math.max(limit * 3, root === stage ? 300 : 120);
        var seen = {}, owners = [], order = 0;
        walk(root, function (o) {
            if (o === root) return;
            if (!o.visible || o.alpha === 0) return false;
            if (owners.length >= discoverCap) return false;
            var r = stageRect(o);
            if (!r || r.width < 6 || r.height < 6) return;
            if (r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= stage.stageWidth || r.y >= stage.stageHeight) return;
            // semanticActionOwner 只在有真实点击监听或命名像控件时返回宿主，天然滤掉装饰节点
            var owner = semanticActionOwner(o, root);
            if (!owner || owner === root) return;
            var key = String(hashOf(owner));
            if (seen[key]) return;
            seen[key] = true;
            owners.push({ o: owner, order: order++ });
        }, true);

        // FairyGUI 这类框架的父链上带着 visible=false 的容器，显示列表遍历会在那里被剪掉，
        // 把真正能点的控件（常见的就是弹窗右上角的关闭按钮）整个漏掉。
        // 引擎自己的命中检测才是基准：在面板范围内扫一遍网格，把漏掉的动作宿主补回来。
        var sweepRect = root === stage ? { x: 0, y: 0, width: stage.stageWidth, height: stage.stageHeight } : stageRect(root);
        if (sweepRect) {
            var sx0 = Math.max(0, sweepRect.x), sy0 = Math.max(0, sweepRect.y);
            var sx1 = Math.min(stage.stageWidth, sweepRect.x + sweepRect.width);
            var sy1 = Math.min(stage.stageHeight, sweepRect.y + sweepRect.height);
            // 网格步长要小于常见按钮，否则 40px 的关闭按钮会整好从网眼里漏过去
            var points = [], cols = 20, rows = 14;
            for (var ci = 0; ci <= cols; ci++) {
                for (var ri = 0; ri <= rows; ri++) {
                    points.push([sx0 + (sx1 - sx0) * ci / cols, sy0 + (sy1 - sy0) * ri / rows]);
                }
            }
            // 关闭按钮几乎总贴在左右边缘靠上的位置，这两条竖带再加密一遍
            [0.03, 0.06, 0.10, 0.90, 0.94, 0.97].forEach(function (fx) {
                [0.04, 0.08, 0.12, 0.17, 0.22, 0.88, 0.94].forEach(function (fy) {
                    points.push([sx0 + (sx1 - sx0) * fx, sy0 + (sy1 - sy0) * fy]);
                });
            });
            // 网格扫描单独留一份名额：它补的正是遍历漏掉的东西，不能因为遍历先用满了就整个跳过
            for (var pi = 0; pi < points.length && owners.length < discoverCap + 80; pi++) {
                var hit = hitTest(round(points[pi][0]), round(points[pi][1]));
                if (!hit) continue;
                var hitOwner = semanticActionOwner(hit, root);
                if (!hitOwner || hitOwner === root || hitOwner === stage) continue;
                if (root !== stage && !isSelfOrAncestor(root, hitOwner)) continue;
                var hitKey = String(hashOf(hitOwner));
                if (seen[hitKey]) continue;
                seen[hitKey] = true;
                owners.push({ o: hitOwner, order: order++ });
            }
        }

        var probed = 0;
        var entries = [], offstage = 0, indicators = 0, textOnly = [], faded = 0;
        owners.forEach(function (item) {
            var o = item.o;
            var r = stageRect(o);
            if (!r || r.width < 4 || r.height < 4) return;
            // Egret 命中测试不看透明度：淡出到几乎透明的横幅照样点得中、进得了表，玩家却看不见（验收里 agent 去点屏幕上没有的「激励·铁碎阵」）
            var seenAlpha = visualAlpha(o);
            if (seenAlpha >= 0 && seenAlpha < 10) {
                offstage++;
                faded++;
                return;
            }
            var label = actionLabelOf(o);
            var entry = {
                hash: hashOf(o),
                role: actionRoleOf(o, label.label, label.from),
                label: label.label,
                from: label.from,
                size: [round(r.width), round(r.height)],
                _y: r.y, _x: r.x, _w: r.width, _h: r.height, _o: o
            };
            if (o.enabled === false) entry.off = true;
            if (o.selected === true) entry.on = true;
            var drag = dragTargetOf(o);
            if (drag) entry.drag = drag.dir;
            if (o.currentState && o.currentState !== "up" && o.currentState !== "normal") entry.st = o.currentState;
            if (p.rects) entry.screenRect = screenRect(r);
            var point = { x: round(r.x + r.width / 2), y: round(r.y + r.height / 2) };
            var hit = hitTest(point.x, point.y);
            if (!reaches(o, hit)) {
                var alt = probed++ < 24 ? probePoint(o, true) : null;
                if (alt) point = alt.point;
                else {
                    entry.occluded = true;
                    entry.blocker = hit ? shortClass(hit) + "#" + hashOf(hit) : null;
                }
            }
            // 红点角标：小块的指示图直接丢掉，不占编号
            if (r.width < 32 && r.height < 32 &&
                INDICATOR_TAG.test(nameOf(o) || bindId(o) || qaNameOf(o) || shortClass(o) || "")) {
                indicators++;
                return;
            }
            // 点在舞台外的条目点不到（地图容器伸出舞台的边缘格子），只会让 agent 白点一轮
            if (point.x < 0 || point.y < 0 || point.x > stage.stageWidth || point.y > stage.stageHeight) {
                offstage++;
                return;
            }
            // 没有自己的点击监听的纯文字节点是正文，不是按钮：并进 text，别占动作编号
            if (entry.role === "text" && !interactionListenersOf(o).length) {
                if (textOnly.indexOf(label.label) < 0) textOnly.push(label.label);
                return;
            }
            entry.point = point;
            entries.push(entry);
        });
        if (textOnly.length) {
            textOnly.forEach(function (t) { if (out.text.indexOf(t) < 0) out.text.push(t); });
        }
        entries = borrowCaptions(entries, textNodes, stage);
        rememberLocks(entries);
        // 祖先-后代去重：容器和它装的按钮不该各占一行，同名的父子只留一行
        var indexed = {}, descendants = {};
        entries.forEach(function (e) { indexed[e.hash] = e; });
        entries.forEach(function (e) {
            var cur = e._o.parent, guard = 0;
            while (cur && guard++ < 12) {
                var ancestor = indexed[hashOf(cur)];
                if (ancestor) (descendants[ancestor.hash] = descendants[ancestor.hash] || []).push(e);
                cur = cur.parent;
            }
        });
        var dropped = {};
        entries.forEach(function (e) {
            var kids = descendants[e.hash] || [];
            if (!kids.length) return;
            var container = /group|container|list|scroller|view|layer|sprite/i.test(className(e._o)) ||
                !interactionListenersOf(e._o).length;
            if (kids.length >= 2 && container) {
                dropped[e.hash] = true;
                return;
            }
            kids.forEach(function (kid) {
                if (dropped[kid.hash] || dropped[e.hash]) return;
                // 文案相同而外面那层又大又空：那是弹窗面板把正文当了标签，留里面那个。
                // 只看比例会把普通按钮也算进来（54x59 的按钮套着 22x11 的文字），
                // 所以还要求外层本身占掉舞台的一大块——按钮不会有那么大。
                if (kid.label === e.label && e._w * e._h > kid._w * kid._h * 4 &&
                    e._w * e._h >= stage.stageWidth * stage.stageHeight * 0.15) {
                    dropped[e.hash] = true;
                    return;
                }
                // 页签常被拆成「容器 + click_state + 背景图」好几行，占着差不多同一块地方：
                // 这种只留一行，留标签信息量大的那个，一样就留外面那层（更大的点击目标）
                if (kid._w * kid._h >= e._w * e._h * 0.5) {
                    var sk = rowScore(kid), se = rowScore(e);
                    // 外层只是委托里的壳（自己没监听、名字也不像控件），里面那个才叫得出是什么：
                    // 战斗工具栏按 e.target 分发，ps_grp 里显示的是 petBtn，表里写 ps_grp 时 agent 认不出这是换宠键
                    var shell = sk === se && !interactionListenersOf(e._o).length &&
                        BUTTON_TAG.test(ownIds(kid._o)) && !BUTTON_TAG.test(ownIds(e._o));
                    dropped[sk > se || shell ? e.hash : kid.hash] = true;
                    return;
                }
                if (kid.label === e.label) dropped[kid.hash] = true;
            });
        });
        entries = entries.filter(function (e) { return !dropped[e.hash]; });
        entries = mergeItemParts(entries, stage);
        // 两个「返回」时 agent 会挑错：经验舱里 grp_back_landscape 才是返回，btn_return 是「经验返还」。
        // 表里已有明确叫 back / 返回 的，只凭 return 认出来的那些降成普通按钮
        var strongBack = function (e) { return STRONG_BACK_RE.test(ownIds(e._o) + " " + e.label); };
        if (entries.some(function (e) { return e.role === "back" && strongBack(e); })) {
            entries.forEach(function (e) { if (e.role === "back" && !strongBack(e)) e.role = "button"; });
        }

        // 阅读顺序（先上后左），被遮挡的排到最后
        entries.sort(function (a, b) {
            if (!!a.occluded !== !!b.occluded) return a.occluded ? 1 : -1;
            if (Math.abs(a._y - b._y) > 12) return a._y - b._y;
            return a._x - b._x;
        });
        // 奖励格子这类一模一样的条目会几十个地刷屏，把真正的按钮挤出表外：同款各留前三个。
        // 六个以内的不折：换宠栏五只精灵标签都是「等级:100」，折掉后两只，活着的恰好全在后面。
        // alt 不同就不是同款（petDie 和 headIcon 是死的和活的）
        function repeatKey(e) { return e.role + "|" + e.label + "|" + (e.alt || "") + "|" + e.size.join("x"); }
        var groupSize = {}, repeats = {}, collapsed = 0;
        entries.forEach(function (e) {
            if (!e.occluded) groupSize[repeatKey(e)] = (groupSize[repeatKey(e)] || 0) + 1;
        });
        entries = entries.filter(function (e) {
            if (e.occluded) return true;
            var key = repeatKey(e);
            repeats[key] = (repeats[key] || 0) + 1;
            if (groupSize[key] <= 6 || repeats[key] <= 3) return true;
            collapsed++;
            return false;
        });
        // 「整张表都被同一个对象挡住」要在丢掉遮挡项之前判断
        var allOccluded = entries.length >= 3 && !entries.some(function (e) { return !e.occluded; });
        var occludedHidden = 0;
        if (!allOccluded && !p.occluded) {
            // 被遮挡的条目 egret_act 本来就拒绝点击：默认只留计数，不占动作编号也不占上下文
            var kept = entries.filter(function (e) { return !e.occluded; });
            occludedHidden = entries.length - kept.length;
            entries = kept;
        }
        out.omitted = Math.max(0, entries.length - limit) + collapsed + offstage + indicators;
        if (collapsed) out.collapsed = collapsed;
        if (occludedHidden) out.occludedHidden = occludedHidden;
        var visibleEntries = entries.filter(function (e) { return !e.occluded; });
        var rowKeys = visibleEntries.map(function (e) { return e.role + "|" + e.label; });
        entries = pickWithinLimit(entries, limit);
        entries.forEach(function (entry, i) { entry.i = i + 1; });
        if (!p.peek) lastEntries = entries;
        // 系统提示框（一段话 + 确定 / 取消）点遮罩关不掉：表里有确定、取消、关闭键就不再推荐点遮罩，
        // 否则 agent 每次都先点一下遮罩白花一轮
        if (out.mode === "modal-backdrop-dismiss" && visibleEntries.some(function (e) {
            return e.role === "confirm" || e.role === "close" || /cancel|取消/i.test(e.label || "");
        })) {
            out.mode = "normal";
            delete out.recommendedTarget;
            delete out.hint;
        }
        // 默认只给「编号 + 标签 + 角色 + 状态」：按编号决策时 hash/point/size 是死重量，
        // 摆在眼前还会把模型引到 find/get_node 这些慢路径上去。detail=true 时才带回来。
        var detail = !!p.detail;
        out.actions = entries.map(function (e) {
            var row = { i: e.i, label: e.label, role: e.role };
            if (e.off) row.off = true;
            if (e.on) row.on = true;
            if (e.st) row.st = e.st;
            if (e.occluded) row.occluded = true;
            if (e.drag) row.drag = e.drag;
            if (e.from !== "text" && e.from !== "childText" && e.from !== "nearText") row.weak = true;
            if (e.alt) row.alt = e.alt;
            // rects 是 server 做 OCR 时要的：它也得拿到 hash 和 from 才能把识别结果写回来
            if (detail || p.rects) {
                row.hash = e.hash;
                row.from = e.from;
                if (e.screenRect) row.screenRect = e.screenRect;
            }
            if (detail) {
                row.point = e.point;
                row.size = e.size;
                if (e.blocker) row.blocker = e.blocker;
            }
            return row;
        });
        // 全是弱标签时 server 会自动补一次本地 OCR，不用模型再花一轮决定要不要 OCR
        var strongLabels = 0, weakLabels = 0;
        entries.forEach(function (e) {
            if (e.occluded || e.role === "text") return;
            if (e.from === "text" || e.from === "childText" || e.from === "nearText") strongLabels++;
            else weakLabels++;
        });
        if (weakLabels >= 3 && weakLabels >= strongLabels * 3) out.needOcr = true;
        // 已经作为动作列出来的文案不必在 text 里再抄一遍（标签有截断，按前缀比）
        out.text = out.text.filter(function (t) {
            return !entries.some(function (e) { return t.indexOf(e.label) === 0 || e.label.indexOf(t) === 0; });
        });
        // 整张表都被同一个对象挡住：可能是过场遮罩，也可能是「点任意处继续」的全屏接管层
        if (allOccluded) {
            out.mode = "blocked";
            out.blocker = entries[0] && entries[0].blocker;
            var center = { x: stage.stageWidth / 2, y: stage.stageHeight / 2 };
            var catcher = hitTest(center.x, center.y);
            var catcherRect = catcher && stageRect(catcher);
            // 全屏接管层的监听常挂在 stage 上（战斗入场演出的「点任意处跳过」），
            // 所以只看它自己有没有监听会漏；能接收触摸的全屏层就当成可点
            if (catcher && catcherRect && catcherRect.width >= stage.stageWidth * 0.9 &&
                catcherRect.height >= stage.stageHeight * 0.9 && effectiveTouchable(catcher)) {
                out.recommendedTarget = recommendationAt(catcher, center, "blocker-tap", catcher);
                out.hint = "整个界面被一个全屏层接管（战斗入场演出、点任意处继续）：先短等，仍是这一层就用 egret_act 的 {op:\"recommended\"} 点它";
            } else {
                out.hint = "动作表里的目标全被同一个对象挡住（多半是过场遮罩）：短等后重新观察，一直不消失再截图排查";
            }
        }
        var scrollers = scrollersIn(root);
        if (scrollers.length) out.scrollers = scrollers;
        if (p.rects) {
            // 供 MCP server 做批量 OCR：截图是物理像素，这里给出换算所需的视口信息
            var canvas = getCanvas();
            var canvasRect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
            out.devicePixelRatio = window.devicePixelRatio || 1;
            out.viewportSize = { width: window.innerWidth, height: window.innerHeight };
            out.captureSize = canvasRect ? {
                width: Math.max(window.innerWidth, canvasRect.left + canvasRect.width),
                height: Math.max(window.innerHeight, canvasRect.top + canvasRect.height)
            } : { width: window.innerWidth, height: window.innerHeight };
        }
        // 指纹只看语义（面板、标签、状态、文案），不看坐标：循环播放的待机动画不该让决策作废
        out.marker = hashString([out.panel && out.panel.hash, out.stageSize.join("x"), out.text.join("|"),
            entries.map(function (e) {
                return [e.hash, e.label, e.role, e.off ? 1 : 0, e.on ? 1 : 0, e.st || "", e.occluded ? 1 : 0].join(",");
            }).join(";")].join("#"));
        if (!p.peek) lastTable = out;
        try { Object.defineProperty(out, "_faded", { value: faded, enumerable: false, configurable: true }); } catch (e) {}
        return hideRowKeys(out, rowKeys, visibleEntries);
    }

    function stackEntryLabel(o) {
        var name = qaNameOf(o) || bindId(o) || nameOf(o);
        return tidy(name, 24) || shortClass(o);
    }

    function stackSnapshot() {
        try {
            return (sceneInfo().stack || []).map(function (o) { return { hash: hashOf(o), tag: stackEntryLabel(o) }; });
        } catch (e) {
            return null;
        }
    }

    // 一行说清这一步把界面改成了什么样：让调用方不必自己 diff 前后两张动作表
    function stackDelta(before, after) {
        if (!before || !after) return null;
        var had = {}, has = {};
        before.forEach(function (x) { had[x.hash] = 1; });
        after.forEach(function (x) { has[x.hash] = 1; });
        var opened = after.filter(function (x) { return !had[x.hash]; }).map(function (x) { return x.tag; });
        var closed = before.filter(function (x) { return !has[x.hash]; }).map(function (x) { return x.tag; });
        if (!opened.length && !closed.length) return null;
        var parts = [];
        if (opened.length) parts.push("打开 " + opened.slice(0, 3).join("、"));
        if (closed.length) parts.push("关闭 " + closed.slice(0, 3).join("、"));
        if (after.length) parts.push("顶层 " + after[after.length - 1].tag);
        return parts.join("；");
    }

    // 执行后等到「有用的状态」：先等指纹变化，再等它稳定；一直没变化就尽早返回，不空耗
    async function settleAfter(before, p) {
        var cap = Math.min(Math.max(p.timeoutMs !== undefined ? +p.timeoutMs : 3000, 0), 30000);
        var stableMs = Math.min(Math.max(p.stableMs !== undefined ? +p.stableMs : 250, 0), 5000);
        // 游戏点击常要等一次网络往返才有反应，比网页的两帧长得多；仍然没变化就尽早返回
        var quietMs = Math.min(Math.max(p.quietMs !== undefined ? +p.quietMs : 600, 60), Math.max(cap, 60));
        var start = Date.now(), last = before, lastAt = Date.now(), changed = false;
        while (Date.now() - start < cap) {
            await sleep(60);
            var sig = quickSignature();
            if (sig !== before) changed = true;
            if (sig !== last) {
                last = sig;
                lastAt = Date.now();
            } else if (changed && Date.now() - lastAt >= stableMs) break;
            else if (!changed && Date.now() - start >= quietMs) break;
        }
        return { changed: changed, waitedMs: Date.now() - start };
    }

    // 把动作表里的编号解析回真实对象：编号只有在指纹仍然成立时才可用
    function resolveFastTarget(step, fresh) {
        if (step.i !== undefined && step.i !== null) {
            if (!fresh) throw new Error("动作表已过期，编号不再有效：按返回的新动作表重新决策");
            var entry = lastEntries.filter(function (a) { return a.i === +step.i; })[0];
            if (!entry) throw new Error("动作表里没有编号 " + step.i);
            var o = byHash(entry.hash);
            if (!o) throw new Error("编号 " + step.i + "（" + entry.label + "）对应的对象已不在显示列表里");
            return { o: o, entry: entry };
        }
        var target;
        try {
            target = resolveTarget(step);
        } catch (err) {
            // agent 照着动作表里看到的标签写 {"text":"confirm"}，但 confirm* 是实例名不是界面文字，按文字查不到。
            // 只给了 text 时再按动作表的标签（和 alt）找一遍
            var byLabel = step.text && !["hash", "id", "name", "className", "source", "qaName"].some(function (k) {
                return step[k] !== undefined && step[k] !== null && step[k] !== "";
            }) ? tableRowByLabel(String(step.text), +step.index || 0) : null;
            if (!byLabel) throw err;
            return byLabel;
        }
        if (!target) throw new Error("步骤缺少目标：需要 i / hash / 查询条件之一");
        return { o: target, entry: null };
    }

    function tableRowByLabel(text, index) {
        var want = text.replace(/\*$/, "").trim();
        var rows = (buildActionTable({ peek: true, limit: 60 })._entries || []).filter(function (e) {
            return !e.occluded && (e.label === want || e.alt === want);
        });
        var e = rows[index];
        var o = e && byHash(e.hash);
        return o ? { o: o, entry: null } : null;
    }

    var handlers = {
        getErrors: function (p) {
            var since = p.sinceTs !== undefined && p.sinceTs !== null ? +p.sinceTs : 0;
            var types = p.types && p.types.length ? p.types : null;
            var buf = errorBuffer();
            // 已知噪音（如引擎告警、缺图刷屏）交给调用方用 exclude 折叠，避免淹没真正的信号
            var excl = (p.exclude || []).map(function (x) { return String(x).toLowerCase(); });
            var excluded = 0;
            var list = buf.filter(function (e) {
                if (e.lastAt < since) return false;
                if (types && !types.some(function (t) { return e.type === t || e.type.indexOf(t) === 0; })) return false;
                var msg = String(e.message || "").toLowerCase();
                if (excl.some(function (x) { return msg.indexOf(x) >= 0; })) {
                    excluded++;
                    return false;
                }
                return true;
            });
            var limit = p.limit !== undefined ? +p.limit : 50;
            var out = { total: list.length, excluded: excluded, collectingSince: window.__egretInspectorErrorHooks || null,
                now: Date.now(), errors: list.slice(-limit) };
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
            var maxDepth = Math.min(Math.max(p.depth !== undefined ? +p.depth : 3, 0), 8);
            var maxNodes = Math.min(Math.max(p.maxNodes !== undefined ? +p.maxNodes : 80, 1), 120);
            var visibleOnly = !!p.visibleOnly;
            var withBounds = p.bounds !== false;
            var count = 0, truncated = false;
            var fields = p.fields && p.fields.length ? p.fields : null;
            var rootNode = project(describe(root, { bounds: withBounds, path: !fields }), fields);
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
                    cn = project(cn, fields);
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
            var limit = Math.min(Math.max(p.limit !== undefined ? +p.limit : 20, 1), 50);
            var keys = p.props || [];
            var fields = p.fields && p.fields.length ? p.fields : null;
            return {
                total: list.length,
                truncated: list.length > limit,
                results: list.slice(0, limit).map(function (o) {
                    var info = describe(o, { path: !fields, center: true });
                    if (keys.length) info.props = readProps(o, keys);
                    return project(info, fields);
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
            var method = p.method || (touchHandler() ? "touch" : "dom");
            var warnings = [];
            var settle = p.settleMs !== undefined ? +p.settleMs : 0;
            if (settle && target) await waitStable(target, settle);
            var pt = stagePointOf(p, target);
            var hit = hitTest(pt.x, pt.y);
            // 命中目标自身、其子节点或其祖先（点击常由父容器接管）都算能点到。某些 UI 框架（如 FairyGUI）
            // 的父链上带着 visible=false 的容器，此时 effectiveVisible 会误判，不要据此判断
            var reachable = reaches(target, hit);
            if (target && !reachable && !effectiveVisible(target)) warnings.push("目标对象在舞台上不可见");
            if (target && hit && method !== "event" && !reachable) {
                var blocker = className(hit) + (bindId(hit) ? "#" + bindId(hit) : "");
                // 中心点点不到不等于点不到：名字条、相邻控件、半透明装饰常压住中心，先在包围盒内换个点
                var alt = p.probe === false || p.stageX !== undefined || p.clientX !== undefined ? null : probePoint(target, true);
                if (alt) {
                    pt = alt.point;
                    hit = alt.hit;
                    reachable = true;
                    warnings.push("中心点被 " + blocker + " 遮挡，改点包围盒内未被遮挡的位置");
                } else if (!p.force) {
                    // 整个包围盒都点不到，多半是弹窗或全屏遮罩压在上面；报错让调用方先处理遮挡
                    throw new Error("目标被遮挡，未执行点击：该位置命中的是 " + blocker + "（hash " + hashOf(hit) +
                        "），包围盒内没有找到未被遮挡的点。先关闭遮挡物（egret_dismiss_popups）再重试；确需照点可传 force: true");
                } else {
                    warnings.push("点击位置命中的对象不在目标内部（可能被遮挡）：" + blocker);
                }
            }
            var times = p.count || 1;
            for (var i = 0; i < times; i++) {
                if (i) await sleep(80);
                await performGesture([pt], method, p.holdMs !== undefined ? +p.holdMs : 50, target);
            }
            var compactFields = ["hash", "className", "id", "name", "qaName", "text", "onStageVisible", "touchable",
                "enabled", "selected", "currentState", "center"];
            return {
                method: method,
                stagePoint: pt,
                screenPoint: stageToClient(pt.x, pt.y),
                target: target ? (p.details ? describe(target, { path: true }) : project(describe(target, { center: true }), compactFields)) : null,
                hit: hit ? (p.details ? describe(hit, { path: true, bounds: false }) : project(describe(hit, { bounds: false }), ["hash", "className", "id", "name", "qaName"])) : null,
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
            var timeout = Math.min(Math.max(p.timeoutMs !== undefined ? +p.timeoutMs : 10000, 0), 120000);
            var interval = Math.min(Math.max(p.intervalMs !== undefined ? +p.intervalMs : 200, 20), 5000);
            var start = Date.now();
            var stableMs = p.stableMs ? +p.stableMs : 0;
            var lastKey = null;
            var stableSince = 0;
            var overlayGraceMs = Math.min(Math.max(p.overlayGraceMs !== undefined ? +p.overlayGraceMs : 300, 0), 5000);
            var conditions = p.anyOf && p.anyOf.length ? p.anyOf.map(function (c) { return Object.assign({}, c); }) : [p];
            conditions.forEach(function (c) {
                if ((c.state || p.state) === "changed" && !hasCriteria(c)) {
                    throw new Error("state=changed 必须提供 hash/id/qaName/text 等目标条件；无目标会观察 stage 本身并一直等到超时");
                }
            });
            var baselines = conditions.map(function (c) {
                if ((c.state || p.state) !== "changed") return null;
                if (c.from !== undefined) return c.from;
                var initial = getStage() ? query(Object.assign({}, c, { visibleOnly: false })) : [];
                return watchSnapshot(initial[0], c.watchProps || p.watchProps);
            });
            while (true) {
                var matched = null;
                var pending = [];
                for (var ci = 0; ci < conditions.length && !matched; ci++) {
                    var c = conditions[ci];
                    var state = c.state || p.state || "visible";
                    var q = Object.assign({}, c, { visibleOnly: state === "visible" || state === "hidden" });
                    delete q.state;
                    delete q.watchProps;
                    delete q.from;
                    var list = getStage() ? query(q) : [];
                    var before = baselines[ci], after = watchSnapshot(list[0], c.watchProps || p.watchProps);
                    var ok = state === "visible" || state === "exists" ? list.length > 0 :
                        state === "changed" ? !snapshotsEqual(after, before) : list.length === 0;
                    if (ok) matched = { index: ci, state: state, list: list, before: before, after: after };
                    else pending.push({ condition: c, state: state, list: list });
                }
                if (matched && stableMs && matched.list.length && matched.state !== "changed") {
                    // 位置、尺寸和透明度在 stableMs 内保持不变才算满足，用于等待面板打开动画结束
                    var key = matched.index + "|" + JSON.stringify(stageRect(matched.list[0])) + "|" + visualAlpha(matched.list[0]);
                    if (key !== lastKey) {
                        lastKey = key;
                        stableSince = Date.now();
                    }
                    if (Date.now() - stableSince < stableMs) matched = null;
                }
                if (matched) {
                    return {
                        matched: true,
                        state: matched.state,
                        conditionIndex: conditions.length > 1 ? matched.index : undefined,
                        elapsedMs: Date.now() - start,
                        // 最后一次视觉变化发生在何时：可直接作为该界面的动画时长/settle 参考值
                        settledAfterMs: stableMs && stableSince ? stableSince - start : undefined,
                        total: matched.list.length,
                        before: matched.state === "changed" ? matched.before : undefined,
                        after: matched.state === "changed" ? matched.after : undefined,
                        results: matched.list.slice(0, 1).map(function (o) {
                            return project(describe(o, { center: true }), ["hash", "className", "id", "name", "qaName", "text",
                                "onStageVisible", "touchable", "enabled", "selected", "currentState", "center"]);
                        })
                    };
                }
                if (Date.now() - start >= overlayGraceMs) {
                    for (var pi = 0; pi < pending.length; pi++) {
                        var item = pending[pi];
                        var shouldInterrupt = item.condition.interruptOnOverlay !== undefined ? item.condition.interruptOnOverlay :
                            p.interruptOnOverlay !== undefined ? p.interruptOnOverlay : item.state === "gone" || item.state === "hidden";
                        if (!shouldInterrupt) continue;
                        var overlay = actionableOverlayFor(item.list);
                        if (overlay) return { matched: false, interrupted: true, reason: "actionable-overlay",
                            conditionIndex: conditions.length > 1 ? pi : undefined, state: item.state,
                            elapsedMs: Date.now() - start, overlay: overlay };
                    }
                }
                if (Date.now() - start >= timeout) {
                    return { matched: false, state: conditions.length > 1 ? "anyOf" : (conditions[0].state || p.state || "visible"),
                        elapsedMs: Date.now() - start };
                }
                await sleep(interval);
            }
        },

        scene: function (p) {
            var si = sceneInfo();
            var stage = si.stage;
            var maxItems = Math.min(Math.max(p.maxItems !== undefined ? +p.maxItems : 20, 0), 50);
            var brief = function (o) {
                var d = describe(o, { center: true });
                var out = project(d, ["hash", "className", "id", "name", "qaName", "text", "center", "touchable",
                    "enabled", "selected", "currentState"]);
                var r = d.stageRect;
                if (r) {
                    out.size = [round(r.width), round(r.height)];
                    if (r.width >= stage.stageWidth * 0.9 && r.height >= stage.stageHeight * 0.9) out.fullscreen = true;
                }
                return out;
            };
            var out = {
                stageSize: [stage.stageWidth, stage.stageHeight],
                layers: si.layers.map(function (l) {
                    return { hash: hashOf(l), className: className(l), name: nameOf(l), children: numChildren(l) };
                }),
                panelStack: si.stack.map(brief),
                top: si.top ? brief(si.top) : null,
                items: []
            };
            if (!si.top || maxItems <= 0) return out;
            var recommendedTarget = continueTargetOf(si.top) || backdropDismissTargetOf(si.top);
            if (recommendedTarget) {
                out.recommendedTarget = recommendedTarget;
                return out;
            }
            var transientOverlay = transientOverlayOf(si.top);
            if (transientOverlay) {
                out.transientOverlay = transientOverlay;
                return out;
            }
            var cand = [];
            walk(si.top, function (o) {
                if (o === si.top) return;
                if (!o.visible || o.alpha === 0) return false;
                if (cand.length >= maxItems * 4) return false;
                var r = stageRect(o);
                if (!r || r.width < 8 || r.height < 8) return;
                var t = textOf(o);
                var tag = className(o) + " " + (nameOf(o) || "") + " " + (bindId(o) || "");
                var interactive = effectiveTouchable(o) || /button|btn|item|tab|check|close|toggle/i.test(tag);
                if (!interactive && !t) return;
                cand.push({ o: o, r: r, interactive: interactive });
            });
            cand.sort(function (a, b) {
                return (b.interactive ? 1 : 0) - (a.interactive ? 1 : 0);
            });
            var probed = 0;
            out.items = cand.slice(0, maxItems).map(function (c) {
                var item = project(describe(c.o, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "center",
                    "touchable", "enabled", "selected", "currentState"]);
                var hit = item.center ? hitTest(item.center.x, item.center.y) : null;
                if (!reaches(c.o, hit)) {
                    // 点不到中心不等于点不到：先试包围盒内其他点，仍不行才标记为被遮挡
                    var alt = probed++ < 8 ? probePoint(c.o, true) : null;
                    if (alt) item.center = alt.point;
                    else {
                        item.occluded = true;
                        item.blocker = hit ? className(hit) + "#" + hashOf(hit) : null;
                    }
                }
                return item;
            });
            out.itemsTruncated = cand.length > maxItems;
            return out;
        },

        observe: function (p) {
            return buildActionTable(p);
        },

        act: async function (p) {
            requireStage();
            var raw = p.steps && p.steps.length ? p.steps : [p];
            var steps = raw.slice(0, 10);
            if (!steps.length) throw new Error("需要提供 steps：[{i:3}] 或 [{op:\"advance\"}] 等");
            var method = p.method || (touchHandler() ? "touch" : "dom");
            // 执行后的新表要和 observe 同口径：少了 detail/rects，server 侧拿不到 from/screenRect，
            // 自动 OCR 在 act 结果上就一次都不会跑
            var tableArgs = { rootHash: p.rootHash, limit: p.limit, occluded: p.occluded, detail: p.detail, rects: p.rects };
            var errorsBefore = errorBuffer().length;
            // 编号只在「界面还是决策时那一页」时有效：对不上就直接把新动作表交回去重新决策
            var fresh = !!lastTable;
            if (p.marker) {
                if (!lastTable || lastTable.marker !== p.marker) {
                    var checked = buildActionTable(tableArgs);
                    if (checked.marker !== p.marker) {
                        checked.stale = true;
                        checked.executed = [];
                        checked.stopped = "stale";
                        checked.hint = "界面已经不是做决策时那一页；按这张新动作表重新选择目标";
                        return checked;
                    }
                }
                fresh = true;
            }
            // 执行前的样子：marker 对得上就用 agent 刚看到的那张表，否则只看不记地扫一张
            var rowsBefore = p.marker && lastTable && lastTable.marker === p.marker && lastTable._rowKeys
                ? lastTable._rowKeys
                : buildActionTable(Object.assign({}, tableArgs, { peek: true }))._rowKeys;
            var started = Date.now();
            // 整次调用的时限：连出、等回合都可能很久，超过桥接超时就整个白跑、结果也拿不回来。
            // 快到点就停手先返回，已经做了什么照实报，agent 接着再发一次同样的步骤即可
            var deadline = started + Math.max(+p.budgetMs || 45000, 5000);
            var sceneBefore = stackSnapshot();
            var executed = [], stopped = "done";
            // 每步出招时的顶层面板：收尾时拿来复核「解锁了」其实是不是已经结算换了界面
            var turnTops = [];
            for (var n = 0; n < steps.length; n++) {
                var step = steps[n] || {};
                if (n > 0 && Date.now() > deadline - 3000) {
                    stopped = "budget";
                    break;
                }
                // {"i":3,"text":"abc"} 是往 3 号输入框里填字；只有 text 没别的定位条件时是「按文字找来点」
                var locatedElsewhere = ["i", "hash", "id", "name", "className", "source", "qaName"].some(function (k) {
                    return step[k] !== undefined && step[k] !== null && step[k] !== "";
                });
                var op = step.op || (step.text !== undefined && locatedElsewhere ? "text" : "tap");
                var before = quickSignature();
                var record = { op: op };
                try { record.from = panelKey(sceneInfo().top); } catch (e) {}
                var tapTarget = null, tapWasLocked = null;
                try {
                    if (n > 0 && step.i !== undefined && step.i !== null) {
                        // 验收里 agent 反复写 [{"i":10},{"i":26},{"i":4}]：以为后面几张表的编号能提前用上。
                        // 原来只报「动作表已过期」，它看不出错在哪，下一次还这么写
                        throw new Error("第 " + (n + 1) + " 步用了编号 i：编号只对第一步有效，第一步执行后界面变了、编号会重排。" +
                            "后面的步骤改用查询条件（{\"text\":\"表里显示的标签\"}、{\"qaName\":…}），或看完新表再发下一次 act");
                    }
                    if (op === "tap" || op === "text" || op === "swipe" || op === "drag") {
                        // 填字时 text 是要填的内容，不能拿它当查询条件去找目标
                        var findQuery = op === "text" ? Object.assign({}, step, { text: undefined }) : step, resolved = null;
                        for (var findStart = Date.now(); !resolved;) {
                            try {
                                resolved = resolveFastTarget(findQuery, fresh);
                            } catch (err) {
                                // 多步里后面的目标常常还没出来：点完「挑战」要先进战斗、技能栏滑进来才点得到。
                                // 验收里照发的路线就这样一进战斗就报「找不到」。后面的步骤等它最多 3 秒再判
                                if (n === 0 || !/没有找到匹配的显示对象/.test(String(err && err.message)) ||
                                    Date.now() - findStart > 3000 || deadline - Date.now() < 4000) throw err;
                                await sleep(150);
                            }
                        }
                        var o = resolved.o, entry = resolved.entry;
                        if (entry) {
                            record.target = { i: entry.i, label: entry.label, hash: entry.hash, role: entry.role };
                        } else {
                            var lab = actionLabelOf(o);
                            record.target = { hash: hashOf(o), label: lab.label, role: actionRoleOf(o, lab.label, lab.from) };
                        }
                        var sel = stableSelector(o);
                        if (sel) record.target.sel = sel;
                        if (op === "text") {
                            // 往标签、按钮文字上写字只会把界面改花，还让人以为输入成功了
                            if (!inputLike(o) && !(o.textDisplay && inputLike(o.textDisplay)) && !step.force) {
                                throw new Error("目标不是输入框，没有写入：要按文字点它请只给 text（不带 i/hash），要填字请指到输入框");
                            }
                            o.text = String(step.text);
                            if (step.dispatchChange !== false) {
                                var eg = egretNs();
                                o.dispatchEvent(new eg.Event(eg.Event.CHANGE, true));
                            }
                            record.text = String(step.text);
                        } else {
                            if (step.settleMs) await waitStable(o, +step.settleMs);
                            var preCap = Math.min(step.turnMs !== undefined ? +step.turnMs : p.turnMs !== undefined ? +p.turnMs : 15000,
                                60000, deadline - Date.now() - 3000);
                            var preLock = lockedAncestor(o);
                            if (preLock && preCap > 0 && (turnLock(preLock) || +step.repeat > 1)) {
                                record.unlock = await waitForUnlock(o, preLock, preCap,
                                    fresh && lastTable && lastTable._entries);
                                if (record.unlock.reason === "new-controls") {
                                    throw new Error("没有点：它所在的一组控件锁着，游戏在等你先做别的决定（冒出了 " +
                                        record.unlock.added.join("、") + "），按新表先处理");
                                }
                                if (record.unlock.reason !== "unlocked") {
                                    throw new Error("目标所在的一组控件一直锁着（等了 " +
                                        (record.unlock.waitedMs / 1000).toFixed(1) + "s，" + record.unlock.reason + "），没有点");
                                }
                            }
                            var r = stageRect(o);
                            if (!r) throw new Error("目标没有有效包围盒，可能已被移出舞台");
                            var pt = step.offsetX !== undefined || step.offsetY !== undefined
                                ? { x: round(r.x + (+step.offsetX || 0)), y: round(r.y + (+step.offsetY || 0)) }
                                : { x: round(r.x + r.width / 2), y: round(r.y + r.height / 2) };
                            // 执行前再解一次几何与遮挡：动作表里的坐标只是参考
                            var hit = hitTest(pt.x, pt.y);
                            // 刚点开的下拉框、弹窗还在入场动画里，目标会被正在滑入的底图挡一下：
                            // 等它落定再判「被遮挡」，别让 agent 为一段动画多花一轮
                            for (var occStart = Date.now(); !reaches(o, hit) && !probePoint(o, true) &&
                                Date.now() - occStart < 1200 && !step.force;) {
                                await sleep(100);
                                r = stageRect(o) || r;
                                if (step.offsetX === undefined && step.offsetY === undefined) {
                                    pt = { x: round(r.x + r.width / 2), y: round(r.y + r.height / 2) };
                                }
                                hit = hitTest(pt.x, pt.y);
                            }
                            if (!reaches(o, hit)) {
                                var alt = probePoint(o, true);
                                if (alt) pt = alt.point;
                                else if (!step.force) {
                                    throw new Error("目标被 " + (hit ? shortClass(hit) + "#" + hashOf(hit) : "未知对象") +
                                        " 遮挡，未执行点击：先用 op=dismiss 关掉遮挡物再重试");
                                }
                            }
                            tapTarget = o;
                            tapWasLocked = lockedAncestor(o);
                            // 拖出去才生效的控件（换宠卡）原地点一下什么都不发生：认得出方向就直接替它按住滑出去，
                            // 不让 agent 为「点了没反应」再花一轮，回合倒计时也等不起
                            var drag = dragTargetOf(o);
                            var dir = op === "swipe" ? step.dir || (drag && drag.dir) || "up" : drag && drag.dir;
                            if (op === "drag") {
                                // 拖到另一个控件上（把技能拖进技能栏、把卡片拖到格子里）：to 用同一张表的编号、查询条件或 dx/dy
                                var to = step.to || {}, dst;
                                if (to.dx !== undefined || to.dy !== undefined) {
                                    dst = { x: round(pt.x + (+to.dx || 0)), y: round(pt.y + (+to.dy || 0)) };
                                    record.to = { label: "dx=" + (+to.dx || 0) + ",dy=" + (+to.dy || 0) };
                                } else {
                                    if (!Object.keys(to).length) throw new Error("drag 需要 to：{\"i\":7}、查询条件或 {\"dx\":-200,\"dy\":0}");
                                    var toRes = resolveFastTarget(to, fresh), tr = stageRect(toRes.o);
                                    if (!tr) throw new Error("drag 的目标没有有效包围盒");
                                    dst = { x: round(tr.x + tr.width / 2), y: round(tr.y + tr.height / 2) };
                                    record.to = { label: toRes.entry ? toRes.entry.label : actionLabelOf(toRes.o).label };
                                    var toSel = stableSelector(toRes.o);
                                    if (toSel) record.to.sel = toSel;
                                }
                                await performGesture(dragToPath(pt, dst, step.holdMs !== undefined ? Math.max(+step.holdMs, 0) : 700,
                                    scrollAxisOf(o)), method, 0, o);
                                record.drag = "to";
                            } else if (dir) {
                                await performGesture(dragPath(pt, drag ? drag.owner : o, dir), method,
                                    step.holdMs !== undefined ? +step.holdMs : 300, o);
                                record.drag = dir;
                            } else {
                                await performGesture([pt], method, step.holdMs !== undefined ? +step.holdMs : 50, o);
                            }
                            record.point = pt;
                        }
                    } else if (op === "recommended") {
                        // 与 observe 用同一套判定，保证 agent 看到的 recommendedTarget 就是这里点的那个
                        var rec = buildActionTable(tableArgs).recommendedTarget;
                        if (!rec) throw new Error("当前没有 recommendedTarget：重新 observe 后按动作表选目标");
                        await performGesture([rec.stagePoint], method, 50, null);
                        record.target = { reason: rec.reason, stagePoint: rec.stagePoint,
                            label: rec.target && (rec.target.text || rec.target.qaName || rec.target.id || rec.target.className) };
                    } else if (op === "advance") {
                        record.result = await handlers.advance({
                            max: step.max !== undefined ? step.max : 6,
                            waitMs: step.waitMs, paceMs: step.paceMs, stableMs: step.stableMs, method: method
                        });
                    } else if (op === "dismiss") {
                        record.result = await handlers.dismissPopups({
                            max: step.max !== undefined ? step.max : 2, until: step.until, method: method
                        });
                    } else if (op === "close") {
                        record.result = await handlers.closeTop({ method: method });
                        if (!record.result.ok && !step.optional) stopped = "close-failed";
                    } else if (op === "scroll") {
                        var scroller = step.i !== undefined || hasCriteria(step)
                            ? resolveFastTarget(step, fresh).o
                            : byHash((lastTable && lastTable.scrollers && lastTable.scrollers[0] || {}).hash);
                        if (!scroller) throw new Error("没有可滚动的目标：传 i/hash，或先 observe 看 scrollers");
                        record.target = { hash: hashOf(scroller), label: actionLabelOf(scroller).label };
                        if (step.toIndex !== undefined) {
                            // 读过数据、知道目标是第几条时直接定位，不用一屏一屏拖着找
                            record.result = await scrollToIndex(scroller, step.toIndex);
                        } else {
                            var sr = stageRect(scroller);
                            if (!sr) throw new Error("滚动目标没有有效包围盒");
                            var dy = step.dy !== undefined ? +step.dy : (step.dx !== undefined ? 0 : -Math.round(sr.height * 0.6));
                            var dx = step.dx !== undefined ? +step.dx : 0;
                            var from = { x: round(sr.x + sr.width / 2), y: round(sr.y + sr.height / 2) };
                            var points = [];
                            var stepsCount = 10;
                            for (var si2 = 0; si2 <= stepsCount; si2++) {
                                points.push({ x: round(from.x + dx * si2 / stepsCount), y: round(from.y + dy * si2 / stepsCount) });
                            }
                            await performGesture(points, method === "event" ? "touch" : method, 300, scroller);
                            record.delta = [dx, dy];
                        }
                    } else if (op === "wait") {
                        if (step.until && hasCriteria(step.until)) {
                            record.result = await handlers.waitFor(Object.assign({}, step.until, {
                                timeoutMs: Math.max(Math.min(step.timeoutMs || 8000, deadline - Date.now() - 3000), 200) }));
                            if (!record.result.matched) throw new Error("等待条件超时未满足");
                        } else {
                            await sleep(Math.min(Math.max(step.ms !== undefined ? +step.ms : 600, 0), 15000));
                        }
                    } else {
                        throw new Error("未知的 op：" + op + "（支持 tap/text/swipe/drag/close/recommended/advance/dismiss/scroll/wait）");
                    }
                    if (op !== "wait" || !step.until) {
                        record.settle = await settleAfter(before, {
                            timeoutMs: step.timeoutMs !== undefined ? step.timeoutMs : p.timeoutMs,
                            stableMs: step.stableMs !== undefined ? step.stableMs : p.stableMs,
                            quietMs: step.quietMs !== undefined ? step.quietMs : p.quietMs
                        });
                    }
                    // 点之前是开着的、点完整组被锁：游戏在播演出或等对手，等到能再操作再返回（turnMs=0 关掉）
                    if (tapTarget && !tapWasLocked) {
                        var turnCap = step.turnMs !== undefined ? +step.turnMs : p.turnMs !== undefined ? +p.turnMs : 15000;
                        if (turnCap > 0) {
                            turnCap = Math.max(Math.min(turnCap, 60000, deadline - Date.now()), 500);
                            var grace = knownLockable(tapTarget) || +step.repeat > 1 ? 1500 : 0;
                            var topAtTap = sceneInfo().top, topAtTapHash = topAtTap && hashOf(topAtTap);
                            turnTops[executed.length] = topAtTapHash;
                            var turn = await waitForTurn(tapTarget, turnCap, grace);
                            if (turn) record.turn = turn;
                            // 连出同一招：回合倒计时只有几秒，模型每回合决策一次根本赶不上。
                            // 解锁后立刻再点，直到界面换了（结算）、冒出新的可选项（换宠栏）、点了不再上锁（PP 用完）或次数用完
                            var times = Math.min(Math.max(+step.repeat || 1, 1), 30), done = 1;
                            while (done < times && turn && turn.reason === "unlocked" && tapTarget.stage) {
                                // 下一回合多半要五六秒，剩下的时间不够就先返回，别让整次调用超时白跑
                                if (deadline - Date.now() < 8000) {
                                    turn = { reason: "budget", waitedMs: 0 };
                                    break;
                                }
                                var again = probePoint(tapTarget, true);
                                if (!again) {
                                    // 解开了却点不到：多半是结算、提示盖上来了
                                    turn = { reason: "blocked", waitedMs: 0 };
                                    break;
                                }
                                await performGesture([again.point], method, 50, tapTarget);
                                done++;
                                turn = await waitForTurn(tapTarget, Math.max(Math.min(turnCap, deadline - Date.now()), 500), 1500);
                            }
                            if (times > 1) {
                                record.repeated = done;
                                record.turn = turn || { reason: "no-lock", waitedMs: 0 };
                            }
                            // 最后一击直接结算：锁跟着技能栏一起没了，看上去像「解锁了」。
                            // 顶层换了就照实说界面换了，别让 agent 以为还能接着出招
                            if (record.turn && (record.turn.reason === "unlocked" || record.turn.reason === "blocked")) {
                                var topNow = sceneInfo().top;
                                if (!tapTarget.stage || !topNow || hashOf(topNow) !== topAtTapHash) record.turn.reason = "panel";
                            }
                        }
                    }
                    if (step.expect && hasCriteria(step.expect)) {
                        var hitList = query(Object.assign({ visibleOnly: true }, step.expect));
                        record.expectMatched = hitList.length > 0;
                        if (!hitList.length) stopped = "expect-failed";
                    }
                } catch (e) {
                    record.error = e && e.message ? e.message : String(e);
                    // optional 步骤失败不影响结论：用于「先试着关个弹窗再点正事」这类链
                    if (step.optional) record.skipped = true;
                    else stopped = "error";
                }
                executed.push(record);
                // 编号来自上一次快照；执行完第一步后界面已变，后续步骤必须用查询条件或 op 定位
                fresh = false;
                if (stopped !== "done") break;
            }
            // 加载过场里没有可点目标，直接在这一次调用里等它过去，省掉一整轮往返
            var table = buildActionTable(tableArgs);
            var loadingCap = Math.min(Math.max(p.loadingMs !== undefined ? +p.loadingMs : 6000, 0), 30000);
            var loadingStart = Date.now();
            while (Date.now() - loadingStart < loadingCap) {
                // 弹窗刚铺上遮罩、按钮还没加进来：表里一个能点的都没有，只剩「点遮罩」，这时交回去 agent 只会去点遮罩
                var emptyModal = table.mode === "modal-backdrop-dismiss" && Date.now() - loadingStart < 1500 &&
                    !(table.actions || []).some(function (a) { return !a.occluded; });
                if (table.mode !== "transient" && table.mode !== "empty" && table.mode !== "blocked" && !emptyModal) break;
                // blocked 多半是等不走的全屏接管层，短等确认它不是加载条就交回去
                if (table.mode === "blocked" && Date.now() - loadingStart >= 1500) break;
                await sleep(150);
                table = buildActionTable(tableArgs);
            }
            var loadingMs = Date.now() - loadingStart;
            // 列表、弹窗还在淡入：控件几乎全透明时不进表，这时交回去 agent 看到的是一张缺了主角的表
            // （点进星球后关卡列表淡入，整列关卡都不在表里，agent 只好在别处乱找）。透明的在变少就再等等；
            // 一直不变的是本来就透明的东西，最多多花 200ms
            for (var fadeWait = 0; table._faded > 0 && fadeWait < 4 && deadline - Date.now() > 2000; fadeWait++) {
                var fadedBefore = table._faded;
                await sleep(200);
                table = buildActionTable(tableArgs);
                if (table._faded >= fadedBefore) break;
            }
            if (loadingMs > 300) table.waitedForLoadingMs = loadingMs;
            executed.forEach(function (rec, k) {
                if (!rec.turn || turnTops[k] === undefined) return;
                if (rec.turn.reason !== "unlocked" && rec.turn.reason !== "blocked") return;
                var topEnd = sceneInfo().top;
                if (!topEnd || hashOf(topEnd) !== turnTops[k]) rec.turn.reason = "panel";
            });
            table.executed = executed;
            table.stopped = stopped;
            table.elapsedMs = Date.now() - started;
            var delta = stackDelta(sceneBefore, stackSnapshot());
            var diff = rowDiff(rowsBefore, table._rowKeys);
            var rowsChanged = diff.added.length > 0 || diff.removed.length > 0;
            var settled = executed.some(function (r) { return r.settle && r.settle.changed; });
            table.changed = delta || (rowsChanged ? "面板栈没变；" + describeRowDiff(diff)
                : settled ? "面板栈没变，界面内容有变化" : "界面没有变化");
            // 只有点击类操作才谈得上「点了没反应」；纯等待不该劝 agent 去怀疑目标
            var clicked = executed.filter(function (r) { return r.op === "tap" || r.op === "text" || r.op === "swipe" || r.op === "drag" || r.op === "recommended"; });
            if (stopped === "done" && clicked.length && !delta && !rowsChanged && !settled) {
                table.hint = "操作已执行但界面没有变化：确认目标是否正确，或用 op=wait 再等一次；仍无变化时用 egret_get_errors 排查";
            }
            var added = errorBuffer().slice(errorsBefore);
            if (added.length) {
                table.newErrors = added.length;
                table.firstError = added[0] && added[0].message;
            }
            return table;
        },

        advance: async function (p) {
            var max = Math.min(Math.max(p.max !== undefined ? +p.max : 1, 1), 12);
            var waitMs = Math.min(Math.max(p.waitMs !== undefined ? +p.waitMs : 1200, 100), 5000);
            var paceMs = Math.min(Math.max(p.paceMs !== undefined ? +p.paceMs : 320, 0), 2000);
            var stableMs = Math.min(Math.max(p.stableMs !== undefined ? +p.stableMs : 180, 0), 1500);
            var method = p.method || (touchHandler() ? "touch" : "dom");
            var steps = [], stopped = "limit", chainPanelHash = null, chainReason = null, current = null, hint = null;
            for (var n = 0; n < max; n++) {
                var beforeScene = sceneInfo();
                var target = continueTargetOf(beforeScene.top);
                if (!target) {
                    var transientOverlay = transientOverlayOf(beforeScene.top);
                    var topTag = beforeScene.top && (className(beforeScene.top) + " " + (nameOf(beforeScene.top) || ""));
                    var dialogue = /dialogueIntegration|dialogue(?:Buttom|Bottom)Mixed|npcDialog|plotDialog/i.test(topTag || "");
                    var decision = dialogue && dialogueHasDecision(beforeScene.top);
                    stopped = transientOverlay ? "transient-overlay" : decision ? "decision-required" : "no-continuation";
                    if (beforeScene.top) current = project(describe(beforeScene.top, { center: true }),
                        ["hash", "className", "id", "name", "qaName", "text", "center", "currentState"]);
                    hint = transientOverlay ? transientOverlay.actionHint : decision ? "当前对白需要语义选择，使用 egret_locate 定位选项" :
                        "当前顶层界面不是可直接推进的对白或引导；按返回的动作表定位下一目标";
                    break;
                }
                if (target.reason === "guide-hole") {
                    stopped = "targeted-guide";
                    break;
                }
                var panelHash = beforeScene.top && hashOf(beforeScene.top);
                if (chainPanelHash === null) {
                    chainPanelHash = panelHash;
                    chainReason = target.reason;
                } else if (panelHash !== chainPanelHash || target.reason !== chainReason) {
                    stopped = "continuation-changed";
                    break;
                }
                var before = continuationSignature(beforeScene.top, target);
                var clickedAt = Date.now();
                await performGesture([target.stagePoint], method, 50, null);
                var changed = false, afterTarget = null;
                var deadline = Date.now() + waitMs;
                while (Date.now() < deadline) {
                    await sleep(80);
                    var afterScene = sceneInfo();
                    afterTarget = continueTargetOf(afterScene.top);
                    if (!afterScene.top || !afterTarget || continuationSignature(afterScene.top, afterTarget) !== before) {
                        changed = true;
                        break;
                    }
                }
                steps.push({ reason: target.reason, stagePoint: target.stagePoint,
                    target: target.target, changed: changed });
                if (!changed) {
                    stopped = "unchanged";
                    break;
                }
                // 文本逐字出现时，首次变化不代表已经可继续；等签名短暂稳定并保持均匀点击节奏。
                if (afterTarget && stableMs) {
                    var stableSignature = continuationSignature(sceneInfo().top, afterTarget);
                    var stableSince = Date.now();
                    var stableDeadline = Date.now() + Math.max(stableMs, waitMs);
                    while (Date.now() < stableDeadline && Date.now() - stableSince < stableMs) {
                        await sleep(Math.min(60, stableMs));
                        var stableScene = sceneInfo();
                        var stableTarget = continueTargetOf(stableScene.top);
                        if (!stableScene.top || !stableTarget || hashOf(stableScene.top) !== chainPanelHash || stableTarget.reason !== chainReason) {
                            afterTarget = stableTarget;
                            break;
                        }
                        var signature = continuationSignature(stableScene.top, stableTarget);
                        if (signature !== stableSignature) {
                            stableSignature = signature;
                            stableSince = Date.now();
                        }
                        afterTarget = stableTarget;
                    }
                }
                var paceRemaining = paceMs - (Date.now() - clickedAt);
                if (paceRemaining > 0) await sleep(paceRemaining);
                if (!afterTarget) {
                    stopped = "done";
                    break;
                }
            }
            var rest = sceneInfo();
            var result = { advanced: steps.length, stopped: stopped, steps: steps,
                next: continueTargetOf(rest.top) };
            if (current) result.current = current;
            if (hint) result.hint = hint;
            return result;
        },

        locate: function (p) {
            if (!p.description || !String(p.description).trim()) throw new Error("需要提供 description 描述要找的按钮、NPC 或入口");
            return locateSemantic(p);
        },

        dismissPopups: async function (p) {
            var max = p.max !== undefined ? +p.max : 6;
            var method = p.method || (touchHandler() ? "touch" : "dom");
            var until = p.until || {};
            var closed = [], stopped = "done";
            for (var n = 0; n < max; n++) {
                if (hasCriteria(until) && query(Object.assign({ visibleOnly: true }, until)).length) {
                    stopped = "until";
                    break;
                }
                var si = sceneInfo();
                var panel = si.top;
                if (!panel) {
                    stopped = "empty";
                    break;
                }
                var hash = hashOf(panel);
                var entry = { panel: className(panel) + (nameOf(panel) ? "#" + nameOf(panel) : ""), hash: hash };
                var btn = findCloseControl(panel);
                if (btn) {
                    var alt = probePoint(btn.o, false);
                    var pt = alt ? alt.point : { x: round(btn.rect.x + btn.rect.width / 2), y: round(btn.rect.y + btn.rect.height / 2) };
                    entry.via = "close";
                    entry.control = bindId(btn.o) || qaNameOf(btn.o) || nameOf(btn.o) || sourceOf(btn.o) || className(btn.o);
                    await performGesture([pt], method, 50, btn.o);
                } else {
                    var mp = maskPointOutside(panel);
                    if (!mp) {
                        entry.ok = false;
                        entry.note = "面板内没有可识别的关闭控件，内容区外也没有高置信的可点遮罩";
                        closed.push(entry);
                        stopped = "stuck";
                        break;
                    }
                    entry.via = "mask";
                    entry.point = { x: mp.x, y: mp.y };
                    entry.control = bindId(mp.evidence) || qaNameOf(mp.evidence) || nameOf(mp.evidence) || sourceOf(mp.evidence) || className(mp.evidence);
                    await performGesture([{ x: mp.x, y: mp.y }], method, 50, null);
                }
                // 等这个面板真的消失；没消失就别接着点，否则会反复点同一个
                var gone = false;
                for (var w = 0; w < 12 && !gone; w++) {
                    await sleep(150);
                    var now = sceneInfo().top;
                    gone = !now || hashOf(now) !== hash;
                }
                entry.ok = gone;
                closed.push(entry);
                if (!gone) {
                    entry.note = "点击后该面板仍在最上层";
                    stopped = "stuck";
                    break;
                }
            }
            var rest = sceneInfo();
            return {
                closed: closed,
                stopped: stopped,
                remaining: rest.top ? project(describe(rest.top, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "center"]) : null,
                stackDepth: rest.stack.length
            };
        },

        // 关掉当前顶层面板：close → back → 遮罩，依次试，每试一次都确认面板真的消失了。
        // 一次往返解决「打开后关不掉」，并回报到底哪条路子有效，省得 agent 一次一次试。
        closeTop: async function (p) {
            var method = p.method || (touchHandler() ? "touch" : "dom");
            var panel = sceneInfo().top;
            if (!panel) return { ok: false, stopped: "empty", note: "当前没有顶层面板可关" };
            var hash = hashOf(panel);
            var name = className(panel) + (nameOf(panel) ? "#" + nameOf(panel) : "");
            var tried = [];

            async function vanished() {
                for (var w = 0; w < 10; w++) {
                    await sleep(120);
                    var now = sceneInfo().top;
                    if (!now || hashOf(now) !== hash) return true;
                }
                return false;
            }

            async function attempt(via, o, point) {
                if (!point) return false;
                var entry = { via: via, point: { x: round(point.x), y: round(point.y) } };
                if (o) entry.control = bindId(o) || qaNameOf(o) || nameOf(o) || sourceOf(o) || className(o);
                await performGesture([point], method, 50, o || null);
                entry.ok = await vanished();
                tried.push(entry);
                return entry.ok;
            }

            function centerOf(r) {
                return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
            }

            // 连着关几层时，下面那层可能还在铺开，这一瞬间找不到任何控件。
            // 只在一个都没找到时等一下重来，找到过控件就不重试，免得重复点。
            for (var sweep = 0; sweep < 2; sweep++) {
                if (sweep) {
                    await sleep(250);
                    var settled = sceneInfo().top;
                    if (!settled || hashOf(settled) !== hash) {
                        // 一下都没点它就自己没了：是上一层的退场动画、特效层（EffectContainer），不是要关的界面。
                        // 下面露出来的是模态面板就接着关它；主城 HUD 不算，免得把 HUD 当面板去点
                        if (!tried.length && !p.handedOver && settled && isModalPanel(settled)) {
                            var next = await handlers.closeTop(Object.assign({}, p, { handedOver: true }));
                            next.passed = name;
                            return next;
                        }
                        return { ok: true, via: "gone", panel: name, tried: tried };
                    }
                    panel = settled;
                }
                var strict = findCloseControl(panel, false);
                if (strict) {
                    var sp = probePoint(strict.o, false);
                    if (await attempt("close", strict.o, sp ? sp.point : centerOf(strict.rect))) {
                        return { ok: true, via: "close", panel: name, tried: tried };
                    }
                }
                var back = findCloseControl(panel, true);
                if (back && (!strict || back.o !== strict.o)) {
                    var bp = probePoint(back.o, false);
                    if (await attempt("back", back.o, bp ? bp.point : centerOf(back.rect))) {
                        return { ok: true, via: "back", panel: name, tried: tried };
                    }
                }
                // 系统提示（一段话加一个「确认」）点遮罩关不掉，确认键又常是美术字、名字只叫 confirm。
                // 面板里除了字只剩这一个 confirm 时它就是「知道了」；购买类弹窗总有取消或 ×，前面已经先点了
                var sole = soleConfirmOf(panel);
                if (sole && (!strict || sole._o !== strict.o)) {
                    if (await attempt("confirm", sole._o, sole.point)) {
                        return { ok: true, via: "confirm", panel: name, tried: tried };
                    }
                }
                var mp = maskPointOutside(panel);
                if (mp && await attempt("mask", null, { x: mp.x, y: mp.y })) {
                    return { ok: true, via: "mask", panel: name, tried: tried };
                }
                if (tried.length) break;
            }
            if (!tried.length) {
                return { ok: false, stopped: "no-control", panel: name, tried: tried,
                    note: "面板里找不到关闭/返回控件，内容区外也没有可点遮罩：截图看看它是怎么关的" };
            }
            return { ok: false, stopped: "stuck", panel: name, tried: tried,
                note: "关闭/返回/遮罩都点过了，面板仍在最上层" };
        },

        runtimeStats: function () {
            var stage = getStage();
            var stats = { now: Date.now(), url: location.href, visibility: document.visibilityState,
                agentVersion: VERSION, uptimeMs: performance && performance.now ? round(performance.now()) : null };
            if (performance && performance.memory) {
                stats.jsHeap = {
                    usedBytes: performance.memory.usedJSHeapSize,
                    totalBytes: performance.memory.totalJSHeapSize,
                    limitBytes: performance.memory.jsHeapSizeLimit
                };
            } else stats.jsHeap = null;
            if (stage) {
                var total = 0, visible = 0, listenerOwners = 0, interactionListeners = 0;
                walk(stage, function (o) {
                    total++;
                    if (effectiveVisible(o)) visible++;
                    var listeners = interactionListenersOf(o);
                    if (listeners.length) {
                        listenerOwners++;
                        interactionListeners += listeners.length;
                    }
                });
                stats.egret = { displayObjects: total, visibleObjects: visible,
                    interactionOwners: listenerOwners, interactionListeners: interactionListeners };
            } else stats.egret = null;
            return stats;
        },

        inspectCode: function (p) {
            var o = resolveTarget(p);
            if (!o) throw new Error("需要提供 hash 或查询条件");
            var maxChars = p.maxChars !== undefined ? +p.maxChars : 400;
            var out = {
                hash: hashOf(o), className: className(o), id: bindId(o), qaName: qaNameOf(o),
                methods: methodsOf(o), listeners: listenersOf(o, maxChars), ancestorListeners: []
            };
            // 按钮的点击常由父面板统一处理，往上找几层才看得到真正的业务回调
            var cur = o.parent, depth = 0;
            while (cur && depth < (p.ancestorDepth !== undefined ? +p.ancestorDepth : 4)) {
                var ls = listenersOf(cur, maxChars).filter(function (l) {
                    return /touch|tap|mouse|click/i.test(l.type);
                });
                if (ls.length) out.ancestorListeners.push({ className: className(cur), id: bindId(cur), hash: hashOf(cur), listeners: ls });
                cur = cur.parent;
                depth++;
            }
            var info = bindInfo(o);
            if (info) out.host = { className: className(info.host), key: info.key, hash: hashOf(info.host), methods: methodsOf(info.host) };
            return out;
        },

        // ---- Splan 项目专属：页面存在全局 MFC 时才可用；接口按 probe 现场探测，缺失时退回事件派发 ----
        splan: async function (p) {
            var W = window;
            if (!W.MFC) throw new Error("当前页面没有全局 MFC 对象，splan_call 不适用于此项目");
            var mm = W.MFC.moduleManager || null;
            var consts = (W.xls && W.xls.ModuleConst) || W.ModuleConst || null;
            var ge = W.GameEvent || (W.xls && W.xls.GameEvent) || null;
            var tool = W.VilGeneralTool || (W.xls && W.xls.VilGeneralTool) || null;
            var action = p.action || "probe";

            // ModuleConst 里既有常量也有工具函数，只取常量部分
            function constEntries() {
                var out = [];
                if (!consts) return out;
                Object.keys(consts).forEach(function (k) {
                    var v;
                    try {
                        v = consts[k];
                    } catch (e) {
                        return;
                    }
                    if (v === null || typeof v === "function" || typeof v === "object") return;
                    out.push({ name: k, id: v });
                });
                return out;
            }

            function moduleId(m) {
                if (m === undefined || m === null) throw new Error("需要提供 module");
                if (typeof m === "number" || /^\d+$/.test(String(m))) return +m;
                var entries = constEntries();
                var hit = entries.filter(function (e) { return e.name === m; })[0] ||
                    entries.filter(function (e) { return e.name.toLowerCase() === String(m).toLowerCase(); })[0];
                if (!hit) throw new Error("模块常量表里没有 " + m + "，先用 action=listModules 查实际名字");
                return hit.id;
            }

            // 用项目自己的接口判断模块是否已打开，比“界面变了没”准确
            function moduleState(id) {
                if (!mm || typeof mm.checkModuleOpen !== "function") return { known: false };
                var r;
                try {
                    r = mm.checkModuleOpen(id, true);
                } catch (e) {
                    return { known: false, error: e && e.message };
                }
                if (r && typeof r === "object") return { known: true, open: true, panel: r };
                return { known: true, open: !!r, panel: null };
            }

            function dispatch(type, data) {
                if (tool && typeof tool.GlobalDispatchEvent === "function") {
                    tool.GlobalDispatchEvent(type, data);
                    return "VilGeneralTool.GlobalDispatchEvent";
                }
                var stage = getStage();
                if (stage && stage.dispatchEventWith) {
                    stage.dispatchEventWith(type, false, data);
                    return "stage.dispatchEventWith";
                }
                throw new Error("没有可用的全局事件派发接口，请用 egret_evaluate 直接调用项目接口");
            }

            function debugInfo() {
                var scriptLoaded = Array.prototype.some.call(document.scripts || [], function (s) {
                    return /\/config\/debug\.js(?:[?#]|$)/i.test(s.src || "");
                });
                if (!scriptLoaded && W.performance && typeof W.performance.getEntriesByType === "function") {
                    scriptLoaded = W.performance.getEntriesByType("resource").some(function (e) {
                        return /\/config\/debug\.js(?:[?#]|$)/i.test(e.name || "");
                    });
                }
                return {
                    loaded: scriptLoaded && W.DEBUG === true && !!W.debugUI,
                    scriptLoaded: scriptLoaded,
                    debugFlag: W.DEBUG === true,
                    debugUi: !!W.debugUI,
                    testCommand: typeof W.cs_test_cmd === "function" && !!(W.MFC.online && W.MFC.online.send),
                    commonCommands: ["addItem", "addCoin", "addEnergy", "setAttr", "processTask"]
                };
            }

            if (action === "probe") {
                return {
                    MFC: true,
                    stageFound: !!getStage(),
                    moduleManager: mm ? {
                        className: className(mm),
                        methods: methodsOf(mm).filter(function (k) { return k.charAt(0) !== "_"; })
                    } : null,
                    moduleConstCount: constEntries().length,
                    events: ge ? { open: ge.OPEN_MODULE || null, close: ge.CLOSE_MODULE || null } : null,
                    api: {
                        openModule: !!(mm && mm.openModule),
                        closeModule: !!(mm && mm.closeModule),
                        checkModuleOpen: !!(mm && mm.checkModuleOpen),
                        findByQaName: !!(tool && tool.FindByQaName),
                        popupMgr: !!W.MFC.popupMgr
                    },
                    debug: debugInfo(),
                    MFCKeys: Object.keys(W.MFC).slice(0, 40)
                };
            }

            if (action === "listModules") {
                var filter = p.filter ? String(p.filter).toLowerCase() : null;
                var limit = Math.min(Math.max(p.limit !== undefined ? +p.limit : 60, 1), 200);
                var list = constEntries().filter(function (e) {
                    return !filter || e.name.toLowerCase().indexOf(filter) >= 0 || String(e.id).indexOf(filter) >= 0;
                });
                if (!list.length && !filter) throw new Error("没有找到模块常量表（ModuleConst）");
                return { total: list.length, modules: list.slice(0, limit) };
            }

            if (action === "isOpen") {
                var sid = moduleId(p.module);
                var st = moduleState(sid);
                return { module: p.module, moduleId: sid, known: st.known, open: !!st.open,
                    panel: st.panel && st.panel.stage ? describe(st.panel, { center: true }) : null };
            }

            if (action === "openModule" || action === "closeModule") {
                var opening = action === "openModule";
                var id = moduleId(p.module);
                var fn = mm && mm[opening ? "openModule" : "closeModule"];
                var via;
                if (typeof fn === "function" && !p.event) {
                    fn.call(mm, id, p.payload);
                    via = "MFC.moduleManager." + (opening ? "openModule" : "closeModule");
                } else {
                    var evt = p.event || (ge && (opening ? ge.OPEN_MODULE : ge.CLOSE_MODULE)) || (opening ? "open_module" : "close_module");
                    via = dispatch(evt, p.payload !== undefined ? p.payload : id) + " (" + evt + ")";
                }
                var waitMs = p.waitMs !== undefined ? +p.waitMs : 4000;
                var deadline = Date.now() + waitMs;
                var state = { known: false }, ok = false;
                while (Date.now() < deadline) {
                    await sleep(150);
                    state = moduleState(id);
                    if (!state.known) break;
                    if (opening ? state.open : !state.open) {
                        ok = true;
                        break;
                    }
                }
                var panel = state.panel && state.panel.stage ? state.panel : null;
                if (ok && panel) await waitStable(panel, 200);
                var top = sceneInfo().top;
                return {
                    via: via, module: p.module, moduleId: id,
                    ok: state.known ? ok : null,
                    panel: panel ? describe(panel, { path: true, center: true }) : null,
                    top: top ? project(describe(top, { center: true }), ["hash", "className", "id", "name", "qaName", "text", "center"]) : null
                };
            }

            if (action === "qa") {
                var qa = p.qaName;
                if (!qa) throw new Error("需要提供 qaName");
                if (tool && typeof tool.FindByQaName === "function") {
                    var found = null;
                    try {
                        found = tool.FindByQaName(qa);
                    } catch (e) {}
                    if (found) return { via: "VilGeneralTool.FindByQaName", node: describe(found, { path: true, center: true }) };
                }
                var list = query({ qaName: qa, match: p.match || "exact", visibleOnly: p.visibleOnly !== false });
                return { via: "displayList", total: list.length, node: list.length ? describe(list[0], { path: true, center: true }) : null };
            }

            if (action === "dispatch") {
                if (!p.event) throw new Error("需要提供 event");
                return { via: dispatch(p.event, p.payload), event: p.event };
            }

            if (action === "testCommand") {
                var dbg = debugInfo();
                if (!p.authorized) throw new Error("测试命令需要用户在当前任务中明确授权，并传 authorized: true");
                if (!dbg.loaded || !dbg.testCommand) throw new Error("当前页面未确认加载 config/debug.js，或测试命令接口不可用");
                if (!p.subCmd) throw new Error("需要提供 subCmd");
                var cmd = new W.cs_test_cmd();
                cmd.subCmd = String(p.subCmd);
                if (p.value1 !== undefined) cmd.value1 = p.value1;
                if (p.value2 !== undefined) cmd.value2 = p.value2;
                return await new Promise(function (resolve) {
                    var done = false;
                    var timer = setTimeout(function () {
                        if (done) return;
                        done = true;
                        resolve({ ok: false, timeout: true, subCmd: cmd.subCmd });
                    }, Math.min(Math.max(+p.timeoutMs || 10000, 1000), 30000));
                    W.MFC.online.send(cmd, function (body, error) {
                        if (done) return;
                        done = true;
                        clearTimeout(timer);
                        var failed = !body || !!(error && typeof error.isError === "function" && error.isError());
                        resolve({ ok: !failed, subCmd: cmd.subCmd,
                            value1: cmd.value1 === undefined ? null : cmd.value1,
                            value2: cmd.value2 === undefined ? null : cmd.value2 });
                    });
                });
            }

            throw new Error("未知的 action：" + action);
        },

        splanTestCommand: async function (p) {
            return handlers.splan(Object.assign({}, p, { action: "testCommand" }));
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
                },
                // $items(列表或 Scroller 的 hash, 可选筛选函数或 {字段: 值}, 可选 {fields, limit})
                $items: itemsOf
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
