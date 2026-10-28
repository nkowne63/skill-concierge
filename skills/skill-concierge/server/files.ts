// File access for the agent-editable UI (`ui/`) and the workspace app's saved data (`ui-data/`). Agents, the
// workspace app, and local processes can put anything there, symlinks included, while both directories are
// served to any web origin. Nothing outside the directory itself is ever read or written through them.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// A directory, not a symlink to one: a symlinked `ui/` or `ui-data/` could point anywhere.
const isRealDirectory = (dir: string) => {
  try {
    return lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}

// The real path of `relative` under `root` when, after resolving every symlink, it is a regular file inside
// `root`; else null (missing, dangling, looping, a directory, or anywhere outside `root`). Symlinks that stay
// inside `root` are fine.
export function fileWithin(root: string, relative: string): string | null {
  if (!isRealDirectory(root)) return null
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(path.resolve(root, relative))
    return real.startsWith(realRoot + path.sep) && statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

// The content of `dir/name` when it is a regular file; null when it is missing or anything else (a symlink is
// not followed, so it reads as missing).
export function readPlainFile(dir: string, name: string): string | null {
  if (!isRealDirectory(dir)) return null
  let fd: number
  try {
    // O_NONBLOCK: opening a FIFO planted there must not hang the server.
    fd = openSync(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null
  } finally {
    closeSync(fd)
  }
}

// Replaces `dir/name` with a new regular file holding `content`. The rename swaps the directory entry, so a
// symlink there is replaced, never written through.
export function writePlainFile(dir: string, name: string, content: string) {
  mkdirSync(dir, { recursive: true })
  if (!isRealDirectory(dir)) throw new Error(`${dir} is not a directory`)
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
  renameSync(temp, path.join(dir, name))
}
