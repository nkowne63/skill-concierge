# Rewriting the Concierge browser UI

For questions that ask to change what the browser shows: a tool, view, or widget in the "UI workspace", or the
look of the whole page. The page has three areas: the chat list (`#sidebar`), the UI workspace (`#workspace`,
an iframe), and the chat panel (`#chat-panel`). Only the UI directory is yours to edit:

```sh
UI=$(curl -sS "$U/api/state" | jq -r .uiDir)
```

Never edit the skill's own files; its `app/` directory is the chat screen and is compiled only at server start.

## Files

| File | Shown as | Notes |
|---|---|---|
| `index.html` | the UI workspace iframe, served at `/ui/index.html` | entry point; reference other files with relative paths |
| `app.js`, `style.css`, anything else you add | loaded by `index.html` | ES modules (`<script type="module">`) and `import` work |
| `theme.css` | a stylesheet on the whole page, after the chat screen's own CSS | the only file that affects the chat list and chat panel |
| `store.js` | helper the app imports to save data (below) | keep it; if missing, copy it from `<skill>/template-ui/store.js` |

The page notices any added, removed, or rewritten file in `UI` within about 2 seconds and reloads the iframe
and `theme.css`. Reloading restarts the workspace app, so in-memory state is lost.

## What the workspace app can and cannot do

It runs sandboxed in an opaque origin (`origin` is `"null"`):

| Works | Fails |
|---|---|
| scripts, forms, `alert`/`confirm`, module imports | `localStorage`, `sessionStorage`, IndexedDB, cookies (SecurityError) |
| `fetch` of its own files under `/ui/`; saving data with `store.js` | `fetch` of `/api/*`: it cannot read or send chat messages |
| inline `<style>`/`<script>`, `data:` and `blob:` URLs | anything from another host (CDNs, external APIs): vendor libraries into `UI` |
| | reading or changing the parent page's DOM |
| symlinks between files inside `UI` | symlinks to anything outside `UI` (served as 404); `store.js` data is always a plain file |

## Saving data

Memos, to-do lists, settings, and anything else the user enters must be saved with `store.js`; nothing else
survives a reload (storage is blocked, and each reload opens a fresh `/ui/index.html?v=…`, so a URL hash
is lost too):

```js
import { load, save } from './store.js'
const todos = await load('todos', [])   // fallback when nothing is saved yet
await save('todos', todos)              // any JSON value; save after each change
```

Names are 1–64 letters, digits, `_`, or `-`. Each name is one file, `<data>/ui-data/<name>.json`, next to `UI`:

```sh
cat "$(dirname "$UI")/ui-data/todos.json"   # read what the user saved, e.g. to act on their to-do list
```

You may write these files too (keep them valid JSON); the app sees the new value the next time it calls `load`.
Saving does not reload the workspace; `touch "$UI/index.html"` does (any changed modification time counts).
Before answering, remove data you created while testing (restore or delete the file) and touch `index.html`
so the user's open page shows the real state.

When a request cannot be done inside these limits, build the part that works, say in the answer what cannot be
done and why, and end with a question offering what is possible.

## theme.css

Colours are CSS variables on `:root`; dark values live in `@media (prefers-color-scheme: dark)`:
`--bg`, `--panel`, `--border`, `--text`, `--muted`, `--accent`, `--user` (your messages), `--danger`, `--ok`,
`--code-bg`, `--shadow`.

Selectors you can style: `#shell` (grid of the three areas), `#sidebar`, `#chat-list .chat-item`
(`.current`, `.unread`), `.badge`, `#agent-status`, `#workspace`, `#app-frame`, `#chat-panel`, `.bar`,
`#messages`, `.msg` (`.msg-user`, `.msg-assistant`, `.msg-system`, `[data-status]`), `.steps`, `#composer`,
`#composer-input`, `#send-button`.

Layouts: wider than 1024px shows all three areas; up to 1024px shows the list and one pane
(`#shell[data-view='chat'|'ui']`); up to 760px the list becomes a drawer (`#shell[data-drawer='open']`).

The chat panel, `#messages`, `#composer-input`, and `#send-button` must stay visible, unobstructed, and usable.

## Light, dark, and phone

The page follows the system light/dark setting. Unless the user asks for one fixed scheme, give every colour
you change a dark value too, in the workspace app's CSS and in `theme.css`. Keep the workspace app usable at
about 390px wide.

## Check before answering

Open `U` in a headless browser of your own, never the user's: your environment's browser tool if it has one
(omp: `browser` in `eval`), otherwise Playwright in a scratch directory (`npm i playwright && npx playwright
install chromium`). Check at about 1280×800 and 390×844, each in light and dark (emulate
`prefers-color-scheme`). In all four confirm: the chat panel, message list, input, and send button are
visible; the input accepts text. At the phone width also confirm the panes switch: ☰ (`#open-drawer`) opens the
chat list (✕ or Escape closes it), `button[aria-label="UI ワークスペース"]` shows the workspace, and its
`← チャット` button returns.
Then check the workspace after your last edit: it shows what was asked and has no console errors. Automated
clicks into the sandboxed iframe can time out; running script inside the frame (e.g. Playwright's
`frame.evaluate`) is enough there. If anything broke, fix or revert your edit before answering. In the answer,
say what you changed, what you checked, and what you did not check.

To return to the initial UI: `cp -r <skill>/template-ui/. "$UI"/` (overwrites the template's files; delete
files you added).
