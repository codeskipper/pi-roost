// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAliases, sshArgs } from "../src/vm.ts";

test("parseAliases finds the kit's marked blocks", () => {
	const config = [
		"Host other",
		"  HostName example.com",
		"",
		"# >>> pi-roost: pi-roost >>>",
		"Host pi-roost",
		"Host pi-roost-git",
		"# <<< pi-roost: pi-roost <<<",
		"# >>> pi-roost: second-vm >>>",
		"# <<< pi-roost: second-vm <<<",
	].join("\n");
	assert.deepEqual(parseAliases(config), ["pi-roost", "second-vm"]);
	assert.deepEqual(parseAliases("Host pi-roost\n"), []);
	// A name that `ssh` would read as an option is not an alias.
	assert.deepEqual(parseAliases("# >>> pi-roost: -oProxyCommand=x >>>\n"), []);
});

test("sshArgs forwards a socket only when asked", () => {
	assert.deepEqual(sshArgs("vm"), ["-o", "ConnectTimeout=10", "vm"]);
	assert.deepEqual(sshArgs("vm", "/tmp/s.ssh"), [
		"-o",
		"ConnectTimeout=10",
		"-o",
		"ControlPath=none",
		"-o",
		"ForwardAgent=/tmp/s.ssh",
		"vm",
	]);
});
