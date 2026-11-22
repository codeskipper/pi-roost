// Copyright 2026 codeskipper
// Licensed under the Apache License, Version 2.0. See LICENSE.

// The wizard's screen, built on pi's own TUI library. It works like pi's
// main screen: finished steps stay in the terminal's scrollback, and the
// part being worked on sits at the bottom.

import {
	CancellableLoader,
	type Component,
	decodeKittyPrintable,
	isKeyRelease,
	Loader,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";

type Styler = (text: string) => string;

const plain: Styler = (text) => text;

function sgr(code: number): Styler {
	return process.env.NO_COLOR ? plain : (text) => `\x1b[${code}m${text}\x1b[0m`;
}

export const style = {
	bold: sgr(1),
	dim: sgr(2),
	accent: sgr(36),
	good: sgr(32),
	warn: sgr(33),
	bad: sgr(31),
};

const listTheme: SelectListTheme = {
	selectedPrefix: style.accent,
	selectedText: style.accent,
	description: style.dim,
	scrollInfo: style.dim,
	noMatch: style.dim,
};

/** Returned by `work()` when the user pressed Escape. */
export const CANCELLED: unique symbol = Symbol("cancelled");

export interface SelectOptions {
	title: string;
	items: SelectItem[];
	/** Let the user narrow the list by typing. */
	filter?: boolean;
	maxVisible?: number;
	/** Shown when the filter leaves nothing. */
	emptyText?: string;
}

/** A titled list, optionally narrowed by typing. */
class Picker implements Component {
	readonly capturesViewportInput = true;
	onSelect?: (value: string) => void;
	onCancel?: () => void;

	private readonly title: string;
	private readonly items: SelectItem[];
	private readonly filter: boolean;
	private readonly maxVisible: number;
	private readonly hint: string;
	private readonly emptyText: string;
	private query = "";
	private visible: SelectItem[] = [];
	private list: SelectList;

	constructor(options: Required<SelectOptions>) {
		this.title = options.title;
		this.items = options.items;
		this.filter = options.filter;
		this.maxVisible = options.maxVisible;
		this.emptyText = options.emptyText;
		this.hint = options.filter
			? "type to filter · ↑↓ move · enter select · esc cancel"
			: "↑↓ move · enter select · esc cancel";
		this.list = this.rebuild();
	}

	private rebuild(): SelectList {
		const needle = this.query.toLowerCase();
		this.visible = needle
			? this.items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle))
			: this.items;
		// Size the label column to the longest label, so a repository name is
		// never cut short. The column is the same whatever the filter shows.
		const widest = Math.max(0, ...this.items.map((item) => visibleWidth(item.label)));
		const column = Math.min(widest + 2, 72);
		const list = new SelectList(this.visible, this.maxVisible, listTheme, {
			minPrimaryColumnWidth: column,
			maxPrimaryColumnWidth: column,
		});
		list.onSelect = (item) => this.onSelect?.(item.value);
		list.onCancel = () => this.onCancel?.();
		this.list = list;
		return list;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.filter) {
			if (matchesKey(data, "backspace")) {
				if (this.query) {
					this.query = this.query.slice(0, -1);
					this.rebuild();
				}
				return;
			}
			const typed = decodeKittyPrintable(data) ?? (/^[\x20-\x7e]+$/.test(data) ? data : undefined);
			if (typed !== undefined) {
				this.query += typed;
				this.rebuild();
				return;
			}
		}
		if (this.visible.length === 0) {
			if (matchesKey(data, "escape")) this.onCancel?.();
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		const lines = [truncateToWidth(` ${style.bold(this.title)}`, width)];
		if (this.filter) {
			lines.push(truncateToWidth(` ${style.dim("Filter:")} ${this.query}${style.dim("▏")}`, width));
		}
		if (this.visible.length === 0) {
			lines.push(truncateToWidth(style.dim(`  ${this.emptyText}`), width));
		} else {
			lines.push(...this.list.render(width));
		}
		lines.push(truncateToWidth(style.dim(` ${this.hint}`), width));
		return lines;
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

export class Ui {
	/** Called on Ctrl+C. Set by the caller to clean up before exiting. */
	onInterrupt?: () => void;

	private readonly tui: TUI;
	private started = false;

	constructor() {
		this.tui = new TuiMainScreen(new ProcessTerminal());
		this.tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) this.onInterrupt?.();
			return undefined;
		});
	}

	start(): void {
		this.tui.start();
		this.started = true;
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.tui.stop();
	}

	line(text = ""): void {
		this.tui.addChild(new Text(text, 1, 0));
		this.tui.requestRender();
	}

	blank(): void {
		this.tui.addChild(new Spacer(1));
		this.tui.requestRender();
	}

	heading(text: string): void {
		this.blank();
		this.line(style.bold(style.accent(text)));
	}

	good(text: string): void {
		this.line(`${style.good("✓")} ${text}`);
	}

	warn(text: string): void {
		this.line(`${style.warn("!")} ${text}`);
	}

	bad(text: string): void {
		this.line(`${style.bad("✗")} ${text}`);
	}

	note(text: string): void {
		this.line(style.dim(text));
	}

	/** Let the user pick one item. Resolves with its value, or null on Escape. */
	select(options: SelectOptions): Promise<string | null> {
		return new Promise((resolve) => {
			const picker = new Picker({
				filter: false,
				maxVisible: 10,
				emptyText: "Nothing matches",
				...options,
			});
			const finish = (value: string | null) => {
				this.tui.removeChild(picker);
				this.tui.setFocus(null);
				this.tui.requestRender();
				resolve(value);
			};
			picker.onSelect = (value) => finish(value);
			picker.onCancel = () => finish(null);
			this.tui.addChild(picker);
			this.tui.setFocus(picker);
			this.tui.requestRender();
		});
	}

	/** A yes/no question. Escape counts as no. */
	async confirm(question: string, labels: { yes?: string; no?: string } = {}): Promise<boolean> {
		const answer = await this.select({
			title: question,
			items: [
				{ value: "yes", label: labels.yes ?? "Yes" },
				{ value: "no", label: labels.no ?? "No" },
			],
		});
		return answer === "yes";
	}

	/** Show a spinner while `task` runs. */
	async work<T>(message: string, task: () => Promise<T>): Promise<T> {
		const loader = new Loader(this.tui, style.accent, plain, message);
		this.tui.addChild(loader);
		loader.start();
		try {
			return await task();
		} finally {
			loader.stop();
			this.tui.removeChild(loader);
			this.tui.requestRender();
		}
	}

	/**
	 * Show a spinner while `task` runs, and let Escape cancel it. Escape
	 * aborts the signal passed to the task, and the result is CANCELLED.
	 */
	async cancellableWork<T>(
		message: string,
		task: (signal: AbortSignal) => Promise<T>,
	): Promise<T | typeof CANCELLED> {
		const loader = new CancellableLoader(this.tui, style.accent, plain, `${message} ${style.dim("(esc to cancel)")}`);
		this.tui.addChild(loader);
		this.tui.setFocus(loader);
		loader.start();
		try {
			const result = await task(loader.signal);
			return loader.aborted ? CANCELLED : result;
		} catch (error) {
			if (loader.aborted) return CANCELLED;
			throw error;
		} finally {
			loader.stop();
			loader.dispose();
			this.tui.removeChild(loader);
			this.tui.setFocus(null);
			this.tui.requestRender();
		}
	}
}
