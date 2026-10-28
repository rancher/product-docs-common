'use strict'

// Run with: node --test extensions/release-url-layout/*.test.cjs
//
// The fixture tests classify a small site with the content classifier of
// Antora. They find Antora in the node_modules of the playbook repository,
// for example when product-docs-common is a submodule, and skip without it.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const posix = require('node:path').posix
const { _internal: ext } = require('./release-url-layout.js')

const antora = (() => {
  const paths = [process.cwd(), __dirname]
  try {
    return {
      classifyContent: require(require.resolve('@antora/content-classifier', { paths })),
      File: require(require.resolve('vinyl', { paths })),
    }
  } catch {
    return undefined
  }
})()
const fixture = { skip: antora ? false : 'Antora is not installed in a parent node_modules' }

// Configuration ---------------------------------------------------------------

const config = (...releases) => ({
  product: { component: 'kubewarden', landing_version: '1.0', url_prefix: 'suse-security' },
  releases,
})
const r600 = { version: '6.0.0', components: { 'admission-controller': '1.38', 'network-enforcer': '0.3' } }
const r601 = { version: '6.0.1', prerelease: true, components: { 'admission-controller': '1.38', 'network-enforcer': '0.4' } }
const product = (...releases) => ext.validateConfig(config(...releases), 'test.yml', 'suse-security')

test('validation rejects a bad configuration', () => {
  const bad = (change) => () => ext.validateConfig(change(config(r600)), 'test.yml', 'p')
  assert.throws(bad(() => null), /must contain product and releases/)
  assert.throws(bad((c) => ({ ...c, extra: 1 })), /top level: unknown key extra/)
  assert.throws(bad((c) => ({ ...c, product: { ...c.product, colour: 'red' } })), /product: unknown key colour/)
  assert.throws(bad((c) => ({ ...c, product: { ...c.product, url_prefix: 'SUSE/Security' } })), /url_prefix must match/)
  assert.throws(bad((c) => ({ ...c, product: { ...c.product, landing_version: 1 } })), /landing_version must be a string/)
  assert.throws(bad((c) => ({ ...c, releases: [] })), /at least one release/)
  assert.throws(bad((c) => ({ ...c, releases: [r600, r600] })), /6.0.0 appears more than once/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, version: '../6' }] })), /version must be a string that matches/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, version: 'latest' }] })), /latest is a reserved name/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, version: 'dev' }] })), /dev is a reserved name/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, notes: 'x' }] })), /releases\[0\]: unknown key notes/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, components: { kubewarden: '1.0' } }] })), /kubewarden is the landing component/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, components: { 'Bad/Name': '1.0' } }] })), /component name Bad\/Name must match/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, components: { 'admission-controller': 1.38 } }] })), /must be a string/)
  assert.throws(bad((c) => ({ ...c, releases: [{ ...r600, prerelease: 'yes' }] })), /prerelease must be true or false/)
})

test('latest is the newest release that is not a prerelease, dev the newest prerelease', () => {
  const r602 = { ...r601, version: '6.0.2' }
  assert.deepEqual(ext.aliases(product(r601, r600)), { latest: '6.0.0', dev: '6.0.1' })
  assert.deepEqual(ext.aliases(product(r602, r601, r600)), { latest: '6.0.0', dev: '6.0.2' })
  assert.deepEqual(ext.aliases(product(r600)), { latest: '6.0.0' })
  assert.deepEqual(ext.aliases(product(r601)), { dev: '6.0.1' })
})

