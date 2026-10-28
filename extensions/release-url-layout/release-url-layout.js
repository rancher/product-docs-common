'use strict'

// Publishes the releases of a product under one URL prefix.
//
// A product is a landing component and some component versions, pinned by
// product releases. A content repository describes a product in a partial
// named <product>-release-config.yml. For example, SUSE Security:
// shared/modules/en/partials/product-specific/suse-security-release-config.yml
// in rancher/suse-security-product-docs.
//
// For each product, this extension:
//
// 1. contentAggregated: leaves out the versions of the product components
//    that no release pins, and replaces the landing component version with
//    one copy for each release. Each copy has the release as its version and
//    sets the release-version and release-<component>-version attributes.
// 2. contentClassified: moves each pinned component version to
//    /<url_prefix>/<release>/<module>/<component>/, under the oldest release
//    that pins it, and each landing copy to /<url_prefix>/<release>/<module>/.
//    The module is the language, for example en.
// 3. documentsConverted: moves the page aliases, which Antora registers while
//    it converts the documents, and stops the build if a moved page links to
//    another component with a relative path instead of an xref.
// 4. pagesComposed: in the pages of a component version that several
//    releases pin, makes the links to other places go through the site root.
//    The other releases reach these pages through a symlink (see 6), so a
//    plain relative link would resolve in the wrong release.
// 5. beforePublish: checks the result, and writes
//    /<url_prefix>/release-url-layout.json for split-search-index.js.
// 6. sitePublished: links /<url_prefix>/<release>/<module>/<component> to the
//    oldest release for each component version that several releases pin.
//
// Robustness comes first: the configuration is checked strictly, every move
// is planned and checked before any file changes, and anything unexpected
// stops the build. Without a configuration file, the extension does nothing.

const fs = require('node:fs')
const path = require('node:path')
const posix = path.posix

const NAME = 'release-url-layout'
const MANIFEST = 'release-url-layout.json'
const CONFIG_RX = /^modules\/[^/]+\/partials\/(?:.+\/)?([a-z0-9][a-z0-9-]*)-release-config\.yml$/
const SEGMENT_RX = /^[a-z][a-z0-9-]*$/
const RELEASE_RX = /^[0-9A-Za-z][0-9A-Za-z.-]*$/
const SUPPORTED_ANTORA_RX = /^3\.[12]\./
const SCHEME_RX = /^[a-z][a-z0-9+.-]*:/i

class LayoutError extends Error {
  constructor (message) {
    super(`${NAME}: ${message}`)
  }
}

const fail = (message) => { throw new LayoutError(message) }

// Configuration -------------------------------------------------------------

function validateConfig (config, source, name) {
  const bad = (message) => fail(`${source}: ${message}`)
  const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
  const onlyKeys = (object, keys, where) => {
    for (const key of Object.keys(object)) if (!keys.includes(key)) bad(`${where}: unknown key ${key}`)
  }
  if (!isObject(config)) bad('the file must contain product and releases')
  onlyKeys(config, ['product', 'releases'], 'top level')
  const product = config.product
  if (!isObject(product)) bad('product must be a map')
  onlyKeys(product, ['component', 'landing_version', 'url_prefix'], 'product')
  for (const key of ['component', 'landing_version', 'url_prefix']) {
    if (typeof product[key] !== 'string' || !product[key]) bad(`product.${key} must be a string`)
  }
  if (!SEGMENT_RX.test(product.url_prefix)) bad(`product.url_prefix must match ${SEGMENT_RX}`)
  if (!Array.isArray(config.releases) || !config.releases.length) bad('releases must be a list with at least one release')
  const versions = new Set()
  const releases = config.releases.map((release, i) => {
    const where = `releases[${i}]`
    if (!isObject(release)) bad(`${where} must be a map`)
    onlyKeys(release, ['version', 'prerelease', 'components'], where)
    if (typeof release.version !== 'string' || !RELEASE_RX.test(release.version)) {
      bad(`${where}: version must be a string that matches ${RELEASE_RX}`)
    }
    if (versions.has(release.version)) bad(`${where}: release ${release.version} appears more than once`)
    versions.add(release.version)
    if (release.prerelease != null && typeof release.prerelease !== 'boolean') bad(`${where}: prerelease must be true or false`)
    if (!isObject(release.components) || !Object.keys(release.components).length) {
      bad(`${where}: components must map component names to versions`)
    }
    for (const [component, version] of Object.entries(release.components)) {
      if (component === product.component) bad(`${where}: ${component} is the landing component`)
      if (!SEGMENT_RX.test(component)) bad(`${where}: component name ${component} must match ${SEGMENT_RX}`)
      if (typeof version !== 'string' || !version) bad(`${where}: the version of ${component} must be a string, for example '1.0'`)
    }
    return { version: release.version, prerelease: release.prerelease === true, components: { ...release.components } }
  })
  return {
    name,
    source,
    landing: product.component,
    landingVersion: product.landing_version,
    prefix: product.url_prefix,
    releases,
  }
}

