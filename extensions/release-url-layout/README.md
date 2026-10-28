# release-url-layout

An Antora extension that publishes the releases of a product under one URL
prefix, for example:

```text
/suse-security/6.0.0/en/admission-controller/introduction.html
/suse-security/6.0.0/en/introduction.html        (landing page of the release)
```

The language (the Antora module) is the third URL segment, as in the rest of
the site. The UI helpers in dsc-style-bundle, `search-ui.js`, and
`jscript/split-search-index.js` read it from there.

## Configuration

A content repository describes a product in a partial named
`<product>-release-config.yml`. The partial must be in a component with one
version, for example `shared`. Example:
`shared/modules/en/partials/product-specific/suse-security-release-config.yml`
in rancher/suse-security-product-docs.

```yaml
product:
  component: kubewarden        # the landing component
  landing_version: '1.0'       # its version to publish for each release
  url_prefix: suse-security    # the first URL segment
releases:                      # newest first
  - version: '6.0.1'
    prerelease: true           # optional; required if a pin is a prerelease
    components:
      admission-controller: '1.38'
      network-enforcer: '0.4'
  - version: '6.0.0'
    components:
      admission-controller: '1.38'
      network-enforcer: '0.3'
```

The `productreleases` helper in dsc-style-bundle reads the same file for the
"Component / version" selector and the page version menu.

## Playbook

Register the extension before `vlp.js`, so that `vlp.js` sees only the
component versions that are built:

```yaml
antora:
  extensions:
    - require: ./product-docs-common/extensions/release-url-layout/release-url-layout.js
    - require: ./product-docs-common/extensions/versions-latest-prerelease/vlp.js
```

Without a configuration file, the extension does nothing.

## What it does

1. `contentAggregated`: leaves out the versions of the product components that
   no release pins, and replaces the landing component version with one copy
   for each release. A copy has the release as its version and sets the
   AsciiDoc attributes `release-version` and `release-<component>-version`.
2. `contentClassified`: moves each pinned component version to
   `/<url_prefix>/<release>/<module>/<component>/`, under the oldest release
   that pins it, and each landing copy to `/<url_prefix>/<release>/<module>/`.
   Nothing stays at the old paths.
3. `documentsConverted`: moves the page aliases, which Antora registers during
   the conversion, and stops the build if a moved page links to another
   component with a relative path instead of an xref.
4. `pagesComposed`: in the pages of a component version that several releases
   pin, makes the links that leave the component version, and the links to a
   release, go through the site root.
5. `beforePublish`: checks the result, and writes
   `/<url_prefix>/release-url-layout.json`. `split-search-index.js` reads it
   to map release URLs to the search index of their component version.
6. `sitePublished`: links `/<url_prefix>/<release>/<module>/<component>` to
   the oldest release for each component version that several releases pin.
   With the AsciiDoc attribute `build-environment: netlify`, it copies instead.

The extension never changes xrefs. A `latest@` xref still means the latest
version that is built.

## Rules

The build stops if:

- The configuration has an unknown key or a value of the wrong type.
- A release pins a component version that is not in the site, or pins a
  prerelease without `prerelease: true`.
- The URL prefix is the name of a component, or two products share a
  component or a URL prefix.
- The playbook does not use the default URL layout
  (`urls.html_extension_style: default`, no `urls.latest_version_segment*`),
  or does not publish to the file system.
- The Antora version is not 3.1 or 3.2.
- A file to move does not have the expected output path and URL, or is in the
  ROOT module.
- Two files would have the same output path, or a file that does not move is
  under the URL prefix.
- A landing page is in a folder with the name of a product component.
- A moved page links to another component with a relative path.

Every move is planned and checked before any file changes.

## Tests

```bash
node --test extensions/release-url-layout/*.test.cjs
```

The fixture tests use the content classifier of Antora from the
`node_modules` of the playbook repository, and skip without it.
