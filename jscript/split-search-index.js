// Usage: node split-search-index.js <input-index.js> <output-dir>
// Splits the monolithic Lunrjs index into per-component, per-version,
// per-language files.

const fs = require('fs');
const path = require('path');

const TARGET_LANGS = ['en', 'es', 'de', 'fr', 'pt', 'ja', 'ko', 'zh'];
const SUPPORTED_LANG_SET = new Set(TARGET_LANGS);
const SOURCE_INDEX_BASENAME = 'search-index-source.js';

function parseSearchData(buffer) {
  const match = buffer.match(/antoraSearch\.initSearch\(lunr,\s*(\{[\s\S]*\})\s*\);?/);
  if (!match) {
    throw new Error('Could not find searchData object in file (expected antoraSearch.initSearch(lunr, ...))');
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    const relaxed = match[1].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    return JSON.parse(relaxed);
  }
}

function parseDocMeta(doc) {
  const urlMatch = typeof doc.url === 'string'
    ? doc.url.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\//)
    : null;
  const component = doc.component || (urlMatch ? urlMatch[1] : undefined);
  const version = doc.version || (urlMatch ? urlMatch[2] : undefined);
  const lang = doc.lang || (urlMatch ? urlMatch[3] : undefined);
  return { component, version, lang };
}

function extractRefBase(ref) {
  return String(ref).split('-')[0];
}

function filterFieldVectors(fieldVectors, keepDocIds) {
  return fieldVectors.filter(([key]) => {
    const keyStr = String(key);
    const slashAt = keyStr.indexOf('/');
    const ref = slashAt === -1 ? keyStr : keyStr.slice(slashAt + 1);
    return keepDocIds.has(extractRefBase(ref));
  });
}

function filterInvertedIndex(invertedIndex, keepDocIds, allFields) {
  const filtered = [];
  for (const [token, posting] of invertedIndex) {
    if (!posting || typeof posting !== 'object') continue;

    const newPosting = {};
    if (Object.hasOwn(posting, '_index')) {
      newPosting._index = posting._index;
    }

    let hasAnyRefs = false;
    for (const field of allFields) {
      const refs = posting[field];
      const keptRefs = {};

      if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
        for (const [ref, meta] of Object.entries(refs)) {
          if (keepDocIds.has(extractRefBase(ref))) {
            keptRefs[ref] = meta;
            hasAnyRefs = true;
          }
        }
      }

      // Lunr expects each posting to contain every indexed field key.
      newPosting[field] = keptRefs;
    }

    if (hasAnyRefs) {
      filtered.push([token, newPosting]);
    }
  }
  return filtered;
}

