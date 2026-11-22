#!/usr/bin/env node
// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// pi-roost wizard, first slice: give the VM access to one GitHub repository
// through deploy keys held in Secretive. The design is in docs/WIZARD.md.
//
// The wizard runs on the host. It never creates a key itself, because
// Secretive has no way to do that from outside the app: it tells the user
// what to create and picks the new key up from the agent.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { accountKeyBlobs, addDeployKey, branchProtected, listRepos, login, type Repo } from "./github.ts";
import { INSTALLED_MARKER, installScript } from "./guest-config.ts";
import {
	type Access,
	attribution,
	fingerprint,
	hostAlias,
	parseKeyList,
	protectionFor,
	type PublicKey,
	type Role,
	ROLES,
	rolesFor,
	secretName,
} from "./keys.ts";
import { listKeys, openApp, socketPath, testSign, waitForNewKey } from "./secretive.ts";
import {
	knownBlobs,
	loadState,
	repoEntry,
	type RepoEntry,
	saveState,
	type State,
	type StoredKey,
	vmRepos,
} from "./state.ts";
import { CANCELLED, style, Ui } from "./ui.ts";
import { authorizedKeys, hostAliases, loginAgent, sshArgs, vmScript } from "./vm.ts";

/** Ends the wizard. The reason has already been shown. */
class Stop extends Error {
	/** The wizard's exit status: 0 when the user cancelled, 1 on a failure. */
	readonly code: number;

	constructor(code: number) {
		super("stopped");
		this.code = code;
	}
}

/** What to do once the screen has been given back to the terminal. */
type Afterwards = () => Promise<number>;

function stop(): never {
	throw new Stop(1);
}

function cancelled(ui: Ui): never {
	ui.note("Cancelled. Run the wizard again to carry on where it stopped.");
	throw new Stop(0);
}

function firstLine(text: string | undefined): string {
	return (text ?? "").split("\n").find((line) => line.trim()) ?? "";
}

function lastLine(text: string | undefined): string {
	return (text ?? "").split("\n").findLast((line) => line.trim()) ?? "";
}

