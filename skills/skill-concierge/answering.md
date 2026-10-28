# Answering a Concierge question

You were given a question from the Concierge browser chat: its JSON
(`{"thread": 1, "title": "…", "reply": 2, "question": "…"}`) and the server URL `U`
(e.g. `http://127.0.0.1:41234`). Reply 2 is assigned to you and shows as 処理中 in the browser. The user reads
your answer there, rendered as GitHub-flavoured Markdown: answer in their language (Japanese when they write
Japanese) and keep it focused.

## Steps

1. Report what you are doing, now and before each further step (investigating, editing, verifying). The user
   watches these lines live:

   ```sh
   curl -sS --fail-with-body --data-binary '<one line>' "$U/api/agent/replies/<reply>/progress"
   ```

   Keep the lines coming at least once a minute while the reply is open, including while you wait on
   subagents, builds, or test runs; a silent minute looks stalled. For waits you do not watch line by line,
   write the current step to a status file and let the ticker post it every minute until you answer
   (run it in the background; it exits by itself once the reply is answered or stopped):

   ```sh
   echo 'running tests/gateway (3 of 12 files)' > /tmp/concierge-<reply>.status
   node <skill>/server/ticker.ts --url "$U" --reply <reply> --file /tmp/concierge-<reply>.status
   ```

   Rewrite the status file whenever the step changes; post one-off lines with `progress` as before.

2. If the question refers to earlier turns, read the thread:

   ```sh
   curl -sS "$U/api/state?chat=<thread>" | jq -r '.messages[] | "## \(.role) #\(.id) (\(.status))\n\(.content)\n"'
   ```

3. Do the work. If the question asks to change what the browser shows (the UI workspace, colours, layout),
   follow `ui.md` next to this file.
4. Post the full answer once. The body is plain text; a quoted heredoc keeps Markdown intact:

   ```sh
   curl -sS --fail-with-body --data-binary @- "$U/api/agent/replies/<reply>/answer" <<'EOF'
   <answer>
   EOF
   ```

   To ask the user something, end the answer with the question; their reply in the thread comes back as a new
   question.

If your assignment tells you to hand questions back to the agent that gave it to you, and you need that agent's
context, permissions, or decision: post a progress line saying what you are waiting for, post no answer, and end
your task with the question. The reply stays 処理中 in the browser until that agent answers it.

If `progress` or `answer` fails with HTTP 409 (`reply #… is interrupted: stop working on it`), the user pressed
停止: stop working on it and post nothing more. Connection failures (server restarting) can be retried.
