// Gated Notes — Gated Reading & Spaced Repetition for Obsidian

import {
	App,
	ButtonComponent,
	Component,
	Editor,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	TAbstractFile,
	TextComponent,
	TFile,
	ToggleComponent,
} from "obsidian";

import { Buffer } from "buffer";

// ===================================================================
//
//                          CONSTANTS & ENUMS
//
// ===================================================================

const DECK_FILE_NAME = "_flashcards.json";
const SPLIT_TAG = '<div class="gn-split-placeholder"></div>';
const PARA_CLASS = "gn-paragraph";
const PARA_ID_ATTR = "data-para-id";
const PARA_MD_ATTR = "data-gn-md";
const API_URL_COMPLETIONS = "https://api.openai.com/v1/chat/completions";
const API_URL_MODELS = "https://api.openai.com/v1/models";
const IMAGE_ANALYSIS_FILE_NAME = "_images.json";

const ICONS = {
	blocked: "⏳",
	due: "📆",
	done: "✅",
};

enum StudyMode {
	REVIEW = "review",
	CHAPTER = "chapter",
	SUBJECT = "subject",
}

enum LogLevel {
	NONE = 0,
	NORMAL = 1,
	VERBOSE = 2,
}

type CardRating = "Again" | "Hard" | "Good" | "Easy";
type CardStatus = "new" | "learning" | "review" | "relearn";
type ReviewResult = "answered" | "skip" | "abort" | "again";

// ===================================================================
//
//                          INTERFACES & TYPES
//
// ===================================================================

interface ReviewLog {
	timestamp: number;
	rating: CardRating;
	state: CardStatus;
	interval: number;
	ease_factor: number;
}

interface Flashcard {
	id: string;
	front: string;
	back: string;
	tag: string;
	chapter: string;
	paraIdx?: number;
	status: CardStatus;
	last_reviewed: string | null;
	interval: number;
	ease_factor: number;
	due: number;
	learning_step_index?: number;
	blocked: boolean;
	review_history: ReviewLog[];
}

interface FlashcardGraph {
	[id: string]: Flashcard;
}

interface Settings {
	openaiApiKey: string;
	openaiModel: string;
	openaiTemperature: number;
	availableModels: string[];
	learningSteps: number[];
	relearnSteps: number[];
	buryDelayHours: number;
	gatingEnabled: boolean;
	apiProvider: "openai" | "lmstudio";
	lmStudioUrl: string;
	lmStudioModel: string;
	logLevel: LogLevel;
	autoCorrectTags: boolean;
	maxTagCorrectionRetries: number;
	openaiMultimodalModel: string;
	analyzeImagesOnGenerate: boolean;
}

const DEFAULT_SETTINGS: Settings = {
	openaiApiKey: "",
	openaiModel: "gpt-4o",
	openaiTemperature: 0,
	availableModels: [],
	learningSteps: [1, 10],
	relearnSteps: [10],
	buryDelayHours: 24,
	gatingEnabled: true,
	apiProvider: "openai",
	lmStudioUrl: "http://localhost:1234",
	lmStudioModel: "",
	logLevel: LogLevel.NORMAL,
	autoCorrectTags: true,
	maxTagCorrectionRetries: 2,
	openaiMultimodalModel: "gpt-4o-mini",
	analyzeImagesOnGenerate: true,
};

interface ImageAnalysis {
	path: string;
	analysis: {
		type: string;
		description: Record<string, string | string[]>;
	};
}

interface ImageAnalysisGraph {
	[hash: string]: ImageAnalysis;
}

// ===================================================================
//
//                          MAIN PLUGIN CLASS
//
// ===================================================================

export default class GatedNotesPlugin extends Plugin {
	settings!: Settings;
	public lastModalTransform: string | null = null;

	private statusBar!: HTMLElement;
	private gatingStatus!: HTMLElement;
	private cardsMissingParaIdxStatus!: HTMLElement;
	private statusRefreshQueued = false;
	private studyMode: StudyMode = StudyMode.CHAPTER;
	private isRecalculatingAll = false;

	// =====================
	// Plugin Lifecycle
	// =====================

	async onload(): Promise<void> {
		await this.loadSettings();

		this.setupStatusBar();
		this.addSettingTab(new GNSettingsTab(this.app, this));

		this.injectCss();
		this.registerGatingProcessor();

		this.registerCommands();
		this.registerRibbonIcons();
		this.registerEvents();
		this.registerContextMenus();

		this.app.workspace.onLayoutReady(() => {
			this.refreshAllStatuses();
			this.decorateExplorer();
		});
	}

	// =====================
	// Logging
	// =====================

	/**
	 * Logs messages to the console based on the current logging level.
	 * @param level The level of the message (NORMAL or VERBOSE).
	 * @param message The primary message to log.
	 * @param optionalParams Additional data to log.
	 */
	public logger(
		level: LogLevel,
		message: string,
		...optionalParams: unknown[]
	): void {
		if (this.settings.logLevel >= level) {
			const prefix = "[Gated Notes]";
			if (level === LogLevel.NORMAL) {
				console.warn(prefix, message, ...optionalParams);
			} else {
				console.log(prefix, message, ...optionalParams);
			}
		}
	}

	// =====================
	// Setup & Registration
	// =====================

	private setupStatusBar(): void {
		this.statusBar = this.addStatusBarItem();
		this.gatingStatus = this.addStatusBarItem();
		this.updateGatingStatus();
		this.gatingStatus.onClickEvent(() => this.toggleGating());

		this.cardsMissingParaIdxStatus = this.addStatusBarItem();
		this.cardsMissingParaIdxStatus.onClickEvent(() => {
			new CardBrowser(
				this,
				(card: Flashcard) =>
					card.paraIdx === undefined || card.paraIdx === null
			).open();
		});
	}

