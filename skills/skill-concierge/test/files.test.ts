import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileWithin, readPlainFile, writePlainFile } from '../server/files.ts'

// A data directory with a secret next to the served directories, as chats.json sits next to ui/ and ui-data/.
function withData(fn: (dir: { ui: string; uiData: string; secret: string }) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'concierge-files-'))
  const dir = { ui: path.join(root, 'ui'), uiData: path.join(root, 'ui-data'), secret: path.join(root, 'chats.json') }
  mkdirSync(dir.ui)
  mkdirSync(dir.uiData)
  writeFileSync(dir.secret, 'SECRET')
  try {
    fn(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the UI is served only from regular files inside it, whatever symlinks or paths say', () =>
  withData(({ ui, secret }) => {
    writeFileSync(path.join(ui, 'index.html'), 'ok')
    mkdirSync(path.join(ui, 'lib'))
    symlinkSync(secret, path.join(ui, 'leak.json'))
    symlinkSync(path.dirname(secret), path.join(ui, 'up'))
    symlinkSync(path.join(ui, 'index.html'), path.join(ui, 'alias.html'))
    symlinkSync(path.join(ui, 'missing'), path.join(ui, 'dangling'))

    assert.equal(fileWithin(ui, 'index.html'), path.join(ui, 'index.html'))
    assert.equal(fileWithin(ui, 'alias.html'), path.join(ui, 'index.html'), 'a symlink staying inside is fine')
    for (const escape of ['leak.json', 'up/chats.json', '../chats.json', 'lib', 'dangling', 'missing']) {
      assert.equal(fileWithin(ui, escape), null, escape)
    }
  }))

test('a symlinked UI directory serves nothing', () =>
  withData(({ ui, secret }) => {
    const linked = path.join(path.dirname(ui), 'ui-link')
    symlinkSync(path.dirname(secret), linked)
    assert.equal(fileWithin(linked, 'chats.json'), null)
  }))

test('saved workspace data never reads or writes through a symlink', () =>
  withData(({ uiData, secret }) => {
    symlinkSync(secret, path.join(uiData, 'link.json'))
    assert.equal(readPlainFile(uiData, 'link.json'), null)

    writePlainFile(uiData, 'link.json', '{"a":1}')
    assert.equal(readFileSync(secret, 'utf8'), 'SECRET', 'the target is untouched')
    assert.equal(readPlainFile(uiData, 'link.json'), '{"a":1}', 'the link was replaced by the data')
  }))

test('a symlinked ui-data directory is neither read nor written', () =>
  withData(({ uiData, secret }) => {
    rmSync(uiData, { recursive: true })
    symlinkSync(path.dirname(secret), uiData)
    assert.equal(readPlainFile(uiData, 'chats.json'), null)
    assert.throws(() => writePlainFile(uiData, 'chats.json', 'x'))
    assert.equal(readFileSync(secret, 'utf8'), 'SECRET')
  }))
