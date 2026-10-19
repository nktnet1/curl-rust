#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const branch = "fork";
const remote = "origin";
const crateManifest = join(root, "curl-sys", "Cargo.toml");
const workspaceManifest = join(root, "Cargo.toml");
const versionPattern =
	/^(\d+)\.(\d+)\.(\d+)-nktnet\.(\d+)\+curl-(\d+)\.(\d+)\.(\d+)$/;

function git(...args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout.trim();
}

function section(text, name) {
	const headers = [...text.matchAll(/^\[([^\]\r\n]+)\][ \t]*\r?$/gm)];
	const matches = headers.filter((header) => header[1] === name);
	if (matches.length !== 1) {
		throw new Error(`Expected exactly one [${name}] section`);
	}
	const header = matches[0];
	const start = header.index + header[0].length + 1;
	const following = headers.find((entry) => entry.index > header.index);
	return { body: text.slice(start, following?.index ?? text.length), start };
}

function packageField(text, field) {
	const { body, start } = section(text, "package");
	const pattern = new RegExp(
		`^([ \\t]*${field}[ \\t]*=[ \\t]*")([^"\\r\\n]+)("[ \\t]*\\r?)$`,
		"gm",
	);
	const matches = [...body.matchAll(pattern)];
	if (matches.length !== 1) {
		throw new Error(`Expected exactly one package.${field} field`);
	}
	const match = matches[0];
	return { value: match[2], start: start + match.index + match[1].length };
}