	private registerCommands(): void {
		this.addCommand({
			id: "gn-review-due",
			name: "Review due cards",
			callback: () => this.reviewDue(),
		});

		this.addCommand({
			id: "gn-toggle-gating",
			name: "Toggle content gating",
			callback: () => this.toggleGating(),
		});

		this.addCommand({
			id: "gn-browse-cards",
			name: "Browse cards",
			callback: () => new CardBrowser(this).open(),
		});

		this.addCommand({
			id: "gn-finalize-auto",
			name: "Finalize note (auto-paragraphs)",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) this.autoFinalizeNote(view.file);
				return true;
			},
		});

		this.addCommand({
			id: "gn-finalize-manual",
			name: "Finalize note (manual splits)",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) this.manualFinalizeNote(view.file);
				return true;
			},
		});

		this.addCommand({
			id: "gn-unfinalize",
			name: "Un-finalize chapter",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) this.unfinalize(view.file);
				return true;
			},
		});

		this.addCommand({
			id: "gn-insert-split",
			name: "Insert paragraph split marker",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
			editorCallback: (editor: Editor) =>
				editor.replaceSelection(`\n${SPLIT_TAG}\n`),
		});

		this.addCommand({
			id: "gn-generate-cards",
			name: "Generate flashcards from finalized note",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (
					!view?.file ||
					!view.editor.getValue().includes(PARA_CLASS)
				) {
					return false;
				}
				if (!checking) {
					// This part needs to be async to check for existing cards
					(async () => {
						const file = view.file!;
						const deckPath = getDeckPathForChapter(file.path);
						const graph = await this.readDeck(deckPath);
						const existingCards = Object.values(graph).filter(
							(c) => c.chapter === file.path
						);

						if (existingCards.length > 0) {
							// Open new modal for generating additional cards
							new GenerateAdditionalCardsModal(
								this,
								file,
								existingCards,
								(result) => {
									if (result && result.count > 0) {
										this.generateFlashcards(
											file,
											result.count,
											result.preventDuplicates
												? existingCards
												: undefined
										);
									}
								}
							).open();
						} else {
							// Open original modal for new card generation
							this.promptForCardCount(file, (count: number) => {
								if (count > 0)
									this.generateFlashcards(file, count);
							});
						}
					})();
				}
				return true;
			},
		});

		this.addCommand({
			id: "gn-recalculate-para-idx",
			name: "Recalculate paragraph indexes for this note",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) this.recalculateParaIdx(view.file);
				return true;
			},
		});

		this.addCommand({
			id: "gn-recalculate-all-para-idx",
			name: "Recalculate paragraph indexes for all notes",
			callback: () => this.recalculateAllParaIndexes(),
		});

		this.addCommand({
			id: "gn-delete-chapter-cards",
			name: "Delete all flashcards for this chapter",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) this.deleteChapterCards(view.file);
				return true;
			},
		});
	}

	private registerRibbonIcons(): void {
		this.addRibbonIcon("target", "Chapter focus", () => {
			this.studyMode = StudyMode.CHAPTER;
			new Notice("🎯 Chapter focus mode");
			this.reviewDue();
		});

		this.addRibbonIcon("library", "Subject focus", () => {
			this.studyMode = StudyMode.SUBJECT;
			new Notice("📚 Subject focus mode");
			this.reviewDue();
		});

		this.addRibbonIcon("brain", "Review-only focus", () => {
			this.studyMode = StudyMode.REVIEW;
			new Notice("🧠 Review-only mode");
			this.reviewDue();
		});

		this.addRibbonIcon("wallet-cards", "Card Browser", () => {
			new CardBrowser(this).open();
		});
	}

	private registerEvents(): void {
		this.registerEvent(
			this.app.vault.on("modify", () => this.decorateExplorer())
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.decorateExplorer())
		);
		this.registerEvent(
			this.app.vault.on("rename", this.handleRename.bind(this))
		);

		const refreshOnDeckChange = (file: TAbstractFile) => {
			if (file.path.endsWith(DECK_FILE_NAME)) {
				this.refreshAllStatuses();
			}
		};
		this.registerEvent(this.app.vault.on("modify", refreshOnDeckChange));
		this.registerEvent(this.app.vault.on("rename", refreshOnDeckChange));
		this.registerEvent(this.app.vault.on("delete", refreshOnDeckChange));
	}

	private registerContextMenus(): void {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				const selection = editor.getSelection().trim();
				if (!selection || !view.file) return;

				menu.addItem((item) =>
					item
						.setTitle("Add flashcard (Gated Notes)")
						.setIcon("plus-circle")
						.onClick(() =>
							this.addFlashcardFromSelection(
								selection,
								view.file!
							)
						)
				);
			})
		);

		this.registerDomEvent(document, "contextmenu", (evt: MouseEvent) => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || view.getMode() !== "preview") return;

			const selection = window.getSelection()?.toString().trim();
			if (!selection) return;

			const targetEl = evt.target as HTMLElement;
			const paraEl = targetEl.closest<HTMLElement>(`.${PARA_CLASS}`);
			if (!paraEl || !view.file) return;

			const paraIdx = Number(paraEl.getAttribute(PARA_ID_ATTR));
			evt.preventDefault();
			const menu = new Menu();

			menu.addItem((item) =>
				item
					.setTitle("Copy")
					.setIcon("copy")
					.onClick(() => navigator.clipboard.writeText(selection))
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Add flashcard (manual)")
					.setIcon("plus-circle")
					.onClick(() =>
						this.addFlashcardFromSelection(
							selection,
							view.file!,
							paraIdx
						)
					)
			);
			menu.addItem((item) =>
				item
					.setTitle("Generate a card with AI")
					.setIcon("sparkles")
					.onClick(() =>
						this.generateCardFromSelection(
							selection,
							view.file!,
							paraIdx
						)
					)
			);
			menu.addItem((item) =>
				item
					.setTitle("Generate one or more cards with AI")
					.setIcon("sparkles")
					.onClick(() =>
						this.generateCardsFromSelection(
							selection,
							view.file!,
							paraIdx
						)
					)
			);
			menu.showAtMouseEvent(evt);
		});
	}

	// =====================
	// Spaced Repetition & Review
	// =====================

	private async reviewDue(): Promise<void> {
		const activePath = this.app.workspace.getActiveFile()?.path ?? "";
		while (true) {
			const queue = await this.collectReviewPool(activePath);
			if (!queue.length) {
				new Notice("🎉 All reviews complete!");
				return;
			}
			let breakEarly = false;
			for (let i = 0; i < queue.length; i++) {
				const { card, deck } = queue[i];
				const res = await this.openReviewModal(card, deck);
				if (res === "abort") {
					new Notice("Review session aborted.");
					return;
				}
				if (res === "again" && i === queue.length - 1) {
					new Notice("Last card failed. Jumping to context…");
					await this.jumpToTag(card);
					breakEarly = true;
					break;
				}
			}
			if (!breakEarly) return;
		}
	}

	private async collectReviewPool(
		activePath: string
	): Promise<{ card: Flashcard; deck: TFile }[]> {
		const subjectOf = (path: string): string => path.split("/")[0] ?? "";
		const reviewPool: { card: Flashcard; deck: TFile }[] = [];
		const now = Date.now();

		const allDeckFiles = this.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));

		for (const deck of allDeckFiles) {
			const graph = await this.readDeck(deck.path);
			let cardsInScope: Flashcard[];

			switch (this.studyMode) {
				case StudyMode.CHAPTER:
					cardsInScope = Object.values(graph).filter(
						(c) => c.chapter === activePath
					);
					break;
				case StudyMode.SUBJECT:
					cardsInScope = Object.values(graph).filter(
						(c) => subjectOf(c.chapter) === subjectOf(activePath)
					);
					break;
				case StudyMode.REVIEW:
				default:
					cardsInScope = Object.values(graph);
					break;
			}

			let firstBlockedParaIdx = Infinity;
			if (this.studyMode === StudyMode.CHAPTER) {
				const blockedCards = cardsInScope.filter((c) => c.blocked);
				if (blockedCards.length > 0) {
					firstBlockedParaIdx = Math.min(
						...blockedCards.map((c) => c.paraIdx ?? Infinity)
					);
				}
			}

			for (const card of cardsInScope) {
				if (card.due > now) continue;

				const isNew = isUnseen(card);
				if (this.studyMode === StudyMode.CHAPTER) {
					if (
						isNew &&
						(card.paraIdx ?? Infinity) > firstBlockedParaIdx
					) {
						continue;
					}
				} else {
					if (isNew) continue;
				}
				reviewPool.push({ card, deck });
			}
		}

		reviewPool.sort((a, b) => {
			const aIsNew = isUnseen(a.card);
			const bIsNew = isUnseen(b.card);
			if (aIsNew !== bIsNew) return aIsNew ? -1 : 1;
			if (a.card.chapter === b.card.chapter) {
				return (
					(a.card.paraIdx ?? Infinity) - (b.card.paraIdx ?? Infinity)
				);
			}
			return a.card.due - b.card.due;
		});

		return reviewPool;
	}

	private applySm2(card: Flashcard, rating: CardRating): void {
		const { status: originalStatus, interval, ease_factor } = card;
		const previousState: ReviewLog = {
			timestamp: 0,
			rating,
			state: originalStatus,
			interval,
			ease_factor,
		};

		const now = Date.now();
		const ONE_DAY_MS = 86_400_000;
		const ONE_MINUTE_MS = 60_000;

		if (!card.review_history) card.review_history = [];
		card.review_history.push({ ...previousState, timestamp: now });

		if (originalStatus === "new") {
			card.status = "learning";
		}

		if (rating === "Again") {
			if (originalStatus === "review") {
				card.status = "relearn";
			}
			card.learning_step_index = 0;
			card.interval = 0;
			card.ease_factor = Math.max(1.3, card.ease_factor - 0.2);
			card.due = now;
			card.blocked = true;
			card.last_reviewed = new Date(now).toISOString();
			return;
		}

		card.blocked = false;

		if (["learning", "relearn"].includes(card.status)) {
			const steps =
				card.status === "relearn"
					? this.settings.relearnSteps
					: this.settings.learningSteps;
			const stepIncrement = rating === "Easy" ? 2 : 1;
			const currentIndex =
				(card.learning_step_index ?? -1) + stepIncrement;

			if (currentIndex < steps.length) {
				card.learning_step_index = currentIndex;
				card.due = now + steps[currentIndex] * ONE_MINUTE_MS;
			} else {
				card.status = "review";
				card.interval = rating === "Easy" ? 4 : 1;
				card.due = now + card.interval * ONE_DAY_MS;
				delete card.learning_step_index;
			}
		} else if (card.status === "review") {
			if (rating === "Hard") {
				card.interval = Math.max(1, card.interval * 1.2);
				card.ease_factor = Math.max(1.3, card.ease_factor - 0.15);
			} else {
				if (rating === "Easy") card.ease_factor += 0.15;
				card.interval = Math.round(card.interval * card.ease_factor);
			}
			card.due = now + card.interval * ONE_DAY_MS;
		}
		card.last_reviewed = new Date(now).toISOString();
	}

	// =====================
	// Note Processing & Card Generation
	// =====================

	private async autoFinalizeNote(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		if (content.includes(PARA_CLASS)) {
			new Notice("Note is already finalized.");
			return;
		}

		if (content.includes(SPLIT_TAG)) {
			const userChoice = await this.showSplitMarkerConflictModal();

			if (userChoice === "manual") {
				await this.manualFinalizeNote(file);
				return;
			} else if (userChoice === null) {
				return;
			}
		}

		const paragraphs: string[] = [];
		let inFence = false;
		let buffer: string[] = [];

		for (const line of content.split("\n")) {
			if (line.trim().startsWith("```")) inFence = !inFence;
			buffer.push(line);
			if (!inFence && line.trim() === "") {
				const paragraph = buffer.join("\n").trim();
				if (paragraph) paragraphs.push(paragraph);
				buffer = [];
			}
		}
		if (buffer.length > 0) {
			const lastParagraph = buffer.join("\n").trim();
			if (lastParagraph) paragraphs.push(lastParagraph);
		}

		const wrappedContent = paragraphs
			.map(
				(md, i) =>
					`<br class="gn-sentinel"><div class="${PARA_CLASS}" ${PARA_ID_ATTR}="${
						i + 1
					}" ${PARA_MD_ATTR}="${md2attr(md)}"></div>`
			)
			.join("\n\n");
		await this.app.vault.modify(file, wrappedContent);
		new Notice("Note auto-finalized. Gating is now active.");
	}

	private async manualFinalizeNote(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		if (!content.includes(SPLIT_TAG)) {
			new Notice("No split markers found in the note.");
			return;
		}
		if (content.includes(PARA_CLASS)) {
			new Notice("Note is already finalized.");
			return;
		}

		const chunks = content.split(SPLIT_TAG);
		const wrappedContent = chunks
			.map(
				(md, i) =>
					`<br class="gn-sentinel"><div class="${PARA_CLASS}" ${PARA_ID_ATTR}="${
						i + 1
					}" ${PARA_MD_ATTR}="${md2attr(md.trim())}"></div>`
			)
			.join("\n\n");
		await this.app.vault.modify(file, wrappedContent);
		new Notice("Note manually finalized. Gating is now active.");
	}

	private async unfinalize(file: TFile): Promise<void> {
		const htmlContent = await this.app.vault.read(file);
		const paragraphs = getParagraphsFromFinalizedNote(htmlContent);

		if (paragraphs.length === 0) {
			new Notice("This note does not appear to be finalized.");
			return;
		}

		const mdContent = paragraphs
			.map((p) => p.markdown)
			.join(`\n\n${SPLIT_TAG}\n\n`)
			.trim();
		await this.app.vault.modify(file, mdContent);
		this.refreshReading();
		this.refreshAllStatuses();

		const deckPath = getDeckPathForChapter(file.path);
		if (!(await this.app.vault.adapter.exists(deckPath))) {
			new Notice("Chapter un-finalized. Gating removed.");
			return;
		}

		const graph = await this.readDeck(deckPath);
		const cardsForChapter = Object.values(graph).filter(
			(c) => c.chapter === file.path
		);

		if (cardsForChapter.length > 0) {
			if (await this.showUnfinalizeConfirmModal()) {
				for (const id in graph) {
					if (graph[id].chapter === file.path) delete graph[id];
				}
				await this.writeDeck(deckPath, graph);
				new Notice(
					`Chapter un-finalized and ${cardsForChapter.length} card(s) deleted.`
				);
			} else {
				new Notice(
					"Chapter un-finalized. Gating removed, cards were kept."
				);
			}
		} else {
			new Notice("Chapter un-finalized. Gating removed.");
		}
	}

	private showSplitMarkerConflictModal(): Promise<"auto" | "manual" | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			let choice: "auto" | "manual" | null = null; // Variable to store the choice

			modal.titleEl.setText("Manual Split Markers Detected");
			modal.contentEl.createEl("p", {
				text: "This note contains manual paragraph split markers. The 'auto-finalize' action normally ignores these and splits paragraphs based on blank lines.",
			});
			modal.contentEl.createEl("p", {
				text: "How would you like to proceed?",
			});

			const buttonContainer = modal.contentEl.createDiv({
				cls: "gn-edit-btnrow",
			});

			new ButtonComponent(buttonContainer)
				.setButtonText("Cancel")
				.onClick(() => {
					choice = null; // Set choice
					modal.close();
				});

			new ButtonComponent(buttonContainer)
				.setButtonText("Ignore and Auto-Split")
				.setWarning()
				.onClick(() => {
					choice = "auto"; // Set choice
					modal.close();
				});

			new ButtonComponent(buttonContainer)
				.setButtonText("Use Manual Breaks")
				.setCta()
				.onClick(() => {
					choice = "manual"; // Set choice
					modal.close();
				});

			modal.onClose = () => {
				resolve(choice);
			};

			modal.open();
		});
	}

	private async generateFlashcards(
		file: TFile,
		count: number,
		existingCardsForContext?: Flashcard[]
	): Promise<void> {
		const notice = new Notice(
			`🤖 Preparing to generate ${count} flashcard(s)...`,
			0
		);
		const wrappedContent = await this.app.vault.read(file);
		const paragraphs = getParagraphsFromFinalizedNote(wrappedContent);
		let plainTextForLlm = paragraphs.map((p) => p.markdown).join("\n\n");

		let hasImages = false;
		const imageHashMap = new Map<string, number>();

		if (this.settings.analyzeImagesOnGenerate) {
			const imageRegex = /!\[\[([^\]]+)\]\]/g;
			const imageDb = await this.getImageDb();
			let match;
			const textToProcess = plainTextForLlm;

			while ((match = imageRegex.exec(textToProcess)) !== null) {
				const imageLinkText = match[0];
				const imagePath = match[1];
				const imageFile = this.app.metadataCache.getFirstLinkpathDest(
					imagePath,
					file.path
				);

				if (imageFile instanceof TFile) {
					hasImages = true;
					notice.setMessage(
						`🤖 Analyzing image: ${imageFile.name}...`
					);
					const hash = await this.calculateFileHash(imageFile);

					const imagePara = paragraphs.find((p) =>
						p.markdown.includes(imageLinkText)
					);
					if (imagePara) {
						imageHashMap.set(hash, imagePara.id);
					}

					let analysisEntry = imageDb[hash];

					if (!analysisEntry) {
						const newAnalysis = await this.analyzeImage(imageFile);
						if (newAnalysis) {
							analysisEntry = newAnalysis;
							imageDb[hash] = newAnalysis;
							await this.writeImageDb(imageDb);
						}
					}

					if (analysisEntry) {
						const { type, description } = analysisEntry.analysis;
						const descriptionJson = JSON.stringify(description);
						const placeholder = `[[IMAGE: HASH=${hash} TYPE=${type} DESCRIPTION=${descriptionJson}]]`;
						plainTextForLlm = plainTextForLlm.replace(
							imageLinkText,
							placeholder
						);
					}
				}
			}
		}

		if (!plainTextForLlm.trim()) {
			new Notice(
				"Error: Could not extract text from the finalized note."
			);
			return;
		}

		let contextPrompt = "";
		if (existingCardsForContext && existingCardsForContext.length > 0) {
			const simplifiedCards = existingCardsForContext.map((c) => ({
				front: c.front,
				back: c.back,
			}));
			contextPrompt = `To avoid duplicates, do not create cards that cover the same information as the following existing cards:\nExisting Cards:\n${JSON.stringify(
				simplifiedCards
			)}\n\n`;
		}

		let initialPrompt: string;
		if (hasImages) {
			initialPrompt = `Create ${count} new, distinct Anki-style flashcards to study the following article. The article contains descriptions of images with this structure: "[[IMAGE: HASH=... TYPE=... DESCRIPTION={...}]]", where DESCRIPTION contains a JSON object with details about the image.

**Card Structure:**
- The "Front" MUST be a question.
- The "Back" MUST be a direct answer.
- The "Tag" MUST be context for the card.

**Tagging Rules:**
1.  **For cards about an image:** The "Tag" MUST be ONLY the image reference, like "[[IMAGE HASH=...]]".
2.  **For cards about text:** You MUST find a relevant, contiguous quote from the article and copy it *exactly* into the "Tag" field.
3.  **Crucially, only use an image reference as a tag if the question in the "Front" is asking specifically about that image. Otherwise, you MUST use a text quote.**
4.  Do not invent a tag or use placeholders like "none". Every card must have a valid tag.

**Example of a PERFECT image-based card:**
{
  "front": "What does the diagram of the solar system show?",
  "back": "It shows the sun at the center with the planets orbiting it.",
  "tag": "[[IMAGE HASH=...]]"
}

Return ONLY valid JSON of this shape:
[
  {"front":"...","back":"...","tag":"..."}
]

${contextPrompt}Here is the article:
${plainTextForLlm}`;
		} else {
			initialPrompt = `Create ${count} new, distinct Anki-style flashcards to study the following article.

**Card Structure:**
- The "Front" MUST be a question.
- The "Back" MUST be a direct answer.
- The "Tag" MUST be context for the card.

**Tagging Rules:**
1. You MUST find a relevant, contiguous quote from the article and copy it *exactly* into the "Tag" field. Do not summarize or paraphrase it.
2. The tag value must not contain any newline characters.
3. **Crucially, do not invent a tag or use placeholders like "none". Every card must have a valid tag.**


Return ONLY valid JSON of this shape:
[
  {"front":"...","back":"...","tag":"..."}
]

${contextPrompt}Here is the article:
${plainTextForLlm}`;
		}

		notice.setMessage(`🤖 Generating ${count} flashcard(s)...`);
		const response = await this.sendToLlm(initialPrompt);
		notice.hide();
		if (!response) {
			new Notice("LLM generation failed. See console for details.");
			return;
		}

		const generatedItems = this.parseLlmResponse(response, file.path);
		const goodCards: Flashcard[] = [];
		let cardsToFix: Omit<Flashcard, "id" | "paraIdx" | "review_history">[] =
			[];

		for (const item of generatedItems) {
			if (item.tag.startsWith("[[IMAGE HASH=")) {
				const hashMatch = item.tag.match(
					/\[\[IMAGE HASH=([a-f0-9]{64})\]\]/
				);
				if (hashMatch && imageHashMap.has(hashMatch[1])) {
					const paraIdx = imageHashMap.get(hashMatch[1]);
					goodCards.push(this.createCardObject({ ...item, paraIdx }));
				} else {
					const imagePara = paragraphs.find((p) =>
						p.markdown.includes("![[")
					);
					goodCards.push(
						this.createCardObject({
							...item,
							paraIdx: imagePara?.id,
						})
					);
				}
			} else {
				const paraIdx = this.findBestParaForTag(item.tag, paragraphs);
				if (paraIdx !== undefined) {
					goodCards.push(this.createCardObject({ ...item, paraIdx }));
				} else {
					cardsToFix.push(item);
				}
			}
		}

		let correctedCount = 0;
		if (this.settings.autoCorrectTags && cardsToFix.length > 0) {
			new Notice(`🤖 Found ${cardsToFix.length} tags to auto-correct...`);
			const stillUnfixed: typeof cardsToFix = [];

			for (const cardData of cardsToFix) {
				const correctedCard = await this.attemptTagCorrection(
					cardData,
					plainTextForLlm,
					paragraphs
				);
				if (correctedCard) {
					goodCards.push(correctedCard);
					correctedCount++;
				} else {
					stillUnfixed.push(cardData);
					this.logger(
						LogLevel.NORMAL,
						`Failed to auto-correct tag for card: "${cardData.front}"`,
						cardData
					);
				}
			}
			cardsToFix = stillUnfixed;
		}

		if (goodCards.length > 0) await this.saveCards(file, goodCards);
		let noticeText = `✅ Added ${goodCards.length} cards.`;
		if (correctedCount > 0)
			noticeText += ` 🤖 Auto-corrected ${correctedCount} tags.`;
		if (cardsToFix.length > 0)
			noticeText += ` ⚠️ Failed to fix ${cardsToFix.length} tags (see console).`;
		new Notice(noticeText);

		this.refreshReading();
		this.refreshAllStatuses();
	}

	private async attemptTagCorrection(
		cardData: Omit<Flashcard, "id" | "paraIdx" | "review_history">,
		sourceText: string,
		paragraphs: { id: number; markdown: string }[]
	): Promise<Flashcard | null> {
		for (let i = 0; i < this.settings.maxTagCorrectionRetries; i++) {
			const cardJson = JSON.stringify({
				front: cardData.front,
				back: cardData.back,
				tag: cardData.tag,
			});
			const correctionPrompt = `You are a text-correction assistant. You will be given a flashcard (Front, Back, and a bad Tag) and a Source Text. The provided "Tag" is not a verbatim quote from the Source Text.

Your task is to find the single best short, contiguous quote from the Source Text that is most relevant to the flashcard's Front and Back.
- The new tag MUST be copied exactly, verbatim, from the Source Text.
- Do not add any explanation.

Return ONLY valid JSON of this shape: {"front":"...","back":"...","tag":"..."}

---
**Flashcard to Correct:**
${cardJson}

**Source Text:**
${JSON.stringify(sourceText)}
---`;

			const fixResponse = await this.sendToLlm(correctionPrompt);
			if (fixResponse) {
				try {
					const fixedItems = extractJsonObjects<{
						front: string;
						back: string;
						tag: string;
					}>(fixResponse);
					if (fixedItems.length > 0) {
						const fixedItem = fixedItems[0];
						const paraIdx = this.findBestParaForTag(
							fixedItem.tag,
							paragraphs
						);
						if (paraIdx !== undefined) {
							return this.createCardObject({
								...cardData,
								...fixedItem,
								paraIdx,
							});
						}
					}
				} catch (e) {
					this.logger(
						LogLevel.VERBOSE,
						"Error parsing correction response JSON",
						e
					);
				}
			}
		}
		return null;
	}

	private async generateCardFromSelection(
		selection: string,
		file: TFile,
		paraIdx: number
	): Promise<void> {
		new Notice("🤖 Generating card with AI...");

		const prompt = `From the following text, create a single, concise flashcard.
Return ONLY valid JSON of this shape: {"front":"...","back":"..."}

Text:
"""
${selection}
"""`;

		try {
			const response = await this.sendToLlm(prompt);
			if (!response) throw new Error("AI returned an empty response.");

			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (!jsonMatch)
				throw new Error(
					"Could not find a valid JSON object in the LLM response."
				);

			const parsed = JSON.parse(jsonMatch[0]) as {
				front: string;
				back: string;
			};
			if (!parsed.front || !parsed.back)
				throw new Error(
					"AI response was missing 'front' or 'back' keys."
				);

			const card = this.createCardObject({
				front: parsed.front.trim(),
				back: parsed.back.trim(),
				tag: selection,
				chapter: file.path,
				paraIdx,
			});

			await this.saveCards(file, [card]);
			new Notice("✅ AI-generated card added!");
			this.refreshAllStatuses();
			this.refreshReading();
		} catch (e: unknown) {
			const message =
				e instanceof Error ? e.message : "An unknown error occurred.";
			new Notice(`Failed to generate AI card: ${message}`);
			this.logger(LogLevel.NORMAL, "Failed to generate AI card:", e);
		}
	}

	private async generateCardsFromSelection(
		selection: string,
		file: TFile,
		paraIdx: number
	): Promise<void> {
		new CountModal(this, 1, async (count) => {
			if (count <= 0) return;
			const notice = new Notice(
				`🤖 Generating ${count} card(s) from selection...`,
				0
			);

			const prompt = `From the following text, create ${count} concise flashcard(s).
Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]

Text:
"""
${selection}
"""`;

			try {
				const response = await this.sendToLlm(prompt);
				if (!response)
					throw new Error("AI returned an empty response.");

				const parsedItems = extractJsonArray<{
					front: string;
					back: string;
				}>(response);
				if (parsedItems.length === 0) {
					throw new Error(
						"AI response did not contain valid card data."
					);
				}

				const cards = parsedItems.map((item) =>
					this.createCardObject({
						front: item.front.trim(),
						back: item.back.trim(),
						tag: selection,
						chapter: file.path,
						paraIdx,
					})
				);

				await this.saveCards(file, cards);
				notice.setMessage(
					`✅ ${cards.length} AI-generated card(s) added!`
				);
				setTimeout(() => notice.hide(), 3000);

				this.refreshAllStatuses();
				this.refreshReading();
			} catch (e: unknown) {
				const message =
					e instanceof Error
						? e.message
						: "An unknown error occurred.";
				notice.hide();
				new Notice(`Failed to generate AI cards: ${message}`);
				this.logger(
					LogLevel.NORMAL,
					"Failed to generate AI cards from selection:",
					e
				);
			}
		}).open();
	}

	private parseLlmResponse(
		rawResponse: string,
		chapterPath: string
	): Omit<Flashcard, "id" | "paraIdx" | "review_history">[] {
		try {
			const items = extractJsonArray<{
				front: string;
				back: string;
				tag: string;
			}>(rawResponse);

			return items
				.filter((item) => item.front && item.back && item.tag)
				.map((item) => ({
					front: item.front.trim(),
					back: item.back.trim(),
					tag: item.tag.trim(),
					chapter: chapterPath,
					status: "new" as CardStatus,
					last_reviewed: null,
					interval: 0,
					ease_factor: 2.5,
					due: Date.now(),
					blocked: true,
				}));
		} catch (e: unknown) {
			new Notice("Error parsing LLM response. See console for details.");
			this.logger(LogLevel.NORMAL, "Failed to parse LLM JSON.", {
				error: e,
				response: rawResponse,
			});
			return [];
		}
	}

	// =====================
	// Rendering & DOM Manipulation
	// =====================

	public refreshReading(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") {
				(view.previewMode as any)?.rerender?.(true);
			}
		});
	}

	private registerGatingProcessor(): void {
		this.registerMarkdownPostProcessor(
			async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				const paragraphDivs = el.querySelectorAll<HTMLElement>(
					`.${PARA_CLASS}`
				);
				if (!paragraphDivs.length) return;

				if (!this.settings.gatingEnabled) {
					for (const div of paragraphDivs) {
						div.classList.remove("gn-hidden");
						if (div.dataset.gnProcessed) continue;
						const md = attr2md(
							div.getAttribute(PARA_MD_ATTR) || ""
						);
						if (!md) continue;
						div.empty();
						await MarkdownRenderer.render(
							this.app,
							md,
							div,
							ctx.sourcePath,
							this
						);
						div.dataset.gnProcessed = "true";
					}
					return;
				}

				try {
					const chapterPath = ctx.sourcePath;
					const deckPath = getDeckPathForChapter(chapterPath);
					const graph = await this.readDeck(deckPath);

					const blockedCards = Object.values(graph).filter(
						(c) => c.chapter === chapterPath && c.blocked
					);
					const firstBlockedParaIdx =
						blockedCards.length > 0
							? Math.min(
									...blockedCards.map(
										(c) => c.paraIdx ?? Infinity
									)
							  )
							: Infinity;

					for (const div of paragraphDivs) {
						if (div.dataset.gnProcessed) continue;
						const md = attr2md(
							div.getAttribute(PARA_MD_ATTR) || ""
						);
						if (!md) continue;

						div.empty();
						await MarkdownRenderer.render(
							this.app,
							md,
							div,
							chapterPath,
							this
						);

						const paraIdx = Number(
							div.getAttribute(PARA_ID_ATTR) || 0
						);
						div.classList.toggle(
							"gn-hidden",
							paraIdx > firstBlockedParaIdx
						);
						div.dataset.gnProcessed = "true";
					}
				} catch (e: unknown) {
					this.logger(LogLevel.NORMAL, "Gating processor error:", e);
				}
			}
		);
	}

	private async decorateExplorer(): Promise<void> {
		const fileItems =
			document.querySelectorAll<HTMLElement>(".nav-file-title");
		for (const el of fileItems) {
			const path = el.getAttribute("data-path");
			if (!path || !path.endsWith(".md")) continue;

			const state = await this.getChapterState(path);
			el.classList.remove("gn-done", "gn-due", "gn-blocked");
			if (state) el.classList.add(`gn-${state}`);
		}
	}

	private async jumpToTag(card: Flashcard): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.chapter);
		if (!(file instanceof TFile)) {
			new Notice("Could not find the source file for this card.");
			return;
		}
		const targetLine = await getLineForParagraph(
			this,
			file,
			card.paraIdx ?? 1
		);

		const leaf = this.app.workspace.getLeaf(false);

		await leaf.openFile(file, {
			state: { mode: "preview" },
		});

		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView) return;

		mdView.setEphemeralState({ scroll: targetLine });

		await new Promise((resolve) => setTimeout(resolve, 50));

		const paraSelector = `.${PARA_CLASS}[${PARA_ID_ATTR}="${
			card.paraIdx ?? 1
		}"]`;

		const wrapper = await waitForEl<HTMLElement>(
			paraSelector,
			mdView.previewMode.containerEl
		);
		if (!wrapper) {
			this.logger(
				LogLevel.NORMAL,
				`Jump failed: Timed out waiting for paragraph element with selector: ${paraSelector}`
			);
			new Notice(
				"Jump failed: Timed out waiting for paragraph to render."
			);
			return;
		}

		if (card.tag.startsWith("[[IMAGE HASH=")) {
			const hashMatch = card.tag.match(
				/\[\[IMAGE HASH=([a-f0-9]{64})\]\]/
			);
			let imageFound = false;

			if (hashMatch) {
				const hash = hashMatch[1];
				const imageDb = await this.getImageDb();
				const imageInfo = imageDb[hash];

				if (imageInfo) {
					const filename = imageInfo.path.split("/").pop();
					const imageSelector = `span.internal-embed[src*="${filename}"]`;
					const imgContainerEl =
						wrapper.querySelector<HTMLElement>(imageSelector);

					if (imgContainerEl) {
						imgContainerEl.scrollIntoView({
							behavior: "smooth",
							block: "center",
						});
						imgContainerEl.classList.add("gn-flash");
						setTimeout(
							() => imgContainerEl.classList.remove("gn-flash"),
							1200
						);
						imageFound = true;
					}
				}
			}

			if (!imageFound) {
				this.logger(
					LogLevel.NORMAL,
					`Could not find specific image element for tag: ${card.tag}. Flashing paragraph.`
				);
				wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
				wrapper.classList.add("gn-flash");
				setTimeout(() => wrapper.classList.remove("gn-flash"), 1200);
			}
		} else {
			try {
				const range = findTextRange(card.tag, wrapper);
				const mark = document.createElement("mark");
				mark.className = "gn-flash";
				range.surroundContents(mark);
				mark.scrollIntoView({ behavior: "smooth", block: "center" });

				setTimeout(() => {
					const parent = mark.parentNode;
					if (parent) {
						while (mark.firstChild)
							parent.insertBefore(mark.firstChild, mark);
						parent.removeChild(mark);
					}
				}, 1200);
			} catch (e) {
				this.logger(
					LogLevel.NORMAL,
					`Tag highlighting failed: ${
						(e as Error).message
					}. Flashing paragraph as fallback.`
				);
				wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
				wrapper.classList.add("gn-flash");
				setTimeout(() => wrapper.classList.remove("gn-flash"), 1200);
			}
		}
	}

	private injectCss(): void {
		const styleId = "gated-notes-styles";
		if (document.getElementById(styleId)) return;
		const styleEl = document.createElement("style");
		styleEl.id = styleId;
		styleEl.textContent = `
              .gn-sentinel { display: none; }
              .gn-hidden { filter: blur(5px); background: var(--background-secondary); position: relative; overflow: hidden; padding: 0.1px 0; }
              .gn-hidden::after { content: "🔒 Unlock by answering earlier cards"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: bold; color: var(--text-muted); }
              .gn-blocked::before, .gn-due::before, .gn-done::before { margin-right: 4px; font-size: 0.9em; }
              .gn-blocked::before { content: "${ICONS.blocked}"; }
              .gn-due::before { content: "${ICONS.due}"; }
              .gn-done::before { content: "${ICONS.done}"; }
              .gn-flash, .gn-flash mark { background-color: var(--text-highlight-bg) !important; transition: background-color 1s ease-out; }
              .gn-edit-row { display: flex; gap: 0.5rem; align-items: flex-start; margin-block: 0.4rem; }
              .gn-edit-row > label { min-width: 5rem; font-weight: 600; padding-top: 0.5rem; }
              .gn-edit-row textarea, .gn-edit-row input { flex: 1; width: 100%; }
              .gn-edit-row textarea { resize: vertical; font-family: var(--font-text); }
              .gn-edit-btnrow { display: flex; gap: 0.5rem; margin-top: 0.8rem; justify-content: flex-end; }
              .gn-browser { width: 60vw; height: 70vh; min-height: 20rem; min-width: 32rem; resize: both; display: flex; flex-direction: column; }
              .gn-body { flex: 1; display: flex; overflow: hidden; }
              .gn-tree { width: 40%; padding-right: .75rem; border-right: 1px solid var(--background-modifier-border); overflow-y: auto; overflow-x: hidden; }
              .gn-node > summary { cursor: pointer; font-weight: 600; }
              .gn-chap { margin-left: 1.2rem; cursor: pointer; }
              .gn-chap:hover { text-decoration: underline; }
              .gn-editor { flex: 1; padding-left: .75rem; overflow-y: auto; overflow-x: hidden; }
              .gn-cardrow { position: relative; margin: .15rem 0; padding-right: 2.8rem; cursor: pointer; width: 100%; border-radius: var(--radius-s); padding-left: 4px; }
              .gn-cardrow:hover { background: var(--background-secondary-hover); }
              .gn-trash { position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%); cursor: pointer; opacity: .6; }
              .gn-trash:hover { opacity: 1; }
              .gn-info { position: absolute; right: 2rem; top: 50%; transform: translateY(-50%); cursor: pointer; opacity: .6; }
              .gn-info:hover { opacity: 1; }
              .gn-ease-buttons, .gn-action-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; margin-top: 0.5rem; }
              .gn-ease-buttons button { flex-grow: 1; }
              .gn-info-grid { display: grid; grid-template-columns: 120px 1fr; gap: 0.5rem; margin-bottom: 1rem; }
              .gn-info-table-wrapper { max-height: 200px; overflow-y: auto; }
              .gn-info-table { width: 100%; text-align: left; }
              .gn-info-table th { border-bottom: 1px solid var(--background-modifier-border); }
              .gn-info-table td { padding-top: 4px; }
            `;
		document.head.appendChild(styleEl);
		this.register(() => styleEl.remove());
	}

	// =====================
	// Card Management
	// =====================

	private async addFlashcardFromSelection(
		selectedText: string,
		mdFile: TFile,
		paraHint?: number
	): Promise<void> {
		let paraIdx = paraHint;
		if (paraIdx === undefined) {
			const content = await this.app.vault.read(mdFile);
			paraIdx = findParaIdxInMarkdown(content, selectedText);
		}

		const card = this.createCardObject({
			front: "",
			back: "",
			tag: selectedText,
			chapter: mdFile.path,
			paraIdx,
		});

		const deckPath = getDeckPathForChapter(mdFile.path);
		const graph = await this.readDeck(deckPath);
		const deckFile = this.app.vault.getAbstractFileByPath(
			deckPath
		) as TFile | null;

		this.openEditModal(
			card,
			graph,
			deckFile ?? (await this.app.vault.create(deckPath, "{}")),
			() => new Notice("✅ Flashcard created.")
		);
	}

	public createCardObject(
		data: Partial<Flashcard> & {
			front: string;
			back: string;
			tag: string;
			chapter: string;
		}
	): Flashcard {
		return {
			id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
			front: data.front,
			back: data.back,
			tag: data.tag,
			chapter: data.chapter,
			paraIdx: data.paraIdx,
			status: "new",
			last_reviewed: null,
			interval: 0,
			ease_factor: 2.5,
			due: Date.now(),
			blocked: true,
			review_history: [],
		};
	}

	public async saveCards(
		sourceFile: TFile,
		newCards: Flashcard[]
	): Promise<void> {
		if (newCards.length === 0) return;
		const deckPath = getDeckPathForChapter(sourceFile.path);
		const graph = await this.readDeck(deckPath);
		newCards.forEach((card) => (graph[card.id] = card));
		await this.writeDeck(deckPath, graph);
	}

	public async recalculateParaIdx(
		file: TFile,
		showNotice = true
	): Promise<void> {
		if (showNotice)
			new Notice(
				`Recalculating paragraph indexes for "${file.basename}"...`
			);

		const noteContent = await this.app.vault.read(file);
		const paragraphs = getParagraphsFromFinalizedNote(noteContent);
		if (!paragraphs.length) {
			if (showNotice)
				new Notice("Note is not finalized. Cannot recalculate.");
			return;
		}

		const deckPath = getDeckPathForChapter(file.path);
		const graph = await this.readDeck(deckPath);
		if (Object.keys(graph).length === 0) return;

		const imageHashMap = new Map<string, number>();
		const imageRegex = /!\[\[([^\]]+)\]\]/g;

		for (const p of paragraphs) {
			let match;
			while ((match = imageRegex.exec(p.markdown)) !== null) {
				const imagePath = match[1];
				const imageFile = this.app.metadataCache.getFirstLinkpathDest(
					imagePath,
					file.path
				);
				if (imageFile instanceof TFile) {
					const hash = await this.calculateFileHash(imageFile);
					imageHashMap.set(hash, p.id);
				}
			}
		}

		let updatedCount = 0;
		let notFoundCount = 0;
		const cardsForChapter = Object.values(graph).filter(
			(c) => c.chapter === file.path
		);

		for (const card of cardsForChapter) {
			let newParaIdx: number | undefined;

			if (card.tag.startsWith("[[IMAGE HASH=")) {
				const hashMatch = card.tag.match(
					/\[\[IMAGE HASH=([a-f0-9]{64})\]\]/
				);
				if (hashMatch && imageHashMap.has(hashMatch[1])) {
					newParaIdx = imageHashMap.get(hashMatch[1]);
				}
			} else {
				newParaIdx = this.findBestParaForTag(card.tag, paragraphs);
			}

			if (newParaIdx !== undefined) {
				if (card.paraIdx !== newParaIdx) {
					card.paraIdx = newParaIdx;
					updatedCount++;
				}
			} else {
				notFoundCount++;
				this.logger(
					LogLevel.NORMAL,
					`Could not locate paragraph for card: "${card.front}" in file ${file.path}.`
				);
			}
		}

		if (updatedCount > 0) await this.writeDeck(deckPath, graph);

		if (showNotice) {
			let noticeText = `Recalculation complete. ${updatedCount} card index(es) updated.`;
			if (notFoundCount > 0)
				noticeText += ` ${notFoundCount} cards could not be located (see console).`;
			new Notice(noticeText);
		}
		this.refreshAllStatuses();
	}

	public async recalculateAllParaIndexes(): Promise<void> {
		if (this.isRecalculatingAll) {
			new Notice("Recalculation for all notes is already in progress.");
			return;
		}

		this.isRecalculatingAll = true;
		const markdownFiles = this.app.vault.getMarkdownFiles();
		new Notice(
			`Starting paragraph index recalculation for ${markdownFiles.length} notes...`
		);

		try {
			for (const file of markdownFiles) {
				await this.recalculateParaIdx(file, false);
			}
			new Notice(
				`✅ Recalculation complete for all ${markdownFiles.length} notes.`
			);
		} catch (e: unknown) {
			new Notice(`Recalculation failed: ${(e as Error).message}`);
			this.logger(
				LogLevel.NORMAL,
				"Error during bulk para index recalculation:",
				e
			);
		} finally {
			this.isRecalculatingAll = false;
		}
	}

	private async deleteChapterCards(file: TFile): Promise<void> {
		const deckPath = getDeckPathForChapter(file.path);
		if (!(await this.app.vault.adapter.exists(deckPath))) {
			new Notice("No flashcard deck found for this chapter's subject.");
			return;
		}

		const graph = await this.readDeck(deckPath);
		const cardsForChapter = Object.values(graph).filter(
			(c) => c.chapter === file.path
		);

		if (cardsForChapter.length === 0) {
			new Notice("No flashcards found for this specific chapter.");
			return;
		}
		if (
			!confirm(
				`Are you sure you want to delete ${cardsForChapter.length} flashcard(s) for "${file.basename}"? This cannot be undone.`
			)
		) {
			return;
		}

		for (const card of cardsForChapter) {
			delete graph[card.id];
		}

		await this.writeDeck(deckPath, graph);
		new Notice(
			`Deleted ${cardsForChapter.length} flashcard(s) for "${file.basename}".`
		);
		this.refreshAllStatuses();
		this.refreshReading();
	}

	private async handleRename(
		file: TAbstractFile,
		oldPath: string
	): Promise<void> {
		setTimeout(async () => {
			const allDecksToScan = new Set<string>([
				getDeckPathForChapter(oldPath),
				getDeckPathForChapter(file.path),
			]);

			for (const deckPath of allDecksToScan) {
				if (!(await this.app.vault.adapter.exists(deckPath))) continue;

				const graph = await this.readDeck(deckPath);
				let changed = false;
				const cardsToMove: Record<string, Flashcard[]> = {};

				for (const card of Object.values(graph)) {
					if (
						card.chapter === oldPath ||
						card.chapter.startsWith(`${oldPath}/`)
					) {
						const newCardPath = card.chapter.replace(
							oldPath,
							file.path
						);
						const newDeckPath = getDeckPathForChapter(newCardPath);
						card.chapter = newCardPath;
						changed = true;

						if (newDeckPath !== deckPath) {
							if (!cardsToMove[newDeckPath])
								cardsToMove[newDeckPath] = [];
							cardsToMove[newDeckPath].push(card);
							delete graph[card.id];
						}
					}
				}

				if (changed) await this.writeDeck(deckPath, graph);

				for (const newDeckPath in cardsToMove) {
					const targetGraph = await this.readDeck(newDeckPath);
					for (const cardToMove of cardsToMove[newDeckPath]) {
						targetGraph[cardToMove.id] = cardToMove;
					}
					await this.writeDeck(newDeckPath, targetGraph);
				}
			}

			this.refreshAllStatuses();
			this.decorateExplorer();
		}, 500);
	}

	// ===========================
	// --- IMAGE UTILITIES ---
	// ===========================

	private async getImageDb(): Promise<ImageAnalysisGraph> {
		const dbPath = normalizePath(
			this.app.vault.getRoot().path + IMAGE_ANALYSIS_FILE_NAME
		);
		if (!(await this.app.vault.adapter.exists(dbPath))) {
			return {};
		}
		try {
			const content = await this.app.vault.adapter.read(dbPath);
			return JSON.parse(content) as ImageAnalysisGraph;
		} catch (e) {
			this.logger(LogLevel.NORMAL, "Failed to read image DB", e);
			return {};
		}
	}

	private async writeImageDb(db: ImageAnalysisGraph): Promise<void> {
		const dbPath = normalizePath(
			this.app.vault.getRoot().path + IMAGE_ANALYSIS_FILE_NAME
		);
		await this.app.vault.adapter.write(dbPath, JSON.stringify(db, null, 2));
	}

	private async calculateFileHash(file: TFile): Promise<string> {
		const arrayBuffer = await this.app.vault.readBinary(file);
		const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	private async analyzeImage(
		imageFile: TFile
	): Promise<ImageAnalysis | null> {
		const notice = new Notice(
			`🤖 Analyzing image: ${imageFile.name}...`,
			0
		);
		try {
			const imageData = await this.app.vault.readBinary(imageFile);
			const base64Image = Buffer.from(imageData).toString("base64");
			const fileExtension = imageFile.extension
				.toLowerCase()
				.replace("jpg", "jpeg");
			const imageUrl = `data:image/${fileExtension};base64,${base64Image}`;

			const prompt = `You are an expert academic analyst specializing in visual media. Your task is to analyze the provided image and return a single, valid JSON object that classifies and describes it for study purposes.

**Step 1: Classify the Image**
First, determine the image's primary category and set the \`type\` key to ONE of the following exact string values:
* \`diagram\`
* \`chart\`
* \`map\`
* \`artwork\`
* \`photograph\`
* \`screenshot\`

**Step 2: Generate a Structured Description**
Based on the \`type\` you chose, create a corresponding \`description\` object with the following required structure:

* If \`type\` is \`diagram\` or \`chart\`: The \`description\` object must contain:
    * \`title\`: A string for the official title or a concise summary if none exists.
    * \`components\`: An array of strings, listing each key labeled part or element.
    * \`relationships\`: A string explaining how the components interact, focusing on the meaning of arrows, lines, and spatial arrangement.

* If \`type\` is \`map\`: The \`description\` object must contain:
    * \`region\`: A string identifying the main geographical area shown.
    * \`key_locations\`: An array of strings listing important labeled cities, countries, or landmarks.
    * \`purpose\`: A string explaining what the map illustrates (e.g., "Political boundaries in 1815," "Topographical features of the Andes").

* If \`type\` is \`artwork\` or \`photograph\`: The \`description\` object must contain:
    * \`subject\`: A string describing the central subject and any action taking place.
    * \`composition\`: A string detailing the arrangement, use of color, light, and perspective.
    * \`mood\`: A string describing the overall feeling or tone the image evokes.

* If \`type\` is \`screenshot\`: The \`description\` object must contain:
    * \`interface_element\`: A string identifying the application or primary UI element shown.
    * \`action\`: A string describing the task being performed or the information being displayed.

**Your final output must be ONLY the JSON object, with no other text, explanations, or markdown formatting.**`;

			const response = await this.sendToLlm(prompt, imageUrl);
			if (!response) throw new Error("LLM returned an empty response.");

			const analysis = extractJsonObjects<any>(response)[0];
			if (!analysis || !analysis.type || !analysis.description) {
				throw new Error(
					"LLM response was not in the expected JSON format."
				);
			}

			return {
				path: imageFile.path,
				analysis: analysis,
			};
		} catch (e: unknown) {
			this.logger(
				LogLevel.NORMAL,
				`Failed to analyze image ${imageFile.path}`,
				e
			);
			new Notice(`⚠️ Failed to analyze image: ${(e as Error).message}`);
			return null;
		} finally {
			notice.hide();
		}
	}

	private async renderCardContent(
		content: string,
		container: HTMLElement,
		sourcePath: string
	) {
		let processedContent = content;
		const imageRegex = /\[\[IMAGE HASH=([a-f0-9]{64})\]\]/g;
		let match;
		const contentToScan = content;
		const imageDb = await this.getImageDb();

		while ((match = imageRegex.exec(contentToScan)) !== null) {
			const hash = match[1];
			const imageInfo = imageDb[hash];
			if (imageInfo) {
				processedContent = processedContent.replace(
					match[0],
					`![[${imageInfo.path}]]`
				);
			} else {
				processedContent = processedContent.replace(
					match[0],
					`> [!warning] Gated Notes: Image with hash ${hash.substring(
						0,
						8
					)}... not found in database.`
				);
			}
		}

		await MarkdownRenderer.render(
			this.app,
			fixMath(processedContent),
			container,
			sourcePath,
			this
		);
	}

	// =====================
	// UI & UX
	// =====================

	private async openReviewModal(
		card: Flashcard,
		deck: TFile
	): Promise<ReviewResult> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			makeModalDraggable(modal, this);

			const pathParts = card.chapter.split("/");
			const subject = pathParts.length > 1 ? pathParts[0] : "Vault";
			const chapterName = (pathParts.pop() || card.chapter).replace(
				/\.md$/,
				""
			);
			modal.titleEl.setText(`${subject} ► ${chapterName}`);

			let settled = false;
			const safeResolve = (v: ReviewResult) => {
				if (settled) return;
				settled = true;
				resolve(v);
			};

			let state: ReviewResult = "abort";
			modal.onClose = () => safeResolve(state);

			const frontContainer = modal.contentEl.createDiv();
			this.renderCardContent(card.front, frontContainer, card.chapter);

			const bottomBar = modal.contentEl.createDiv({
				cls: "gn-action-bar",
			});

			const revealBtn = new ButtonComponent(bottomBar)
				.setButtonText("Show Answer")
				.setCta();

			modal.contentEl.createEl("hr");

			const showAnswer = async () => {
				revealBtn.buttonEl.style.display = "none";

				const backContainer = modal.contentEl.createDiv();
				await this.renderCardContent(
					card.back,
					backContainer,
					card.chapter
				);

				const easeButtonContainer = modal.contentEl.createDiv({
					cls: "gn-ease-buttons",
				});

				(["Again", "Hard", "Good", "Easy"] as const).forEach(
					(lbl: CardRating) => {
						new ButtonComponent(easeButtonContainer)
							.setButtonText(lbl)
							.onClick(async () => {
								const graph = await this.readDeck(deck.path);
								this.applySm2(card, lbl);
								graph[card.id] = card;
								await this.writeDeck(deck.path, graph);
								this.refreshReading();
								state = lbl === "Again" ? "again" : "answered";
								modal.close();
							});
					}
				);
				modal.contentEl.insertBefore(easeButtonContainer, bottomBar);
			};

			revealBtn.onClick(showAnswer);

			new ButtonComponent(bottomBar)
				.setIcon("trash")
				.setTooltip("Delete")
				.onClick(async () => {
					if (confirm("Delete this card permanently?")) {
						const graph = await this.readDeck(deck.path);
						delete graph[card.id];
						await this.writeDeck(deck.path, graph);
						this.refreshReading();
						state = "answered";
						modal.close();
					}
				});

			new ButtonComponent(bottomBar)
				.setIcon("pencil")
				.setTooltip("Edit")
				.onClick(async () => {
					const graph = await this.readDeck(deck.path);
					this.openEditModal(card, graph, deck, () => {});
				});

			new ButtonComponent(bottomBar)
				.setIcon("info")
				.setTooltip("Info")
				.onClick(() => new CardInfoModal(this.app, card).open());

			new ButtonComponent(bottomBar)
				.setIcon("link")
				.setTooltip("Context")
				.onClick(() => this.jumpToTag(card));

			new ButtonComponent(bottomBar)
				.setIcon("file-down")
				.setTooltip("Bury")
				.onClick(async () => {
					const graph = await this.readDeck(deck.path);
					graph[card.id].due =
						Date.now() + this.settings.buryDelayHours * 3_600_000;
					await this.writeDeck(deck.path, graph);
					this.refreshReading();
					state = "answered";
					modal.close();
				});

			new ButtonComponent(bottomBar).setButtonText("Skip").onClick(() => {
				state = "skip";
				modal.close();
			});

			modal.open();
		});
	}

	public openEditModal(
		card: Flashcard,
		graph: FlashcardGraph,
		deck: TFile,
		onDone: () => void
	): void {
		new EditModal(this, card, graph, deck, onDone).open();
	}

	private async promptForCardCount(
		file: TFile,
		callback: (count: number) => void
	): Promise<void> {
		const wrappedContent = await this.app.vault.read(file);
		const plainText = getParagraphsFromFinalizedNote(wrappedContent)
			.map((p) => p.markdown)
			.join("\n\n");
		const wordCount = plainText.split(/\s+/).filter(Boolean).length;
		const defaultCardCount = Math.max(1, Math.round(wordCount / 100));
		new CountModal(this, defaultCardCount, callback).open();
	}

	private showUnfinalizeConfirmModal(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText("Un-finalize Note");
			modal.contentEl.createEl("p", {
				text: "This note has associated flashcards. Do you want to keep them or delete them?",
			});

			const buttonContainer = modal.contentEl.createDiv({
				cls: "gn-edit-btnrow",
			});

			new ButtonComponent(buttonContainer)
				.setButtonText("No, keep my cards")
				.setCta()
				.onClick(() => {
					modal.close();
					resolve(false);
				});

			new ButtonComponent(buttonContainer)
				.setButtonText("Yes, delete")
				.setWarning()
				.onClick(() => {
					modal.close();
					resolve(true);
				});

			modal.onClose = () => resolve(false);
			modal.open();
		});
	}

	// =====================
	// Status & State
	// =====================

	public async refreshAllStatuses(): Promise<void> {
		this.refreshDueCardStatus();
		this.updateMissingParaIdxStatus();
	}

	public refreshDueCardStatus(): void {
		if (this.statusRefreshQueued) return;
		this.statusRefreshQueued = true;

		setTimeout(async () => {
			this.statusRefreshQueued = false;
			let learningDue = 0,
				reviewDue = 0;
			const now = Date.now();
			const allDeckFiles = this.app.vault
				.getFiles()
				.filter((f) => f.name.endsWith(DECK_FILE_NAME));

			for (const deck of allDeckFiles) {
				const graph = await this.readDeck(deck.path);
				for (const c of Object.values(graph)) {
					if (c.due > now) continue;
					if (["new", "learning", "relearn"].includes(c.status)) {
						learningDue++;
					} else {
						reviewDue++;
					}
				}
			}
			this.statusBar.setText(
				`GN: ${learningDue} learning, ${reviewDue} review`
			);
		}, 150);
	}

	public async updateMissingParaIdxStatus(): Promise<void> {
		let count = 0;
		const allDeckFiles = this.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));

		for (const deck of allDeckFiles) {
			const graph = await this.readDeck(deck.path);
			for (const card of Object.values(graph)) {
				if (card.paraIdx === undefined || card.paraIdx === null) {
					count++;
				}
			}
		}

		if (count > 0) {
			this.cardsMissingParaIdxStatus.setText(
				`GN Missing Index: ${count}`
			);
			this.cardsMissingParaIdxStatus.setAttribute(
				"aria-label",
				`${count} cards are missing a paragraph index. Click to view.`
			);
		} else {
			this.cardsMissingParaIdxStatus.setText("");
			this.cardsMissingParaIdxStatus.setAttribute(
				"aria-label",
				"All cards have a paragraph index."
			);
		}
	}

	private async toggleGating(): Promise<void> {
		this.settings.gatingEnabled = !this.settings.gatingEnabled;
		await this.saveSettings();
		this.updateGatingStatus();
		this.refreshReading();
		new Notice(
			`Content gating ${
				this.settings.gatingEnabled ? "enabled" : "disabled"
			}.`
		);
	}

	private updateGatingStatus(): void {
		this.gatingStatus.setText(this.settings.gatingEnabled ? "🔒" : "🔓");
		this.gatingStatus.setAttribute(
			"aria-label",
			`Content gating is ${
				this.settings.gatingEnabled ? "ON" : "OFF"
			}. Click to toggle.`
		);
	}

	private async getChapterState(
		chapterPath: string
	): Promise<keyof typeof ICONS | undefined> {
		const deckPath = getDeckPathForChapter(chapterPath);
		if (!(await this.app.vault.adapter.exists(deckPath))) return undefined;

		const graph = await this.readDeck(deckPath);
		const cards = Object.values(graph).filter(
			(c) => c.chapter === chapterPath
		);

		if (cards.length === 0) return undefined;
		if (cards.some((c) => c.blocked)) return "blocked";
		if (cards.some((c) => c.due <= Date.now())) return "due";
		return "done";
	}

	// =====================
	// LLM & API
	// =====================

	public async sendToLlm(prompt: string, imageUrl?: string): Promise<string> {
		const {
			apiProvider,
			lmStudioUrl,
			lmStudioModel,
			openaiApiKey,
			openaiTemperature,
		} = this.settings;

		if (apiProvider === "lmstudio" && imageUrl) {
			new Notice("Image analysis is not supported with LM Studio.");
			return "";
		}

		let apiUrl: string;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		let model: string;

		if (apiProvider === "lmstudio") {
			apiUrl = `${lmStudioUrl.replace(/\/$/, "")}/v1/chat/completions`;
			model = lmStudioModel;
		} else {
			if (!openaiApiKey) {
				new Notice("OpenAI API key is not set in plugin settings.");
				return "";
			}
			apiUrl = API_URL_COMPLETIONS;
			model = imageUrl
				? this.settings.openaiMultimodalModel
				: this.settings.openaiModel;
			headers["Authorization"] = `Bearer ${openaiApiKey}`;
		}

		try {
			const messageContent: any = imageUrl
				? [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: imageUrl } },
				  ]
				: prompt;

			const payload = {
				model,
				temperature: openaiTemperature,
				messages: [{ role: "user", content: messageContent }],
			};

			if (imageUrl) {
				this.logger(
					LogLevel.VERBOSE,
					"Sending multimodal payload to LLM:",
					payload
				);
			} else {
				this.logger(
					LogLevel.VERBOSE,
					"Sending payload to LLM:",
					payload
				);
			}

			const response = await requestUrl({
				url: apiUrl,
				method: "POST",
				headers,
				body: JSON.stringify(payload),
			});

			if (imageUrl) {
				this.logger(
					LogLevel.VERBOSE,
					"Received multimodal payload from LLM:",
					response.json
				);
			}

			const responseText =
				response.json.choices?.[0]?.message?.content ?? "";
			this.logger(
				LogLevel.VERBOSE,
				"Received response content from LLM:",
				responseText
			);
			return responseText;
		} catch (e: unknown) {
			this.logger(LogLevel.NORMAL, `API Error for ${apiProvider}:`, e);
			new Notice(`${apiProvider} API error – see developer console.`);
			return "";
		}
	}

	public async fetchAvailableModels(): Promise<string[]> {
		const { apiProvider, lmStudioUrl, openaiApiKey } = this.settings;
		let apiUrl: string;
		const headers: Record<string, string> = {};

		if (apiProvider === "lmstudio") {
			apiUrl = `${lmStudioUrl.replace(/\/$/, "")}/v1/models`;
		} else {
			if (!openaiApiKey) {
				new Notice("OpenAI API key is not set in plugin settings.");
				return [];
			}
			apiUrl = API_URL_MODELS;
			headers["Authorization"] = `Bearer ${openaiApiKey}`;
		}

		try {
			const response = await requestUrl({
				url: apiUrl,
				method: "GET",
				headers,
			});
			const modelIds = response.json.data.map(
				(m: { id: string }) => m.id
			) as string[];
			this.settings.availableModels = modelIds;
			await this.saveSettings();
			return modelIds;
		} catch (e: unknown) {
			this.logger(
				LogLevel.NORMAL,
				`Error fetching models from ${apiProvider}:`,
				e
			);
			new Notice(
				`Could not fetch models from ${apiProvider}. Check settings and console.`
			);
			return [];
		}
	}

	// =====================
	// Settings & Data I/O
	// =====================

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	public async readDeck(deckPath: string): Promise<FlashcardGraph> {
		if (!(await this.app.vault.adapter.exists(deckPath))) return {};
		try {
			const content = await this.app.vault.adapter.read(deckPath);
			return JSON.parse(content) as FlashcardGraph;
		} catch (e: unknown) {
			this.logger(
				LogLevel.NORMAL,
				`Failed to parse deck at ${deckPath}:`,
				e
			);
			new Notice(
				`Warning: Could not read flashcard file at ${deckPath}. File may be corrupt.`
			);
			return {};
		}
	}

	public async writeDeck(
		deckPath: string,
		graph: FlashcardGraph
	): Promise<void> {
		const content = JSON.stringify(graph, null, 2);
		try {
			const file = this.app.vault.getAbstractFileByPath(deckPath);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, content);
			} else {
				if (file) {
					this.logger(
						LogLevel.NORMAL,
						`Deck path is a folder, cannot write file: ${deckPath}`
					);
					new Notice(
						`Error: Cannot save flashcards, path is a folder.`
					);
					return;
				}
				await this.app.vault.create(deckPath, content);
			}
		} catch (e: unknown) {
			this.logger(
				LogLevel.NORMAL,
				`Failed to write deck to ${deckPath}`,
				e
			);
			new Notice(`Error: Failed to save flashcards to ${deckPath}.`);
		}
	}

	private findBestParaForTag(
		tag: string,
		paragraphs: { id: number; markdown: string }[]
	): number | undefined {
		if (!tag) return undefined;

		const LCS_WEIGHT = 0.7;
		const BOW_WEIGHT = 0.3;
		const FINAL_SCORE_THRESHOLD = 0.5;

		const normalize = (s: string) =>
			s
				.toLowerCase()
				.replace(/[^\w\s]/g, "")
				.replace(/\s+/g, " ")
				.trim();

		const normalizedTag = normalize(tag);
		const tagWords = normalizedTag.split(" ");
		const uniqueTagWords = new Set(tagWords);
		if (uniqueTagWords.size === 0) return undefined;

		let bestMatch = { score: 0, paraId: -1 };

		for (const para of paragraphs) {
			const normalizedPara = normalize(para.markdown);
			if (!normalizedPara) continue;

			const wordsFound = [...uniqueTagWords].filter((word) =>
				normalizedPara.includes(word)
			).length;
			const scoreBoW = wordsFound / uniqueTagWords.size;

			let longestMatchInPara = 0;
			for (let i = 0; i < tagWords.length; i++) {
				for (let j = i + 1; j <= tagWords.length; j++) {
					const subArray = tagWords.slice(i, j);
					const subString = subArray.join(" ");
					if (
						subArray.length > longestMatchInPara &&
						normalizedPara.includes(subString)
					) {
						longestMatchInPara = subArray.length;
					}
				}
			}
			const scoreLCS = longestMatchInPara / tagWords.length;

			const finalScore = scoreBoW * BOW_WEIGHT + scoreLCS * LCS_WEIGHT;

			if (finalScore > bestMatch.score) {
				bestMatch = { score: finalScore, paraId: para.id };
			}
		}

		return bestMatch.score >= FINAL_SCORE_THRESHOLD
			? bestMatch.paraId
			: undefined;
	}
}

