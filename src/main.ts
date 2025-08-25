import {
	App,
	ButtonComponent,
	Editor,
	FileView,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	RequestUrlParam,
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

import * as JSZip from "jszip";

const DECK_FILE_NAME = "_flashcards.json";
const SPLIT_TAG = "---GATED-NOTES-SPLIT---";
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

/**
 * Represents a single flashcard within the system.
 */
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

/**
 * Defines the settings for the Gated Notes plugin.
 */
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
	/** The OpenAI model to use for multimodal (image analysis) tasks. */
	openaiMultimodalModel: string;
	/** Whether to analyze images and include their descriptions during card generation. */
	analyzeImagesOnGenerate: boolean;
	/** The default processing mode for PDF-to-note conversion. */
	defaultPdfMode: "text" | "hybrid";
	/** The default DPI for rendering PDF pages as images in hybrid mode. */
	defaultPdfDpi: number;
	/** The default maximum width for rendered PDF page images. */
	defaultPdfMaxWidth: number;
	/** The maximum number of tokens the AI should generate per page in PDF hybrid mode. */
	pdfMaxTokensPerPage: number;
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
	defaultPdfMode: "text",
	defaultPdfDpi: 200,
	defaultPdfMaxWidth: 1400,
	pdfMaxTokensPerPage: 4000,
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

/**
 * Represents a log entry for a call to a Large Language Model.
 */
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
	details?: {
		cardCount?: number;
		textContentTokens?: number;
		isVariableOutput?: boolean;
		isHybrid?: boolean;
		pageCount?: number;
	};
}

interface EpubSection {
	id: string;
	title: string;
	level: number;
	href: string;
	children: EpubSection[];
	content?: string;
	selected: boolean;
}

interface EpubStructure {
	title: string;
	author?: string;
	sections: EpubSection[];
	manifest: { [id: string]: { href: string; mediaType: string } };
}

const LLM_LOG_FILE = "_llm_log.json";
const IMAGE_TOKEN_COST = 1105;

