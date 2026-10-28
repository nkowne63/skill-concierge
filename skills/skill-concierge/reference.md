# skill-concierge reference

`U` is the server URL printed at start (`concierge listening on http://127.0.0.1:41234`; the port varies). Bodies are plain
text; `jq` is only for reading the JSON.

## API

| Method and path | Body | Result |
|---|---|---|
| `GET /api/state[?chat=N]` | | `chats` (id, title, `unread` answers, `running`: a reply is queued or in progress), thread N's `messages` (id, role `user`/`assistant`, content, status, `steps` of `{text, at}`), `agent.waiting`, `uiDir` |
| `POST /api/chats` | | `{"chat": {"id": …}}`, a new empty thread |
| `POST /api/chats/N/messages` | question | `{"user": {…}, "reply": {"id": …}}`; the reply starts `queued` |
| `POST /api/chats/N/abort` | | stops thread N's reply in progress; queued ones stay |
| `POST /api/chats/N/unread` | | marks thread N's latest finished answer unread again (the browser's 未読に戻す); 409 when it has none |
| `GET /api/agent/next` | | `{"thread", "title", "reply", "question"}` and assigns the reply to the caller; 404 when none waits |
| `POST /api/agent/replies/R/progress` | one line | adds a progress line to reply R |
| `POST /api/agent/replies/R/answer` | Markdown | posts reply R's answer |

Reply status: `queued` (waiting for an answerer, or for the thread's previous reply) → `running` (assigned)
→ `done`, or `interrupted` when the user presses 停止. `progress`/`answer` on a reply that is no longer
`running` fail with 409. Reading a thread through the API does not mark it read; only the browser does.

## Recipes

```sh
# wait for the next question (run async)
until curl -fs "$U/api/agent/next"; do sleep 1; done

# threads, then one thread
curl -sS "$U/api/state" | jq -r '.chats[] | "#\(.id) \(.title) unread=\(.unread) busy=\(.running)"'
curl -sS "$U/api/state?chat=1" | jq -r '.messages[] | "## \(.role) #\(.id) (\(.status))\n\(.content)\n"'

# ask in a new thread (or set T to an existing id), then wait for the answer;
# the wait only ends once an answerer is polling /api/agent/next
T=$(curl -fsS -X POST "$U/api/chats" | jq .chat.id)
R=$(curl -fsS --data-binary @- "$U/api/chats/$T/messages" <<'EOF' | jq .reply.id
<your question>
EOF
)
until curl -fsS "$U/api/state?chat=$T" | jq -e --argjson r "$R" \
  '.messages[] | select(.id == $r and .status != "queued" and .status != "running")' >/dev/null; do sleep 2; done
curl -fsS "$U/api/state?chat=$T" | jq -r --argjson r "$R" '.messages[] | select(.id == $r) | .content'

# stop thread T's reply in progress
curl -fsS -X POST "$U/api/chats/$T/abort"

# while busy elsewhere: post the first line of a status file to reply R every minute (exits when R ends)
node <skill>/server/ticker.ts --url "$U" --reply R --file /tmp/concierge-R.status [--every 60]
```

## Server

- `node <skill>/server/main.ts [--port N] [--allow-host NAME]... [--status]`, run in the project directory.
  There is no fixed port: without `--port`, the server reuses the project's previous port while it is free,
  else takes one the OS picks, and remembers it in the data directory (`port`). A second start for the same
  project prints `concierge already running` with the running URL and exits; `--status` only prints the URL,
  or `concierge not running` with exit status 1. "Running" means its PID answers or it refreshed
  `server.json` within the last 9 seconds (it does every 3), so a sandbox that hides host PIDs still sees it.
  Starts that overlap (before the first has written `server.json`) do not both run: the first takes the data
  directory's `lock`, the others wait for its URL and report it. A lock left by a dead process is taken over.
- Data: `$XDG_STATE_HOME/skill-concierge/projects/<project>-<hash>` (`~/.local/state/…`), or
  `CONCIERGE_DATA_DIR`. `<project>` is the project directory's base name. It holds the history `chats.json`, the
  editable UI `ui/`, the workspace app's saved data `ui-data/` (`ui.md`), and `server.json` (url, pid, workdir,
  uiDir) and `lock` while the server runs. Every file there is plain JSON or text you can read.
- Stop: SIGINT/SIGTERM (stop the background task or service, or `kill <pid from server.json>`). History stays.
- Restart: replies that were `running` go back to `queued` and are handed out again.
- The chat screen (`app/`) is compiled once at start; edits to it on disk need a restart.

## Access from other devices

The server only listens on 127.0.0.1 and rejects requests whose `Host` is not `127.0.0.1`/`localhost`
(403 `forbidden host`) or that come from another web origin (403). To open it through a proxy, start with
`--allow-host <public name>` (and `--port N`, so the proxy target stays put) and proxy to that port, e.g. for a
tailnet:

```sh
sudo tailscale serve --bg --https=8446 http://127.0.0.1:<port>   # sudo when the serve config has path handlers
sudo tailscale serve --https=8446 off                            # remove
```

There is no authentication: whoever reaches the name can put work in front of the answering agent. Use it only
on a network you own, or put authentication in the proxy (e.g. Cloudflare Access) and keep the `Host` header
as the public name.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `curl: (7) Failed to connect` | server not running, or another port (check its start output) |
| 403 `forbidden host` | request reached the server under a name not passed to `--allow-host` |
| 409 on `progress`/`answer` | the user pressed 停止, or the reply was already answered |
| 400 `empty text` | empty body (`--data-binary` with nothing, or a heredoc with only blank lines) |
| footer shows 「エージェント: 未接続」 | nobody called `/api/agent/next` in the last 5 seconds; questions wait as 待機中 |
| a question stays 待機中 while the agent waits | the thread's previous reply is still `running`; threads are answered one reply at a time |
