#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawn, spawnSync } = require("child_process");

function pythonCandidates(platform = process.platform, env = process.env) {
    const result = [];
    if (env.EGRET_PYTHON) result.push({ command: env.EGRET_PYTHON, args: [] });
    if (platform === "win32") {
        result.push({ command: "python", args: [] }, { command: "py", args: ["-3"] }, { command: "python3", args: [] });
    } else {
        result.push({ command: "python3", args: [] }, { command: "python", args: [] });
    }
    const seen = new Set();
    return result.filter((candidate) => {
        const key = `${candidate.command}\0${candidate.args.join("\0")}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function supportsPython38(candidate) {
    const probe = spawnSync(candidate.command, [...candidate.args, "-c",
        "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    return !probe.error && probe.status === 0;
}

function main() {
    const pluginRoot = path.resolve(__dirname, "..");
    const server = path.join(pluginRoot, "server", "egret_agent_inspector_mcp.py");
    const candidate = pythonCandidates().find(supportsPython38);
    if (!candidate) {
        console.error("Egret Agent Inspector 需要 Python 3.8+；未找到可用的 python3、python 或 py -3。");
        process.exitCode = 1;
        return;
    }
    const child = spawn(candidate.command, [...candidate.args, server], {
        cwd: pluginRoot,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
    });
    ["SIGINT", "SIGTERM"].forEach((signal) => process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    }));
    child.on("error", (error) => {
        console.error(`无法启动 Egret Agent Inspector MCP server：${error.message}`);
        process.exitCode = 1;
    });
    child.on("exit", (code) => {
        process.exitCode = Number.isInteger(code) ? code : 1;
    });
}

module.exports = { pythonCandidates, supportsPython38 };
if (require.main === module) main();
