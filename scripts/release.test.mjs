import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const oldVersion = "0.4.91-nktnet.2+curl-8.22.0";
const nextVersion = "0.4.91-nktnet.3+curl-8.22.0";
let scratch;
let seed;
let counter = 0;

function command(executable, args, cwd) {
	const result = spawnSync(executable, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${executable} ${args.join(" ")}: ${result.stderr || result.error}`,
		);
	}
	return result.stdout.trim();
}

function git(cwd, ...args) {
	return command("git", args, cwd);
}

function runScript(repo, ...args) {
	return spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1" },
	});
}

function createFixture() {
	counter += 1;
	const remote = join(scratch, `remote-${counter}.git`);
	const repo = join(scratch, `repo-${counter}`);
	git(scratch, "clone", "--quiet", "--bare", seed, remote);
	git(scratch, "clone", "--quiet", "--branch", "fork", remote, repo);
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "Release Test");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "tag.gpgsign", "false");
	return { repo, remote };
}

function content(repo, path) {
	return readFileSync(join(repo, path), "utf8");
}

function assertUnchanged(repo) {
	assert.match(
		content(repo, "curl-sys/Cargo.toml"),
		/0\.4\.91-nktnet\.2\+curl-8\.22\.0/,
	);
	assert.match(content(repo, "Cargo.toml"), /=0\.4\.91-nktnet\.2/);
}

before(() => {
	scratch = mkdtempSync(join(tmpdir(), "nktnet-release-test-"));
	seed = join(scratch, "seed");
	mkdirSync(seed);
	git(seed, "init", "--quiet", "--initial-branch=fork");
	git(seed, "config", "user.email", "test@example.invalid");
	git(seed, "config", "user.name", "Release Test");
	mkdirSync(join(seed, "curl-sys"));
	mkdirSync(join(seed, "scripts"));
	for (const path of [
		"Cargo.toml",
		"curl-sys/Cargo.toml",
		"scripts/release.mjs",
	]) {
		copyFileSync(join(project, path), join(seed, path));
	}
	writeFileSync(join(seed, "README.md"), "Keep this text exactly as it is.\n");
	git(seed, "add", "--all");
	git(seed, "commit", "--quiet", "-m", "Initial fixture");
});

after(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("auto-increments and publishes the correct commit, branch, and tag", () => {
	const { repo, remote } = createFixture();
	const result = runScript(repo);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /GitHub Actions will publish/);
	assert.match(
		content(repo, "curl-sys/Cargo.toml"),
		new RegExp(nextVersion.replaceAll(".", "\\.").replace("+", "\\+")),
	);
	assert.match(content(repo, "Cargo.toml"), /=0\.4\.91-nktnet\.3/);
	assert.equal(
		content(repo, "README.md"),
		"Keep this text exactly as it is.\n",
	);
	assert.equal(git(repo, "log", "-1", "--format=%s"), nextVersion);
	assert.deepEqual(
		git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split(
			"\n",
		),
		["Cargo.toml", "curl-sys/Cargo.toml"],
	);
	const head = git(repo, "rev-parse", "HEAD");
	assert.equal(git(remote, "rev-parse", "refs/heads/fork"), head);
	assert.equal(
		git(remote, "rev-parse", "refs/tags/curl-sys-v0.4.91-nktnet.3"),
		head,
	);
});

test("releases subsequent versions without manual manifest edits", () => {
	const { repo, remote } = createFixture();
	assert.equal(runScript(repo).status, 0);
	const second = runScript(repo);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(
		git(repo, "log", "-1", "--format=%s"),
		"0.4.91-nktnet.4+curl-8.22.0",
	);
	assert.equal(git(repo, "tag", "--list").split("\n").length, 2);
	assert.equal(
		git(remote, "rev-parse", "refs/tags/curl-sys-v0.4.91-nktnet.4"),
		git(repo, "rev-parse", "HEAD"),
	);
});

test("accepts a full explicit version including curl metadata", () => {
	const { repo } = createFixture();
	const version = "0.4.92-nktnet.0+curl-8.23.0";
	const result = runScript(repo, version);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		content(repo, "curl-sys/Cargo.toml"),
		/0\.4\.92-nktnet\.0\+curl-8\.23\.0/,
	);
	assert.match(content(repo, "Cargo.toml"), /=0\.4\.92-nktnet\.0/);
	assert.equal(git(repo, "log", "-1", "--format=%s"), version);
	assert.equal(git(repo, "tag", "--list"), "curl-sys-v0.4.92-nktnet.0");
});

test("dry-run computes the next version without changes", () => {
	const { repo, remote } = createFixture();
	const before = git(repo, "rev-parse", "HEAD");
	const result = runScript(repo, "--dry-run");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /0\.4\.91-nktnet\.3\+curl-8\.22\.0/);
	assert.match(result.stdout, /Dry run/);
	assert.equal(git(repo, "rev-parse", "HEAD"), before);
	assert.equal(git(remote, "rev-parse", "refs/heads/fork"), before);
	assert.equal(git(repo, "tag", "--list"), "");
	assert.equal(git(repo, "status", "--porcelain"), "");
	assertUnchanged(repo);
});

test("refuses a dirty working tree", () => {
	const { repo } = createFixture();
	writeFileSync(join(repo, "README.md"), "Uncommitted changes\n");
	const result = runScript(repo);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Working tree must be clean/);
	assertUnchanged(repo);
	assert.equal(git(repo, "tag", "--list"), "");
});

test("refuses to release outside fork", () => {
	const { repo } = createFixture();
	git(repo, "switch", "--quiet", "-c", "development");
	const result = runScript(repo);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Switch to the fork branch/);
	assertUnchanged(repo);
});

test("refuses a mismatched dependency pin", () => {
	const { repo } = createFixture();
	const root = join(repo, "Cargo.toml");
	writeFileSync(
		root,
		readFileSync(root, "utf8").replace("=0.4.91-nktnet.2", "=0.4.91-nktnet.1"),
	);
	const result = runScript(repo);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not match/);
	assert.equal(git(repo, "tag", "--list"), "");
});

test("refuses an unsynchronized origin branch", () => {
	const { repo } = createFixture();
	writeFileSync(join(repo, "README.md"), "Local commit\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "--quiet", "-m", "Unpushed work");
	const result = runScript(repo);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not in sync/);
	assertUnchanged(repo);
});

test("refuses an existing remote release tag", () => {
	const { repo } = createFixture();
	git(repo, "tag", "curl-sys-v0.4.91-nktnet.3");
	git(repo, "push", "--quiet", "origin", "curl-sys-v0.4.91-nktnet.3");
	git(repo, "tag", "--delete", "curl-sys-v0.4.91-nktnet.3");
	const result = runScript(repo);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /already exists/);
	assertUnchanged(repo);
});

test("rejects invalid and non-increasing explicit versions", () => {
	const { repo } = createFixture();
	for (const version of [
		oldVersion,
		"0.4.91-nktnet.2+curl-8.22.1",
		"0.4.91-nktnet.03+curl-8.22.0",
	]) {
		const result = runScript(repo, version);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /must be newer|Invalid crate version/);
		assertUnchanged(repo);
	}
});

test("retries an interrupted atomic push without incrementing twice", () => {
	const { repo, remote } = createFixture();
	const hook = join(remote, "hooks", "pre-receive");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const failed = runScript(repo);
	assert.notEqual(failed.status, 0);
	assert.match(failed.stderr, /git push --atomic/);
	assert.match(failed.stderr, /rerun this script to retry/);
	const newHead = git(repo, "rev-parse", "HEAD");
	assert.notEqual(git(remote, "rev-parse", "refs/heads/fork"), newHead);
	assert.equal(git(repo, "tag", "--list"), "curl-sys-v0.4.91-nktnet.3");
	rmSync(hook);

	const retried = runScript(repo);
	assert.equal(retried.status, 0, retried.stderr);
	assert.match(retried.stdout, /Retrying release/);
	assert.equal(git(repo, "log", "-1", "--format=%s"), nextVersion);
	assert.equal(git(remote, "rev-parse", "refs/heads/fork"), newHead);
	assert.equal(
		git(remote, "rev-parse", "refs/tags/curl-sys-v0.4.91-nktnet.3"),
		newHead,
	);
});
