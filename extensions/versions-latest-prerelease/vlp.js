// Antora extension for managing symlinks to latest and prerelease
// documentation versions
"use strict";
// Requires 'semver' in package.json for version parsing
const semver = require("semver");
const path = require("path");
const fs = require("fs");

// Enable debug output if VLP_DEBUG env var is set
const debug = process.env.VLP_DEBUG === "true";

/**
 * Prints debug messages if debugging is enabled.
 * @param {...any} args - Arguments to print.
 */
function dprint(...args) {
	if (debug) {
		console.log("[vlp.js]", ...args);
	}
}

/**
 * Creates a symlink at symlinkPath pointing to targetPath.
 * If symlinkPath exists and is not a directory, it is removed first.
 * Directories are never overwritten to avoid accidental data loss.
 */
function createSymlink(targetPath, symlinkPath) {
	if (fs.existsSync(symlinkPath)) {
		if (!fs.lstatSync(symlinkPath).isDirectory()) {
			fs.unlinkSync(symlinkPath);
		} else {
			// If it's a directory, do not touch it
			dprint("Not writing", symlinkPath, "because it is a directory");
			return;
		}
	}
	fs.symlinkSync(targetPath, symlinkPath);
}

/**
 * Ensures symlink targets are within the intended output directory.
 * Prevents directory traversal vulnerabilities.
 */
function isSafePath(base, target) {
  const relative = path.relative(base, target);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Output directory and version info for symlink/file creation
let outputDir = null;
const latestVersionsList = [];

// Symlink and file names used for version pointers
const LATEST_SYMLINK = "latest";
const DEV_SYMLINK = "dev";
const LATEST_DEV_FILE = "latest_dev.txt";

/**
 * Writes latest_dev.txt for a component, creating the directory if needed.
 */
function writeLatestDevFile(dir, content) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, LATEST_DEV_FILE), content, "utf8");
	} catch (err) {
		console.error(`Failed to write ${LATEST_DEV_FILE} in ${dir}:`, err);
	}
}

/**
 * Antora extension entry point.
 * Registers event handlers for playbookBuilt, contentClassified,
 * and sitePublished.
 *
 * - playbookBuilt: Captures output directory from playbook config
 * - contentClassified: Determines latest stable and prerelease versions
 *   for each component and writes latest_dev.txt files
 * - sitePublished: Creates symlinks ('latest', 'dev') for each component
 *   to their respective versions
 */

module.exports.register = function () {
	// Capture output directory for later symlink and file creation
	this.once("playbookBuilt", ({ playbook }) => {
		if (playbook.output?.dir) {
			outputDir = playbook.output.dir;
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
					`will contain\n--------\n${fileContent}--------`,
			);
			writeLatestDevFile(dirName, fileContent);
		});
	});

	this.once("sitePublished", () => {
		// Create symlinks for each component after site is published
		latestVersionsList.forEach(
			({ componentName, latestStableObj, latestPrereleaseObj }) => {
				const dirName = path.resolve(outputDir, componentName);
				// For both stable and prerelease, create symlinks if version exists
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
								obj.version,
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
	});
};
