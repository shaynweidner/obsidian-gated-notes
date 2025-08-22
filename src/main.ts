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
	TextAreaComponent,
	TFile,
	ToggleComponent,
} from "obsidian";

import { Buffer } from "buffer";

import { encode } from "gpt-tokenizer";
import { calculateCost as aicostCalculate } from "aicost";
import OpenAI from "openai";

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

const HIGHLIGHT_COLORS = {
	unlocked: "rgba(0, 255, 0, 0.3)",
	context: "var(--text-highlight-bg)",
	failed: "rgba(255, 0, 0, 0.3)",
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
	flagged?: boolean;
	suspended?: boolean;
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
	analysis?: {
		type: string;
		description: Record<string, string | string[]>;
	};
}

interface ImageAnalysisGraph {
	[hash: string]: ImageAnalysis;
}

interface CardBrowserState {
	openSubjects: Set<string>;
	activeChapterPath: string | null;
	treeScroll: number;
	editorScroll: number;
	isFirstRender: boolean;
}

interface LlmLogEntry {
	timestamp: number;
	action:
		| "generate"
		| "generate_additional"
		| "refocus"
		| "split"
		| "correct_tag"
		| "analyze_image"
		| "generate_from_selection_single"
		| "generate_from_selection_many"
		| "pdf_to_note";
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number | null;
	cardsGenerated?: number;
	textContentTokens?: number;
}

interface GetDynamicInputsResult {
	promptText: string;
	imageCount: number;
	action: LlmLogEntry["action"];
	details?: { cardCount?: number; textContentTokens?: number };
}

const LLM_LOG_FILE = "_llm_log.json";
const IMAGE_TOKEN_COST = 1105;

export default class GatedNotesPlugin extends Plugin {
	settings!: Settings;
	public lastModalTransform: string | null = null;
	private openai: OpenAI | null = null;
	private cardBrowserState: CardBrowserState = {
		openSubjects: new Set(),
		activeChapterPath: null,
		treeScroll: 0,
		editorScroll: 0,
		isFirstRender: true,
	};

	private statusBar!: HTMLElement;
	private gatingStatus!: HTMLElement;
	private cardsMissingParaIdxStatus!: HTMLElement;
	private statusRefreshQueued = false;
	private studyMode: StudyMode = StudyMode.CHAPTER;
	private isRecalculatingAll = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.initializeOpenAIClient();

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

	public createCostEstimatorUI(
		container: HTMLElement,
		getDynamicInputs: () => GetDynamicInputsResult
	): { update: () => Promise<string> } {
		const costEl = container.createEl("small", {
			text: "Calculating cost...",
			cls: "gn-cost-estimator",
		});
		costEl.style.display = "block";
		costEl.style.marginTop = "10px";
		costEl.style.opacity = "0.7";

		let lastCostString = "";

		const update = async () => {
			const { promptText, imageCount, action, details } =
				getDynamicInputs();

			const model =
				imageCount > 0
					? this.settings.openaiMultimodalModel
					: this.settings.openaiModel;

			const textTokens = countTextTokens(promptText);
			const imageTokens = calculateImageTokens(imageCount);
			const inputTokens = textTokens + imageTokens;

			const { formattedString } = await getEstimatedCost(
				this,
				this.settings.apiProvider,
				model,
				action,
				inputTokens,
				details
			);

			costEl.setText(formattedString);
			lastCostString = formattedString;
			return formattedString;
		};

		return { update };
	}

