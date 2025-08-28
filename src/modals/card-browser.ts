import { Modal, Setting, TFile } from "obsidian";
import {
	Flashcard,
	CardBrowserState,
	GatedNotesPluginInterface,
	LogLevel,
} from "../types";
import { makeModalDraggable, getDeckPathForChapter } from "../utils";
import { CardInfoModal } from ".";
import { DECK_FILE_NAME } from "../constants";

/**
 * A modal that provides a tree-based browser for all flashcards in the vault.
 */
export class CardBrowser extends Modal {
	private showOnlyFlagged = false;
	private showOnlySuspended = false;
	private treePane!: HTMLElement;
	private editorPane!: HTMLElement;

	constructor(
		private plugin: GatedNotesPluginInterface,
		private state: CardBrowserState,
		private filter?: (card: Flashcard) => boolean
	) {
		super(plugin.app);
	}

	async onOpen() {
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onOpen -> Initializing modal."
		);
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onOpen -> Received state:",
			{ ...this.state, openSubjects: [...this.state.openSubjects] }
		);

		this.modalEl.addClass("gn-browser");
		this.titleEl.setText(
			this.filter ? "Card Browser (Filtered)" : "Card Browser"
		);
		makeModalDraggable(this, this.plugin);

		const header = this.contentEl.createDiv({ cls: "gn-header" });
		new Setting(header)
			.setName("Show only flagged cards")
			.addToggle((toggle) => {
				toggle
					.setValue(this.showOnlyFlagged)
					.onChange(async (value) => {
						this.showOnlyFlagged = value;
						await this.renderContent();
					});
			});

		new Setting(header)
			.setName("Show only suspended cards")
			.addToggle((toggle) => {
				toggle
					.setValue(this.showOnlySuspended)
					.onChange(async (value) => {
						this.showOnlySuspended = value;
						await this.renderContent();
					});
			});

		const body = this.contentEl.createDiv({ cls: "gn-body" });
		this.treePane = body.createDiv({ cls: "gn-tree" });
		this.editorPane = body.createDiv({ cls: "gn-editor" });

		this.treePane.addEventListener("scroll", () => {
			this.state.treeScroll = this.treePane.scrollTop;
			this.plugin.logger(
				LogLevel.VERBOSE,
				`CardBrowser: Scroll state updated -> Tree: ${this.state.treeScroll}`
			);
		});
		this.editorPane.addEventListener("scroll", () => {
			this.state.editorScroll = this.editorPane.scrollTop;
			this.plugin.logger(
				LogLevel.VERBOSE,
				`CardBrowser: Scroll state updated -> Editor: ${this.state.editorScroll}`
			);
		});

		await this.renderContent();
	}

	async renderContent() {
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: renderContent -> Starting render."
		);
		this.treePane.empty();
		this.editorPane.empty();
		this.editorPane.setText("← Choose a chapter to view its cards");

		const showCardsForChapter = async (
			deck: TFile,
			chapterPath: string
		) => {
			this.state.activeChapterPath = chapterPath;
			this.plugin.logger(
				LogLevel.VERBOSE,
				`CardBrowser: showCardsForChapter -> Active chapter state updated to '${chapterPath}'`
			);

			this.treePane
				.querySelectorAll(".gn-chap.is-active")
				.forEach((el) => el.removeClass("is-active"));
			this.treePane
				.querySelector(`[data-chapter-path="${chapterPath}"]`)
				?.addClass("is-active");

			this.editorPane.empty();
			const graph = await this.plugin.deckService.readDeck(deck.path);
			let cards: Flashcard[] = (Object.values(graph) as Flashcard[]).filter(
				(c) => c.chapter === chapterPath
			);

			if (this.filter) cards = cards.filter(this.filter);
			if (this.showOnlyFlagged) cards = cards.filter((c) => c.flagged);
			if (this.showOnlySuspended)
				cards = cards.filter((c) => c.suspended);

			if (!cards.length) {
				this.editorPane.setText("No cards match the current filter.");
				return;
			}
			cards.sort(
				(a, b) => (a.paraIdx ?? Infinity) - (b.paraIdx ?? Infinity)
			);

			for (const card of cards) {
				const row = this.editorPane.createDiv({ cls: "gn-cardrow" });
				let cardLabel = card.front || "(empty front)";
				if (card.suspended) cardLabel = `⏸️ ${cardLabel}`;
				if (card.flagged) cardLabel = `🚩 ${cardLabel}`;
				row.setText(cardLabel);

				row.onclick = () => {
					this.plugin.openEditModal(card, graph, deck, async () => {
						await this.renderContent();
					});
				};

				row.createEl("span", { text: "ℹ️", cls: "gn-info" }).onclick = (
					ev
				) => {
					ev.stopPropagation();
					new CardInfoModal(this.plugin.app, card).open();
				};
				row.createEl("span", {
					text: "🗑️",
					cls: "gn-trash",
				}).onclick = async (ev) => {
					ev.stopPropagation();
					if (!confirm("Delete this card permanently?")) return;
					delete graph[card.id];
					await this.plugin.deckService.writeDeck(deck.path, graph);
					this.plugin.refreshAllStatuses();
					await this.renderContent();
				};
			}
		};

		const decks = this.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));

		for (const deck of decks) {
			const graph = await this.plugin.deckService.readDeck(deck.path);
			let cardsInDeck = Object.values(graph) as Flashcard[];
			if (this.filter) cardsInDeck = cardsInDeck.filter(this.filter);
			if (this.showOnlyFlagged)
				cardsInDeck = cardsInDeck.filter((c) => c.flagged);
			if (this.showOnlySuspended)
				cardsInDeck = cardsInDeck.filter((c) => c.suspended);
			if (cardsInDeck.length === 0) continue;

			const subject = deck.path.split("/")[0] || "Vault Root";

			const shouldBeOpen =
				this.state.isFirstRender ||
				this.state.openSubjects.has(subject);
			this.plugin.logger(
				LogLevel.VERBOSE,
				`CardBrowser: renderContent -> Subject '${subject}' should be open: ${shouldBeOpen} (isFirstRender: ${this.state.isFirstRender})`
			);

			const subjectEl = this.treePane.createEl("details", {
				cls: "gn-node",
			});
			subjectEl.open = shouldBeOpen;

			subjectEl.createEl("summary", { text: subject });

			subjectEl.addEventListener("toggle", () => {
				if (subjectEl.open) this.state.openSubjects.add(subject);
				else this.state.openSubjects.delete(subject);
				this.plugin.logger(
					LogLevel.VERBOSE,
					`CardBrowser: Subject toggle -> '${subject}' is now ${
						subjectEl.open ? "open" : "closed"
					}. New state:`,
					[...this.state.openSubjects]
				);
			});

			if (this.state.isFirstRender) this.state.openSubjects.add(subject);

			const chaptersInSubject = new Map<string, number>();
			for (const c of cardsInDeck) {
				chaptersInSubject.set(
					c.chapter,
					(chaptersInSubject.get(c.chapter) ?? 0) + 1
				);
			}

			const sortedChapters = [...chaptersInSubject.entries()].sort(
				(a, b) => a[0].localeCompare(b[0])
			);
			for (const [chapterPath, count] of sortedChapters) {
				const chapterName =
					chapterPath.split("/").pop()?.replace(/\.md$/, "") ??
					chapterPath;
				subjectEl.createEl("div", {
					cls: "gn-chap",
					text: `${count} card(s) • ${chapterName}`,
					attr: { "data-chapter-path": chapterPath },
				}).onclick = () => showCardsForChapter(deck, chapterPath);
			}
		}

		if (this.state.isFirstRender) {
			this.plugin.logger(
				LogLevel.VERBOSE,
				"CardBrowser: renderContent -> First render complete, setting flag to false."
			);
			this.state.isFirstRender = false;
		}

		if (this.state.activeChapterPath) {
			this.plugin.logger(
				LogLevel.VERBOSE,
				`CardBrowser: renderContent -> Attempting to restore active chapter: '${this.state.activeChapterPath}'`
			);
			const activeChapterDeck = decks.find(
				(d) =>
					getDeckPathForChapter(this.state.activeChapterPath!) ===
					d.path
			);
			if (activeChapterDeck) {
				await showCardsForChapter(
					activeChapterDeck,
					this.state.activeChapterPath
				);
			} else {
				this.plugin.logger(
					LogLevel.VERBOSE,
					"CardBrowser: renderContent -> ...deck not found for active chapter."
				);
			}
		}

		setTimeout(() => {
			this.plugin.logger(
				LogLevel.VERBOSE,
				`CardBrowser: renderContent -> Applying scroll positions in setTimeout -> Tree: ${this.state.treeScroll}, Editor: ${this.state.editorScroll}`
			);
			this.treePane.scrollTop = this.state.treeScroll;
			this.editorPane.scrollTop = this.state.editorScroll;
		}, 50);
	}

	onClose() {
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onClose -> Closing modal."
		);
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onClose -> Final state on close:",
			{ ...this.state, openSubjects: [...this.state.openSubjects] }
		);
		this.contentEl.empty();
	}
}
