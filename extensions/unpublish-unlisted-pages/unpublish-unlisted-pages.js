// Originally sourced from https://docs.antora.org/antora/latest/extend/extension-use-cases/#unpublish-unlisted-pages,
// licensed under MPL-2.0.
module.exports.register = function ({ config }) {
  // Retrieve the target component(s) from the extension's configuration.
  // The extension will only run if `component` is defined in the playbook.
  let targetComponents = config.component
  if (!targetComponents) return // Do nothing if no component is specified.

  // Ensure targetComponents is an array for consistent processing.
  if (!Array.isArray(targetComponents)) {
    targetComponents = [targetComponents]
  }

  this.on('navigationBuilt', ({ contentCatalog }) => {
    contentCatalog.getComponents().forEach(({ versions }) => {
      versions.forEach(({ name: component, version, navigation: nav, url: defaultUrl }) => {
        // Only run for components specified in the playbook configuration.
        if (!targetComponents.includes(component)) return
        const navEntriesByUrl = getNavEntriesByUrl(nav)
        const unlistedPages = contentCatalog
          .findBy({ component, version, family: 'page' })
          .filter((page) => page.out)
          .reduce((collector, page) => {
            if ((page.pub.url in navEntriesByUrl) || page.pub.url === defaultUrl) return collector
            return collector.concat(page)
          }, [])
        if (unlistedPages.length) unlistedPages.forEach((page) => delete page.out)
      })
    })
  })
}

function getNavEntriesByUrl (items = [], accum = {}) {
  items.forEach((item) => {
    if (item.urlType === 'internal') accum[item.url.split('#')[0]] = item
    getNavEntriesByUrl(item.items, accum)
  })
  return accum
}