function expandHome(path: string): string {
	return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function shellQuote(word: string): string {
	return /^[A-Za-z0-9_/.=:@+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

function label(key: PublicKey): string {
	return key.comment || fingerprint(key);
}

function describeAccess(entry: RepoEntry): string {
	if (entry.keys.write) return "write";
	if (entry.keys.read) return "read";
	return "started";
}

interface HostCheck {
	alias: string;
	/** The public keys that may log in to the VM. */
	loginKeys: PublicKey[];
}

async function checkHost(ui: Ui, state: State): Promise<HostCheck> {
	ui.heading("Checking the host");

	const secretive = await ui.work("Looking for Secretive", () => listKeys());
	if (!secretive.ok) {
		ui.bad("Secretive's agent is not reachable.");
		ui.note(`  ${socketPath()}`);
		ui.note("  Install it with `brew install secretive`, open it, and install its agent.");
		stop();
	}
	ui.good(`Secretive is running and holds ${secretive.keys.length} key(s)`);
	const known = knownBlobs(state);
	const foreign = secretive.keys.filter((key) => !known.has(key.blob));
	if (foreign.length > 0) {
		ui.warn(
			foreign.length === 1
				? "One of them was not set up by this wizard:"
				: `${foreign.length} of them were not set up by this wizard:`,
		);
		for (const key of foreign) ui.note(`    ${label(key)}`);
		ui.note("  Every key in Secretive is in reach of the VM during a session.");
	}

	const user = await ui.work("Checking gh", () => login());
	if (!user) {
		ui.bad("gh is not signed in on this Mac.");
		ui.note("  Run `gh auth login`, then start the wizard again.");
		stop();
	}
	ui.good(`gh is signed in as ${user}`);

	const aliases = hostAliases();
	let alias = aliases[0];
	if (!alias) {
		ui.bad("No pi-roost VM is set up in ~/.ssh/config.");
		ui.note("  Run host/create-vm.sh and host/setup.sh first.");
		stop();
	}
	if (aliases.length > 1) {
		const chosen = await ui.select({
			title: "Which VM?",
			items: aliases.map((name) => ({ value: name, label: name })),
		});
		if (chosen === null) cancelled(ui);
		alias = chosen;
	}

	const agent = await loginAgent(alias);
	if (agent && expandHome(agent) === socketPath()) {
		ui.bad(`"${alias}" is opened with a key held in Secretive.`);
		ui.note("  The wizard forwards Secretive's socket to the VM, so the login key would be in reach of it.");
		ui.note("  Run host/setup.sh with --identity-agent set to another agent.");
		stop();
	}

	const vm = alias;
	const reach = await ui.work(`Connecting to ${vm}`, () => vmScript(vm, "echo pi-roost-ok\n"));
	if (!reach.ok || !reach.stdout.includes("pi-roost-ok")) {
		ui.bad(`The VM does not answer as "${vm}".`);
		if (reach.stderr) ui.note(`  ${firstLine(reach.stderr)}`);
		stop();
	}
	ui.good(`The VM answers as "${vm}"`);

	const [loginKeys, accountKeys] = await ui.work("Checking how the VM is opened", async () => {
		return [await authorizedKeys(vm), await accountKeyBlobs(user)] as const;
	});
	if (loginKeys && accountKeys) {
		const shared = loginKeys.filter((key) => accountKeys.has(key.blob));
		if (shared.length > 0) {
			ui.warn("The VM is opened by a key that is also on your GitHub account:");
			for (const key of shared) ui.note(`    ${label(key)}`);
			ui.note("  A prompt for that key can mean a VM login or GitHub access.");
			ui.note("  A separate login key is planned. See docs/WIZARD.md.");
		}
	}

	return { alias: vm, loginKeys: loginKeys ?? [] };
}

async function chooseRepo(ui: Ui, state: State, alias: string): Promise<{ repo: Repo; access: Access }> {
	ui.heading("Choose a repository");
	const listing = await ui.work("Listing your repositories", () => listRepos());
	if (!listing.ok) {
		ui.bad("gh could not list your repositories.");
		if (listing.error) ui.note(`  ${firstLine(listing.error)}`);
		stop();
	}
	const usable = listing.repos.filter((repo) => repo.usable);
	const hidden = listing.repos.length - usable.length;
	if (hidden > 0) ui.note(`${hidden} repositories are left out: no admin rights, or archived.`);
	if (usable.length === 0) {
		ui.bad("No repository can take a deploy key.");
		stop();
	}
	const configured = vmRepos(state, alias);
	const name = await ui.select({
		title: "Repository",
		filter: true,
		maxVisible: 12,
		emptyText: "No repository matches",
		items: usable.map((repo) => {
			const entry = configured[repo.name];
			const details = [repo.isPrivate ? "private" : "public"];
			if (entry) details.push(`set up: ${describeAccess(entry)}`);
			return { value: repo.name, label: repo.name, description: details.join(" · ") };
		}),
	});
	if (name === null) cancelled(ui);
	const repo = usable.find((candidate) => candidate.name === name);
	if (!repo) stop();

	const choices = repo.isPrivate
		? [
				{ value: "read", label: "Read only", description: "clone and fetch" },
				{ value: "write", label: "Read and write", description: "also push; each push needs Touch ID" },
			]
		: [
				{
					value: "write",
					label: "Write",
					description: "push with Touch ID; reading a public repository needs no key",
				},
			];
	const picked = await ui.select({ title: `Access to ${repo.name}`, items: choices });
	if (picked === null) cancelled(ui);
	const access: Access = picked === "write" ? "write" : "read";
	ui.good(`${repo.name} (${repo.isPrivate ? "private" : "public"}): ${access}`);

	if (access === "write") {
		const guarded = await ui.work(`Checking branch protection on "${repo.defaultBranch}"`, () =>
			branchProtected(repo.name, repo.defaultBranch),
		);
		if (guarded === true) {
			ui.good(`"${repo.defaultBranch}" is protected`);
		} else if (guarded === false) {
			ui.warn(`"${repo.defaultBranch}" is not protected. A write key can push to it directly.`);
			ui.note("  A branch protection rule or ruleset on GitHub can require pull requests.");
			if (!(await ui.confirm("Continue without branch protection?"))) cancelled(ui);
		} else {
			ui.note("Could not check branch protection.");
		}
	}
	return { repo, access };
}

/**
 * Confirm that a key asks before signing, by having the user refuse once.
 * Returns false when the user cancelled. Stops the wizard when the key
 * turns out to sign without asking.
 */
async function checkAsksBeforeSigning(ui: Ui, repoName: string, key: PublicKey): Promise<boolean> {
	ui.line("Checking that this key asks before it signs.");
	ui.line(`A Touch ID prompt for "${secretName(repoName, "write")}" should appear. ${style.bold("Press Deny.")}`);
	for (;;) {
		const result = await ui.cancellableWork("Waiting for you to press Deny", (signal) => testSign(key, signal));
		if (result === CANCELLED) return false;
		if (result.refused) {
			ui.good("The key did not sign without approval");
			return true;
		}
		if (!result.signed) {
			// Neither a signature nor a refusal: the check itself went wrong.
			ui.warn("The check did not finish as expected.");
			if (result.detail) ui.note(`  ssh-keygen: ${lastLine(result.detail)}`);
			const next = await ui.select({
				title: "What now?",
				items: [
					{ value: "retry", label: "Try the check again" },
					{ value: "accept", label: "Use the key without this check" },
				],
			});
			if (next === null) return false;
			if (next === "accept") return true;
			continue;
		}
		ui.warn("The key signed. Either it is at Notify, or the prompt was approved.");
		const next = await ui.select({
			title: "What happened?",
			items: [
				{ value: "retry", label: "A prompt appeared and I approved it", description: "try again and press Deny" },
				{ value: "notify", label: "No prompt appeared" },
			],
		});
		if (next === null) return false;
		if (next === "notify") {
			ui.bad("This key signs without authentication, so it cannot be the write key.");
			ui.note("  Delete it in Secretive and run the wizard again.");
			stop();
		}
	}
}

/**
 * Walk the user through creating one key, and return it once it exists.
 * Returns null when the user cancelled.
 */
async function createKey(ui: Ui, repoName: string, role: Role): Promise<PublicKey | null> {
	// Taken before the instructions are shown, so a key made while they are
	// on screen still counts as new.
	const before = await listKeys();
	if (!before.ok) {
		ui.bad("Secretive's agent stopped answering.");
		stop();
	}
	const expected = attribution(repoName, role);
	ui.heading(`Create the ${role} key`);
	ui.line("In Secretive, choose File > New Secret, open Advanced, and enter:");
	ui.line(`  Name              ${style.bold(secretName(repoName, role))}`);
	ui.line(`  Protection level  ${style.bold(protectionFor(role))}`);
	ui.line(`  Key type          ${style.bold("ecdsa-256")}`);
	ui.line(`  Key attribution   ${style.bold(expected)}`);
	if (role === "write") {
		ui.note("The default protection level is Notify. A write key at Notify pushes with no Touch ID.");
	}
	ui.note("Set these when creating. Secretive 4.0.0 does not apply later edits until its agent restarts.");

	const ready = await ui.select({
		title: "Ready?",
		items: [
			{ value: "open", label: "Open Secretive and wait for the new key" },
			{ value: "wait", label: "Wait for the new key", description: "Secretive is already open" },
		],
	});
	if (ready === null) return null;
	if (ready === "open") await openApp();

	const added = await ui.cancellableWork("Waiting for a new key in Secretive", (signal) =>
		waitForNewKey(before.keys, signal),
	);
	if (added === CANCELLED) return null;
	let key = added[0];
	if (added.length > 1) {
		const blob = await ui.select({
			title: "More than one new key appeared. Which one is it?",
			items: added.map((candidate) => ({
				value: candidate.blob,
				label: label(candidate),
				description: fingerprint(candidate),
			})),
		});
		if (blob === null) return null;
		key = added.find((candidate) => candidate.blob === blob);
	}
	if (!key) return null;

	ui.good(`New key: ${key.comment || "(no attribution)"}`);
	ui.note(`  ${fingerprint(key)}`);
	if (key.comment !== expected) {
		ui.note(`  Its attribution is not "${expected}". That only changes the label.`);
	}
	if (key.type !== "ecdsa-sha2-nistp256") {
		ui.warn(`Its type is ${key.type}. This wizard was tested with ecdsa-256 keys only.`);
		if (!(await ui.confirm("Use this key anyway?"))) {
			ui.note("Delete it in Secretive and run the wizard again.");
			stop();
		}
	}
	if (role === "write" && !(await checkAsksBeforeSigning(ui, repoName, key))) return null;
	return key;
}

async function registerKey(ui: Ui, alias: string, repoName: string, role: Role, key: PublicKey): Promise<boolean> {
	const title = `pi-roost wizard, VM ${alias}, ${role}`;
	for (;;) {
		const result = await ui.work(`Registering the ${role} key on ${repoName}`, () =>
			addDeployKey(repoName, key, title, role === "write"),
		);
		if (result.ok) {
			ui.good(`Registered on GitHub as "${title}", ${role === "write" ? "with write access" : "read-only"}`);
			return true;
		}
		ui.bad("GitHub did not accept the key.");
		if (result.detail) ui.note(`  ${firstLine(result.detail)}`);
		if (!(await ui.confirm("Try again?", { no: "Stop" }))) return false;
	}
}

/** Make sure every key the access needs exists and is registered. */
async function ensureKeys(ui: Ui, state: State, alias: string, repo: Repo, access: Access): Promise<RepoEntry> {
	const entry = repoEntry(state, alias, repo.name);
	entry.private = repo.isPrivate;
	entry.defaultBranch = repo.defaultBranch;
	const roles = rolesFor(repo.isPrivate, access);
	for (const role of ROLES) {
		if (entry.keys[role] && !roles.includes(role)) {
			ui.note(`A ${role} key is already recorded for this repository. It is kept.`);
		}
	}
	for (const role of roles) {
		let key: StoredKey | undefined = entry.keys[role];
		if (key) {
			const recorded = key;
			const current = await listKeys();
			if (current.ok && !current.keys.some((held) => held.blob === recorded.blob)) {
				ui.warn(`The recorded ${role} key is no longer in Secretive. A new one is needed.`);
				delete entry.keys[role];
				saveState(state);
				key = undefined;
			} else {
				ui.good(`The ${role} key already exists: ${label(recorded)}`);
			}
		}
		if (!key) {
			const created = await createKey(ui, repo.name, role);
			if (!created) cancelled(ui);
			key = { ...created, fingerprint: fingerprint(created), registered: false };
			entry.keys[role] = key;
			saveState(state);
		}
		if (!key.registered) {
			if (!(await registerKey(ui, alias, repo.name, role, key))) cancelled(ui);
			key.registered = true;
			saveState(state);
		}
	}
	return entry;
}

async function setUpGuest(ui: Ui, state: State, alias: string): Promise<void> {
	ui.heading("Set up the VM");
	const script = installScript(vmRepos(state, alias));
	const result = await ui.work("Writing the routing", () => vmScript(alias, script));
	if (!result.ok || !result.stdout.includes(INSTALLED_MARKER)) {
		ui.bad("The routing could not be written in the VM.");
		if (result.stderr) ui.note(`  ${firstLine(result.stderr)}`);
		ui.note("  The keys are recorded. Run the wizard again to retry this step.");
		stop();
	}
	ui.good("The VM knows which key to use for each repository");
}

async function verify(ui: Ui, alias: string, repo: Repo, entry: RepoEntry, loginKeys: PublicKey[]): Promise<void> {
	ui.heading("Check from inside the VM");
	const forwardSocket = socketPath();

	const listed = await ui.work("Listing the keys the VM can see", () =>
		vmScript(alias, "ssh-add -L 2>/dev/null || true\n", { forwardSocket }),
	);
	const seen = parseKeyList(listed.stdout);
	const isSeen = (key: PublicKey) => seen.some((held) => held.blob === key.blob);
	const missing = ROLES.filter((role) => {
		const key = entry.keys[role];
		return key !== undefined && !isSeen(key);
	});
	if (!listed.ok || missing.length > 0) {
		ui.bad("The VM does not see the new keys through the forwarded socket.");
		if (listed.stderr) ui.note(`  ${firstLine(listed.stderr)}`);
	} else {
		ui.good(`With Secretive forwarded, the VM sees ${seen.length} key(s)`);
	}
	if (loginKeys.some(isSeen)) {
		ui.bad("The key that opens the VM is also visible inside it. It should not be.");
	}

	if (entry.keys.read) {
		const fetched = await ui.work(`Reading ${repo.name} with the read key`, () =>
			vmScript(alias, `git ls-remote https://github.com/${repo.name}.git HEAD\n`, { forwardSocket }),
		);
		if (fetched.ok) {
			ui.good("The read key works. Secretive shows a notification for it.");
		} else {
			ui.bad("Reading with the read key failed.");
			if (fetched.stderr) ui.note(`  ${firstLine(fetched.stderr)}`);
		}
	}

	if (entry.keys.write && (await ui.confirm("Test the write key now? It needs Touch ID.", { no: "Skip" }))) {
		ui.line(`Approve the Touch ID prompt for "${secretName(repo.name, "write")}".`);
		const command = `ssh -T -o BatchMode=yes ${hostAlias(repo.name, "write")} 2>&1 || true\n`;
		const greeted = await ui.cancellableWork("Waiting for Touch ID", (signal) =>
			vmScript(alias, command, { forwardSocket, signal }),
		);
		if (greeted === CANCELLED) {
			ui.note("Skipped.");
		} else if (greeted.stdout.includes(`Hi ${repo.name}!`)) {
			ui.good(`GitHub recognises the write key for ${repo.name}`);
		} else {
			ui.bad("GitHub did not recognise the write key.");
			ui.note(`  ${firstLine(greeted.stdout) || firstLine(greeted.stderr)}`);
		}
	}
}

async function wizard(ui: Ui): Promise<Afterwards | undefined> {
	ui.line(`${style.bold("pi-roost wizard")} ${style.dim("· give the VM access to one repository")}`);
	const state = loadState();

	const { alias, loginKeys } = await checkHost(ui, state);
	const { repo, access } = await chooseRepo(ui, state, alias);
	const entry = await ensureKeys(ui, state, alias, repo, access);
	await setUpGuest(ui, state, alias);
	await verify(ui, alias, repo, entry, loginKeys);

	ui.heading("Done");
	ui.line("In the VM, use addresses that end in .git, for example:");
	ui.line(`  git clone git@github.com:${repo.name}.git`);
	ui.line("Open a session with the deploy keys in reach with:");
	const args = sshArgs(alias, socketPath());
	ui.line(`  ssh ${args.map(shellQuote).join(" ")}`);
	const next = await ui.select({
		title: "What next?",
		items: [
			{ value: "session", label: "Open that session now" },
			{ value: "finish", label: "Finish" },
		],
	});
	if (next !== "session") return undefined;
	return () =>
		new Promise<number>((resolve) => {
			const child = spawn("ssh", args, { stdio: "inherit" });
			child.on("error", () => resolve(127));
			child.on("close", (code) => resolve(code ?? 0));
		});
}

async function main(): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error("The wizard needs a terminal. Run it from Terminal, not through a pipe.");
		return 2;
	}
	const ui = new Ui();
	ui.onInterrupt = () => {
		ui.stop();
		process.exit(130);
	};
	ui.start();
	let afterwards: Afterwards | undefined;
	let code = 0;
	try {
		afterwards = await wizard(ui);
	} catch (error) {
		if (error instanceof Stop) {
			code = error.code;
		} else {
			code = 1;
			ui.bad(`The wizard hit an error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// Let the last lines reach the terminal before giving it back.
	await new Promise((resolve) => setTimeout(resolve, 80));
	ui.stop();
	return afterwards ? afterwards() : code;
}

process.exitCode = await main();