// ===================================================================
//
//                          UI COMPONENT CLASSES
//
// ===================================================================

class EditModal extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private card: Flashcard,
		private graph: FlashcardGraph,
		private deck: TFile,
		private onDone: () => void
	) {
		super(plugin.app);
	}

	onOpen() {
		makeModalDraggable(this, this.plugin);
		this.titleEl.setText("Edit Card");
		this.contentEl.addClass("gn-edit-container");

		const createRow = (label: string): HTMLElement => {
			const row = this.contentEl.createDiv({ cls: "gn-edit-row" });
			row.createEl("label", { text: label });
			return row;
		};

		const frontInput = createRow("Front:").createEl("textarea", {
			attr: { rows: 3 },
		});
		frontInput.value = this.card.front;

		const backInput = createRow("Back:").createEl("textarea", {
			attr: { rows: 3 },
		});
		backInput.value = this.card.back;

		const tagInput = createRow("Tag:").createEl("textarea", {
			attr: { rows: 2 },
		});
		tagInput.value = this.card.tag;

		const paraInput = createRow("Para #:").createEl("input", {
			type: "number",
			value: (this.card.paraIdx ?? "").toString(),
		});

		const btnRow = this.contentEl.createDiv({ cls: "gn-edit-btnrow" });

		new ButtonComponent(btnRow)
			.setButtonText("Refocus with AI")
			.onClick(this.handleRefocus.bind(this));
		new ButtonComponent(btnRow)
			.setButtonText("Split with AI")
			.onClick(this.handleSplit.bind(this));
		new ButtonComponent(btnRow)
			.setButtonText("Save")
			.setCta()
			.onClick(async () => {
				this.card.front = frontInput.value.trim();
				this.card.back = backInput.value.trim();
				this.card.tag = tagInput.value.trim();
				this.card.paraIdx = Number(paraInput.value) || undefined;
				this.graph[this.card.id] = this.card;
				await this.plugin.writeDeck(this.deck.path, this.graph);
				this.plugin.refreshReading();
				this.plugin.refreshAllStatuses();
				this.close();
				this.onDone();
			});
	}

	private _createCardsFromLlmResponse(response: string): Flashcard[] {
		const items = extractJsonObjects<{ front: string; back: string }>(
			response
		).filter((i) => i.front && i.back);

		return items.map((i) =>
			this.plugin.createCardObject({
				front: i.front.trim(),
				back: i.back.trim(),
				tag: this.card.tag, // keep existing tag
				chapter: this.card.chapter,
				paraIdx: this.card.paraIdx,
			})
		);
	}

	private async handleRefocus(evt: MouseEvent) {
		const buttonEl = evt.target as HTMLButtonElement;
		buttonEl.disabled = true;
		buttonEl.setText("Refocusing...");
		new Notice("🤖 Generating alternative card...");

		try {
			const cardJson = JSON.stringify({
				front: this.card.front,
				back: this.card.back,
			});
			const prompt = `You are an AI assistant that helps refine study materials by creating "reverse" flashcards. Given an existing flashcard, take the information from the 'Back' and use it to form a new 'Front'. The subject of the original 'Front' should become the new 'Back'.

Example:
Original: { "Front": "What is the function of mitochondria?", "Back": "They generate ATP for the cell." }
Reversed: { "Front": "Which organelle generates ATP for the cell?", "Back": "Mitochondria" }

Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]

---
**Original Card:**
${cardJson}

**Source Text for Context:**
${JSON.stringify(this.card.tag)}
---`;

			const response = await this.plugin.sendToLlm(prompt);
			if (!response) throw new Error("LLM returned an empty response.");

			const newCards = this._createCardsFromLlmResponse(response);
			if (newCards.length === 0)
				throw new Error(
					"Could not parse any new cards from the LLM response."
				);

			const file = this.app.vault.getAbstractFileByPath(
				this.card.chapter
			) as TFile;
			if (!file)
				throw new Error(
					"Could not find the source file for the new cards."
				);

			await this.plugin.saveCards(file, newCards);
			new Notice(`✅ Added ${newCards.length} new alternative card(s).`);
			this.plugin.refreshAllStatuses();
			this.close();
			this.onDone();
		} catch (e: unknown) {
			new Notice(`Failed to generate cards: ${(e as Error).message}`);
			this.plugin.logger(LogLevel.NORMAL, "Failed to refocus card:", e);
		} finally {
			buttonEl.disabled = false;
			buttonEl.setText("Refocus with AI");
		}
	}

	private async handleSplit(evt: MouseEvent) {
		const buttonEl = evt.target as HTMLButtonElement;
		buttonEl.disabled = true;
		buttonEl.setText("Splitting...");
		new Notice("🤖 Splitting card with AI...");

		try {
			const cardJson = JSON.stringify({
				front: this.card.front,
				back: this.card.back,
			});
			const prompt = `Take the following flashcard and split it into one or more new, simpler, more atomic flashcards. The original card may be too complex or cover multiple ideas.

Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]

---
**Original Card:**
${cardJson}
---`;
			const response = await this.plugin.sendToLlm(prompt);
			if (!response) throw new Error("LLM returned an empty response.");

			const newCards = this._createCardsFromLlmResponse(response);
			if (newCards.length === 0)
				throw new Error(
					"Could not parse any new cards from LLM response."
				);

			delete this.graph[this.card.id];
			newCards.forEach((newCard) => (this.graph[newCard.id] = newCard));

			await this.plugin.writeDeck(this.deck.path, this.graph);
			this.plugin.refreshReading();
			this.plugin.refreshAllStatuses();
			new Notice(`✅ Split card into ${newCards.length} new card(s).`);
			this.close();
			this.onDone();
		} catch (e: unknown) {
			new Notice(`Error splitting card: ${(e as Error).message}`);
			this.plugin.logger(LogLevel.NORMAL, "Failed to split card:", e);
		} finally {
			buttonEl.disabled = false;
			buttonEl.setText("Split with AI");
		}
	}
}