test('the redirect of the site start page goes to latest if the start page is in the latest release', () => {
  const redirect = (target, extra = '') => ({
    src: { family: 'alias' },
    out: { path: 'index.html' },
    rel: { pub: { url: `/${target}` } },
    contents: Buffer.from(`${extra}<script>location="${target}"</script>\n<meta http-equiv="refresh" content="0; url=${target}">\n<a href="${target}">${target}</a>`),
  })
  const catalog = (...files) => ({ getFiles: () => files })
  const plan = { product: product(r601, r600) }
  const file = redirect('suse-security/6.0.0/en/introduction.html', '<link rel="canonical" href="https://docs.example/suse-security/6.0.0/en/introduction.html">\n')
  assert.equal(ext.redirectStartPage(plan, catalog(file)), true)
  assert.equal(file.contents.toString(),
    '<link rel="canonical" href="https://docs.example/suse-security/6.0.0/en/introduction.html">\n' +
    '<script>location="suse-security/latest/en/introduction.html"</script>\n' +
    '<meta http-equiv="refresh" content="0; url=suse-security/latest/en/introduction.html">\n' +
    '<a href="suse-security/latest/en/introduction.html">suse-security/latest/en/introduction.html</a>')
  // Not in the latest release, not in the product, or no contents: no change.
  for (const other of [redirect('suse-security/6.0.1/en/introduction.html'), redirect('k3s/latest/en/introduction.html'), { ...redirect('suse-security/6.0.0/en/x.html'), contents: null }]) {
    const before = other.contents?.toString()
    assert.equal(ext.redirectStartPage(plan, catalog(other)), false)
    assert.equal(other.contents?.toString(), before)
  }
  // No release that is not a prerelease: no latest.
  assert.equal(ext.redirectStartPage({ product: product(r601) }, catalog(redirect('suse-security/6.0.1/en/introduction.html'))), false)
})

test('the links make the shared component versions and the releases reachable through the aliases', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const links = [
    ['suse-security/6.0.1/en/admission-controller', '../../6.0.0/en/admission-controller'],
    ['suse-security/latest', '6.0.0'],
    ['suse-security/dev', '6.0.1'],
  ]
  for (const copy of [false, true]) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'release-url-layout-'))
    try {
      fs.mkdirSync(path.join(out, 'suse-security/6.0.0/en/admission-controller'), { recursive: true })
      fs.mkdirSync(path.join(out, 'suse-security/6.0.1/en'), { recursive: true })
      fs.writeFileSync(path.join(out, 'suse-security/6.0.0/en/admission-controller/x.html'), 'x')
      ext.createLinks(out, links, copy)
      for (const release of ['6.0.0', '6.0.1', 'latest', 'dev']) {
        assert.equal(fs.readFileSync(path.join(out, 'suse-security', release, 'en/admission-controller/x.html'), 'utf8'), 'x')
      }
      assert.equal(fs.lstatSync(path.join(out, 'suse-security/latest')).isSymbolicLink(), !copy)
      assert.throws(() => ext.createLinks(out, [['suse-security/latest', '6.0.0']], copy), /already exists/)
      // The next build removes the links, not the files they point to.
      assert.equal(ext.removeLinks(path.join(out, 'suse-security')), copy ? 0 : 3)
      assert.equal(fs.existsSync(path.join(out, 'suse-security/latest')), copy)
      assert.equal(fs.readFileSync(path.join(out, 'suse-security/6.0.0/en/admission-controller/x.html'), 'utf8'), 'x')
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  }
})

// A content aggregate without Antora: buckets with files that can be cloned.
const fakeFile = (path, contents = '') => {
  const file = { path, src: { path }, contents: Buffer.from(contents) }
  file.clone = () => ({ ...file, src: { ...file.src } })
  return file
}
const configFile = (data, path = 'modules/en/partials/product-specific/suse-security-release-config.yml') =>
  fakeFile(path, JSON.stringify(data))
const bucket = (name, version, files = [], extra = {}) => ({ name, version, title: name, files, ...extra })
const fakeAggregate = () => [
  bucket('shared', 'latest', [configFile(config(r601, r600))]),
  bucket('kubewarden', '1.0', [fakeFile('modules/en/pages/introduction.adoc')], { asciidoc: { attributes: { a: 'b' } } }),
  bucket('admission-controller', '1.39', [], { prerelease: '-dev' }),
  bucket('admission-controller', '1.38'),
  bucket('admission-controller', '1.37'),
  bucket('network-enforcer', '0.4', [], { prerelease: '-dev' }),
  bucket('network-enforcer', '0.3'),
  bucket('k3s', 'latest'),
]

