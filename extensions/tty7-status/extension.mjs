// tty7-status: reports Copilot CLI's lifecycle to the tty7 pane it runs in.
// Part of the tty7-github-copilot plugin:
// https://github.com/MJuma/tty7-github-copilot
//
// Replaces tty7's own Copilot hooks (Settings → Integrations → Copilot CLI →
// Install). Leave those uninstalled, or every event is reported twice.
//
// Hooks only see sessionStart / prompt / agentStop / notification. The session
// event stream also sees interrupts (`abort`), answered prompts
// (`*.completed`), and `session.idle`, which waits for background agents.
//
// Reports go through tty7's internal hook runner, the same one its hooks use:
//   <tty7-app | tty7-server-*> agent-hook copilot <event>   (JSON on stdin)
// Events: session-start, prompt-submit, permission-request, question-asked,
// tool-complete, stop, session-end. That runner is undocumented, so a tty7
// update can change it.
//
// tty7 ends a turn on its own when Esc or Ctrl+C reaches the pane and no
// report follows within a second. In Copilot one Esc does not stop a turn (it
// takes two), so while a turn runs a keepalive re-asserts "working" every
// TTY7_STATUS_KEEPALIVE_MS (default 2000). That undoes the guess, and also
// keeps tty7 from expiring a turn that has been quiet for 30 minutes.
//
// Outside a tty7 pane ($TTY7 / $TTY7_PANE unset) the extension does nothing.
//
// Every report also carries Copilot's session working directory, so tty7's
// branch, diff counts and Files panel follow /worktree, /cd and --resume.
//
// Env:
//   TTY7_HOOK_BIN             path to the hook runner (else found from the pane's
//                             process ancestry or the usual install paths)
//   TTY7_STATUS_KEEPALIVE_MS  keepalive while a turn runs (default 2000;
//                             under 1000 also stops the wrong "done" from showing)
//   TTY7_STATUS_DEBUG=1       log every report to stderr (the extension log)

import { joinSession } from "@github/copilot-sdk/extension";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const AGENT = "copilot";
const RUNNER_TIMEOUT_MS = 5000;
// A permission prompt is reported only if it is still open after this long, so
// a request that is approved at once never shows as waiting.
const PROMPT_SETTLE_MS = 250;
// While a turn runs, re-assert "working" this often (see the header).
const KEEPALIVE_MS = Math.max(250, Number(process.env.TTY7_STATUS_KEEPALIVE_MS) || 2000);
// Skip a repeated "working" report sent sooner than this after the last report.
const REASSERT_MIN_MS = 5_000;
const MESSAGE_MAX = 300;

const inTty7 = Boolean(process.env.TTY7 && process.env.TTY7_PANE);
const debug = process.env.TTY7_STATUS_DEBUG === "1";
const log = (...args) => {
    if (debug) console.error("[tty7-status]", ...args);
};

function isRunner(path) {
    const name = basename(path);
    return name === "tty7-app" || name.startsWith("tty7-server");
}

function procParent(pid) {
    if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        return { ppid, exe: readlinkSync(`/proc/${pid}/exe`) };
    }
    return null;
}

// The pane's shell is a child of the tty7 server, so the nearest tty7-app or
// tty7-server ancestor is the runner that matches this pane. This also works
// in a remote workspace, where it is ~/.local/share/tty7/bin/tty7-server-*.
function runnerFromAncestry() {
    try {
        if (process.platform === "linux") {
            let pid = process.ppid;
            for (let i = 0; i < 32 && pid > 1; i++) {
                const { ppid, exe } = procParent(pid);
                if (isRunner(exe)) return exe;
                pid = ppid;
            }
            return null;
        }
        const table = new Map();
        const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
        for (const line of out.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
            if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
        }
        let pid = process.ppid;
        for (let i = 0; i < 32 && table.has(pid); i++) {
            const { ppid, comm } = table.get(pid);
            if (comm.startsWith("/") && isRunner(comm)) return comm;
            pid = ppid;
        }
    } catch (err) {
        log("ancestry lookup failed:", err.message);
    }
    return null;
}

