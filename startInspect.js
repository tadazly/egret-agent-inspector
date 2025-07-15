(function () {
    var t = window.setInterval(function () {
        var a = egret && egret.devtool && egret.devtool.start && (window.clearInterval(t) || egret.devtool.start());
        console.log("waiting")
    }, 100);
    egret && egret.devtool && egret.devtool.start && (window.clearInterval(t) || egret.devtool.start());
})();