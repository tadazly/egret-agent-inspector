// Egret Agent Inspector MCP 页面代理：由扩展通过 chrome.scripting.executeScript 注入到页面 MAIN world，
// 为 MCP 工具提供显示对象查询、点击、等待等能力。所有返回值均为可 JSON 序列化的普通对象。
(function () {
    var VERSION = "1.4.0";
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
            name: nameOf(o)
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

    // 弹窗里的关闭控件：命名五花八门，按关键字 + 体积 + 靠右上角的程度打分
    function findCloseControl(panel) {
        var pr = stageRect(panel);
        if (!pr) return null;
        var best = null;
        walk(panel, function (o) {
            if (o === panel) return;
            if (!o.visible || o.alpha === 0) return false;
            var r = stageRect(o);
            if (!r || r.width < 10 || r.height < 10) return;
            if (r.width * r.height > pr.width * pr.height * 0.35) return;
            var tag = [bindId(o), qaNameOf(o), nameOf(o), sourceOf(o)].filter(Boolean).join(" ");
            var t = textOf(o);
            var score = 0;
            if (CLOSE_RE.test(tag)) score += 10;
            if (t && CLOSE_TEXTS.indexOf(String(t).trim()) >= 0) score += 8;
            if (!score) return;
            if (effectiveTouchable(o)) score += 2;
            // 同分时取更靠右上、体积更小的，通常就是那个 X
            score += (r.x - pr.x) / Math.max(pr.width, 1) - (r.y - pr.y) / Math.max(pr.height, 1);
            if (!best || score > best.score) best = { o: o, score: score, rect: r };
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
        // 面板里有带文字的可点控件（对白选项、功能按钮）就不是过场：有东西可点，不该让调用方空等
        if (dialogueHasDecision(panel)) return null;
        var tags = [], cur = panel;
        for (var depth = 0; cur && depth < 4; depth++, cur = cur.parent) {
            tags.push(className(cur), nameOf(cur), bindId(cur), qaNameOf(cur), sourceOf(cur));
        }
        var namedTransition = /loading|transition|fade|switch.?map|map.?title|scene.?title|chapter.?title|location.?title|过场|转场/i
            .test(tags.filter(Boolean).join(" "));
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
        function search(root) {
            if (!root) return null;
            if (/guideMask\.GuideMask/i.test(className(root))) return root;
            var found = null;
            walk(root, function (o) {
                if (found) return false;
                if (!o.visible || o.alpha === 0) return false;
                if (/guideMask\.GuideMask/i.test(className(o))) found = o;
            });
            return found;
        }
        return search(panel) || search(getStage());
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
        "npc": ["npc", "storyinteractobject"]
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
        for (var depth = 0; cur && depth < 8; depth++) {
            var tag = className(cur) + " " + (nameOf(cur) || "") + " " + (bindId(cur) || "") + " " + (qaNameOf(cur) || "");
            if (!fallback && /button|btn|item|tab|check|toggle|close/i.test(tag)) fallback = cur;
            if (interactionListenersOf(cur).length) return fallback || cur;
            if (cur === root || cur === getStage()) break;
            cur = cur.parent;
        }
        return fallback;
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

    // ---------------------------------------------------------------- 高速动作表（observe / act）
    // 借鉴 browser-use/jev-ultrafast：一次快照产出带编号的动作表；执行时按编号复用同一批对象引用，
    // 并用「语义指纹」而不是几何变化判断还是不是决策时看到的那一页，因此持续播放的动画不会让决策作废。

    var lastTable = null;
    // 动作表对外只给编号和标签；hash、坐标和对象引用留在这里，编号靠它解析回真实对象
    var lastEntries = [];

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

    var FAST_ROLES = [
        ["npc", /storyInteractObject|(^|[_-])npc(?:[_-]|$)/i],
        ["input", /inputText|textInput|editText|textField/i],
        ["close", /close|关闭|關閉|quit|dismiss|(?:^|[\s_-])btn_no(?:$|[\s_-])/i],
        ["confirm", /confirm|btn_yes|btn_ok|确定|確定|确认|確認|知道了|好的/i],
        ["back", /back|return|返回/i],
        ["tab", /tab|toggle|switch|radio|check/i],
        ["item", /item|cell|slot|card|grid|list/i]
    ];

    var TEXT_CLASS = /label|textfield|bitmaptext|richtext/i;
    var BUTTON_TAG = /button|btn|tab|close|confirm|item|cell/i;

    function actionRoleOf(o, label, from) {
        var tag = className(o) + " " + (nameOf(o) || "") + " " + (bindId(o) || "") + " " + (qaNameOf(o) || "");
        var blob = tag + " " + (label || "");
        for (var i = 0; i < FAST_ROLES.length; i++) if (FAST_ROLES[i][1].test(blob)) return FAST_ROLES[i][0];
        if (BUTTON_TAG.test(tag)) return "button";
        // 弹窗正文、健康游戏忠告这类文字常常也挂着监听，标成 button 会诱导 agent 去点它。
        // 只看界面上真实的文案：qaName/资源名这类弱标签再长也不是正文。
        var realText = from === "text" || from === "childText";
        if (TEXT_CLASS.test(className(o)) || (realText && label.length >= 12)) return "text";
        return "button";
    }

    // 面板里的可见文案：给 agent 当页面正文用（任务描述、对白、数量）
    function panelTexts(root, budget) {
        var texts = [], stack = [], scanned = 0, total = 0;
        // 从最上层的子节点开始：弹窗正文是最后加入的子节点，从底层扫会被背景和地图吃光预算
        for (var i = 0; i < numChildren(root); i++) stack.push(childAt(root, i));
        while (stack.length && scanned < 400 && total < budget) {
            var c = stack.pop();
            scanned++;
            if (!c || !c.visible || c.alpha === 0) continue;
            var t = tidy(textOf(c), 60);
            if (t && texts.indexOf(t) < 0) {
                texts.push(t);
                total += t.length;
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

    function scrollersIn(root) {
        var out = [];
        walk(root, function (o) {
            if (out.length >= 4) return false;
            if (!o.visible || o.alpha === 0) return false;
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
            out.push(entry);
        });
        return out;
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
        var limit = Math.min(Math.max(p.limit !== undefined ? +p.limit : 30, 1), 60);
        var scoped = p.rootHash !== undefined && p.rootHash !== null;
        // 顶层「面板」可能只是一块浮动提示；这种时候把整个舞台都收进动作表，
        // 否则地图上的 NPC、入口这些真正的目标会被漏掉。占住大半个舞台的才当模态处理。
        var topRect = si.top && stageRect(si.top);
        var stageArea = stage.stageWidth * stage.stageHeight;
        var modal = !!(topRect && topRect.width * topRect.height >= stageArea * 0.6);
        var root = scoped ? byHash(p.rootHash) : (modal ? si.top : stage);
        var out = {
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
            lastEntries = [];
            lastTable = out;
            return out;
        }
        out.text = panelTexts(root, 600);

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
                lastEntries = [];
                lastTable = out;
                return out;
            }
            out.hint = "没有识别到关闭控件：优先用动作表里的关闭/确定/领取按钮，都不行再用 egret_act 的 {op:\"recommended\"} 点遮罩";
        }
        if (transientOverlay) {
            out.mode = "transient";
            out.transientOverlay = transientOverlay;
            out.marker = hashString(["transient", si.top && hashOf(si.top), out.text.join("|")].join("#"));
            out.hint = "地图标题/加载过场，没有安全点击目标：用 op=wait 短等后看返回的新动作表";
            lastEntries = [];
            lastTable = out;
            return out;
        }

        // 发现阶段的上限不能跟展示 limit 绑死：limit 调小只应该少显示几行，
        // 不能让还没扫到的弹窗按钮整个消失（limit=10 时「确定」按钮曾经就这样丢掉）。
        var discoverCap = Math.max(limit * 3, 120);
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
            for (var pi = 0; pi < points.length && owners.length < discoverCap; pi++) {
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
        var entries = [], offstage = 0, textOnly = [];
        owners.forEach(function (item) {
            var o = item.o;
            var r = stageRect(o);
            if (!r || r.width < 4 || r.height < 4) return;
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
                // 文案相同时留小的那个：外面那层大出一截就只是壳（弹窗面板带着正文当标签），
                // 普通按钮和它的文字标签大小接近，留的仍然是按钮本身
                if (kid.label === e.label) {
                    if (e._w * e._h > kid._w * kid._h * 4) dropped[e.hash] = true;
                    else dropped[kid.hash] = true;
                }
                // 包一层的容器和它唯一的按钮占同一块矩形（grp_btn / confirm），只留里面那个：
                // 里层的 label 和 role 更具体，两行一模一样只会让模型二选一浪费一轮
                else if (Math.abs(kid._x - e._x) <= 2 && Math.abs(kid._y - e._y) <= 2 &&
                    Math.abs(kid._w - e._w) <= 2 && Math.abs(kid._h - e._h) <= 2) dropped[e.hash] = true;
            });
        });
        entries = entries.filter(function (e) { return !dropped[e.hash]; });

        // 阅读顺序（先上后左），被遮挡的排到最后
        entries.sort(function (a, b) {
            if (!!a.occluded !== !!b.occluded) return a.occluded ? 1 : -1;
            if (Math.abs(a._y - b._y) > 12) return a._y - b._y;
            return a._x - b._x;
        });
        // 奖励格子这类一模一样的条目会几十个地刷屏，把真正的按钮挤出表外：同款各留前三个。
        var repeats = {}, collapsed = 0;
        entries = entries.filter(function (e) {
            if (e.occluded) return true;
            var key = e.role + "|" + e.label + "|" + e.size.join("x");
            repeats[key] = (repeats[key] || 0) + 1;
            if (repeats[key] <= 3) return true;
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
        out.omitted = Math.max(0, entries.length - limit) + collapsed + offstage;
        if (collapsed) out.collapsed = collapsed;
        if (occludedHidden) out.occludedHidden = occludedHidden;
        entries = entries.slice(0, limit);
        entries.forEach(function (entry, i) { entry.i = i + 1; });
        lastEntries = entries;
        // 默认只给「编号 + 标签 + 角色 + 状态」：按编号决策时 hash/point/size 是死重量，
        // 摆在眼前还会把模型引到 find/get_node 这些慢路径上去。detail=true 时才带回来。
        var detail = !!p.detail;
        out.actions = entries.map(function (e) {
            var row = { i: e.i, label: e.label, role: e.role };
            if (e.off) row.off = true;
            if (e.on) row.on = true;
            if (e.st) row.st = e.st;
            if (e.occluded) row.occluded = true;
            if (e.from !== "text" && e.from !== "childText") row.weak = true;
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
            if (e.from === "text" || e.from === "childText") strongLabels++;
            else weakLabels++;
        });
        if (weakLabels >= 2 && !strongLabels) out.needOcr = true;
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
        lastTable = out;
        return out;
    }

    function panelTag(o) {
        var name = qaNameOf(o) || bindId(o) || nameOf(o);
        return tidy(name, 24) || shortClass(o);
    }

    function stackSnapshot() {
        try {
            return (sceneInfo().stack || []).map(function (o) { return { hash: hashOf(o), tag: panelTag(o) }; });
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
        var target = resolveTarget(step);
        if (!target) throw new Error("步骤缺少目标：需要 i / hash / 查询条件之一");
        return { o: target, entry: null };
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
            var tableArgs = { rootHash: p.rootHash, limit: p.limit };
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
            var started = Date.now();
            var sceneBefore = stackSnapshot();
            var executed = [], stopped = "done";
            for (var n = 0; n < steps.length; n++) {
                var step = steps[n] || {};
                var op = step.op || (step.text !== undefined ? "text" : "tap");
                var before = quickSignature();
                var record = { op: op };
                try {
                    if (op === "tap" || op === "text") {
                        var resolved = resolveFastTarget(step, fresh);
                        var o = resolved.o, entry = resolved.entry;
                        record.target = entry ? { i: entry.i, label: entry.label, hash: entry.hash }
                            : { hash: hashOf(o), label: actionLabelOf(o).label };
                        if (op === "text") {
                            o.text = String(step.text);
                            if (step.dispatchChange !== false) {
                                var eg = egretNs();
                                o.dispatchEvent(new eg.Event(eg.Event.CHANGE, true));
                            }
                            record.text = String(step.text);
                        } else {
                            if (step.settleMs) await waitStable(o, +step.settleMs);
                            var r = stageRect(o);
                            if (!r) throw new Error("目标没有有效包围盒，可能已被移出舞台");
                            var pt = step.offsetX !== undefined || step.offsetY !== undefined
                                ? { x: round(r.x + (+step.offsetX || 0)), y: round(r.y + (+step.offsetY || 0)) }
                                : { x: round(r.x + r.width / 2), y: round(r.y + r.height / 2) };
                            // 执行前再解一次几何与遮挡：动作表里的坐标只是参考
                            var hit = hitTest(pt.x, pt.y);
                            if (!reaches(o, hit)) {
                                var alt = probePoint(o, true);
                                if (alt) pt = alt.point;
                                else if (!step.force) {
                                    throw new Error("目标被 " + (hit ? shortClass(hit) + "#" + hashOf(hit) : "未知对象") +
                                        " 遮挡，未执行点击：先用 op=dismiss 关掉遮挡物再重试");
                                }
                            }
                            await performGesture([pt], method, step.holdMs !== undefined ? +step.holdMs : 50, o);
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
                    } else if (op === "scroll") {
                        var scroller = step.i !== undefined || hasCriteria(step)
                            ? resolveFastTarget(step, fresh).o
                            : byHash((lastTable && lastTable.scrollers && lastTable.scrollers[0] || {}).hash);
                        if (!scroller) throw new Error("没有可滚动的目标：传 i/hash，或先 observe 看 scrollers");
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
                        record.target = { hash: hashOf(scroller), label: actionLabelOf(scroller).label };
                        record.delta = [dx, dy];
                    } else if (op === "wait") {
                        if (step.until && hasCriteria(step.until)) {
                            record.result = await handlers.waitFor(Object.assign({ timeoutMs: step.timeoutMs || 8000 }, step.until));
                            if (!record.result.matched) throw new Error("等待条件超时未满足");
                        } else {
                            await sleep(Math.min(Math.max(step.ms !== undefined ? +step.ms : 600, 0), 15000));
                        }
                    } else {
                        throw new Error("未知的 op：" + op + "（支持 tap/text/recommended/advance/dismiss/scroll/wait）");
                    }
                    if (op !== "wait" || !step.until) {
                        record.settle = await settleAfter(before, {
                            timeoutMs: step.timeoutMs !== undefined ? step.timeoutMs : p.timeoutMs,
                            stableMs: step.stableMs !== undefined ? step.stableMs : p.stableMs,
                            quietMs: step.quietMs !== undefined ? step.quietMs : p.quietMs
                        });
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
                if (table.mode !== "transient" && table.mode !== "empty" && table.mode !== "blocked") break;
                // blocked 多半是等不走的全屏接管层，短等确认它不是加载条就交回去
                if (table.mode === "blocked" && Date.now() - loadingStart >= 1500) break;
                await sleep(150);
                table = buildActionTable(tableArgs);
            }
            var loadingMs = Date.now() - loadingStart;
            if (loadingMs > 300) table.waitedForLoadingMs = loadingMs;
            table.executed = executed;
            table.stopped = stopped;
            table.elapsedMs = Date.now() - started;
            var delta = stackDelta(sceneBefore, stackSnapshot());
            table.changed = delta || (executed.some(function (r) { return r.settle && r.settle.changed; })
                ? "面板栈没变，界面内容有变化" : "界面没有变化");
            if (stopped === "done" && executed.length && executed.every(function (r) {
                return r.settle && r.settle.changed === false;
            })) {
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
