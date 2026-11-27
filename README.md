# machine-load

A session-first view of your Mac's load, inside Claude Code.

Most monitors group work by program: "node ×87", "Docker". When several Claude Code sessions run at once, the questions are different. Which session is slowing my machine down? What is it running? Which one should I pause? machine-load answers by grouping everything (child processes, background jobs that lost their parent, and Docker containers) under the Claude Code session or project that started it.

An unofficial open-source utility from Stak Technologies. Not a supported product.

**macOS only. Unofficial: not affiliated with or endorsed by Anthropic. Provided as-is, with no support.**

## What you get

- **A load chip above the prompt.** It shows the load average with a coloured dot (calm, busy, overloaded) and opens the panel when clicked. When another mod already has a row there, the chip sits on the same line. It also adds a small 30-minute load chart beside the [ponytail](https://github.com/DietrichGebert/ponytail) band when that band is expanded.
- **A side panel** (`/load`) that explains the load number in plain English ("on average 34 tasks wanted the processor at once; your Mac has 10 cores"), with a 30-minute load chart and CPU, GPU and memory figures.
- **A details table** with sortable columns (name, running time, CPU, memory). Rows hold their place between refreshes, so the list doesn't jump while you read it. It has three collapsible sections:
  - **Claude sessions:** each session's processes and Docker containers.
  - **Detached jobs:** work whose session has ended, grouped by folder.
  - **Mac apps and system.**
- **A Docker drill-down.** Each container shows its image, the branch and step it is running, how long it has been up, and the session that started it.
- **Search** across sessions, folders, branches and programs. Case, spaces and dashes are ignored, so `billing api` finds `billing-api-worktree`.
- **Plain-English labels** such as "Jest test worker", "Next.js dev server" and "Playwright test browser", instead of raw command lines.

## Install

In Claude Code, type:

```
/plugin install machine-load --marketplace Stak-Technologies/machine-load
```

Answer `y` to add the marketplace, then pick a scope. The chip appears above the prompt in new sessions, and `/load` opens the panel.

## How work is traced to a session

In order:

1. **Parent processes.** Walk up a process's parents until reaching a live Claude Code session (from `~/.claude/sessions/*.json`, checked against the process start time so a reused PID is never credited to the wrong session).
2. **`CLAUDE_PID`.** Background jobs whose shell exited are re-parented to launchd but still carry the `CLAUDE_PID` of the session that started them. Only that one variable is read from a process's environment, and the rest is discarded straight away.
3. **Docker.**
   - A container is tied to the `docker run` command that started it, and that command is traced as in steps 1–2.
   - If you pass `-e CI_SHA=<commit>` to `docker run` (and optionally `-e CI_BRANCH=<branch>`), the match is exact and the branch is shown.
   - Without those variables, a container is matched to a `docker run` of the same image when there is only one.
   - Compose containers are matched through their project's working folder.
4. **Folder.** If none of the above works, a job is grouped by its working folder, and credited to a session only when exactly one session works in that folder.

## Privacy

- Command-line arguments are never shown. Labels come from a fixed list or from a script's file name only.
- Of a process's environment, only `CLAUDE_PID` is read. Of a container's environment, only `CI_SHA` and `CI_BRANCH`.
- Nothing leaves your machine. To keep the cost low with many sessions open, one session samples every 10 seconds and the others read its result from `~/.claude/state/machine-load.json`.

## Limits

- **macOS only. Unofficial: not affiliated with or endorsed by Anthropic. Provided as-is, with no support.** It uses `sysctl`, `ioreg`, `memory_pressure`, `ps` and `lsof`.
- It depends on Claude Code's `~/.claude/sessions` files, which are not a documented interface and may change in a future Claude Code release.
- Fan speed is not shown, because it needs admin rights on Apple Silicon.
- CPU % is a share of one core (100% = one core fully busy).

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT. See [LICENSE](LICENSE).
