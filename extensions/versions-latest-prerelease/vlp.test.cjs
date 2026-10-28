'use strict'

// Run with: node --test extensions/versions-latest-prerelease/*.test.cjs
// Runs the playbookBuilt, contentClassified, and sitePublished steps of the
// extension with a stand-in content catalog and a temporary output directory.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Loads a fresh copy: the extension keeps its state in module variables.
function loadVlp (file = path.join(__dirname, 'vlp.js')) {
  delete require.cache[require.resolve(file)]
  return require(file)
}

function run (vlp, outputDir, components, published) {
  for (const [component, versions] of Object.entries(published)) {
    for (const version of versions) fs.mkdirSync(path.join(outputDir, component, version, 'en'), { recursive: true })
  }
  const listeners = {}
  vlp.register.call({ once: (event, fn) => { listeners[event] = fn } })
  const playbook = { output: { dir: outputDir }, site: {}, asciidoc: { attributes: {} } }
  listeners.playbookBuilt({ playbook })
  listeners.contentClassified({
    contentCatalog: { getComponents: () => components, findBy: () => [] },
  })
  listeners.sitePublished({ playbook })
}

// The output directory as a sorted list: type, path, and symlink target.
function tree (dir) {
  const entries = []
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name)
      if (entry.isSymbolicLink()) entries.push(`l ${file} -> ${fs.readlinkSync(path.join(dir, file))}`)
      else if (entry.isDirectory()) { entries.push(`d ${file}`); walk(file) } else entries.push(`f ${file}: ${fs.readFileSync(path.join(dir, file), 'utf8').trim().replaceAll('\n', ' | ')}`)
    }
  }
  walk('')
  return entries.sort()
}

const COMPONENTS = [
  { name: 'longhorn', versions: [{ version: '1.10', prerelease: '-dev' }, { version: '1.9' }, { version: '1.8' }] },
  { name: 'admission-controller', versions: [{ version: '1.38' }] },
  { name: 'shared', versions: [{ version: 'latest' }] },
]

function withOutputDir (fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlp-test-'))
  const log = console.log
  console.log = () => {}
  try {
    return fn(dir)
  } finally {
    console.log = log
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('links latest and dev to the published version directories', () => {
  const result = withOutputDir((dir) => {
    run(loadVlp(), dir, COMPONENTS, { longhorn: ['1.10', '1.9', '1.8'], 'admission-controller': ['1.38'] })
    return tree(dir)
  })
  assert.ok(result.includes('l longhorn/latest -> 1.9'))
  assert.ok(result.includes('l longhorn/dev -> 1.10'))
  assert.ok(result.includes('f longhorn/latest_dev.txt: longhorn | latest: 1.9 | dev: 1.10'))
  assert.ok(result.includes('l admission-controller/latest -> 1.38'))
})

test('leaves nothing for a component whose versions are published elsewhere', () => {
  const result = withOutputDir((dir) => {
    // admission-controller 1.38 is not at /admission-controller/1.38/, for
    // example because the release-url-layout extension moved it.
    run(loadVlp(), dir, COMPONENTS, { longhorn: ['1.10', '1.9', '1.8'] })
    return tree(dir)
  })
  assert.equal(result.some((entry) => entry.includes('admission-controller')), false)
  assert.ok(result.includes('l longhorn/latest -> 1.9'))
})

test('does not link to a version directory that is missing', () => {
  const result = withOutputDir((dir) => {
    run(loadVlp(), dir, COMPONENTS, { longhorn: ['1.9', '1.8'] })
    return tree(dir)
  })
  assert.ok(result.includes('l longhorn/latest -> 1.9'))
  assert.equal(result.some((entry) => entry.startsWith('l longhorn/dev')), false)
  assert.ok(result.includes('f longhorn/latest_dev.txt: longhorn | latest: 1.9 | dev: 1.10'))
})
