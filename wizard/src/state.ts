// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// The wizard's record of what it set up: which repositories each VM can
// reach, and with which keys. It holds public keys only.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PublicKey, Role } from "./keys.ts";

/** A key the wizard has seen in Secretive. */
export interface StoredKey extends PublicKey {
	fingerprint: string;
	/** Whether it has been added to the repository as a deploy key. */
	registered: boolean;
	/** True for a key made outside the wizard and taken over. */
	takenOver?: boolean;
}

export interface RepoEntry {
	private?: boolean;
	defaultBranch?: string;
	keys: Partial<Record<Role, StoredKey>>;
}

export interface VmEntry {
	repos: Record<string, RepoEntry>;
}

export interface State {
	version: 1;
	/** Keyed by the VM's SSH alias. */
	vms: Record<string, VmEntry>;
}

/** The folder pi-roost owns on the host. Deleting it removes everything in it. */
export function roostHome(): string {
	return process.env.PI_ROOST_HOME || join(homedir(), ".pi-roost");
}

export function statePath(): string {
	return join(roostHome(), "state.json");
}

export function loadState(): State {
	try {
		const state = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<State> | null;
		if (state && state.version === 1 && state.vms && typeof state.vms === "object") {
			return { version: 1, vms: state.vms };
		}
	} catch {
		// No state yet, or an unreadable file: start empty.
	}
	return { version: 1, vms: {} };
}

export function saveState(state: State): void {
	mkdirSync(roostHome(), { recursive: true, mode: 0o700 });
	const temp = `${statePath()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, statePath());
}

/** The repositories recorded for one VM. */
export function vmRepos(state: State, vm: string): Record<string, RepoEntry> {
	return state.vms[vm]?.repos ?? {};
}

/** The entry for one repository on one VM, created if missing. */
export function repoEntry(state: State, vm: string, repo: string): RepoEntry {
	const vmEntry = (state.vms[vm] ??= { repos: {} });
	return (vmEntry.repos[repo] ??= { keys: {} });
}

/** Every key blob the wizard has recorded, across all VMs. */
export function knownBlobs(state: State): Set<string> {
	const blobs = new Set<string>();
	for (const vm of Object.values(state.vms)) {
		for (const entry of Object.values(vm.repos ?? {})) {
			for (const key of Object.values(entry.keys ?? {})) {
				if (key) blobs.add(key.blob);
			}
		}
	}
	return blobs;
}
