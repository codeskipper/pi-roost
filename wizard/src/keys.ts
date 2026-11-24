// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// Pure helpers for SSH public keys and the names derived from a repository.
// Nothing here touches the agent, the network or the file system.

import { createHash } from "node:crypto";

/** A public key as an agent lists it. */
export interface PublicKey {
	type: string;
	/** Base64 key data. This is the key's identity. */
	blob: string;
	/** A label only. In Secretive it is the key attribution, and it can change. */
	comment: string;
}

/** What a deploy key is for. */
export type Role = "read" | "write";

/** What the user asked for on a repository. */
export type Access = "read" | "write";

export const ROLES: readonly Role[] = ["read", "write"];

/**
 * Parse the output of `ssh-add -L` into keys.
 * A key's identity is its blob. The comment is only a label: Secretive lets
 * the user change it, and an edit does not reach the agent in 4.0.0.
 */
export function parseKeyList(text: string): PublicKey[] {
	const keys: PublicKey[] = [];
	for (const raw of text.split("\n")) {
		const match = /^(\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(raw.trim());
		if (!match) continue;
		const type = match[1] ?? "";
		const blob = match[2] ?? "";
		if (!/^(ssh-|ecdsa-|sk-)/.test(type)) continue;
		keys.push({ type, blob, comment: match[3] ?? "" });
	}
	return keys;
}

/** Keys in `after` whose blob is not in `before`. */
export function newKeys(before: readonly PublicKey[], after: readonly PublicKey[]): PublicKey[] {
	const known = new Set(before.map((key) => key.blob));
	return after.filter((key) => !known.has(key.blob));
}

/**
 * Order keys so that those whose label mentions the repository come first.
 * The label is only a hint; the user still chooses.
 */
export function rankCandidates(keys: readonly PublicKey[], repo: string): PublicKey[] {
	const needle = repo.toLowerCase();
	const mentions = (key: PublicKey) => key.comment.toLowerCase().includes(needle);
	return [...keys.filter(mentions), ...keys.filter((key) => !mentions(key))];
}

/** The `SHA256:...` fingerprint that `ssh-add -l` and GitHub show. */
export function fingerprint(key: PublicKey): string {
	const digest = createHash("sha256").update(Buffer.from(key.blob, "base64")).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** One line in public key file format. */
export function keyLine(key: PublicKey): string {
	return `${key.type} ${key.blob}${key.comment ? ` ${key.comment}` : ""}`;
}

/** Split "owner/name". Throws on anything else. */
export function splitRepo(repo: string): { owner: string; name: string } {
	const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
	if (!match?.[1] || !match[2]) throw new Error(`not a repository name: ${repo}`);
	return { owner: match[1], name: match[2] };
}

/**
 * The name to give the secret in Secretive. The Touch ID prompt shows this
 * name and not the destination, so the name carries host and repository.
 */
export function secretName(repo: string, role: Role): string {
	return `github.com ${repo} ${role}`;
}

/** The key attribution to set: the secret's name with dashes for spaces. */
export function attribution(repo: string, role: Role): string {
	return secretName(repo, role).replaceAll(" ", "-");
}

/**
 * SSH host alias for one key in the guest. Owner names cannot contain a dot,
 * so the first dot after the role always ends the owner.
 */
export function hostAlias(repo: string, role: Role): string {
	const { owner, name } = splitRepo(repo);
	return `gh-${role}.${owner}.${name}`;
}

/** File name for the public key in the guest. */
export function pubFileName(repo: string, role: Role): string {
	const { owner, name } = splitRepo(repo);
	return `${owner}.${name}.${role}.pub`;
}

/** Which keys a repository needs for the chosen access. */
export function rolesFor(isPrivate: boolean, access: Access): Role[] {
	if (access === "write") return isPrivate ? ["read", "write"] : ["write"];
	return isPrivate ? ["read"] : [];
}

/** The protection level each role's key should have in Secretive. */
export function protectionFor(role: Role): string {
	return role === "write" ? "Require Authentication" : "Notify";
}