	private setupStatusBar(): void {
		this.statusBar = this.addStatusBarItem();
		this.gatingStatus = this.addStatusBarItem();
		this.updateGatingStatus();
		this.gatingStatus.onClickEvent(() => this.toggleGating());

		this.cardsMissingParaIdxStatus = this.addStatusBarItem();
		this.cardsMissingParaIdxStatus.onClickEvent(() => {
			new CardBrowser(
				this,
				this.cardBrowserState,
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
			callback: () => new CardBrowser(this, this.cardBrowserState).open(),
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
			id: "gn-remove-all-breakpoints",
			name: "Remove all paragraph breakpoints",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;

				const content = view.editor.getValue();
				if (!content.includes(SPLIT_TAG)) return false;

				if (!checking) {
					const newContent = content.replace(
						new RegExp(SPLIT_TAG, "g"),
						""
					);
					view.editor.setValue(newContent);
					new Notice("All paragraph breakpoints removed.");
				}
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
					(async () => {
						const file = view.file!;
						const deckPath = getDeckPathForChapter(file.path);
						const graph = await this.readDeck(deckPath);
						const existingCards = Object.values(graph).filter(
							(c) => c.chapter === file.path
						);

						if (existingCards.length > 0) {
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
							new GenerateCardsModal(this, file, (result) => {
								if (result && result.count > 0) {
									this.generateFlashcards(
										file,
										result.count,
										undefined,
										result.guidance
									);
								}
							}).open();
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
		this.addCommand({
			id: "gn-reset-chapter-cards",
			name: "Reset flashcard review history for this chapter",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;

				if (!checking) {
					(async () => {
						const file = view.file!;
						const deckPath = getDeckPathForChapter(file.path);
						if (!(await this.app.vault.adapter.exists(deckPath))) {
							new Notice(
								"No flashcard deck found for this chapter."
							);
							return;
						}

						const graph = await this.readDeck(deckPath);
						const cardsForChapter = Object.values(graph).filter(
							(c) => c.chapter === file.path
						);

						if (cardsForChapter.length === 0) {
							new Notice("No flashcards found to reset.");
							return;
						}

						if (
							!confirm(
								`Are you sure you want to reset the review progress for ${cardsForChapter.length} card(s) in "${file.basename}"? All learning history will be lost.`
							)
						) {
							return;
						}

						for (const card of cardsForChapter) {
							card.status = "new";
							card.last_reviewed = null;
							card.interval = 0;
							card.ease_factor = 2.5;
							card.due = Date.now();
							card.blocked = true;
							card.review_history = [];
							delete card.learning_step_index;
						}

						await this.writeDeck(deckPath, graph);
						new Notice(
							`Reset ${cardsForChapter.length} card(s) for "${file.basename}".`
						);

						this.refreshAllStatuses();
						this.refreshReading();
					})();
				}

				return true;
			},
		});
		this.addCommand({
			id: "gn-remove-note-image-analysis",
			name: "Remove image analysis for this note",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) this.removeNoteImageAnalysis(view.file);
				return true;
			},
		});

		this.addCommand({
			id: "gn-remove-all-image-analysis",
			name: "Remove all image analysis data",
			callback: () => this.removeAllImageAnalysis(),
		});
		this.addCommand({
			id: "gn-pdf-to-note",
			name: "Convert PDF to Note (Experimental)",
			callback: () => new PdfToNoteModal(this).open(),
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
			new CardBrowser(this, this.cardBrowserState).open();
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

	private initializeOpenAIClient(): void {
		const { apiProvider, openaiApiKey, lmStudioUrl } = this.settings;

		if (apiProvider === "openai") {
			if (!openaiApiKey) {
				this.openai = null;
				return;
			}
			this.openai = new OpenAI({
				apiKey: openaiApiKey,
				dangerouslyAllowBrowser: true,
			});
		} else {
			this.openai = new OpenAI({
				baseURL: `${lmStudioUrl.replace(/\/$/, "")}/v1`,
				apiKey: "lm-studio",
				dangerouslyAllowBrowser: true,
			});
		}
	}

	private async reviewDue(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file to review.");
			return;
		}
		const activePath = activeFile.path;

		const gateBefore = await this.getFirstBlockedParaIndex(activePath);

		const queue = await this.collectReviewPool(activePath);
		if (!queue.length) {
			new Notice("🎉 All reviews complete!");
			return;
		}

		let reviewInterrupted = false;

		for (const { card, deck } of queue) {
			const res = await this.openReviewModal(card, deck);

			if (res === "abort") {
				new Notice("Review session aborted.");
				reviewInterrupted = true;
				break;
			}

			if (res === "again") {
				new Notice("Last card failed. Jumping to context…");
				reviewInterrupted = true;
				await this.jumpToTag(card, HIGHLIGHT_COLORS.failed);
				break;
			}

			const gateAfterLoop = await this.getFirstBlockedParaIndex(
				activePath
			);
			if (gateAfterLoop > gateBefore) {
				break;
			}
		}

		if (reviewInterrupted) {
			return;
		}

		const gateAfter = await this.getFirstBlockedParaIndex(activePath);

		if (gateAfter > gateBefore) {
			new Notice("✅ New content unlocked!");

			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(activeFile, { state: { mode: "preview" } });

			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!mdView) return;

			await this.findAndScrollToNextContentfulPara(
				gateBefore,
				mdView,
				activeFile
			);
		} else {
			new Notice("All reviews for this section are complete!");
		}
	}

	private async findAndScrollToNextContentfulPara(
		startIdx: number,
		view: MarkdownView,
		file: TFile
	): Promise<void> {
		const SEARCH_LIMIT = 10;

		for (let i = 1; i <= SEARCH_LIMIT; i++) {
			const currentParaIdx = startIdx + i;

			const targetLine = await getLineForParagraph(
				this,
				file,
				currentParaIdx
			);

			view.setEphemeralState({ scroll: targetLine });

			const paraSelector = `.${PARA_CLASS}[${PARA_ID_ATTR}="${currentParaIdx}"]`;
			const wrapper = await waitForEl<HTMLElement>(
				paraSelector,
				view.previewMode.containerEl
			);

			if (wrapper && wrapper.innerText.trim() !== "") {
				wrapper.scrollIntoView({
					behavior: "smooth",
				});
				wrapper.classList.add("gn-unlocked-flash");
				setTimeout(
					() => wrapper.classList.remove("gn-unlocked-flash"),
					1500
				);
				return;
			}
		}

		this.logger(
			LogLevel.NORMAL,
			`Could not find a non-empty paragraph to scroll to after index ${startIdx}.`
		);
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
				if (card.suspended) continue;
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
			let choice: "auto" | "manual" | null = null;

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
					choice = null;
					modal.close();
				});

			new ButtonComponent(buttonContainer)
				.setButtonText("Ignore and Auto-Split")
				.setWarning()
				.onClick(() => {
					choice = "auto";
					modal.close();
				});

			new ButtonComponent(buttonContainer)
				.setButtonText("Use Manual Breaks")
				.setCta()
				.onClick(() => {
					choice = "manual";
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
		existingCardsForContext?: Flashcard[],
		customGuidance?: string
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

			for (const para of paragraphs) {
				let match;
				while ((match = imageRegex.exec(para.markdown)) !== null) {
					const imageLinkText = match[0];
					const imagePath = match[1];
					const imageFile =
						this.app.metadataCache.getFirstLinkpathDest(
							imagePath,
							file.path
						);

					if (imageFile instanceof TFile) {
						hasImages = true;
						notice.setMessage(
							`🤖 Analyzing image: ${imageFile.name}...`
						);
						const hash = await this.calculateFileHash(imageFile);
						imageHashMap.set(hash, para.id);

						let analysisEntry = imageDb[hash];

						if (!analysisEntry || !analysisEntry.analysis) {
							const newAnalysis = await this.analyzeImage(
								imageFile,
								para.markdown
							);
							if (newAnalysis) {
								analysisEntry = newAnalysis;
								imageDb[hash] = newAnalysis;
								await this.writeImageDb(imageDb);
							}
						}

						if (analysisEntry && analysisEntry.analysis) {
							const { type, description } =
								analysisEntry.analysis;
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

		const guidancePrompt = customGuidance
			? `**User's Custom Instructions:**\n${customGuidance}`
			: "";

		const initialPrompt = `Create ${count} new, distinct Anki-style flashcards from the following article. The article may contain text and special image placeholders of the format [[IMAGE: HASH=... DESCRIPTION=...]].
	
${guidancePrompt}

**Card Generation Rules:**
1.  **Text-Based Cards:** For cards based on plain text, the "Tag" MUST be a short, verbatim quote from the text.
2.  **Image-Based Cards from Facts:** If an image's DESCRIPTION contains "key_facts", treat those facts as source text. Create questions whose answers are derived from these facts. The "Tag" for these cards MUST be the \`[[IMAGE HASH=...]]\` placeholder itself.
3.  **Visual Question Cards: Create questions that require the user to see the image to answer. The "Front" of such cards should contain both a question and the \`[[IMAGE HASH=...]]\` placeholder.** For example: "What process does this diagram illustrate? [[IMAGE HASH=...]]".
4.  **No Image-Only Fields: The "Front" or "Back" of a card must never consist solely of an image placeholder. Images must always be accompanied by relevant text or a question.**

**Output Format:**
- Return ONLY valid JSON of this shape: \`[{"front":"...","back":"...","tag":"..."}]\`
- Every card must have a valid front, back, and tag.

${contextPrompt}Here is the article:
${plainTextForLlm}`;

		notice.setMessage(`🤖 Generating ${count} flashcard(s)...`);
		const { content: response, usage } = await this.sendToLlm(
			initialPrompt
		);
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

		let finalNoticeText = "";

		if (goodCards.length > 0) {
			const deckPath = getDeckPathForChapter(file.path);
			const graph = await this.readDeck(deckPath);

			const newCardIds = goodCards.map((card) => card.id);

			goodCards.forEach((card) => (graph[card.id] = card));
			const deckFile =
				(this.app.vault.getAbstractFileByPath(deckPath) as TFile) ||
				(await this.app.vault.create(deckPath, "{}"));
			await this.writeDeck(deckPath, graph);
			if (usage) {
				await logLlmCall(this, {
					action: existingCardsForContext
						? "generate_additional"
						: "generate",
					model: this.settings.openaiModel,
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
					cardsGenerated: goodCards.length,
				});
			}

			await this.promptToReviewNewCards(goodCards, deckFile, graph);

			const keptCardsCount = newCardIds.filter((id) => graph[id]).length;
			const discardedCount = newCardIds.length - keptCardsCount;

			finalNoticeText = `✅ Added ${keptCardsCount} card(s).`;
			if (discardedCount > 0) {
				finalNoticeText += ` (${discardedCount} discarded during review)`;
			}
		} else {
			finalNoticeText = "No new cards were generated.";
		}

		if (correctedCount > 0)
			finalNoticeText += ` 🤖 Auto-corrected ${correctedCount} tags.`;
		if (cardsToFix.length > 0)
			finalNoticeText += ` ⚠️ Failed to fix ${cardsToFix.length} tags (see console).`;
		new Notice(finalNoticeText);

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

			const { content: fixResponse, usage } = await this.sendToLlm(
				correctionPrompt
			);
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
							if (usage) {
								await logLlmCall(this, {
									action: "correct_tag",
									model: this.settings.openaiModel,
									inputTokens: usage.prompt_tokens,
									outputTokens: usage.completion_tokens,
								});
							}
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
			const { content: response, usage } = await this.sendToLlm(prompt);
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
			if (usage) {
				await logLlmCall(this, {
					action: "generate_from_selection_single",
					model: this.settings.openaiModel,
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
				});
			}
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
		new CountModal(this, 1, selection, file.path, async (count) => {
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
				const { content: response, usage } = await this.sendToLlm(
					prompt
				);
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

				if (usage) {
					await logLlmCall(this, {
						action: "generate_from_selection_many",
						model: this.settings.openaiModel,
						inputTokens: usage.prompt_tokens,
						outputTokens: usage.completion_tokens,
					});
				}

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

	public refreshReading(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") {
				(view.previewMode as any)?.rerender?.(true);
			}
		});
	}

	public async refreshReadingAndPreserveScroll(): Promise<void> {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!mdView) {
			this.refreshReading();
			return;
		}

		const state = mdView.getEphemeralState();
		this.logger(LogLevel.VERBOSE, "Preserving scroll state", state);

		this.refreshReading();

		setTimeout(() => {
			let newMdView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (newMdView) {
				newMdView.setEphemeralState(state);
				this.logger(LogLevel.VERBOSE, "Restored scroll state");
			}
		}, 50);
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
						(c) =>
							c.chapter === chapterPath &&
							c.blocked &&
							!c.suspended
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

	private async jumpToTag(
		card: Flashcard,
		highlightColor: string = HIGHLIGHT_COLORS.context
	): Promise<void> {
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
		const paraSelector = `.${PARA_CLASS}[${PARA_ID_ATTR}="${
			card.paraIdx ?? 1
		}"]`;

		for (let attempt = 1; attempt <= 3; attempt++) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: "preview" } });

			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (mdView && mdView.file?.path === file.path) {
				mdView.setEphemeralState({ scroll: targetLine });
				const wrapper = await waitForEl<HTMLElement>(
					paraSelector,
					mdView.previewMode.containerEl
				);

				if (wrapper) {
					const applyHighlight = (el: HTMLElement) => {
						el.style.setProperty(
							"--highlight-color",
							highlightColor
						);
						el.classList.add("gn-flash-highlight");
						setTimeout(() => {
							el.classList.remove("gn-flash-highlight");
							el.style.removeProperty("--highlight-color");
						}, 1500);
					};

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
								const filename = imageInfo.path
									.split("/")
									.pop();
								const imageSelector = `span.internal-embed[src*="${filename}"]`;
								const imgContainerEl =
									wrapper.querySelector<HTMLElement>(
										imageSelector
									);
								if (imgContainerEl) {
									imgContainerEl.scrollIntoView({
										behavior: "smooth",
									});
									applyHighlight(imgContainerEl);
									imageFound = true;
								}
							}
						}
						if (!imageFound) {
							wrapper.scrollIntoView({
								behavior: "smooth",
							});
							applyHighlight(wrapper);
						}
					} else {
						try {
							const range = findTextRange(card.tag, wrapper);
							
							const startContainer = range.startContainer;
							const endContainer = range.endContainer;
							
							if (startContainer !== endContainer || 
								startContainer.parentElement !== endContainer.parentElement) {
								
								
								
								wrapper.scrollIntoView({
									behavior: "smooth",
								});
								
								const selection = window.getSelection();
								if (selection) {
									selection.removeAllRanges();
									selection.addRange(range);
									
									const style = document.createElement('style');
									style.textContent = `
										::selection {
											background-color: ${highlightColor} !important;
											color: inherit !important;
										}
										::-moz-selection {
											background-color: ${highlightColor} !important;
											color: inherit !important;
										}
									`;
									document.head.appendChild(style);
									
									setTimeout(() => {
										selection.removeAllRanges();
										document.head.removeChild(style);
									}, 1500);
								}
								
							} else {
								const mark = document.createElement("mark");
								range.surroundContents(mark);
								mark.scrollIntoView({
									behavior: "smooth",
								});
								applyHighlight(mark);
								setTimeout(() => {
									const parent = mark.parentNode;
									if (parent) {
										while (mark.firstChild)
											parent.insertBefore(
												mark.firstChild,
												mark
											);
										parent.removeChild(mark);
									}
								}, 1500);
							}
							
						} catch (e) {
							this.logger(
								LogLevel.NORMAL,
								`Tag highlighting failed: ${
									(e as Error).message
								}. Flashing paragraph as fallback.`
							);
							wrapper.scrollIntoView({
								behavior: "smooth",
							});
							applyHighlight(wrapper);
						}
					}
					return;
				}
			}
			this.logger(
				LogLevel.VERBOSE,
				`Jump to tag failed on attempt ${attempt}. Retrying...`
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		this.logger(
			LogLevel.NORMAL,
			`Jump failed: Timed out waiting for paragraph element with selector: ${paraSelector} after 3 attempts.`
		);
		new Notice("Jump failed: Timed out waiting for paragraph to render.");
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
			.gn-flash-highlight {
				--highlight-color: ${HIGHLIGHT_COLORS.context};
				background-color: var(--highlight-color) !important;
				transition: background-color 1.5s ease-out;
			}
			.gn-unlocked-flash {
				background-color: ${HIGHLIGHT_COLORS.unlocked} !important;
				transition: background-color 1.2s ease-out;
			}
			.gn-edit-nav { display: flex; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 1rem; }
			.gn-edit-nav button { background: none; border: none; padding: 0.5rem 1rem; cursor: pointer; border-bottom: 2px solid transparent; }
			.gn-edit-nav button.active { border-bottom-color: var(--interactive-accent); font-weight: 600; color: var(--text-normal); }
			.gn-edit-pane .setting-item { border: none; padding-block: 0.5rem; }
			.gn-edit-row { display: flex; gap: 0.5rem; align-items: flex-start; margin-block: 0.4rem; }
			.gn-edit-row > label { min-width: 5rem; font-weight: 600; padding-top: 0.5rem; }
			.gn-edit-row textarea, .gn-edit-row input { flex: 1; width: 100%; }
			.gn-edit-row textarea { resize: vertical; font-family: var(--font-text); }
			.gn-edit-btnrow { display: flex; gap: 0.5rem; margin-top: 0.8rem; justify-content: flex-end; }
			
			.gn-browser {
				width: 60vw;
				height: 70vh;
				min-height: 20rem;
				min-width: 32rem;
				resize: both;
				display: flex;
				flex-direction: column;
			}
			.gn-browser .modal-content {
				display: flex;
				flex-direction: column;
				height: 100%;
				overflow: hidden;
			}
			.gn-header {
				flex-shrink: 0;
				border-bottom: 1px solid var(--background-modifier-border);
				padding-bottom: 0.5rem;
				margin-bottom: 0.5rem;
			}
			.gn-body {
				flex: 1;
				display: flex;
				overflow: hidden;
				min-height: 0;
			}
			.gn-tree {
				width: 40%;
				padding-right: .75rem;
				border-right: 1px solid var(--background-modifier-border);
				overflow-y: auto;
				overflow-x: hidden;
			}
			.gn-editor {
				flex: 1;
				padding-left: .75rem;
				overflow-y: auto;
				overflow-x: hidden;
			}
			
			.gn-node > summary { cursor: pointer; font-weight: 600; }
			.gn-chap { margin-left: 1.2rem; cursor: pointer; }
			.gn-chap:hover { text-decoration: underline; }
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
			() => new Notice("✅ Flashcard created."),
			undefined,
			"edit"
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
			suspended: false,
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

	public resetCardProgress(card: Flashcard): void {
		card.status = "new";
		card.last_reviewed = null;
		card.interval = 0;
		card.ease_factor = 2.5;
		card.due = Date.now();
		card.blocked = true;
		card.review_history = [];
		delete card.learning_step_index;
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

	private async removeNoteImageAnalysis(file: TFile): Promise<void> {
		const imageDb = await this.getImageDb();
		const noteContent = await this.app.vault.read(file);
		const imageRegex = /!\[\[([^\]]+)\]\]/g;
		let match;
		const hashesToClear: string[] = [];

		while ((match = imageRegex.exec(noteContent)) !== null) {
			const imagePath = match[1];
			const imageFile = this.app.metadataCache.getFirstLinkpathDest(
				imagePath,
				file.path
			);
			if (imageFile instanceof TFile) {
				const hash = await this.calculateFileHash(imageFile);
				if (imageDb[hash]?.analysis) {
					hashesToClear.push(hash);
				}
			}
		}

		if (hashesToClear.length === 0) {
			new Notice("No analyzed images found in this note.");
			return;
		}

		if (
			!confirm(
				`Are you sure you want to remove the AI analysis for ${hashesToClear.length} image(s) in this note? The images can be re-analyzed later. This cannot be undone.`
			)
		) {
			return;
		}

		let clearedCount = 0;
		for (const hash of hashesToClear) {
			if (imageDb[hash]) {
				delete imageDb[hash].analysis;
				clearedCount++;
			}
		}

		await this.writeImageDb(imageDb);
		new Notice(`✅ Cleared analysis for ${clearedCount} image(s).`);
	}

	private async removeAllImageAnalysis(): Promise<void> {
		const imageDb = await this.getImageDb();
		const keysWithAnalysis = Object.keys(imageDb).filter(
			(k) => imageDb[k].analysis
		);

		if (keysWithAnalysis.length === 0) {
			new Notice("No image analysis data found to remove.");
			return;
		}

		if (
			!confirm(
				`Are you sure you want to remove ALL AI image analysis data from your vault? This will affect ${keysWithAnalysis.length} image(s). This cannot be undone.`
			)
		) {
			return;
		}

		for (const hash of keysWithAnalysis) {
			delete imageDb[hash].analysis;
		}

		await this.writeImageDb(imageDb);
		new Notice(
			`✅ Cleared all AI analysis data for ${keysWithAnalysis.length} image(s).`
		);
	}

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
		imageFile: TFile,
		textContext?: string
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

			const contextInstruction = textContext
				? `Use the following text context to inform your analysis, especially for identifying people, places, or specific concepts:\n---TEXT CONTEXT---\n${textContext}\n--------------------`
				: "Analyze the image based on its visual content alone.";

			const prompt = `You are an expert academic analyst. Your task is to analyze the provided image and return a single, valid JSON object that classifies and describes it for study purposes.
	
	${contextInstruction}
	
	**Step 1: Classify the Image**
	Set the \`type\` key to ONE of the following: "diagram", "chart", "map", "artwork", "photograph", "screenshot".
	
	**Step 2: Generate a Structured Description**
	Based on the \`type\`, create a \`description\` object.
	- For diagrams, charts, or maps, the description MUST contain:
		- \`title\`: A concise title for the image.
		- \`key_facts\`: An array of strings, where each string is a distinct, self-contained factual proposition or observation extracted from the image.
	- For artwork, photographs, or screenshots, the description MUST contain:
		- \`subject\`: A string describing the central subject.
		- \`context\`: A string explaining the historical, cultural, or technical context, informed by the provided text.
	
	Your final output must be ONLY the JSON object.`;

			const { content: response, usage } = await this.sendToLlm(
				prompt,
				imageUrl
			);
			if (!response) throw new Error("LLM returned an empty response.");

			const analysis = extractJsonObjects<any>(response)[0];
			if (!analysis || !analysis.type || !analysis.description) {
				throw new Error(
					"LLM response was not in the expected JSON format."
				);
			}
			if (usage) {
				await logLlmCall(this, {
					action: "analyze_image",
					model: this.settings.openaiMultimodalModel,
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
				});
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

	public async renderCardContent(
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
								const deckPath = getDeckPathForChapter(
									card.chapter
								);
								const graph = await this.readDeck(deckPath);
								const cardInGraph = graph[card.id];

								if (!cardInGraph) {
									modal.close();
									return;
								}

								const gateBefore =
									await this.getFirstBlockedParaIndex(
										card.chapter,
										graph
									);

								this.applySm2(cardInGraph, lbl);

								const gateAfter =
									await this.getFirstBlockedParaIndex(
										card.chapter,
										graph
									);

								await this.writeDeck(deckPath, graph);

								if (gateBefore !== gateAfter) {
									this.logger(
										LogLevel.VERBOSE,
										`Gate moved from ${gateBefore} to ${gateAfter}. Refreshing view.`
									);
									await this.refreshReadingAndPreserveScroll();
								} else {
									this.logger(
										LogLevel.VERBOSE,
										`Gate unchanged at ${gateBefore}. Skipping view refresh.`
									);
								}

								state = lbl === "Again" ? "again" : "answered";
								modal.close();
							});
					}
				);
				modal.contentEl.insertBefore(easeButtonContainer, bottomBar);
			};

			revealBtn.onClick(showAnswer);

			const flagBtn = new ButtonComponent(bottomBar)
				.setIcon("flag")
				.setTooltip("Flag for review")
				.onClick(async () => {
					const graph = await this.readDeck(deck.path);
					const cardInGraph = graph[card.id];
					if (cardInGraph) {
						cardInGraph.flagged = !cardInGraph.flagged;
						card.flagged = cardInGraph.flagged;
						await this.writeDeck(deck.path, graph);
						new Notice(
							cardInGraph.flagged
								? "Card flagged."
								: "Flag removed."
						);
						flagBtn.buttonEl.style.color = cardInGraph.flagged
							? "var(--text-warning)"
							: "";
					}
				});
			if (card.flagged) {
				flagBtn.buttonEl.style.color = "var(--text-warning)";
			}

			new ButtonComponent(bottomBar)
				.setIcon("trash")
				.setTooltip("Delete")
				.onClick(async () => {
					if (confirm("Delete this card permanently?")) {
						const graph = await this.readDeck(deck.path);
						delete graph[card.id];
						await this.writeDeck(deck.path, graph);
						this.refreshReadingAndPreserveScroll();
						state = "answered";
						modal.close();
					}
				});

			new ButtonComponent(bottomBar)
				.setIcon("pencil")
				.setTooltip("Edit")
				.onClick(async () => {
					const graph = await this.readDeck(deck.path);

					this.openEditModal(
						card,
						graph,
						deck,
						(actionTaken, newCards) => {
							if (actionTaken) {
								state = "abort";
								modal.close();

								if (newCards && newCards.length > 0) {
									this.promptToReviewNewCards(
										newCards,
										deck,
										graph
									);
								}
							}
						},
						undefined,
						"review"
					);
				});
			new ButtonComponent(bottomBar)
				.setIcon("ban")
				.setTooltip("Suspend card from reviews")
				.onClick(async () => {
					if (
						confirm(
							"Suspend this card? You can unsuspend it later from the Card Browser or Edit menu."
						)
					) {
						const graph = await this.readDeck(deck.path);
						const cardInGraph = graph[card.id];
						if (cardInGraph) {
							cardInGraph.suspended = true;
							await this.writeDeck(deck.path, graph);
							this.refreshReadingAndPreserveScroll();
							new Notice("Card suspended.");
							state = "answered";
							modal.close();
						}
					}
				});

			new ButtonComponent(bottomBar)
				.setIcon("info")
				.setTooltip("Info")
				.onClick(() => new CardInfoModal(this.app, card).open());

			new ButtonComponent(bottomBar)
				.setIcon("link")
				.setTooltip("Context")
				.onClick(() => this.jumpToTag(card, HIGHLIGHT_COLORS.context));

			new ButtonComponent(bottomBar)
				.setIcon("file-down")
				.setTooltip("Bury")
				.onClick(async () => {
					const graph = await this.readDeck(deck.path);
					graph[card.id].due =
						Date.now() + this.settings.buryDelayHours * 3_600_000;
					await this.writeDeck(deck.path, graph);
					this.refreshReadingAndPreserveScroll();
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
		onDone: (actionTaken: boolean, newCards?: Flashcard[]) => void,
		reviewContext?: { index: number; total: number },
		parentContext?: "edit" | "review"
	): void {
		new EditModal(this, card, graph, deck, onDone, reviewContext).open();
	}

	public async promptToReviewNewCards(
		newCards: Flashcard[],
		deck: TFile,
		graph: FlashcardGraph
	): Promise<void> {
		if (newCards.length === 0) return;

		const userWantsToReview = await new Promise<boolean>((resolve) => {
			const modal = new Modal(this.app);
			let choiceMade = false; 

			modal.titleEl.setText("Review New Cards?");
			modal.contentEl.createEl("p", {
				text: `You've created ${newCards.length} new card(s). Would you like to review and edit them now?`,
			});
			const btnRow = modal.contentEl.createDiv({ cls: "gn-edit-btnrow" });

			new ButtonComponent(btnRow)
				.setButtonText("No, I'll do it later")
				.onClick(() => {
					choiceMade = true;
					modal.close();
					resolve(false);
				});
			new ButtonComponent(btnRow)
				.setButtonText("Yes, Review Now")
				.setCta()
				.onClick(() => {
					choiceMade = true;
					modal.close();
					resolve(true);
				});

			modal.onClose = () => {
				if (!choiceMade) {
					resolve(false);
				}
			};

			modal.open();
		});

		if (userWantsToReview) {
			await this.reviewNewCardsInSequence(newCards, deck, graph);
		}
	}

	public async reviewNewCardsInSequence(
		newCards: Flashcard[],
		deck: TFile,
		graph: FlashcardGraph
	): Promise<void> {
		if (newCards.length === 0) return;

		let reviewAborted = false;

		for (let i = 0; i < newCards.length; i++) {
			if (reviewAborted) break;

			const card = newCards[i];

			const editPromise = new Promise<void>((resolve) => {
				this.openEditModal(
					card,
					graph,
					deck,
					(continueReview: boolean) => {
						if (!continueReview) {
							reviewAborted = true;
						}
						resolve();
					},
					{
						index: i + 1,
						total: newCards.length,
					}
				);
			});

			await editPromise;
		}

		if (reviewAborted) {
			new Notice("Review session closed.");
		} else {
			new Notice("Finished reviewing all new cards.");
		}
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

	public async sendToLlm(
		prompt: string,
		imageUrl?: string
	): Promise<{ content: string; usage?: OpenAI.CompletionUsage }> {
		if (!this.openai) {
			new Notice("AI client is not configured. Check plugin settings.");
			return { content: "" };
		}

		const { apiProvider, lmStudioModel, openaiTemperature } = this.settings;

		if (apiProvider === "lmstudio" && imageUrl) {
			new Notice("Image analysis is not supported with LM Studio.");
			return { content: "" };
		}

		const model = imageUrl
			? this.settings.openaiMultimodalModel
			: apiProvider === "openai"
			? this.settings.openaiModel
			: lmStudioModel;

		try {
			const messageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
				[{ type: "text", text: prompt }];
			if (imageUrl) {
				messageContent.push({
					type: "image_url",
					image_url: { url: imageUrl },
				});
			}

			const payload: OpenAI.Chat.Completions.ChatCompletionCreateParams =
				{
					model,
					temperature: openaiTemperature,
					messages: [{ role: "user", content: messageContent }],
				};

			this.logger(LogLevel.VERBOSE, "Sending payload to LLM:", payload);

			const response = await this.openai.chat.completions.create(payload);

			this.logger(
				LogLevel.VERBOSE,
				"Received payload from LLM:",
				response
			);

			const responseText = response.choices?.[0]?.message?.content ?? "";
			this.logger(
				LogLevel.VERBOSE,
				"Received response content from LLM:",
				responseText
			);

			return {
				content: responseText,
				usage: response.usage,
			};
		} catch (e: unknown) {
			this.logger(LogLevel.NORMAL, `API Error for ${apiProvider}:`, e);
			new Notice(`${apiProvider} API error – see developer console.`);
			return { content: "" };
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

	private async getFirstBlockedParaIndex(
		chapterPath: string,
		graphToUse?: FlashcardGraph
	): Promise<number> {
		const graph =
			graphToUse ??
			(await this.readDeck(getDeckPathForChapter(chapterPath)));

		const blockedCards = Object.values(graph).filter(
			(c) => c.chapter === chapterPath && c.blocked && !c.suspended
		);

		if (blockedCards.length === 0) {
			return Infinity;
		}

		return Math.min(...blockedCards.map((c) => c.paraIdx ?? Infinity));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.initializeOpenAIClient();
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

class PdfToNoteModal extends Modal {
	private fileInput!: HTMLInputElement;
	private chapterNameInput!: TextComponent;
	private folderSelect!: HTMLSelectElement;
	private newFolderInput!: TextComponent;
	private pdfViewer!: HTMLElement;
	private costUi!: { update: () => Promise<string> };
	private extractedText: string = "";
	private selectedFile: File | null = null;
	private exampleNotePath: string = "";
	private exampleNoteContent: string = "";

	constructor(private plugin: GatedNotesPlugin) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Convert PDF to Note (EXPERIMENTAL)");
		this.modalEl.addClass("gn-pdf-modal");
		makeModalDraggable(this, this.plugin);

		const warningEl = this.contentEl.createDiv({
			attr: { style: "background: var(--background-modifier-error); padding: 10px; border-radius: 5px; margin-bottom: 15px;" }
		});
		warningEl.createEl("strong", { text: "⚠️ Experimental Feature" });
		warningEl.createEl("p", { 
			text: "This PDF conversion feature is experimental. Results may vary depending on PDF complexity and formatting. Always review the generated content carefully.",
			attr: { style: "margin: 5px 0 0 0; font-size: 0.9em;" }
		});

		const fileSection = this.contentEl.createDiv();
		fileSection.createEl("h4", { text: "Select PDF File" });

		const fileButton = fileSection.createEl("button", {
			text: "Choose PDF File",
			cls: "mod-cta",
		});

		this.fileInput = fileSection.createEl("input", {
			type: "file",
			attr: { accept: ".pdf", style: "display: none;" },
		}) as HTMLInputElement;

		fileButton.onclick = () => this.fileInput.click();
		this.fileInput.onchange = (e) => this.handleFileSelection(e);

		this.pdfViewer = fileSection.createDiv({
			cls: "pdf-viewer",
			attr: {
				style: "margin-top: 10px; min-height: 200px; border: 1px solid var(--background-modifier-border); padding: 10px;",
			},
		});
		this.pdfViewer.setText("No PDF selected");

		new Setting(this.contentEl)
			.setName("Chapter Name")
			.setDesc("Name for the new note/chapter")
			.addText((text) => {
				this.chapterNameInput = text;
				text.setPlaceholder("Enter chapter name...");
				text.onChange(() => this.costUi?.update());
			});

		const folderSection = this.contentEl.createDiv();
		folderSection.createEl("h4", { text: "Destination Folder" });

		this.folderSelect = folderSection.createEl("select");
		await this.populateFolderOptions();

		this.folderSelect.onchange = () => {
			const isNewFolder = this.folderSelect.value === "__new__";
			this.newFolderInput.inputEl.style.display = isNewFolder
				? "block"
				: "none";
		};

		this.newFolderInput = new TextComponent(folderSection);
		this.newFolderInput.setPlaceholder("Enter new folder name...");
		this.newFolderInput.inputEl.style.display = "none";

		const exampleSection = this.contentEl.createDiv();
		exampleSection.createEl("h4", { text: "Example Note (Optional)" });
		exampleSection.createEl("p", {
			text: "Select an existing note to use as a structural template for the conversion.",
			cls: "setting-item-description",
		});

		const exampleButtonContainer = exampleSection.createDiv({
			cls: "gn-edit-row",
		});
		const exampleButton = exampleButtonContainer.createEl("button", {
			text: "Choose Example Note",
		});

		const exampleDisplay = exampleSection.createDiv({
			attr: {
				style: "margin-top: 10px; font-style: italic; color: var(--text-muted);",
			},
		});
		exampleDisplay.setText("No example note selected");

		exampleButton.onclick = () =>
			this.openExampleNoteSelector(exampleDisplay);

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(costContainer, (): GetDynamicInputsResult => {
			const promptText = this.buildPrompt(this.extractedText, this.exampleNoteContent);
			const textContentTokens = countTextTokens(this.extractedText); 
			return {
				promptText,
				imageCount: 0,
				action: "pdf_to_note",
				details: { textContentTokens },
			};
		});

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Convert")
					.setCta()
					.onClick(() => this.handleConvert())
			);
	}

	private async handleFileSelection(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		this.selectedFile = file;
		this.pdfViewer.setText("Processing PDF...");

		try {
			const pdfjsLib = await this.loadPdfJs();

			const arrayBuffer = await file.arrayBuffer();
			const typedArray = new Uint8Array(arrayBuffer);

			const pdf = await pdfjsLib.getDocument(typedArray).promise;
			let fullText = "";

			for (let i = 1; i <= pdf.numPages; i++) {
				const page = await pdf.getPage(i);
				const textContent = await page.getTextContent();
				const pageText = this.extractParagraphsFromTextContent(
					textContent.items
				);
				fullText += `\n\n--- PAGE ${i} ---\n\n` + pageText + "\n";
			}

			this.extractedText = fullText;

			this.pdfViewer.empty();
			const preview = this.pdfViewer.createEl("div");
			preview.createEl("p", {
				text: `✅ PDF processed: ${file.name} (${pdf.numPages} pages)`,
			});
			const textPreview = preview.createEl("pre", {
				attr: {
					style: "max-height: 150px; overflow-y: auto; font-size: 12px; background: var(--background-secondary); padding: 10px;",
				},
			});
			textPreview.setText(fullText.substring(0, 500) + "...");

			if (!this.chapterNameInput.getValue()) {
				const suggestedName = file.name.replace(/\.pdf$/i, "");
				this.chapterNameInput.setValue(suggestedName);
			}

			await this.costUi.update();
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			this.pdfViewer.setText(`Error processing PDF: ${errorMessage}`);
			console.error("PDF processing error:", error);
		}
	}

	private async loadPdfJs(): Promise<any> {
		if ((window as any).pdfjsLib) {
			return (window as any).pdfjsLib;
		}

		try {
			const script = document.createElement("script");
			script.src =
				"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
			document.head.appendChild(script);

			return new Promise((resolve, reject) => {
				script.onload = () => {
					const pdfjsLib = (window as any).pdfjsLib;
					if (pdfjsLib) {
						pdfjsLib.GlobalWorkerOptions.workerSrc =
							"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
						resolve(pdfjsLib);
					} else {
						reject(new Error("pdf.js failed to load"));
					}
				};
				script.onerror = () =>
					reject(new Error("Failed to load pdf.js from CDN"));

				setTimeout(
					() => reject(new Error("pdf.js loading timeout")),
					10000
				);
			});
		} catch (error) {
			throw new Error(
				"pdf.js not available. Please check your internet connection."
			);
		}
	}

	private extractParagraphsFromTextContent(items: any[]): string {
		items.sort((a, b) => {
			const yDiff = b.transform[5] - a.transform[5];
			if (Math.abs(yDiff) > 2) return yDiff;
			return a.transform[4] - b.transform[4];
		});

		const lines = [];
		let currentLine = [];
		let lastY = null;
		let lastLineY = null;
		const paragraphGapThreshold = 8;

		for (const item of items) {
			const y = item.transform[5];

			if (lastY !== null && Math.abs(y - lastY) > 1) {
				const lineText = currentLine
					.map((i) => i.str)
					.join(" ")
					.trim();
				if (lineText) {
					if (
						lastLineY !== null &&
						Math.abs(y - lastLineY) > paragraphGapThreshold
					) {
						lines.push(""); 
					}
					lines.push(lineText);
					lastLineY = lastY;
				}
				currentLine = [];
			}

			currentLine.push(item);
			lastY = y;
		}

		if (currentLine.length) {
			lines.push(
				currentLine
					.map((i) => i.str)
					.join(" ")
					.trim()
			);
		}

		return lines.join("\n");
	}

	private async populateFolderOptions(): Promise<void> {
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((file) => file.parent?.isRoot() && "children" in file)
			.map((folder) => folder.name)
			.sort();

		const rootOption = this.folderSelect.createEl("option", {
			value: "",
			text: "📁 Vault Root",
		});

		folders.forEach((folderName) => {
			this.folderSelect.createEl("option", {
				value: folderName,
				text: `📁 ${folderName}`,
			});
		});

		this.folderSelect.createEl("option", {
			value: "__new__",
			text: "➕ Create New Folder",
		});
	}

	private openExampleNoteSelector(displayElement: HTMLElement): void {
		const suggester = new ExampleNoteSuggester(this.app, (file: TFile) => {
			this.exampleNotePath = file.path;
			displayElement.setText(`📄 ${file.basename}`);
			this.loadExampleNoteContent(file);
		});
		suggester.open();
	}

	private async loadExampleNoteContent(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.cachedRead(file);
			this.exampleNoteContent = this.processExampleNote(content);
			await this.costUi?.update();
		} catch (error) {
			console.error("Error loading example note:", error);
			this.exampleNoteContent = "";
		}
	}

	private processExampleNote(content: string): string {
		const isFinalized = content.includes('class="gn-paragraph"');

		let processedContent: string;

		if (isFinalized) {
			const paragraphs = getParagraphsFromFinalizedNote(content);
			processedContent = paragraphs.map((p) => p.markdown).join("\n\n");
		} else {
			processedContent = content;
		}

		processedContent = processedContent.replace(
			/!\[\[([^\]]+)\]\]/g,
			"![IMAGE_PLACEHOLDER]"
		);
		processedContent = processedContent.replace(
			/!\[([^\]]*)\]\([^)]+\)/g,
			"![IMAGE_PLACEHOLDER]"
		);

		processedContent = processedContent.replace(
			/<div class="gn-split-placeholder"><\/div>/g,
			""
		);

		const paragraphs = processedContent.split(/\n\s*\n/);
		const abbreviatedParagraphs = paragraphs.map((paragraph) => {
			const trimmed = paragraph.trim();
			if (!trimmed) return "";

			if (
				trimmed.startsWith("#") ||
				trimmed.startsWith("```") ||
				trimmed.includes("```") ||
				trimmed.split(/\s+/).length <= 10
			) {
				return trimmed;
			}

			const words = trimmed.split(/\s+/);
			if (words.length <= 6) {
				return trimmed;
			}

			const firstTwo = words.slice(0, 2).join(" ");
			const lastTwo = words.slice(-2).join(" ");
			return `${firstTwo} ... ${lastTwo}`;
		});

		return abbreviatedParagraphs.filter((p) => p).join("\n\n");
	}

	private buildPrompt(textContent: string, exampleContent: string): string {
		let systemPrompt = `You are an expert document processor. Your task is to convert raw text extracted from a PDF into clean, well-structured markdown suitable for a note-taking app like Obsidian. Follow these rules strictly:

1.  **Headers**: Convert section titles (e.g., "1.1 Trading protocol") into markdown headers ("# 1.1 Trading protocol", "## 1.1.1 Order-driven markets", etc.).
2.  **Paragraphs**: Merge consecutive lines of text into complete paragraphs, removing unnecessary line breaks.
3.  **Footnotes**: Find footnote citations (e.g., a superscript number) and inject the corresponding footnote text directly into the main text in parentheses. For example, "...a reference^1" with footnote "1 This is the info" becomes "...a reference (This is the info)".
4.  **Figures & Tables**: For any figures or tables, use a placeholder like "![IMAGE_PLACEHOLDER]" or recreate the table in markdown. Any accompanying text, source, or caption should be placed immediately below the placeholder or markdown table, separated by a single newline.
5.  **Mathematics**: Format all mathematical and scientific notations using LaTeX delimiters ("$" for inline, "$" for block).
6.  **Output**: The response should ONLY contain the final markdown text. Do not include any conversational phrases, introductions, or apologies.`;

		let userPrompt = `Please convert the following text to markdown based on the system instructions.`;

		if (exampleContent.trim()) {
			userPrompt += `

[EXAMPLE_NOTE_START]
The following is an example of the desired structure and formatting style. Use this as a template for organizing and formatting your output. The "..." represents abbreviated content - you should expand these sections based on the PDF content while maintaining the same structural pattern and formatting style.

${exampleContent}
[EXAMPLE_NOTE_END]`;
		}

		userPrompt += `

[START_TEXT_CONTENT]
${textContent}
[END_TEXT_CONTENT]`;

		return systemPrompt + "\n\n" + userPrompt;
	}

	private async handleConvert(): Promise<void> {
		if (!this.selectedFile || !this.extractedText) {
			new Notice("Please select a PDF file first.");
			return;
		}

		const chapterName = this.chapterNameInput.getValue().trim();
		if (!chapterName) {
			new Notice("Please enter a chapter name.");
			return;
		}

		let folderPath = this.folderSelect.value;
		if (folderPath === "__new__") {
			const newFolderName = this.newFolderInput.getValue().trim();
			if (!newFolderName) {
				new Notice("Please enter a new folder name.");
				return;
			}
			folderPath = newFolderName;

			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
		}

		const finalCost = await this.costUi.update();
		if (
			!confirm(
				`This will convert the PDF to a note.\n${finalCost}\n\nProceed?`
			)
		) {
			return;
		}

		const notice = new Notice("🤖 Converting PDF to note...", 0);

		try {
			const promptText = this.buildPrompt(
				this.extractedText,
				this.exampleNoteContent
			);

			const textContentTokens = countTextTokens(this.extractedText);

			const { content: response, usage } = await this.plugin.sendToLlm(
				promptText
			);

			if (!response) {
				throw new Error("LLM returned an empty response.");
			}

			const fileName = chapterName.endsWith(".md")
				? chapterName
				: `${chapterName}.md`;
			const notePath = folderPath
				? `${folderPath}/${fileName}`
				: fileName;

			await this.app.vault.create(notePath, response);

			if (usage) {
				await logLlmCall(this.plugin, {
					action: "pdf_to_note",
					model: this.plugin.settings.openaiModel,
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
					textContentTokens,
				});
			}

			notice.setMessage(`✅ Successfully created note: ${notePath}`);
			setTimeout(() => notice.hide(), 3000);

			const newFile = this.app.vault.getAbstractFileByPath(notePath);
			if (newFile instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(newFile);
			}

			this.close();
		} catch (error) {
			notice.hide();
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			new Notice(`Failed to convert PDF: ${errorMessage}`);
			this.plugin.logger(LogLevel.NORMAL, "PDF conversion error:", error);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ExampleNoteSuggester extends Modal {
	private inputEl!: HTMLInputElement;
	private suggestionsEl!: HTMLElement;
	private allFiles: TFile[] = [];

	constructor(app: App, private onSelect: (file: TFile) => void) {
		super(app);
		this.allFiles = this.app.vault.getMarkdownFiles();
	}

	onOpen() {
		this.titleEl.setText("Select Example Note");

		this.inputEl = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Type to search notes...",
			attr: { style: "width: 100%; margin-bottom: 10px; padding: 8px;" },
		});

		this.suggestionsEl = this.contentEl.createDiv({
			attr: {
				style: "max-height: 300px; overflow-y: auto; border: 1px solid var(--background-modifier-border);",
			},
		});

		this.inputEl.addEventListener("input", () => this.updateSuggestions());
		this.inputEl.addEventListener("keydown", (e) => this.handleKeydown(e));

		this.updateSuggestions();
		this.inputEl.focus();
	}

	private updateSuggestions(): void {
		const query = this.inputEl.value.toLowerCase();
		const filtered = this.allFiles
			.filter(
				(file) =>
					file.basename.toLowerCase().includes(query) ||
					file.path.toLowerCase().includes(query)
			)
			.slice(0, 20); 

		this.suggestionsEl.empty();

		if (filtered.length === 0) {
			this.suggestionsEl.createEl("div", {
				text: "No notes found",
				attr: {
					style: "padding: 10px; text-align: center; color: var(--text-muted);",
				},
			});
			return;
		}

		filtered.forEach((file, index) => {
			const item = this.suggestionsEl.createEl("div", {
				attr: {
					style: "padding: 8px; cursor: pointer; border-bottom: 1px solid var(--background-modifier-border);",
					"data-index": index.toString(),
				},
			});

			item.createEl("div", {
				text: file.basename,
				attr: { style: "font-weight: 500;" },
			});

			item.createEl("div", {
				text: file.path,
				attr: { style: "font-size: 0.8em; color: var(--text-muted);" },
			});

			item.addEventListener("click", () => {
				this.onSelect(file);
				this.close();
			});

			item.addEventListener("mouseenter", () => {
				this.suggestionsEl
					.querySelectorAll("[data-index]")
					.forEach((el) => el.removeClass("is-selected"));
				item.addClass("is-selected");
			});
		});

		this.suggestionsEl
			.querySelector("[data-index='0']")
			?.addClass("is-selected");
	}

	private handleKeydown(e: KeyboardEvent): void {
		const selected = this.suggestionsEl.querySelector(".is-selected");
		const items = this.suggestionsEl.querySelectorAll("[data-index]");

		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (selected) {
				const currentIndex = parseInt(
					selected.getAttribute("data-index") || "0"
				);
				const nextIndex = Math.min(currentIndex + 1, items.length - 1);
				selected.removeClass("is-selected");
				items[nextIndex]?.addClass("is-selected");
			}
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			if (selected) {
				const currentIndex = parseInt(
					selected.getAttribute("data-index") || "0"
				);
				const prevIndex = Math.max(currentIndex - 1, 0);
				selected.removeClass("is-selected");
				items[prevIndex]?.addClass("is-selected");
			}
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (selected) {
				const index = parseInt(
					selected.getAttribute("data-index") || "0"
				);
				const filteredFiles = this.allFiles
					.filter(
						(file) =>
							file.basename
								.toLowerCase()
								.includes(this.inputEl.value.toLowerCase()) ||
							file.path
								.toLowerCase()
								.includes(this.inputEl.value.toLowerCase())
					)
					.slice(0, 20);

				if (filteredFiles[index]) {
					this.onSelect(filteredFiles[index]);
					this.close();
				}
			}
		} else if (e.key === "Escape") {
			this.close();
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ActionConfirmationModal extends Modal {
	private costUi!: { update: () => Promise<string> };

	constructor(
		private plugin: GatedNotesPlugin,
		private title: string,
		private getDynamicInputs: () => {
			promptText: string;
			imageCount: number;
			action: LlmLogEntry["action"];
		},
		private onConfirm: () => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		makeModalDraggable(this, this.plugin);

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(
			costContainer,
			this.getDynamicInputs
		);
		this.costUi.update();

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(async () => {
						this.onConfirm();
						this.close();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class EditModal extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private card: Flashcard,
		private graph: FlashcardGraph,
		private deck: TFile,
		private onDone: (actionTaken: boolean, newCards?: Flashcard[]) => void,
		private reviewContext?: { index: number; total: number },
		private parentContext?: "edit" | "review"
	) {
		super(plugin.app);
	}

	onOpen() {
		makeModalDraggable(this, this.plugin);
		this.titleEl.setText(
			this.reviewContext
				? `Reviewing Card ${this.reviewContext.index} of ${this.reviewContext.total}`
				: "Edit Card"
		);
		this.contentEl.addClass("gn-edit-container");

		const nav = this.contentEl.createDiv({ cls: "gn-edit-nav" });
		const editButton = nav.createEl("button", {
			text: "Edit",
			cls: "active",
		});
		const previewButton = nav.createEl("button", { text: "Preview" });

		const panesContainer = this.contentEl.createDiv();
		const editPane = panesContainer.createDiv({ cls: "gn-edit-pane" });
		const previewPane = panesContainer.createDiv({
			cls: "gn-edit-pane",
			attr: { style: "display: none;" },
		});

		const createRow = (label: string, parent: HTMLElement): HTMLElement => {
			const row = parent.createDiv({ cls: "gn-edit-row" });
			row.createEl("label", { text: label });
			return row;
		};

		const frontInput = createRow("Front:", editPane).createEl("textarea", {
			attr: { rows: 3 },
		});
		frontInput.value = this.card.front;

		const backInput = createRow("Back:", editPane).createEl("textarea", {
			attr: { rows: 3 },
		});
		backInput.value = this.card.back;

		const tagInput = createRow("Tag:", editPane).createEl("textarea", {
			attr: { rows: 2 },
		});
		tagInput.value = this.card.tag;

		const paraInput = createRow("Para #:", editPane).createEl("input", {
			type: "number",
			value: (this.card.paraIdx ?? "").toString(),
		});

		new Setting(editPane)
			.setName("Flag this card")
			.setDesc("Mark this card for future attention.")
			.addToggle((toggle) => {
				toggle.setValue(!!this.card.flagged).onChange((value) => {
					this.card.flagged = value;
				});
			});

		new Setting(editPane)
			.setName("Suspend this card")
			.setDesc(
				"Temporarily remove this card from reviews and content gating."
			)
			.addToggle((toggle) => {
				toggle.setValue(!!this.card.suspended).onChange((value) => {
					this.card.suspended = value;
				});
			});

		editButton.onclick = () => {
			editButton.addClass("active");
			previewButton.removeClass("active");
			editPane.style.display = "";
			previewPane.style.display = "none";
		};

		previewButton.onclick = async () => {
			previewButton.addClass("active");
			editButton.removeClass("active");
			previewPane.style.display = "";
			editPane.style.display = "none";

			previewPane.empty();
			const previewFrontContainer = previewPane.createDiv();
			const previewBackContainer = previewPane.createDiv();

			previewFrontContainer.createEl("h4", { text: "Front Preview" });
			await this.plugin.renderCardContent(
				frontInput.value,
				previewFrontContainer,
				this.card.chapter
			);

			previewBackContainer.createEl("hr");
			previewBackContainer.createEl("h4", { text: "Back Preview" });
			await this.plugin.renderCardContent(
				backInput.value,
				previewBackContainer,
				this.card.chapter
			);
		};

		const btnRow = this.contentEl.createDiv({ cls: "gn-edit-btnrow" });

		if (!this.reviewContext) {
			new ButtonComponent(btnRow)
				.setButtonText("Reset Progress")
				.setWarning()
				.onClick(async () => {
					if (
						!confirm(
							"Are you sure you want to reset the review progress for this card? This cannot be undone."
						)
					) {
						return;
					}

					this.plugin.resetCardProgress(this.card);
					await this.saveCardState(
						frontInput,
						backInput,
						tagInput,
						paraInput
					);
					new Notice("Card progress has been reset.");
					this.close();
					this.onDone(true);
				});

			new ButtonComponent(btnRow)
				.setButtonText("Refocus with AI")
				.onClick(async (evt) => await this.handleRefocus(evt));
			new ButtonComponent(btnRow)
				.setButtonText("Split with AI")
				.onClick(async (evt) => await this.handleSplit(evt));
		}

		if (this.reviewContext) {
			new ButtonComponent(btnRow)
				.setButtonText("Delete Card")
				.setWarning()
				.onClick(async () => {
					if (
						!confirm(
							"Are you sure you want to delete this new card?"
						)
					)
						return;
					delete this.graph[this.card.id];
					await this.plugin.writeDeck(this.deck.path, this.graph);
					new Notice("Card deleted.");
					this.plugin.refreshAllStatuses();
					this.close();
					this.onDone(true);
				});
			new ButtonComponent(btnRow)
				.setButtonText("Save & Close Review")
				.onClick(async () => {
					await this.saveCardState(
						frontInput,
						backInput,
						tagInput,
						paraInput
					);
					this.close();
					this.onDone(false);
				});

			if (this.reviewContext.index < this.reviewContext.total) {
				new ButtonComponent(btnRow)
					.setButtonText(
						`Save & Next (${this.reviewContext.index}/${this.reviewContext.total})`
					)
					.setCta()
					.onClick(async () => {
						await this.saveCardState(
							frontInput,
							backInput,
							tagInput,
							paraInput
						);
						this.close();
						this.onDone(true);
					});
			} else {
				new ButtonComponent(btnRow)
					.setButtonText("Save & Finish")
					.setCta()
					.onClick(async () => {
						await this.saveCardState(
							frontInput,
							backInput,
							tagInput,
							paraInput
						);
						this.close();
						this.onDone(true);
					});
			}
		} else {
			new ButtonComponent(btnRow)
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					await this.saveCardState(
						frontInput,
						backInput,
						tagInput,
						paraInput
					);
					new Notice("Card saved.");
					this.close();
					this.onDone(false);
				});
		}
	}

	private async saveCardState(
		frontInput: HTMLTextAreaElement,
		backInput: HTMLTextAreaElement,
		tagInput: HTMLTextAreaElement,
		paraInput: HTMLInputElement
	) {
		this.card.front = frontInput.value.trim();
		this.card.back = backInput.value.trim();
		this.card.tag = tagInput.value.trim();
		this.card.paraIdx = Number(paraInput.value) || undefined;
		this.graph[this.card.id] = this.card;
		await this.plugin.writeDeck(this.deck.path, this.graph);
		this.plugin.refreshReading();
		this.plugin.refreshAllStatuses();
	}

	private _createCardsFromLlmResponse(response: string): Flashcard[] {
		const items = extractJsonObjects<{ front: string; back: string }>(
			response
		).filter((i) => i.front && i.back);

		return items.map((i) =>
			this.plugin.createCardObject({
				front: i.front.trim(),
				back: i.back.trim(),
				tag: this.card.tag,
				chapter: this.card.chapter,
				paraIdx: this.card.paraIdx,
			})
		);
	}

	private async handleRefocus(evt: MouseEvent) {
		new RefocusOptionsModal(this.plugin, (result) => {
			if (!result) return;
	
			const { quantity, preventDuplicates } = result;
			const buttonEl = evt.target as HTMLButtonElement;
	
			const getDynamicInputsForCost = () => {
				let contextPrompt = "";
				if (preventDuplicates) {
					const otherCards = Object.values(this.graph).filter(
						(c) => c.chapter === this.card.chapter && c.id !== this.card.id
					);
					if (otherCards.length > 0) {
						const simplified = otherCards.map((c) => ({
							front: c.front,
							back: c.back,
						}));
						contextPrompt = `To avoid duplicates, do not create cards that cover the same information as the following existing cards:\nExisting Cards:\n${JSON.stringify(simplified)}\n\n`;
					}
				}
				
				const cardJson = JSON.stringify({
					front: this.card.front,
					back: this.card.back,
				});
	
				// RESTORED: Full original prompt
				const basePrompt = `You are an AI assistant that creates a new, insightful flashcard by "refocusing" an existing one.
	
	**Core Rule:** Your new card MUST be created by inverting the information **explicitly present** in the original card's "front" and "back" fields. The "Source Text" is provided only for context and should NOT be used to introduce new facts into the new card.
	
	**Thought Process:**
	1.  **Deconstruct the Original Card:** Identify the key subject in the "back" and the key detail in the "front".
	2.  **Invert & Refocus:** Create a new card where the original detail becomes the subject of the question, and the original subject becomes the answer.
	
	---
	**Example 1:**
	* **Original Card:**
		* "front": "What was the outcome of the War of Fakery in 1653?"
		* "back": "Country A decisively defeated Country B."
	* **Refocused Card (testing the date, which is in the front):**
		* "front": "In what year did the War of Fakery take place?"
		* "back": "1653"
	
	**Example 2:**
	* **Original Card:**
		* "front": "Who is said to have lived circa 365–circa 270 BC?"
		* "back": "Pyrrho"
	* **Refocused Card (testing the date, which is in the front):**
		* "front": "What were the approximate years of Pyrrho's life?"
		* "back": "circa 365–circa 270 BC"
	---
	
	**Your Task:**
	Now, apply this process to the following card.`;
	
				const quantityInstruction = quantity === "one" 
					? `Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]`
					: `Create one or more cards and return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]`;
	
				const sourceText = JSON.stringify(this.card.tag);
				const promptText = `${contextPrompt}${basePrompt}
	
	**Original Card:**
	${cardJson}
	
	**Source Text for Context (use only to understand the card, not to add new facts):**
	${sourceText}
	
	${quantityInstruction}`;
	
				return {
					promptText,
					imageCount: 0,
					action: "refocus" as const,
				};
			};
	
			new ActionConfirmationModal(
				this.plugin,
				"Confirm Refocus",
				getDynamicInputsForCost,
				async () => {
					buttonEl.disabled = true;
					buttonEl.setText("Refocusing...");
					new Notice("🤖 Generating alternative card(s)...");
	
					try {
						const { promptText } = getDynamicInputsForCost();
						const { content: response, usage } = await this.plugin.sendToLlm(promptText);
	
						if (!response) throw new Error("LLM returned an empty response.");
						const newCards = this._createCardsFromLlmResponse(response);
						if (newCards.length === 0) throw new Error("Could not parse new cards from LLM response.");
	
						if (usage) {
							await logLlmCall(this.plugin, {
								action: "refocus",
								model: this.plugin.settings.openaiModel,
								inputTokens: usage.prompt_tokens,
								outputTokens: usage.completion_tokens,
								cardsGenerated: newCards.length,
							});
						}
	
						newCards.forEach((card) => (this.graph[card.id] = card));
						await this.plugin.writeDeck(this.deck.path, this.graph);
	
						this.close();
						await this.plugin.promptToReviewNewCards(newCards, this.deck, this.graph);
						this.onDone(true);
					} catch (e: unknown) {
						new Notice(`Failed to generate cards: ${(e as Error).message}`);
					} finally {
						buttonEl.disabled = false;
						buttonEl.setText("Refocus with AI");
					}
				}
			).open();
		}).open();
	}

	private async handleSplit(evt: MouseEvent) {
		new SplitOptionsModal(this.plugin, (result) => {
			if (!result) return;
	
			const { preventDuplicates } = result;
			const buttonEl = evt.target as HTMLButtonElement;
	
			const getDynamicInputsForCost = () => {
				let contextPrompt = "";
				if (preventDuplicates) {
					const otherCards = Object.values(this.graph).filter(
						(c) => c.chapter === this.card.chapter && c.id !== this.card.id
					);
					if (otherCards.length > 0) {
						const simplified = otherCards.map((c) => ({
							front: c.front,
							back: c.back,
						}));
						contextPrompt = `To avoid duplicates, do not create cards that cover the same information as the following existing cards:\nExisting Cards:\n${JSON.stringify(simplified)}\n\n`;
					}
				}
				
				const cardJson = JSON.stringify({
					front: this.card.front,
					back: this.card.back,
				});
	
				const promptText = `${contextPrompt}Take the following flashcard and split it into one or more new, simpler, more atomic flashcards. The original card may be too complex or cover multiple ideas.
	
	Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]
	
	---
	**Original Card:**
	${cardJson}
	---`;
	
				return { promptText, imageCount: 0, action: "split" as const };
			};
	
			new ActionConfirmationModal(
				this.plugin,
				"Confirm Split",
				getDynamicInputsForCost,
				async () => {
					buttonEl.disabled = true;
					buttonEl.setText("Splitting...");
					new Notice("🤖 Splitting card with AI...");
	
					try {
						const { promptText } = getDynamicInputsForCost();
						const { content: response, usage } = await this.plugin.sendToLlm(promptText);
	
						if (!response) throw new Error("LLM returned an empty response.");
						const newCards = this._createCardsFromLlmResponse(response);
						if (newCards.length === 0) throw new Error("Could not parse new cards from LLM response.");
	
						if (usage) {
							await logLlmCall(this.plugin, {
								action: "split",
								model: this.plugin.settings.openaiModel,
								inputTokens: usage.prompt_tokens,
								outputTokens: usage.completion_tokens,
								cardsGenerated: newCards.length,
							});
						}
	
						delete this.graph[this.card.id];
						newCards.forEach((newCard) => (this.graph[newCard.id] = newCard));
						await this.plugin.writeDeck(this.deck.path, this.graph);
	
						this.close();
						await this.plugin.promptToReviewNewCards(newCards, this.deck, this.graph);
						this.onDone(true);
					} catch (e: unknown) {
						new Notice(`Error splitting card: ${(e as Error).message}`);
					} finally {
						buttonEl.disabled = false;
						buttonEl.setText("Split with AI");
					}
				}
			).open();
		}).open();
	}
}

class RefocusOptionsModal extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private onDone: (
			result: {
				quantity: "one" | "many";
				preventDuplicates: boolean;
			} | null
		) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Refocus Card");
		makeModalDraggable(this, this.plugin);

		let preventDuplicates = true;
		let choiceMade = false;

		this.contentEl.createEl("p", {
			text: "How many alternative cards would you like to generate?",
		});

		new Setting(this.contentEl)
			.setName("Prevent creating duplicate cards")
			.setDesc(
				"Sends existing cards to the AI for context to avoid creating similar ones."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(preventDuplicates)
					.onChange((value) => (preventDuplicates = value));
			});

		const btnRow = this.contentEl.createDiv({ cls: "gn-edit-btnrow" });

		new ButtonComponent(btnRow).setButtonText("Cancel").onClick(() => {
			choiceMade = true;
			this.close();
			this.onDone(null);
		});

		new ButtonComponent(btnRow).setButtonText("Just One").onClick(() => {
			choiceMade = true;
			this.close();
			this.onDone({ quantity: "one", preventDuplicates });
		});

		new ButtonComponent(btnRow)
			.setButtonText("One or More")
			.setCta()
			.onClick(() => {
				choiceMade = true;
				this.close();
				this.onDone({ quantity: "many", preventDuplicates });
			});

		this.onClose = () => {
			if (!choiceMade) {
				this.onDone(null);
			}
		};
	}
}

class SplitOptionsModal extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private onDone: (result: { preventDuplicates: boolean } | null) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Split Card");
		makeModalDraggable(this, this.plugin);