// Finds and validates the configuration files in the content aggregate. A
// configuration file must be in a component that has one version, for
// example shared, so that there is no doubt about which file counts.
function loadProducts (contentAggregate, parse) {
  const versionsOf = new Map()
  for (const bucket of contentAggregate) versionsOf.set(bucket.name, (versionsOf.get(bucket.name) || 0) + 1)
  const products = []
  for (const bucket of contentAggregate) {
    for (const file of bucket.files) {
      const match = CONFIG_RX.exec(file.src?.path ?? file.path)
      if (!match) continue
      const source = `${match[0]} in ${bucket.version}@${bucket.name}`
      if (versionsOf.get(bucket.name) !== 1) fail(`${source}: the file must be in a component with one version, for example shared`)
      products.push(validateConfig(parse(file.contents.toString()), source, match[1]))
    }
  }
  const owner = new Map()
  const prefixes = new Map()
  for (const product of products) {
    for (const name of [product.landing, ...product.releases.flatMap((release) => Object.keys(release.components))]) {
      if (owner.has(name) && owner.get(name) !== product.source) fail(`${name} is in ${owner.get(name)} and in ${product.source}`)
      owner.set(name, product.source)
    }
    if (prefixes.has(product.prefix)) fail(`url_prefix ${product.prefix} is in ${prefixes.get(product.prefix)} and in ${product.source}`)
    prefixes.set(product.prefix, product.source)
  }
  return products
}

// Step 1: contentAggregated -------------------------------------------------

