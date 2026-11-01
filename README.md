# tty7-github-copilot

A [GitHub Copilot CLI](https://github.com/github/copilot-cli) plugin that
reports Copilot's status to [tty7](https://tty7.io). It replaces tty7's own
Copilot CLI hooks.

tty7 shows a status dot on each pane that runs a coding agent. With this
plugin, a Copilot pane shows:

| tty7 status | When Copilot |
|---|---|
| working (blue) | starts a turn, or continues one after you answer a prompt |
| waiting (amber) | asks for a permission, asks a question, shows a plan for approval, or reaches a session limit |
| done (green) | finishes a turn, or stops because you interrupted it |

The same states drive tty7's notifications, the tray icon, `tty7 agents`, and
`tty7 wait`.

## Why not tty7's hooks

Copilot hooks see only four events: session start, prompt submit, agent stop,
and notifications. This plugin runs a Copilot extension, which sees the whole
session event stream. Thus:

- An interrupt (Esc Esc) ends the turn. With hooks, the pane can stay
  "working".
- A turn ends only when background agents also finish.
- An answered prompt sets the pane back to "working" at once.
- tty7 follows Copilot's working directory. After `/worktree`, `/cwd`, or
  `copilot --resume`, the pane's branch, diff counts, and Files panel show the
  directory Copilot works in, not the directory where Copilot started.
- tty7 records the session ID when Copilot starts. Thus Hibernate Tab and a
  restart resume the session even before its first prompt.

## Requirements

- tty7 on macOS or Linux (tested with 26.10.0)
- GitHub Copilot CLI with experimental mode on (tested with 1.0.105). Copilot
  loads extensions only in experimental mode. Run `/experimental on` once.

## Install

Install the plugin on each machine where Copilot runs. In a tty7 remote
workspace, Copilot runs on the far machine, so install it there.

```bash
copilot plugin install MJuma/tty7-github-copilot
```

Then:

1. In tty7, open **Settings → Integrations**. Do not install the hooks for
   Copilot CLI. If they are installed, uninstall them. Otherwise tty7 gets
   every event twice. `tty7 doctor` then reports that the Copilot hooks are
   missing. That is expected.
2. Restart the Copilot sessions that run in tty7.
3. Copilot can ask, once per folder, to give the extension "elevated
   permissions" to handle permission requests. Answer **Yes**. If you answer
   **No**, the extension does not load. The extension never decides a request.
   It only notes the request, so that tty7 can show "waiting", and Copilot
   then shows its normal approval dialog.

Outside tty7 the plugin does nothing. It checks for `$TTY7` and `$TTY7_PANE`,
which tty7 sets in each pane.

Update and uninstall:

```bash
copilot plugin update tty7-github-copilot
copilot plugin uninstall tty7-github-copilot
```

## Configuration

Set these variables in the shell that starts Copilot.

| Variable | Default | Effect |
|---|---|---|
| `TTY7_STATUS_KEEPALIVE_MS` | `2000` | While a turn runs, report "working" this often. See [Notes](#notes). |
| `TTY7_HOOK_BIN` | found | Path to the tty7 binary that takes the reports. |
| `TTY7_STATUS_DEBUG` | off | `1` logs each session event and report to the extension log. |

Copilot writes each extension's log to `~/.copilot/logs/process-*.log`. The
first line of the file names the extension.

## How it works

The extension sends each report through the command that tty7's own hooks
use:

```
<tty7-app | tty7-server-*> agent-hook copilot <event>    (JSON on stdin)
```

It finds that binary in the process tree above Copilot: `tty7-app` on the
local machine, or `tty7-server-*` in a remote workspace. If it is not there,
it looks in the usual install locations.

| Copilot session event | Report to tty7 |
|---|---|
| extension starts | `session-start`, with the session ID and working directory |
| `user.message`, `assistant.turn_start` | `prompt-submit` |
| permission request | `permission-request`, with a short description |
| `user_input`, `elicitation`, `exit_plan_mode`, `auto_mode_switch`, `session_limits_exhausted` requested | `question-asked` |
| any of those completed | `tool-complete` (back to working) |
| `session.idle` | `stop`, with Copilot's last reply |
| `abort` | `stop`, with "Interrupted" |
| `session.context_changed` | `tool-complete`, with the new working directory |
| `session.shutdown`, exit | `session-end` |

A permission request that Copilot approves within 250 ms is not reported, so
auto-approved commands do not flash "waiting".

## Notes

- `agent-hook` is not a documented tty7 interface. A tty7 update can change
  it and break the plugin.
- One Esc does not stop a Copilot turn. Two do. But tty7 assumes that any Esc
  or Ctrl+C ends the turn if no report follows within a second. While a turn
  runs, the extension reports "working" every 2 seconds, which corrects that
  guess. Thus after one Esc, the pane can show "done" for up to 2 seconds. Set
  `TTY7_STATUS_KEEPALIVE_MS=900` to prevent that. This costs about 1% of a
  CPU core per working agent.
- `tty7 pane ls` still shows the shell's directory. The directory that Copilot
  works in is in `tty7 agents --json`.
- tty7 manages only the worktrees in `<repo>/.tty7/worktrees/`. Worktrees from
  Copilot's `/worktree` are elsewhere, so tty7 does not offer to remove them.
- Remote workspaces are not tested.

## Development

```bash
git clone https://github.com/MJuma/tty7-github-copilot
cd tty7-github-copilot
TTY7_STATUS_DEBUG=1 copilot --plugin-dir "$PWD"
```

`--plugin-dir` loads the plugin for one session without installing it. Do
not also install the plugin, or keep a copy in `~/.copilot/extensions/`, while
you do this. Otherwise tty7 gets every event twice.

## License

[MIT](LICENSE)
