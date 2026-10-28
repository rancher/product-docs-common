'use strict'

// Run with: node --test jscript/*.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { buildRootLoader, readReleaseLayouts } = require('./split-search-index.js')

const LANGS = ['en', 'de']
const VERSION_MAP = { k3s: ['latest'], 'admission-controller': ['1.38', '1.37'], kubewarden: ['6.0.1', '6.0.0'] }
const LAYOUTS = {
  'suse-security': {
    landing: 'kubewarden',
    aliases: { latest: '6.0.0', dev: '6.0.1' },
    releases: {
      '6.0.1': { 'admission-controller': '1.38' },
      '6.0.0': { 'admission-controller': '1.38' },
    },
  },
}

// Runs the loader for a page and returns the URLs of the index scripts it adds.
function load (loader, pageUrl, scriptUrl = 'https://docs.example/search-index.js') {
  const scripts = []
  const document = {
    currentScript: { src: scriptUrl },
    createElement: () => ({}),
    head: { appendChild: (script) => scripts.push(script.src) },
  }
  vm.runInNewContext(loader, { document, window: { location: new URL(pageUrl) }, URL })
  return scripts
}

test('without release layouts, the loader uses the component and version of the URL', () => {
  const loader = buildRootLoader(LANGS, VERSION_MAP)
  assert.equal(loader, buildRootLoader(LANGS, VERSION_MAP, {}))
  assert.doesNotMatch(loader, /releaseLayouts/)
  assert.deepEqual(load(loader, 'https://docs.example/k3s/latest/de/install.html'),
    ['https://docs.example/lang-indexes/k3s/latest/search-index-de.js'])
})

test('a release URL loads the index of the component version of the release', () => {
  const loader = buildRootLoader(LANGS, VERSION_MAP, LAYOUTS)
  assert.deepEqual(load(loader, 'https://docs.example/suse-security/6.0.1/de/admission-controller/howtos/x.html'),
    ['https://docs.example/lang-indexes/admission-controller/1.38/search-index-de.js'])
  // A landing page: the landing component, whose version is the release.
  assert.deepEqual(load(loader, 'https://docs.example/suse-security/6.0.0/en/introduction.html'),
    ['https://docs.example/lang-indexes/kubewarden/6.0.0/search-index-en.js'])
  // Other components do not change.
  assert.deepEqual(load(loader, 'https://docs.example/k3s/latest/en/x.html'),
    ['https://docs.example/lang-indexes/k3s/latest/search-index-en.js'])
  // The aliases stand for their releases.
  assert.deepEqual(load(loader, 'https://docs.example/suse-security/latest/de/admission-controller/howtos/x.html'),
    ['https://docs.example/lang-indexes/admission-controller/1.38/search-index-de.js'])
  assert.deepEqual(load(loader, 'https://docs.example/suse-security/latest/en/introduction.html'),
    ['https://docs.example/lang-indexes/kubewarden/6.0.0/search-index-en.js'])
  assert.deepEqual(load(loader, 'https://docs.example/suse-security/dev/en/introduction.html'),
    ['https://docs.example/lang-indexes/kubewarden/6.0.1/search-index-en.js'])
  // An unknown release loads nothing.
  assert.deepEqual(load(loader, 'https://docs.example/suse-security/9.9.9/en/introduction.html'), [])
})

test('the loader works when the site is in a subfolder', () => {
  const loader = buildRootLoader(LANGS, VERSION_MAP, LAYOUTS)
  assert.deepEqual(load(loader, 'https://docs.example/cloudnative/suse-security/6.0.0/en/admission-controller/x.html',
    'https://docs.example/cloudnative/search-index.js'),
  ['https://docs.example/cloudnative/lang-indexes/admission-controller/1.38/search-index-en.js'])
})

test('release layouts come from the release-url-layout.json files in the site', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'split-search-index-'))
  try {
    assert.deepEqual(readReleaseLayouts(site), {})
    fs.mkdirSync(path.join(site, 'suse-security'))
    fs.mkdirSync(path.join(site, 'k3s'))
    fs.writeFileSync(path.join(site, 'suse-security', 'release-url-layout.json'), JSON.stringify({
      url_prefix: 'suse-security',
      landing: 'kubewarden',
      aliases: { latest: '6.0.0', dev: '6.0.1' },
      releases: [
        { version: '6.0.1', prerelease: true, components: { 'admission-controller': { version: '1.38', home: '6.0.0' } } },
        { version: '6.0.0', prerelease: false, components: { 'admission-controller': { version: '1.38', home: '6.0.0' } } },
      ],
    }))
    assert.deepEqual(readReleaseLayouts(site), LAYOUTS)
    fs.mkdirSync(path.join(site, 'other'))
    fs.writeFileSync(path.join(site, 'other', 'release-url-layout.json'), JSON.stringify({ url_prefix: 'wrong', releases: [] }))
    assert.throws(() => readReleaseLayouts(site), /url_prefix wrong does not match the folder other/)
  } finally {
    fs.rmSync(site, { recursive: true, force: true })
  }
})