		let preventDuplicates = true;

		new Setting(this.contentEl)
			.setName("Prevent creating duplicate cards")
			.setDesc(
				"Sends existing cards to the AI for context to avoid creating similar ones."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(preventDuplicates)
					.onChange((value) => (preventDuplicates = value));
			});

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
					this.onDone(null);
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Split")
					.setCta()
					.onClick(() => {
						this.close();
						this.onDone({ preventDuplicates });
					})
			);
	}
}

class CardBrowser extends Modal {
	private showOnlyFlagged = false;
	private showOnlySuspended = false;
	private treePane!: HTMLElement;
	private editorPane!: HTMLElement;

	constructor(
		private plugin: GatedNotesPlugin,
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
			const graph = await this.plugin.readDeck(deck.path);
			let cards: Flashcard[] = Object.values(graph).filter(
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
					await this.plugin.writeDeck(deck.path, graph);
					this.plugin.refreshAllStatuses();
					await this.renderContent();
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

class GenerateCardsModal extends Modal {
	private countInput!: TextComponent;
	private guidanceInput?: TextAreaComponent;
	private defaultCardCount: number = 1;
	private costUi!: { update: () => Promise<string> };

	constructor(
		private plugin: GatedNotesPlugin,
		private file: TFile,
		private callback: (
			result: {
				count: number;
				guidance: string;
			} | null
		) => void
	) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Generate Flashcards");
		makeModalDraggable(this, this.plugin);

		const wrappedContent = await this.plugin.app.vault.read(this.file);
		const plainText = getParagraphsFromFinalizedNote(wrappedContent)
			.map((p) => p.markdown)
			.join("\n\n");
		const wordCount = plainText.split(/\s+/).filter(Boolean).length;
		this.defaultCardCount = Math.max(1, Math.round(wordCount / 100));

		new Setting(this.contentEl)
			.setName("Number of cards to generate")
			.addText((text) => {
				this.countInput = text;
				text.setValue(String(this.defaultCardCount));
				text.inputEl.type = "number";
				text.onChange(() => this.costUi.update());
			});

		const guidanceContainer = this.contentEl.createDiv();
		const addGuidanceBtn = new ButtonComponent(guidanceContainer)
			.setButtonText("Add Custom Guidance")
			.onClick(() => {
				addGuidanceBtn.buttonEl.style.display = "none";
				new Setting(guidanceContainer)
					.setName("Custom Guidance")
					.setDesc(
						"Provide specific instructions for the AI (e.g., 'All answers must be a single word')."
					)
					.addTextArea((text) => {
						this.guidanceInput = text;
						text.setPlaceholder("Your custom instructions...");
						text.inputEl.rows = 4;
						text.inputEl.style.width = "100%";
						text.onChange(() => this.costUi.update());
					});
			});
		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(costContainer, () => {
			const count =
				Number(this.countInput.getValue()) || this.defaultCardCount;
			const guidance = this.guidanceInput?.getValue() || "";

			const promptText = `Create ${count} new, distinct Anki-style flashcards...${guidance}...Here is the article:\n${plainText}`;
			return {
				promptText: promptText,
				imageCount: 0,
				action: "generate",
				details: { cardCount: count },
			};
		});
		this.costUi.update();

		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText("Generate")
					.setCta()
					.onClick(async () => {
						const finalCost = await this.costUi.update();
						if (
							!confirm(
								`This will generate ${this.countInput.getValue()} card(s).\n${finalCost}\n\nProceed?`
							)
						) {
							return;
						}

						const count = Number(this.countInput.getValue());
						this.callback({
							count: count > 0 ? count : this.defaultCardCount,
							guidance: this.guidanceInput?.getValue() || "",
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

class CountModal extends Modal {
	private costUi!: { update: () => Promise<string> };
	private countInput!: TextComponent;

	constructor(
		private plugin: GatedNotesPlugin,
		private defaultValue: number,
		private selectionText: string,
		private sourcePath: string,
		private callback: (num: number) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Cards to Generate from Selection");
		makeModalDraggable(this, this.plugin);
		this.contentEl.createEl("p", {
			text: "How many cards should the AI generate for this selection?",
		});

		this.countInput = new TextComponent(this.contentEl).setValue(
			String(this.defaultValue)
		);
		this.countInput.inputEl.type = "number";
		this.countInput.onChange(() => this.costUi.update());

		this.countInput.inputEl.addEventListener(
			"keydown",
			(e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.submitAndConfirm();
				}
			}
		);

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(costContainer, () => {
			const count =
				Number(this.countInput.getValue()) || this.defaultValue;
			const promptText = `From the following text, create ${count} concise flashcard(s)...Text:\n"""\n${this.selectionText}\n"""`;
			return {
				promptText: promptText,
				imageCount: 0,
				action: "generate_from_selection_many",
				details: { cardCount: count },
			};
		});
		this.costUi.update();

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((button) =>
				button
					.setButtonText("Generate")
					.setCta()
					.onClick(() => this.submitAndConfirm())
			);

		setTimeout(() => this.countInput.inputEl.focus(), 50);
	}

	private async submitAndConfirm() {
		const finalCost = await this.costUi.update();
		if (
			!confirm(
				`This will generate ${this.countInput.getValue()} card(s).\n${finalCost}\n\nProceed?`
			)
		) {
			return;
		}

		const num = Number(this.countInput.getValue());
		this.close();
		this.callback(num > 0 ? num : this.defaultValue);
	}
}

class GenerateAdditionalCardsModal extends Modal {
	private countInput!: TextComponent;
	private preventDuplicatesToggle!: ToggleComponent;
	private guidanceInput?: TextAreaComponent;
	private costUi!: { update: () => Promise<string> };

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
				text.onChange(() => this.costUi.update());
			});

		new Setting(this.contentEl)
			.setName("Prevent creating duplicate cards")
			.setDesc(
				"Sends existing cards to the AI for context to avoid creating similar ones. (This will increase API token usage)."
			)
			.addToggle((toggle) => {
				this.preventDuplicatesToggle = toggle;
				toggle.setValue(true);
				toggle.onChange(() => this.costUi.update());
			});

		const guidanceContainer = this.contentEl.createDiv();
		const addGuidanceBtn = new ButtonComponent(guidanceContainer)
			.setButtonText("Add Custom Guidance")
			.onClick(() => {
				addGuidanceBtn.buttonEl.style.display = "none";
				new Setting(guidanceContainer)
					.setName("Custom Guidance")
					.setDesc(
						"Provide specific instructions for this generation task."
					)
					.addTextArea((text) => {
						this.guidanceInput = text;
						text.setPlaceholder("Your custom instructions...");
						text.inputEl.rows = 4;
						text.inputEl.style.width = "100%";
						text.onChange(() => this.costUi.update());
					});
			});

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(costContainer, () => {
			let contextPrompt = "";
			if (this.preventDuplicatesToggle.getValue()) {
				const simplifiedCards = this.existingCards.map((c) => ({
					front: c.front,
					back: c.back,
				}));
				contextPrompt = `To avoid duplicates...:\n${JSON.stringify(
					simplifiedCards
				)}\n\n`;
			}
			const guidance = this.guidanceInput?.getValue() || "";
			const count =
				Number(this.countInput.getValue()) || defaultCardCount;

			const promptText = `Create ${count} new...${guidance}...${contextPrompt}Here is the article:\n${plainText}`;
			return {
				promptText: promptText,
				imageCount: 0,
				action: "generate_additional",
				details: { cardCount: count },
			};
		});
		this.costUi.update();

		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText("Generate")
					.setCta()
					.onClick(async () => {
						const finalCost = await this.costUi.update();
						if (
							!confirm(
								`This will generate ${this.countInput.getValue()} additional card(s).\n${finalCost}\n\nProceed?`
							)
						) {
							return;
						}
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

function findTextRange(tag: string, container: HTMLElement): Range {

	const normalize = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^\w\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

	const convertMarkdownToText = (text: string): string => {
		const converted = text
			.replace(/\*\*(.*?)\*\*/g, '$1')  
			.replace(/\*(.*?)\*/g, '$1')     
			.replace(/_(.*?)_/g, '$1')       
			.replace(/`(.*?)`/g, '$1')       
			;
		return converted;
	};

	const rawFullText = container.textContent ?? "";
	const convertedTag = convertMarkdownToText(tag);

	const normalizedTag = normalize(convertedTag);
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

function extractJsonArray<T>(s: string): T[] {
    const fixJsonString = (str: string) => {
        return str
            .replace(/```json\s*|\s*```/g, '')
            .trim()
            .replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    };

    try {
        const parsed = JSON.parse(s.trim());
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e1) {
        try {
            const fixed = fixJsonString(s);
            const parsed = JSON.parse(fixed);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e2) {
            try {
                const arrayMatch = s.match(/\[[\s\S]*\]/);
                if (arrayMatch) {
                    const fixed = fixJsonString(arrayMatch[0]);
                    const parsed = JSON.parse(fixed);
                    return Array.isArray(parsed) ? parsed : [parsed];
                }
            } catch (e3) {
                console.log("All JSON parsing methods failed");
            }
        }
    }

    throw new Error("Could not parse JSON from LLM response");
}

function extractJsonObjects<T>(s: string): T[] {
    const fixJsonString = (str: string) => {
        return str
            .replace(/```json\s*|\s*```/g, '')
            .trim()
            .replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    };

    try {
        const j = JSON.parse(s);
        return Array.isArray(j) ? j : [j];
    } catch {}

    try {
        const fixed = fixJsonString(s);
        const j = JSON.parse(fixed);
        return Array.isArray(j) ? j : [j];
    } catch {}

    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) {
        try {
            const j = JSON.parse(fence[1]);
            return Array.isArray(j) ? j : [j];
        } catch {}
        
        try {
            const fixed = fixJsonString(fence[1]);
            const j = JSON.parse(fixed);
            return Array.isArray(j) ? j : [j];
        } catch {}
    }

    const arr = s.match(/\[\s*[\s\S]*?\s*\]/);
    if (arr && arr[0]) {
        try {
            const parsed = JSON.parse(arr[0]);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {}
        
        try {
            const fixed = fixJsonString(arr[0]);
            const parsed = JSON.parse(fixed);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {}
    }

    const objMatch = s.match(/\{\s*[\s\S]*?\s*\}/);
    if (objMatch && objMatch[0]) {
        try {
            return [JSON.parse(objMatch[0])];
        } catch {}
        
        try {
            const fixed = fixJsonString(objMatch[0]);
            return [JSON.parse(fixed)];
        } catch {}
    }

    const frontBackRegex = /^\s*Front:\s*(?<front>[\s\S]+?)\s*Back:\s*(?<back>[\s\S]+?)\s*$/im;
    const match = s.match(frontBackRegex);

    if (match && match.groups) {
        const { front, back } = match.groups;
        if (front && back) {
            return [{ front: front.trim(), back: back.trim() }] as T[];
        }
    }

    throw new Error("No valid JSON object, array, or Front/Back structure found in the string.");
}

function countTextTokens(text: string): number {
	if (!text) return 0;
	return encode(text).length;
}

function calculateImageTokens(imageCount: number): number {
	return imageCount * IMAGE_TOKEN_COST;
}

async function getLlmLog(plugin: GatedNotesPlugin): Promise<LlmLogEntry[]> {
	const logPath = normalizePath(
		plugin.app.vault.getRoot().path + LLM_LOG_FILE
	);
	if (!(await plugin.app.vault.adapter.exists(logPath))) {
		return [];
	}
	try {
		const content = await plugin.app.vault.adapter.read(logPath);
		return JSON.parse(content) as LlmLogEntry[];
	} catch (e) {
		plugin.logger(LogLevel.NORMAL, "Failed to read LLM Log", e);
		return [];
	}
}

async function estimateOutputTokens(
	plugin: GatedNotesPlugin,
	action: LlmLogEntry["action"],
	model: string,
	details: { cardCount?: number; textContentTokens?: number } = {}
): Promise<number> {
	const log = await getLlmLog(plugin);

	if (action === "generate" || action === "generate_additional") {
		const relevantEntries = log.filter(
			(entry) =>
				(entry.action === "generate" ||
					entry.action === "generate_additional") &&
				entry.model === model &&
				entry.cardsGenerated &&
				entry.cardsGenerated > 0
		);

		if (relevantEntries.length < 1) return 0;

		const totalTokens = relevantEntries.reduce(
			(sum, entry) => sum + entry.outputTokens,
			0
		);
		const totalCards = relevantEntries.reduce(
			(sum, entry) => sum + entry.cardsGenerated!,
			0
		);

		const avgTokensPerCard = totalCards > 0 ? totalTokens / totalCards : 0;

		return Math.round(avgTokensPerCard * (details.cardCount || 1));
	} else if (action === "pdf_to_note") {
		const relevantEntries = log.filter(
			(entry) =>
				entry.action === "pdf_to_note" &&
				entry.model === model &&
				entry.textContentTokens &&
				entry.textContentTokens > 0
		);

		if (relevantEntries.length < 1) {
			return details.textContentTokens || 0;
		}

		const totalOutputTokens = relevantEntries.reduce(
			(sum, entry) => sum + entry.outputTokens,
			0
		);
		const totalTextTokens = relevantEntries.reduce(
			(sum, entry) => sum + entry.textContentTokens!,
			0
		);

		const outputToTextRatio =
			totalTextTokens > 0 ? totalOutputTokens / totalTextTokens : 1;
		return Math.round((details.textContentTokens || 0) * outputToTextRatio);
	}

	const relevantEntries = log.filter(
		(entry) => entry.action === action && entry.model === model
	);

	if (relevantEntries.length < 1) {
		return 0;
	}

	const totalOutputTokens = relevantEntries.reduce(
		(sum, entry) => sum + entry.outputTokens,
		0
	);
	return Math.round(totalOutputTokens / relevantEntries.length);
}

async function getEstimatedCost(
	plugin: GatedNotesPlugin,
	provider: "openai" | "lmstudio",
	model: string,
	action: LlmLogEntry["action"],
	inputTokens: number,
	details: { cardCount?: number } = {}
): Promise<{
	totalCost: number;
	inputCost: number;
	outputCost: number;
	formattedString: string;
}> {
	if (provider === "lmstudio") {
		return {
			totalCost: 0,
			inputCost: 0,
			outputCost: 0,
			formattedString: "Cost: $0.00 (local model)",
		};
	}

	const estimatedOutput = await estimateOutputTokens(
		plugin,
		action,
		model,
		details
	);

	const costResult = await aicostCalculate({
		provider: "openai",
		model: model as any,
		inputAmount: inputTokens,
		outputAmount: estimatedOutput,
	});

	if (costResult === null) {
		return {
			totalCost: 0,
			inputCost: 0,
			outputCost: 0,
			formattedString: "Cost: N/A (unknown model)",
		};
	}

	const { inputCost, outputCost } = costResult;
	const totalCost = inputCost + outputCost;

	let formattedString = `Est. Cost: ~$${totalCost.toFixed(4)}`;
	if (estimatedOutput > 0) {
		formattedString += ` (Prompt: $${inputCost.toFixed(
			4
		)} + Est. Response: $${outputCost.toFixed(4)})`;
	} else {
		formattedString += ` (for prompt)`;
	}

	return { totalCost, inputCost, outputCost, formattedString };
}

async function logLlmCall(
	plugin: GatedNotesPlugin,
	data: Omit<LlmLogEntry, "timestamp" | "cost">
) {
	const logPath = normalizePath(
		plugin.app.vault.getRoot().path + LLM_LOG_FILE
	);
	const log = await getLlmLog(plugin);

	const costResult = await aicostCalculate({
		provider: "openai",
		model: data.model as any,
		inputAmount: data.inputTokens,
		outputAmount: data.outputTokens,
	});

	const totalCost = costResult
		? costResult.inputCost + costResult.outputCost
		: null;

	const newEntry: LlmLogEntry = {
		...data,
		timestamp: Date.now(),
		cost: totalCost,
	};

	log.push(newEntry);

	await plugin.app.vault.adapter.write(logPath, JSON.stringify(log, null, 2));
}
