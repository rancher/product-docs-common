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

// Requires 'semver' in package.json for version parsing
const semver = require("semver");
const path = require("node:path");
const fs = require("node:fs");

// Enable debug output if VLP_DEBUG environment variable is set
const debug = process.env.VLP_DEBUG === "true";

// Output directory and version info for symlink/file creation
let outputDir = null;
const componentVersions = [];
let startPageVersionStr = null;
let startPageComponentName = null;


// Symlink and file names used for version pointers
const LATEST_SYMLINK = "latest";
const DEV_SYMLINK = "dev";
const LATEST_DEV_FILE = "latest_dev.txt";

// Utility: Get component output directory
function getComponentDir(outputDir, componentName) {
  return componentName === 'ROOT'
    ? path.resolve(outputDir)
    : path.resolve(outputDir, componentName);
}

// Utility: Get path to latest_dev.txt for a component
function getLatestDevFilePath(outputDir, componentName) {
  return path.join(getComponentDir(outputDir, componentName), LATEST_DEV_FILE);
}

// Utility: Get symlink/copy path for a component and link name
function getSymlinkOrCopyPath(outputDir, componentName, linkName) {
  return path.join(getComponentDir(outputDir, componentName), linkName);
}

// Print debug messages if enabled, using dynamic filename label.
const debugLabel = `[${require("node:path").basename(__filename)}]`;
function dprint(...args) {
  if (debug) {
    console.log(debugLabel, ...args);
  }
}

/*
 * Creates a symlink at symlinkPath pointing to targetPath, avoiding
 * directories. If symlinkPath exists and is not a directory, it is replaced.
 * @param {string} targetPath - The target path for the symlink. @param
 * {string} symlinkPath - The path where the symlink will be created.
 */

function createSymlinkOrCopy(targetPath, symlinkOrCopyPath, buildEnvironment) {
  if (fs.existsSync(symlinkOrCopyPath)) {
    if (fs.lstatSync(symlinkOrCopyPath).isDirectory()) {
      // If it's a directory, do not touch it
      dprint("Not writing", symlinkOrCopyPath, "because it is a directory");
      return;
    }
    fs.unlinkSync(symlinkOrCopyPath);
  }
  if (buildEnvironment === "netlify") {
    dprint("Build environment is Netlify, performing recursive copy.");
    const srcPath = path.resolve(path.dirname(symlinkOrCopyPath), targetPath);
    fs.cpSync(srcPath, symlinkOrCopyPath, { recursive: true });
    return;
  }
  dprint("Standard build environment, creating symlink.");
  fs.symlinkSync(targetPath, symlinkOrCopyPath);
}

/**
 * Checks if the target path is safe (not outside base and not absolute).
 * @param {string} base - The base directory.
 * @param {string} target - The target path to check.
 * @returns {boolean} True if safe, false otherwise.
 */