function ensurePayloadBuffer(inputFile, outputDir, initialBuffer) {
  if (/antoraSearch\.initSearch\(lunr,\s*\{/.test(initialBuffer)) {
    return initialBuffer;
  }

  const fallbackFile = path.join(outputDir, SOURCE_INDEX_BASENAME);
  if (fs.existsSync(fallbackFile)) {
    return fs.readFileSync(fallbackFile, 'utf8');
  }

  throw new Error(
    `Input file ${path.basename(inputFile)} does not contain an Antora search payload and no fallback payload was found at ${fallbackFile}`
  );
}

function buildOutputGroups(allDocs) {
  const groups = {};

  for (const [docId, doc] of Object.entries(allDocs)) {
    const { component, version, lang } = parseDocMeta(doc);
    if (!component || !version || !SUPPORTED_LANG_SET.has(lang)) continue;

    const langGroup = getOrCreateLangGroup(groups, component, version, lang);
    langGroup.documents[docId] = doc;
    langGroup.docIds.add(docId);
    langGroup.componentVersionKeys.add(`${component}/${version}`);
  }

  return groups;
}

function getOrCreateLangGroup(groups, component, version, lang) {
  if (!groups[component]) groups[component] = {};
  if (!groups[component][version]) groups[component][version] = {};
  if (!groups[component][version][lang]) {
    groups[component][version][lang] = {
      documents: {},
      docIds: new Set(),
      componentVersionKeys: new Set(),
    };
  }
  return groups[component][version][lang];
}

function buildFilteredPayload(index, store, group) {
  const keepDocs = group.documents;
  const keepDocIds = group.docIds;
  const keepComponentVersionKeys = group.componentVersionKeys;
  const fieldVectors = index.fieldVectors || [];
  const invertedIndex = index.invertedIndex || [];
  const fields = index.fields || [];
  const componentVersions = store.componentVersions || {};

  const filteredIndex = {
    ...index,
    fieldVectors: filterFieldVectors(fieldVectors, keepDocIds),
    invertedIndex: filterInvertedIndex(invertedIndex, keepDocIds, fields),
  };

  const filteredStore = {
    ...store,
    documents: keepDocs,
    componentVersions: Object.fromEntries(
      Object.entries(componentVersions).filter(([key]) => keepComponentVersionKeys.has(key))
    ),
  };

  return { index: filteredIndex, store: filteredStore };
}

function writeLanguageIndexes(outputDir, groups, index, store) {
  for (const [component, versions] of Object.entries(groups)) {
    const componentDir = path.join(outputDir, component);
    fs.mkdirSync(componentDir, { recursive: true });

    for (const [version, langs] of Object.entries(versions)) {
      const versionDir = path.join(componentDir, version);
      fs.mkdirSync(versionDir, { recursive: true });

      for (const [lang, group] of Object.entries(langs)) {
        const payload = buildFilteredPayload(index, store, group);
        const out = `antoraSearch.initSearch(lunr, ${JSON.stringify(payload)});\n`;
        const outFile = path.join(versionDir, `search-index-${lang}.js`);
        fs.writeFileSync(outFile, out);
        console.log(`Wrote ${component}/${version}/search-index-${lang}.js (docs: ${Object.keys(group.documents).length})`);
      }
    }
  }
}

function buildVersionMap(groups) {
  const versionMap = {};
  for (const [component, versions] of Object.entries(groups)) {
    versionMap[component] = sortVersions(Object.keys(versions));
  }
  return versionMap;
}

// Sort versions with latest-tagged first, then descending numeric order, then specials.
function sortVersions(versions) {
  return [...versions].sort((a, b) => {
    const rank = (v) => {
      if (v === 'latest') return 0;
      if (v.endsWith('-latest')) return 1;
      if (v === 'next') return 2;
      if (v === 'dev') return 3;
      return 4;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Both same category: compare numeric parts descending.
    const parse = (v) => v.replace(/^v/, '').replace(/-.*$/, '').split('.').map(Number);
    const ap = parse(a), bp = parse(b);
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      const diff = (bp[i] || 0) - (ap[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

function buildAvailabilityMap(groups) {
  const availability = {};

  for (const [component, versions] of Object.entries(groups)) {
    const byLang = {};
    for (const lang of TARGET_LANGS) byLang[lang] = [];

    for (const [version, langs] of Object.entries(versions)) {
      for (const lang of Object.keys(langs)) {
        byLang[lang].push(version);
      }
    }

    for (const lang of Object.keys(byLang)) {
      byLang[lang] = sortVersions(byLang[lang]);
    }

    availability[component] = byLang;
  }

  return availability;
}

function buildRootLoader(targetLangs, versionMap, availabilityMap) {
  const langArray = JSON.stringify(targetLangs);
  const versionMapJson = JSON.stringify(versionMap);
  const availabilityMapJson = JSON.stringify(availabilityMap);
  return `// Auto-generated by split-search-index.js
(function () {
  var supported = new Set(${langArray});
  var versionMap = ${versionMapJson};
  var availabilityMap = ${availabilityMapJson};
  var scriptUrl = (document.currentScript && document.currentScript.src) || '/search-index.js';
  var pathname = window.location.pathname || '';
  var match = pathname.match(/^\\/([^/]+)\\/([^/]+)\\/([^/]+)\\//);
  var component = match && match[1];
  var version = match && match[2];
  var lang = (match && match[3]) || 'en';

  if (!component || !version) return;
  if (!supported.has(lang)) lang = 'en';

  function getVersionCandidates(componentName, versionName, langCode) {
    var candidates = [];
    var seen = Object.create(null);

    function pushUnique(v) {
      if (!v || seen[v]) return;
      seen[v] = true;
      candidates.push(v);
    }

    var availableByLang = (((availabilityMap[componentName] || {})[langCode]) || []);

    if (availableByLang.length) {
      if (availableByLang.indexOf(versionName) !== -1) pushUnique(versionName);

      var preferred = versionMap[componentName] || [];
      for (var i = 0; i < preferred.length; i++) {
        if (availableByLang.indexOf(preferred[i]) !== -1) pushUnique(preferred[i]);
      }

      for (var j = 0; j < availableByLang.length; j++) {
        pushUnique(availableByLang[j]);
      }

      return candidates;
    }

    // Fallback to optimistic behavior if availability metadata is missing.
    pushUnique(versionName);
    var versions = versionMap[componentName] || [];
    for (var k = 0; k < versions.length; k++) {
      pushUnique(versions[k]);
    }
    return candidates;
  }

  function inject(componentName, versionName, langCode) {
    var candidates = getVersionCandidates(componentName, versionName, langCode);

    if (!candidates.length) {
      if (langCode !== 'en') inject(componentName, versionName, 'en');
      return;
    }

    function injectAt(index) {
      if (index >= candidates.length) {
        if (langCode !== 'en') inject(componentName, versionName, 'en');
        return;
      }

      var encodedComponent = encodeURIComponent(componentName);
      var encodedVersion = encodeURIComponent(candidates[index]);
      var url = new URL('lang-indexes/' + encodedComponent + '/' + encodedVersion + '/search-index-' + langCode + '.js', scriptUrl).toString();
      var s = document.createElement('script');
      s.async = true;
      s.src = url;
      s.onerror = function () {
        injectAt(index + 1);
      };
      document.head.appendChild(s);
    }

    injectAt(0);
  }

  inject(component, version, lang);
})();
`;
}

async function main() {
  const [, , inputFile, outputDir] = process.argv;
  if (!inputFile || !outputDir) {
    console.error('Usage: node split-search-index.js <input-index.js> <output-dir>');
    process.exit(1);
  }

  let initialBuffer;
  try {
    initialBuffer = await fs.promises.readFile(inputFile, 'utf8');
  } catch (err) {
    console.error('Failed to read input file:', err.message || err);
    process.exit(1);
  }

  let payloadBuffer;
  let searchData;
  try {
    payloadBuffer = ensurePayloadBuffer(inputFile, outputDir, initialBuffer);
    searchData = parseSearchData(payloadBuffer);
  } catch (err) {
    console.error('Failed to parse searchData object:', err.message || err);
    process.exit(1);
  }

  const { index, store } = searchData;
  const allDocs = store.documents || {};
  const groups = buildOutputGroups(allDocs);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, SOURCE_INDEX_BASENAME), payloadBuffer);

  writeLanguageIndexes(outputDir, groups, index, store);

  // Keep the HTML <script src=".../search-index.js"> references unchanged.
  // The root file becomes a tiny loader that picks the right component/version/language index file.
  const versionMap = buildVersionMap(groups);
  const availabilityMap = buildAvailabilityMap(groups);
  fs.writeFileSync(inputFile, buildRootLoader(TARGET_LANGS, versionMap, availabilityMap));
  console.log(`Replaced ${path.basename(inputFile)} with language loader`);
}

main().catch((err) => {
  console.error('Unhandled error:', err && err.message ? err.message : err);
  process.exit(1);
});