class CardBrowser extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private filter?: (card: Flashcard) => boolean
	) {
		super(plugin.app);
	}

	async onOpen() {
		this.modalEl.addClass("gn-browser");
		this.titleEl.setText(
			this.filter ? "Card Browser (Filtered)" : "Card Browser"
		);
		makeModalDraggable(this, this.plugin);

		const body = this.contentEl.createDiv({ cls: "gn-body" });
		const treePane = body.createDiv({ cls: "gn-tree" });
		const editorPane = body.createDiv({ cls: "gn-editor" });
		editorPane.setText("← Choose a chapter to view its cards");

		const showCardsForChapter = async (
			deck: TFile,
			chapterPath: string
		) => {
			editorPane.empty();
			const graph = await this.plugin.readDeck(deck.path);
			let cards: Flashcard[] = Object.values(graph).filter(
				(c) => c.chapter === chapterPath
			);

			if (this.filter) cards = cards.filter(this.filter);
			if (!cards.length) {
				editorPane.setText(
					"No cards in this chapter match the current filter."
				);
				return;
			}

			cards.sort(
				(a, b) => (a.paraIdx ?? Infinity) - (b.paraIdx ?? Infinity)
			);

			for (const card of cards) {
				const row = editorPane.createDiv({ cls: "gn-cardrow" });
				row.setText(card.front || "(empty front)");
				row.onclick = () => {
					this.plugin.openEditModal(card, graph, deck, () => {
						showCardsForChapter(deck, chapterPath);
					});
				};

				row.createEl("span", { text: "ℹ️", cls: "gn-info" }).onclick = (
					ev
				) => {
					ev.stopPropagation();
					new CardInfoModal(this.plugin.app, card).open();
				};
				row.createEl("span", { text: "🗑️", cls: "gn-trash" }).onclick =
					async (ev) => {
						ev.stopPropagation();
						if (!confirm("Delete this card permanently?")) return;
						delete graph[card.id];
						await this.plugin.writeDeck(deck.path, graph);
						row.remove();
						this.plugin.refreshAllStatuses();
					};
			}
		};

		const decks = this.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));
		for (const deck of decks) {
			const graph = await this.plugin.readDeck(deck.path);
			let cardsInDeck = Object.values(graph);

			if (this.filter) cardsInDeck = cardsInDeck.filter(this.filter);
			if (cardsInDeck.length === 0) continue;

			const subject = deck.path.split("/")[0] || "Vault Root";
			const subjectEl = treePane.createEl("details", {
				cls: "gn-node",
				attr: { open: true },
			});
			subjectEl.createEl("summary", { text: subject });

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
				}).onclick = () => showCardsForChapter(deck, chapterPath);
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class CountModal extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private defaultValue: number,
		private callback: (num: number) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Cards to Generate");
		makeModalDraggable(this, this.plugin);
		this.contentEl.createEl("p", {
			text: "How many cards should the AI generate for this note?",
		});

		const input = new TextComponent(this.contentEl).setValue(
			String(this.defaultValue)
		);
		input.inputEl.type = "number";
		input.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit(input.getValue());
			}
		});

		new ButtonComponent(this.contentEl)
			.setButtonText("Generate")
			.setCta()
			.onClick(() => this.submit(input.getValue()));

		setTimeout(() => input.inputEl.focus(), 50);
	}

	private submit(value: string) {
		const num = Number(value);
		this.close();
		this.callback(num > 0 ? num : this.defaultValue);
	}
}