function runnerFromInstall() {
    const candidates = [
        "/Applications/tty7.app/Contents/MacOS/tty7-app",
        join(homedir(), "Applications/tty7.app/Contents/MacOS/tty7-app"),
    ];
    try {
        const cli = execFileSync("sh", ["-c", "command -v tty7"], { encoding: "utf8" }).trim();
        if (cli) candidates.push(join(dirname(realpathSync(cli)), "tty7-app"));
    } catch {}
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
    try {
        const dir = join(homedir(), ".local/share/tty7/bin");
        const servers = readdirSync(dir)
            .filter((n) => n.startsWith("tty7-server"))
            .map((n) => join(dir, n))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (servers[0]) return servers[0];
    } catch {}
    return null;
}

function findRunner() {
    const override = process.env.TTY7_HOOK_BIN;
    if (override && existsSync(override)) return override;
    return runnerFromAncestry() ?? runnerFromInstall();
}

const clip = (text) => {
    if (typeof text !== "string") return undefined;
    const line = text.trim().replace(/\s+/g, " ");
    return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX - 1)}…` : line || undefined;
};

function describePermission(req = {}) {
    switch (req.kind) {
        case "shell":
            return req.intention || req.fullCommandText;
        case "write":
            return req.intention || (req.fileName && `Edit ${req.fileName}`);
        case "read":
            return req.intention || (req.path && `Read ${req.path}`);
        case "url":
            return req.intention || (req.url && `Fetch ${req.url}`);
        case "mcp":
            return `${req.serverDisplayName || req.serverName}: ${req.toolTitle || req.toolName}`;
        case "custom-tool":
            return req.toolDescription || req.toolName;
        default:
            return req.intention || req.toolName || (req.kind && `Permission: ${req.kind}`);
    }
}

const runner = inTty7 ? findRunner() : null;
let sessionId;

// Reports run one at a time, in order, so tty7 never sees them reordered.
let chain = Promise.resolve();
let lastReportAt = 0;

function runHook(event, body) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(runner, ["agent-hook", AGENT, event], {
                stdio: ["pipe", "ignore", "ignore"],
            });
        } catch (err) {
            log("spawn failed:", err.message);
            return resolve();
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), RUNNER_TIMEOUT_MS);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        child.once("error", (err) => {
            log("runner error:", err.message);
            done();
        });
        child.once("exit", done);
        child.stdin.on("error", () => {});
        child.stdin.end(body);
    });
}

function report(event, fields = {}) {
    if (!runner) return;
    const body = JSON.stringify({ session_id: sessionId, ...(currentCwd && { cwd: currentCwd }), ...fields });
    lastReportAt = Date.now();
    log("report", event, body);
    chain = chain.then(() => runHook(event, body));
}

// What this extension last told tty7: idle | working | waiting | done.
let state = "idle";
// Copilot's session working directory. It moves on /worktree, /cd and
// --resume without the process's own cwd changing, which is all tty7 can see
// for itself, so every report carries it. tty7 uses it for the row's branch
// and diff counts and for the Files panel.
let currentCwd;
let lastAssistantMessage;
// requestId -> { timer, reported }
const prompts = new Map();
let heartbeat;

function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
        if (state === "working") report("tool-complete");
    }, KEEPALIVE_MS);
    heartbeat.unref();
}

function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = undefined;
}

function toWorking(force) {
    if (!force && state === "working" && Date.now() - lastReportAt < REASSERT_MIN_MS) return;
    state = "working";
    report("prompt-submit");
    startHeartbeat();
}

function clearPrompts() {
    for (const p of prompts.values()) clearTimeout(p.timer);
    prompts.clear();
}

function endTurn(message) {
    clearPrompts();
    stopHeartbeat();
    state = "done";
    report("stop", message ? { message } : {});
}

function openPrompt(requestId, event, message) {
    if (!requestId || prompts.has(requestId)) return;
    const entry = { reported: false, timer: undefined };
    entry.timer = setTimeout(() => {
        entry.reported = true;
        state = "waiting";
        report(event, message ? { message } : {});
    }, PROMPT_SETTLE_MS);
    prompts.set(requestId, entry);
}

function closePrompt(requestId) {
    const entry = prompts.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    prompts.delete(requestId);
    const stillWaiting = [...prompts.values()].some((p) => p.reported);
    if (entry.reported && !stillWaiting) {
        state = "working";
        report("tool-complete");
    }
}

// Permission prompts are keyed by tool call, which both the request and its
// `permission.completed` carry.
let permissionSeq = 0;
function onPermissionAsked(toolCallId, request) {
    if (!runner) return;
    openPrompt(`perm:${toolCallId ?? `#${++permissionSeq}`}`, "permission-request", clip(describePermission(request)));
}

function onPermissionAnswered(toolCallId) {
    const key = toolCallId && `perm:${toolCallId}`;
    if (key && prompts.has(key)) return closePrompt(key);
    const oldest = [...prompts.keys()].find((k) => k.startsWith("perm:"));
    if (oldest) closePrompt(oldest);
}

const session = await joinSession({
    // The interactive CLI does not emit `permission.requested` to extensions;
    // it asks a registered handler instead. Note the prompt and decline to
    // decide ("no-result"), so Copilot shows its normal approval dialog.
    ...(inTty7 && {
        onPermissionRequest: (request) => {
            onPermissionAsked(request?.toolCallId, request);
            return { kind: "no-result" };
        },
    }),
});
sessionId = session.sessionId;

if (!inTty7) {
    log("not in a tty7 pane; idle");
} else if (!runner) {
    console.error("[tty7-status] tty7 hook runner not found; set TTY7_HOOK_BIN");
} else {
    console.error(`[tty7-status] pane ${process.env.TTY7_PANE} session ${sessionId} runner ${runner}`);
}

if (runner) {
    try {
        currentCwd = (await session.rpc.metadata.snapshot())?.workingDirectory || undefined;
    } catch (err) {
        log("metadata.snapshot failed:", err.message);
    }
    report("session-start", { source: "startup" });

    // tool-complete leaves tty7's status as it is (or undoes a guessed end of
    // turn), so it can carry a new cwd at any time except while a prompt is
    // open: there it would read as answered. The next report carries it then.
    session.on("session.context_changed", (event) => {
        const cwd = event.data?.cwd;
        if (!cwd || cwd === currentCwd) return;
        currentCwd = cwd;
        if (state !== "waiting") report("tool-complete");
    });

    if (debug) {
        session.on((event) => {
            if (!event.type.endsWith("_delta")) log("event", event.type, event.agentId ?? "");
        });
    }

    session.on("user.message", () => {
        clearPrompts();
        toWorking(true);
    });

    // Every model call of a turn, including turns that start without a user
    // message (autopilot, background-agent results, scheduled prompts).
    session.on("assistant.turn_start", () => {
        if (state !== "waiting") toWorking(false);
    });

    session.on("assistant.message", (event) => {
        if (event.agentId || event.data?.parentToolCallId) return;
        const text = clip(event.data?.content);
        if (text) lastAssistantMessage = text;
    });

    session.on("permission.requested", (event) => {
        const data = event.data ?? {};
        if (data.resolvedByHook) return;
        onPermissionAsked(data.permissionRequest?.toolCallId, data.permissionRequest);
    });
    session.on("permission.completed", (event) => onPermissionAnswered(event.data?.toolCallId));

    // Other dialogs that stop the turn until the user answers.
    const questions = {
        "user_input.requested": (d) => d.question,
        "elicitation.requested": (d) => d.message,
        "exit_plan_mode.requested": (d) => d.summary || "Plan ready for review",
        "auto_mode_switch.requested": () => "Switch model mode?",
        "session_limits_exhausted.requested": () => "Session AI credit limit reached",
    };
    for (const [type, text] of Object.entries(questions)) {
        session.on(type, (event) => {
            const data = event.data ?? {};
            openPrompt(data.requestId, "question-asked", clip(text(data)));
        });
        const done = type.replace(/\.requested$/, ".completed");
        session.on(done, (event) => closePrompt(event.data?.requestId));
    }

    // Only a turn in progress can end. A sub-agent's idle or abort does not
    // end the main turn.
    const midTurn = () => state === "working" || state === "waiting";
    session.on("session.idle", (event) => {
        if (event.agentId || !midTurn()) return;
        endTurn(lastAssistantMessage);
        lastAssistantMessage = undefined;
    });
    session.on("abort", (event) => {
        if (event.agentId || !midTurn()) return;
        endTurn("Interrupted");
    });

    let ended = false;
    const endSession = () => {
        if (ended) return;
        ended = true;
        stopHeartbeat();
        clearPrompts();
        log("report session-end (sync)");
        spawnSync(runner, ["agent-hook", AGENT, "session-end"], {
            input: JSON.stringify({ session_id: sessionId }),
            stdio: ["pipe", "ignore", "ignore"],
            timeout: 2000,
        });
    };
    session.on("session.shutdown", endSession);
    // The CLI stops extensions with SIGTERM on exit, /clear and session switch.
    process.once("SIGTERM", () => {
        endSession();
        process.exit(0);
    });
}
