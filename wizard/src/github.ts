// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// GitHub, through the `gh` CLI on the host. The host's `gh` login never
// reaches the VM.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyLine, parseKeyList, type PublicKey, splitRepo } from "./keys.ts";
import { run } from "./run.ts";

export interface Repo {
	/** "owner/name" */
	name: string;
	isPrivate: boolean;
	defaultBranch: string;
	/** Whether a deploy key can be added: admin rights, and not archived. */
	usable: boolean;
}

export interface RepoListing {
	ok: boolean;
	repos: Repo[];
	error?: string;
}

/** The shape of one entry in `gh repo list --json ...`. */
interface GhRepo {
	nameWithOwner: string;
	isPrivate?: boolean;
	isArchived?: boolean;
	viewerPermission?: string;
	defaultBranchRef?: { name?: string } | null;
}

/** The signed-in GitHub login, or null. */
export async function login(signal?: AbortSignal): Promise<string | null> {
	const result = await run("gh", ["api", "user", "--jq", ".login"], { signal });
	const name = result.stdout.trim();
	return result.code === 0 && name ? name : null;
}

/** Whether a name from `gh` has the plain "owner/name" form the wizard builds paths and commands from. */
function isPlainName(name: string): boolean {
	try {
		splitRepo(name);
		return true;
	} catch {
		return false;
	}
}

/** The user's own repositories. */
export async function listRepos(signal?: AbortSignal): Promise<RepoListing> {
	const fields = "nameWithOwner,isPrivate,isArchived,viewerPermission,defaultBranchRef";
	const result = await run("gh", ["repo", "list", "--limit", "500", "--json", fields], { signal });
	if (result.code !== 0) return { ok: false, repos: [], error: result.stderr.trim() };
	try {
		const repos = (JSON.parse(result.stdout) as GhRepo[]).map(
			(repo): Repo => ({
				name: repo.nameWithOwner,
				isPrivate: Boolean(repo.isPrivate),
				defaultBranch: repo.defaultBranchRef?.name || "main",
				usable: repo.viewerPermission === "ADMIN" && !repo.isArchived && isPlainName(repo.nameWithOwner),
			}),
		);
		repos.sort((a, b) => a.name.localeCompare(b.name));
		return { ok: true, repos };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, repos: [], error: `could not read gh's output: ${reason}` };
	}
}

/**
 * Whether the branch has classic branch protection or any ruleset rule.
 * Returns null when it cannot be determined.
 */
export async function branchProtected(repo: string, branch: string, signal?: AbortSignal): Promise<boolean | null> {
	const classic = await run("gh", ["api", `repos/${repo}/branches/${branch}`, "--jq", ".protected"], { signal });
	if (classic.code !== 0) return null;
	if (classic.stdout.trim() === "true") return true;
	const rules = await run("gh", ["api", `repos/${repo}/rules/branches/${branch}`, "--jq", "length"], { signal });
	if (rules.code !== 0) return false;
	return Number(rules.stdout.trim()) > 0;
}

export interface DeployKey {
	id: number;
	/** Base64 key data, comparable with a PublicKey's blob. */
	blob: string;
	readOnly: boolean;
	title: string;
}

/** The deploy keys on a repository, or null if they cannot be listed. */
export async function listDeployKeys(repo: string, signal?: AbortSignal): Promise<DeployKey[] | null> {
	const result = await run("gh", ["repo", "deploy-key", "list", "-R", repo, "--json", "id,key,readOnly,title"], {
		signal,
	});
	if (result.code !== 0) return null;
	try {
		const listed = JSON.parse(result.stdout || "[]") as { id: number; key: string; readOnly: boolean; title: string }[];
		return listed.map((entry) => ({
			id: entry.id,
			blob: parseKeyList(entry.key)[0]?.blob ?? "",
			readOnly: entry.readOnly,
			title: entry.title,
		}));
	} catch {
		return null;
	}
}

/** Remove a deploy key from a repository. */
export async function deleteDeployKey(
	repo: string,
	id: number,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	const result = await run("gh", ["repo", "deploy-key", "delete", String(id), "-R", repo], { signal });
	return { ok: result.code === 0, detail: (result.stderr || result.stdout).trim() };
}

/** Register a public key as a deploy key on one repository. */
export async function addDeployKey(
	repo: string,
	key: PublicKey,
	title: string,
	allowWrite: boolean,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-roost-key-"));
	try {
		const file = join(dir, "key.pub");
		writeFileSync(file, `${keyLine(key)}\n`);
		const args = ["repo", "deploy-key", "add", file, "-R", repo, "--title", title];
		if (allowWrite) args.push("--allow-write");
		const result = await run("gh", args, { signal });
		return { ok: result.code === 0, detail: (result.stderr || result.stdout).trim() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The SSH keys on a user's GitHub account, from the public
 * `github.com/<login>.keys` page. Returns null when it cannot be fetched.
 */
export async function accountKeyBlobs(name: string): Promise<Set<string> | null> {
	try {
		const response = await fetch(`https://github.com/${encodeURIComponent(name)}.keys`, {
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return null;
		return new Set(parseKeyList(await response.text()).map((key) => key.blob));
	} catch {
		return null;
	}
}
