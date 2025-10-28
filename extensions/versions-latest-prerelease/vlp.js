'use strict'
const semver = require('semver')
const path = require('path')
const fs = require('fs')

const debug = true

function dprint(...args) {
  if (debug) {
    console.log('[vlp.js]', ...args)
  }
}

function createSymlink(target, symlinkPath) {
  if (fs.existsSync(symlinkPath)) {
    if (!fs.lstatSync(symlinkPath).isDirectory()) {
      fs.unlinkSync(symlinkPath);
    } else {
      // If it's a directory, do not touch it
      return;
    }
  }
  fs.symlinkSync(target, symlinkPath);
}

module.exports.register = function () {
  let globalOutputDir = null;

  // Capture the global output directory from the playbook
  this.once('playbookBuilt', ({ playbook }) => {
    if (playbook.output && playbook.output.dir) {
      globalOutputDir = playbook.output.dir;
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

      // Construct the full realpath for the output file
      const versionLD_File = path.resolve(
        globalOutputDir, component.name, 'latest_dev.txt');
      const dirName = path.dirname(versionLD_File);

      let fileContent = component.name + '\n';
      if (latestStableObj) {
        console.log(component.name, ` : latest : ${latestStableObj.version}`);
        fileContent += `latest: ${latestStableObj.version}\n`;
      }
      if (latestPrereleaseObj) {
        console.log(component.name, `: dev : ${latestPrereleaseObj.version}`);
        fileContent += `dev: ${latestPrereleaseObj.version}\n`;
      }

      let debug_message = component.name + '/' +
        path.basename(versionLD_File) +
        ' will contain\n--------\n' + fileContent + '--------';
      dprint(debug_message);

      // Ensure the directory exists before writing and link creation
      try {
        fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(versionLD_File, fileContent, 'utf8');

        // Create symlink for latest
        if (latestStableObj) {
          try {
            createSymlink(latestStableObj.version,
              path.join(dirName, 'latest'));
          } catch (err) {
            console.error(`Failed to create symlink 'latest' in ${dirName}:`,
              err);
          }
        }

        // Create symlink for dev
        if (latestPrereleaseObj) {
          try {
            createSymlink(latestPrereleaseObj.version,
              path.join(dirName, 'dev'));
          } catch (err) {
            console.error(`Failed to create symlink 'dev' in ${dirName}:`,
              err);
          }
        }
      } catch (err) {
        console.error(`Failed to write or symlink in ${dirName}:`, err);
      }
    });
  });
}
