var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function () {
            function e() {
                var e = this;
                this.events = {};
                this.on = function (t, n) {
                    if (!(t in e.events)) e.events[t] = [];
                    e.events[t].push(n);
                    return e
                };
                this.trigger = function (t, n) {
                    var r = e.events[t];
                    if (!r) return;
                    for (var i = 0; i < r.length; i++) {
                        if (typeof r[i] == "function") {
                            r[i](n)
                        }
                    }
                }
            }
            e.prototype.removeAllEvents = function () {
                this.events = {}
            };
            return e
        }();
        e.EventBase = t
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function () {
            function e() {}
            e.after = function (t, n, r) {
                if (e.funcs[n]) return;
                e.funcs[n] = window.setTimeout(function () {
                    e.funcs[n] = null;
                    r()
                }, t)
            };
            e.funcs = {};
            return e
        }();
        e.RunIt = t;
        var n = function (e) {
            __extends(t, e);

            function t(t) {
                var n = this;
                e.call(this);
                this.el = t;
                this.lastX = 0;
                this.lastY = 0;
                this.isMouseDown = false;
                this.monitorY = true;
                this.begin = function (e) {
                    if (n.isMouseDown) return;
                    n.lastX = e.screenX;
                    n.lastY = e.screenY;
                    n.isMouseDown = true;
                    document.documentElement.addEventListener("mousemove", n.move);
                    document.documentElement.addEventListener("mouseup", n.end);
                    document.body.style["-webkit-user-select"] = "none"
                };
                this.move = function (e) {
                    if (n.isMouseDown == false) return;
                    var t = e.screenY - n.lastY;
                    var r = e.screenX - n.lastX;
                    if (n.monitorY) {
                        n.el.css({
                            transform: "translateY(" + t + "px)"
                        })
                    } else {
                        n.el.css({
                            transform: "translateX(" + r + "px)"
                        })
                    }
                };
                this.end = function (e) {
                    n.isMouseDown = false;
                    document.documentElement.removeEventListener("mousemove", n.move);
                    document.documentElement.removeEventListener("mouseup", n.end);
                    document.body.style["-webkit-user-select"] = "";
                    var t = e.screenY - n.lastY;
                    var r = e.screenX - n.lastX;
                    n.trigger("move", n.monitorY ? t : r);
                    n.el.css({
                        transform: ""
                    })
                };
                window.addEventListener("resize", function () {
                    n.trigger("move", 0)
                });
                t.mousedown(this.begin)
            }
            return t
        }(e.EventBase);
        e.PanelHandle = n;
        var r = function () {
            function e() {
                var e = this;
                this.controlHeight = 30;
                this.nodesHeight = 300;
                this.propsHeight = 300;
                this.nodesWidth = 300;
                this.propsWidth = 300;
                this.width = 300;
                window.addEventListener("resize", function () {
                    e.resize(0, 0)
                });
                this.resize(0, 0)
            }
            e.prototype.resize = function (e, t) {
                var n = window.innerHeight;
                var r = window.innerWidth;
                this.nodesHeight = this.propsHeight = n;
                this.propsWidth -= e;
                this.nodesWidth = r - this.propsWidth - 10
            };
            e.prototype.setWidth = function (e) {
                this.width -= e
            };
            return e
        }();
        e.Layout = r;

        function i(e) {
            var t = {};
            if (!e) return t;
            if (e.indexOf("?") == 0) e = e.substr(1);
            var n = e.split("&");
            n.forEach(function (e) {
                if (e == "?") return;
                if (!e) return;
                var n = e.split("=");
                t[n[0]] = n.length > 1 ? n[1] : null
            });
            return t
        }
        e.parseParam = i
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
Object.defineProperty(Object.prototype, "getDisplayName", {
    value: function () {
        if (typeof this == "number") return this;
        if (egret.getQualifiedClassName) return egret.getQualifiedClassName(this);
        if (this.constructor && this.constructor.name) return this.constructor.name;
        if (lark && this.__classFlag__) {
            return lark.Types[this.__classFlag__]
        }
    }
});
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments);
                this._children = [];
                this._props = [];
                this.parentHash = -1;
                this.show = false;
                this.visible = true;
                this.type = null;
                this.memberName = null;
                this.selected = false;
                this.expandable = false;
                this.isGetter = false;
                this.isSetter = false;
                this.icon = "-";
                this.dirty = false;
                this.hasChildren = false
            }
            t.prototype.updateIcon = function () {
                this.icon = this.hasChildren == false ? "&nbsp;" : this.show ? "-" : "+"
            };
            t.prototype.recover = function () {
                if (this.show && this.hasChildren && (this.children != this._children || this.props != this._props)) {
                    this.children = null;
                    this.props = null;
                    this.showChildren()
                }
            };
            t.prototype.showChildren = function () {
                if (!this.hasChildren) return;
                this.show = true;
                if (!this.children) {
                    this.children = this._children;
                    this.props = this._props;
                    this.trigger(t.ChildrenChange)
                }
                this.updateIcon();
                this.trigger(t.Show)
            };
            t.prototype.toggle = function () {
                if (!this.children && !this.show) {
                    this.showChildren();
                    return
                }
                this.show = !this.show;
                this.updateIcon();
                this.trigger(t.Show)
            };
            t.prototype.parseChildren = function () {
                t.parseChildren(this.raw, this)
            };
            t.prototype.reset = function (e) {
                if (e === void 0) {
                    e = true
                }
                var n = [this];
                while (n.length) {
                    var r = n.pop();
                    var i = r._children || [];
                    var o = r._props || [];
                    for (var s = 0; s < i.length; s++) n.push(i[s]);
                    for (var a = 0; a < o.length; a++) n.push(o[a]);
                    r._children = [];
                    r._props = [];
                    r.children = null;
                    r.props = null;
                    r.show = false;
                    if (e) {
                        delete t.hash2Node[r.rawHash];
                        delete t.hash2DisplayObject[r.rawHash]
                    }
                }
            };
            Object.defineProperty(t.prototype, "raw", {
                get: function () {
                    return t.hash2DisplayObject[this.rawHash]
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(t.prototype, "parent", {
                get: function () {
                    if (this.parentHash == -1) return null;
                    return t.hash2Node[this.parentHash]
                },
                enumerable: true,
                configurable: true
            });
            t.getValue = function (e, t) {
                if (e == null) return String(e);
                var n = typeof e;
                var r = null;
                t.type = n;
                switch (n) {
                    case "string":
                        r = JSON.stringify(e);
                        break;
                    case "number":
                        if (e == NaN) e = "NaN";
                        r = e;
                        return r;
                    case "array":
                        r = String(e);
                        t.expandable = true;
                        break;
                    case "object":
                        r = e.constructor["name"] || e["__class__"] || "object";
                        t.expandable = true;
                        break;
                    case "function":
                        r = String(e);
                        t.name;
                        break;
                    default:
                        r = String(e)
                }
                return r
            };
            t.prototype.naviToDisplayObject = function (e) {
                if (!t.isLinked(e)) {
                    t.linkToIt(e);
                    this.dirty = true
                }
                this.naviToNode(e.hashCode)
            };
            t.prototype.naviToNode = function (e, n) {
                if (n === void 0) {
                    n = false
                }
                var r = t.getByHash(e);
                if (!r) return;
                var i = [];
                var o = r.parent;
                var a = {};
                while (o != null && !a[o.rawHash]) {
                    a[o.rawHash] = true;
                    i.push(o);
                    o = o.parent
                }
                for (var s = i.length - 1; s >= 0; s--) i[s].showChildren();
                r.showUp()
            };
            t.prototype.showUp = function () {
                if (t.selected) {
                    t.selected.selected = false;
                    t.selected.trigger(t.UnSelected)
                }
                this.selected = true;
                t.selected = this;
                this.trigger(t.OnSelected)
            };
            t.prototype.find = function (e, t) {
                if (this.rawHash == e) {
                    t.push(this);
                    return true
                }
                if (!this.hasChildren) return false;
                t.push(this);
                var n = this._props.filter(function (n) {
                    return n.find(e, t)
                });
                var r = n.length > 0;
                if (!r) {
                    n = this._children.filter(function (n) {
                        return n.find(e, t)
                    });
                    r = n.length > 0
                }
                if (!r) {
                    t.pop();
                    return false
                }
                return true
            };
            t.prototype.parseRawProps = function (e, n, r) {
                if (n === void 0) {
                    n = new t
                }
                return t.parseRawProps(this.raw, e, n, r)
            };
            t.parseRawProps = function (e, n, r, i) {
                if (r === void 0) {
                    r = new t
                }
                if (i === void 0) {
                    i = {
                        showPrivate: true,
                        showMethods: false
                    }
                }
                if (n < 0) return;
                if (typeof e != "object") return;
                var o = [];
                for (var s in e) {
                    if (i.showPrivate === false && (String(s).indexOf("_") == 0 || String(s).indexOf("$") == 0)) {
                        continue
                    }
                    var a = new t;
                    a.name = s;
                    var h = null;
                    var c = null;
                    var l = e;
                    c = Object.getOwnPropertyDescriptor(e, s);
                    while (c == null && l) {
                        l = Object.getPrototypeOf(l);
                        c = Object.getOwnPropertyDescriptor(l, s)
                    }
                    if (c) {
                        a.isGetter = c.get != undefined;
                        a.isSetter = a.isGetter && c.set != undefined
                    }
                    try {
                        h = e[s]
                    } catch (u) {
                        h = "faild to get value"
                    }
                    if (typeof h == "function" && i.showMethods != true) continue;
                    t.parseRawProps(h, n - 1, a);
                    a.value = t.getValue(h, a);
                    o.push(a)
                }
                o.sort(function (e, t) {
                    var n = e.name;
                    var r = t.name;
                    return n > r ? 1 : n == r ? 0 : -1
                });
                r.name = e.getDisplayName();
                r._props = o;
                return r
            };
            t.parseRawProp = function (e, n, r, i) {
                if (i === void 0) {
                    i = new t
                }
                i.name = e;
                t.parseRawProps(n, r - 1, i);
                i.value = t.getValue(n, i);
                return i
            };
            t.prototype.toString = function () {
                return this.name
            };
            t.linkToIt = function (e, n) {
                if (n === void 0) {
                    n = null
                }
                var r = [];
                var i = {};
                var o = e;
                while (o) {
                    if (i[o.hashCode]) break;
                    i[o.hashCode] = true;
                    r.push(o);
                    if (t.hash2Node[o.hashCode] != undefined) break;
                    o = o.parent
                }
                var s = n;
                var a = null;
                for (var h = 0; h < r.length; h++) {
                    var c = r[h];
                    var l = t.hash2Node[c.hashCode];
                    if (l != undefined) {
                        l.reset(false);
                        t.parseChildren(c, l, 0)
                    } else {
                        l = t.parseNode(c)
                    }
                    l.showChildren();
                    if (s) {
                        for (var u = 0; u < l._children.length; u++) {
                            if (l._children[u].rawHash == s.rawHash) {
                                l._children[u] = s;
                                break
                            }
                        }
                    }
                    s = l;
                    a = l
                }
                return a
            };
            t.unLinkIt = function (e) {
                var n = t.hash2Node[e.hashCode];
                var r = n.parent;
                var i = r._children.indexOf(n);
                r._children.splice(i, 1)
            };
            t.isLinked = function (e) {
                return t.hash2Node[e.hashCode] != undefined
            };
            t.parseChildren = function (e, n, r) {
                if (r === void 0) {
                    r = 0
                }
                if (e["numChildren"] !== undefined) {
                    var i = e;
                    if (i.numChildren == 0) {
                        n.hasChildren = false;
                        return
                    } else n.hasChildren = true;
                    n._children = [];
                    for (var o = 0, s = i.numChildren; o < s; o++) {
                        var a = t.parseNode(i.getChildAt(o), new t, false, r);
                        n._children.push(a)
                    }
                }
            };
            t.parseNode = function (e, n, r, i) {
                if (n === void 0) {
                    n = new t
                }
                if (r === void 0) {
                    r = false
                }
                if (i === void 0) {
                    i = 1
                }
                if (i < 0) return null;
                if (r) {
                    t.clear()
                }
                t.hash2Node[e.hashCode] = n;
                t.hash2DisplayObject[e.hashCode] = e;
                var o = e.getDisplayName();
                n.name = o;
                n.memberName = e.name;
                n.type = o;
                n.visible = e.visible && e.alpha != 0;
                n.rawHash = e.hashCode;
                var s = e;
                n.hasChildren = !!(s.numChildren && s.numChildren > 0);
                if (e.parent) n.parentHash = e.parent.hashCode;
                if (i > 0) {
                    t.parseChildren(e, n, i - 1)
                }
                n.updateIcon();
                return n
            };
            t.parseRawObject = function (e, n) {
                if (n === void 0) {
                    n = new t
                }
                return t.parseRawProps(e, 0, n)
            };
            t.getByHash = function (e) {
                return t.hash2Node[e]
            };
            t.clear = function () {
                t.hash2Node = {};
                t.hash2DisplayObject = {};
                t.selected = null
            };
            t.toFlat = function (e) {
                if (!e || e.__egretTreeFlat) return e;
                var n = [];
                var r = [];
                var i = new Map;
                var o = function (e) {
                    if (i.has(e)) return i.get(e);
                    var t = n.length;
                    i.set(e, t);
                    n.push(e);
                    r.push(null);
                    return t
                };
                o(e);
                for (var s = 0; s < n.length; s++) {
                    var a = n[s];
                    var h = {};
                    Object.getOwnPropertyNames(a).forEach(function (e) {
                        if (e == "events" || e == "_children" || e == "_props" || e == "children" || e == "props") return;
                        var t = a[e];
                        if (typeof t != "function") h[e] = t
                    });
                    r[s] = {
                        data: h,
                        children: (a._children || []).map(o),
                        props: (a._props || []).map(o)
                    }
                }
                return {
                    __egretTreeFlat: 1,
                    nodes: r,
                    root: 0
                }
            };
            t.fromFlat = function (e, n, r) {
                if (!e || !e.__egretTreeFlat || !e.nodes || !e.nodes.length) return null;
                var i = new Array(e.nodes.length);
                for (var o = 0; o < i.length; o++) i[o] = o == e.root && n ? n : new t;
                for (var s = 0; s < i.length; s++) {
                    var a = i[s];
                    var h = e.nodes[s];
                    var l = h.data || {};
                    Object.getOwnPropertyNames(l).forEach(function (e) {
                        a[e] = l[e]
                    });
                    a._children = (h.children || []).map(function (e) {
                        return i[e]
                    });
                    a._props = (h.props || []).map(function (e) {
                        return i[e]
                    });
                    a.children = a.show ? a._children : null;
                    a.props = a.show ? a._props : null;
                    a.updateIcon();
                    if (a.rawHash != null && a.rawHash != -1) t.hash2Node[a.rawHash] = a
                }
                var o = i[e.root || 0];
                r && o.trigger(t.Changed);
                return o
            };
            t.clone = function (e, n, r) {
                if (n === void 0) {
                    n = false
                }
                return t.fromFlat(t.toFlat(e), r, n)
            };
            t.Show = "show";
            t.UnSelected = "unselected";
            t.OnSelected = "selected";
            t.ChildrenChange = "childrenchange";
            t.Changed = "changed";
            t.hash2Node = {};
            t.hash2DisplayObject = {};
            t.ignore = {
                _parent: 1,
                parent: 1,
                _stage: 1,
                stage: 1,
                _eventTarget: 1,
                _children: 1,
                _owner: 1,
                _rendererOwner: 1
            };
            t.selected = null;
            return t
        }(e.EventBase);
        e.TreeNode = t;
        var n = function () {
            function e() {
                this.dirtyCount = [];
                this.dirtyKey = {};
                this.init = false
            }
            e.prototype.push = function (e) {
                while (e != null) {
                    if (e.hashCode in this.dirtyKey) {
                        this.dirtyCount[this.dirtyKey[e.hashCode]] += 1;
                        break
                    } else if (this.init == false) {
                        var t = 0;
                        if (this.dirtyCount.length == 0) t = 1;
                        this.dirtyCount.push(t);
                        this.dirtyKey[e.hashCode] = this.dirtyCount.length - 1
                    }
                    e = e.parent
                }
                this.init = true
            };
            e.prototype.getRootHash = function () {
                for (var e = this.dirtyCount.length; e >= 0; e--) {
                    if (this.dirtyCount[e] > 0) {
                        break
                    }
                }
                for (var t in this.dirtyKey) {
                    if (this.dirtyKey[t] == e) return t
                }
            };
            e.prototype.reset = function () {
                this.dirtyCount = [];
                this.dirtyKey = {};
                this.init = false
            };
            return e
        }();
        e.TreeDirtyCache = n
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var EGRETRELEASE = true;
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function () {
            function e(e, t) {
                this.host = e;
                this.callbacks = {};
                this.namedCallbacks = {};
                this.key = null;
                this.getKey();
                this._connect(t)
            }
            e.prototype._connect = function (e) {};
            e.prototype.post = function (e, t, n) {
                if (t === void 0) {
                    t = null
                }
                var r = t;
                if (n) {
                    r = (performance.now() + Math.random() * 100).toString();
                    this.callbacks[r] = n
                }
                var i = {
                    id: r,
                    data: e,
                    key: this.key
                };
                this._doPost(i);
                return this
            };
            e.prototype._doPost = function (e) {
                this.port.postMessage(e)
            };
            e.prototype.on = function (e, t) {
                if (!this.namedCallbacks[e]) this.namedCallbacks[e] = [];
                this.namedCallbacks[e].push(t);
                return this
            };
            e.prototype.remove = function (e, t) {
                var n = this.namedCallbacks[e];
                if (n) {
                    var r = n.indexOf(t);
                    if (r < 0) return;
                    n.splice(r, 1)
                }
                return this
            };
            e.prototype.removeAll = function () {
                this.namedCallbacks = {};
                return this
            };
            e.prototype._parseMsgData = function (e) {
                return null
            };
            e.prototype._onMessage = function (e) {
                var t = this;
                var n = this._parseMsgData(e);
                var r = n.id;
                var i = n.data && n.data.name;
                var o = this.callbacks[r];
                if (o) {
                    o(n.data);
                    delete this.callbacks[r]
                }
                var s = this.namedCallbacks[i];
                if (s) {
                    s.forEach(function (e) {
                        var i = e(n.data, function (e) {
                            if (r) {
                                t.post(e, r)
                            }
                        });
                        if (r && i) {
                            t.post(i, r)
                        }
                    })
                }
            };
            e.prototype.getKey = function () {
                if (window.name == "") {
                    window.name = Date.now().toString()
                }
                this.key = window.name
            };
            return e
        }();
        e.PortBase = t
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments)
            }
            t.prototype._connect = function (e) {
                var t = this;
                var n = chrome.runtime.connect();
                n.onMessage.addListener(function (e) {
                    return t._onMessage(e)
                });
                this.port = n;
                e && window.setTimeout(e.bind(this), 0)
            };
            t.prototype._doPost = function (e) {
                this.port.postMessage(e)
            };
            t.prototype._parseMsgData = function (e) {
                return e
            };
            return t
        }(e.PortBase);
        e.ChromePort = t;
        var n = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments)
            }
            t.prototype._connect = function (e) {
                var t = this;
                var n = chrome.runtime.connect();
                n.onMessage.addListener(function (e) {
                    return t._onMessage(e)
                });
                this.port = n;
                window.addEventListener("message", function (e) {
                    return t._onWindowMessage(e.data)
                });
                e && window.setTimeout(e.bind(this), 0)
            };
            t.prototype._doPost = function (e) {
                this.port.postMessage(e)
            };
            t.prototype._parseMsgData = function (e) {
                return e
            };
            t.prototype._onMessage = function (t) {
                if (t.toContent) {
                    e.prototype._onMessage.call(this, t)
                } else {
                    window.postMessage(t, "*")
                }
            };
            t.prototype._onWindowMessage = function (e) {
                if (e["from"] == "stage") {
                    var t = JSON.parse(e.data);
                    this.post(t, e.id)
                }
            };
            return t
        }(e.PortBase);
        e.ContentPort = n;
        var r = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments)
            }
            t.prototype._connect = function (e) {
                var t = this;
                window.addEventListener("message", function (e) {
                    return t._onMessage(e)
                });
                e && window.setTimeout(e.bind(this), 0)
            };
            t.prototype._doPost = function (e) {
                window.postMessage({
                    from: "stage",
                    id: e.id,
                    data: JSON.stringify(e.data)
                }, "*")
            };
            t.prototype._parseMsgData = function (e) {
                return e.data
            };
            t.prototype._onMessage = function (t) {
                var n = this._parseMsgData(t);
                if (!n.data) return;
                if (n["from"] == "stage") return false;
                e.prototype._onMessage.call(this, t)
            };
            return t
        }(e.PortBase);
        e.StagePort = r;
        var i = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments)
            }
            t.prototype._connect = function (e) {
                var t = this;
                var n = new WebSocket("ws://" + this.host);
                this.port = n;
                n.addEventListener("message", function (e) {
                    return t._onMessage(e)
                });
                n.addEventListener("open", function (n) {
                    return e(t)
                })
            };
            t.prototype._doPost = function (e) {
                var t = this.port;
                t.send(JSON.stringify(e))
            };
            t.prototype._parseMsgData = function (e) {
                return JSON.parse(e.data)
            };
            return t
        }(e.PortBase);
        e.WsPort = i
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var egret;
(function (e) {
    var t;
    (function (e) {
        e.PortFactory = null
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var egret;
(function (e) {
    var t;
    (function (t) {
        var n = function () {
            function t() {}
            t.prototype.getStagePortClass = function () {
                return e.devtool.StagePort
            };
            t.prototype.getPanelPortClass = function () {
                return e.devtool.ChromePort
            };
            t.prototype.getExtContentPortClass = function () {
                return e.devtool.ContentPort
            };
            return t
        }();
        t.ChromePortFactory = n;
        t.PortFactory = new n
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments)
            }
            Object.defineProperty(t.prototype, "height", {
                set: function (e) {
                    this.container.height(e)
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(t.prototype, "width", {
                set: function (e) {
                    this.container.width(e)
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(t.prototype, "data", {
                get: function () {
                    return this._data
                },
                set: function (e) {
                    this._data = e;
                    this.trigger("datachange")
                },
                enumerable: true,
                configurable: true
            });
            t.prototype.init = function () {};
            t.prototype.showChildren = function () {};
            return t
        }(e.EventBase);
        e.Panel = t
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function (e) {
            __extends(t, e);

            function t() {
                e.apply(this, arguments);
                this.maxBarCount = 60;
                this._fpsList = [];
                this._fps = 0
            }
            Object.defineProperty(t.prototype, "fps", {
                get: function () {
                    return this._fps
                },
                set: function (e) {
                    this._fps = e;
                    this._fpsList.push(e);
                    if (this._fpsList.length > this.maxBarCount) {
                        this._fpsList.shift()
                    }
                    this.trigger("fps")
                },
                enumerable: true,
                configurable: true
            });
            t.prototype.init = function () {
                var e = this;
                this.container = $("#profile");
                this.fpsTag = $("#fps");
                this.chartCtx = document.getElementById("fpsChart").getContext("2d");
                this.on("fps", function () {
                    e.fpsTag.text(e._fps);
                    e.drawChart()
                })
            };
            t.prototype.drawChart = function () {
                var e = this._fpsList.length;
                var t = this.chartCtx.canvas.width;
                var n = this.chartCtx.canvas.height;
                var r = Math.round(t / this.maxBarCount);
                var i = Math.min.apply(Math, this._fpsList);
                i = 0;
                this.chartCtx.clearRect(0, 0, t, n);
                for (var o = 0; o < e; o++) {
                    var s = this._fpsList[o] - i;
                    var a = s / (70 - i) * n;
                    var h = r * o;
                    var c = n - a;
                    var l = a / n * 200;
                    l = Math.round(l);
                    l = Math.max(l, 1);
                    var u = 200 - l;
                    this.chartCtx.fillStyle = "rgb(" + u + "," + l + ",0)";
                    this.chartCtx.fillRect(h, c, r - 1, a)
                }
            };
            return t
        }(e.Panel);
        e.ProfilePanel = t
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function (t) {
            __extends(n, t);

            function n() {
                t.apply(this, arguments);
                this.chkShowId = $("#chkShowId");
                this.chkPreventTouch = $("#chkPreventTouch");
                this.chkHighlightHover = $("#chkHighlightHover");
                this.chkHighlightClick = $("#chkHighlightClick");
                this.searchForm = $("#searchForm");
                this.btnRefresh = $("#refreshTree");
                this._highlightHover = false;
                this._highlightClick = true;
                this._preventTouch = false;
                this._showId = false;
                this._hoverFrame = 0;
                this._hoverHash = null;
                this._lastHoverHash = null;
                this._renderFrame = 0;
                this._visibleNodes = [];
                this._rowHeight = 16
            }
            Object.defineProperty(n.prototype, "highlightHover", {
                set: function (e) {
                    this._highlightHover = e;
                    if (e != this.chkHighlightHover.is("checked")) this.chkHighlightHover.attr("checked", e);
                    window.localStorage.setItem("highlightHover", String(e));
                    this.port.post({
                        name: "highlightHover",
                        data: e
                    })
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(n.prototype, "highlightClick", {
                set: function (e) {
                    this._highlightClick = e;
                    if (e != this.chkHighlightClick.is(":checked")) this.chkHighlightClick.attr("checked", e);
                    window.localStorage.setItem("highlightClick", String(e));
                    this.port.post({
                        name: "highlightClick",
                        data: e
                    })
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(n.prototype, "preventTouch", {
                set: function (e) {
                    this._preventTouch = e;
                    if (e != this.chkPreventTouch.is(":checked")) this.chkPreventTouch.attr("checked", e);
                    window.localStorage.setItem("preventTouch", String(e));
                    this.port.post({
                        name: "preventTouch",
                        data: this._preventTouch
                    })
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(n.prototype, "showId", {
                set: function (e) {
                    this._showId = e;
                    if (e != this.chkShowId.is(":checked")) this.chkShowId.prop("checked", e);
                    window.localStorage.setItem("showId", String(e));
                    if (this.container) this._renderViewport()
                },
                enumerable: true,
                configurable: true
            });
            n.prototype.init = function () {
                var e = this;
                t.prototype.init.call(this);
                this.container = $("#nodes");
                this.itemTmpl = this.container.html();
                this.container.html("");
                this.container.on("scroll", function () {
                    if (e._renderFrame) return;
                    e._renderFrame = window.requestAnimationFrame(function () {
                        e._renderFrame = 0;
                        e._renderViewport()
                    })
                });
                this.on("datachange", function () {
                    return e.showChildren()
                });
                this.chkShowId.change(function () {
                    e.showId = e.chkShowId.is(":checked")
                });
                this.showId = (window.localStorage.getItem("showId") || "false") == "true";
                this.chkPreventTouch.change(function () {
                    return e._onChkPreventTouchChange()
                });
                this.highlightClick = (window.localStorage.getItem("highlightClick") || "true") == "true";
                this.highlightHover = (window.localStorage.getItem("highlightHover") || "false") == "true";
                this.preventTouch = (window.localStorage.getItem("preventTouch") || "false") == "true";
                this.chkHighlightClick.change(function () {
                    return e._onChkHighlightClickChange()
                });
                this.chkHighlightHover.change(function () {
                    return e._onChkHighlightHoverChange()
                });
                this.btnRefresh.click(function () {
                    return e.refresh()
                });
                this.searchForm.submit(function () {
                    e.search();
                    return false
                });
                window.addEventListener("keydown", function (e) {
                    if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.keyCode == 70) {
                        $("#txtSearchName").focus().select();
                        e.stopPropagation();
                        e.preventDefault()
                    }
                }, true);
                $.contextMenu({
                    selector: ".display-object",
                    items: {
                        store: {
                            name: "存储为全局变量"
                        },
                        axesHelper: {
                            name: "位置缩放编辑"
                        }
                    },
                    callback: function (t, n) {
                        var r = n.$trigger;
                        var i = r.data("hashCode");
                        e.port.post({
                            name: t,
                            hashCode: i
                        })
                    }
                })
            };
            n.prototype.showChildren = function () {
                this._visibleNodes = [];
                if (!this._data) return;
                var t = [{
                    node: this._data,
                    level: 0
                }];
                while (t.length) {
                    var n = t.pop();
                    var r = n.node;
                    if (!r || r.memberName == "$LarkMetricMask") continue;
                    this._visibleNodes.push(n);
                    if (r.show && r._children && r._children.length) {
                        for (var o = r._children.length - 1; o >= 0; o--) {
                            t.push({
                                node: r._children[o],
                                level: n.level + 1
                            })
                        }
                    }
                }
                var e = -1;
                for (var i = 0; i < this._visibleNodes.length; i++) {
                    if (this._visibleNodes[i].node.selected) {
                        e = i;
                        break
                    }
                }
                if (e >= 0) {
                    var o = e * this._rowHeight;
                    var s = this.container.scrollTop();
                    var a = this.container.height();
                    if (o < s || o + this._rowHeight > s + a) this.container.scrollTop(Math.max(0, o - a / 2))
                }
                this._renderViewport()
            };
            n.prototype._renderViewport = function () {
                if (!this.container || !this.container.length) return;
                var e = this._visibleNodes || [];
                var t = this._rowHeight;
                var n = Math.max(0, Math.floor(this.container.scrollTop() / t) - 10);
                var r = Math.min(e.length, n + Math.ceil(this.container.height() / t) + 20);
                var i = document.createDocumentFragment();
                var o = document.createElement("div");
                o.className = "tree-scroll-spacer";
                o.style.height = e.length * t + "px";
                i.appendChild(o);
                for (var s = n; s < r; s++) {
                    var a = this.bindNode(e[s].node, e[s].level);
                    if (!a || !a[0]) continue;
                    a.css({
                        position: "absolute",
                        top: s * t + "px",
                        left: 0,
                        right: 0,
                        height: t + "px"
                    });
                    i.appendChild(a[0])
                }
                this.container.empty()[0].appendChild(i)
            };
            n.prototype.bindNode = function (t, n) {
                var r = this;
                t.removeAllEvents();
                var i = this;
                var c = i.buildLabel(t);
                var o = i.itemTmpl.replace("{label}", function () {
                    return c
                }).replace("{icon}", function () {
                    return t.icon
                });
                var s = $(o);
                var h = s.find(".toggle");
                s.data("hashCode", t.rawHash);
                h.prop("checked", !!t.visible);
                if (t.visible == false) {
                    s.addClass("invisible")
                }
                h.click(function (e) {
                    e.stopPropagation();
                    var n = h.is(":checked");
                    t.visible = n;
                    r.mainPanel.port.post({
                        name: "applyChange",
                        hash: t.rawHash,
                        expressions: {
                            "['visible']": n,
                            "['alpha']": n ? 1 : undefined
                        }
                    }, null, function (e) {
                        s.toggleClass("invisible");
                        console.log(e)
                    })
                });
                var l = s.find(".icon");
                var p = s.find(".parent");
                s.find(".children").remove();
                p.css("padding-left", n + "em");
                if (t.selected) p.addClass("selected");
                var d = function () {
                    if (t._children.length == 0 && t.hasChildren) {
                        r.port.post({
                            name: "expandTree",
                            hashCode: t.rawHash
                        }, null, function (n) {
                            e.TreeNode.clone(n, false, t);
                            t.show = true;
                            t.updateIcon();
                            r.showChildren()
                        })
                    } else {
                        t.show = !t.show;
                        t.updateIcon();
                        r.showChildren()
                    }
                };
                p.click(function () {
                    return i.showItInGame(t)
                });
                p.mouseenter(function () {
                    return i.queueGameHover(t)
                });
                l.click(function () {
                    d();
                    return false
                });
                p.dblclick(function () {
                    d();
                    return false
                });
                return s
            };
            // 显示格式：id ( name ) : 类名；仅有 id 或 name 时显示 id : 类名 / name : 类名
            n.prototype.buildLabel = function (e) {
                var t = function (e) {
                    return String(e).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
                };
                var n = this._showId && e.bindId ? e.bindId : "";
                var r = e.memberName ? e.memberName : "";
                var i = "";
                if (n) {
                    i = '<span class="bindId">' + t(n) + "</span>";
                    if (r) i += ' <span class="memberName">( ' + t(r) + " )</span>"
                } else if (r) {
                    i = '<span class="memberName">' + t(r) + "</span>"
                }
                if (i) i += '<span class="nameSeparator"> : </span>';
                return i + t(e.name)
            };
            n.prototype.queueGameHover = function (e) {
                var t = this;
                this._hoverHash = e.rawHash;
                if (this._hoverFrame) return;
                this._hoverFrame = window.requestAnimationFrame(function () {
                    t._hoverFrame = 0;
                    if (t._hoverHash == t._lastHoverHash) return;
                    t._lastHoverHash = t._hoverHash;
                    var n = egret.devtool.TreeNode.getByHash(t._hoverHash);
                    if (n) t.showItInGame(n, true)
                })
            };
            n.prototype.showGameSelection = function (t, n) {
                if (n) {
                    var i = n.__egretTreeFlat ? n.nodes[n.root || 0].data.rawHash : n.rawHash;
                    var r = e.TreeNode.getByHash(i);
                    e.TreeNode.clone(n, true, r)
                }
                if (!this._data || !e.TreeNode.getByHash(t)) return;
                this._data.naviToNode(t);
                this.showChildren()
            };
            n.prototype.showItInGame = function (e, t) {
                if (t === void 0) {
                    t = false
                }
                if (!t) {
                    this.mainPanel.propsPanel.selectedHash = e.rawHash;
                    e.showUp();
                    this.showChildren()
                }
                if (!t || t && this._highlightHover) this.transTreeSelection(e.rawHash, t)
            };
            n.prototype.transTreeSelection = function (e, t) {
                if (t === void 0) {
                    t = false
                }
                this.mainPanel.port.post({
                    name: "showTreeSelection",
                    data: e,
                    isHover: t
                })
            };
            n.prototype.refresh = function () {
                var t = this;
                this.port.post({
                    name: "refresh"
                }, null, function (n) {
                    e.TreeNode.clear();
                    var r = e.TreeNode.clone(n.tree, false);
                    t.data = r;
                    t.data.naviToNode(n.hash);
                    t.showChildren()
                })
            };
            n.prototype.search = function () {
                var e = this;
                var t = $.trim($("#txtSearchName").val());
                if (!t) return false;
                var n = this.searchForm.data("query") == t ? this.searchForm.data("current") : null;
                this.searchForm.data("query", t);
                var r = {
                    name: "search",
                    option: {
                        current: n,
                        name: t
                    }
                };
                this.port.post(r, null, function (t) {
                    if (!t || !t.results || !t.results.length) {
                        e.searchForm.removeData("current");
                        return
                    }
                    e.searchForm.data("current", t.current);
                    if (t.selection) {
                        e.mainPanel.showGameSelection(t.selection.hash, t.selection.props, t.selection.treeChange)
                    } else {
                        e.showGameSelection(t.current)
                    }
                });
                return false
            };
            n.prototype._onChkPreventTouchChange = function () {
                this.preventTouch = this.chkPreventTouch.is(":checked")
            };
            n.prototype._onChkHighlightClickChange = function () {
                this.highlightClick = this.chkHighlightClick.is(":checked")
            };
            n.prototype._onChkHighlightHoverChange = function () {
                this.highlightHover = this.chkHighlightHover.is(":checked")
            };
            return n
        }(e.Panel);
        e.TreePanel = t
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = ["x", "y", "width", "height", "measuredWidth", "measuredHeight", "layoutBoundsWidth", "layoutBoundsHeight", "preferredWidth", "preferredHeight", "left", "right", "top", "bottom", "percentWidth", "percentHeight", "verticalCenter", "horizontalCenter", "explicitWidth", "explicitHeight", "includeInLayout", "preferredX", "preferredY", "layoutBoundsX", "layoutBoundsY", "maxWidth", "minWidth", "skin", "skinName", "source", "content", "maxHeight", "minHeight", "visible", "alpha", "parent"];
        var n = function (e) {
            __extends(n, e);

            function n() {
                var t = this;
                e.apply(this, arguments);
                this._showMethods = false;
                this._showPrivate = true;
                this.onShowPrivateChanged = function () {
                    t.showPrivate = t.chkShowPrivate.is(":checked")
                };
                this.onShowMethodsChanged = function () {
                    t.showMethods = t.chkShowMethods.is(":checked")
                };
                this.refresh = function () {
                    t.port.post({
                        name: "refreshProp",
                        hash: t.selectedHash
                    })
                };
                this.lastQuery = "";
                this.filterProps = function () {
                    var e = t.txtSearchProp.val();
                    if (!e) {
                        t.container.find(".property.searchResult").removeClass("searchResult searchCurrent");
                        t.lastQuery = e;
                        return
                    }
                    var n = null;
                    if (t.lastQuery != e) {
                        t.container.find(".property.searchResult").removeClass("searchResult searchCurrent");
                        var r = t.container.find(".property:Contains(" + e + ")");
                        r.addClass("searchResult");
                        $(r[0]).addClass("searchCurrent");
                        t.lastQuery = e;
                        n = $(r[0])
                    } else {
                        var r = t.container.find(".property.searchResult");
                        if (r.length == 1) {
                            n = r;
                            return
                        }
                        for (var i = 0; i < r.length; i++) {
                            var o = $(r[i]);
                            if (!o.hasClass("searchCurrent")) continue;
                            var s = i + 1 < r.length ? i + 1 : 0;
                            var a = $(r[s]);
                            a.addClass("searchCurrent");
                            n = a;
                            o.removeClass("searchCurrent");
                            break
                        }
                    }
                    if (!n || n.length == 0) return;
                    var h = t.container.height();
                    var c = t.container.offset().top;
                    var l = n.offset().top - c;
                    if (l > h || l < 0) {
                        var u = t.container.scrollTop() + l;
                        t.container.animate({
                            scrollTop: u
                        }, 200)
                    }
                }
            }
            Object.defineProperty(n.prototype, "showMethods", {
                set: function (e) {
                    this._showMethods = e;
                    if (e != this.chkShowMethods.is(":checked")) this.chkShowMethods.attr("checked", e);
                    window.localStorage.setItem("showMethods", String(e));
                    this.port.post({
                        name: "showMethodsChanged",
                        showMethods: this._showMethods,
                        hash: this.selectedHash
                    })
                },
                enumerable: true,
                configurable: true
            });
            Object.defineProperty(n.prototype, "showPrivate", {
                set: function (e) {
                    this._showPrivate = e;
                    if (e != this.chkShowPrivate.is(":checked")) this.chkShowPrivate.attr("checked", e);
                    window.localStorage.setItem("showPrivate", String(e));
                    this.port.post({
                        name: "showPrivateChanged",
                        showPrivate: this._showPrivate,
                        hash: this.selectedHash
                    })
                },
                enumerable: true,
                configurable: true
            });
            n.prototype.init = function () {
                var t = this;
                e.prototype.init.call(this);
                this.container = $("#props");
                this.title = this.container.find(".title");
                this.properties = this.container.find(".properties");
                this.chkShowMethods = $("#showMethods");
                this.chkShowPrivate = $("#showPrivate");
                this.txtSearchProp = $("#txtSearchProp");
                this.btnRefreshProps = $("#refreshProps");
                this.itemTmpl = this.properties.html();
                this.properties.html("");
                this.on("datachange", function () {
                    return t.showChildren()
                });
                this.showPrivate = (window.localStorage.getItem("showPrivate") || "true") == "true";
                this.showMethods = (window.localStorage.getItem("showMethods") || "false") == "true";
                this.chkShowPrivate.click(this.onShowPrivateChanged);
                this.chkShowMethods.click(this.onShowMethodsChanged);
                this.btnRefreshProps.click(this.refresh);
                window.addEventListener("keydown", function (e) {
                    if ((e.ctrlKey || e.metaKey) && e.keyCode == 70 && !e.shiftKey) {
                        t.txtSearchProp.focus().select();
                        e.stopPropagation();
                        e.preventDefault()
                    }
                }, true);
                this.txtSearchProp.keyup(function (e) {
                    window.setTimeout(t.filterProps, 0)
                });
                $.contextMenu({
                    selector: ".property",
                    items: {
                        store: {
                            name: "存储为全局变量"
                        }
                    },
                    callback: function (e, n) {
                        var r = n.$trigger;
                        var i = t.selectedHash;
                        t.port.post({
                            name: "store",
                            hashCode: i,
                            expression: r.data("expression")
                        })
                    }
                })
            };
            n.prototype.showChildren = function (e, n) {
                var r = this;
                if (e === void 0) {
                    e = this._data
                }
                if (n === void 0) {
                    n = this.properties
                }
                this.lastQuery = "";
                var i = e;
                this.title.text(i.name);
                n.html("");
                i._props = i._props.sort(function (e, n) {
                    var r = t.indexOf(e.name);
                    var i = t.indexOf(n.name);
                    if (r >= 0 && i >= 0) {
                        return r > i ? 1 : -1
                    } else if (r >= 0) {
                        return -1
                    } else if (i >= 0) {
                        return 1
                    } else {
                        return e.name > n.name ? 1 : -1
                    }
                });
                var o = n.data("expression") || "";
                var s = i._props.map(function (e) {
                    return r.showProperty(e, o + "['" + e.name + "']")
                });
                n.append(s)
            };
            n.prototype.showProperty = function (e, t, n) {
                if (n === void 0) {
                    n = this._initPropElement(e)
                }
                var r = e.name;
                var i = e.value;
                n.data("expression", t);
                if (r.toLowerCase().indexOf("color") >= 0 && typeof i == "number") {
                    i = i.toString(16);
                    while (i.length < 6) {
                        i = "0" + i
                    }
                    i = "0x" + i;
                    e.value = i
                }
                if (e.type == "function") {
                    n.addClass("function");
                    i = "function(){...}"
                }
                var o = n.children(".value");
                o.text(i);
                o.attr("title", e.value);
                this._initValueActions(e, n, t);
                if (e.expandable) {
                    this._initChildrenActions(e, n, t)
                }
                return n
            };
            n.prototype._initPropElement = function (e) {
                var t = this.itemTmpl.replace("{icon}", e.expandable ? "+" : " ").replace("{name}", e.name);
                var n = $(t);
                if (e.isGetter && e.isSetter == false) n.addClass("noSetter");
                return n
            };
            n.prototype._initValueActions = function (e, t, n) {
                var r = this;
                var i = t.children(".value");
                i.data("expression", n);
                i.dblclick(function () {
                    if (e.expandable || e.isGetter && e.isSetter == false) return;
                    var t = $('<input type="text" value="" />');
                    t.width(i.width() + 10);
                    t.val(e.value);
                    i.text("").append(t);
                    t.focus().select();
                    var o = function () {
                        var o = t.val();
                        t.remove();
                        if (o == "") o = String(e.value);
                        i.text(o);
                        if (o == String(e.value)) return;
                        r.applyChange(n, o, function (t) {
                            t = JSON.stringify(t);
                            if (t == '"NaN"') t = "NaN";
                            e.value = t;
                            i.text(t)
                        })
                    };
                    t.blur(o).keypress(function (e) {
                        if (e.keyCode == 13) {
                            o()
                        }
                    })
                })
            };
            n.prototype._initChildrenActions = function (e, t, n) {
                var r = this;
                var i = t.children(".icon");
                i.data("expanded", false);
                t.addClass("expandable");
                t.children("span").click(function () {
                    var e = i.data("expanded");
                    if (!e) {
                        var n = $("<ul/>").data("expression", t.data("expression"));
                        n.click(function (e) {
                            return false
                        });
                        t.append(n);
                        r.expand(t.data("expression"), n);
                        i.text("-")
                    } else {
                        var n = t.children("ul");
                        n.remove();
                        i.text("+")
                    }
                    i.data("expanded", !e);
                    return false
                })
            };
            n.prototype.expand = function (e, t) {
                var n = this;
                this.mainPanel.port.post({
                    name: "expand",
                    hash: this.selectedHash,
                    expression: e
                }, null, function (e) {
                    n.showChildren(egret.devtool.TreeNode.clone(e), t)
                })
            };
            n.prototype.invokeGetter = function (e, t, n) {
                var r = this;
                this.mainPanel.port.post({
                    name: "invokeGetter",
                    hash: this.selectedHash,
                    expression: t,
                    propName: e
                }, null, function (e) {
                    r.showProperty(e, t, n)
                })
            };
            n.prototype.applyChange = function (e, t, n) {
                this.mainPanel.port.post({
                    name: "applyChange",
                    hash: this.selectedHash,
                    expression: e,
                    value: t
                }, null, function (e) {
                    if (e.success) {
                        n && n(e.result)
                    }
                })
            };
            n.prototype.showGameSelection = function (e, t) {
                this._data = t && t.__egretTreeFlat ? egret.devtool.TreeNode.clone(t) : t;
                this.selectedHash = e;
                this.showChildren()
            };
            return n
        }(e.Panel);
        e.PropertiesPanel = n
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));
var __extends = this && this.__extends || function (e, t) {
    for (var n in t)
        if (t.hasOwnProperty(n)) e[n] = t[n];

    function r() {
        this.constructor = e
    }
    e.prototype = t === null ? Object.create(t) : (r.prototype = t.prototype, new r)
};
var egret;
(function (e) {
    var t;
    (function (e) {
        var t = function (t) {
            __extends(n, t);

            function n() {
                var n = this;
                t.apply(this, arguments);
                this.treePanel = new e.TreePanel;
                this.propsPanel = new e.PropertiesPanel;
                this.profilePanel = new e.ProfilePanel;
                this.targetKey = null;
                this.portReady = function () {
                    var t = n.port;
                    t.post({
                        name: "init",
                        from: "view",
                        targetKey: n.targetKey
                    });
                    t.on("ready", function (e) {
                        return n.sendOptions()
                    });
                    t.on("updateTree", function (t) {
                        var r = t.data;
                        e.TreeNode.clear();
                        n.treePanel.data = e.TreeNode.clone(r)
                    });
                    t.on("updateSelection", function (e) {
                        return n.showGameSelection(e.data.hash, e.data.props, e.data.treeChange)
                    });
                    t.on("fps", function (e) {
                        return n.profilePanel.fps = e.data
                    });
                    n.treePanel.mainPanel = n;
                    n.propsPanel.mainPanel = n;
                    n.profilePanel.mainPanel = n;
                    n.treePanel.port = t;
                    n.propsPanel.port = t;
                    n.profilePanel.port = t;
                    n.treePanel.init();
                    n.propsPanel.init();
                    n.profilePanel.init();
                    n.sendOptions()
                };
                this.changeLayout = function (e) {
                    var t = $(".left").width();
                    var n = $(window).width();
                    t += e;
                    t = Math.max(t, 310);
                    var r = n - $(".handle-v").outerWidth() - t;
                    $(".left").width(t);
                    $(".right").width(r);
                    $("#props .header").width(r);
                    var i = $("#profile").height();
                    var o = $(window).innerHeight();
                    var s = $("#control").outerHeight();
                    var a = $("#searchBar").outerHeight();
                    $(".nodes").outerHeight(o - i - s - a);
                    $("#props").outerHeight(o - $("#searchProp").outerHeight() - $("#propHeader").outerHeight())
                }
            }
            n.prototype.init = function () {
                var t = this;
                var n = new e.PanelHandle($(".handle-v"));
                n.monitorY = false;
                n.on("move", this.changeLayout);
                this.changeLayout(0);
                var r = e.PortFactory.getPanelPortClass();
                this._getTargetKey(function (e) {
                    t.targetKey = e;
                    t.port = new r(location.host, t.portReady)
                })
            };
            n.prototype._getTargetKey = function (t) {
                var n = window["chrome"] || null;
                if (n && n.devtools && n.devtools.inspectedWindow) {
                    n.devtools.inspectedWindow.eval("window.name", function (e) {
                        return t(e)
                    })
                } else {
                    var r = e.parseParam(location.search);
                    var i = r["key"];
                    t(i)
                }
            };
            n.prototype.sendOptions = function () {
                this.port.post({
                    name: "initOptions",
                    highlightClick: this.treePanel._highlightClick,
                    highlightHover: this.treePanel._highlightHover,
                    preventTouch: this.treePanel._preventTouch,
                    showMethods: this.propsPanel._showMethods,
                    showPrivate: this.propsPanel._showPrivate
                })
            };
            n.prototype.showGameSelection = function (e, t, n) {
                this.treePanel.showGameSelection(e, n);
                this.propsPanel.showGameSelection(e, t)
            };
            return n
        }(e.EventBase);
        e.MainPanel = t;
        $(function () {
            var e = new t;
            e.init();
            window["mainPanel"] = e;

            showChanges()
        })
    })(t = e.devtool || (e.devtool = {}))
})(egret || (egret = {}));

function showChanges() {
    var e = "3.1.1";
    if (window.localStorage.getItem("showChange" + e)) return;
    var t = document.getElementById("changes");
    t.style.display = "block";
    var n = document.querySelector("#changes .close");
    n.addEventListener("click", function () {
        return t.style.display = "none"
    });
    window.localStorage.setItem("showChange" + e, "true")
}