class GenerateAdditionalCardsModal extends Modal {
	private countInput!: TextComponent;
	private preventDuplicatesToggle!: ToggleComponent;

	constructor(
		private plugin: GatedNotesPlugin,
		private file: TFile,
		private existingCards: Flashcard[],
		private callback: (
			result: {
				count: number;
				preventDuplicates: boolean;
			} | null
		) => void
	) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Generate Additional Cards");
		makeModalDraggable(this, this.plugin);

		this.contentEl.createEl("p", {
			text: `This note already has ${this.existingCards.length} card(s). How many *additional* cards should the AI generate?`,
		});

		const wrappedContent = await this.plugin.app.vault.read(this.file);
		const plainText = getParagraphsFromFinalizedNote(wrappedContent)
			.map((p) => p.markdown)
			.join("\n\n");
		const wordCount = plainText.split(/\s+/).filter(Boolean).length;
		const defaultCardCount = Math.max(1, Math.round(wordCount / 100));

		new Setting(this.contentEl)
			.setName("Number of cards to generate")
			.addText((text) => {
				this.countInput = text;
				text.setValue(String(defaultCardCount));
				text.inputEl.type = "number";
			});

		new Setting(this.contentEl)
			.setName("Prevent creating duplicate cards")
			.setDesc(
				"Sends existing cards to the AI for context to avoid creating similar ones. (This will increase API token usage)."
			)
			.addToggle((toggle) => {
				this.preventDuplicatesToggle = toggle;
				toggle.setValue(true);
			});

		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText("Generate")
					.setCta()
					.onClick(() => {
						const count = Number(this.countInput.getValue());
						this.callback({
							count: count > 0 ? count : defaultCardCount,
							preventDuplicates:
								this.preventDuplicatesToggle.getValue(),
						});
						this.close();
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.callback(null);
					this.close();
				})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class CardInfoModal extends Modal {
	constructor(app: App, private card: Flashcard) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Card Information");
		const { contentEl } = this;

		contentEl.createEl("h4", { text: "Current State" });
		const grid = contentEl.createDiv({ cls: "gn-info-grid" });
		const addStat = (label: string, value: string) => {
			grid.createEl("strong", { text: label });
			grid.createEl("span", { text: value });
		};

		addStat("Status:", this.card.status);
		addStat("Interval:", `${this.card.interval.toFixed(2)} days`);
		addStat("Ease:", `${(this.card.ease_factor * 100).toFixed(0)}%`);
		addStat("Due:", new Date(this.card.due).toLocaleString());

		contentEl.createEl("h4", { text: "Review History" });
		if (
			!this.card.review_history ||
			this.card.review_history.length === 0
		) {
			contentEl.createEl("p", {
				text: "No review history recorded yet.",
			});
			return;
		}

		const tableWrapper = contentEl.createDiv({
			cls: "gn-info-table-wrapper",
		});
		const table = tableWrapper.createEl("table", { cls: "gn-info-table" });
		const header = table.createEl("thead").createEl("tr");
		["Date", "Rating", "State", "Interval"].forEach((text) =>
			header.createEl("th", { text })
		);

		const tbody = table.createEl("tbody");
		const historyToShow = this.card.review_history.slice(-10);

		for (const log of historyToShow) {
			const row = tbody.createEl("tr");
			row.createEl("td", {
				text: new Date(log.timestamp).toLocaleDateString(),
			});
			row.createEl("td", { text: log.rating });
			row.createEl("td", { text: log.state });
			row.createEl("td", { text: `${log.interval.toFixed(1)}d` });
		}
	}
}

class GNSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: GatedNotesPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Gated Notes Settings" });

		// --- AI Provider Section ---
		new Setting(containerEl).setName("AI Provider").setHeading();
		new Setting(containerEl)
			.setName("API Provider")
			.setDesc("Choose the AI provider for text-based card generation.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("openai", "OpenAI")
					.addOption("lmstudio", "LM Studio")
					.setValue(this.plugin.settings.apiProvider)
					.onChange(async (value) => {
						this.plugin.settings.apiProvider = value as
							| "openai"
							| "lmstudio";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (
			this.plugin.settings.apiProvider === "openai" ||
			this.plugin.settings.analyzeImagesOnGenerate
		) {
			new Setting(containerEl)
				.setName("OpenAI API key")
				.setDesc(
					"Required for OpenAI text generation and/or image analysis."
				)
				.addText((text) =>
					text
						.setPlaceholder("sk-…")
						.setValue(this.plugin.settings.openaiApiKey)
						.onChange(async (value) => {
							this.plugin.settings.openaiApiKey = value;
							await this.plugin.saveSettings();
						})
				);
		}

		if (this.plugin.settings.apiProvider === "openai") {
			new Setting(containerEl)
				.setName("OpenAI Text Model")
				.addDropdown((dropdown) => {
					this.plugin.settings.availableModels.forEach((model) =>
						dropdown.addOption(model, model)
					);
					dropdown
						.setValue(this.plugin.settings.openaiModel)
						.onChange(async (value) => {
							this.plugin.settings.openaiModel = value;
							await this.plugin.saveSettings();
						});
				});
		} else {
			// This is the LM Studio block
			new Setting(containerEl)
				.setName("LM Studio Server URL")
				.addText((text) =>
					text
						.setPlaceholder("http://localhost:1234")
						.setValue(this.plugin.settings.lmStudioUrl)
						.onChange(async (value) => {
							this.plugin.settings.lmStudioUrl = value;
							await this.plugin.saveSettings();
						})
				);
			new Setting(containerEl)
				.setName("LM Studio Model")
				.addDropdown((dropdown) => {
					this.plugin.settings.availableModels.forEach((model) =>
						dropdown.addOption(model, model)
					);
					dropdown
						.setValue(this.plugin.settings.lmStudioModel)
						.onChange(async (value) => {
							this.plugin.settings.lmStudioModel = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Fetch available models")
			.setDesc("Update the model list from the selected provider.")
			.addButton((button) =>
				button.setButtonText("Fetch").onClick(async () => {
					button.setDisabled(true).setButtonText("Fetching...");
					try {
						await this.plugin.fetchAvailableModels();
						new Notice("Fetched models.");
					} finally {
						this.display();
					}
				})
			);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc(
				"Controls randomness. 0 is deterministic, 1 is max creativity."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.01)
					.setValue(this.plugin.settings.openaiTemperature)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.openaiTemperature = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Card Generation Section ---
		new Setting(containerEl).setName("Card Generation").setHeading();

		new Setting(containerEl)
			.setName("Analyze images on generate (Experimental)")
			.setDesc(
				"Analyze images using an OpenAI vision model. This feature requires an OpenAI API key regardless of the main provider setting."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.analyzeImagesOnGenerate)
					.onChange(async (value) => {
						this.plugin.settings.analyzeImagesOnGenerate = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.analyzeImagesOnGenerate) {
			new Setting(containerEl)
				.setName("OpenAI Multimodal Model")
				.setDesc(
					"Model for image analysis (e.g., gpt-4o, gpt-4o-mini)."
				)
				.addDropdown((dropdown) => {
					dropdown.addOption("gpt-4o", "gpt-4o");
					dropdown.addOption("gpt-4o-mini", "gpt-4o-mini");
					dropdown
						.setValue(this.plugin.settings.openaiMultimodalModel)
						.onChange(async (value) => {
							this.plugin.settings.openaiMultimodalModel = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Auto-correct AI tags")
			.setDesc(
				"If enabled, the plugin will ask the AI to fix tags that aren't verbatim quotes."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCorrectTags)
					.onChange(async (value) => {
						this.plugin.settings.autoCorrectTags = value;
						await this.plugin.saveSettings();
						// --- NEW: Re-render to show/hide the retries setting ---
						this.display();
					})
			);

		if (this.plugin.settings.autoCorrectTags) {
			new Setting(containerEl)
				.setName("Max tag correction retries")
				.setDesc(
					"How many times to ask the AI to fix a single bad tag before giving up."
				)
				.addText((text) =>
					text
						.setPlaceholder("2")
						.setValue(
							String(this.plugin.settings.maxTagCorrectionRetries)
						)
						.onChange(async (value) => {
							const num = parseInt(value, 10);
							if (!isNaN(num) && num >= 0) {
								this.plugin.settings.maxTagCorrectionRetries =
									num;
								await this.plugin.saveSettings();
							}
						})
				);
		}

		// --- Spaced Repetition Section ---
		new Setting(containerEl).setName("Spaced Repetition").setHeading();
		this.createNumericArraySetting(
			containerEl,
			"Learning steps (minutes)",
			"Intervals for new cards. Comma-separated.",
			"1, 10",
			"learningSteps"
		);
		this.createNumericArraySetting(
			containerEl,
			"Re-learn steps (minutes)",
			"Used after pressing ‘Again’ on a mature card.",
			"10",
			"relearnSteps"
		);
		new Setting(containerEl)
			.setName("Bury delay (hours)")
			.setDesc("How long a buried card is hidden from review.")
			.addText((text) =>
				text
					.setPlaceholder("24")
					.setValue(String(this.plugin.settings.buryDelayHours))
					.onChange(async (value) => {
						const num = Number(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.buryDelayHours = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- Content Gating Section ---
		new Setting(containerEl).setName("Content Gating").setHeading();
		new Setting(containerEl)
			.setName("Enable content gating")
			.setDesc("If disabled, all finalized content will be visible.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.gatingEnabled)
					.onChange(async (value) => {
						this.plugin.settings.gatingEnabled = value;
						await this.plugin.saveSettings();
						(this.plugin as any).updateGatingStatus();
						this.plugin.refreshReading();
					})
			);

		// --- Debugging Section ---
		new Setting(containerEl).setName("Debugging").setHeading();
		new Setting(containerEl)
			.setName("Logging level")
			.setDesc("Sets the verbosity of messages in the developer console.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(String(LogLevel.NONE), "Off")
					.addOption(String(LogLevel.NORMAL), "Normal")
					.addOption(String(LogLevel.VERBOSE), "Verbose")
					.setValue(String(this.plugin.settings.logLevel))
					.onChange(async (value) => {
						this.plugin.settings.logLevel = Number(
							value
						) as LogLevel;
						await this.plugin.saveSettings();
					})
			);
	}

	private createNumericArraySetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		placeholder: string,
		settingsKey: "learningSteps" | "relearnSteps"
	) {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(this.plugin.settings[settingsKey].join(", "))
					.onChange(async (value) => {
						this.plugin.settings[settingsKey] = value
							.split(",")
							.map((s) => Number(s.trim()))
							.filter((n) => !isNaN(n) && n >= 0);
						await this.plugin.saveSettings();
					})
			);
	}
}

// ===================================================================
//
//                          UTILITY FUNCTIONS
//
// ===================================================================

const isUnseen = (card: Flashcard): boolean =>
	card.status === "new" &&
	(card.learning_step_index == null || card.learning_step_index === 0);

const md2attr = (md: string): string => encodeURIComponent(md);

const attr2md = (attr: string): string => decodeURIComponent(attr);

const getDeckPathForChapter = (chapterPath: string): string => {
	const parts = chapterPath.split("/");
	const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
	return normalizePath((folder ? `${folder}/` : "") + DECK_FILE_NAME);
};

const fixMath = (s: string): string =>
	s.replace(/\\\(\s*(.*?)\s*\\\)/g, "$$$$$1$$$$");

const getParagraphsFromFinalizedNote = (
	finalizedContent: string
): { id: number; markdown: string }[] => {
	const paraMatches = [
		...finalizedContent.matchAll(
			new RegExp(
				`${PARA_ID_ATTR}="(\\d+)"\\s*${PARA_MD_ATTR}="([^"]+)"`,
				"g"
			)
		),
	];
	return paraMatches.map((m) => ({
		id: Number(m[1]),
		markdown: attr2md(m[2]),
	}));
};

const findParaIdxInMarkdown = (
	markdownContent: string,
	selectedText: string
): number | undefined => {
	const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
	const paras = markdownContent.split(/\n{2,}/);
	let needle = normalize(selectedText);
	while (needle) {
		for (let i = 0; i < paras.length; i++) {
			if (normalize(paras[i]).includes(needle)) return i + 1;
		}
		needle = needle.split(" ").slice(1).join(" ").trim();
	}
	return undefined;
};

async function waitForEl<T extends HTMLElement>(
	selector: string,
	container: HTMLElement
): Promise<T | null> {
	return new Promise((resolve) => {
		const interval = setInterval(() => {
			const el = container.querySelector<T>(selector);
			if (
				el &&
				(el.dataset.gnProcessed === "true" ||
					el.innerText.trim() !== "")
			) {
				clearInterval(interval);
				resolve(el);
			}
		}, 50);
		setTimeout(() => {
			clearInterval(interval);
			resolve(null);
		}, 3000);
	});
}

/**
 * Finds the DOM Range for a text snippet within a container using a robust fuzzy matching algorithm.
 * @param tag The text content to find, which may not be a verbatim quote.
 * @param container The HTML element to search within.
 * @returns A DOM Range object spanning the found text.
 */
function findTextRange(tag: string, container: HTMLElement): Range {
	const normalize = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^\w\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

	const rawFullText = container.textContent ?? "";

	const normalizedTag = normalize(tag);
	const normalizedFullText = normalize(rawFullText);

	let startIndexInNormalized = -1;
	let endIndexInNormalized = -1;

	const perfectMatchIndex = normalizedFullText.indexOf(normalizedTag);
	if (perfectMatchIndex !== -1) {
		startIndexInNormalized = perfectMatchIndex;
		endIndexInNormalized = perfectMatchIndex + normalizedTag.length;
	} else {
		const tagWords = normalizedTag.split(/\s+/).filter(Boolean);
		let prefixMatch: { index: number; text: string } | null = null;
		let suffixMatch: { index: number; text: string } | null = null;

		for (let i = tagWords.length; i > 0; i--) {
			const prefix = tagWords.slice(0, i).join(" ");
			const index = normalizedFullText.indexOf(prefix);
			if (index !== -1) {
				prefixMatch = { index, text: prefix };
				break;
			}
		}

		for (let i = 0; i < tagWords.length; i++) {
			const suffix = tagWords.slice(i).join(" ");
			const index = normalizedFullText.lastIndexOf(suffix);
			if (index !== -1) {
				suffixMatch = { index, text: suffix };
				break;
			}
		}

		if (prefixMatch && suffixMatch) {
			const prefixEndIndex = prefixMatch.index + prefixMatch.text.length;
			const suffixEndIndex = suffixMatch.index + suffixMatch.text.length;
			if (prefixEndIndex <= suffixMatch.index) {
				startIndexInNormalized = prefixMatch.index;
				endIndexInNormalized = suffixEndIndex;
			}
		}
	}

	if (startIndexInNormalized === -1) {
		throw new Error("Could not find a valid fuzzy match for the tag.");
	}

	const trimOffset = rawFullText.search(/\S/);
	if (trimOffset === -1) throw new Error("Container has no text.");

	const trimmedFullText = rawFullText.trim();
	let startInTrimmed = -1;
	let endInTrimmed = -1;
	let normalizedCharCount = 0;

	for (let i = 0; i < trimmedFullText.length; i++) {
		const char = trimmedFullText[i];
		const isKeptChar = /[\w\s]/.test(char);

		if (isKeptChar) {
			if (
				normalizedCharCount === startIndexInNormalized &&
				startInTrimmed === -1
			) {
				startInTrimmed = i;
			}
			if (
				normalizedCharCount >= endIndexInNormalized - 1 &&
				endInTrimmed === -1
			) {
				endInTrimmed = i + 1;
			}
			normalizedCharCount++;
		}
		if (endInTrimmed !== -1) break;
	}

	if (startInTrimmed === -1 || endInTrimmed === -1) {
		throw new Error(
			"Failed to map normalized indices back to original text."
		);
	}

	const originalStartIndex = startInTrimmed + trimOffset;
	const originalEndIndex = endInTrimmed + trimOffset;

	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	let charCount = 0;
	let startNode: Node | undefined, endNode: Node | undefined;
	let startOffset: number | undefined, endOffset: number | undefined;
	let currentNode;

	while ((currentNode = walker.nextNode())) {
		const nodeTextLength = currentNode.textContent?.length || 0;
		const nextCharCount = charCount + nodeTextLength;

		if (startNode === undefined && nextCharCount > originalStartIndex) {
			startNode = currentNode;
			startOffset = originalStartIndex - charCount;
		}

		if (endNode === undefined && nextCharCount >= originalEndIndex) {
			endNode = currentNode;
			endOffset = originalEndIndex - charCount;
			break;
		}
		charCount = nextCharCount;
	}

	if (
		!startNode ||
		!endNode ||
		startOffset === undefined ||
		endOffset === undefined
	) {
		throw new Error("Could not map string indices to DOM nodes.");
	}

	const range = document.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	return range;
}

function makeModalDraggable(modal: Modal, plugin: GatedNotesPlugin): void {
	const modalEl = modal.modalEl;
	const titleEl = modal.titleEl;

	if (plugin.lastModalTransform) {
		modalEl.style.transform = plugin.lastModalTransform;
	}

	let isDragging = false;
	let initialX: number,
		initialY: number,
		offsetX = 0,
		offsetY = 0;

	titleEl.style.cursor = "grab";

	const onMouseDown = (e: MouseEvent) => {
		isDragging = true;
		initialX = e.clientX;
		initialY = e.clientY;
		const matrix = new DOMMatrixReadOnly(
			window.getComputedStyle(modalEl).transform
		);
		offsetX = matrix.m41;
		offsetY = matrix.m42;
		titleEl.style.cursor = "grabbing";
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
	};

	const onMouseMove = (e: MouseEvent) => {
		if (!isDragging) return;
		const dx = e.clientX - initialX;
		const dy = e.clientY - initialY;
		modalEl.style.transform = `translate(${offsetX + dx}px, ${
			offsetY + dy
		}px)`;
	};

	const onMouseUp = () => {
		if (!isDragging) return;
		isDragging = false;
		titleEl.style.cursor = "grab";
		if (modalEl.style.transform) {
			plugin.lastModalTransform = modalEl.style.transform;
		}
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
	};

	titleEl.addEventListener("mousedown", onMouseDown);
	const originalOnClose = modal.onClose;
	modal.onClose = () => {
		titleEl.removeEventListener("mousedown", onMouseDown);
		if (originalOnClose) originalOnClose.call(modal);
	};
}

async function getLineForParagraph(
	plugin: GatedNotesPlugin,
	file: TFile,
	paraIdx: number
): Promise<number> {
	const content = await plugin.app.vault.cachedRead(file);

	if (content.includes(PARA_CLASS)) {
		const lines = content.split("\n");
		let divCount = 0;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(PARA_CLASS)) {
				divCount++;
				if (divCount === paraIdx) {
					return i;
				}
			}
		}
	}

	const paragraphs = content.split(/\n\s*\n/);
	if (paraIdx > 0 && paraIdx <= paragraphs.length) {
		const textBefore = paragraphs.slice(0, paraIdx - 1).join("\n\n");
		return textBefore.split("\n").length;
	}

	return 0;
}

/**
 * Robustly extracts a JSON array from a string that may include code fences or other text.
 * @param s The string to parse.
 * @returns A parsed array of objects.
 */
function extractJsonArray<T>(s: string): T[] {
	try {
		const parsed = JSON.parse(s);
		return Array.isArray(parsed) ? parsed : [parsed]; // Also handle single object response
	} catch {
		/* continue */
	}

	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence && fence[1]) {
		try {
			const parsed = JSON.parse(fence[1]);
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			/* continue */
		}
	}

	const arr = s.match(/\[\s*[\s\S]*?\s*\]/);
	if (arr && arr[0]) {
		try {
			const parsed = JSON.parse(arr[0]);
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			/* continue */
		}
	}

	const objMatch = s.match(/\{\s*[\s\S]*?\s*\}/);
	if (objMatch && objMatch[0]) {
		try {
			return [JSON.parse(objMatch[0])];
		} catch {
			/* continue */
		}
	}

	throw new Error("No valid JSON array or object found in the string.");
}

/**
 * Robustly extracts one or more JSON objects from a string.
 * @param s The string to parse.
 * @returns An array of parsed objects.
 */
function extractJsonObjects<T>(s: string): T[] {
	try {
		const j = JSON.parse(s);
		return Array.isArray(j) ? j : [j];
	} catch {
		/* continue */
	}

	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence && fence[1]) {
		try {
			const j = JSON.parse(fence[1]);
			return Array.isArray(j) ? j : [j];
		} catch {
			/* continue */
		}
	}

	const obj = s.match(/\{\s*[\s\S]*?\s*\}/);
	if (obj && obj[0]) {
		try {
			const j = JSON.parse(obj[0]);
			return Array.isArray(j) ? j : [j];
		} catch {
			/* continue */
		}
	}

	throw new Error("No valid JSON object or array found in the string.");
}
