// An Antora extension for managing symlinks to latest and prerelease
// documentation versions.

// This turned out to be necessary because the standard Antora mechanism for
// providing links to 'latest' and 'dev' versions did not work on our
// infrastructure. The standard mechanism, for Apache httpd used in our
// infrastructure, generated a `.htaccess` file with 302 redirects. This could
// not be made to work with our infrastructure. However, the Apache server can
// be configured to 'FollowSymlinks'. This extension puts those symlinks in
// place, in the build directory structure, after the Antora build.

// Additionally, this extension modifies 'xref:' links in AsciiDoc files that
// point to 'latest' or 'dev' versions to point to the actual latest stable or
// prerelease version numbers. This ensures that cross-references resolve
// correctly during the Antora build.

// Docs for the standard mechanism:
// https://docs.antora.org/antora/latest/playbook/configure-urls/

// Author: John Krug <john.krug@suse.com>
// See: https://docs.antora.org/antora/latest/playbook/configure-urls/

// Requires 'semver' in package.json for version parsing
const semver = require("semver");
const path = require("node:path");
const fs = require("node:fs");

// Enable debug output if VLP_DEBUG environment variable is set
const debug = process.env.VLP_DEBUG === "true";

// Output directory and version info for symlink/file creation
let outputDir = null;
const latestVersionsList = [];
let startPageVersion = null;
let startPageComponent = null;

// Symlink and file names used for version pointers
const LATEST_SYMLINK = "latest";
const DEV_SYMLINK = "dev";
const LATEST_DEV_FILE = "latest_dev.txt";

// Print debug messages if enabled, using dynamic filename label.
const debugLabel = `[${require("node:path").basename(__filename)}]`;
function dprint(...args) {
  if (debug) {
    console.log(
      debugLabel,
      ...args
    );
  }
}

// Create symlink, avoiding directories.
function createSymlink(targetPath, symlinkPath) {
  if (fs.existsSync(symlinkPath)) {
    if (!fs.lstatSync(symlinkPath).isDirectory()) {
      fs.unlinkSync(symlinkPath);
    } else {
      // If it's a directory, do not touch it
      dprint(
        "Not writing",
        symlinkPath,
        "because it is a directory"
      );
      return;
    }
  }
  fs.symlinkSync(targetPath, symlinkPath);
}

// Ensure symlink targets are safe.
function isSafePath(base, target) {
  const relative = path.relative(base, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Rewrite xrefs to be latest/dev versions.
function modifyXrefsInText(fileText, file, latestVersionsList) {
  const regex = new RegExp(
     `xref:(${LATEST_SYMLINK}|${DEV_SYMLINK})@([^:]+):([^[]+)`,
    "g",
  );
  let match = regex.exec(fileText);
  let newFileText = fileText;
  let xrefsModified = 0;
  while (match !== null) {
    dprint(
      `[XREF REGEX MATCH] Full match: '${match[0]}' | ` +
      `Group 1 (version): '${match[1]}' | ` +
      `Group 2 (component): '${match[2]}' | ` +
      `Group 3 (file): '${match[3]}' | ` +
      `File: ${file.src?.path}`
    );
    const versionType = match[1];
    const targetComponent = match[2];
    const targetFile = match[3];
    dprint(
      `[MODIFIABLE XREF FOUND] Version: ${versionType}, Target Component: ` +
      `${targetComponent}, Target File: ${targetFile}, File: ${file.src?.path}`
    );

    // Look up the correct version from latestVersionsList
    const compEntry = latestVersionsList.find(
      (e) => e.componentName === targetComponent,
    );
    let actualVersion = null;
    if (compEntry) {
      if (versionType === LATEST_SYMLINK && compEntry.latestStableObj) {
        actualVersion = compEntry.latestStableObj.version;
      } else if (versionType === DEV_SYMLINK && compEntry.latestPrereleaseObj) {
        actualVersion = compEntry.latestPrereleaseObj.version;
      }
    }
    if (actualVersion) {
      // Build the new xref with full filename
      const newXref = `xref:${actualVersion}@${targetComponent}:${targetFile}`;
      dprint(
        `[XREF MODIFIED] ${newXref}`
      );
      // Replace the original xref in newFileText
      const originalXref = match[0];
      // Find the line containing the original xref
      const lines = newFileText.split(/\r?\n/);
      const modifiedLine = lines.find((line) => line.includes(originalXref));
      if (modifiedLine) {
        dprint(
          `[MODIFIED LINE] ${modifiedLine}`
        );
      }
      newFileText = newFileText.replace(originalXref, newXref);
      xrefsModified++;
    } else {
      dprint(
        `[XREF MODIFIED] No replacement version found for ${versionType} ` +
        `in component ${targetComponent}`
      );
    }
    match = regex.exec(newFileText);
  }
  // Print summary if any xrefs were modified
  if (xrefsModified > 0) {
    console.log(
      `${debugLabel} Modified ${xrefsModified} xref(s) in ` +
      `file: ${file.src?.path}`
    );
  }
  return newFileText;
}

// Write latest_dev.txt for a component.
function writeLatestDevFile(dir, content) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LATEST_DEV_FILE), content, "utf8");
  } catch (err) {
    console.error(
      `Failed to write ${LATEST_DEV_FILE} in ${dir}:`,
      err
    );
  }
}

