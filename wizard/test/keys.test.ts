// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attribution,
	fingerprint,
	hostAlias,
	keyLine,
	newKeys,
	parseKeyList,
	protectionFor,
	pubFileName,
	rolesFor,
	secretName,
	splitRepo,
} from "../src/keys.ts";

// GitHub's published Ed25519 host key, whose fingerprint is public.
const GITHUB_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

test("parseKeyList reads type, blob and comment", () => {
	const keys = parseKeyList(
		[
			"ecdsa-sha2-nistp256 AAAAE2Vj+/= github.com-owner/repo-write",
			"ecdsa-sha2-nistp256 AAAAE2Vk github.com owner/repo write",
			`ssh-ed25519 ${GITHUB_BLOB}`,
			"",
		].join("\n"),
	);
	assert.equal(keys.length, 3);
	assert.deepEqual(keys[0], {
		type: "ecdsa-sha2-nistp256",
		blob: "AAAAE2Vj+/=",
		comment: "github.com-owner/repo-write",
	});
	// A comment may contain spaces. Secretive keeps them when typed.
	assert.equal(keys[1]?.comment, "github.com owner/repo write");
	assert.equal(keys[2]?.comment, "");
});

test("parseKeyList ignores lines that are not keys", () => {
	assert.deepEqual(parseKeyList("The agent has no identities.\n"), []);
	assert.deepEqual(parseKeyList("Could not open a connection to your authentication agent.\n"), []);
});

test("newKeys compares by blob, not by comment", () => {
	const before = parseKeyList("ssh-ed25519 AAAA1 old-name\n");
	const after = parseKeyList("ssh-ed25519 AAAA1 renamed\nssh-ed25519 AAAA2 fresh\n");
	assert.deepEqual(
		newKeys(before, after).map((key) => key.blob),
		["AAAA2"],
	);
});

test("fingerprint matches ssh-keygen's SHA256 form", () => {
	assert.equal(
		fingerprint({ type: "ssh-ed25519", blob: GITHUB_BLOB, comment: "" }),
		"SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
	);
});

test("keyLine leaves out an empty comment", () => {
	assert.equal(keyLine({ type: "t", blob: "b", comment: "" }), "t b");
	assert.equal(keyLine({ type: "t", blob: "b", comment: "c d" }), "t b c d");
});

test("names derived from a repository", () => {
	assert.equal(secretName("codeskipper/pi-roost", "write"), "github.com codeskipper/pi-roost write");
	assert.equal(attribution("codeskipper/pi-roost", "write"), "github.com-codeskipper/pi-roost-write");
	assert.equal(hostAlias("codeskipper/pi-roost", "read"), "gh-read.codeskipper.pi-roost");
	assert.equal(pubFileName("codeskipper/pi.roost", "write"), "codeskipper.pi.roost.write.pub");
});

test("host aliases stay distinct where a dash-joined name would collide", () => {
	assert.notEqual(hostAlias("a-b/c", "read"), hostAlias("a/b-c", "read"));
});

test("splitRepo rejects anything that is not owner/name", () => {
	assert.deepEqual(splitRepo("o/n.x_y-z"), { owner: "o", name: "n.x_y-z" });
	for (const bad of ["", "owner", "a/b/c", "o wner/n", "o/n;rm", "o/$(x)", "o/n'"]) {
		assert.throws(() => splitRepo(bad), /not a repository name/);
	}
});

test("rolesFor and protectionFor", () => {
	assert.deepEqual(rolesFor(true, "read"), ["read"]);
	assert.deepEqual(rolesFor(true, "write"), ["read", "write"]);
	assert.deepEqual(rolesFor(false, "write"), ["write"]);
	assert.deepEqual(rolesFor(false, "read"), []);
	assert.equal(protectionFor("read"), "Notify");
	assert.equal(protectionFor("write"), "Require Authentication");
});