// Plans the product against the content aggregate, then changes the aggregate:
// removes the unpinned versions and adds the landing copies. Returns the plan.
function planAggregate (product, contentAggregate) {
  const bad = (message) => fail(`${product.source}: ${message}`)
  const bucketsOf = (name) => contentAggregate.filter((bucket) => bucket.name === name)
  if (bucketsOf(product.prefix).length) bad(`url_prefix ${product.prefix} is also the name of a component`)
  const landingBucket = bucketsOf(product.landing).find((bucket) => bucket.version === product.landingVersion)
  if (!landingBucket) bad(`the landing component ${product.landing} has no version ${product.landingVersion}`)
  for (const release of product.releases) {
    if (bucketsOf(product.landing).some((bucket) => bucket.version === release.version)) {
      bad(`the landing component ${product.landing} already has a version ${release.version}, the version of a release`)
    }
  }

  // The home of a pinned component version is the oldest release that pins it.
  // Releases are newest first.
  const homes = new Map()
  const pinnedBy = new Map()
  for (const release of product.releases) {
    for (const [name, version] of Object.entries(release.components)) {
      const bucket = bucketsOf(name).find((it) => it.version === version)
      if (!bucket) bad(`release ${release.version} names ${name} ${version}, which is not in the site`)
      if (bucket.prerelease && !release.prerelease) {
        bad(`release ${release.version} names the prerelease ${name} ${version}, so it must set prerelease: true`)
      }
      const key = `${version}@${name}`
      homes.set(key, release.version)
      pinnedBy.set(key, [...(pinnedBy.get(key) || []), release.version])
    }
  }

  const componentNames = new Set(product.releases.flatMap((release) => Object.keys(release.components)))
  const removed = []
  for (let i = contentAggregate.length - 1; i >= 0; i--) {
    const bucket = contentAggregate[i]
    const unpinned = componentNames.has(bucket.name) && !homes.has(`${bucket.version}@${bucket.name}`)
    if (unpinned || bucket.name === product.landing) {
      removed.push(`${bucket.version}@${bucket.name}`)
      contentAggregate.splice(i, 1)
    }
  }
  for (const release of product.releases) contentAggregate.push(landingCopy(landingBucket, release))

  const moves = new Map()
  for (const [key, release] of homes) {
    const [version, name] = splitKey(key)
    moves.set(key, { kind: 'component', name, version, release, shared: pinnedBy.get(key).length > 1 })
  }
  for (const release of product.releases) {
    moves.set(`${release.version}@${product.landing}`, { kind: 'landing', name: product.landing, version: release.version, release: release.version, shared: false })
  }
  return { product, moves, pinnedBy, componentNames, removed: removed.reverse() }
}

function splitKey (key) {
  const at = key.indexOf('@')
  return [key.slice(0, at), key.slice(at + 1)]
}

function landingCopy (bucket, release) {
  const attributes = { ...bucket.asciidoc?.attributes, 'release-version': release.version }
  for (const [name, version] of Object.entries(release.components)) attributes[`release-${name}-version`] = version
  const copy = {
    ...bucket,
    version: release.version,
    displayVersion: release.prerelease ? `${release.version} (preview)` : release.version,
    asciidoc: { ...bucket.asciidoc, attributes },
    origins: [...(bucket.origins || [])],
    files: bucket.files.map((file) => {
      const clone = file.clone({ deep: false })
      clone.src = { ...file.src }
      return clone
    }),
  }
  if (release.prerelease) copy.prerelease = true
  else delete copy.prerelease
  return copy
}

// Step 2: contentClassified -------------------------------------------------

const encodeUrl = (url) => (~url.indexOf(' ') ? url.replaceAll(' ', '%20') : url)

// Plans the move of one file of a moved component version. Returns
// { file, out, pub }, or { file, pub } for a navigation file, or
// { file, remove: true } for Antora's redirect to the start page, or
// undefined for a file that is not published.
function planFileMove (plan, key, move, file) {
  const { product } = plan
  const bad = (message) => fail(`${product.source}: ${key}: ${message}`)
  const { name, version, kind, release } = move
  const { src } = file
  if (!file.out && !file.pub) return
  // Antora's redirect to the start page of a component version, at
  // /<component>/<version>/index.html. Nothing stays at the old paths.
  if (src.family === 'alias' && src.module === 'ROOT' && file.synthetic) return { file, remove: true }
  if (src.module === 'ROOT') bad(`${src.path || src.relative} is in the ROOT module; the layout needs a language module`)
  const oldBase = `${name}/${version}/`
  const moduleRoot = kind === 'component'
    ? posix.join(product.prefix, release, src.module, name)
    : posix.join(product.prefix, release, src.module)
  if (src.family === 'nav') {
    const expected = `/${oldBase}${src.module}/`
    if (file.out || file.pub.url !== expected) bad(`the navigation file ${src.path} has the URL ${file.pub.url}, not ${expected}`)
    return { file, pub: { ...file.pub, url: `/${moduleRoot}/` } }
  }
  if (!file.out || !file.pub) bad(`${src.path || src.relative} has ${file.out ? 'no URL' : 'no output path'}`)
  const modulePrefix = `${oldBase}${src.module}/`
  if (!file.out.path.startsWith(modulePrefix)) bad(`${file.out.path} does not start with ${modulePrefix}`)
  if (file.pub.url !== encodeUrl('/' + file.out.path)) bad(`the URL ${file.pub.url} does not match the output path ${file.out.path}`)
  const rest = file.out.path.slice(modulePrefix.length)
  if (kind === 'landing' && rest.includes('/') && plan.componentNames.has(rest.split('/')[0])) {
    bad(`${file.out.path} is in a folder with the name of the component ${rest.split('/')[0]}`)
  }
  const newPath = posix.join(moduleRoot, rest)
  const dirname = posix.dirname(newPath)
  const rootPath = posix.relative(dirname, '') || '.'
  const moduleRootPath = posix.relative(dirname, moduleRoot) || '.'
  if (moduleRootPath !== file.out.moduleRootPath) {
    bad(`${file.out.path} would have the module root path ${moduleRootPath}, not ${file.out.moduleRootPath}`)
  }
  const out = { dirname, basename: posix.basename(newPath), path: newPath, moduleRootPath, rootPath }
  return { file, out, pub: { ...file.pub, url: encodeUrl('/' + newPath), moduleRootPath, rootPath } }
}