function dependencyVersion(text) {
	const { body, start } = section(text, "dependencies");
	const entries = [
		...body.matchAll(
			/^([ \t]*curl-sys[ \t]*=[ \t]*\{)([^\r\n]*)(\}[ \t]*\r?)$/gm,
		),
	];
	if (entries.length !== 1) {
		throw new Error(
			"Expected exactly one inline curl-sys dependency in [dependencies]",
		);
	}
	const entry = entries[0];
	const attributes = entry[2];
	if (
		!/\bpackage\s*=\s*"nktnet-curl-sys"/.test(attributes) ||
		!/\bpath\s*=\s*"curl-sys"/.test(attributes)
	) {
		throw new Error(
			"The curl-sys dependency must point to the local nktnet-curl-sys crate",
		);
	}
	const versions = [...attributes.matchAll(/(\bversion\s*=\s*")([^"]+)(")/g)];
	if (versions.length !== 1) {
		throw new Error("Expected exactly one version pin for curl-sys");
	}
	const match = versions[0];
	return {
		value: match[2],
		start:
			start + entry.index + entry[1].length + match.index + match[1].length,
	};
}

function isNewerVersion(target, current) {
	for (let index = 0; index < 4; index += 1) {
		if (target[index] > current[index]) return true;
		if (target[index] < current[index]) return false;
	}
	return false;
}

function parseVersion(version) {
	const match = versionPattern.exec(version);
	const components = match?.slice(1).map(Number);
	if (
		!match ||
		components.some(
			(number, index) =>
				!Number.isSafeInteger(number) || String(number) !== match[index + 1],
		)
	) {
		throw new Error(`Invalid crate version: ${version}`);
	}
	return components;
}

function tagFor(version) {
	return `curl-sys-v${version.split("+")[0]}`;
}

function replaceValue(text, field, value) {
	return (
		text.slice(0, field.start) +
		value +
		text.slice(field.start + field.value.length)
	);
}

function remoteRef(ref) {
	return git("ls-remote", remote, ref).split(/\s+/)[0] || "";
}

function pushRelease(tag) {
	git(
		"push",
		"--atomic",
		remote,
		`refs/heads/${branch}:refs/heads/${branch}`,
		`refs/tags/${tag}:refs/tags/${tag}`,
	);
}

function release() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log("Usage: node scripts/release.mjs [full-version] [--dry-run]");
		return;
	}
	const dryRun = args.includes("--dry-run");
	const versions = args.filter((arg) => arg !== "--dry-run");
	if (versions.length > 1 || versions.some((arg) => arg.startsWith("-"))) {
		throw new Error(
			"Usage: node scripts/release.mjs [full-version] [--dry-run]",
		);
	}

	const crateText = readFileSync(crateManifest, "utf8");
	const workspaceText = readFileSync(workspaceManifest, "utf8");
	if (packageField(crateText, "name").value !== "nktnet-curl-sys") {
		throw new Error("Unexpected crate name in curl-sys/Cargo.toml");
	}
	const crateVersion = packageField(crateText, "version");
	const current = parseVersion(crateVersion.value);
	const pin = dependencyVersion(workspaceText);
	if (pin.value !== `=${crateVersion.value.split("+")[0]}`) {
		throw new Error(
			`Root curl-sys pin ${pin.value} does not match ${crateVersion.value}`,
		);
	}
	if (git("branch", "--show-current") !== branch) {
		throw new Error(`Switch to the ${branch} branch before releasing`);
	}
	if (git("status", "--porcelain", "--untracked-files=all")) {
		throw new Error("Working tree must be clean before releasing");
	}

	const head = git("rev-parse", "HEAD");
	const remoteHead = remoteRef(`refs/heads/${branch}`);
	if (!remoteHead) {
		throw new Error(`Remote ${remote} has no ${branch} branch`);
	}

	// Resume a failed push without accidentally creating the next release.
	const previousTag = tagFor(crateVersion.value);
	if (
		git("tag", "--list", previousTag) &&
		!remoteRef(`refs/tags/${previousTag}`)
	) {
		const taggedHead = git("rev-parse", `${previousTag}^{commit}`);
		const parent = git("rev-parse", "HEAD^");
		if (
			taggedHead !== head ||
			git("log", "-1", "--format=%s") !== crateVersion.value ||
			(remoteHead !== head && remoteHead !== parent)
		) {
			throw new Error(
				`Local tag ${previousTag} has not been pushed; resolve it first`,
			);
		}
		console.log(`Retrying release ${styleText("cyan", crateVersion.value)}.`);
		if (!dryRun) {
			pushRelease(previousTag);
			console.log(
				`Pushed ${styleText("green", previousTag)}; GitHub Actions will publish.`,
			);
		}
		return;
	}

	if (remoteHead !== head) {
		throw new Error(
			`${branch} is not in sync with ${remote}/${branch}; pull or push first`,
		);
	}

	const next =
		versions[0] ??
		`${current[0]}.${current[1]}.${current[2]}-nktnet.${current[3] + 1}` +
			`+curl-${current.slice(4).join(".")}`;
	const target = parseVersion(next);
	if (!isNewerVersion(target, current)) {
		throw new Error(`Version ${next} must be newer than ${crateVersion.value}`);
	}
	const tag = tagFor(next);
	if (git("tag", "--list", tag) || remoteRef(`refs/tags/${tag}`)) {
		throw new Error(`Release tag ${tag} already exists`);
	}

	console.log(
		`Releasing ${styleText("cyan", next)} as ${styleText("cyan", tag)}.`,
	);
	if (dryRun) {
		console.log(
			`${styleText("yellow", "Dry run")}: no files, commits, or remote refs changed.`,
		);
		return;
	}

	writeFileSync(crateManifest, replaceValue(crateText, crateVersion, next));
	writeFileSync(
		workspaceManifest,
		replaceValue(workspaceText, pin, `=${next.split("+")[0]}`),
	);
	git("add", "--", "Cargo.toml", "curl-sys/Cargo.toml");
	git("commit", "-m", next);
	git("tag", tag);
	try {
		pushRelease(tag);
	} catch (error) {
		throw new Error(
			`${error.message}\nCommit and tag are local; rerun this script to retry the push.`,
		);
	}
	console.log(
		`Pushed ${styleText("green", tag)}; GitHub Actions will publish the crate`,
	);
	console.log(
		"and create a draft GitHub release using the Production environment.",
	);
}

try {
	release();
} catch (error) {
	console.error(`${styleText("red", "Error:")} ${error.message}`);
	process.exitCode = 1;
}
