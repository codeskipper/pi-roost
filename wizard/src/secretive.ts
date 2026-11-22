// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// Talks to Secretive's agent through its socket. The wizard can list keys
// and ask for a signature. It cannot create a key or read a key's
// protection level: Secretive 4.0.0 offers no way to do either from outside
// the app.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { keyLine, newKeys, parseKeyList, type PublicKey } from "./keys.ts";
import { run, sleep } from "./run.ts";

export function socketPath(): string {
	return (
		process.env.PI_ROOST_SECRETIVE_SOCK ||
		join(homedir(), "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh")
	);
}

export interface KeyListing {
	/** False when the agent cannot be reached. */
	ok: boolean;
	keys: PublicKey[];
	error?: string;
}

/** The keys Secretive holds. */
export async function listKeys(signal?: AbortSignal): Promise<KeyListing> {
	const result = await run("ssh-add", ["-L"], { env: { SSH_AUTH_SOCK: socketPath() }, signal });
	if (result.code === 0) return { ok: true, keys: parseKeyList(result.stdout) };
	// Exit status 1 means the agent answered and holds no keys.
	if (result.code === 1) return { ok: true, keys: [] };
	return { ok: false, keys: [], error: (result.stderr || result.stdout).trim() };
}

/**
 * Wait until Secretive holds a key it did not hold before, and return the
 * new keys. A key is recognised by its blob, never by its comment.
 */
export async function waitForNewKey(
	before: readonly PublicKey[],
	signal?: AbortSignal,
	intervalMs = 1000,
): Promise<PublicKey[]> {
	for (;;) {
		const now = await listKeys(signal);
		if (now.ok) {
			const added = newKeys(before, now.keys);
			if (added.length > 0) return added;
		}
		await sleep(intervalMs, signal);
	}
}

export interface SignTest {
	/** True when the agent returned a signature. */
	signed: boolean;
	/**
	 * True when the agent said no. This is what `ssh-keygen` reports after
	 * Deny is pressed on Secretive's prompt: "agent refused operation".
	 */
	refused: boolean;
	/** What `ssh-keygen` printed. */
	detail: string;
}

/**
 * Ask the key for a signature over a throwaway file. Used to tell a key that
 * requires authentication from one that does not: the user is told to press
 * Deny, and a signature that comes back anyway means nothing asked.
 */
export async function testSign(key: PublicKey, signal?: AbortSignal): Promise<SignTest> {
	const dir = mkdtempSync(join(tmpdir(), "pi-roost-sign-"));
	try {
		const pub = join(dir, "key.pub");
		const data = join(dir, "data");
		writeFileSync(pub, `${keyLine(key)}\n`);
		writeFileSync(data, "pi-roost protection check\n");
		const result = await run("ssh-keygen", ["-Y", "sign", "-f", pub, "-n", "pi-roost-check", data], {
			env: { SSH_AUTH_SOCK: socketPath() },
			signal,
		});
		const detail = (result.stderr || result.stdout).trim();
		const signed = result.code === 0;
		return { signed, refused: !signed && detail.includes("agent refused operation"), detail };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Bring the Secretive app to the front. */
export async function openApp(): Promise<void> {
	await run("open", ["-a", "Secretive"]);
}