// Checks that no two files would have the same output path after the changes,
// and that nothing that does not move is under the URL prefix.
function checkPaths (plan, contentCatalog, changes) {
  const { prefix, source } = plan.product
  const bad = (message) => fail(`${source}: ${message}`)
  const moving = new Map()
  const removing = new Set()
  for (const change of changes) {
    if (change.remove) removing.add(change.file)
    else if (change.out) moving.set(change.file, change.out.path)
  }
  const paths = new Map()
  for (const file of contentCatalog.getFiles()) {
    if (!file.out || removing.has(file)) continue
    const outPath = moving.get(file) ?? file.out.path
    if (!moving.has(file) && (outPath === prefix || outPath.startsWith(prefix + '/')) && !plan.placed?.has(file)) {
      bad(`${outPath} is under the URL prefix ${prefix}, but no release puts it there`)
    }
    if (paths.has(outPath)) bad(`two files would have the output path ${outPath}: ${describe(paths.get(outPath))} and ${describe(file)}`)
    paths.set(outPath, file)
  }
}

// Applies checked changes. Changes the objects in place: other files refer to
// them, for example the target of an alias.
function applyChanges (plan, contentCatalog, changes) {
  plan.placed ??= new Set()
  for (const change of changes) {
    if (change.remove) {
      contentCatalog.removeFile(change.file)
      continue
    }
    if (change.out) Object.assign(change.file.out, change.out)
    Object.assign(change.file.pub, change.pub)
    plan.placed.add(change.file)
  }
}

// Moves the files of the planned component versions. Plans and checks every
// move first, then applies all of them.
function moveFiles (plan, contentCatalog) {
  const bad = (message) => fail(`${plan.product.source}: ${message}`)
  const changes = []
  const startPages = []
  const modules = new Map()
  for (const [key, move] of plan.moves) {
    const componentVersion = contentCatalog.getComponentVersion(move.name, move.version)
    if (!componentVersion) bad(`${key} is not in the content catalog`)
    const newUrlOf = new Map()
    modules.set(key, new Set())
    const files = contentCatalog.getFiles().filter(({ src }) => src.component === move.name && src.version === move.version)
    for (const file of files) {
      const change = planFileMove(plan, key, move, file)
      if (!change) continue
      changes.push(change)
      if (!change.out) continue
      newUrlOf.set(file.pub.url, change.pub.url)
      if (file.src.family === 'page') modules.get(key).add(file.src.module)
    }
    const url = newUrlOf.get(componentVersion.url)
    if (!url) bad(`${key}: no page has the start page URL ${componentVersion.url}`)
    startPages.push({ componentVersion, url })
  }
  checkPaths(plan, contentCatalog, changes)
  applyChanges(plan, contentCatalog, changes)
  for (const { componentVersion, url } of startPages) componentVersion.url = url
  return { modules, moved: changes.filter((change) => !change.remove).length, removed: changes.filter((change) => change.remove).length }
}

