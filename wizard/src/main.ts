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
import {
	accountKeyBlobs,
	addDeployKey,
	branchProtected,
	deleteDeployKey,
	listDeployKeys,
	listRepos,
	login,
	type Repo,
} from "./github.ts";
import { INSTALLED_MARKER, installScript } from "./guest-config.ts";
import {
	type Access,
	attribution,
	fingerprint,
	hostAlias,
	parseKeyList,
	protectionFor,
	type PublicKey,
	rankCandidates,
	type Role,
	ROLES,
	rolesFor,
	secretName,
} from "./keys.ts";
import { copyToClipboard, listKeys, openApp, socketPath, testSign, waitForNewKey } from "./secretive.ts";
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
		ui.note(
			foreign.length === 1
				? "  One of them was made outside this wizard:"
				: `  ${foreign.length} of them were made outside this wizard:`,
		);
		for (const key of foreign) ui.note(`    ${label(key)}`);
		ui.note("  That is fine if you made them on purpose. When you pick a repository, the wizard");
		ui.note("  offers such keys before asking for a new one. Every key in Secretive is in reach");
		ui.note("  of the VM during a session.");
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

	const held = new Set(secretive.keys.map((key) => key.blob));
	const gone: string[] = [];
	for (const [repoName, entry] of Object.entries(vmRepos(state, alias))) {
		for (const role of ROLES) {
			const key = entry.keys[role];
			if (key && !held.has(key.blob)) gone.push(`${repoName}, ${role} key`);
		}
	}
	if (gone.length > 0) {
		ui.warn("Keys recorded for this VM are no longer in Secretive:");
		for (const name of gone) ui.note(`    ${name}`);
		ui.note("  Pick the repository again to replace a key. Its old deploy key stays on GitHub");
		ui.note("  until removed there.");
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
 * turns out to sign without asking, or carries the wrong name.
 *
 * A key the wizard asked for must carry the exact name it gave. A key made
 * earlier, outside the wizard, only has to name the repository clearly.
 */
async function checkAsksBeforeSigning(ui: Ui, repoName: string, key: PublicKey, adopted: boolean): Promise<boolean> {
	const name = secretName(repoName, "write");
	const question = adopted
		? `Did the prompt name a secret that is clearly for ${repoName}, with write access?`
		: `Did the prompt name the secret exactly "${name}"?`;
	ui.line("Checking that this key asks before it signs.");
	ui.line(`A Touch ID prompt should appear. ${style.bold("Press Deny.")}`);
	if (adopted) {
		ui.line(`Read the secret's name in the prompt first. It should tell you it is for ${repoName}.`);
	} else {
		ui.line("Read the secret's name in the prompt first. It should be exactly:");
		ui.line(`  ${style.bold(name)}`);
	}
	for (;;) {
		const result = await ui.cancellableWork("Waiting for you to press Deny", (signal) => testSign(key, signal));
		if (result === CANCELLED) return false;
		if (result.refused) {
			ui.good("The key did not sign without approval");
			// The agent only exposes the attribution, so the name can be checked
			// by eye alone. It is what every later prompt for this key shows.
			if (!(await ui.confirm(question))) {
				ui.bad(adopted ? "The secret's name does not identify the repository." : "The secret's name is not the one asked for.");
				ui.note(
					adopted
						? "  Rename it in Secretive and restart SecretAgent, or create a new key. Nothing was registered."
						: "  Delete it in Secretive and run the wizard again. Nothing was registered on GitHub.",
				);
				stop();
			}
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
			ui.note(
				adopted
					? "  Choose another key, or create a new one, when you run the wizard again."
					: "  Delete it in Secretive and run the wizard again.",
			);
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

	// The menu stays up while the user works in Secretive, and closes by
	// itself as soon as a new key appears in the agent.
	const watch = new AbortController();
	const menu = new AbortController();
	const detection = waitForNewKey(before.keys, watch.signal).then(
		(keys) => {
			menu.abort();
			return keys;
		},
		() => null,
	);
	const actions = [
		{ value: "open", label: "Open Secretive" },
		{ value: "name", label: "Copy the name", description: "to paste into Name" },
		{ value: "attribution", label: "Copy the key attribution", description: "to paste into Key attribution" },
	];
	let cursor = 0;
	let copied = "";
	while (!menu.signal.aborted) {
		const action = await ui.select({
			title: `${copied}Waiting for the new key. Meanwhile:`,
			items: actions,
			initialIndex: cursor,
			hint: "↑↓ move · enter select · esc cancel · continues when the key appears",
			signal: menu.signal,
		});
		if (menu.signal.aborted) break;
		if (action === null) {
			watch.abort();
			return null;
		}
		if (action === "open") {
			await openApp();
			cursor = 1;
		} else {
			const isName = action === "name";
			if (await copyToClipboard(isName ? secretName(repoName, role) : expected)) {
				copied = isName ? "Name copied. " : "Key attribution copied. ";
			} else {
				copied = "";
				ui.warn("The clipboard could not be set. Type the value instead.");
			}
			cursor = 2;
		}
	}
	const added = await detection;
	if (!added) return null;
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
	return key;
}

/** The answer from pickExistingKey. */
type KeyChoice = PublicKey | "create" | "same-as-write" | null;

interface PickOptions {
	/**
	 * This repository's recorded read key, offered when choosing the write key.
	 * It lets a key that was taken over as the read key by mistake become the
	 * write key instead.
	 */
	ownReadKey?: PublicKey;
	/** Offer the write key for reading too. Set when it was just taken over. */
	writeKey?: PublicKey;
}

/**
 * Offer keys that are in Secretive but not recorded by the wizard, before
 * asking for a new one. Resolves with the chosen key, "create", "same-as-write"
 * when the write key should be used for reading too, or null when the user
 * cancelled.
 */
async function pickExistingKey(
	ui: Ui,
	state: State,
	repoName: string,
	role: Role,
	options: PickOptions = {},
): Promise<KeyChoice> {
	const current = await listKeys();
	if (!current.ok) return "create";
	const held = (key: PublicKey | undefined) => key !== undefined && current.keys.some((k) => k.blob === key.blob);
	const known = knownBlobs(state);
	const candidates = rankCandidates(
		current.keys.filter((key) => !known.has(key.blob)),
		repoName,
	);
	const ownRead = held(options.ownReadKey) ? options.ownReadKey : undefined;
	const writeKey = held(options.writeKey) ? options.writeKey : undefined;
	if (candidates.length === 0 && !ownRead && !writeKey) return "create";

	ui.heading(`The ${role} key for ${repoName}`);
	if (role === "write") {
		ui.line("Pushes use this key, and each push asks for Touch ID.");
	} else {
		ui.line("Fetches use this key. A new read key only shows a notification, with no Touch ID.");
	}
	if (candidates.length > 0) {
		ui.line("Secretive holds keys made outside this wizard. One of them can be used, if it is meant for this.");
	}
	const items = [];
	if (writeKey) {
		items.push({ value: "same-as-write", label: "Use the write key for reading too", description: "every fetch asks for Touch ID" });
	}
	if (ownRead) {
		items.push({ value: ownRead.blob, label: label(ownRead), description: "recorded as this repository's read key" });
	}
	for (const key of candidates) items.push({ value: key.blob, label: label(key), description: fingerprint(key) });
	items.push({
		value: "create",
		label: "Create a new key",
		description: role === "read" ? "at Notify" : "at Require Authentication",
	});
	const choice = await ui.select({
		title: `Which key should be the ${role} key for ${repoName}?`,
		items,
	});
	if (choice === null) return null;
	if (choice === "create" || choice === "same-as-write") return choice;
	const key = [...(ownRead ? [ownRead] : []), ...candidates].find((candidate) => candidate.blob === choice);
	if (!key) return null;
	ui.good(`Using an existing key as the ${role} key: ${label(key)}`);
	return key;
}

/**
 * Checks a key before it is recorded: its type, and for a write key that it
 * asks before signing. Returns false when the user cancelled.
 */
async function vetKey(ui: Ui, repoName: string, role: Role, key: PublicKey, adopted: boolean): Promise<boolean> {
	if (key.type !== "ecdsa-sha2-nistp256") {
		ui.warn(`Its type is ${key.type}. This wizard was tested with ecdsa-256 keys only.`);
		if (!(await ui.confirm("Use this key anyway?"))) {
			ui.note(adopted ? "Choose another key when you run the wizard again." : "Delete it in Secretive and run the wizard again.");
			stop();
		}
	}
	if (role === "write") return checkAsksBeforeSigning(ui, repoName, key, adopted);
	if (adopted) ui.note("  If this key requires authentication, every read will ask for Touch ID.");
	return true;
}

async function registerKey(ui: Ui, alias: string, repoName: string, role: Role, key: PublicKey): Promise<boolean> {
	const title = `pi-roost wizard, VM ${alias}, ${role}`;
	// A key made earlier, or a run that stopped after registering, may be on
	// GitHub already. Adding it again would fail.
	const existing = await ui.work(`Checking the deploy keys on ${repoName}`, () => listDeployKeys(repoName));
	const match = existing?.find((deployKey) => deployKey.blob === key.blob);
	if (match) {
		if (role === "read" || !match.readOnly) {
			ui.good(`Already registered on GitHub as "${match.title}", ${match.readOnly ? "read-only" : "with write access"}`);
			if (role === "read" && !match.readOnly) {
				ui.note("  It has write access there, more than reading needs. The wizard uses it for reading only.");
			}
			return true;
		}
		ui.warn(`This key is registered on ${repoName} as "${match.title}", read-only.`);
		if (!(await ui.confirm("Replace that deploy key with one that has write access?", { no: "Stop" }))) {
			return false;
		}
		const removed = await ui.work("Removing the read-only deploy key", () => deleteDeployKey(repoName, match.id));
		if (!removed.ok) {
			ui.bad("GitHub did not remove the deploy key.");
			if (removed.detail) ui.note(`  ${firstLine(removed.detail)}`);
			return false;
		}
	}
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
	// The write key is settled first. A key taken over is most often one made
	// for pushing, and asking about it first keeps it from being taken as the
	// read key by mistake.
	const order = [...roles].sort((a, b) => (a === b ? 0 : a === "write" ? -1 : 1));
	let tookOverWriteKey = false;
	for (const role of order) {
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
			const existing = await pickExistingKey(ui, state, repo.name, role, {
				ownReadKey: role === "write" ? entry.keys.read : undefined,
				writeKey: role === "read" && tookOverWriteKey ? entry.keys.write : undefined,
			});
			if (existing === null) cancelled(ui);
			if (existing === "same-as-write") {
				const writeKey = entry.keys.write;
				if (!writeKey) stop();
				// The same deploy key serves both. It is registered already.
				entry.keys.read = { ...writeKey };
				saveState(state);
				ui.good("Reading uses the write key. Every fetch asks for Touch ID.");
				continue;
			}
			const adopted = existing !== "create";
			if (role === "write" && adopted) tookOverWriteKey = true;
			const chosen = adopted ? existing : await createKey(ui, repo.name, role);
			if (!chosen) cancelled(ui);
			if (!(await vetKey(ui, repo.name, role, chosen, adopted))) cancelled(ui);
			key = { ...chosen, fingerprint: fingerprint(chosen), registered: false };
			if (adopted) key.takenOver = true;
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

	const readKey = entry.keys.read;
	// A read key that is also the write key, or one taken over, may need
	// Touch ID, so testing it is offered instead of done.
	const readMayAsk = readKey !== undefined && (readKey.blob === entry.keys.write?.blob || readKey.takenOver === true);
	if (readKey && (!readMayAsk || (await ui.confirm("Test the read key now? It may need Touch ID.", { no: "Skip" })))) {
		const command = `git ls-remote https://github.com/${repo.name}.git HEAD\n`;
		const fetched = await ui.cancellableWork(`Reading ${repo.name} with the read key`, (signal) =>
			vmScript(alias, command, { forwardSocket, signal }),
		);
		if (fetched === CANCELLED) {
			ui.note("Skipped.");
		} else if (fetched.ok) {
			ui.good("The read key works.");
			if (!readMayAsk) ui.note(`  Secretive should show "Using secret ${secretName(repo.name, "read")}".`);
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