// Extension entry point: hooks into playbookBuilt, contentClassified,
// sitePublished.

module.exports.register = function () {
  // Capture output directory for later symlink and file creation
  this.once("playbookBuilt", ({ playbook }) => {
    dprint("Entered playbookBuilt event");
    if (playbook.output?.dir) {
      outputDir = playbook.output.dir;
    } else {
      // If output.dir is unset, use default 'build/site'
      outputDir = "build/site";
    }
    dprint("outputDir is", outputDir);
    // Extract version and component from playbook.site.startPage
    // (e.g. 1.29@admission-controller:en:introduction.adoc)
    if (playbook.site?.startPage) {
      dprint("playbook.site.startPage is", playbook.site.startPage);
      const startPage = playbook.site.startPage;
      // The version is the part before '@' in startPage
      const versionMatch = startPage.match(/^([\w.-]+)@/);
      if (versionMatch) {
        startPageVersion = versionMatch[1];
        dprint("Version from playbook.site.startPage is", startPageVersion);
      }
      // The component is the part between '@' and ':' in startPage
      const compMatch = startPage.match(/^[\w.-]+@([\w.-]+):/);
      if (compMatch) {
        startPageComponent = compMatch[1];
        dprint("Component from playbook.site.startPage is", startPageComponent);
      }
    }
  });

  this.once("contentClassified", ({ contentCatalog }) => {
    // For each component, determine latest stable and prerelease versions
    contentCatalog.getComponents().forEach((component) => {
      // Skip 'shared' component (not versioned)
      if (component.name === "shared") return;

      // Parse and coerce versions to semver objects
      const parsedVersions = component.versions
        .map((v) => ({
          version: v.version,
          semver: semver.coerce(v.version),
          prerelease: v.prerelease,
        }))
        .filter((v) => v.semver);

      // Sort versions in descending order (latest first)
      parsedVersions.sort((a, b) => semver.rcompare(a.semver, b.semver));

      // Find latest stable (no prerelease) and latest prerelease versions
      const latestStableObj = parsedVersions.find(
        (v) => v.prerelease === undefined,
      );
      const latestPrereleaseObj = parsedVersions.find(
        (v) => v.prerelease !== undefined,
      );

      // Store for later symlink creation in sitePublished
      latestVersionsList.push({
        componentName: component.name,
        latestStableObj,
        latestPrereleaseObj,
      });

      // Write latest_dev.txt file with latest version info
      const dirName = path.resolve(outputDir, component.name);
      let fileContent = `${component.name}\n`;
      if (latestStableObj)
        fileContent += `latest: ${latestStableObj.version}\n`;
      if (latestPrereleaseObj)
        fileContent += `dev: ${latestPrereleaseObj.version}\n`;

      dprint(
        `In contentClassified:\n${component.name}/${LATEST_DEV_FILE} ` +
        `will contain\n--------\n${fileContent}--------`
      );
      writeLatestDevFile(dirName, fileContent);
    });

    contentCatalog.findBy({ mediaType: "text/asciidoc" }).forEach((file) => {
      dprint("Entered contentClassified file processing loop");
      try {
        const basename = file.src?.basename;
        const compName = file.component?.name || file.src?.component;
        const filename = file.src?.path;

        // Skip files that are nav.adoc, in the shared component, or have no
        // filename
        if (!filename || basename === "nav.adoc" || compName === "shared") {
          return;
        }

        dprint(
          `[PROCESSING FILE] Component: ${compName}, File: ${filename}`
        );

        // Output component name and version from file.src if available
        if (file.src?.component && file.src?.version) {
          dprint(
            `[SRC COMPONENT INFO] Component: ${file.src.component}, ` +
            `Version: ${file.src.version}, File: ${file.src.path}`
          );
        }

        // Scan file for 'xref:latest@' or 'xref:dev@' and modify them
        const fileText = file.contents?.toString();
        if (fileText) {
          dprint(
            `[SCANNING FILE] Scanning for xref:(latest|dev)@ in ` +
            `component: ${compName}, file: ${file.src?.path}`
          );
          const newFileText = modifyXrefsInText(
            fileText,
            file,
            latestVersionsList,
          );
          file.contents = Buffer.from(newFileText);
        }
      } catch (err) {
        console.error(`[vlp.js] Error processing file: ${file.src?.path}`, err);
      }
    });
  });

  this.once("sitePublished", () => {
    // Create symlinks for each component after site is published
    latestVersionsList.forEach(
      ({ componentName, latestStableObj, latestPrereleaseObj }) => {
        const dirName = path.resolve(outputDir, componentName);
        // For both stable and prerelease, create symlinks if
        // version exists
        [
          { obj: latestStableObj, linkName: LATEST_SYMLINK },
          { obj: latestPrereleaseObj, linkName: DEV_SYMLINK },
        ].forEach(({ obj, linkName }) => {
          if (obj) {
            try {
              dprint(
                "In sitePublished, for",
                componentName,
                "going to create symlink",
                linkName,
                "to",
                obj.version
              );
              // Symlink points to the version directory
              const symlinkPath = path.join(dirName, linkName);
              const targetPath = path.relative(
                dirName,
                path.join(dirName, obj.version),
              );
              // Only create symlink if path is safe
              if (isSafePath(outputDir, symlinkPath)) {
                createSymlink(targetPath, symlinkPath);
              }
            } catch (err) {
              console.error(
                `Failed to create symlink '${linkName}' in ${dirName}:`,
                err,
              );
            }
          }
        });
      },
    );
    // Now adjust index.html, point at latest, not a specific version.
    dprint("Adjusting root index.html to point to latest versions");
    const indexPath = path.join(outputDir, "index.html");
    if (fs.existsSync(indexPath)) {
      let indexContent = fs.readFileSync(indexPath, "utf8");
      dprint("Original index.html content:", indexContent);
      if (startPageComponent && startPageVersion) {
        // Build the path to the 'latest' directory/symlink for the
        // component
        const latestPath = path.join(outputDir, startPageComponent, "latest");
        dprint("Checking for existence of", latestPath);
        // Proceed only if 'latest' exists
        if (fs.existsSync(latestPath)) {
          dprint(
            `Updating index.html: ` +
            `Replacing /${startPageComponent}/${startPageVersion}/ ` +
            `with /${startPageComponent}/latest/`
          );
          // Build a regex to match URLs containing the version
          // for this component
          // and replace with 'latest'.
          // Backup index.html before modifying
          const backupPath = path.join(outputDir, "index.html.bkp");
          fs.copyFileSync(indexPath, backupPath);
          dprint(
            `Backed up index.html to ${backupPath}`
          );
          const versionPattern = new RegExp(
            `(${startPageComponent})/${startPageVersion}(/|\b)`,
            "g",
          );
          // Perform the replacement in index.html content
          indexContent = indexContent.replace(versionPattern, "$1/latest$2");
        } else {
          // If 'latest' does not exist, skip the replacement
          dprint(
            `Skipping index.html update: '${latestPath}' does not exist.`
          );
        }
      }
      fs.writeFileSync(indexPath, indexContent, "utf8");
      dprint(
        "Updated index.html content:",
        indexContent
      );
    }
  });
};
