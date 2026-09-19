// The function below is executed in the context of the inspected page.
var page_getProperties = function () {
    var data = window.egret && window.egret.MainContext ? window.egret.MainContext.instance : {};
    var props = Object.getOwnPropertyNames(data);
    var copy = { __proto__: null };
    for (var i = 0; i < props.length; ++i)
        copy[props[i]] = data[props[i]];
    return copy;
};

chrome.devtools.panels.elements.createSidebarPane("Egret Properties", function (sidebar) {
    function updateElementProperties() {
        sidebar.setExpression("(" + page_getProperties.toString() + ")()");
    }
    updateElementProperties();
    chrome.devtools.panels.elements.onSelectionChanged.addListener(updateElementProperties);
});

chrome.devtools.panels.create("Egret", "icon.png", "ipt/panel/index.html", function (panel) {
    var connected = false;
    const backgroundPageConnection = chrome.runtime.connect({
        name: btoa("for" + String(chrome.devtools.inspectedWindow.tabId))
    });

    backgroundPageConnection.onMessage.addListener(function (message) {
        // handle messages from background if needed
    });

    backgroundPageConnection.postMessage({
        from: "devtools-page",
        tabId: chrome.devtools.inspectedWindow.tabId
    });

    panel.onShown.addListener(function (w) {
        if (!connected) {
            chrome.devtools.inspectedWindow.eval(`(function () {
                var startedAt = Date.now();
                var t = window.setInterval(function () {
                    var runtime = window.egret;
                    if (runtime && runtime.devtool && runtime.devtool.start) {
                        window.clearInterval(t);
                        runtime.devtool.start();
                    } else if (Date.now() - startedAt > 60000) {
                        window.clearInterval(t);
                    }
                }, 100);
                var runtime = window.egret;
                if (runtime && runtime.devtool && runtime.devtool.start) {
                    window.clearInterval(t);
                    runtime.devtool.start();
                }
            })();`);
        }

        backgroundPageConnection.postMessage({
            toDevTool: true,
            toggleMask: true,
            devToolHidden: false
        });

        connected = true;
    });

    panel.onHidden.addListener(function (w) {
        backgroundPageConnection.postMessage({
            toDevTool: true,
            toggleMask: true,
            devToolHidden: true
        });
    });
});
