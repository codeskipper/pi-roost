// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetKey, type State, type StoredKey, staleKeys } from "../src/state.ts";

function key(blob: string): StoredKey {
	return { type: "ecdsa-sha2-nistp256", blob, comment: "", fingerprint: "SHA256:x", registered: true };
}

function sample(): State {
	return {
		version: 1,
		vms: {
			vm: {
				repos: {
					"o/b": { keys: { read: key("R"), write: key("W") } },
					"o/a": { keys: { write: key("GONE") } },
					"o/shared": { keys: { read: key("S"), write: key("S") } },
				},
			},
			other: { repos: { "o/a": { keys: { write: key("GONE") } } } },
		},
	};
}

test("staleKeys lists recorded keys Secretive no longer holds, by repository", () => {
	const stale = staleKeys(sample(), "vm", new Set(["R", "W"]));
	assert.deepEqual(
		stale.map((entry) => `${entry.repo} ${entry.role}`),
		["o/a write", "o/shared read", "o/shared write"],
	);
	assert.deepEqual(staleKeys(sample(), "vm", new Set(["R", "W", "GONE", "S"])), []);
	assert.deepEqual(staleKeys(sample(), "no-such-vm", new Set()), []);
});

test("forgetKey removes one key, and the repository once it has none", () => {
	const state = sample();
	forgetKey(state, "vm", "o/b", "write");
	assert.deepEqual(Object.keys(state.vms.vm?.repos["o/b"]?.keys ?? {}), ["read"]);
	forgetKey(state, "vm", "o/a", "write");
	assert.equal(state.vms.vm?.repos["o/a"], undefined);
	// Another VM's record is untouched.
	assert.ok(state.vms.other?.repos["o/a"]?.keys.write);
	// Forgetting what is not there does nothing.
	forgetKey(state, "vm", "o/none", "read");
	forgetKey(state, "none", "o/b", "read");
	assert.ok(state.vms.vm?.repos["o/b"]?.keys.read);
});
