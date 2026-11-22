// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// Runs external commands. Every host-side effect of the wizard goes through
// here, so it is the one place to look to see what the wizard can do.

import { spawn } from "node:child_process";

export interface RunOptions {
	/** Added to the wizard's own environment. */
	env?: Record<string, string>;
	/** Written to the command's standard input. */
	input?: string;
	signal?: AbortSignal;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
}

/**
 * Run a command and collect its output. Never rejects: a command that
 * cannot be started resolves with code 127.
 */
export function run(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(command, [...args], {
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: Error) => {
			const aborted = error.name === "AbortError";
			resolve({ code: aborted ? 130 : 127, stdout, stderr: stderr || error.message, aborted });
		});
		child.on("close", (code, killSignal) => {
			resolve({ code: code ?? (killSignal ? 130 : 1), stdout, stderr, aborted: Boolean(options.signal?.aborted) });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

/** Sleep that ends early, and rejects, when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}
