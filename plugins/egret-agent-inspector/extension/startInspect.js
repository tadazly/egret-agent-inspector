(function () {
    var startedAt = Date.now();
    var t = window.setInterval(function () {
        var runtime = window.egret;
        if (runtime && runtime.devtool && runtime.devtool.start) {
            window.clearInterval(t);
            runtime.devtool.start()
        } else if (Date.now() - startedAt > 60000) {
            window.clearInterval(t)
        }
    }, 100);
    var runtime = window.egret;
    if (runtime && runtime.devtool && runtime.devtool.start) {
        window.clearInterval(t);
        runtime.devtool.start()
    }
})();