function isSafePath(base, target) {
  const relative = path.relative(base, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Rewrites xref links in AsciiDoc text to point to actual latest/dev versions.
 * @param {string} fileText - The file contents as text.
 * @param {object} file - The file object from Antora content catalog.
 * @param {Array} componentVersions - Array of component version info.
 * @returns {string} The modified file text.
 */
function modifyXrefsInText(fileText, file, componentVersions) {
  const regex = new RegExp(
    `xref:(${LATEST_SYMLINK}|${DEV_SYMLINK})@([^:]+):([^[]+)`,
    "g",
  );
  let xrefsModified = 0;
  const newFileText = fileText.replace(
    regex,
    (originalXref, versionType, targetComponent, targetFile) => {
      dprint(
        `[XREF REGEX MATCH] Full match: '${originalXref}' | ` +
          `Group 1 (version): '${versionType}' | ` +
          `Group 2 (component): '${targetComponent}' | ` +
          `Group 3 (file): '${targetFile}' | ` +
          `File: ${file.src?.path}`,
      );
      dprint(
        `[MODIFIABLE XREF FOUND] Version: ${versionType}, Target Component: ` +
          `${targetComponent}, Target File: ${targetFile}, ` +
          `File: ${file.src?.path}`,
      );
      // Look up the correct version from componentVersions
      const compEntry = componentVersions.find(
        (e) => e.componentName === targetComponent,
      );
      let actualVersion = null;
      if (compEntry) {
        if (versionType === LATEST_SYMLINK && compEntry.latestStableObj) {
          actualVersion = compEntry.latestStableObj.version;
        } else if (
          versionType === DEV_SYMLINK &&
          compEntry.latestPrereleaseObj
        ) {
          actualVersion = compEntry.latestPrereleaseObj.version;
        }
      }
      if (actualVersion) {
        const newXref =
          `xref:${actualVersion}` + `@${targetComponent}:${targetFile}`;
        dprint(`[XREF MODIFIED] ${newXref}`);
        // Find the line containing the original xref
        const lines = fileText.split(/\r?\n/);
        const modifiedLine = lines.find((line) => line.includes(originalXref));
        if (modifiedLine) {
          dprint(`[MODIFIED LINE] ${modifiedLine}`);
        }
        xrefsModified++;
        return newXref;
      } else {
        dprint(
          `[XREF MODIFIED] No replacement version found for ${versionType} ` +
            `in component ${targetComponent}`,
        );
        return originalXref;
      }
    },
  );
  // Print summary if any xrefs were modified
  if (xrefsModified > 0) {
    const compName = file.component?.name || file.src?.component || "unknown";
    console.log(
      `${debugLabel} Modified ${xrefsModified} xref(s) in file: ` +
      `${file.src?.path} (component: ${compName})`,
    );
  }
  return newFileText;
}

/**
 * Writes the latest_dev.txt file for a component with version info.
 * @param {string} dir - Directory to write the file in.
 * @param {string} content - Content to write to the file.
 */
function writeLatestDevFile(dir, content) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LATEST_DEV_FILE), content, "utf8");
  } catch (err) {
    console.error(`Failed to write ${LATEST_DEV_FILE} in ${dir}:`, err);
    return;
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
        startPageVersionStr = versionMatch[1];
        dprint("Version from playbook.site.startPage is", startPageVersionStr);
      }
      // The component is the part between '@' and ':' in startPage
      const compMatch = startPage.match(/^[\w.-]+@([\w.-]+):/);
      if (compMatch) {
        startPageComponentName = compMatch[1];
        dprint(
          "Component from playbook.site.startPage is",
          startPageComponentName,
        );
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

      if (!parsedVersions.length) return;

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
      componentVersions.push({
        componentName: component.name,
        latestStableObj,
        latestPrereleaseObj,
      });

      // Write latest_dev.txt file with latest version info
      const dirName = getComponentDir(outputDir, component.name);
      let fileContent = `${component.name}\n`;
      if (latestStableObj)
        fileContent += `latest: ${latestStableObj.version}\n`;
      if (latestPrereleaseObj)
        fileContent += `dev: ${latestPrereleaseObj.version}\n`;

      dprint(
        `In contentClassified:\n${component.name}/${LATEST_DEV_FILE} ` +
          `will contain\n--------\n${fileContent}--------`,
      );
      writeLatestDevFile(dirName, fileContent);
    });

    contentCatalog.findBy({ mediaType: "text/asciidoc" }).forEach((file) => {
      dprint("Entered contentClassified file processing loop");
      try {
        const basename = file.src?.basename;
        const compName = file.component?.name || file.src?.component;
        const filename = file.src?.path;

        // Early return for files that are nav.adoc, in the shared component, or have no filename
        if (!filename || basename === "nav.adoc" || compName === "shared") return;

        dprint(`[PROCESSING FILE] Component: ${compName}, File: ${filename}`);

        // Output component name and version from file.src if available
        if (file.src?.component && file.src?.version) {
          dprint(
            `[SRC COMPONENT INFO] Component: ${file.src.component}, ` +
              `Version: ${file.src.version}, File: ${file.src.path}`,
          );
        }

        // Scan file for 'xref:latest@' or 'xref:dev@' and modify them
        const fileText = file.contents?.toString();
        if (!fileText) return;
        dprint(
          `[SCANNING FILE] Scanning for xref:(latest|dev)@ in ` +
            `component: ${compName}, file: ${file.src?.path}`,
        );
        const newFileText = modifyXrefsInText(
          fileText,
          file,
          componentVersions,
        );
        file.contents = Buffer.from(newFileText);
      } catch (err) {
        console.error(`[vlp.js] Error processing file: ${file.src?.path}`, err);
        return;
      }
    });
  });

  this.once("sitePublished", ({ playbook }) => {
    const buildEnvironment = playbook.asciidoc?.attributes?.['build-environment'];
    dprint("build-environment attribute:", buildEnvironment);

    // Create symlinks for each component after site is published
    componentVersions.forEach(
      ({ componentName, latestStableObj, latestPrereleaseObj }) => {
        const dirName = getComponentDir(outputDir, componentName);
        dprint(
          "In sitePublished, processing component",
          componentName,
          "in directory",
          dirName,
          "for outputDir", outputDir
        );
        // For both stable and prerelease, create symlinks if or copy
        // version exists
        [
          { versionObj: latestStableObj, linkName: LATEST_SYMLINK },
          { versionObj: latestPrereleaseObj, linkName: DEV_SYMLINK },
        ].forEach(({ versionObj, linkName }) => {
          if (versionObj) {
            try {
              dprint(
                "In sitePublished, for",
                componentName,
                "going to create symlink or copy",
                linkName,
                "to",
                versionObj.version,
              );
              // Symlink points to the version directory
              const symlinkOrCopyPath = getSymlinkOrCopyPath(outputDir, componentName, linkName);
              const targetPath = path.relative(
                dirName,
                path.join(dirName, versionObj.version),
              );
              // Only create symlink or copy if path is safe
              if (isSafePath(outputDir, symlinkOrCopyPath)) {
                createSymlinkOrCopy(targetPath, symlinkOrCopyPath, buildEnvironment);
              }
            } catch (err) {
              console.error(
                `Failed to create symlink or copy '${linkName}' in ${dirName}:`,
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
      if (startPageComponentName && startPageVersionStr) {
        // Build the path to the 'latest' directory/symlink for the
        // component. If startPageComponentName is 'ROOT',
        // only use outputDir and 'latest'.
        const latestPath = startPageComponentName === 'ROOT'
          ? path.join(outputDir, 'latest')
          : path.join(outputDir, startPageComponentName, 'latest');
        dprint("Checking for existence of", latestPath);
        // Proceed only if 'latest' exists
        if (fs.existsSync(latestPath)) {
          // Backup index.html before modifying
          const backupPath = path.join(outputDir, "index.html.bkp");
          fs.copyFileSync(indexPath, backupPath);
          dprint(`Backed up index.html to ${backupPath}`);
          if (startPageComponentName === 'ROOT') {
            dprint(
              `Updating index.html: Replacing occurrences of ${startPageVersionStr}/ with latest/ (ROOT case)`
            );
            // Replace all occurrences of the version string followed by a slash, after =, ", >, or whitespace
            const versionPattern = new RegExp(`([=\"'\s>])${startPageVersionStr}/`, "g");
            indexContent = indexContent.replace(versionPattern, `$1latest/`);
          } else {
            dprint(
              `Updating index.html: ` +
                `Replacing /${startPageComponentName}/${startPageVersionStr}/ ` +
                `with /${startPageComponentName}/latest/`,
            );
            // Build a regex to match URLs containing the version for this component and replace with 'latest'.
            const versionPattern = new RegExp(
              `(${startPageComponentName})/${startPageVersionStr}(/|\\b)`,
              "g",
            );
            // Perform the replacement in index.html content
            indexContent = indexContent.replace(versionPattern, "$1/latest$2");
          }
        } else {
          // If 'latest' does not exist, skip the replacement
          dprint(`Skipping index.html update: '${latestPath}' does not exist.`);
        }
      }
      fs.writeFileSync(indexPath, indexContent, "utf8");
      dprint("Updated index.html content:", indexContent);
    }
  });
};
