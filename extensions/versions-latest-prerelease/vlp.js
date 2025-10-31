'use strict'
// remember to have 'semver' in package.json
const semver = require('semver')
const path = require('path')
const fs = require('fs')

const debug = process.env.VLP_DEBUG === 'true';

/**
 * Prints debug messages if debugging is enabled.
 * @param {...any} args - Arguments to print.
 */
function dprint(...args) {
  if (debug) {
    console.log('[vlp.js]', ...args)
  }
}

/**
 * Creates a symlink at symlinkPath pointing to target.
 * If symlinkPath exists and is not a directory, it is removed first.
 * @param {string} targetPath - The target path for the symlink.
 * @param {string} symlinkPath - The path where the symlink will be created.
 */
function createSymlink(targetPath, symlinkPath) {
  if (fs.existsSync(symlinkPath)) {
    if (!fs.lstatSync(symlinkPath).isDirectory()) {
      fs.unlinkSync(symlinkPath);
    } else {
      // If it's a directory, do not touch it
      dprint('Not writing', symlinkPath, 'because it is a directory');
      return;
    }
  }
  fs.symlinkSync(targetPath, symlinkPath);
}

/**
 * Checks if the target path is within the base directory.
 * Prevents directory traversal vulnerabilities.
 * @param {string} base - The base directory.
 * @param {string} target - The target path to check.
 * @returns {boolean} True if safe, false otherwise.
 */
function isSafePath(base, target) {
  const relative = path.relative(base, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Global state
let outputDir = null;
const latestVersionsList = [];

const LATEST_SYMLINK = 'latest';
const DEV_SYMLINK = 'dev';
const LATEST_DEV_FILE = 'latest_dev.txt';

/**
 * Writes the latest_dev.txt file for a component.
 * @param {string} dir - Directory path.
 * @param {string} content - File content.
 */
function writeLatestDevFile(dir, content) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LATEST_DEV_FILE), content, 'utf8');
  } catch (err) {
    console.error(`Failed to write ${LATEST_DEV_FILE} in ${dir}:`, err);
  }
}

/**
 * Antora extension entry point.
 * Registers event handlers for playbookBuilt, contentClassified, and sitePublished.
 */
module.exports.register = function () {

  // Capture the output directory from the playbook
  this.once('playbookBuilt', ({ playbook }) => {
    if (playbook.output && playbook.output.dir) {
      outputDir = playbook.output.dir;
    }
  });

  this.once('contentClassified', ({ contentCatalog }) => {
    contentCatalog.getComponents().forEach((component) => {
      if (component.name === 'shared') return;

      const parsedVersions = component.versions.map(v => ({
        version: v.version,
        semver: semver.coerce(v.version),
        prerelease: v.prerelease
      })).filter(v => v.semver);

      parsedVersions.sort((a, b) => semver.rcompare(a.semver, b.semver));

      const latestStableObj = parsedVersions.find(
        v => v.prerelease === undefined);
      const latestPrereleaseObj = parsedVersions.find(
        v => v.prerelease !== undefined);

      // Store for later symlink creation
      latestVersionsList.push({
        componentName: component.name,
        latestStableObj,
        latestPrereleaseObj
      });

      // Write latest_dev.txt
      const dirName = path.resolve(outputDir, component.name);
      let fileContent = `${component.name}\n`;
      if (latestStableObj)
        fileContent += `latest: ${latestStableObj.version}\n`;
      if (latestPrereleaseObj)
        fileContent += `dev: ${latestPrereleaseObj.version}\n`;

      dprint(`In contentClassified:\n${component.name}/${LATEST_DEV_FILE} ` +
        `will contain\n--------\n${fileContent}--------`);
      writeLatestDevFile(dirName, fileContent);
    });
  });

  this.once('sitePublished', () => {
    latestVersionsList.forEach(({ componentName,
      latestStableObj,
      latestPrereleaseObj }) => {
      const dirName = path.resolve(outputDir, componentName);
      [
        { obj: latestStableObj, linkName: LATEST_SYMLINK },
        { obj: latestPrereleaseObj, linkName: DEV_SYMLINK }
      ].forEach(({ obj, linkName }) => {
        if (obj) {
          try {
            dprint(
              'In sitePublished, for',
              componentName,
              'going to create symlink',
              linkName,
              'to',
              obj.version
            );
            const symlinkPath = path.join(dirName, linkName);
            const targetPath = path.relative(dirName,
              path.join(dirName,
                obj.version));
            if (isSafePath(outputDir, symlinkPath)) {
              createSymlink(targetPath, symlinkPath);
            }
          } catch (err) {
            console.error(
              `Failed to create symlink '${linkName}' in ${dirName}:`, err);
          }
        }
      });
    });
  });

}
