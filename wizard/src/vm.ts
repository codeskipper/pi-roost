// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// The VM, reached over SSH with the aliases that host/setup.sh wrote.
//
// Two kinds of connection are used:
// - plain: the kit's non-forwarding alias. Nothing on the host is in reach of
//   the VM.
// - forwarded: the same alias with Secretive's socket forwarded, and only
//   that socket. The login agent is never forwarded.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseKeyList, type PublicKey } from "./keys.ts";
import { run } from "./run.ts";

export interface VmOptions {
	/** Agent socket to forward. Omit for a plain connection. */
	forwardSocket?: string;
	signal?: AbortSignal;
}

export interface VmResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

/** VM aliases found in the kit's marked blocks in an SSH config. */
export function parseAliases(sshConfigText: string): string[] {
	const aliases: string[] = [];
	for (const match of sshConfigText.matchAll(/^# >>> pi-roost: (\S+) >>>\s*$/gm)) {
		const alias = match[1];
		// An alias is passed to `ssh` as an argument, so it must not look like
		// an option.
		if (alias && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias) && !aliases.includes(alias)) aliases.push(alias);
	}
	return aliases;
}

export function hostAliases(): string[] {
	try {
		return parseAliases(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
	} catch {
		return [];
	}
}

/** The agent socket SSH would use to log in to this alias, or null. */
export async function loginAgent(alias: string, signal?: AbortSignal): Promise<string | null> {
	const result = await run("ssh", ["-G", alias], { signal });
	if (result.code !== 0) return null;
	const match = /^identityagent (.+)$/m.exec(result.stdout);
	return match?.[1]?.trim() ?? null;
}

/** The `ssh` arguments for a connection, without the remote command. */
export function sshArgs(alias: string, forwardSocket?: string): string[] {
	const args = ["-o", "ConnectTimeout=10"];
	if (forwardSocket) args.push("-o", "ControlPath=none", "-o", `ForwardAgent=${forwardSocket}`);
	args.push(alias);
	return args;
}

/** Run a bash script in the VM. */
export async function vmScript(alias: string, script: string, options: VmOptions = {}): Promise<VmResult> {
	const args = ["-T", "-o", "BatchMode=yes", ...sshArgs(alias, options.forwardSocket), "bash -s"];
	const result = await run("ssh", args, { input: script, signal: options.signal });
	return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr.trim() };
}

/** The public keys that may log in to the VM, or null if it cannot be asked. */
export async function authorizedKeys(alias: string, signal?: AbortSignal): Promise<PublicKey[] | null> {
	const result = await vmScript(alias, "cat ~/.ssh/authorized_keys 2>/dev/null || true\n", { signal });
	return result.ok ? parseKeyList(result.stdout) : null;
}