// Antora registers the page aliases while it converts the documents, after
// contentClassified. Moves the aliases of the moved component versions.
function moveAliases (plan, contentCatalog) {
  const changes = []
  for (const [key, move] of plan.moves) {
    const oldBase = `${move.name}/${move.version}/`
    const aliases = contentCatalog.findBy({ family: 'alias' }).filter(({ src, out }) =>
      src.component === move.name && src.version === move.version && out && out.path.startsWith(oldBase))
    for (const file of aliases) {
      const change = planFileMove(plan, key, move, file)
      if (change) changes.push(change)
    }
  }
  checkPaths(plan, contentCatalog, changes)
  applyChanges(plan, contentCatalog, changes)
  return changes.length
}

function describe (file) {
  const { component, version, module, family, relative } = file.src
  return `${version}@${component}:${module}:${family}$${relative}`
}

// Steps 3 and 4: links ------------------------------------------------------

function isRelative (url) {
  return url !== '' && !SCHEME_RX.test(url) && !url.startsWith('/') && !url.startsWith('#') && !url.startsWith('?')
}

function splitUrl (url) {
  const index = url.search(/[?#]/)
  return index < 0 ? [url, ''] : [url.slice(0, index), url.slice(index)]
}

function resolveUrl (fromUrl, relative) {
  const [target] = splitUrl(relative)
  const resolved = posix.normalize(posix.join(posix.dirname(fromUrl), target))
  return target.endsWith('/') && !resolved.endsWith('/') ? resolved + '/' : resolved
}

// The URL space that belongs to a moved page: its component version for a
// component, and the landing pages, without the component folders, for a landing copy.
function ownArea (plan, move, file) {
  const base = `/${plan.product.prefix}/${move.release}/${file.src.module}/`
  if (move.kind === 'component') return (url) => url.startsWith(`${base}${move.name}/`)
  return (url) => url.startsWith(base) && !plan.componentNames.has(url.slice(base.length).split('/')[0])
}

function movedPages (plan, contentCatalog, filter = () => true) {
  const pages = []
  for (const [key, move] of plan.moves) {
    if (!filter(move)) continue
    const [version, name] = splitKey(key)
    for (const file of contentCatalog.getPages(({ src, out }) => out && src.component === name && src.version === version)) {
      pages.push({ file, move })
    }
  }
  return pages
}

// Step 3: a link from a moved page to another component must be an xref.
function checkContentLinks (plan, contentCatalog) {
  const violations = []
  for (const { file, move } of movedPages(plan, contentCatalog)) {
    const inArea = ownArea(plan, move, file)
    for (const [tag] of file.contents.toString().matchAll(/<a\b[^>]*>/g)) {
      const href = /\shref="([^"]*)"/.exec(tag)?.[1]
      if (!href || !isRelative(href)) continue
      const target = resolveUrl(file.pub.url, href)
      if (inArea(target)) continue
      if (/\sclass="(?:[^"]*\s)?xref(?:\s[^"]*)?"/.test(tag)) continue
      violations.push(`${describe(file)}: ${href}`)
    }
  }
  if (violations.length) {
    fail(`links to other components must be xrefs, not relative paths:\n  ${violations.slice(0, 20).join('\n  ')}` +
      (violations.length > 20 ? `\n  and ${violations.length - 20} more` : ''))
  }
  return violations.length
}