/**
 * The main class for the Gated Notes plugin, handling all logic and UI.
 */
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

	/**
	 * Logs a message to the console if the specified log level is met.
	 * @param level The log level of the message.
	 * @param message The message to log.
	 * @param optionalParams Additional data to log with the message.
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

	/**
	 * Creates and manages a UI element for estimating the cost of an LLM call.
	 * @param container The HTMLElement to append the cost estimator to.
	 * @param getDynamicInputs A function that returns the necessary inputs for cost calculation.
	 * @returns An object with an `update` method to refresh the cost estimation.
	 */
	public createCostEstimatorUI(
		container: HTMLElement,
		getDynamicInputs: () =>
			| GetDynamicInputsResult
			| Promise<GetDynamicInputsResult>
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
			const result = getDynamicInputs();
			const { promptText, imageCount, action, details } =
				result instanceof Promise ? await result : result;

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
			id: "gn-insert-split",
			name: "Insert paragraph split marker",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const currentLine = editor.getLine(cursor.line);

				if (currentLine.trim() === "") {
					editor.setLine(cursor.line, SPLIT_TAG);
				} else {
					editor.replaceSelection(`\n${SPLIT_TAG}\n`);
				}
			},
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
		this.addCommand({
			id: "gn-epub-to-note",
			name: "Convert EPUB to Note (Experimental)",
			callback: () => new EpubToNoteModal(this).open(),
		});
		this.addCommand({
			id: "gn-remove-all-split-tags",
			name: "Remove all manual split tags from current note",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;

				const content = view.editor.getValue();
				if (!content.includes(SPLIT_TAG)) return false;

				if (!checking) {
					const newContent = this.cleanupAfterSplitRemoval(content);
					view.editor.setValue(newContent);
					new Notice("All manual split tags removed.");
				}
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
			// Using a custom fetch adapter with Obsidian's requestUrl
			// is more robust for handling requests in the Obsidian environment.
			const customFetch = async (
				url: RequestInfo | URL,
				init?: RequestInit
			): Promise<Response> => {
				const headers: Record<string, string> = {};
				if (init?.headers) {
					// The openai-node SDK passes a Headers object. We need to convert it to
					// a plain Record<string, string> for Obsidian's requestUrl function.
					new Headers(init.headers).forEach((value, key) => {
						headers[key] = value;
					});
				}

				const requestParams: RequestUrlParam = {
					url: url.toString(),
					method: init?.method ?? 'GET',
					headers: headers,
					body: init?.body as string | ArrayBuffer,
					throw: false,
				};
				const obsidianResponse = await requestUrl(requestParams);
				return new Response(obsidianResponse.arrayBuffer, {
					status: obsidianResponse.status,
					headers: new Headers(obsidianResponse.headers),
				});
			};
			this.openai = new OpenAI({
				apiKey: openaiApiKey,
				dangerouslyAllowBrowser: true,
				fetch: customFetch,
			});
		} else {
			this.openai = new OpenAI({
				baseURL: `${lmStudioUrl.replace(/\/$/, "")}/v1`,
				apiKey: "lm-studio",
				dangerouslyAllowBrowser: true,
				// LM Studio is local, so default fetch is usually fine.
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

			const mdView = await this.navigateToChapter(activeFile);
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

			const paraSelector = `.${PARA_CLASS}[${PARA_ID_ATTR}="${currentParaIdx}"]`;
			const wrapper = await waitForEl<HTMLElement>(
				paraSelector,
				view.previewMode.containerEl
			);

			if (wrapper && wrapper.innerText.trim() !== "") {
				wrapper.scrollIntoView({
					// block: "center",
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

		// If we get here, we didn't find a contentful paragraph to scroll to.
		// This is not an error, just means the unlocked content was empty paragraphs.
		this.logger(
			LogLevel.VERBOSE,
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

				if (this.studyMode === StudyMode.CHAPTER) {
					// In chapter mode, we only want to review cards that are at or before the current content gate.
					// This includes due review cards and the new cards that are blocking progress.
					if ((card.paraIdx ?? Infinity) > firstBlockedParaIdx) {
						continue;
					}
				} else {
					// In other modes (Subject, Review-only), we don't want to see new cards.
					const isNew = isUnseen(card);
					if (isNew) continue;
				}
				reviewPool.push({ card, deck });
			}
		}

		reviewPool.sort((a, b) => {
			const aIsNew = isUnseen(a.card);
			const bIsNew = isUnseen(b.card);

			// In chapter focus mode, we want to see review cards first, then new cards.
			if (this.studyMode === StudyMode.CHAPTER) {
				if (aIsNew !== bIsNew) {
					return aIsNew ? 1 : -1; // This sorts non-new cards (reviews) before new cards.
				}
			} else {
				// In other modes, new cards (if they were to be included) would come first.
				if (aIsNew !== bIsNew) {
					return aIsNew ? -1 : 1;
				}
			}

			// For cards of the same type (e.g., both are review cards), sort by due date.
			// If due dates are the same, sort by their position in the note.
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
			} else if (userChoice === "remove") {
				const contentWithoutSplits = content.replace(
					new RegExp(escapeRegExp(SPLIT_TAG), "g"),
					""
				);
				return this.performAutoFinalize(file, contentWithoutSplits);
			} else if (userChoice === null) {
				return;
			}
		} else {
			return this.performAutoFinalize(file, content);
		}
	}

	private async performAutoFinalize(
		file: TFile,
		content: string
	): Promise<void> {
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

		const normalizedContent = this.normalizeSplitContent(content);
		const chunks = normalizedContent.split(SPLIT_TAG);

		const wrappedContent = chunks
			.map((md, i) => {
				const trimmedMd = md.trim();
				return `<br class="gn-sentinel"><div class="${PARA_CLASS}" ${PARA_ID_ATTR}="${
					i + 1
				}" ${PARA_MD_ATTR}="${md2attr(trimmedMd)}"></div>`;
			})
			.join("\n\n");

		await this.app.vault.modify(file, wrappedContent);
		new Notice("Note manually finalized. Gating is now active.");
	}

	private normalizeSplitContent(content: string): string {
		let normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		normalized = normalized.replace(/\n{3,}/g, "\n\n");

		normalized = normalized.replace(
			new RegExp(`\\s*${escapeRegExp(SPLIT_TAG)}\\s*`, "g"),
			`\n${SPLIT_TAG}\n`
		);

		normalized = normalized.replace(/\n{3,}/g, "\n\n");

		return normalized.trim();
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
			.join(`\n${SPLIT_TAG}\n`)
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

	private cleanupAfterSplitRemoval(content: string): string {
		let cleaned = content.replace(
			new RegExp(escapeRegExp(SPLIT_TAG), "g"),
			""
		);

		cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

		cleaned = cleaned.trim();

		return cleaned;
	}

	private showSplitMarkerConflictModal(): Promise<
		"auto" | "manual" | "remove" | null
	> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			let choice: "auto" | "manual" | "remove" | null = null;

			modal.titleEl.setText("Manual Split Markers Detected");
			modal.contentEl.createEl("p", {
				text: "This note contains manual paragraph split markers. How would you like to proceed?",
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
				.setButtonText("Remove Splits & Auto-Finalize")
				.setWarning()
				.onClick(() => {
					choice = "remove";
					modal.close();
				});

			new ButtonComponent(buttonContainer)
				.setButtonText("Use Manual Splits")
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

**Formatting Rule:** Preserve all Markdown formatting, especially LaTeX math expressions (e.g., \`$ ... $\` and \`$$ ... $$\`), in the "front" and "back" fields.

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
		let cardsToFix: (Pick<Flashcard, "front" | "back" | "tag" | "chapter">)[] = [];

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
		cardData: Pick<Flashcard, "front" | "back" | "tag" | "chapter">,
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
**Formatting Rule:** Preserve all Markdown formatting, especially LaTeX math expressions (e.g., \`$ ... $\` and \`$$ ... $$\`), in the "front" and "back" fields.
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
**Formatting Rule:** Preserve all Markdown formatting, especially LaTeX math expressions (e.g., \`$ ... $\` and \`$$ ... $$\`), in the "front" and "back" fields.
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
	): (Pick<Flashcard, "front" | "back" | "tag" | "chapter">)[] {
		try {
			// Try the enhanced parsing
			const items = extractJsonArray<{
				front: string;
				back: string;
				tag: string;
			}>(rawResponse);

			return items
				.filter((item) => {
					// More robust validation
					if (!item || typeof item !== "object") {
						this.logger(LogLevel.VERBOSE, "LLM response item filtered out: Not an object", item);
						return false;
					}

					const hasRequiredFields =
						typeof item.front === "string" &&
						item.front.trim().length > 0 &&
						typeof item.back === "string" &&
						item.back.trim().length > 0 &&
						typeof item.tag === "string" &&
						item.tag.trim().length > 0;
					
					if (!hasRequiredFields) {
						this.logger(LogLevel.VERBOSE, "LLM response item filtered out: Missing required fields", item);
					}
					return hasRequiredFields;
				})
				.map((item) => ({
					front: item.front.trim(),
					back: item.back.trim(),
					tag: item.tag.trim(),
					chapter: chapterPath
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

	private async updateGatingForView(view: MarkdownView): Promise<number> {
		if (!view.file) return Infinity;

		const paragraphDivs =
			view.previewMode.containerEl.querySelectorAll<HTMLElement>(
				`.${PARA_CLASS}`
			);

		if (!this.settings.gatingEnabled) {
			for (const div of paragraphDivs) {
				div.classList.remove("gn-hidden");
			}
			return Infinity;
		}

		const chapterPath = view.file.path;
		const firstBlockedParaIdx =
			await this.getFirstBlockedParaIndex(chapterPath);

		for (const div of paragraphDivs) {
			const paraIdx = Number(div.getAttribute(PARA_ID_ATTR) || 0);
			if (paraIdx) {
				div.classList.toggle("gn-hidden", paraIdx > firstBlockedParaIdx);
			}
		}
		return firstBlockedParaIdx;
	}

	/**
	 * Rerenders all preview-mode markdown views in the workspace.
	 * This is used to apply changes to content gating or paragraph rendering.
	 */
	public refreshReading(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") {
				(view.previewMode as any)?.rerender?.(true);
			}
		});
	}

	/**
	 * Rerenders markdown views and attempts to preserve the user's scroll position.
	 * This is useful after an action that might reflow the document, like unlocking content.
	 */
	public async refreshReadingAndPreserveScroll(): Promise<void> {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!mdView) {
			this.refreshReading(); // Fallback for other views
			return;
		}

		const state = mdView.getEphemeralState();
		this.logger(LogLevel.VERBOSE, "Preserving scroll state", state);

		await this.updateGatingForView(mdView);

		mdView.setEphemeralState(state);
		this.logger(LogLevel.VERBOSE, "Restored scroll state");
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

	private async navigateToChapter(
		file: TFile
	): Promise<MarkdownView | null> {
		const { workspace } = this.app;
		const activeView = workspace.getActiveViewOfType(MarkdownView);

		// Case 1: The active view is already showing the correct file.
		if (activeView && activeView.file?.path === file.path) {
			if (activeView.getMode() !== "preview") {
				await activeView.setState(
					{ ...activeView.getState(), mode: "preview" },
					{ history: false }
				);
			}
			return activeView;
		}

		// Case 2: The file is open in another leaf. Find it and activate it.
		const leaves = workspace.getLeavesOfType("markdown");
		const leafWithFile = leaves.find((l) => {
			// Type guard to ensure view has a 'file' property
			const view = l.view;
			return view instanceof FileView && view.file?.path === file.path;
		});
		if (leafWithFile) {
			workspace.setActiveLeaf(leafWithFile, { focus: true });
			const view = leafWithFile.view as MarkdownView;
			if (view.getMode() !== "preview") {
				await view.setState({ ...view.getState(), mode: "preview" }, { history: false });
			}
			return view;
		}

		// Case 3: The file is not open. Open it in a leaf.
		const leaf = workspace.getLeaf(false);
		await leaf.openFile(file, { state: { mode: "preview" } });
		return workspace.getActiveViewOfType(MarkdownView);
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

		const mdView = await this.navigateToChapter(file);
		if (!mdView) {
			new Notice("Could not open the note for this card.");
			return;
		}

		const targetLine = await getLineForParagraph(
			this,
			file,
			card.paraIdx ?? 1
		);
		const paraSelector = `.${PARA_CLASS}[${PARA_ID_ATTR}="${card.paraIdx ?? 1}"]`;

		for (let attempt = 1; attempt <= 3; attempt++) {
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

						if (
							startContainer !== endContainer ||
							startContainer.parentElement !==
								endContainer.parentElement
						) {
							wrapper.scrollIntoView({
								behavior: "smooth",
							});

							const selection = window.getSelection();
							if (selection) {
								selection.removeAllRanges();
								selection.addRange(range);

								const style =
									document.createElement("style");
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
			.gn-epub-modal {
				width: 80vw;
				height: 80vh;
				max-width: 1200px;
				max-height: 800px;
			}
			
			.gn-epub-modal .modal-content {
				height: 100%;
				display: flex;
				flex-direction: column;
			}
			
			.gn-epub-section {
				display: flex;
				align-items: center;
				padding: 2px 0;
				cursor: pointer;
			}
			
			.gn-epub-section:hover {
				background-color: var(--background-modifier-hover);
			}
			
			.gn-epub-section input[type="checkbox"] {
				margin-right: 8px;
			}
			.gn-pdf-modal {
				width: 70vw;
				height: 80vh;
				max-width: 1000px;
				max-height: 900px;
				min-width: 600px;
				min-height: 500px;
			}
			
			.gn-pdf-modal .modal-content {
				height: 100%;
				display: flex;
				flex-direction: column;
				overflow-y: auto;
				padding: 20px;
			}
			
			.gn-hybrid-controls {
				background: var(--background-secondary);
				border-radius: var(--radius-m);
				transition: all 0.2s ease-in-out;
			}
			
			.gn-hybrid-controls h5 {
				margin-bottom: 15px;
				color: var(--text-accent);
				font-weight: 600;
			}
			
			.gn-cost-estimator {
				padding: 8px 12px;
				background: var(--background-modifier-info);
				border-radius: var(--radius-s);
				font-family: var(--font-monospace);
				border-left: 3px solid var(--text-accent);
			}
			
			.gn-cost-estimator.gn-hybrid-cost {
				background: var(--background-modifier-success);
				border-left-color: var(--color-green);
			}
			
			.gn-processing-status {
				display: flex;
				align-items: center;
				gap: 10px;
				padding: 10px;
				background: var(--background-secondary);
				border-radius: var(--radius-s);
				margin: 10px 0;
			}
			
			.gn-processing-status .gn-spinner {
				width: 16px;
				height: 16px;
				border: 2px solid var(--background-modifier-border);
				border-top: 2px solid var(--text-accent);
				border-radius: 50%;
				animation: gn-spin 1s linear infinite;
			}
			
			@keyframes gn-spin {
				0% { transform: rotate(0deg); }
				100% { transform: rotate(360deg); }
			}
			
			.gn-page-preview {
				display: grid;
				grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
				gap: 10px;
				max-height: 200px;
				overflow-y: auto;
				padding: 10px;
				background: var(--background-secondary);
				border-radius: var(--radius-s);
			}
			
			.gn-page-preview-item {
				display: flex;
				flex-direction: column;
				align-items: center;
				padding: 8px;
				border: 1px solid var(--background-modifier-border);
				border-radius: var(--radius-s);
				background: var(--background-primary);
			}
			
			.gn-page-preview-item img {
				max-width: 100%;
				max-height: 80px;
				object-fit: contain;
				border-radius: var(--radius-xs);
			}
			
			.gn-page-preview-item .gn-page-num {
				margin-top: 5px;
				font-size: 0.8em;
				color: var(--text-muted);
			}
			
			.gn-mode-toggle {
				display: flex;
				background: var(--background-modifier-border);
				border-radius: var(--radius-m);
				padding: 2px;
				margin-bottom: 15px;
			}
			
			.gn-mode-toggle button {
				flex: 1;
				background: transparent;
				border: none;
				padding: 8px 16px;
				border-radius: var(--radius-s);
				cursor: pointer;
				transition: all 0.2s ease;
				font-weight: 500;
			}
			
			.gn-mode-toggle button:hover {
				background: var(--background-modifier-hover);
			}
			
			.gn-mode-toggle button.active {
				background: var(--interactive-accent);
				color: var(--text-on-accent);
			}
			
			.gn-progress-bar {
				width: 100%;
				height: 4px;
				background: var(--background-modifier-border);
				border-radius: 2px;
				overflow: hidden;
				margin: 10px 0;
			}
			
			.gn-progress-bar .gn-progress-fill {
				height: 100%;
				background: var(--text-accent);
				transition: width 0.3s ease;
				border-radius: 2px;
			}
			
			/* Warning styles for experimental features */
			.gn-warning-banner {
				background: var(--background-modifier-error);
				border: 1px solid var(--color-red);
				border-radius: var(--radius-s);
				padding: 12px;
				margin-bottom: 15px;
			}
			
			.gn-warning-banner strong {
				color: var(--color-red);
			}
			
			/* Input grouping for page ranges */
			.gn-input-group {
				display: flex;
				gap: 8px;
				align-items: center;
			}
			
			.gn-input-group .setting-item-control {
				display: flex;
				gap: 8px;
				align-items: center;
			}
			
			.gn-input-group input[type="text"] {
				width: 80px !important;
			}
			
			.gn-input-group .gn-input-separator {
				color: var(--text-muted);
				font-weight: bold;
			}
			
			/* Enhanced tooltip styles */
			.gn-tooltip {
				position: relative;
				display: inline-block;
				cursor: help;
				color: var(--text-muted);
			}
			
			.gn-tooltip::after {
				content: attr(data-tooltip);
				position: absolute;
				bottom: 125%;
				left: 50%;
				transform: translateX(-50%);
				background: var(--background-tooltip);
				color: var(--text-tooltip);
				padding: 6px 10px;
				border-radius: var(--radius-s);
				font-size: 0.8em;
				white-space: nowrap;
				opacity: 0;
				pointer-events: none;
				transition: opacity 0.3s;
				z-index: 1000;
			}
			
			.gn-tooltip:hover::after {
				opacity: 1;
			}
			
			/* Responsive adjustments */
			@media (max-width: 800px) {
				.gn-pdf-modal {
					width: 95vw;
					height: 95vh;
					min-width: 320px;
				}
				
				.gn-page-preview {
					grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
				}
				
				.gn-input-group {
					flex-direction: column;
					align-items: stretch;
				}
				
				.gn-input-group .setting-item-control {
					flex-direction: column;
				}
			}
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

	/**
	 * Creates a new flashcard object with default values for spaced repetition.
	 * @param data The core data for the flashcard (front, back, tag, chapter).
	 */
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

	/**
	 * Saves an array of new flashcards to the appropriate deck file.
	 * @param sourceFile The source TFile of the chapter the cards belong to.
	 * @param newCards An array of new Flashcard objects to save.
	 */
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

	/**
	 * Recalculates the `paraIdx` for all cards associated with a given note.
	 * This is useful after editing a finalized note to re-sync card locations.
	 * @param file The TFile of the note to process.
	 * @param showNotice Whether to show a user-facing notice upon completion.
	 */
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

	/**
	 * Triggers a recalculation of paragraph indexes for all markdown files in the vault.
	 */
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

	/**
	 * Resets the review progress of a single flashcard, setting it back to a "new" state.
	 * @param card The flashcard to reset.
	 */
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

	/**
	 * Renders card content, processing special placeholders like `[[IMAGE HASH=...]]`.
	 * @param content The raw markdown content from the card's front or back field.
	 * @param container The HTMLElement to render the content into.
	 * @param sourcePath The path of the card's source chapter, for resolving links.
	 */
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

	/**
	 * Opens the card editing modal.
	 * @param card The flashcard to edit.
	 * @param graph The full flashcard graph for the deck.
	 * @param deck The TFile of the deck file.
	 * @param onDone A callback function executed when the modal is closed.
	 * @param reviewContext Context if the modal is opened during a new-card review sequence.
	 * @param parentContext The context from which the modal was opened.
	 */
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

	/**
	 * Prompts the user to review a set of newly created cards.
	 * @param newCards An array of the new cards to review.
	 * @param deck The TFile of the deck they were added to.
	 * @param graph The full flashcard graph for the deck.
	 */
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

	/**
	 * Guides the user through a sequential review of newly created cards.
	 * @param newCards The array of new cards to review.
	 * @param deck The TFile of the deck.
	 * @param graph The full flashcard graph.
	 */
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

	/**
	 * Refreshes all status bar indicators.
	 */
	public async refreshAllStatuses(): Promise<void> {
		this.refreshDueCardStatus();
		this.updateMissingParaIdxStatus();
	}

	/**
	 * Updates the status bar item that shows the number of due cards.
	 */
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

	/**
	 * Updates the status bar item that shows the count of cards missing a paragraph index.
	 */
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

	/**
	 * Sends a prompt to the configured Large Language Model (LLM).
	 * Handles both OpenAI and LM Studio providers, as well as multimodal requests.
	 * @param prompt The text prompt to send.
	 * @param imageUrl Optional base64-encoded image URL for multimodal requests.
	 * @param options Optional settings to override the default model, temperature, etc.
	 * @returns A promise that resolves to an object containing the LLM's response content and usage statistics.
	 */
	public async sendToLlm(
		prompt: string,
		imageUrl?: string,
		options: {
			maxTokens?: number;
			temperature?: number;
			model?: string;
		} = {}
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

		let model: string;
		if (options.model) {
			model = options.model;
		} else if (imageUrl) {
			model = this.settings.openaiMultimodalModel;
		} else {
			model =
				apiProvider === "openai"
					? this.settings.openaiModel
					: lmStudioModel;
		}

		try {
			const messageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
				[{ type: "text", text: prompt }];

			if (imageUrl) {
				messageContent.push({
					type: "image_url",
					image_url: {
						url: imageUrl,
						detail: "high", // Use high detail for PDF processing
					},
				});
			}

			const payload: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
				model,
				temperature: options.temperature ?? openaiTemperature,
				messages: [{ role: "user", content: messageContent }],
			};

			if (options.maxTokens) {
				payload.max_tokens = options.maxTokens;
			}

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

	/**
	 * Fetches the list of available models from the configured AI provider.
	 * @returns A promise that resolves to an array of model ID strings.
	 */
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

	/**
	 * Loads plugin settings from Obsidian's data store.
	 */
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	/**
	 * Saves the current plugin settings to Obsidian's data store.
	 */
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

/**
 * A modal for converting an EPUB file into an Obsidian note.
 */
class EpubToNoteModal extends Modal {
	private fileInput!: HTMLInputElement;
	private chapterNameInput!: TextComponent;
	private folderSelect!: HTMLSelectElement;
	private newFolderInput!: TextComponent;
	private treeContainer!: HTMLElement;
	private previewContainer!: HTMLElement;
	private viewModeSelect!: HTMLSelectElement;

	private selectedFile: File | null = null;
	private epubStructure: EpubStructure | null = null;
	private selectedSections: Set<string> = new Set();
	private zipData: JSZip | null = null;
	private epubBasePath: string = "";

	constructor(private plugin: GatedNotesPlugin) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Convert EPUB to Note (EXPERIMENTAL)");
		this.modalEl.addClass("gn-epub-modal");
		makeModalDraggable(this, this.plugin);

		const warningEl = this.contentEl.createDiv({
			attr: {
				style: "background: var(--background-modifier-error); padding: 10px; border-radius: 5px; margin-bottom: 15px;",
			},
		});
		warningEl.createEl("strong", { text: "⚠️ Experimental Feature" });
		warningEl.createEl("p", {
			text: "This EPUB conversion feature is experimental. Complex formatting may not convert perfectly.",
			attr: { style: "margin: 5px 0 0 0; font-size: 0.9em;" },
		});

		new Setting(this.contentEl).setName("Select EPUB File").addButton((btn) => {
			btn.setButtonText("Choose File").onClick(() => this.fileInput.click());
		});

		this.fileInput = this.contentEl.createEl("input", {
			type: "file",
			attr: { accept: ".epub", style: "display: none;" },
		}) as HTMLInputElement;

		this.fileInput.onchange = (e) => this.handleFileSelection(e);

		new Setting(this.contentEl.createDiv())
			.setName("Chapter Name")
			.setDesc("Name for the new note")
			.addText((text) => {
				this.chapterNameInput = text;
				text.setPlaceholder("Enter chapter name...");
			});

		const folderSetting = new Setting(this.contentEl.createDiv()).setName(
			"Destination Folder"
		);
		this.folderSelect = folderSetting.controlEl.createEl("select");
		this.newFolderInput = new TextComponent(folderSetting.controlEl);

		await this.populateFolderOptions();

		this.folderSelect.onchange = () => {
			const isNewFolder = this.folderSelect.value === "__new__";
			this.newFolderInput.inputEl.style.display = isNewFolder
				? "block"
				: "none";
		};

		this.newFolderInput.setPlaceholder("Enter new folder name...");
		this.newFolderInput.inputEl.style.display = "none";

		const contentArea = this.contentEl.createDiv({
			attr: {
				style: "display: flex; height: 400px; gap: 10px; margin: 20px 0;",
			},
		});

		const leftPanel = contentArea.createDiv({
			attr: {
				style: "width: 40%; border-right: 1px solid var(--background-modifier-border); padding-right: 10px;",
			},
		});
		leftPanel.createEl("h4", { text: "Structure" });

		this.viewModeSelect = leftPanel.createEl("select", {
			attr: { style: "width: 100%; margin-bottom: 10px;" },
		});
		this.viewModeSelect.createEl("option", {
			value: "toc",
			text: "📖 Table of Contents",
		});
		this.viewModeSelect.createEl("option", {
			value: "files",
			text: "📁 File Structure",
		});
		this.viewModeSelect.createEl("option", {
			value: "spine",
			text: "📋 Reading Order",
		});
		this.viewModeSelect.onchange = () => this.updateTreeView();

		this.treeContainer = leftPanel.createDiv({
			attr: {
				style: "height: 300px; overflow-y: auto; border: 1px solid var(--background-modifier-border); padding: 5px;",
			},
		});
		this.treeContainer.setText("No EPUB loaded");

		const rightPanel = contentArea.createDiv({
			attr: { style: "width: 60%; padding-left: 10px;" },
		});
		rightPanel.createEl("h4", { text: "Preview" });

		this.previewContainer = rightPanel.createDiv({
			attr: {
				style: "height: 300px; overflow-y: auto; border: 1px solid var(--background-modifier-border); padding: 10px; background: var(--background-secondary);",
			},
		});
		this.previewContainer.setText("Select sections to preview content");

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Extract Selected Content")
					.setCta()
					.onClick(() => this.handleExtract())
			);
	}

	private async handleFileSelection(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		this.selectedFile = file;
		this.treeContainer.setText("Processing EPUB...");

		try {
			this.epubStructure = await this.parseEpub(file);

			if (!this.chapterNameInput.getValue() && this.epubStructure.title) {
				this.chapterNameInput.setValue(this.epubStructure.title);
			}

			this.updateTreeView();
			new Notice(
				`✅ EPUB processed: ${this.epubStructure.sections.length} sections found`
			);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			this.treeContainer.setText(
				`Error processing EPUB: ${errorMessage}`
			);
			console.error("EPUB processing error:", error);
		}
	}

	private async parseEpub(file: File): Promise<EpubStructure> {
		this.zipData = await JSZip.loadAsync(file);

		const containerFile = this.zipData.file("META-INF/container.xml");
		if (!containerFile)
			throw new Error("Invalid EPUB: No container.xml found");

		const containerXml = await containerFile.async("text");
		const containerDoc = new DOMParser().parseFromString(
			containerXml,
			"application/xml"
		);
		const opfPath = containerDoc
			.querySelector("rootfile")
			?.getAttribute("full-path");
		if (!opfPath) throw new Error("Invalid EPUB: No OPF path found");

		this.epubBasePath = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

		const opfFile = this.zipData.file(opfPath);
		if (!opfFile) throw new Error("Invalid EPUB: OPF file not found");

		const opfXml = await opfFile.async("text");
		const opfDoc = new DOMParser().parseFromString(
			opfXml,
			"application/xml"
		);

		const title = opfDoc.querySelector("title")?.textContent || "Untitled";
		const author =
			opfDoc.querySelector("creator")?.textContent || undefined;

		const manifest: { [id: string]: { href: string; mediaType: string } } =
			{};
		opfDoc.querySelectorAll("manifest item").forEach((item) => {
			const id = item.getAttribute("id");
			const href = item.getAttribute("href");
			const mediaType = item.getAttribute("media-type");
			if (id && href && mediaType) {
				manifest[id] = { href, mediaType };
			}
		});

		const spine = Array.from(opfDoc.querySelectorAll("spine itemref"))
			.map((item) => item.getAttribute("idref"))
			.filter(Boolean) as string[];

		let sections: EpubSection[] = [];

		const ncxId = Array.from(opfDoc.querySelectorAll("manifest item"))
			.find(
				(item) =>
					item.getAttribute("media-type") ===
					"application/x-dtbncx+xml"
			)
			?.getAttribute("id");

		if (ncxId && manifest[ncxId]) {
			sections = await this.parseNcxToc(
				this.zipData,
				manifest[ncxId].href,
				opfPath
			);
		}

		if (sections.length === 0) {
			sections = await this.createSectionsFromSpine(
				this.zipData,
				spine,
				manifest,
				opfPath
			);
		}

		return { title, author, sections, manifest };
	}

	private async parseNcxToc(
		zip: JSZip,
		ncxPath: string,
		opfPath: string
	): Promise<EpubSection[]> {
		const basePath = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);
		const fullNcxPath = basePath + ncxPath;

		const ncxFile = zip.file(fullNcxPath);
		if (!ncxFile) return [];

		const ncxXml = await ncxFile.async("text");
		const ncxDoc = new DOMParser().parseFromString(
			ncxXml,
			"application/xml"
		);

		const parseNavPoint = (
			navPoint: Element,
			level: number = 1
		): EpubSection => {
			const id =
				navPoint.getAttribute("id") || Math.random().toString(36);
			const title =
				navPoint.querySelector("navLabel text")?.textContent ||
				"Untitled";
			const href =
				navPoint.querySelector("content")?.getAttribute("src") || "";

			const children: EpubSection[] = [];
			navPoint.querySelectorAll(":scope > navPoint").forEach((child) => {
				children.push(parseNavPoint(child, level + 1));
			});

			return {
				id,
				title,
				level,
				href,
				children,
				selected: false,
			};
		};

		const sections: EpubSection[] = [];
		ncxDoc.querySelectorAll("navMap > navPoint").forEach((navPoint) => {
			sections.push(parseNavPoint(navPoint));
		});

		return sections;
	}

	private async createSectionsFromSpine(
		zip: JSZip,
		spine: string[],
		manifest: { [id: string]: { href: string; mediaType: string } },
		opfPath: string
	): Promise<EpubSection[]> {
		const sections: EpubSection[] = [];
		const basePath = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

		for (let i = 0; i < spine.length; i++) {
			const spineId = spine[i];
			const manifestItem = manifest[spineId];
			if (
				!manifestItem ||
				manifestItem.mediaType !== "application/xhtml+xml"
			)
				continue;

			const filePath = basePath + manifestItem.href;
			const file = zip.file(filePath);
			if (!file) continue;

			try {
				const content = await file.async("text");
				const doc = new DOMParser().parseFromString(
					content,
					"application/xhtml+xml"
				);
				const title =
					doc.querySelector("title")?.textContent ||
					doc.querySelector("h1")?.textContent ||
					`Chapter ${i + 1}`;

				sections.push({
					id: spineId,
					title,
					level: 1,
					href: manifestItem.href,
					children: [],
					selected: false,
					content,
				});
			} catch (error) {
				console.warn(`Failed to parse ${filePath}:`, error);
			}
		}

		return sections;
	}

	private updateTreeView(): void {
		if (!this.epubStructure) return;

		this.treeContainer.empty();
		this.renderSectionTree(this.epubStructure.sections, this.treeContainer);
	}

	private renderSectionTree(
		sections: EpubSection[],
		container: HTMLElement
	): void {
		sections.forEach((section) => {
			const sectionEl = container.createDiv({
				cls: "gn-epub-section",
				attr: {
					style: `margin-left: ${
						(section.level - 1) * 20
					}px; padding: 2px 0;`,
				},
			});

			const checkbox = sectionEl.createEl("input", {
				type: "checkbox",
				attr: { style: "margin-right: 8px;" },
			});
			checkbox.checked = section.selected;
			checkbox.onchange = async () => {
				section.selected = checkbox.checked;
				this.updateSelectionState(section, checkbox.checked);
				await this.updatePreview();
			};

			sectionEl.createSpan({ text: section.title });

			if (section.children.length > 0) {
				this.renderSectionTree(section.children, container);
			}
		});
	}

	private updateSelectionState(
		section: EpubSection,
		selected: boolean
	): void {
		section.selected = selected;

		if (selected) {
			this.selectedSections.add(section.id);
		} else {
			this.selectedSections.delete(section.id);
		}

		section.children.forEach((child) => {
			this.updateSelectionState(child, selected);
		});
	}

	private async updatePreview(): Promise<void> {
		if (this.selectedSections.size === 0) {
			this.previewContainer.setText("Select sections to preview content");
			return;
		}

		this.previewContainer.setText("Loading preview...");

		try {
			const selectedSectionsList = Array.from(this.selectedSections);
			const sectionsToProcess: EpubSection[] = [];

			for (const sectionId of selectedSectionsList) {
				const section = this.findSectionById(sectionId);
				if (section) {
					sectionsToProcess.push(section);
				}
			}

			const previewStructure = await this.buildPreviewStructure(
				sectionsToProcess
			);

			this.previewContainer.empty();
			const previewEl = this.previewContainer.createEl("div", {
				attr: {
					style: "font-family: var(--font-text); line-height: 1.4;",
				},
			});

			previewEl.innerHTML = previewStructure.content;

			this.previewContainer.createEl("div", {
				text: `Estimated words: ~${previewStructure.wordCount}`,
				attr: {
					style: "margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--background-modifier-border); font-style: italic; color: var(--text-muted);",
				},
			});
		} catch (error) {
			console.error("Error generating preview:", error);
			this.previewContainer.setText("Error generating preview");
		}
	}

	private async buildPreviewStructure(
		sections: EpubSection[]
	): Promise<{ content: string; wordCount: number }> {
		if (sections.length === 0) {
			return { content: "", wordCount: 0 };
		}

		let previewHtml = "";
		let totalWordCount = 0;

		if (sections.length === 1) {
			const section = sections[0];
			previewHtml += `<div style="font-size: 1.3em; font-weight: bold; color: var(--text-accent); border-bottom: 2px solid var(--text-accent); padding-bottom: 8px; margin-bottom: 15px;">📝 Note Title: ${section.title}</div>`;

			const contentSnippet = await this.getContentSnippet(section);
			if (contentSnippet.content) {
				previewHtml += `<p style="margin: 10px 0; font-style: italic; color: var(--text-muted);">${contentSnippet.content}</p>`;
				totalWordCount += contentSnippet.wordCount;
			}

			const childrenPreview = await this.processChildrenForPreview(
				section.children,
				1
			);
			previewHtml += childrenPreview.content;
			totalWordCount += childrenPreview.wordCount;
		} else {
			previewHtml += `<p style="font-weight: bold; color: var(--text-accent); margin-bottom: 15px;">📝 Note will contain ${sections.length} main sections:</p>`;

			for (const section of sections) {
				previewHtml += `<h2 style="color: var(--text-normal); margin-top: 20px;"># ${section.title}</h2>`;

				const contentSnippet = await this.getContentSnippet(section);
				if (contentSnippet.content) {
					previewHtml += `<p style="margin: 8px 0 8px 20px; font-style: italic; color: var(--text-muted);">${contentSnippet.content}</p>`;
					totalWordCount += contentSnippet.wordCount;
				}

				if (section.children.length > 0) {
					const childrenPreview =
						await this.processChildrenForPreview(
							section.children,
							2,
							4
						);
					previewHtml += childrenPreview.content;
					totalWordCount += childrenPreview.wordCount;
				}
			}
		}

		return { content: previewHtml, wordCount: totalWordCount };
	}

	private async processChildrenForPreview(
		children: EpubSection[],
		headingLevel: number,
		maxChildren = 10
	): Promise<{ content: string; wordCount: number }> {
		let html = "";
		let wordCount = 0;
		const childrenToShow = children.slice(0, maxChildren);

		for (const child of childrenToShow) {
			const headingStyle =
				headingLevel === 1
					? "color: var(--text-normal); margin-top: 15px;"
					: "color: var(--text-muted); margin-top: 10px; font-size: 0.9em;";

			const prefix = "#".repeat(headingLevel);
			html += `<h${Math.min(
				headingLevel + 2,
				6
			)} style="${headingStyle}">${prefix} ${child.title}</h${Math.min(
				headingLevel + 2,
				6
			)}>`;

			const contentSnippet = await this.getContentSnippet(child);
			if (contentSnippet.content) {
				const indent = headingLevel * 15;
				html += `<p style="margin: 5px 0 5px ${indent}px; font-style: italic; color: var(--text-muted); font-size: 0.85em;">${contentSnippet.content}</p>`;
				wordCount += contentSnippet.wordCount;
			}
		}

		if (children.length > maxChildren) {
			html += `<p style="margin-left: ${
				headingLevel * 15
			}px; color: var(--text-muted); font-style: italic;">... and ${
				children.length - maxChildren
			} more sections</p>`;
		}

		return { content: html, wordCount };
	}

	private async getContentSnippet(
		section: EpubSection
	): Promise<{ content: string; wordCount: number }> {
		if (!this.zipData || !this.epubStructure) {
			return { content: "", wordCount: 0 };
		}

		try {
			const basePath = this.getBasePath();
			const fullPath = basePath + section.href;

			console.log(`Trying to access: ${fullPath}`);

			const file = this.zipData.file(fullPath);
			if (!file) {
				const alternativePath = section.href;
				console.log(`Trying alternative path: ${alternativePath}`);
				const altFile = this.zipData.file(alternativePath);
				if (!altFile) {
					const availableFiles = Object.keys(
						this.zipData.files
					).slice(0, 10);
					console.log(
						`Available files (first 10): ${availableFiles.join(
							", "
						)}`
					);
					return {
						content: `[File not found: ${fullPath}]`,
						wordCount: 3,
					};
				}
				return await this.extractContentFromFile(altFile);
			}

			return await this.extractContentFromFile(file);
		} catch (error) {
			console.error(
				`Error getting content snippet for ${section.title}:`,
				error
			);
			return { content: "[Error reading content]", wordCount: 3 };
		}
	}

	private async extractContentFromFile(
		file: any
	): Promise<{ content: string; wordCount: number }> {
		const xhtmlContent = await file.async("text");
		const doc = new DOMParser().parseFromString(
			xhtmlContent,
			"application/xhtml+xml"
		);
		const body = doc.querySelector("body");

		if (!body) {
			return { content: "[No content found]", wordCount: 3 };
		}

		const paragraphs = Array.from(body.querySelectorAll("p, div"))
			.map((el) => el.textContent?.trim())
			.filter((text) => text && text.length > 20);

		if (paragraphs.length === 0) {
			const allText = body.textContent?.trim() || "";
			const words = allText.split(/\s+/).filter(Boolean);
			if (words.length > 0) {
				const snippet = words.slice(0, 15).join(" ");
				return {
					content: snippet + (words.length > 15 ? "..." : ""),
					wordCount: words.length,
				};
			}
			return { content: "[No readable content]", wordCount: 3 };
		}

		const firstParagraph = paragraphs[0];
		if (!firstParagraph) {
			return { content: "[No readable content]", wordCount: 3 };
		}

		const words = firstParagraph.split(/\s+/).filter(Boolean);
		const snippet = words.slice(0, 20).join(" ");

		return {
			content: snippet + (words.length > 20 ? "..." : ""),
			wordCount: paragraphs.reduce(
				(count, para) =>
					count + (para?.split(/\s+/).filter(Boolean).length || 0),
				0
			),
		};
	}

	private extractTextSnippet(content: string): string {
		const doc = new DOMParser().parseFromString(
			content,
			"application/xhtml+xml"
		);
		const textContent = doc.body?.textContent || "";
		const sentences = textContent
			.split(/[.!?]+/)
			.filter((s) => s.trim().length > 0);
		return (
			sentences.slice(0, 2).join(". ") +
			(sentences.length > 2 ? "..." : "")
		);
	}

	private findSectionById(id: string): EpubSection | null {
		if (!this.epubStructure) return null;

		const search = (sections: EpubSection[]): EpubSection | null => {
			for (const section of sections) {
				if (section.id === id) return section;
				const found = search(section.children);
				if (found) return found;
			}
			return null;
		};

		return search(this.epubStructure.sections);
	}

	private async populateFolderOptions(): Promise<void> {
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((file) => file.parent?.isRoot() && "children" in file)
			.map((folder) => folder.name)
			.sort();

		this.folderSelect.createEl("option", {
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

	private async handleExtract(): Promise<void> {
		if (
			!this.selectedFile ||
			!this.epubStructure ||
			this.selectedSections.size === 0
		) {
			new Notice(
				"Please select an EPUB file and choose sections to extract."
			);
			return;
		}

		const chapterName = this.chapterNameInput.getValue().trim();
		if (!chapterName) {
			new Notice("Please enter a chapter name.");
			return;
		}

		const notice = new Notice("📖 Converting EPUB to note...", 0);

		try {
			const markdownContent = await this.extractSelectedContent();

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

			const fileName = chapterName.endsWith(".md")
				? chapterName
				: `${chapterName}.md`;
			const notePath = folderPath
				? `${folderPath}/${fileName}`
				: fileName;

			await this.app.vault.create(notePath, markdownContent);

			notice.setMessage(`✅ Successfully created note: ${notePath}`);
			setTimeout(() => notice.hide(), 3000);

			const newFile = this.app.vault.getAbstractFileByPath(notePath);
			if (newFile instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(newFile);
			}

			this.close();
		} catch (error: unknown) {
			notice.hide();
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			new Notice(`Failed to convert EPUB: ${errorMessage}`);
			console.error("EPUB conversion error:", error);
		}
	}

	private async extractSelectedContent(): Promise<string> {
		if (!this.epubStructure || !this.zipData) {
			throw new Error("No EPUB data available");
		}

		const selectedSectionsList = Array.from(this.selectedSections);
		const sectionsToProcess: EpubSection[] = [];

		for (const sectionId of selectedSectionsList) {
			const section = this.findSectionById(sectionId);
			if (section) {
				sectionsToProcess.push(section);
			}
		}

		let markdownContent = "";

		if (sectionsToProcess.length === 1) {
			const section = sectionsToProcess[0];

			console.log(`Processing main section: ${section.title}`);
			console.log(
				`Section has ${section.children.length} children:`,
				section.children.map((c) => c.title)
			);

			const sectionContent = await this.processSectionContent(section);
			console.log(
				`Main section content length: ${sectionContent.length}`
			);
			console.log(
				`Main section content preview: ${sectionContent.substring(
					0,
					200
				)}...`
			);

			if (sectionContent.trim()) {
				markdownContent += sectionContent + "\n\n";
			}

			const sortedChildren = [...section.children].sort((a, b) => {
				const aNum = parseInt(a.title.match(/^\d+/)?.[0] || "999");
				const bNum = parseInt(b.title.match(/^\d+/)?.[0] || "999");
				if (aNum !== bNum) return aNum - bNum;
				return a.title.localeCompare(b.title);
			});

			console.log(
				`Processing children in order:`,
				sortedChildren.map((c) => c.title)
			);

			for (const child of sortedChildren) {
				console.log(`Processing child: ${child.title}`);
				markdownContent += `# ${child.title}\n\n`;
				const childContent = await this.processSectionContent(child);
				if (childContent.trim()) {
					markdownContent += childContent + "\n\n";
				}
			}
		} else {
			for (const section of sectionsToProcess) {
				markdownContent += `# ${section.title}\n\n`;
				const sectionContent = await this.processSectionContent(
					section
				);
				if (sectionContent.trim()) {
					markdownContent += sectionContent + "\n\n";
				}
			}
		}

		return markdownContent.trim();
	}

	private determineHeadingLevel(sections: EpubSection[]): number {
		if (sections.length === 1) {
			return 1;
		} else {
			return 1;
		}
	}

	private async processSectionContent(section: EpubSection): Promise<string> {
		if (!this.zipData || !this.epubStructure) {
			return "[Content extraction failed]";
		}

		const basePath = this.getBasePath();
		const fullPath = basePath + section.href;

		const file = this.zipData.file(fullPath);
		if (!file) {
			return "[File not found in EPUB]";
		}

		try {
			const xhtmlContent = await file.async("text");
			return await this.convertXhtmlToMarkdown(
				xhtmlContent,
				section.href
			);
		} catch (error) {
			console.error(`Error processing section ${section.title}:`, error);
			return `[Error processing content: ${error}]`;
		}
	}

	private getBasePath(): string {
		return this.epubBasePath || "";
	}

	private async convertXhtmlToMarkdown(
		xhtmlContent: string,
		href: string
	): Promise<string> {
		const doc = new DOMParser().parseFromString(
			xhtmlContent,
			"application/xhtml+xml"
		);
		const body = doc.querySelector("body");

		if (!body) {
			return "[No body content found]";
		}

		const results: string[] = [];

		for (const node of Array.from(body.childNodes)) {
			const nodeResult = await this.processNode(node, href);
			if (nodeResult.trim()) {
				results.push(nodeResult.trim());
			}
		}

		let markdown = results.join("\n\n");

		markdown = markdown.replace(/\n{3,}/g, "\n\n");

		return markdown.trim();
	}

	private async processNode(node: Node, href: string): Promise<string> {
		if (node.nodeType === Node.TEXT_NODE) {
			return node.textContent?.trim() || "";
		}

		if (node.nodeType !== Node.ELEMENT_NODE) {
			return "";
		}

		const element = node as Element;
		const tagName = element.tagName.toLowerCase();

		switch (tagName) {
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				const level = parseInt(tagName.charAt(1));
				const prefix = "#".repeat(level);
				return `${prefix} ${element.textContent?.trim() || ""}`;

			case "p":
				return element.textContent?.trim() || "";

			case "em":
			case "i":
				return `*${element.textContent?.trim() || ""}*`;

			case "strong":
			case "b":
				return `**${element.textContent?.trim() || ""}**`;

			case "code":
				return `\`${element.textContent?.trim() || ""}\``;

			case "pre":
				return `\`\`\`\n${element.textContent?.trim() || ""}\n\`\`\``;

			case "blockquote":
				const lines = (element.textContent?.trim() || "").split("\n");
				return lines.map((line) => `> ${line}`).join("\n");

			case "ul":
			case "ol":
				let listContent = "";
				const listItems = element.querySelectorAll("li");
				listItems.forEach((li, index) => {
					const bullet = tagName === "ul" ? "-" : `${index + 1}.`;
					listContent += `${bullet} ${
						li.textContent?.trim() || ""
					}\n`;
				});
				return listContent.trim();

			case "img":
				return await this.processImage(element, href);

			case "br":
				return "\n";

			case "div":
			case "span":
			case "section":
			case "article":
				let childContent = "";
				const childResults: string[] = [];

				for (const child of Array.from(element.childNodes)) {
					const childResult = await this.processNode(child, href);
					if (childResult.trim()) {
						childResults.push(childResult.trim());
					}
				}

				if (tagName === "span") {
					return childResults.join(" ");
				} else {
					return childResults.join("\n\n");
				}

			default:
				let unknownContent = "";
				for (const child of Array.from(element.childNodes)) {
					const childResult = await this.processNode(child, href);
					if (childResult.trim()) {
						unknownContent += childResult.trim() + " ";
					}
				}
				return unknownContent.trim();
		}
	}

	private async processImage(
		imgElement: Element,
		href: string
	): Promise<string> {
		const src = imgElement.getAttribute("src");
		if (!src || !this.zipData) {
			return "![IMAGE_PLACEHOLDER]";
		}

		try {
			const allFiles = Object.keys(this.zipData.files);
			const imageFiles = allFiles.filter((f) =>
				/\.(jpg|jpeg|png|gif|bmp|svg)$/i.test(f)
			);
			console.log(
				`Found ${imageFiles.length} image files:`,
				imageFiles.slice(0, 5)
			);
			console.log(`Looking for image with src: "${src}"`);

			let imageFile = null;
			const pathsToTry = [];

			pathsToTry.push(src);
			imageFile = this.zipData.file(src);

			if (!imageFile && !src.startsWith("/") && !src.startsWith("http")) {
				const hrefDir = href.substring(0, href.lastIndexOf("/") + 1);
				const relativePath = hrefDir + src;
				pathsToTry.push(relativePath);
				imageFile = this.zipData.file(relativePath);

				if (!imageFile) {
					const basePathImage = this.getBasePath() + src;
					pathsToTry.push(basePathImage);
					imageFile = this.zipData.file(basePathImage);
				}

				if (!imageFile) {
					const filename = src.split("/").pop();
					if (filename) {
						const foundFile = imageFiles.find((f) =>
							f.endsWith(filename)
						);
						if (foundFile) {
							pathsToTry.push(foundFile);
							imageFile = this.zipData.file(foundFile);
						}
					}
				}
			}

			if (!imageFile) {
				console.warn(`Image not found. Tried paths:`, pathsToTry);
				console.log(`Available image files:`, imageFiles);
				return `![IMAGE_PLACEHOLDER - Image not found: ${src}]`;
			}

			console.log(
				`Successfully found image at: ${
					pathsToTry[pathsToTry.length - 1]
				}`
			);

			const imageData = await imageFile.async("blob");
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const extension = src.split(".").pop()?.toLowerCase() || "png";
			const imageName = `epub-image-${timestamp}.${extension}`;

			let targetPath = imageName;

			try {
				const attachmentFolder = (this.app as any).vault.getConfig?.(
					"attachmentFolderPath"
				);
				if (attachmentFolder && typeof attachmentFolder === "string") {
					targetPath = `${attachmentFolder}/${imageName}`;
				}
			} catch (e) {
				targetPath = imageName;
			}

			const arrayBuffer = await imageData.arrayBuffer();
			await this.app.vault.createBinary(targetPath, arrayBuffer);

			console.log(`Image saved as: ${targetPath}`);
			return `![[${imageName}]]`;
		} catch (error) {
			console.error("Error processing image:", error);
			return "![IMAGE_PLACEHOLDER - Processing error]";
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * A modal for converting a PDF file into a structured Obsidian note using AI.
 */
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
	private cleanupToggleComponent!: ToggleComponent;
	private guidanceInput?: TextAreaComponent;
	private processingModeSelect!: HTMLSelectElement;
	private dpiInput!: TextComponent;
	private maxWidthInput!: TextComponent;
	private pageRangeFromInput!: TextComponent;
	private pageRangeToInput!: TextComponent;
	private includeTextToggle!: ToggleComponent;
	private renderedPages: Array<{
		pageNum: number;
		imageData: string;
		textContent?: string;
	}> = [];

	constructor(private plugin: GatedNotesPlugin) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Convert PDF to Note (Enhanced)");
		this.modalEl.addClass("gn-pdf-modal");
		makeModalDraggable(this, this.plugin);

		const warningEl = this.contentEl.createDiv({
			attr: {
				style: "background: var(--background-modifier-error); padding: 10px; border-radius: 5px; margin-bottom: 15px;",
			},
		});
		warningEl.createEl("strong", { text: "⚠️ Enhanced PDF Conversion" });
		warningEl.createEl("p", {
			text: "This enhanced PDF converter supports both text-only and hybrid (text + image) modes for better handling of complex documents with formulas and figures.",
			attr: { style: "margin: 5px 0 0 0; font-size: 0.9em;" },
		});

		new Setting(this.contentEl)
			.setName("Select PDF File")
			.addButton((btn) => {
				btn.setButtonText("Choose File").onClick(() => this.fileInput.click());
			});

		this.fileInput = this.contentEl.createEl("input", {
			type: "file",
			attr: { accept: ".pdf", style: "display: none;" },
		}) as HTMLInputElement;

		this.fileInput.onchange = (e) => this.handleFileSelection(e);

		this.pdfViewer = this.contentEl.createDiv({
			cls: "pdf-viewer",
			attr: {
				style: "margin-top: 10px; min-height: 200px; border: 1px solid var(--background-modifier-border); padding: 10px;",
			},
		});
		this.pdfViewer.setText("No PDF selected");

		this.setupProcessingModeControls();

		new Setting(this.contentEl)
			.setName("Chapter Name")
			.setDesc("Name for the new note/chapter")
			.addText((text) => {
				this.chapterNameInput = text;
				text.setPlaceholder("Enter chapter name...");
				text.onChange(() => this.costUi?.update());
			});

		const folderSetting = new Setting(this.contentEl).setName(
			"Destination Folder"
		);
		this.folderSelect = folderSetting.controlEl.createEl("select");
		this.newFolderInput = new TextComponent(folderSetting.controlEl);

		await this.populateFolderOptions();

		this.folderSelect.onchange = () => {
			const isNewFolder = this.folderSelect.value === "__new__";
			this.newFolderInput.inputEl.style.display = isNewFolder
				? "block"
				: "none";
		};

		this.newFolderInput.setPlaceholder("Enter new folder name...");
		this.newFolderInput.inputEl.style.display = "none";

		this.setupExampleNoteSection();

		const guidanceContainer = this.contentEl.createDiv();
		const addGuidanceBtn = new ButtonComponent(guidanceContainer)
			.setButtonText("Add Custom Guidance")
			.onClick(() => {
				addGuidanceBtn.buttonEl.style.display = "none";
				new Setting(guidanceContainer)
					.setName("Custom Guidance")
					.setDesc(
						"Provide specific instructions for the AI (e.g., 'Focus on definitions', 'Summarize each section')."
					)
					.addTextArea((text) => {
						this.guidanceInput = text;
						text.setPlaceholder("Your custom instructions...");
						text.inputEl.rows = 4;
						text.inputEl.style.width = "100%";
						text.onChange(() => this.costUi?.update());
					});
			});

		const postProcessingSection = this.contentEl.createDiv();
		postProcessingSection.createEl("h4", {
			text: "Post-Processing (Optional)",
		});
		new Setting(postProcessingSection)
			.setName("Clean repetitive headers/footers")
			.setDesc(
				"Runs an additional AI pass to remove recurring text like chapter titles from page headers. This will incur additional cost and time."
			)
			.addToggle((toggle) => {
				this.cleanupToggleComponent = toggle;
				toggle.setValue(false).onChange(() => this.costUi?.update());
			});

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(
			costContainer,
			async () => {
				const isHybridMode = this.processingModeSelect.value === "hybrid";
				const pageCount = this.getEstimatedPageCount();
				const textContentTokens = countTextTokens(this.extractedText);
				const guidance = this.guidanceInput?.getValue() || "";
		
				let mainPromptText: string;
				let mainImageCount: number;
				const mainDetails = {
					textContentTokens,
					isHybrid: isHybridMode,
					pageCount: isHybridMode ? pageCount : undefined,
				};
		
				if (isHybridMode) {
					// Estimate for hybrid processing
					mainPromptText = this.buildHybridPrompt(
						1,
						"Sample text for estimation",
						guidance
					);
					mainImageCount = pageCount;
					
					// If cleanup is enabled, add estimated tokens for the cleanup pass
					if (this.cleanupToggleComponent?.getValue()) {
						// Estimate the output size from hybrid processing
						const estimatedHybridOutput =
							pageCount * 1000; // rough estimate of tokens per page
						
						// Build a sample cleanup prompt for cost estimation
						const sampleCleanupPrompt = this.buildReconstructionPrompt(
							"X".repeat(estimatedHybridOutput), // Dummy markdown content
							this.extractedText // Use actual PDF text
						);
						
						// Add cleanup prompt tokens to the total
						mainPromptText += "\n\n" + sampleCleanupPrompt;
					}
				} else {
					// Text-only mode
					mainPromptText = this.buildPrompt(
						this.extractedText,
						this.exampleNoteContent,
						guidance
					);
					mainImageCount = 0;
					
					// If cleanup is enabled for text mode
					if (this.cleanupToggleComponent?.getValue()) {
						const estimatedTextOutput = textContentTokens; // Assume similar size output
						const sampleCleanupPrompt = this.buildCleanupPrompt(
							"X".repeat(estimatedTextOutput)
						);
						mainPromptText += "\n\n" + sampleCleanupPrompt;
					}
				}
		
				return {
					promptText: mainPromptText,
					imageCount: mainImageCount,
					action: "pdf_to_note",
					details: mainDetails,
				};
			}
		);

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

	private setupProcessingModeControls(): void {
		const modeSection = this.contentEl.createDiv();
		modeSection.createEl("h4", { text: "Processing Mode" });

		new Setting(modeSection)
			.setName("Conversion Mode")
			.setDesc(
				"Choose between text-only extraction or hybrid mode with images"
			)
			.addDropdown((dropdown) => {
				this.processingModeSelect = dropdown.selectEl;
				dropdown
					.addOption("text", "Text Only (Fast, Lower Cost)")
					.addOption(
						"hybrid",
						"Hybrid (Text + Images, Better for Formulas)"
					)
					.setValue("text")
					.onChange(() => {
						this.toggleHybridControls();
						this.costUi?.update();
					});
			});

		const hybridControls = modeSection.createDiv({
			cls: "gn-hybrid-controls",
			attr: {
				style: "display: none; margin-top: 10px; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 5px;",
			},
		});

		hybridControls.createEl("h5", { text: "Hybrid Mode Settings" });

		new Setting(hybridControls)
			.setName("Page Range")
			.setDesc(
				"Specify page range to process (leave empty for all pages)"
			)
			.addText((text) => {
				this.pageRangeFromInput = text;
				text.setPlaceholder("From (e.g., 1)");
				text.inputEl.style.width = "80px";
				text.onChange(() => this.costUi?.update());
			})
			.addText((text) => {
				this.pageRangeToInput = text;
				text.setPlaceholder("To (e.g., 10)");
				text.inputEl.style.width = "80px";
				text.onChange(() => this.costUi?.update());
			});

		new Setting(hybridControls)
			.setName("Image Quality")
			.setDesc(
				"DPI for page rendering (higher = better quality, larger files)"
			)
			.addText((text) => {
				this.dpiInput = text;
				text.setValue("200");
				text.setPlaceholder("200");
				text.inputEl.style.width = "80px";
			});

		new Setting(hybridControls)
			.setName("Max Image Width")
			.setDesc(
				"Maximum width in pixels (keeps images compact while maintaining detail)"
			)
			.addText((text) => {
				this.maxWidthInput = text;
				text.setValue("1400");
				text.setPlaceholder("1400");
				text.inputEl.style.width = "100px";
			});

		new Setting(hybridControls)
			.setName("Include Text Context")
			.setDesc(
				"Include PDF text extraction alongside images for better AI processing"
			)
			.addToggle((toggle) => {
				this.includeTextToggle = toggle;
				toggle.setValue(true);
			});

		this.hybridControls = hybridControls;
	}

	private hybridControls!: HTMLElement;

	private toggleHybridControls(): void {
		const isHybrid = this.processingModeSelect.value === "hybrid";
		this.hybridControls.style.display = isHybrid ? "block" : "none";
	}

	private getEstimatedPageCount(): number {
		if (!this.selectedFile) return 1;

		const fromPage = parseInt(this.pageRangeFromInput?.getValue() || "1");
		const toPage = parseInt(this.pageRangeToInput?.getValue() || "");

		if (toPage && fromPage) {
			return Math.max(1, toPage - fromPage + 1);
		}

		// Rough estimate based on file size (very approximate)
		const mbSize = this.selectedFile.size / (1024 * 1024);
		return Math.max(1, Math.round(mbSize * 10)); // ~10 pages per MB estimate
	}

	private async handleFileSelection(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		this.selectedFile = file;
		this.pdfViewer.setText("Processing PDF...");

		try {
			// Always try text extraction first for preview
			await this.extractTextFromPdf(file);

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

	private async extractTextFromPdf(file: File): Promise<void> {
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
		} catch (error) {
			throw new Error(`Failed to extract text: ${error}`);
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

	private async renderPdfPagesToImages(): Promise<void> {
		const notice = new Notice("🔄 Rendering PDF pages to images...", 0);

		try {
			const pdfjsLib = await this.loadPdfJs();
			const arrayBuffer = await this.selectedFile!.arrayBuffer();
			const typedArray = new Uint8Array(arrayBuffer);
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			const fromPage = parseInt(
				this.pageRangeFromInput.getValue() || "1"
			);
			const toPage = parseInt(
				this.pageRangeToInput.getValue() || pdf.numPages.toString()
			);
			const dpi = parseInt(this.dpiInput.getValue() || "200");
			const maxWidth = parseInt(this.maxWidthInput.getValue() || "1400");

			this.renderedPages = [];

			for (
				let pageNum = fromPage;
				pageNum <= Math.min(toPage, pdf.numPages);
				pageNum++
			) {
				notice.setMessage(
					`🔄 Rendering page ${pageNum - fromPage + 1}/${
						toPage - fromPage + 1
					}...`
				);

				const page = await pdf.getPage(pageNum);
				const viewport = page.getViewport({ scale: dpi / 72 });

				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d")!;
				let scale = 1;

				if (viewport.width > maxWidth) {
					scale = maxWidth / viewport.width;
				}

				canvas.width = viewport.width * scale;
				canvas.height = viewport.height * scale;

				await page.render({
					canvasContext: context,
					viewport: page.getViewport({ scale: (dpi / 72) * scale }),
				}).promise;

				const imageData = canvas.toDataURL("image/png");

				// Extract text content for this page using PDF.js
				let textContent = "";
				if (this.includeTextToggle?.getValue()) {
					const pageTextContent = await page.getTextContent();
					textContent = this.extractParagraphsFromTextContent(
						pageTextContent.items
					);
				}

				this.renderedPages.push({
					pageNum,
					imageData,
					textContent: textContent || undefined,
				});
			}

			notice.hide();
		} catch (error) {
			notice.hide();
			throw error;
		}
	}

	private buildHybridPrompt(
		pageNum: number,
		textContent?: string,
		customGuidance?: string
	): string {
		let systemPrompt = `You are an expert document processor converting a PDF page image (with optional PDF text) into clean, well-structured Markdown. Follow these rules strictly:

1. **Headers**: Convert section titles into markdown headers ("# Header", "## Subheader", etc.).
2. **Paragraphs**: Merge consecutive lines into complete paragraphs, removing unnecessary line breaks.
3. **Footnotes**: If footnote citations and text appear on the same page, inline them in parentheses.
4. **Figures & Tables**: Use ![IMAGE_PLACEHOLDER] for figures or recreate tables in markdown. Include captions below.
5. **Mathematics**: Format all mathematical notation using LaTeX delimiters ("$" for inline, "$$" for block).
6. **Image is authoritative**: If PDF text conflicts with the image, trust the image. Mark illegible content as [[ILLEGIBLE]].
7. **Output**: ONLY the final Markdown text. No code fences or commentary.`;

		if (this.exampleNoteContent.trim()) {
			systemPrompt += `\n\nUse this structural template:\n${this.exampleNoteContent}`;
		}

		let userPrompt = `Convert this PDF page ${pageNum} to markdown.`;

		if (customGuidance) {
			userPrompt += `\n\n**User's Custom Instructions:**\n${customGuidance}`;
		}

		if (textContent && textContent.trim()) {
			userPrompt += `\n\nPDF TEXT CONTENT (may have layout issues; use IMAGE as ground truth):\n${textContent}`;
		}

		return systemPrompt + "\n\n" + userPrompt;
	}

	private buildReconstructionPrompt(
		aiGeneratedMarkdown: string,
		originalPdfText: string
	): string {
		const systemPrompt = `You are an expert document reconstruction AI. Your task is to clean and merge a markdown document that was converted from a PDF page-by-page, fixing artifacts from that process.
	
	You have TWO inputs:
	1. The AI-generated markdown (converted page-by-page, may have splits and repetitions)
	2. The original PDF text extraction (continuous but may have layout issues)
	
	**Your tasks:**
	1. **Remove Repetitive Headers/Footers**: Delete page-level artifacts like repeated chapter titles or page numbers
	2. **Merge Split Paragraphs**: Identify paragraphs that were artificially split across pages and merge them
	3. **Preserve Figures/Tables**: Keep all ![IMAGE_PLACEHOLDER] markers and table structures intact
	4. **Fix Split Sentences**: Sentences ending abruptly at one point and continuing later should be joined
	5. **Maintain Structure**: Preserve all legitimate headers, lists, and formatting
	
	**How to identify split paragraphs:**
	- A paragraph ending mid-sentence (no period, question mark, or exclamation)
	- The next section starting with a lowercase letter or continuing the thought
	- Mathematical equations or code blocks split unnaturally
	- Lists that continue across boundaries
	
	**Important**: The original PDF text is for reference only - the AI-generated markdown is your primary source. Use the PDF text to understand where natural paragraph boundaries should be.`;
	
		const userPrompt = `Please reconstruct this document:
	
	**ORIGINAL PDF TEXT (for reference - may have layout issues):**
	\`\`\`
	${originalPdfText}
	\`\`\`
	
	**AI-GENERATED MARKDOWN (your primary source):**
	\`\`\`markdown
	${aiGeneratedMarkdown}
	\`\`\`
	
	Return ONLY the cleaned, merged markdown text.`;
	
		return systemPrompt + "\n\n" + userPrompt;
	}

	private buildPrompt(
		textContent: string,
		exampleContent: string,
		customGuidance?: string
	): string {
		let systemPrompt = `You are an expert document processor. Your task is to convert raw text extracted from a PDF into clean, well-structured markdown suitable for a note-taking app like Obsidian. Follow these rules strictly:

1.  **Headers**: Convert section titles (e.g., "1.1 Trading protocol") into markdown headers ("# 1.1 Trading protocol", "## 1.1.1 Order-driven markets", etc.).
2.  **Paragraphs**: Merge consecutive lines of text into complete paragraphs, removing unnecessary line breaks.
3.  **Footnotes**: Find footnote citations (e.g., a superscript number) and inject the corresponding footnote text directly into the main text in parentheses. For example, "...a reference^1" with footnote "1 This is the info" becomes "...a reference (This is the info)".
4.  **Figures & Tables**: For any figures or tables, use a placeholder like "![IMAGE_PLACEHOLDER]" or recreate the table in markdown. Any accompanying text, source, or caption should be placed immediately below the placeholder or markdown table, separated by a single newline.
5.  **Mathematics**: Format all mathematical and scientific notations using LaTeX delimiters ("$" for inline, "$$" for block).
6.  **Output**: The response should ONLY contain the final markdown text. Do not include any conversational phrases, introductions, or apologies.`;

		let userPrompt = `Please convert the following text to markdown based on the system instructions.`;

		if (customGuidance) {
			userPrompt += `\n\n**User's Custom Instructions:**\n${customGuidance}`;
		}

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

	private buildCleanupPrompt(messyMarkdown: string): string {
		const systemPrompt = `You are a text-cleaning AI expert. Your task is to refine a markdown document converted from a PDF. The document contains repetitive headers and footers from the original PDF layout. Your goal is to remove these artifacts while preserving the core content and structure.`;

		const userPrompt = `Please clean the following markdown text.

**Instructions:**
1.  **Identify Repetitive Text:** Scan the document for phrases, titles, or section numbers that appear repeatedly. For example, a chapter title like '# 2. Overview of Supervised Learning' or a section title like '## 2.3 Least Squares and Nearest Neighbors' might appear multiple times.
2.  **Remove Redundancy:** Delete these repetitive headers and footers. The main section heading should appear only once where it is first introduced.
3.  **Merge Content:** Ensure that paragraphs broken apart by these removed headers are seamlessly joined.
4.  **Preserve Structure:** Do not alter the legitimate markdown structure (headings, lists, LaTeX equations, etc.). Only remove the redundant page-level artifacts.
5.  **Output:** Return ONLY the cleaned, final markdown text. Do not add any commentary or explanation.

**Markdown to Clean:**
\`\`\`markdown
${messyMarkdown}
\`\`\`
`;
		return systemPrompt + "\n\n" + userPrompt;
	}

	private async handleConvert(): Promise<void> {
		if (!this.selectedFile) {
			new Notice("Please select a PDF file first.");
			return;
		}

		const chapterName = this.chapterNameInput.getValue().trim();
		if (!chapterName) {
			new Notice("Please enter a chapter name.");
			return;
		}

		const isHybridMode = this.processingModeSelect.value === "hybrid";

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
				`This will convert the PDF to a note using ${
					isHybridMode ? "hybrid (text + images)" : "text-only"
				} mode.\n${finalCost}\n\nProceed?`
			)
		) {
			return;
		}

		const notice = new Notice("🤖 Converting PDF to note...", 0);

		try {
			let response: string;
			let usage: OpenAI.CompletionUsage | undefined;
	
			if (isHybridMode) {
				// Process with hybrid mode FIRST
				const result = await this.processHybridMode(notice);
				response = result.response;
				usage = result.usage;
			} else {
				// Process with text-only mode
				const promptText = this.buildPrompt(
					this.extractedText,
					this.exampleNoteContent,
					this.guidanceInput?.getValue()
				);
				const result = await this.plugin.sendToLlm(promptText);
				response = result.content;
				usage = result.usage;
			}
	
			if (!response) {
				throw new Error("LLM returned an empty response.");
			}
	
			let finalResponse = response;
			let cleanupUsage: OpenAI.CompletionUsage | undefined;
	
			// NOW we can do cleanup/reconstruction with actual content
			if (this.cleanupToggleComponent.getValue()) {
				notice.setMessage("🤖 Reconstructing document structure...");
	
				let cleanupPrompt: string;
				if (isHybridMode) {
					// Use reconstruction for hybrid mode
					cleanupPrompt = this.buildReconstructionPrompt(
						response, // Now we have actual content!
						this.extractedText
					);
				} else {
					// Use original cleanup for text mode
					cleanupPrompt = this.buildCleanupPrompt(response);
				}
	
				const cleanupResult = await this.plugin.sendToLlm(
					cleanupPrompt,
					undefined,
					{
						model: this.plugin.settings.openaiModel,
					}
				);
	
				if (cleanupResult.content) {
					finalResponse = cleanupResult.content;
					cleanupUsage = cleanupResult.usage;
				} else {
					this.plugin.logger(
						LogLevel.NORMAL,
						"Cleanup pass returned an empty response. Using original content."
					);
				}
			}

			const fileName = chapterName.endsWith(".md")
				? chapterName
				: `${chapterName}.md`;
			const notePath = folderPath
				? `${folderPath}/${fileName}`
				: fileName;

			await this.app.vault.create(notePath, finalResponse);

			if (usage) {
				let totalInputTokens = usage.prompt_tokens;
				let totalOutputTokens = usage.completion_tokens;

				if (cleanupUsage) {
					totalInputTokens += cleanupUsage.prompt_tokens;
					totalOutputTokens += cleanupUsage.completion_tokens;
				}

				await logLlmCall(this.plugin, {
					action: "pdf_to_note",
					model: isHybridMode
						? this.plugin.settings.openaiMultimodalModel
						: this.plugin.settings.openaiModel,
					inputTokens: totalInputTokens,
					outputTokens: totalOutputTokens,
					textContentTokens: countTextTokens(this.extractedText),
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

	private async processHybridMode(
		notice: Notice
	): Promise<{ response: string; usage?: OpenAI.CompletionUsage }> {
		// Render pages first
		await this.renderPdfPagesToImages();
	
		if (this.renderedPages.length === 0) {
			throw new Error("No pages were rendered successfully");
		}
	
		let combinedResponse = "";
		let totalUsage: OpenAI.CompletionUsage = {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};
	
		// Collect all PDF text for potential reconstruction
		let fullPdfText = "";
		for (const pageData of this.renderedPages) {
			if (pageData.textContent) {
				fullPdfText += `\n--- PAGE ${pageData.pageNum} ---\n${pageData.textContent}\n`;
			}
		}
	
		// Process each page
		for (let i = 0; i < this.renderedPages.length; i++) {
			const pageData = this.renderedPages[i];
			notice.setMessage(
				`🤖 Processing page ${i + 1}/${this.renderedPages.length} with AI...`
			);
	
			const promptText = this.buildHybridPrompt(
				pageData.pageNum,
				pageData.textContent,
				this.guidanceInput?.getValue()
			);
	
			const imageUrl = pageData.imageData;
	
			const result = await this.plugin.sendToLlm(promptText, imageUrl, {
				maxTokens: this.plugin.settings.pdfMaxTokensPerPage || 4000,
			});
	
			if (!result.content) {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Warning: Empty response for page ${pageData.pageNum}`
				);
				continue;
			}
	
			let pageContent = result.content;
			// Remove markdown code fences if present
			if (pageContent.match(/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/)) {
				pageContent = pageContent.replace(
					/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/,
					"$1"
				);
			}
	
			combinedResponse += `\n\n${pageContent.trim()}\n\n`;
	
			if (result.usage) {
				totalUsage.prompt_tokens += result.usage.prompt_tokens;
				totalUsage.completion_tokens += result.usage.completion_tokens;
				totalUsage.total_tokens += result.usage.total_tokens;
			}
		}
	
		// Clean up spacing before returning
		combinedResponse = combinedResponse
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]+/g, " ")
			.trim();
	
		return {
			response: combinedResponse,
			usage: totalUsage,
		};
	}

	private async populateFolderOptions(): Promise<void> {
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((file) => file.parent?.isRoot() && "children" in file)
			.map((folder) => folder.name)
			.sort();

		this.folderSelect.createEl("option", {
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

	private setupExampleNoteSection(): void {
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

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * A suggester modal for selecting an example note from the vault.
 */
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

/**
 * A generic confirmation modal that displays an estimated cost before proceeding.
 */
class ActionConfirmationModal extends Modal {
	private costUi!: { update: () => Promise<string> };

	constructor(
		private plugin: GatedNotesPlugin,
		private title: string,
		private getDynamicInputs: () => GetDynamicInputsResult,
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

/**
 * The primary modal for editing a flashcard's content and properties.
 */
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
				const cardJson = JSON.stringify({
					front: this.card.front,
					back: this.card.back,
				});

				// Different prompts based on quantity selection
				const isMultiple = quantity === "many";
				const cardWord = isMultiple ? "cards" : "card";
				const verbForm = isMultiple ? "are" : "is";

				const basePrompt = `You are an AI assistant that creates new, insightful flashcard${
					isMultiple ? "s" : ""
				} by "refocusing" an existing one.
			
			**Core Rule:** Your new ${cardWord} MUST be created by inverting the information **explicitly present** in the original card's "front" and "back" fields. The "Source Text" ${verbForm} provided only for context and should NOT be used to introduce new facts into the new ${cardWord}.
			
			**Thought Process:**
			**Formatting Rule:** Preserve all Markdown formatting, especially LaTeX math expressions (e.g., \`$ ... $\` and \`$$ ... $$\`), in the "front" and "back" fields.

			1.  **Deconstruct the Original Card:** Identify the key subject in the "back" and the key detail in the "front".
			2.  **Invert & Refocus:** Create ${
					isMultiple ? "new cards" : "a new card"
				} where the original detail${isMultiple ? "s" : ""} become${
					isMultiple ? "" : "s"
				} the subject of the question${
					isMultiple ? "s" : ""
				}, and the original subject becomes the answer${
					isMultiple ? "s" : ""
				}.
			
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
			Now, apply this process to the following card.
			
			**Original Card:**
			${cardJson}
			
			**Source Text for Context (use only to understand the card, not to add new facts):**
			${JSON.stringify(this.card.tag)}`;

				// Add duplicate prevention context after the main instructions
				let contextPrompt = "";
				if (preventDuplicates) {
					const otherCards = Object.values(this.graph).filter(
						(c) =>
							c.chapter === this.card.chapter &&
							c.id !== this.card.id
					);
					if (otherCards.length > 0) {
						const simplified = otherCards.map((c) => ({
							front: c.front,
							back: c.back,
						}));
						contextPrompt = `\n\n**Important:** To avoid duplicates, do not create ${cardWord} that cover the same information as the following existing cards:
			Existing Cards:
			${JSON.stringify(simplified)}`;
					}
				}

				// Different instructions based on quantity
				const quantityInstruction = isMultiple
					? `Create multiple refocused cards by identifying different aspects or details from the original card that can be inverted. Look for dates, names, locations, concepts, or other discrete elements that could each become the focus of a separate question. Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]`
					: `Return ONLY valid JSON of this shape: [{"front":"...","back":"..."}]`;

				const promptText = `${basePrompt}${contextPrompt}
			
			${quantityInstruction}`;

				return {
					promptText,
					imageCount: 0,
					action: "refocus" as const,
					details: { isVariableOutput: isMultiple },
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
						const { content: response, usage } =
							await this.plugin.sendToLlm(promptText);

						if (!response)
							throw new Error("LLM returned an empty response.");
						const newCards =
							this._createCardsFromLlmResponse(response);
						if (newCards.length === 0)
							throw new Error(
								"Could not parse new cards from LLM response."
							);

						if (usage) {
							await logLlmCall(this.plugin, {
								action: "refocus",
								model: this.plugin.settings.openaiModel,
								inputTokens: usage.prompt_tokens,
								outputTokens: usage.completion_tokens,
								cardsGenerated: newCards.length,
							});
						}

						newCards.forEach(
							(card) => (this.graph[card.id] = card)
						);
						await this.plugin.writeDeck(this.deck.path, this.graph);

						this.close();
						await this.plugin.promptToReviewNewCards(
							newCards,
							this.deck,
							this.graph
						);
						this.onDone(true);
					} catch (e: unknown) {
						new Notice(
							`Failed to generate cards: ${(e as Error).message}`
						);
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
				const cardJson = JSON.stringify({
					front: this.card.front,
					back: this.card.back,
				});

				const basePrompt = `You are an AI assistant that breaks down complex flashcards into multiple simpler, more atomic flashcards.

**Your Task:**
Analyze the given card and split it into 2-4 smaller, focused cards. Each new card should test a single, specific concept or fact from the original card.

**Guidelines:**
1. **Identify Multiple Concepts:** Look for compound ideas, multiple facts, or complex relationships in the original card
2. **Create Atomic Cards:** Each new card should focus on one clear, testable element
3. **Maintain Accuracy:** Only use information explicitly present in the original card
4. **Ensure Completeness:** Together, the new cards should cover the key information from the original

**Formatting Rule:** Preserve all Markdown formatting, especially LaTeX math expressions (e.g., \`$ ... $\` and \`$$ ... $$\`), in the "front" and "back" fields.

**Example:**
* **Original Complex Card:**
	* "front": "What were the main causes and effects of World War I?"
	* "back": "Causes included nationalism and militarism. Effects included millions of deaths and the Treaty of Versailles."
* **Split into Atomic Cards:**
	* Card 1: "front": "What were two main causes of World War I?", "back": "Nationalism and militarism."
	* Card 2: "front": "What was one major effect of World War I in terms of casualties?", "back": "Millions of deaths."
	* Card 3: "front": "What treaty was created as a result of World War I?", "back": "The Treaty of Versailles."

**Original Card to Split:**
${cardJson}`;

				// Add duplicate prevention context if needed
				let contextPrompt = "";
				if (preventDuplicates) {
					const otherCards = Object.values(this.graph).filter(
						(c) =>
							c.chapter === this.card.chapter &&
							c.id !== this.card.id
					);
					if (otherCards.length > 0) {
						const simplified = otherCards.map((c) => ({
							front: c.front,
							back: c.back,
						}));
						contextPrompt = `\n\n**Important:** Avoid creating cards that duplicate the following existing cards:
Existing Cards:
${JSON.stringify(simplified)}`;
					}
				}

				const promptText = `${basePrompt}${contextPrompt}

Return ONLY valid JSON array of this shape: [{"front":"...","back":"..."}]`;

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
						const { content: response, usage } =
							await this.plugin.sendToLlm(promptText);

						if (!response)
							throw new Error("LLM returned an empty response.");
						const newCards =
							this._createCardsFromLlmResponse(response);
						if (newCards.length === 0)
							throw new Error(
								"Could not parse new cards from LLM response."
							);

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
						newCards.forEach(
							(newCard) => (this.graph[newCard.id] = newCard)
						);
						await this.plugin.writeDeck(this.deck.path, this.graph);

						this.close();
						await this.plugin.promptToReviewNewCards(
							newCards,
							this.deck,
							this.graph
						);
						this.onDone(true);
					} catch (e: unknown) {
						new Notice(
							`Error splitting card: ${(e as Error).message}`
						);
					} finally {
						buttonEl.disabled = false;
						buttonEl.setText("Split with AI");
					}
				}
			).open();
		}).open();
	}
}

/**
 * A modal for selecting options before "refocusing" a card with AI.
 */
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

/**
 * A modal for selecting options before "splitting" a card with AI.
 */
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

/**
 * A modal that provides a tree-based browser for all flashcards in the vault.
 */
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

/**
 * A modal for generating an initial set of flashcards from a finalized note.
 */
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

/**
 * A simple modal to get a count from the user, typically for AI generation tasks.
 */
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

/**
 * A modal for generating additional flashcards for a note that already has some.
 */
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

/**
 * A modal that displays detailed information and review history for a single card.
 */
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

/**
 * The settings tab for the Gated Notes plugin.
 */
class GNSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: GatedNotesPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Gated Notes Settings" });

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

/**
 * Checks if a flashcard is new and has not been seen in a learning session.
 * @param card The flashcard to check.
 * @returns True if the card is considered unseen, false otherwise.
 */
const isUnseen = (card: Flashcard): boolean =>
	card.status === "new" &&
	(card.learning_step_index == null || card.learning_step_index === 0);

/**
 * Encodes a markdown string to be safely used in an HTML attribute.
 * @param md The markdown string.
 * @returns The URI-encoded string.
 */
const md2attr = (md: string): string => encodeURIComponent(md);

/**
 * Decodes a markdown string from an HTML attribute.
 * @param attr The URI-encoded string from the attribute.
 * @returns The decoded markdown string.
 */
const attr2md = (attr: string): string => decodeURIComponent(attr);

/**
 * Determines the path for the flashcard deck file based on a chapter's file path.
 * The deck is placed in the same folder as the chapter file.
 * @param chapterPath The path to the chapter's markdown file.
 * @returns The normalized path to the `_flashcards.json` file for that chapter's subject.
 */
const getDeckPathForChapter = (chapterPath: string): string => {
	const parts = chapterPath.split("/");
	const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
	return normalizePath((folder ? `${folder}/` : "") + DECK_FILE_NAME);
};

/**
 * A temporary workaround to fix math rendering issues with Obsidian's MarkdownRenderer.
 * Replaces single-backslash parentheses with dollar signs.
 * @param s The string to process.
 * @returns The processed string with fixed math delimiters.
 */
const fixMath = (s: string): string =>
	s.replace(/\\\(\s*(.*?)\s*\\\)/g, "$$$$$1$$$$");

/**
 * Extracts paragraph data (ID and markdown content) from a finalized note's HTML content.
 * @param finalizedContent The full HTML content of a finalized note.
 * @returns An array of objects, each containing a paragraph's ID and its original markdown.
 */
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

/**
 * Finds the paragraph index for a given text selection within raw markdown content.
 * @param markdownContent The full markdown content of a note.
 * @param selectedText The text to find.
 * @returns The 1-based index of the paragraph containing the text, or undefined if not found.
 */
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

/**
 * Waits for a specific element to appear in the DOM and be ready.
 * "Ready" means it has been processed by the plugin's post-processor or is not empty.
 * @param selector The CSS selector for the element.
 * @param container The parent element to search within.
 * @returns A promise that resolves to the found element, or null if it times out.
 */
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
 * Escapes a string for use in a regular expression.
 * @param string The string to escape.
 * @returns The escaped string.
 */
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds and returns a DOM Range corresponding to a given text tag within a container element.
 * Uses fuzzy matching to handle variations in whitespace and markdown rendering.
 * @param tag The text content to find.
 * @param container The HTMLElement to search within.
 * @returns A DOM Range object highlighting the found text.
 */
function findTextRange(tag: string, container: HTMLElement): Range {
	const normalize = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^\w\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

	const convertMarkdownToText = (text: string): string => {
		const converted = text
			.replace(/\*\*(.*?)\*\*/g, "$1")
			.replace(/\*(.*?)\*/g, "$1")
			.replace(/_(.*?)_/g, "$1")
			.replace(/`(.*?)`/g, "$1");
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

/**
 * Makes an Obsidian modal draggable by its title bar.
 * @param modal The Modal instance to make draggable.
 * @param plugin The plugin instance, used to store the last position.
 */
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

/**
 * Gets the starting line number for a specific paragraph in a file.
 * @param plugin The plugin instance.
 * @param file The TFile to read.
 * @param paraIdx The 1-based index of the paragraph.
 * @returns A promise that resolves to the line number.
 */
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
 * Robustly extracts a JSON array from a string, which may be malformed or wrapped in code blocks.
 * @param s The raw string from an LLM response.
 * @returns An array of parsed objects of type T.
 * @throws An error if no valid JSON can be parsed.
 */
function extractJsonArray<T>(s: string): T[] {
	// Step 1: Try direct parsing first
	try {
		const trimmed = s.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) ? parsed : [parsed];
		}
	} catch (e) {
		// Continue to other methods
	}

	// Step 2: Try to extract from code blocks
	const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (codeBlockMatch && codeBlockMatch[1]) {
		try {
			const content = codeBlockMatch[1].trim();
			const parsed = JSON.parse(content);
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch (e) {
			// Continue to other methods
		}
	}

	// Step 3: Try to find JSON array in the text
	const arrayMatches = s.matchAll(
		/\[\s*\{[\s\S]*?\}\s*(?:,\s*\{[\s\S]*?\}\s*)*\]/g
	);
	for (const match of arrayMatches) {
		try {
			const parsed = JSON.parse(match[0]);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed;
			}
		} catch (e) {
			continue;
		}
	}

	// Step 4: Try to find and fix common JSON issues
	try {
		const fixed = fixCommonJsonIssues(s);
		const parsed = JSON.parse(fixed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch (e) {
		// Continue to other methods
	}

	// Step 5: Try to extract individual objects and combine them
	const objectMatches = [...s.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
	if (objectMatches.length > 0) {
		const objects: T[] = [];
		for (const match of objectMatches) {
			try {
				const obj = JSON.parse(match[0]);
				if (obj && typeof obj === "object") {
					objects.push(obj);
				}
			} catch (e) {
				continue;
			}
		}
		if (objects.length > 0) {
			return objects;
		}
	}

	// Step 6: Last resort - try to parse as front/back format
	const frontBackRegex =
		/^\s*Front:\s*(?<front>[\s\S]+?)\s*Back:\s*(?<back>[\s\S]+?)\s*$/im;
	const match = s.match(frontBackRegex);
	if (match && match.groups) {
		const { front, back } = match.groups;
		if (front && back) {
			return [{ front: front.trim(), back: back.trim() }] as T[];
		}
	}

	throw new Error(
		"Could not parse JSON from LLM response: No valid JSON structure found"
	);
}

/**
 * Robustly extracts one or more JSON objects from a string.
 * @param s The raw string from an LLM response.
 * @returns An array of parsed objects of type T.
 * @throws An error if no valid JSON can be parsed.
 */
function extractJsonObjects<T>(s: string): T[] {
	// This function is similar but focuses on extracting objects (not necessarily arrays)

	// Step 1: Try direct parsing
	try {
		const trimmed = s.trim();
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch (e) {
		// Continue
	}

	// Step 2: Try code blocks
	const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (codeBlockMatch && codeBlockMatch[1]) {
		try {
			const content = codeBlockMatch[1].trim();
			const parsed = JSON.parse(content);
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch (e) {
			// Continue
		}
	}

	// Step 3: Try to fix and parse
	try {
		const fixed = fixCommonJsonIssues(s);
		const parsed = JSON.parse(fixed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch (e) {
		// Continue
	}

	// Step 4: Extract array if present
	const arrayMatch = s.match(/\[\s*[\s\S]*?\s*\]/);
	if (arrayMatch) {
		try {
			const parsed = JSON.parse(arrayMatch[0]);
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch (e) {
			// Try fixing the array
			try {
				const fixed = fixCommonJsonIssues(arrayMatch[0]);
				const parsed = JSON.parse(fixed);
				return Array.isArray(parsed) ? parsed : [parsed];
			} catch (e2) {
				// Continue
			}
		}
	}

	// Step 5: Extract individual objects
	const objectMatches = [...s.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
	if (objectMatches.length > 0) {
		const objects: T[] = [];
		for (const match of objectMatches) {
			try {
				const obj = JSON.parse(match[0]);
				objects.push(obj);
			} catch (e) {
				// Try fixing individual object
				try {
					const fixed = fixCommonJsonIssues(match[0]);
					const obj = JSON.parse(fixed);
					objects.push(obj);
				} catch (e2) {
					continue;
				}
			}
		}
		if (objects.length > 0) {
			return objects;
		}
	}

	// Step 6: Front/back fallback
	const frontBackRegex =
		/^\s*Front:\s*(?<front>[\s\S]+?)\s*Back:\s*(?<back>[\s\S]+?)\s*$/im;
	const match = s.match(frontBackRegex);
	if (match && match.groups) {
		const { front, back } = match.groups;
		if (front && back) {
			return [{ front: front.trim(), back: back.trim() }] as T[];
		}
	}

	throw new Error(
		"No valid JSON object, array, or Front/Back structure found"
	);
}

/**
 * Attempts to fix common issues in malformed JSON strings.
 * @param jsonString The potentially malformed JSON string.
 * @returns A string with fixes applied.
 */
function fixCommonJsonIssues(jsonString: string): string {
	let fixed = jsonString;

	// Remove common wrapper text
	fixed = fixed.replace(/```json\s*|\s*```/g, "").trim();

	// Fix unescaped backslashes (but preserve valid escapes)
	fixed = fixed.replace(/\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})/g, "\\\\");

	// Fix unescaped quotes in strings (basic heuristic)
	// This is tricky and might need adjustment based on your specific use cases

	// Fix trailing commas in arrays and objects
	fixed = fixed.replace(/,(\s*[\]}])/g, "$1");

	// Fix missing commas between array elements or object properties
	// Look for } followed by { without a comma
	fixed = fixed.replace(/\}(\s*)\{/g, "},$1{");

	// Look for " followed by " without a comma (at the end of a property)
	fixed = fixed.replace(/"(\s*)"(\s*[^:])/g, '",$1"$2');

	// Normalize whitespace around structural characters
	fixed = fixed.replace(/\s*([{}[\],:])\s*/g, "$1");
	fixed = fixed.replace(/([{}[\],:])/g, "$1 ").replace(/\s+/g, " ");
	fixed = fixed.replace(/\s*$/, "");

	// Ensure proper array structure if it looks like it should be an array
	if (fixed.includes("},{") && !fixed.trim().startsWith("[")) {
		// Might be missing array brackets
		if (!fixed.trim().startsWith("{")) {
			fixed = "[" + fixed + "]";
		} else {
			// Replace },{ with },{
			fixed = "[" + fixed + "]";
		}
	}

	return fixed;
}

/**
 * Counts the number of tokens in a string using the gpt-tokenizer library.
 * @param text The text to tokenize.
 * @returns The number of tokens.
 */
function countTextTokens(text: string): number {
	if (!text) return 0;
	return encode(text).length;
}

/**
 * Calculates the token cost for a number of images based on a fixed value.
 * @param imageCount The number of images.
 * @returns The total token cost for the images.
 */
function calculateImageTokens(imageCount: number): number {
	return imageCount * IMAGE_TOKEN_COST;
}

/**
 * Reads and parses the LLM log file.
 * @param plugin The plugin instance.
 * @returns A promise that resolves to an array of LLM log entries.
 */
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

/**
 * Estimates the number of output tokens for a given AI action based on historical log data.
 * @param plugin The plugin instance.
 * @param action The type of AI action being performed.
 * @param model The model being used.
 * @param details Additional details like card count or text token count for more accurate estimation.
 * @returns A promise that resolves to the estimated number of output tokens.
 */
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

/**
 * Calculates the estimated cost of an LLM call using the `aicost` library and historical data.
 * @param plugin The plugin instance.
 * @param provider The AI provider.
 * @param model The model ID.
 * @param action The type of AI action.
 * @param inputTokens The number of input tokens.
 * @param details Additional details for estimation.
 * @returns A promise that resolves to an object containing cost details and a formatted string.
 */
async function getEstimatedCost(
	plugin: GatedNotesPlugin,
	provider: "openai" | "lmstudio",
	model: string,
	action: LlmLogEntry["action"],
	inputTokens: number,
	details: {
		cardCount?: number;
		textContentTokens?: number;
		isVariableOutput?: boolean;
	} = {}
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

	// For variable output, estimate based on 2-3 cards average
	const estimatedOutput = details.isVariableOutput
		? await estimateOutputTokensForVariable(plugin, action, model)
		: await estimateOutputTokens(plugin, action, model, details);

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

	if (details.isVariableOutput) {
		formattedString += ` (assuming 1-3 cards, may vary)`;
	} else if (estimatedOutput > 0) {
		formattedString += ` (Prompt: $${inputCost.toFixed(
			4
		)} + Est. Response: $${outputCost.toFixed(4)})`;
	} else {
		formattedString += ` (for prompt)`;
	}

	return { totalCost, inputCost, outputCost, formattedString };
}

/**
 * Estimates output tokens for actions that have a variable number of outputs (e.g., "refocus").
 * @param plugin The plugin instance.
 * @param action The AI action type.
 * @param model The model ID.
 * @returns A promise resolving to the estimated number of output tokens.
 */
async function estimateOutputTokensForVariable(
	plugin: GatedNotesPlugin,
	action: LlmLogEntry["action"],
	model: string
): Promise<number> {
	const log = await getLlmLog(plugin);
	const relevantEntries = log.filter(
		(entry) => entry.action === action && entry.model === model
	);

	if (relevantEntries.length < 1) {
		// If no history, estimate for ~2.5 cards worth of content
		return 250; // rough estimate
	}

	const avgTokens =
		relevantEntries.reduce((sum, entry) => sum + entry.outputTokens, 0) /
		relevantEntries.length;

	// Multiply by 2.5 to account for potentially generating multiple cards
	return Math.round(avgTokens * 2.5);
}

/**
 * Logs a completed LLM call, including its cost, to the log file.
 * @param plugin The plugin instance.
 * @param data The data for the log entry, excluding timestamp and cost which are calculated here.
 */
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