test('a configuration file must be in a component with one version', () => {
  const aggregate = [bucket('docs', '1.0', [configFile(config(r600))]), bucket('docs', '2.0')]
  assert.throws(() => ext.loadProducts(aggregate, JSON.parse), /must be in a component with one version/)
  assert.deepEqual(ext.loadProducts([bucket('docs', '1.0', [fakeFile('modules/en/partials/notes.yml', '{}')])], JSON.parse), [])
})

test('two products cannot share a component or a URL prefix', () => {
  const other = { product: { component: 'other', landing_version: '1', url_prefix: 'other' }, releases: [r600] }
  assert.throws(() => ext.loadProducts([
    bucket('shared', 'latest', [configFile(config(r600)), configFile(other, 'modules/en/partials/other-release-config.yml')]),
  ], JSON.parse), /admission-controller is in .* and in /)
  const prefix = { product: { component: 'other', landing_version: '1', url_prefix: 'suse-security' }, releases: [{ version: '1', components: { z: '1' } }] }
  assert.throws(() => ext.loadProducts([
    bucket('shared', 'latest', [configFile(config(r600)), configFile(prefix, 'modules/en/partials/other-release-config.yml')]),
  ], JSON.parse), /url_prefix suse-security is in/)
})

test('the plan leaves out unpinned versions and adds one landing copy for each release', () => {
  const aggregate = fakeAggregate()
  const [loaded] = ext.loadProducts(aggregate, JSON.parse)
  const plan = ext.planAggregate(loaded, aggregate)
  assert.deepEqual(aggregate.map((it) => `${it.version}@${it.name}`).sort(), [
    '0.3@network-enforcer', '0.4@network-enforcer', '1.38@admission-controller',
    '6.0.0@kubewarden', '6.0.1@kubewarden', 'latest@k3s', 'latest@shared',
  ])
  const copy = aggregate.find((it) => it.name === 'kubewarden' && it.version === '6.0.1')
  assert.equal(copy.displayVersion, '6.0.1 (preview)')
  assert.equal(copy.prerelease, true)
  assert.deepEqual(copy.asciidoc.attributes, {
    a: 'b',
    'release-version': '6.0.1',
    'release-admission-controller-version': '1.38',
    'release-network-enforcer-version': '0.4',
  })
  assert.notEqual(copy.files[0], aggregate.find((it) => it.version === '6.0.0' && it.name === 'kubewarden').files[0])
  assert.equal('prerelease' in aggregate.find((it) => it.version === '6.0.0' && it.name === 'kubewarden'), false)
  // The home of a shared component version is the oldest release that pins it.
  assert.deepEqual(plan.moves.get('1.38@admission-controller'), { kind: 'component', name: 'admission-controller', version: '1.38', release: '6.0.0', shared: true })
  assert.deepEqual(plan.moves.get('0.4@network-enforcer'), { kind: 'component', name: 'network-enforcer', version: '0.4', release: '6.0.1', shared: false })
  assert.equal(plan.moves.get('6.0.1@kubewarden').kind, 'landing')
})

test('the plan stops the build on a bad release', () => {
  const plan = (releases, change = (it) => it) => () => {
    const aggregate = change(fakeAggregate())
    ext.planAggregate(product(...releases), aggregate)
  }
  assert.throws(plan([{ version: '6.0.0', components: { 'admission-controller': '1.20' } }]), /names admission-controller 1.20, which is not in the site/)
  assert.throws(plan([{ version: '6.1.0', components: { 'admission-controller': '1.39' } }]), /prerelease admission-controller 1.39, so it must set prerelease: true/)
  assert.throws(plan([r600], (aggregate) => [...aggregate, bucket('suse-security', '1')]), /url_prefix suse-security is also the name of a component/)
  assert.throws(plan([r600], (aggregate) => aggregate.filter((it) => it.name !== 'kubewarden')), /has no version 1.0/)
  assert.throws(plan([r600], (aggregate) => [...aggregate, bucket('kubewarden', '6.0.0')]), /already has a version 6.0.0/)
})

// Playbook and URLs -------------------------------------------------------------