// Step 4: in the pages of a shared component version, links that leave the
// component version go through the site root. So do the links to a release
// (data-release-option, from the page version menu and the selector): each
// names its release, also when it links to the page itself.
function anchorSharedLinks (plan, contentCatalog) {
  let count = 0
  for (const { file, move } of movedPages(plan, contentCatalog, (it) => it.shared)) {
    const inArea = ownArea(plan, move, file)
    const anchor = (url, always) => {
      if (!isRelative(url)) return url
      const target = resolveUrl(file.pub.url, url)
      if (!always && inArea(target)) return url
      count++
      return posix.join(file.pub.rootPath, target.slice(1)) + (target.endsWith('/') ? '/' : '') + splitUrl(url)[1]
    }
    const html = file.contents.toString().replace(/<[a-z][a-z0-9]*\b[^>]*>/gi, (tag) => {
      const always = /\sdata-release-option="/.test(tag)
      return tag.replace(/(\s(?:href|src)=")([^"]*)(")/g, (match, before, url, after) => before + anchor(url, always) + after)
    })
    file.contents = Buffer.from(html)
  }
  return count
}

// Step 5: beforePublish -----------------------------------------------------

function verify (plan, contentCatalog) {
  const { product, moves, componentNames } = plan
  const bad = (message) => fail(`${product.source}: check after the build: ${message}`)
  for (const [key, move] of moves) {
    const [version, name] = splitKey(key)
    // Antora 3.1 getFiles() takes no filter.
    for (const file of contentCatalog.getFiles().filter(({ src, out }) => out && src.component === name && src.version === version)) {
      if (!file.out.path.startsWith(`${product.prefix}/${move.release}/`)) bad(`${describe(file)} is at ${file.out.path}`)
    }
  }
  for (const name of [...componentNames, product.landing]) {
    for (const componentVersion of contentCatalog.getComponent(name)?.versions || []) {
      if (!moves.has(`${componentVersion.version}@${name}`)) bad(`${componentVersion.version}@${name} is in the site, but no release pins it`)
    }
  }
}

function manifest (plan) {
  const { product, pinnedBy } = plan
  return {
    url_prefix: product.prefix,
    landing: product.landing,
    releases: product.releases.map((release) => ({
      version: release.version,
      prerelease: release.prerelease,
      components: Object.fromEntries(Object.entries(release.components).map(([name, version]) => {
        const homes = pinnedBy.get(`${version}@${name}`)
        return [name, { version, home: homes[homes.length - 1] }]
      })),
    })),
  }
}

// Step 6: sitePublished -----------------------------------------------------

// The links for one product: [link path, target], relative to the output
// directory and to the folder of the link.
function symlinks (plan, modules) {
  const links = []
  for (const release of plan.product.releases) {
    for (const [name, version] of Object.entries(release.components)) {
      const key = `${version}@${name}`
      const home = plan.moves.get(key).release
      if (home === release.version) continue
      for (const module of [...modules.get(key)].sort()) {
        links.push([posix.join(plan.product.prefix, release.version, module, name), posix.join('..', '..', home, module, name)])
      }
    }
  }
  return links
}

function createLinks (outputDir, links, copy) {
  for (const [link, target] of links) {
    const linkPath = path.join(outputDir, link)
    const targetPath = path.resolve(path.dirname(linkPath), target)
    if (!fs.existsSync(targetPath)) fail(`the target of the link ${link} does not exist: ${targetPath}`)
    if (fs.existsSync(linkPath) || isSymlink(linkPath)) fail(`${linkPath} already exists`)
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    if (copy) fs.cpSync(targetPath, linkPath, { recursive: true })
    else fs.symlinkSync(target, linkPath)
  }
}

function isSymlink (file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

// Playbook ------------------------------------------------------------------

function checkPlaybook (playbook, antoraVersion) {
  if (!SUPPORTED_ANTORA_RX.test(antoraVersion)) fail(`Antora ${antoraVersion} is not supported; use Antora 3.1 or 3.2`)
  const urls = playbook.urls || {}
  if ((urls.htmlExtensionStyle || 'default') !== 'default') fail('the playbook must use urls.html_extension_style: default')
  for (const key of ['latestVersionSegment', 'latestPrereleaseVersionSegment', 'latestVersionSegmentStrategy']) {
    if (urls[key] != null) fail(`the playbook must not set urls.${key.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase())}`)
  }
  const destinations = playbook.output?.destinations
  if (destinations?.length && destinations.some((it) => (it.provider || 'fs') !== 'fs')) {
    fail('the playbook must publish to the file system (output.dir), because the extension creates symlinks')
  }
}

function antoraVersionFor (playbook) {
  const file = require.resolve('@antora/content-classifier/package.json', { paths: [playbook.dir || process.cwd(), process.cwd()] })
  return JSON.parse(fs.readFileSync(file, 'utf8')).version
}

// Extension -----------------------------------------------------------------

module.exports.register = function () {
  const logger = this.getLogger(NAME)
  let playbook
  let plans = []
  const modules = new Map()

  this.once('playbookBuilt', ({ playbook: builtPlaybook }) => {
    playbook = builtPlaybook
    checkPlaybook(playbook, antoraVersionFor(playbook))
  })

  this.once('contentAggregated', ({ contentAggregate }) => {
    const products = loadProducts(contentAggregate, (text) => require('js-yaml').load(text))
    plans = products.map((product) => planAggregate(product, contentAggregate))
    for (const plan of plans) {
      logger.info('%s: %d releases; left out %d unpinned component versions: %s', plan.product.source,
        plan.product.releases.length, plan.removed.length, plan.removed.join(', ') || 'none')
    }
  })

  this.once('contentClassified', ({ contentCatalog }) => {
    for (const plan of plans) {
      const result = moveFiles(plan, contentCatalog)
      for (const [key, value] of result.modules) modules.set(`${plan.product.prefix}:${key}`, value)
      plan.modules = result.modules
      logger.info('%s: moved %d files under /%s/', plan.product.source, result.moved, plan.product.prefix)
    }
  })

  this.once('documentsConverted', ({ contentCatalog }) => {
    for (const plan of plans) {
      logger.info('%s: moved %d page aliases', plan.product.source, moveAliases(plan, contentCatalog))
      checkContentLinks(plan, contentCatalog)
    }
  })

  this.once('pagesComposed', ({ contentCatalog }) => {
    for (const plan of plans) {
      logger.info('%s: %d links in shared pages now go through the site root', plan.product.source, anchorSharedLinks(plan, contentCatalog))
    }
  })

  this.once('beforePublish', ({ contentCatalog, siteCatalog }) => {
    for (const plan of plans) {
      verify(plan, contentCatalog)
      const out = { path: posix.join(plan.product.prefix, MANIFEST) }
      if (siteCatalog.getFiles().some((file) => file.out?.path === out.path)) fail(`${out.path} already exists`)
      siteCatalog.addFile({ contents: Buffer.from(JSON.stringify(manifest(plan), null, 2) + '\n'), out })
    }
  })

  this.once('sitePublished', () => {
    if (!plans.length) return
    const outputDir = path.resolve(playbook.dir || process.cwd(), playbook.output?.dir || 'build/site')
    const copy = playbook.asciidoc?.attributes?.['build-environment'] === 'netlify'
    for (const plan of plans) {
      const links = symlinks(plan, plan.modules)
      createLinks(outputDir, links, copy)
      logger.info('%s: %s %d release paths to shared component versions', plan.product.source, copy ? 'copied' : 'linked', links.length)
    }
  })
}

module.exports._internal = {
  validateConfig,
  loadProducts,
  planAggregate,
  moveFiles,
  moveAliases,
  planFileMove,
  checkContentLinks,
  anchorSharedLinks,
  verify,
  manifest,
  symlinks,
  checkPlaybook,
  resolveUrl,
  isRelative,
}
