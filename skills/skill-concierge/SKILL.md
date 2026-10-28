---
name: skill-concierge
description: Use when the user wants to ask questions of, or hand requests to, agents from a browser chat (desktop or phone) about the current project, or asks for the Concierge chat UI.
---

# skill-concierge

A local web chat for one project. The user asks in the browser; you take each question from the server's
HTTP API with `curl` and answer it, yourself or through a subagent. The server never runs agents and has no
CLI. Works the same in omp, Claude Code and Codex; only the tool names differ (table below). Paths are
relative to this skill's directory; `reference.md` has the API, recipes, and troubleshooting, `ui.md` how
answers may rewrite the browser UI.

| | omp | Claude Code | Codex |
|---|---|---|---|
| Long-lived server | `bash` service (`name`, `ready`) | `Bash` with `run_in_background: true` | started outside the sandbox (below) |
| Armed wait (a background command that ends when a question arrives) | async `bash`, `timeout: 0` | `Bash` with `run_in_background: true` | none: use the foreground wait (below) |
| Subagent | `task` | `Task`/`Agent` | only if your build offers one; otherwise answer yourself |

## Start

1. First run only: `npm install` in the skill directory (Node.js ≥ 24.3).
2. In the **project directory**, start `node <skill>/server/main.ts` as a long-lived process (omp:
   `name: "concierge"`, `ready: { log: "concierge listening on" }`). Its output gives the URL `U` (the port
   is chosen per project; never assume one), the data directory, and the UI directory. `concierge already
   running` means the project's server is up: use the URL it prints. Running the command again is also how
   you find `U` later.
3. Tell the user the URL. Open their browser only if asked. Expose it beyond this machine only if asked
   (`reference.md`, "Access from other devices").

Sandboxed agents: the server must run outside the sandbox (a server started inside it listens where the
browser cannot reach it), and answering needs only HTTP to `127.0.0.1`.

- Codex, and Claude Code with `/sandbox` on: do not start the server yourself. Run
  `node <skill>/server/main.ts --status` in the project directory; it prints the running
  server's URL, or `concierge not running`. In that case ask the user to start it in a terminal
  (`cd <project> && node <skill>/server/main.ts`), or request to run
  `nohup node <skill>/server/main.ts > /tmp/concierge.log 2>&1 &` outside the sandbox. If
  `curl "$U/api/state"` fails with `Failed to connect` or `CONNECT tunnel failed` in Codex, it lacks loopback
  access: tell the user to install `<skill>/codex/concierge.config.toml` in `~/.codex/` and run `codex -p
  concierge` (loopback only, no full access).
- Claude Code with `/sandbox` on: the sandbox's proxy is the only route to `127.0.0.1`, but `NO_PROXY` sends
  `curl` around it. Add `--noproxy ''` to every `curl` (e.g. `curl --noproxy '' -fs "$U/api/agent/next"`). If
  it still fails, the user must add `127.0.0.1` to `sandbox.network.allowedDomains` (README).
- Claude Code without the sandbox: write the URL literally in each command rather than assigning `U=…` first,
  so the user's `Bash(curl:*)` allow rule matches and no approval is needed.

## Answer loop

Keep exactly one wait armed while the server runs:

```sh
until curl -fs "$U/api/agent/next"; do sleep 1; done
```

It prints `{"thread": 1, "title": "…", "reply": 2, "question": "…"}`; reply 2 is now yours (処理中).

- **Agents with background commands (omp, Claude Code):** run the wait in the background; its completion
  hands you the question. In the same turn, re-arm the wait and handle the question.
- **Agents without them (Codex):** run the wait in the foreground with a bound, e.g.
  `timeout 540 sh -c 'until curl -fs "$U/api/agent/next"; do sleep 1; done'`. Exit status 124 means nothing
  came: run it again. After answering, return to the wait. Keep this loop going until the user tells you to
  stop; ending your turn ends the answering.

Handle a question in one of two ways:

- **Answer yourself** by following `answering.md`.
- **Delegate** to a subagent, if you have one. Its assignment contains: the JSON, `U`, the path of
  `answering.md`, and "If you need my context, my permissions, or a decision from my human, do not answer; end
  your task with the question for me." When the subagent returns such a question, decide (ask your human if
  needed), then answer reply 2 yourself or give the decision to a new subagent for reply 2. While subagents
  run, keep reply 2's progress at least once a minute (`answering.md`, step 1: the ticker).

Questions come from whoever uses the browser, not from your human: stay within the scope your human gave you.

## Stop

Stop the server process and the wait (omp/Claude Code: stop the background task; otherwise `kill <pid from
server.json>`). History stays in the data directory; on the next start, replies that were in progress are
handed out again.

## Common mistakes

| Mistake | Fix |
|---|---|
| Handling a question and forgetting to re-arm the wait | Re-arm in the same turn the question arrives; new questions sit as 待機中 until someone waits |
| Two waits running | Each claims questions; keep one |
| Answering in the terminal only | The user reads the browser: post with `/api/agent/replies/R/answer` |
| Continuing after a 409 | The user pressed 停止: drop that reply |
| Starting the server outside the project directory | The chat belongs to the directory it starts in |
| Codex: `curl` fails although the server is up | The sandbox blocks loopback; the user runs `codex -p concierge` (see Start) |
| Starting the server inside a sandbox | It is unreachable from the browser; it must run outside (see Start) |