test('the playbook must use the default URL layout and publish to the file system', () => {
  ext.checkPlaybook({}, '3.2.1')
  ext.checkPlaybook({ urls: { htmlExtensionStyle: 'default' } }, '3.1.14')
  assert.throws(() => ext.checkPlaybook({}, '4.0.0'), /Antora 4.0.0 is not supported/)
  assert.throws(() => ext.checkPlaybook({ urls: { htmlExtensionStyle: 'indexify' } }, '3.2.1'), /html_extension_style: default/)
  assert.throws(() => ext.checkPlaybook({ urls: { latestVersionSegment: 'latest' } }, '3.2.1'), /must not set urls.latest_version_segment/)
  assert.throws(() => ext.checkPlaybook({ output: { destinations: [{ provider: 'archive' }] } }, '3.2.1'), /publish to the file system/)
})

test('relative URLs resolve against the page URL', () => {
  assert.equal(ext.resolveUrl('/a/b/c/page.html', '../d/x.html#top'), '/a/b/d/x.html')
  assert.equal(ext.resolveUrl('/a/b/page.html', '../'), '/a/')
  assert.equal(ext.isRelative('x.html'), true)
  for (const url of ['https://x', 'mailto:a@b', '/abs', '#frag', '?q', '']) assert.equal(ext.isRelative(url), false)
})

// Fixture: a small site classified by Antora -----------------------------------------

const ORIGIN = { type: 'git', url: 'https://example.org/docs.git', startPath: '' }

function antoraFile (path, contents = '= Page\n') {
  const { File } = antora
  const basename = posix.basename(path)
  const extname = posix.extname(path)
  return new File({
    path,
    contents: Buffer.from(contents),
    src: { path, basename, stem: basename.slice(0, basename.length - extname.length), extname, origin: ORIGIN },
  })
}

function componentBucket (name, version, paths, extra = {}) {
  return {
    name,
    version,
    title: name,
    startPage: 'en:introduction.adoc',
    nav: ['modules/en/nav.adoc'],
    origins: [ORIGIN],
    files: ['modules/en/nav.adoc', ...paths].map((path) => antoraFile(path, path.endsWith('nav.adoc') ? '* xref:introduction.adoc[]\n' : '= Page\n')),
    ...extra,
  }
}

const PAGES = [
  'modules/en/pages/introduction.adoc',
  'modules/en/pages/howtos/install.adoc',
  'modules/en/images/diagram.png',
  'modules/de/pages/introduction.adoc',
]

function site ({ releases = [r601, r600], extraBuckets = [], extraFiles = {} } = {}) {
  const aggregate = [
    { name: 'shared', version: 'latest', title: 'shared', origins: [ORIGIN], files: [antoraFile('modules/en/partials/product-specific/suse-security-release-config.yml', JSON.stringify(config(...releases)))] },
    componentBucket('kubewarden', '1.0', ['modules/en/pages/introduction.adoc', ...(extraFiles.kubewarden || [])]),
    componentBucket('admission-controller', '1.39', PAGES, { prerelease: '-dev' }),
    componentBucket('admission-controller', '1.38', [...PAGES, ...(extraFiles['admission-controller'] || [])]),
    componentBucket('admission-controller', '1.37', PAGES),
    componentBucket('network-enforcer', '0.4', ['modules/en/pages/introduction.adoc'], { prerelease: '-dev' }),
    componentBucket('network-enforcer', '0.3', ['modules/en/pages/introduction.adoc']),
    componentBucket('k3s', 'latest', ['modules/en/pages/introduction.adoc']),
    ...extraBuckets,
  ]
  const [loaded] = ext.loadProducts(aggregate, JSON.parse)
  const plan = ext.planAggregate(loaded, aggregate)
  const contentCatalog = antora.classifyContent({ site: {}, urls: { htmlExtensionStyle: 'default' } }, aggregate, {})
  return { plan, contentCatalog }
}

const page = (contentCatalog, component, version, module, relative) =>
  contentCatalog.getById({ component, version, module, family: 'page', relative })

test('moves pinned component versions and landing copies under the release', fixture, () => {
  const { plan, contentCatalog } = site()
  const result = ext.moveFiles(plan, contentCatalog)
  const install = page(contentCatalog, 'admission-controller', '1.38', 'en', 'howtos/install.adoc')
  assert.equal(install.out.path, 'suse-security/6.0.0/en/admission-controller/howtos/install.html')
  assert.equal(install.pub.url, '/suse-security/6.0.0/en/admission-controller/howtos/install.html')
  assert.equal(install.out.rootPath, '../../../../..')
  assert.equal(install.pub.rootPath, '../../../../..')
  assert.equal(install.out.moduleRootPath, '..')
  const image = contentCatalog.getById({ component: 'admission-controller', version: '1.38', module: 'en', family: 'image', relative: 'diagram.png' })
  assert.equal(image.out.path, 'suse-security/6.0.0/en/admission-controller/_images/diagram.png')
  assert.equal(page(contentCatalog, 'admission-controller', '1.38', 'de', 'introduction.adoc').pub.url, '/suse-security/6.0.0/de/admission-controller/introduction.html')
  const nav = contentCatalog.findBy({ component: 'admission-controller', version: '1.38', family: 'nav' })[0]
  assert.equal(nav.pub.url, '/suse-security/6.0.0/en/admission-controller/')
  assert.equal(contentCatalog.getComponentVersion('admission-controller', '1.38').url, '/suse-security/6.0.0/en/admission-controller/introduction.html')
  // A component version that only a later release pins lives under that release.
  assert.equal(page(contentCatalog, 'network-enforcer', '0.4', 'en', 'introduction.adoc').pub.url, '/suse-security/6.0.1/en/network-enforcer/introduction.html')
  // Each release has its own landing page.
  assert.equal(page(contentCatalog, 'kubewarden', '6.0.1', 'en', 'introduction.adoc').out.path, 'suse-security/6.0.1/en/introduction.html')
  assert.equal(page(contentCatalog, 'kubewarden', '6.0.0', 'en', 'introduction.adoc').out.rootPath, '../../..')
  assert.equal(contentCatalog.getComponentVersion('kubewarden', '6.0.0').asciidoc.attributes['release-network-enforcer-version'], '0.3')
  // Unpinned versions are not in the site; other components do not move.
  assert.deepEqual(contentCatalog.getComponent('admission-controller').versions.map((it) => it.version), ['1.38'])
  assert.equal(contentCatalog.getComponent('kubewarden').versions.some((it) => it.version === '1.0'), false)
  assert.equal(page(contentCatalog, 'k3s', 'latest', 'en', 'introduction.adoc').out.path, 'k3s/latest/en/introduction.html')
  // Nothing stays at the old paths, including Antora's redirect to the start page.
  const old = contentCatalog.getFiles().filter((file) => file.out && /^(admission-controller|network-enforcer|kubewarden)\//.test(file.out.path))
  assert.deepEqual(old.map((file) => file.out.path), [])
  assert.ok(result.removed > 0)
  ext.verify(plan, contentCatalog)
  assert.deepEqual(ext.symlinks(plan, result.modules), [
    ['suse-security/6.0.1/de/admission-controller', '../../6.0.0/de/admission-controller'],
    ['suse-security/6.0.1/en/admission-controller', '../../6.0.0/en/admission-controller'],
    ['suse-security/latest', '6.0.0'],
    ['suse-security/dev', '6.0.1'],
  ])
  assert.deepEqual(ext.manifest(plan).aliases, { latest: '6.0.0', dev: '6.0.1' })
  assert.deepEqual(ext.manifest(plan).releases[0], {
    version: '6.0.1',
    prerelease: true,
    components: { 'admission-controller': { version: '1.38', home: '6.0.0' }, 'network-enforcer': { version: '0.4', home: '6.0.1' } },
  })
})

test('moves the page aliases that Antora registers later', fixture, () => {
  const { plan, contentCatalog } = site()
  ext.moveFiles(plan, contentCatalog)
  const target = page(contentCatalog, 'admission-controller', '1.38', 'en', 'howtos/install.adoc')
  const alias = contentCatalog.registerPageAlias('howtos/setup.adoc', target)
  assert.equal(alias.out.path, 'admission-controller/1.38/en/howtos/setup.html')
  assert.throws(() => ext.verify(plan, contentCatalog), /is at admission-controller\/1.38\/en\/howtos\/setup.html/)
  assert.equal(ext.moveAliases(plan, contentCatalog), 1)
  assert.equal(alias.out.path, 'suse-security/6.0.0/en/admission-controller/howtos/setup.html')
  ext.verify(plan, contentCatalog)
})

test('stops the build if a file would end up under the URL prefix without a release', fixture, () => {
  const extraBuckets = [componentBucket('ROOT', '', ['modules/suse-security/pages/introduction.adoc'], { startPage: undefined, nav: undefined })]
  const { plan, contentCatalog } = site({ extraBuckets })
  assert.throws(() => ext.moveFiles(plan, contentCatalog), /under the URL prefix suse-security, but no release puts it there/)
})

test('stops the build for a landing page in a folder with the name of a component', fixture, () => {
  const { plan, contentCatalog } = site({ extraFiles: { kubewarden: ['modules/en/pages/admission-controller/extra.adoc'] } })
  assert.throws(() => ext.moveFiles(plan, contentCatalog), /is in a folder with the name of the component admission-controller/)
})

test('stops the build for a moved component version with a ROOT module', fixture, () => {
  const { plan, contentCatalog } = site({ extraFiles: { 'admission-controller': ['modules/ROOT/pages/extra.adoc'] } })
  assert.throws(() => ext.moveFiles(plan, contentCatalog), /is in the ROOT module/)
})

test('a link from a moved page to another component must be an xref', fixture, () => {
  const { plan, contentCatalog } = site()
  ext.moveFiles(plan, contentCatalog)
  const intro = page(contentCatalog, 'admission-controller', '1.38', 'en', 'introduction.adoc')
  intro.contents = Buffer.from('<a href="howtos/install.html">own</a> <a href="../network-enforcer/introduction.html" class="xref page">xref</a>')
  assert.equal(ext.checkContentLinks(plan, contentCatalog), 0)
  intro.contents = Buffer.from('<a href="../network-enforcer/introduction.html">hand-written</a>')
  assert.throws(() => ext.checkContentLinks(plan, contentCatalog), /must be xrefs, not relative paths:\n {2}1.38@admission-controller:en:page\$introduction.adoc: ..\/network-enforcer\/introduction.html/)
})

test('in shared pages, links that leave the component version go through the site root', fixture, () => {
  const { plan, contentCatalog } = site()
  ext.moveFiles(plan, contentCatalog)
  const install = page(contentCatalog, 'admission-controller', '1.38', 'en', 'howtos/install.adoc')
  install.contents = Buffer.from([
    '<link rel="stylesheet" href="../../../../../_/css/site.css">',
    '<a href="../introduction.html">own page</a>',
    '<img src="../_images/diagram.png">',
    '<a href="../../../../6.0.1/en/introduction.html">landing</a>',
    '<a href="../../network-enforcer/introduction.html#top" class="xref page">xref</a>',
    '<a class="version" href="install.html" data-release-option="6.0.0">6.0.0</a>',
    '<a href="https://example.org/">external</a>',
  ].join('\n'))
  // Pages of component versions that are not shared do not change.
  const ne = page(contentCatalog, 'network-enforcer', '0.4', 'en', 'introduction.adoc')
  ne.contents = Buffer.from('<a href="../admission-controller/introduction.html">x</a>')
  assert.equal(ext.anchorSharedLinks(plan, contentCatalog), 4)
  assert.equal(install.contents.toString(), [
    '<link rel="stylesheet" href="../../../../../_/css/site.css">',
    '<a href="../introduction.html">own page</a>',
    '<img src="../_images/diagram.png">',
    '<a href="../../../../../suse-security/6.0.1/en/introduction.html">landing</a>',
    '<a href="../../../../../suse-security/6.0.0/en/network-enforcer/introduction.html#top" class="xref page">xref</a>',
    '<a class="version" href="../../../../../suse-security/6.0.0/en/admission-controller/howtos/install.html" data-release-option="6.0.0">6.0.0</a>',
    '<a href="https://example.org/">external</a>',
  ].join('\n'))
  assert.equal(ne.contents.toString(), '<a href="../admission-controller/introduction.html">x</a>')
})
