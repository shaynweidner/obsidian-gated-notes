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
	setIcon,
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
import { NavigationAwareModal } from "./navigation-aware-modal";
import { 
	NavigationContextType, 
	CardBrowserContext,
	EditModalContext 
} from "./navigation-stack";

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
	NOTE = "note",
	CUSTOM_SESSION = "custom_session",
}

enum LogLevel {
	NONE = 0,
	NORMAL = 1,
	VERBOSE = 2,
}

enum FilterState {
	OFF = "off",
	INCLUDE_ONLY = "include_only", 
	EXCLUDE = "exclude",
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
export interface CardVariant {
	front: string;
	back: string;
}

interface MnemonicEntry {
	number: string;
	words: string[];
	selected?: string;
	position: 'front' | 'back';
	story?: string;
	source?: string; // The original text that generated this number (e.g., "4:9")
}

export interface Flashcard {
	id: string;
	// Legacy fields for backwards compatibility
	front?: string;
	back?: string;
	// New variants structure
	variants?: CardVariant[];
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
	buried?: boolean;
	mnemonics?: {
		majorSystem?: MnemonicEntry[];
		enabled?: boolean;
		freeformNotes?: string;
	};
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
	/** Whether to show green leaf indicators for new flashcards. */
	showNewCardIndicators: boolean;
	/** Whether to show review cards before new cards in chapter focus mode. */
	chapterFocusReviewsFirst: boolean;
	/** Whether to enable smart interleaving for non-chapter modes. */
	enableInterleaving: boolean;
	/** Array of subject names that should be expanded in the CardBrowser. */
	cardBrowserExpandedSubjects: string[];
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
	showNewCardIndicators: true,
	chapterFocusReviewsFirst: true,
	enableInterleaving: true,
	cardBrowserExpandedSubjects: [],
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
	selectedDeckPath?: string;
	selectedChapterPath?: string;
	// Filter states
	flaggedFilter: FilterState;
	suspendedFilter: FilterState;
	buriedFilter: FilterState;
	newFilter: FilterState;
}

interface ExtractedImage {
	id: string;
	pageNumber: number;
	imageData: string; // Base64 data URL
	width: number;
	height: number;
	filename: string;
	x?: number; // PDF coordinate if available
	y?: number; // PDF coordinate if available
}

interface StitchedImage {
	id: string;
	originalImages: ExtractedImage[];
	imageData: string;
	width: number;
	height: number;
	filename: string;
}

interface ImagePlaceholder {
	id: string;
	lineIndex: number;
	placeholderText: string;
}

interface SnippingResult {
	imageData: string;
	width: number;
	height: number;
	sourceType: "pdf" | "screen" | "file";
	metadata?: any;
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
		| "generate_variants"
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
 * Core service for managing image embedding operations
 */
class ImageManager {
	constructor(private plugin: GatedNotesPlugin) {}

	async saveImageToVault(
		imageData: string,
		filename: string,
		targetFolder?: string
	): Promise<string> {
		try {
			// Convert data URL to blob
			const response = await fetch(imageData);
			const blob = await response.blob();
			const arrayBuffer = await blob.arrayBuffer();

			// Determine target path
			let targetPath = filename;
			if (targetFolder) {
				if (
					!(await this.plugin.app.vault.adapter.exists(targetFolder))
				) {
					await this.plugin.app.vault.createFolder(targetFolder);
				}
				targetPath = normalizePath(`${targetFolder}/${filename}`);
			}

			// Handle filename conflicts
			let finalPath = targetPath;
			let counter = 1;
			while (await this.plugin.app.vault.adapter.exists(finalPath)) {
				const ext = filename.split(".").pop() || "png";
				const baseName = filename.replace(`.${ext}`, "");
				finalPath = targetFolder
					? normalizePath(
							`${targetFolder}/${baseName}_${counter}.${ext}`
					  )
					: `${baseName}_${counter}.${ext}`;
				counter++;
			}

			await this.plugin.app.vault.createBinary(finalPath, arrayBuffer);
			return finalPath;
		} catch (error) {
			throw new Error(`Failed to save image: ${error}`);
		}
	}

	generateImagePlaceholder(id: string): string {
		return `[IMAGE_PLACEHOLDER:${id}]`;
	}

	async embedImageInNote(
		noteFile: TFile,
		imageData: string,
		lineIndex: number,
		filename?: string
	): Promise<void> {
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace("T", "_")
			.substring(0, 19);
		const finalFilename = filename || `embedded_image_${timestamp}.png`;

		// Get attachment folder from Obsidian settings
		const attachmentFolder = this.getAttachmentFolder(noteFile);
		const imagePath = await this.saveImageToVault(imageData, finalFilename, attachmentFolder);
		const imageMarkdown = `![[${finalFilename}]]`;

		const content = await this.plugin.app.vault.read(noteFile);
		const lines = content.split("\n");

		lines.splice(lineIndex, 0, imageMarkdown);

		await this.plugin.app.vault.modify(noteFile, lines.join("\n"));
	}

	/**
	 * Get the appropriate attachment folder based on Obsidian settings
	 */
	private getAttachmentFolder(noteFile: TFile): string | undefined {
		// Access Obsidian's file config settings
		const config = (this.plugin.app as any).vault.config;
		const attachmentFolderPath = config?.attachmentFolderPath;

		if (!attachmentFolderPath) {
			// No attachment folder configured, save to vault root
			return undefined;
		}

		if (attachmentFolderPath === "./") {
			// Same folder as current note
			return noteFile.parent?.path || undefined;
		}

		// Specific folder path
		return attachmentFolderPath;
	}

	replacePlaceholder(
		content: string,
		placeholderId: string,
		imageMarkdown: string
	): string {
		const placeholder = this.generateImagePlaceholder(placeholderId);
		return content.replace(placeholder, imageMarkdown);
	}
}

/**
 * Utility for stitching adjacent image fragments together
 */
class ImageStitcher {
	constructor(private plugin: GatedNotesPlugin) {}

	detectAdjacentImages(
		images: ExtractedImage[],
		proximityThreshold: number = 50
	): ExtractedImage[][] {
		if (images.length === 0) return [];

		// Group images by page first
		const pageGroups = new Map<number, ExtractedImage[]>();
		images.forEach((img) => {
			if (!pageGroups.has(img.pageNumber)) {
				pageGroups.set(img.pageNumber, []);
			}
			pageGroups.get(img.pageNumber)!.push(img);
		});

		const adjacentGroups: ExtractedImage[][] = [];

		// For each page, find adjacent images
		pageGroups.forEach((pageImages) => {
			const visited = new Set<string>();

			pageImages.forEach((image) => {
				if (visited.has(image.id) || !image.x || !image.y) {
					return;
				}

				const group: ExtractedImage[] = [image];
				visited.add(image.id);

				// Find all adjacent images recursively
				this.findAdjacentRecursive(
					image,
					pageImages,
					group,
					visited,
					proximityThreshold
				);

				// Only consider groups with multiple images
				if (group.length > 1) {
					adjacentGroups.push(group);
				}
			});
		});

		return adjacentGroups;
	}

	private findAdjacentRecursive(
		currentImage: ExtractedImage,
		allImages: ExtractedImage[],
		group: ExtractedImage[],
		visited: Set<string>,
		threshold: number
	): void {
		allImages.forEach((candidate) => {
			if (visited.has(candidate.id)) return;
			if (!candidate.x || !candidate.y) return;

			const distance = Math.sqrt(
				Math.pow(currentImage.x! - candidate.x, 2) +
					Math.pow(currentImage.y! - candidate.y, 2)
			);

			if (distance <= threshold) {
				group.push(candidate);
				visited.add(candidate.id);
				this.findAdjacentRecursive(
					candidate,
					allImages,
					group,
					visited,
					threshold
				);
			}
		});
	}

	async stitchImages(
		imageGroup: ExtractedImage[]
	): Promise<StitchedImage | null> {
		if (imageGroup.length < 2) return null;

		try {
			// Sort images by position (top-to-bottom, left-to-right)
			const sortedImages = [...imageGroup].sort((a, b) => {
				if (Math.abs((a.y || 0) - (b.y || 0)) < 10) {
					return (a.x || 0) - (b.x || 0); // Same row, sort by x
				}
				return (a.y || 0) - (b.y || 0); // Sort by y
			});

			// Calculate canvas dimensions
			const minX = Math.min(...sortedImages.map((img) => img.x || 0));
			const minY = Math.min(...sortedImages.map((img) => img.y || 0));
			const maxX = Math.max(
				...sortedImages.map((img) => (img.x || 0) + img.width)
			);
			const maxY = Math.max(
				...sortedImages.map((img) => (img.y || 0) + img.height)
			);

			const canvasWidth = maxX - minX;
			const canvasHeight = maxY - minY;

			// Create canvas
			const canvas = document.createElement("canvas");
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
			const ctx = canvas.getContext("2d")!;

			// Fill with white background
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, canvasWidth, canvasHeight);

			// Draw each image at its relative position
			for (const image of sortedImages) {
				const img = new Image();
				await new Promise<void>((resolve, reject) => {
					img.onload = () => {
						const relativeX = (image.x || 0) - minX;
						const relativeY = (image.y || 0) - minY;
						ctx.drawImage(img, relativeX, relativeY);
						resolve();
					};
					img.onerror = reject;
					img.src = image.imageData;
				});
			}

			const stitchedImageData = canvas.toDataURL("image/png");
			const timestamp = Date.now();

			return {
				id: `stitched_${timestamp}`,
				originalImages: imageGroup,
				imageData: stitchedImageData,
				width: canvasWidth,
				height: canvasHeight,
				filename: `stitched_image_${timestamp}.png`,
			};
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error stitching images:",
				error
			);
			return null;
		}
	}
}

/**
 * Interactive modal for live markdown editing with image placement
 */
class InteractiveEditor extends Modal {
	private editor!: HTMLTextAreaElement;
	private preview!: HTMLElement;
	private imageList!: HTMLElement;
	private content: string;
	private images: (ExtractedImage | StitchedImage)[];
	private placeholders: Map<string, ImagePlaceholder> = new Map();
	private onSave: (content: string) => void;
	private imageManager: ImageManager;
	private previewUpdateTimeout: NodeJS.Timeout | undefined;
	private selectedImages: Set<number> = new Set();
	private selectedImagesDisplay!: HTMLElement;
	private isPreviewMode: boolean = false;
	private scrollSyncPosition: number = 0;
	private toggleButton!: HTMLButtonElement;
	private editorContainer!: HTMLElement;
	private previewContainer!: HTMLElement;

	constructor(
		app: App,
		private plugin: GatedNotesPlugin,
		initialContent: string,
		images: (ExtractedImage | StitchedImage)[],
		onSave: (content: string) => void,
		private sourcePdfPath?: string, // Add optional PDF path
		private pageRangeStart?: number, // Starting page of range
		private pageRangeEnd?: number // Ending page of range
	) {
		super(app);
		this.content = initialContent;
		this.images = images;
		this.onSave = onSave;
		this.imageManager = new ImageManager(plugin);
		this.setTitle("Interactive Note Editor with Images");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("interactive-editor-modal");

		// Make modal draggable and resizable
		makeModalDraggable(this, this.plugin);
		this.makeResizable();

		// Create layout
		const container = contentEl.createDiv("editor-container");
		container.style.display = "flex";
		container.style.height = "70vh";
		container.style.gap = "20px";

		// Set initial modal size
		this.modalEl.style.width = "90vw";
		this.modalEl.style.height = "80vh";

		// Left panel: Combined Editor/Preview with toggle
		const editorPreviewPanel = container.createDiv("editor-preview-panel");
		editorPreviewPanel.style.flex = "1";
		editorPreviewPanel.style.display = "flex";
		editorPreviewPanel.style.flexDirection = "column";

		// Toggle button container
		const toggleContainer = editorPreviewPanel.createDiv("toggle-container");
		toggleContainer.style.display = "flex";
		toggleContainer.style.alignItems = "center";
		toggleContainer.style.marginBottom = "10px";
		toggleContainer.style.gap = "10px";

		toggleContainer.createEl("h3", { text: "Edit/Preview" });

		const toggleButton = toggleContainer.createEl("button", {
			text: "📝 Edit Mode",
			cls: "mod-cta"
		});
		toggleButton.onclick = () => this.toggleEditPreview();

		// Editor
		const editorContainer = editorPreviewPanel.createDiv("editor-container");
		editorContainer.style.flex = "1";
		editorContainer.style.display = "flex";
		editorContainer.style.flexDirection = "column";

		this.editor = editorContainer.createEl("textarea");
		this.editor.style.flex = "1";
		this.editor.style.fontFamily = "monospace";
		this.editor.style.fontSize = "14px";
		this.editor.style.resize = "none";
		this.editor.value = this.content;

		// Store references for later use
		this.toggleButton = toggleButton;
		this.editorContainer = editorContainer;

		this.editor.addEventListener("input", () => {
			this.content = this.editor.value;
			// Debounce preview updates to avoid freezing on rapid typing
			clearTimeout(this.previewUpdateTimeout);
			this.previewUpdateTimeout = setTimeout(() => {
				this.updatePreview().catch((error) => {
					console.error("Preview update failed:", error);
				});
			}, 300);
		});

		// Sync scroll position when scrolling in editor
		this.editor.addEventListener("scroll", () => {
			this.scrollSyncPosition = this.editor.scrollTop;
		});

		// Preview (initially hidden)
		const previewContainer = editorPreviewPanel.createDiv("preview-container");
		previewContainer.style.flex = "1";
		previewContainer.style.display = "none";
		previewContainer.style.flexDirection = "column";

		this.preview = previewContainer.createDiv("preview-content");
		this.preview.style.flex = "1";
		this.preview.style.border = "1px solid var(--background-modifier-border)";
		this.preview.style.padding = "10px";
		this.preview.style.overflow = "auto";
		this.preview.style.backgroundColor = "var(--background-primary)";

		// Store reference for later use
		this.previewContainer = previewContainer;

		// Sync scroll position when scrolling in preview
		this.preview.addEventListener("scroll", () => {
			this.scrollSyncPosition = this.preview.scrollTop;
		});

		// Right panel: Images
		const imagePanel = container.createDiv("image-panel");
		imagePanel.style.width = "300px";
		imagePanel.style.display = "flex";
		imagePanel.style.flexDirection = "column";

		imagePanel.createEl("h3", { text: "Available Images" });

		this.imageList = imagePanel.createDiv("image-list");
		this.imageList.style.flex = "1";
		this.imageList.style.overflow = "auto";
		this.imageList.style.border =
			"1px solid var(--background-modifier-border)";
		this.imageList.style.padding = "10px";

		// Populate image list
		this.populateImageList();

		// Initial preview update
		this.updatePreview();

		// Buttons
		const buttonContainer = contentEl.createDiv("button-container");
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "10px";
		buttonContainer.style.marginTop = "20px";

		const saveButton = buttonContainer.createEl("button", {
			text: "Save & Close",
		});
		saveButton.style.backgroundColor = "var(--interactive-accent)";
		saveButton.style.color = "white";
		saveButton.onclick = () => {
			this.onSave(this.content);
			this.close();
		};

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelButton.onclick = () => this.close();
	}

	/**
	 * Toggle between edit and preview modes with scroll synchronization
	 */
	private toggleEditPreview(): void {
		this.isPreviewMode = !this.isPreviewMode;

		if (this.isPreviewMode) {
			// Switch to preview mode
			this.editorContainer.style.display = "none";
			this.previewContainer.style.display = "flex";
			this.toggleButton.textContent = "👁️ Preview Mode";
			
			// Update preview content
			this.updatePreview().then(() => {
				// Sync scroll position from editor to preview
				this.preview.scrollTop = this.scrollSyncPosition;
			}).catch(error => {
				console.error("Failed to update preview:", error);
			});
		} else {
			// Switch to edit mode  
			this.previewContainer.style.display = "none";
			this.editorContainer.style.display = "flex";
			this.toggleButton.textContent = "📝 Edit Mode";
			
			// Sync scroll position from preview to editor
			setTimeout(() => {
				this.editor.scrollTop = this.scrollSyncPosition;
			}, 50);
		}
	}

	/**
	 * Rotate an image 90 degrees clockwise
	 */
	private async rotateImage(imageIndex: number, imgElement: HTMLImageElement): Promise<void> {
		try {
			const image = this.images[imageIndex];
			
			// Create a canvas to rotate the image
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				throw new Error("Could not get canvas context");
			}

			// Create a new image object to load the current image data
			const img = new Image();
			img.onload = () => {
				// Set canvas dimensions (swap width/height for 90-degree rotation)
				canvas.width = img.height;
				canvas.height = img.width;

				// Rotate the canvas 90 degrees clockwise
				ctx.translate(canvas.width / 2, canvas.height / 2);
				ctx.rotate(Math.PI / 2);
				ctx.drawImage(img, -img.width / 2, -img.height / 2);

				// Get the rotated image data
				const rotatedDataUrl = canvas.toDataURL("image/png");

				// Update the image in our array
				const updatedImage = {
					...image,
					imageData: rotatedDataUrl,
					width: image.height, // Swap dimensions
					height: image.width
				};
				this.images[imageIndex] = updatedImage;

				// Update the display
				imgElement.src = rotatedDataUrl;

				// Show feedback
				new Notice("Image rotated 90° clockwise");
			};
			
			img.src = image.imageData;
		} catch (error) {
			console.error("Failed to rotate image:", error);
			new Notice("Failed to rotate image");
		}
	}

	private populateImageList(): void {
		this.imageList.empty();

		if (this.images.length === 0) {
			this.imageList.createEl("p", { text: "No images available" });
			return;
		}

		this.images.forEach((image, index) => {
			const imageItem = this.imageList.createDiv("image-item");
			imageItem.style.marginBottom = "20px";
			imageItem.style.padding = "10px";
			imageItem.style.border =
				"1px solid var(--background-modifier-border)";
			imageItem.style.borderRadius = "5px";
			imageItem.style.cursor = "pointer";

			// Image preview
			const img = imageItem.createEl("img");
			img.src = image.imageData;
			img.style.maxWidth = "100%";
			img.style.maxHeight = "150px";
			img.style.objectFit = "contain";
			img.style.display = "block";
			img.style.marginBottom = "10px";

			// Image info
			const info = imageItem.createDiv();
			info.style.fontSize = "12px";
			info.style.color = "var(--text-muted)";

			if ("originalImages" in image) {
				info.innerHTML = `<strong>Stitched Image</strong><br/>
					${image.width}×${image.height}px<br/>
					${image.originalImages.length} fragments`;
			} else {
				info.innerHTML = `<strong>Page ${image.pageNumber}</strong><br/>
					${image.width}×${image.height}px<br/>
					${image.filename}`;
			}

			// Action buttons
			const actionButtons = imageItem.createDiv("action-buttons");
			actionButtons.style.display = "flex";
			actionButtons.style.gap = "5px";
			actionButtons.style.marginTop = "8px";
			actionButtons.style.justifyContent = "center";

			// Rotate button
			const rotateButton = actionButtons.createEl("button", {
				text: "↻ Rotate",
				cls: "mod-cta"
			});
			rotateButton.style.fontSize = "11px";
			rotateButton.style.padding = "2px 8px";
			rotateButton.onclick = async (e) => {
				e.preventDefault();
				e.stopPropagation();
				await this.rotateImage(index, img);
			};

			// Click to add placeholder or select for stitching
			imageItem.onclick = async (e) => {
				e.preventDefault();
				e.stopPropagation();

				// Check if Ctrl/Cmd is held for multi-selection
				if (e.ctrlKey || e.metaKey) {
					// Toggle selection
					if (this.selectedImages.has(index)) {
						this.selectedImages.delete(index);
						imageItem.style.border =
							"1px solid var(--background-modifier-border)";
					} else {
						this.selectedImages.add(index);
						imageItem.style.border =
							"3px solid var(--interactive-accent)";
					}

					// Update selection display
					this.updateSelectedImagesDisplay();
					return;
				}

				try {
					const placeholderId = `img_${Date.now()}_${index}`;
					const placeholder =
						this.imageManager.generateImagePlaceholder(
							placeholderId
						);

					// Insert at cursor position
					const cursorPos = this.editor.selectionStart;
					const beforeCursor = this.editor.value.substring(
						0,
						cursorPos
					);
					const afterCursor = this.editor.value.substring(cursorPos);

					this.editor.value =
						beforeCursor + placeholder + "\n" + afterCursor;
					this.content = this.editor.value;

					// Store placeholder info
					this.placeholders.set(placeholderId, {
						id: placeholderId,
						lineIndex: beforeCursor.split("\n").length - 1,
						placeholderText: placeholder,
					});

					// Visual feedback first (synchronous)
					imageItem.style.backgroundColor =
						"var(--background-modifier-success)";
					setTimeout(() => {
						imageItem.style.backgroundColor = "";
					}, 500);

					// Update preview asynchronously without blocking UI
					this.updatePreview().catch((error) => {
						console.error("Preview update failed:", error);
					});
				} catch (error) {
					console.error("Error adding image placeholder:", error);
					new Notice("Failed to add image placeholder");
				}
			};
		});

		// Add manual stitching controls
		const stitchingControls =
			this.imageList.createDiv("stitching-controls");
		stitchingControls.style.marginTop = "20px";
		stitchingControls.style.padding = "10px";
		stitchingControls.style.backgroundColor = "var(--background-secondary)";
		stitchingControls.style.borderRadius = "5px";

		const stitchButton = stitchingControls.createEl("button", {
			text: "Manual Stitch Selected Images",
		});
		stitchButton.style.cssText = `
			width: 100%; 
			margin-bottom: 10px; 
			background: var(--interactive-accent); 
			color: white; 
			border: none; 
			padding: 8px; 
			border-radius: 4px; 
			cursor: pointer;
		`;
		stitchButton.onclick = () => this.showManualStitchingModal();

		// Add Missing Images button
		const missingImagesButton = stitchingControls.createEl("button", {
			text: "📄 Capture Missing Images",
		});
		missingImagesButton.style.cssText = `
			width: 100%; 
			margin-bottom: 10px; 
			background: var(--interactive-normal); 
			color: var(--text-normal); 
			border: 1px solid var(--background-modifier-border); 
			padding: 8px; 
			border-radius: 4px; 
			cursor: pointer;
		`;
		missingImagesButton.onclick = () => this.showPDFViewerModal();

		const selectedCountEl = stitchingControls.createDiv();
		selectedCountEl.style.fontSize = "12px";
		selectedCountEl.style.color = "var(--text-muted)";
		selectedCountEl.textContent =
			"Select images by clicking them while holding Ctrl/Cmd";
		this.selectedImagesDisplay = selectedCountEl;

		// Add instructions
		const instructions = this.imageList.createDiv("instructions");
		instructions.style.marginTop = "20px";
		instructions.style.padding = "10px";
		instructions.style.backgroundColor = "var(--background-secondary)";
		instructions.style.borderRadius = "5px";
		instructions.style.fontSize = "12px";
		instructions.innerHTML = `
			<strong>Instructions:</strong><br/>
			• Click an image to insert a placeholder at cursor position<br/>
			• Ctrl/Cmd+Click to select multiple images for stitching<br/>
			• Edit the markdown text as needed<br/>
			• Placeholders will be replaced with actual images when saved
		`;
	}

	private async updatePreview(): Promise<void> {
		try {
			// Clear existing content first
			this.preview.empty();

			// Create a temporary container for rendering
			const tempContainer = this.preview.createDiv();

			// First, render the markdown as-is (with placeholders intact)
			const renderPromise = MarkdownRenderer.render(
				this.app,
				this.content,
				tempContainer,
				"",
				this.plugin
			);

			// Add timeout protection
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Render timeout")), 5000)
			);

			await Promise.race([renderPromise, timeoutPromise]);

			// After rendering, replace placeholders with clickable images
			this.placeholders.forEach((placeholder, id) => {
				const imageIndex = parseInt(id.split("_")[2]);
				if (imageIndex >= 0 && imageIndex < this.images.length) {
					const image = this.images[imageIndex];

					// Use a tree walker to find text nodes containing placeholders
					const walker = document.createTreeWalker(
						tempContainer,
						NodeFilter.SHOW_TEXT,
						null
					);

					const textNodes: Text[] = [];
					let node: Node | null;
					while ((node = walker.nextNode())) {
						if (
							node.textContent?.includes(
								placeholder.placeholderText
							)
						) {
							textNodes.push(node as Text);
						}
					}

					textNodes.forEach((textNode) => {
						if (
							textNode.textContent?.includes(
								placeholder.placeholderText
							)
						) {
							// Create clickable image element
							const imageEl = document.createElement("div");
							imageEl.className = "gn-clickable-placeholder";
							imageEl.style.cssText = `
								display: inline-block; 
								cursor: pointer; 
								margin: 5px; 
								border: 2px solid var(--interactive-accent);
								border-radius: 8px;
								padding: 5px;
								background: var(--background-secondary);
								position: relative;
								max-width: 300px;
							`;

							const img = imageEl.createEl("img");
							img.src = image.imageData;
							img.style.cssText = `
								max-width: 100%; 
								max-height: 150px; 
								display: block;
								border-radius: 4px;
							`;

							const label = imageEl.createEl("div");
							label.textContent = `Click to change image`;
							label.style.cssText = `
								font-size: 10px; 
								text-align: center; 
								color: var(--text-muted);
								margin-top: 5px;
							`;

							// Make it clickable to select different image
							imageEl.addEventListener("click", (e) => {
								e.stopPropagation();
								this.showImageSelectionForPlaceholder(id);
							});

							// Replace the text node with the image element
							const newContent = textNode.textContent.replace(
								placeholder.placeholderText,
								`<!-- PLACEHOLDER_REPLACEMENT_${id} -->`
							);

							if (textNode.parentNode) {
								// Create a temporary div to hold the new content
								const tempDiv = document.createElement("div");
								tempDiv.innerHTML = newContent;

								// Replace the placeholder marker with the actual image
								tempDiv.innerHTML = tempDiv.innerHTML.replace(
									`<!-- PLACEHOLDER_REPLACEMENT_${id} -->`,
									imageEl.outerHTML
								);

								// Replace the text node with the new content
								const fragment =
									document.createDocumentFragment();
								while (tempDiv.firstChild) {
									fragment.appendChild(tempDiv.firstChild);
								}
								textNode.parentNode.replaceChild(
									fragment,
									textNode
								);
							}
						}
					});
				}
			});
		} catch (error) {
			console.error("Preview rendering error:", error);
			this.preview.innerHTML = `
				<div style="color: var(--text-error); padding: 10px; background: var(--background-secondary); border-radius: 4px;">
					<strong>Preview Error:</strong><br/>
					${error instanceof Error ? error.message : String(error)}<br/>
					<small>Content will still be saved correctly.</small>
				</div>
			`;
		}
	}

	private updateSelectedImagesDisplay(): void {
		const count = this.selectedImages.size;
		if (count === 0) {
			this.selectedImagesDisplay.textContent =
				"Select images by clicking them while holding Ctrl/Cmd";
		} else {
			this.selectedImagesDisplay.textContent = `${count} image(s) selected for stitching`;
		}
	}

	private showPDFViewerModal(): void {
		const pdfViewerModal = new PDFViewerModal(
			this.app,
			this.plugin,
			(capturedImage) => {
				// Callback when an image is captured from PDF
				this.images.push(capturedImage);
				this.populateImageList(); // Refresh the image list
				new Notice(
					`✅ Image captured from PDF! Added to image library.`
				);
			},
			this.sourcePdfPath, // Pass the source PDF path if available
			this.pageRangeStart // Start at first page of processed range
		);
		pdfViewerModal.open();
	}

	private showManualStitchingModal(): void {
		if (this.selectedImages.size < 2) {
			new Notice(
				"Please select at least 2 images to stitch together (Ctrl/Cmd+Click)"
			);
			return;
		}

		const selectedImageObjects = Array.from(this.selectedImages)
			.map((index) => this.images[index])
			.filter((img) => img);

		const modal = new Modal(this.app);
		modal.setTitle("Manual Image Stitching");

		modal.contentEl.createEl("p", {
			text: `You've selected ${selectedImageObjects.length} images. Choose how to arrange them:`,
		});

		// Preview of selected images
		const previewContainer = modal.contentEl.createDiv();
		previewContainer.style.display = "grid";
		previewContainer.style.gridTemplateColumns =
			"repeat(auto-fit, minmax(100px, 1fr))";
		previewContainer.style.gap = "10px";
		previewContainer.style.marginBottom = "20px";

		selectedImageObjects.forEach((image, index) => {
			const imgContainer = previewContainer.createDiv();
			imgContainer.style.textAlign = "center";

			const img = imgContainer.createEl("img");
			img.src = image.imageData;
			img.style.cssText =
				"max-width: 100px; max-height: 80px; object-fit: contain; border: 1px solid var(--background-modifier-border);";

			const label = imgContainer.createDiv();
			label.textContent = `${index + 1}`;
			label.style.fontSize = "12px";
			label.style.color = "var(--text-muted)";
		});

		// Arrangement options
		const arrangeContainer = modal.contentEl.createDiv();
		arrangeContainer.style.display = "flex";
		arrangeContainer.style.gap = "10px";
		arrangeContainer.style.marginBottom = "20px";

		const horizontalBtn = arrangeContainer.createEl("button", {
			text: "Arrange Horizontally",
		});
		const verticalBtn = arrangeContainer.createEl("button", {
			text: "Arrange Vertically",
		});
		const smartBtn = arrangeContainer.createEl("button", {
			text: "Smart Arrangement",
		});

		[horizontalBtn, verticalBtn, smartBtn].forEach((btn) => {
			btn.style.flex = "1";
			btn.style.padding = "10px";
			btn.style.border = "1px solid var(--background-modifier-border)";
			btn.style.borderRadius = "4px";
			btn.style.cursor = "pointer";
		});

		horizontalBtn.onclick = () => {
			modal.close();
			this.performManualStitch(selectedImageObjects, "horizontal");
		};

		verticalBtn.onclick = () => {
			modal.close();
			this.performManualStitch(selectedImageObjects, "vertical");
		};

		smartBtn.onclick = () => {
			modal.close();
			this.performManualStitch(selectedImageObjects, "smart");
		};

		modal.open();
	}

	private async performManualStitch(
		images: (ExtractedImage | StitchedImage)[],
		arrangement: "horizontal" | "vertical" | "smart"
	): Promise<void> {
		try {
			new Notice("🧩 Stitching images together...");

			// Convert to ExtractedImage format for stitching
			const extractedImages: ExtractedImage[] = images.map((img) => {
				if ("originalImages" in img) {
					// If it's already a stitched image, use the first original
					return img.originalImages[0];
				}
				return img as ExtractedImage;
			});

			// Arrange images based on selection
			let arrangedImages: ExtractedImage[];
			if (arrangement === "horizontal") {
				// Position images side-by-side from left to right
				let currentX = 0;
				arrangedImages = extractedImages.map((img, index) => {
					const positioned = {
						...img,
						x: currentX,
						y: 0,
					};
					currentX += img.width; // No spacing - images should touch
					return positioned;
				});
			} else if (arrangement === "vertical") {
				// Position images top-to-bottom
				let currentY = 0;
				arrangedImages = extractedImages.map((img, index) => {
					const positioned = {
						...img,
						x: 0,
						y: currentY,
					};
					currentY += img.height; // No spacing - images should touch
					return positioned;
				});
			} else {
				// Smart arrangement - for now, default to horizontal
				let currentX = 0;
				arrangedImages = extractedImages.map((img, index) => {
					const positioned = {
						...img,
						x: currentX,
						y: 0,
					};
					currentX += img.width;
					return positioned;
				});
			}

			const stitched = await this.plugin.imageStitcher.stitchImages(
				arrangedImages
			);

			if (stitched) {
				// Add the stitched image to our images array
				this.images.push(stitched);

				// Clear selection
				this.selectedImages.clear();

				// Refresh the image list
				this.populateImageList();

				new Notice(
					`✅ Images stitched successfully! New composite image created.`
				);
			} else {
				new Notice("❌ Failed to stitch images together");
			}
		} catch (error) {
			console.error("Manual stitching error:", error);
			new Notice(
				`❌ Stitching failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private makeResizable(): void {
		const modalEl = this.modalEl;

		// Make the modal resizable
		modalEl.style.resize = "both";
		modalEl.style.overflow = "auto";
		modalEl.style.minWidth = "800px";
		modalEl.style.minHeight = "500px";
		modalEl.style.maxWidth = "95vw";
		modalEl.style.maxHeight = "95vh";

		// Add resize handle indicator
		const resizeHandle = modalEl.createDiv();
		resizeHandle.style.cssText = `
			position: absolute;
			bottom: 0;
			right: 0;
			width: 20px;
			height: 20px;
			background: linear-gradient(-45deg, transparent 30%, var(--text-muted) 30%, var(--text-muted) 35%, transparent 35%, transparent 65%, var(--text-muted) 65%, var(--text-muted) 70%, transparent 70%);
			cursor: nw-resize;
			pointer-events: none;
		`;

		// Adjust container height on resize (with delay for DOM setup)
		setTimeout(() => {
			const container = this.contentEl.querySelector(
				".editor-container"
			) as HTMLElement;
			if (container) {
				const resizeObserver = new ResizeObserver(() => {
					const modalHeight = modalEl.clientHeight;
					const headerHeight = 60; // Approximate header height
					const buttonHeight = 60; // Approximate button area height
					const padding = 40; // Padding and margins

					const availableHeight =
						modalHeight - headerHeight - buttonHeight - padding;
					container.style.height =
						Math.max(400, availableHeight) + "px";
				});

				resizeObserver.observe(modalEl);

				// Store observer for cleanup
				(this as any).resizeObserver = resizeObserver;
			}
		}, 100);
	}

	private showImageSelectionForPlaceholder(placeholderId: string): void {
		// Create a mini modal to select a different image for this placeholder
		const modal = new Modal(this.app);
		modal.setTitle("Select Image for Placeholder");

		const grid = modal.contentEl.createDiv();
		grid.style.display = "grid";
		grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(150px, 1fr))";
		grid.style.gap = "10px";
		grid.style.maxHeight = "400px";
		grid.style.overflow = "auto";

		this.images.forEach((image, index) => {
			const imageItem = grid.createDiv();
			imageItem.style.cssText = `
				cursor: pointer;
				padding: 10px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 5px;
				text-align: center;
			`;

			const img = imageItem.createEl("img");
			img.src = image.imageData;
			img.style.cssText =
				"max-width: 100%; max-height: 100px; object-fit: contain;";

			const info = imageItem.createDiv();
			info.style.fontSize = "10px";
			info.style.color = "var(--text-muted)";
			info.style.marginTop = "5px";

			if ("originalImages" in image) {
				info.textContent = `Stitched (${image.originalImages.length} parts)`;
			} else {
				info.textContent = `Page ${image.pageNumber}`;
			}

			imageItem.onclick = () => {
				// Update the placeholder to point to this image
				const newPlaceholderId = `img_${Date.now()}_${index}`;
				const newPlaceholder =
					this.imageManager.generateImagePlaceholder(
						newPlaceholderId
					);
				const oldPlaceholder = this.placeholders.get(placeholderId);

				if (oldPlaceholder) {
					// Replace in content
					this.content = this.content.replace(
						oldPlaceholder.placeholderText,
						newPlaceholder
					);
					this.editor.value = this.content;

					// Update placeholders map
					this.placeholders.delete(placeholderId);
					this.placeholders.set(newPlaceholderId, {
						id: newPlaceholderId,
						lineIndex: oldPlaceholder.lineIndex,
						placeholderText: newPlaceholder,
					});
				}

				modal.close();
				this.updatePreview();
			};
		});

		modal.open();
	}

	onClose(): void {
		// Clean up timeout
		if (this.previewUpdateTimeout) {
			clearTimeout(this.previewUpdateTimeout);
		}

		// Clean up resize observer
		if ((this as any).resizeObserver) {
			((this as any).resizeObserver as ResizeObserver).disconnect();
		}
	}
}

/**
 * Modal for viewing PDFs and capturing missing images via bounding box selection
 */
class PDFViewerModal extends Modal {
	private pdfContainer!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private currentPage: number = 1;
	private totalPages: number = 0;
	private currentPdf: any = null;
	private currentScale: number = 1.5;
	private isSelecting: boolean = false;
	private selectionStart: { x: number; y: number } | null = null;
	private selectionRect: HTMLElement | null = null;
	private onImageCaptured: (image: ExtractedImage | StitchedImage) => void;

	constructor(
		app: App,
		private plugin: GatedNotesPlugin,
		onImageCaptured: (image: ExtractedImage | StitchedImage) => void,
		private sourcePdfPath?: string, // Optional source PDF path
		private startingPage?: number // Page to start viewing at
	) {
		super(app);
		this.onImageCaptured = onImageCaptured;
		this.setTitle("PDF Viewer - Capture Missing Images");
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass("pdf-viewer-modal");

		// Make modal large and resizable
		this.modalEl.style.width = "90vw";
		this.modalEl.style.height = "90vh";
		this.modalEl.style.maxWidth = "1200px";
		this.modalEl.style.maxHeight = "800px";

		// Create layout
		await this.createLayout();

		// Load source PDF if available, otherwise show file picker
		if (this.sourcePdfPath) {
			await this.loadPDFFromPath(this.sourcePdfPath);
		} else {
			await this.showPDFSelection();
		}
	}

	private async createLayout(): Promise<void> {
		const { contentEl } = this;

		// Controls bar
		const controls = contentEl.createDiv("pdf-controls");
		controls.style.cssText = `
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 10px;
			background: var(--background-secondary);
			border-radius: 4px;
			margin-bottom: 10px;
		`;

		// Page navigation
		const pageControls = controls.createDiv();
		pageControls.style.display = "flex";
		pageControls.style.alignItems = "center";
		pageControls.style.gap = "10px";

		const prevBtn = pageControls.createEl("button", { text: "◀" });
		prevBtn.onclick = () => this.previousPage();
		prevBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		const pageInfo = pageControls.createEl("span");
		pageInfo.id = "page-info";
		pageInfo.textContent = "Page 0 of 0";

		const nextBtn = pageControls.createEl("button", { text: "▶" });
		nextBtn.onclick = () => this.nextPage();
		nextBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		// Zoom controls
		const zoomControls = controls.createDiv();
		zoomControls.style.display = "flex";
		zoomControls.style.alignItems = "center";
		zoomControls.style.gap = "10px";

		const zoomOutBtn = zoomControls.createEl("button", { text: "−" });
		zoomOutBtn.onclick = () => this.zoomOut();
		zoomOutBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		const zoomInfo = zoomControls.createEl("span");
		zoomInfo.id = "zoom-info";
		zoomInfo.textContent = "150%";

		const zoomInBtn = zoomControls.createEl("button", { text: "+" });
		zoomInBtn.onclick = () => this.zoomIn();
		zoomInBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		// Instructions
		const instructions = controls.createDiv();
		instructions.style.cssText = `
			font-size: 12px;
			color: var(--text-muted);
			text-align: right;
		`;
		instructions.innerHTML = `
			<strong>Instructions:</strong><br/>
			Right-click + drag to select image region
		`;

		// PDF container
		this.pdfContainer = contentEl.createDiv("pdf-container");
		this.pdfContainer.style.cssText = `
			flex: 1;
			overflow: auto;
			border: 1px solid var(--background-modifier-border);
			border-radius: 4px;
			position: relative;
			background: #f0f0f0;
			min-height: 500px;
		`;

		// Create canvas for PDF rendering
		this.canvas = this.pdfContainer.createEl("canvas");
		this.canvas.style.cssText = `
			display: block;
			margin: 20px auto;
			cursor: crosshair;
			box-shadow: 0 4px 8px rgba(0,0,0,0.1);
		`;
		this.ctx = this.canvas.getContext("2d")!;

		// Add selection event handlers
		this.setupSelectionHandlers();

		// Button container
		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.cssText = `
			display: flex;
			justify-content: flex-end;
			gap: 10px;
			margin-top: 20px;
		`;

		const selectPdfBtn = buttonContainer.createEl("button", {
			text: "📂 Select Different PDF",
		});
		selectPdfBtn.onclick = () => this.showPDFSelection();
		selectPdfBtn.style.cssText = `
			padding: 8px 16px;
			border-radius: 4px;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border: 1px solid var(--background-modifier-border);
		`;

		const closeBtn = buttonContainer.createEl("button", { text: "Close" });
		closeBtn.onclick = () => this.close();
		closeBtn.style.cssText = `
			padding: 8px 16px;
			border-radius: 4px;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border: 1px solid var(--background-modifier-border);
		`;
	}

	private async showPDFSelection(): Promise<void> {
		// Create file input for PDF selection
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".pdf";
		input.style.display = "none";

		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (file) {
				await this.loadPDF(file);
			}
			document.body.removeChild(input);
		};

		input.oncancel = () => {
			document.body.removeChild(input);
		};

		document.body.appendChild(input);
		input.click();
	}

	private async loadPDFFromPath(pdfPath: string): Promise<void> {
		try {
			// Check if PDF.js is available
			if (!(await this.plugin.snippingTool.loadPdfJsIfNeeded())) {
				new Notice("PDF.js library is required but not available");
				await this.showPDFSelection(); // Fallback to file picker
				return;
			}

			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) {
				new Notice("PDF.js library not found");
				await this.showPDFSelection(); // Fallback to file picker
				return;
			}

			// Load PDF from path (this may require file system access)
			let loadingTask;
			try {
				// Try to load as URL first (for web contexts)
				loadingTask = pdfjsLib.getDocument(pdfPath);
			} catch (urlError) {
				// If URL loading fails, try fetching as file
				try {
					const response = await fetch(pdfPath);
					const arrayBuffer = await response.arrayBuffer();
					loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
				} catch (fetchError) {
					throw new Error(
						`Could not load PDF from path: ${
							fetchError instanceof Error
								? fetchError.message
								: String(fetchError)
						}`
					);
				}
			}

			this.currentPdf = await loadingTask.promise;
			this.totalPages = this.currentPdf.numPages;
			this.currentPage = this.startingPage && this.startingPage >= 1 && this.startingPage <= this.totalPages 
				? this.startingPage 
				: 1;

			// Render first page (or starting page)
			await this.renderCurrentPage();
			this.updatePageInfo();

			const fileName =
				pdfPath.split("/").pop() || pdfPath.split("\\").pop() || "PDF";
			new Notice(
				`📄 Loaded source PDF: ${fileName} (${this.totalPages} pages)`
			);
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"PDF path loading error:",
				error
			);
			new Notice(
				`Failed to load PDF from path. ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			// Fallback to file picker
			await this.showPDFSelection();
		}
	}

	private async loadPDF(file: File): Promise<void> {
		try {
			// Check if PDF.js is available
			if (!(await this.plugin.snippingTool.loadPdfJsIfNeeded())) {
				new Notice("PDF.js library is required but not available");
				return;
			}

			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) {
				new Notice("PDF.js library not found");
				return;
			}

			// Convert file to array buffer
			const arrayBuffer = await file.arrayBuffer();

			// Load PDF
			const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
			this.currentPdf = await loadingTask.promise;
			this.totalPages = this.currentPdf.numPages;
			this.currentPage = 1;

			// Render first page
			await this.renderCurrentPage();
			this.updatePageInfo();

			new Notice(
				`📄 Loaded PDF: ${file.name} (${this.totalPages} pages)`
			);
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF loading error:", error);
			new Notice(
				`Failed to load PDF: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async renderCurrentPage(): Promise<void> {
		if (!this.currentPdf) return;

		try {
			const page = await this.currentPdf.getPage(this.currentPage);
			const viewport = page.getViewport({ scale: this.currentScale });

			this.canvas.width = viewport.width;
			this.canvas.height = viewport.height;

			const renderContext = {
				canvasContext: this.ctx,
				viewport: viewport,
			};

			await page.render(renderContext).promise;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF rendering error:", error);
			new Notice("Failed to render PDF page");
		}
	}

	private setupSelectionHandlers(): void {
		let startX: number, startY: number;

		this.canvas.addEventListener("contextmenu", (e) => {
			e.preventDefault(); // Prevent browser context menu
		});

		this.canvas.addEventListener("mousedown", (e) => {
			if (e.button !== 2) return; // Only right mouse button

			e.preventDefault();
			this.isSelecting = true;

			const rect = this.canvas.getBoundingClientRect();
			startX = e.clientX - rect.left;
			startY = e.clientY - rect.top;

			this.selectionStart = { x: startX, y: startY };

			// Create selection rectangle overlay
			this.selectionRect = document.createElement("div");
			this.selectionRect.style.cssText = `
				position: absolute;
				border: 2px dashed var(--interactive-accent);
				background: rgba(var(--interactive-accent-rgb), 0.1);
				pointer-events: none;
				z-index: 1000;
			`;

			// Position relative to the canvas container
			const containerRect = this.pdfContainer.getBoundingClientRect();
			const canvasRect = this.canvas.getBoundingClientRect();

			this.selectionRect.style.left =
				canvasRect.left - containerRect.left + startX + "px";
			this.selectionRect.style.top =
				canvasRect.top - containerRect.top + startY + "px";
			this.selectionRect.style.width = "0px";
			this.selectionRect.style.height = "0px";

			this.pdfContainer.appendChild(this.selectionRect);
		});

		this.canvas.addEventListener("mousemove", (e) => {
			if (
				!this.isSelecting ||
				!this.selectionStart ||
				!this.selectionRect
			)
				return;

			const rect = this.canvas.getBoundingClientRect();
			const currentX = e.clientX - rect.left;
			const currentY = e.clientY - rect.top;

			const left = Math.min(this.selectionStart.x, currentX);
			const top = Math.min(this.selectionStart.y, currentY);
			const width = Math.abs(currentX - this.selectionStart.x);
			const height = Math.abs(currentY - this.selectionStart.y);

			// Update selection rectangle
			const containerRect = this.pdfContainer.getBoundingClientRect();
			const canvasRect = this.canvas.getBoundingClientRect();

			this.selectionRect.style.left =
				canvasRect.left - containerRect.left + left + "px";
			this.selectionRect.style.top =
				canvasRect.top - containerRect.top + top + "px";
			this.selectionRect.style.width = width + "px";
			this.selectionRect.style.height = height + "px";
		});

		this.canvas.addEventListener("mouseup", (e) => {
			if (!this.isSelecting || e.button !== 2) return;

			this.isSelecting = false;

			if (this.selectionStart && this.selectionRect) {
				const rect = this.canvas.getBoundingClientRect();
				const endX = e.clientX - rect.left;
				const endY = e.clientY - rect.top;

				const left = Math.min(this.selectionStart.x, endX);
				const top = Math.min(this.selectionStart.y, endY);
				const width = Math.abs(endX - this.selectionStart.x);
				const height = Math.abs(endY - this.selectionStart.y);

				// Only process if selection has meaningful size
				if (width > 10 && height > 10) {
					this.handleSelection({ x: left, y: top, width, height });
				}
			}

			// Clean up selection UI
			if (this.selectionRect) {
				this.pdfContainer.removeChild(this.selectionRect);
				this.selectionRect = null;
			}
			this.selectionStart = null;
		});
	}

	private async handleSelection(selection: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): Promise<void> {
		try {
			// Capture the selected region from the canvas
			const imageData = this.ctx.getImageData(
				selection.x,
				selection.y,
				selection.width,
				selection.height
			);

			// Create a temporary canvas for the selection
			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = selection.width;
			tempCanvas.height = selection.height;
			const tempCtx = tempCanvas.getContext("2d")!;
			tempCtx.putImageData(imageData, 0, 0);

			const capturedDataUrl = tempCanvas.toDataURL("image/png");

			// Show confirmation modal
			this.showConfirmationModal(capturedDataUrl, selection);
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Selection capture error:",
				error
			);
			new Notice("Failed to capture selection");
		}
	}

	private showConfirmationModal(
		imageData: string,
		selection: { x: number; y: number; width: number; height: number }
	): void {
		const confirmModal = new Modal(this.app);
		confirmModal.setTitle("Confirm Captured Image");

		confirmModal.contentEl.style.maxWidth = "600px";

		// Preview
		const preview = confirmModal.contentEl.createDiv();
		preview.style.textAlign = "center";
		preview.style.marginBottom = "20px";

		const img = preview.createEl("img");
		img.src = imageData;
		img.style.cssText = `
			max-width: 100%;
			max-height: 300px;
			border: 1px solid var(--background-modifier-border);
			border-radius: 4px;
		`;

		// Info
		const info = confirmModal.contentEl.createDiv();
		info.style.cssText = `
			text-align: center;
			color: var(--text-muted);
			font-size: 12px;
			margin-bottom: 20px;
		`;
		info.innerHTML = `
			<strong>Captured from:</strong> Page ${this.currentPage}<br/>
			<strong>Size:</strong> ${selection.width} × ${selection.height} pixels<br/>
			<strong>Scale:</strong> ${Math.round(this.currentScale * 100)}%
		`;

		// Buttons
		const buttons = confirmModal.contentEl.createDiv();
		buttons.style.cssText = `
			display: flex;
			justify-content: center;
			gap: 10px;
		`;

		const acceptBtn = buttons.createEl("button", { text: "✅ Looks Good" });
		acceptBtn.style.cssText = `
			padding: 10px 20px;
			background: var(--interactive-accent);
			color: white;
			border: none;
			border-radius: 4px;
			cursor: pointer;
		`;
		acceptBtn.onclick = () => {
			// Create ExtractedImage object and pass to callback
			const extractedImage: ExtractedImage = {
				id: `pdf_capture_${Date.now()}`,
				pageNumber: this.currentPage,
				imageData: imageData,
				width: selection.width,
				height: selection.height,
				filename: `pdf_capture_page${
					this.currentPage
				}_${Date.now()}.png`,
				x: selection.x / this.currentScale, // Convert back to PDF coordinates
				y: selection.y / this.currentScale,
			};

			this.onImageCaptured(extractedImage);
			confirmModal.close();
		};

		const retryBtn = buttons.createEl("button", { text: "🔄 Try Again" });
		retryBtn.style.cssText = `
			padding: 10px 20px;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border: 1px solid var(--background-modifier-border);
			border-radius: 4px;
			cursor: pointer;
		`;
		retryBtn.onclick = () => {
			confirmModal.close();
			// Modal remains open for another selection
		};

		confirmModal.open();
	}

	private async previousPage(): Promise<void> {
		if (this.currentPage > 1) {
			this.currentPage--;
			await this.renderCurrentPage();
			this.updatePageInfo();
		}
	}

	private async nextPage(): Promise<void> {
		if (this.currentPage < this.totalPages) {
			this.currentPage++;
			await this.renderCurrentPage();
			this.updatePageInfo();
		}
	}

	private async zoomIn(): Promise<void> {
		this.currentScale = Math.min(this.currentScale * 1.2, 3.0);
		await this.renderCurrentPage();
		this.updateZoomInfo();
	}

	private async zoomOut(): Promise<void> {
		this.currentScale = Math.max(this.currentScale / 1.2, 0.5);
		await this.renderCurrentPage();
		this.updateZoomInfo();
	}

	private updatePageInfo(): void {
		const pageInfo = this.contentEl.querySelector("#page-info");
		if (pageInfo) {
			pageInfo.textContent = `Page ${this.currentPage} of ${this.totalPages}`;
		}
	}

	private updateZoomInfo(): void {
		const zoomInfo = this.contentEl.querySelector("#zoom-info");
		if (zoomInfo) {
			zoomInfo.textContent = `${Math.round(this.currentScale * 100)}%`;
		}
	}

	onClose(): void {
		// Clean up
		if (
			this.selectionRect &&
			this.pdfContainer.contains(this.selectionRect)
		) {
			this.pdfContainer.removeChild(this.selectionRect);
		}
	}
}

/**
 * Tool for capturing images from various sources
 */
class SnippingTool {
	constructor(private plugin: GatedNotesPlugin) {}

	async captureScreenRegion(): Promise<SnippingResult | null> {
		try {
			// First try clipboard (most reliable across environments)
			try {
				const clipboardResult = await this.captureFromClipboard();
				if (clipboardResult) {
					return clipboardResult;
				}
			} catch (clipboardError) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"Clipboard capture failed:",
					clipboardError
				);
			}

			// Then try Electron if available
			if (this.isElectronEnvironment()) {
				try {
					return await this.captureScreenElectron();
				} catch (electronError) {
					this.plugin.logger(
						LogLevel.NORMAL,
						"Electron screen capture failed:",
						electronError
					);
				}
			}

			// If both methods fail, provide helpful guidance
			new Notice(
				"📋 Screen capture: First copy an image to clipboard, then run this command.\n\n💡 Tip: Use Win+Shift+S (Windows) or Cmd+Shift+4 (Mac) to take a screenshot to clipboard."
			);
			return null;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "Screen capture error:", error);
			new Notice(
				"Screen capture failed. Try copying an image to clipboard first."
			);
			return null;
		}
	}

	private isElectronEnvironment(): boolean {
		try {
			return (
				typeof window !== "undefined" &&
				typeof (window as any).require === "function" &&
				typeof (window as any).require("electron") === "object"
			);
		} catch {
			return false;
		}
	}

	private async captureScreenElectron(): Promise<SnippingResult | null> {
		try {
			// For Electron environment, we can use native screen capture
			const electron = (window as any).require("electron");
			const { desktopCapturer } = electron;

			if (!desktopCapturer) {
				throw new Error(
					"Desktop capturer not available in this Obsidian version"
				);
			}

			// Get available sources (screens)
			const sources = await desktopCapturer.getSources({
				types: ["screen"],
				thumbnailSize: { width: 1920, height: 1080 },
			});

			if (sources.length === 0) {
				throw new Error("No screens available for capture");
			}

			// For now, use the first screen. In the future, could show a selection dialog
			const primaryScreen = sources[0];

			// Convert the thumbnail to our format
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d")!;

			const img = new Image();
			await new Promise<void>((resolve, reject) => {
				img.onload = () => {
					canvas.width = img.width;
					canvas.height = img.height;
					ctx.drawImage(img, 0, 0);
					resolve();
				};
				img.onerror = reject;
				img.src = primaryScreen.thumbnail.toDataURL();
			});

			return {
				imageData: canvas.toDataURL("image/png"),
				width: canvas.width,
				height: canvas.height,
				sourceType: "screen",
				metadata: {
					screenId: primaryScreen.id,
					screenName: primaryScreen.name,
					captureTime: new Date().toISOString(),
				},
			};
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Electron screen capture failed:",
				error
			);
			// Fall back to clipboard method
			return await this.captureFromClipboard();
		}
	}

	private async captureFromClipboard(): Promise<SnippingResult | null> {
		try {
			if (!navigator.clipboard) {
				throw new Error(
					"Clipboard API not supported in this environment"
				);
			}

			if (!navigator.clipboard.read) {
				throw new Error("Clipboard read permission not available");
			}

			let clipboardItems;
			try {
				clipboardItems = await navigator.clipboard.read();
			} catch (permissionError) {
				throw new Error(
					"Clipboard access denied - please allow clipboard permissions"
				);
			}

			if (!clipboardItems || clipboardItems.length === 0) {
				throw new Error("Clipboard is empty");
			}

			for (const clipboardItem of clipboardItems) {
				const imageTypes = clipboardItem.types.filter((type) =>
					type.startsWith("image/")
				);

				if (imageTypes.length === 0) {
					continue; // No image types in this clipboard item
				}

				for (const type of imageTypes) {
					try {
						const blob = await clipboardItem.getType(type);
						if (blob.size === 0) {
							continue; // Empty blob
						}

						const imageData = await this.blobToDataUrl(blob);
						const { width, height } = await this.getImageDimensions(
							imageData
						);

						return {
							imageData,
							width,
							height,
							sourceType: "screen",
							metadata: {
								mimeType: type,
								size: blob.size,
								captureTime: new Date().toISOString(),
								source: "clipboard",
							},
						};
					} catch (typeError) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Failed to process clipboard type ${type}:`,
							typeError
						);
						continue; // Try next type
					}
				}
			}

			throw new Error("No valid image found in clipboard");
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	async captureFromFile(filePath?: string): Promise<SnippingResult | null> {
		try {
			if (!filePath) {
				// Show file picker
				const input = document.createElement("input");
				input.type = "file";
				input.accept = "image/*";
				input.style.display = "none";

				return new Promise((resolve) => {
					input.onchange = async (e) => {
						const file = (e.target as HTMLInputElement).files?.[0];
						if (file) {
							const result = await this.processImageFile(file);
							resolve(result);
						} else {
							resolve(null);
						}
						document.body.removeChild(input);
					};

					input.oncancel = () => {
						document.body.removeChild(input);
						resolve(null);
					};

					document.body.appendChild(input);
					input.click();
				});
			} else {
				// Load from specified file path (if we have file system access)
				const response = await fetch(`file://${filePath}`);
				const blob = await response.blob();
				const file = new File(
					[blob],
					filePath.split("/").pop() || "image",
					{ type: blob.type }
				);
				return await this.processImageFile(file);
			}
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "File capture error:", error);
			new Notice("Failed to load image from file");
			return null;
		}
	}

	async captureFromPdf(
		pdfPath: string,
		pageNumber: number,
		region?: { x: number; y: number; width: number; height: number }
	): Promise<SnippingResult | null> {
		try {
			// Check if PDF.js is available
			if (typeof window !== "undefined" && (window as any).pdfjsLib) {
				return await this.capturePdfWithPdfJs(
					pdfPath,
					pageNumber,
					region
				);
			}

			// Fallback: Use file system access if available
			if (typeof window !== "undefined" && (window as any).require) {
				return await this.capturePdfWithElectron(
					pdfPath,
					pageNumber,
					region
				);
			}

			new Notice(
				"PDF capture requires PDF.js library or desktop environment"
			);
			return null;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF capture error:", error);
			new Notice(
				`PDF capture failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return null;
		}
	}

	private async capturePdfWithPdfJs(
		pdfPath: string,
		pageNumber: number,
		region?: { x: number; y: number; width: number; height: number }
	): Promise<SnippingResult | null> {
		try {
			const pdfjsLib = (window as any).pdfjsLib;

			// Load the PDF document
			const loadingTask = pdfjsLib.getDocument(pdfPath);
			const pdf = await loadingTask.promise;

			// Get the specified page
			const page = await pdf.getPage(pageNumber);

			// Set up canvas for rendering
			const scale = 2.0; // Higher resolution
			const viewport = page.getViewport({ scale });

			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d")!;
			canvas.height = viewport.height;
			canvas.width = viewport.width;

			// Render page to canvas
			const renderContext = {
				canvasContext: context,
				viewport: viewport,
			};

			await page.render(renderContext).promise;

			// Extract region if specified
			if (region) {
				const croppedCanvas = document.createElement("canvas");
				const croppedCtx = croppedCanvas.getContext("2d")!;

				croppedCanvas.width = region.width;
				croppedCanvas.height = region.height;

				croppedCtx.drawImage(
					canvas,
					region.x * scale,
					region.y * scale,
					region.width * scale,
					region.height * scale,
					0,
					0,
					region.width,
					region.height
				);

				return {
					imageData: croppedCanvas.toDataURL("image/png"),
					width: region.width,
					height: region.height,
					sourceType: "pdf",
					metadata: {
						pdfPath,
						pageNumber,
						region,
						scale,
						captureTime: new Date().toISOString(),
					},
				};
			} else {
				return {
					imageData: canvas.toDataURL("image/png"),
					width: viewport.width / scale,
					height: viewport.height / scale,
					sourceType: "pdf",
					metadata: {
						pdfPath,
						pageNumber,
						scale,
						captureTime: new Date().toISOString(),
					},
				};
			}
		} catch (error) {
			throw new Error(
				`PDF.js capture failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async capturePdfWithElectron(
		pdfPath: string,
		pageNumber: number,
		region?: { x: number; y: number; width: number; height: number }
	): Promise<SnippingResult | null> {
		try {
			// This is a placeholder for Electron-based PDF processing
			// You could potentially use node-based PDF libraries here
			// For now, we'll indicate it's not implemented

			new Notice("Electron-based PDF capture not yet implemented");
			return null;
		} catch (error) {
			throw new Error(
				`Electron PDF capture failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	async loadPdfJsIfNeeded(): Promise<boolean> {
		try {
			// Check if PDF.js is already loaded
			if (typeof window !== "undefined" && (window as any).pdfjsLib) {
				return true;
			}

			// Attempt to load PDF.js dynamically
			// This would require PDF.js to be available in the plugin's resources
			// For now, just return false to indicate it's not available

			return false;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF.js loading error:", error);
			return false;
		}
	}

	async processImageFile(file: File): Promise<SnippingResult | null> {
		try {
			const imageData = await this.fileToDataUrl(file);
			const { width, height } = await this.getImageDimensions(imageData);

			return {
				imageData,
				width,
				height,
				sourceType: "file",
				metadata: {
					fileName: file.name,
					fileSize: file.size,
					mimeType: file.type,
					lastModified: new Date(file.lastModified).toISOString(),
					captureTime: new Date().toISOString(),
				},
			};
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Image processing error:",
				error
			);
			return null;
		}
	}

	private async blobToDataUrl(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	private async fileToDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	private async getImageDimensions(
		dataUrl: string
	): Promise<{ width: number; height: number }> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () =>
				resolve({ width: img.width, height: img.height });
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	async resizeImage(
		dataUrl: string,
		maxWidth: number,
		maxHeight: number,
		quality: number = 0.9
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d")!;

				// Calculate new dimensions while maintaining aspect ratio
				let { width, height } = img;

				if (width > maxWidth || height > maxHeight) {
					const widthRatio = maxWidth / width;
					const heightRatio = maxHeight / height;
					const ratio = Math.min(widthRatio, heightRatio);

					width = Math.round(width * ratio);
					height = Math.round(height * ratio);
				}

				canvas.width = width;
				canvas.height = height;

				// Use better image quality settings
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = "high";

				ctx.drawImage(img, 0, 0, width, height);

				// Convert to appropriate format
				const format = dataUrl.startsWith("data:image/png")
					? "image/png"
					: "image/jpeg";
				resolve(canvas.toDataURL(format, quality));
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	async cropImage(
		dataUrl: string,
		cropRegion: { x: number; y: number; width: number; height: number }
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d")!;

				canvas.width = cropRegion.width;
				canvas.height = cropRegion.height;

				ctx.drawImage(
					img,
					cropRegion.x,
					cropRegion.y,
					cropRegion.width,
					cropRegion.height,
					0,
					0,
					cropRegion.width,
					cropRegion.height
				);

				resolve(canvas.toDataURL("image/png"));
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	async convertFormat(
		dataUrl: string,
		format: "png" | "jpeg" | "webp",
		quality: number = 0.9
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d")!;

				canvas.width = img.width;
				canvas.height = img.height;

				// Fill with white background for JPEG (since it doesn't support transparency)
				if (format === "jpeg") {
					ctx.fillStyle = "white";
					ctx.fillRect(0, 0, canvas.width, canvas.height);
				}

				ctx.drawImage(img, 0, 0);

				const mimeType = `image/${format}`;
				resolve(canvas.toDataURL(mimeType, quality));
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}
}

/**
 * Major System utilities for mnemonic generation
 * Based on jmandel/mnemonics project (MIT License)
 * Converts numbers to memorable words using phonetic encoding
 */
class MajorSystemUtils {
	private static readonly PHONEME_TO_DIGIT: Record<string, string> = {
		"S": "0", "Z": "0",
		"T": "1", "D": "1", "TH": "1", "DH": "1",
		"N": "2",
		"M": "3",
		"R": "4",
		"L": "5",
		"CH": "6", "JH": "6", "SH": "6", "ZH": "6",
		"K": "7", "G": "7", "NG": "7",
		"F": "8", "V": "8",
		"P": "9", "B": "9"
	};

	private static cmuDictionary: Record<string, Array<{word: string, freq: number}>> | null = null;
	private static isLoading = false;

	// Fallback dictionary while CMU loads
	private static readonly FALLBACK_WORDS: Record<string, string[]> = {
		// Single digits
		"0": ["sea", "zoo", "sew", "say", "sue", "so", "saw", "soy", "ass", "ice", "ace", "eyes"],
		"1": ["tea", "toe", "day", "die", "tie", "two", "do", "ate", "it", "at", "eat", "out"],
		"2": ["no", "new", "knee", "gnu", "now", "nay", "in", "an", "on", "own", "any", "ion"],
		"3": ["me", "may", "mow", "ma", "my", "am", "him", "home", "aim", "mime", "mama", "memo"],
		"4": ["row", "ray", "rye", "are", "ear", "ore", "eye", "air", "our", "hour", "hero", "rear"],
		"5": ["law", "lay", "lie", "low", "Lee", "loo", "ally", "owl", "ale", "oil", "all", "ill"],
		"6": ["shoe", "jay", "shy", "show", "she", "ash", "age", "edge", "huge", "wash", "wish", "josh"],
		"7": ["key", "go", "gay", "cue", "cow", "guy", "oak", "ago", "ego", "awe", "ache", "hook"],
		"8": ["fee", "vie", "foe", "via", "if", "off", "ivy", "have", "wave", "wife", "ove", "eff"],
		"9": ["bee", "pay", "pie", "bow", "boy", "ape", "pub", "bay", "buy", "by", "hope", "baby"],
		
		// Two digits - common combinations
		"10": ["test", "taste", "dust", "toast", "twist", "toss", "tease", "dose", "daze", "dice"],
		"11": ["toad", "dude", "dead", "dot", "deed", "did", "dad", "date", "diet", "donut", "tent"],
		"12": ["tan", "ton", "den", "tune", "tin", "down", "teen", "den", "dawn", "dine", "tune"],
		"13": ["team", "dam", "time", "tomb", "dime", "tame", "dome", "dime", "atom", "item"],
		"14": ["tire", "door", "tear", "tree", "tar", "deer", "dear", "dare", "draw", "true"],
		"15": ["tail", "dale", "doll", "tool", "tall", "deal", "dial", "till", "dull", "tile"],
		"16": ["dish", "touch", "teach", "ditch", "dutch", "tissue", "dosage", "damage", "dodge"],
		"17": ["dog", "twig", "duck", "take", "deck", "dug", "tag", "took", "thick", "toy"],
		"18": ["dove", "deaf", "tough", "dive", "taffy", "turf", "tooth", "depth", "thief"],
		"19": ["dip", "top", "tape", "tap", "type", "tip", "deep", "tab", "tub", "tube"],
		
		"20": ["nose", "news", "noose", "nice", "noise", "nase", "nurse", "knows", "nice", "nets"],
		"21": ["net", "note", "knot", "neat", "night", "nut", "not", "ant", "aunt", "nude"],
		"30": ["mouse", "miss", "moss", "mess", "mass", "moose", "maze", "music", "mask", "mesa"],
		"40": ["rose", "rice", "race", "ruse", "rays", "raise", "rose", "rush", "rich", "reach"],
		"49": ["rope", "robe", "rap", "rib", "rip", "ruby", "rep", "rub", "rab", "rape", "reap"],
		"50": ["lace", "loss", "loose", "lease", "lose", "lasso", "lazy", "lies", "laws", "less"],
		
		// Three digits - some common ones
		"100": ["doses", "daisies", "tissues", "teaches", "touches", "tosses", "dazzles", "tassels"],
		"101": ["test", "toast", "tasted", "twisted", "dusted", "totted", "tutted", "toasted"],
		"123": ["dynamite", "detonate", "dainty", "distant", "destiny", "dustman", "dustmen"]
	};

	static detectNumbers(text: string): Array<{number: string, position: number, source: string}> {
		console.log('🔍 Detecting numbers in text:', `"${text}"`);
		const numbers: Array<{number: string, position: number, source: string}> = [];
		
		// First, find patterns with digits separated by non-word characters
		// Examples: "4:9" -> "49", "14:3" -> "143", "1-2-3" -> "123"
		const combinedMatches = text.matchAll(/\b\d+(?:[^\w\s]+\d+)+\b/g);
		const combinedSources = new Set<string>();
		
		for (const match of combinedMatches) {
			const sourceText = match[0]; // e.g., "4:9"
			const combined = sourceText.replace(/[^\d]/g, ''); // e.g., "49"
			const individualDigits = sourceText.match(/\d+/g) || []; // e.g., ["4", "9"]
			
			console.log(`🔍 Found combined pattern: "${sourceText}" -> combined: "${combined}", individual: [${individualDigits.join(', ')}]`);
			
			combinedSources.add(sourceText);
			
			// Add the combined number
			if (combined.length > 1) {
				numbers.push({
					number: combined,
					position: match.index || 0,
					source: sourceText
				});
			}
			
			// Add individual numbers from this source
			individualDigits.forEach(digit => {
				numbers.push({
					number: digit,
					position: match.index || 0,
					source: sourceText // Same source as the combined number!
				});
			});
		}

		// Then find standalone individual numbers (not part of combined patterns)
		const individualMatches = text.matchAll(/\b\d+\b/g);
		for (const match of individualMatches) {
			// Check if this number is already part of a combined pattern
			const matchText = match[0];
			const matchPos = match.index || 0;
			
			let isPartOfCombined = false;
			for (const combinedMatch of text.matchAll(/\b\d+(?:[^\w\s]+\d+)+\b/g)) {
				const combinedStart = combinedMatch.index || 0;
				const combinedEnd = combinedStart + combinedMatch[0].length;
				if (matchPos >= combinedStart && matchPos < combinedEnd) {
					isPartOfCombined = true;
					break;
				}
			}
			
			if (!isPartOfCombined) {
				numbers.push({
					number: matchText,
					position: matchPos,
					source: matchText // Standalone numbers are their own source
				});
			}
		}

		// Remove duplicates and sort by position
		const unique = numbers.filter((num, index, arr) => 
			arr.findIndex(n => n.number === num.number && n.position === num.position && n.source === num.source) === index
		);
		
		const sorted = unique.sort((a, b) => a.position - b.position);
		console.log('🔍 Final detected numbers:', sorted.map(n => `${n.number}(from: ${n.source})`));
		return sorted;
	}

	static async loadCMUDictionary(plugin: GatedNotesPlugin): Promise<void> {
		if (this.cmuDictionary || this.isLoading) return;
		
		this.isLoading = true;
		try {
			// Load from embedded base64 dictionary
			const { CMU_DICT_COMPRESSED_BASE64 } = await import('./cmudict-data');
			
			// Decode base64 to binary data
			const binaryString = atob(CMU_DICT_COMPRESSED_BASE64);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}
			
			// Decompress using pako
			const pako = await import('pako');
			const decompressedData = pako.inflate(bytes, { to: 'string' });
			const decompressed = decompressedData;
			
			// Parse the JSON dictionary
			const rawDict = JSON.parse(decompressed);
			
			// Process the dictionary - it's already organized by Major System digits!
			this.cmuDictionary = {};
			let processedDigits = 0;
			let totalWords = 0;
			
			for (const [digits, wordList] of Object.entries(rawDict)) {
				processedDigits++;
				
				// Validate that wordList is an array of word objects
				if (Array.isArray(wordList)) {
					const validWords = wordList
						.filter(entry => entry && typeof entry === 'object' && entry.word && typeof entry.word === 'string')
						.map(entry => ({
							word: entry.word.toLowerCase(),
							freq: entry.freq || 1000 // Use existing frequency or default
						}));
					
					if (validWords.length > 0) {
						// Sort by frequency (descending)
						this.cmuDictionary[digits] = validWords.sort((a, b) => b.freq - a.freq);
						totalWords += validWords.length;
					}
				}
			}
			
		} catch (error) {
			console.warn('Failed to load CMU dictionary, using fallback:', error);
		} finally {
			this.isLoading = false;
		}
	}

	static getWordCandidates(number: string, maxCandidates: number = 12): string[] {
		console.log(`💭 Getting word candidates for number "${number}"`);
		
		// Use CMU dictionary if available
		if (this.cmuDictionary) {
			console.log(`💭 Using CMU dictionary (${Object.keys(this.cmuDictionary).length} patterns available)`);
			const entries = this.cmuDictionary[number] || [];
			console.log(`💭 Found ${entries.length} CMU entries for "${number}"`);
			
			// Sort by frequency (descending) and take top candidates
			const sorted = entries
				.filter(entry => entry.word && entry.word.length > 0)
				.sort((a, b) => b.freq - a.freq)
				.slice(0, maxCandidates)
				.map(entry => entry.word);
			
			if (sorted.length > 0) {
				console.log(`💭 Returning ${sorted.length} CMU words for "${number}":`, sorted);
				return sorted;
			} else {
				console.log(`💭 No valid CMU words found for "${number}", trying fallback...`);
			}
		} else {
			console.log(`💭 CMU dictionary not available, using fallback dictionary`);
		}
		
		// Fallback to basic dictionary
		const words = this.FALLBACK_WORDS[number] || [];
		console.log(`💭 Returning ${words.length} fallback words for "${number}":`, words.slice(0, maxCandidates));
		return words.slice(0, maxCandidates);
	}

	static generateMnemonics(text: string, position: 'front' | 'back'): MnemonicEntry[] {
		console.log(`🎯 Generating mnemonics for ${position} text: "${text}"`);
		const detectedNumbers = this.detectNumbers(text);
		const mnemonics: MnemonicEntry[] = [];

		for (const {number, source} of detectedNumbers) {
			console.log(`🎯 Processing number "${number}" from source "${source}"`);
			const words = this.getWordCandidates(number);
			if (words.length > 0) {
				mnemonics.push({
					number,
					words,
					position,
					selected: undefined, // No default selection
					source: source // Track what text generated this number
				});
				console.log(`🎯 Added mnemonic for "${number}": ${words.length} words`);
			} else {
				console.log(`🎯 No words found for "${number}", skipping`);
			}
		}

		console.log(`🎯 Generated ${mnemonics.length} mnemonics total`);
		return mnemonics;
	}

	// Helper method to detect conflicting numbers (overlapping digits)
	static getConflictingNumbers(mnemonics: MnemonicEntry[]): Map<string, string[]> {
		const conflicts = new Map<string, string[]>();
		
		// Helper function to add bidirectional conflicts
		const addConflict = (num1: string, num2: string) => {
			if (!conflicts.has(num1)) conflicts.set(num1, []);
			if (!conflicts.has(num2)) conflicts.set(num2, []);
			conflicts.get(num1)!.push(num2);
			conflicts.get(num2)!.push(num1);
		};
		
		for (let i = 0; i < mnemonics.length; i++) {
			for (let j = i + 1; j < mnemonics.length; j++) {
				const m1 = mnemonics[i];
				const m2 = mnemonics[j];
				
				if (m1.source === m2.source) {
					// They're from the same source
					const longerNum = m1.number.length > m2.number.length ? m1.number : m2.number;
					const shorterNum = m1.number.length > m2.number.length ? m2.number : m1.number;
					
					// If one number contains the other's digits, they conflict
					// e.g., "49" contains "4" and "9"
					if (longerNum.length > shorterNum.length && longerNum.includes(shorterNum)) {
						addConflict(m1.number, m2.number);
					}
				}
			}
		}
		return conflicts;
	}
}

/**
 * The main class for the Gated Notes plugin, handling all logic and UI.
 */
export default class GatedNotesPlugin extends Plugin {
	settings!: Settings;
	public lastModalTransform: string | null = null;
	private openai: OpenAI | null = null;
	public cardBrowserState: CardBrowserState = {
		openSubjects: new Set(),
		activeChapterPath: null,
		treeScroll: 0,
		editorScroll: 0,
		isFirstRender: true,
		flaggedFilter: FilterState.OFF,
		suspendedFilter: FilterState.OFF,
		buriedFilter: FilterState.OFF,
		newFilter: FilterState.OFF,
	};
	private explorerObserver: MutationObserver | null = null;
	private decorateTimeout: NodeJS.Timeout | null = null;

	private statusBar!: HTMLElement;
	private gatingStatus!: HTMLElement;
	private cardsMissingParaIdxStatus!: HTMLElement;
	private statusRefreshQueued = false;
	private studyMode: StudyMode = StudyMode.NOTE;
	private customSessionPaths: string[] = []; // Selected folders for custom session
	private customSessionExcludeNewCards: boolean = true; // Whether to exclude new cards in custom session
	private customSessionCards: Flashcard[] = []; // Pre-filtered cards for custom session
	private skippedCardIds: Set<string> = new Set(); // Track cards skipped in current session
	private isRecalculatingAll = false;

	// Enhanced image management services
	public imageManager!: ImageManager;
	public imageStitcher!: ImageStitcher;
	public snippingTool!: SnippingTool;

	private subjectOf(path: string): string {
		return path.split("/")[0] ?? "";
	}

	public startCustomReviewFromPaths(selectedPaths: string[], excludeNewCards: boolean = false): void {
		this.customSessionPaths = selectedPaths;
		this.customSessionExcludeNewCards = excludeNewCards;
		this.studyMode = StudyMode.CUSTOM_SESSION;
		
		let pathDisplay = "Vault Root";
		if (selectedPaths.length > 0) {
			if (selectedPaths.length === 1) {
				pathDisplay = selectedPaths[0];
			} else {
				pathDisplay = `${selectedPaths.length} selected items`;
			}
		}
		
		const modeText = excludeNewCards ? " (review-only)" : "";
		new Notice(`🎯 Custom study: ${pathDisplay}${modeText}`);
		this.reviewDue();
	}

	public startCustomReviewFromCards(cards: Flashcard[]): void {
		// Set up a special custom session mode that uses pre-filtered cards
		this.customSessionCards = cards;
		this.customSessionPaths = []; // Clear paths since we're using specific cards
		this.customSessionExcludeNewCards = false; // Cards are already filtered
		this.studyMode = StudyMode.CUSTOM_SESSION;
		
		new Notice(`🎯 Custom study: ${cards.length} filtered cards`);
		this.reviewDue();
	}

	private showCustomSessionDialog(): void {
		const modal = new CustomSessionDialog(this.app, (selectedPaths: string[], excludeNewCards: boolean) => {
			this.customSessionPaths = selectedPaths;
			this.customSessionExcludeNewCards = excludeNewCards;
			this.studyMode = StudyMode.CUSTOM_SESSION;
			
			let pathDisplay = "Vault Root";
			if (selectedPaths.length > 0) {
				if (selectedPaths.length === 1) {
					pathDisplay = selectedPaths[0];
				} else {
					pathDisplay = `${selectedPaths.length} folders`;
				}
			}
			
			const modeText = excludeNewCards ? " (review-only)" : "";
			new Notice(`📁 Custom session: ${pathDisplay}${modeText}`);
			this.reviewDue();
		});
		modal.open();
	}

	private async getCardsForCustomSession(): Promise<Flashcard[]> {
		// If we have pre-filtered cards, use them directly
		if (this.customSessionCards.length > 0) {
			return this.customSessionCards;
		}
		
		if (this.customSessionPaths.length === 0) {
			// Fallback to all cards if no path selected
			const allDeckFiles = this.app.vault
				.getFiles()
				.filter((f) => f.name === DECK_FILE_NAME);
			
			const allCards: Flashcard[] = [];
			for (const deckFile of allDeckFiles) {
				try {
					const content = await this.app.vault.read(deckFile);
					const deckCards = JSON.parse(content);
					allCards.push(...(Object.values(deckCards) as Flashcard[]));
				} catch (error) {
					console.warn(`Could not read deck ${deckFile.path}:`, error);
				}
			}
			
			// Filter out new cards if the option is selected
			if (this.customSessionExcludeNewCards) {
				return allCards.filter(card => !isUnseen(card));
			}
			
			return allCards;
		}

		// Separate note paths and folder paths
		const notePaths: string[] = [];
		const folderPaths: string[] = [];
		
		for (const path of this.customSessionPaths) {
			if (path.endsWith(".md")) {
				notePaths.push(path);
			} else {
				folderPaths.push(path);
			}
		}

		const cards: Flashcard[] = [];

		// Handle specific note selections
		for (const notePath of notePaths) {
			const folderPath = notePath.substring(0, notePath.lastIndexOf("/"));
			const deckPath = folderPath + "/" + DECK_FILE_NAME;
			
			try {
				const deckFile = this.app.vault.getAbstractFileByPath(deckPath);
				if (deckFile instanceof TFile) {
					const content = await this.app.vault.read(deckFile);
					const deckCards = JSON.parse(content);
					
					// Filter cards that belong to this specific note
					const noteCards = Object.values(deckCards).filter((card: any) => 
						card.chapter === notePath
					) as Flashcard[];
					
					cards.push(...noteCards);
				}
			} catch (error) {
				console.warn(`Could not read deck for note ${notePath}:`, error);
			}
		}

		// Handle folder selections (include all notes in folder and subfolders)
		const targetDeckFiles = this.app.vault
			.getFiles()
			.filter((f) => {
				if (f.name !== DECK_FILE_NAME) return false;
				
				// Get the folder path of this deck file
				const folderPath = f.path.replace(`/${DECK_FILE_NAME}`, "");
				
				// Include if it's in any selected folder path or a subfolder of selected paths
				return folderPaths.some(selectedPath => 
					folderPath === selectedPath || 
					folderPath.startsWith(`${selectedPath}/`)
				);
			});

		for (const deckFile of targetDeckFiles) {
			try {
				const content = await this.app.vault.read(deckFile);
				const deckCards = JSON.parse(content);
				cards.push(...(Object.values(deckCards) as Flashcard[]));
			} catch (error) {
				console.warn(`Could not read deck ${deckFile.path}:`, error);
			}
		}

		// Remove duplicates (in case a note is selected both individually and via its folder)
		const uniqueCards = cards.filter((card, index, self) => 
			index === self.findIndex(c => c.id === card.id)
		);

		// Filter out new cards if the option is selected
		if (this.customSessionExcludeNewCards) {
			return uniqueCards.filter(card => !isUnseen(card));
		}

		return uniqueCards;
	}

	public async gatherVaultStatistics(): Promise<{
		totalCards: number;
		byStatus: { new: number; learning: number; review: number; relearn: number };
		byState: { due: number; blocked: number; suspended: number; buried: number; flagged: number; missingParaIdx: number };
		bySubject: Array<{ subject: string; total: number; due: number; blocked: number }>;
	}> {
		const stats = {
			totalCards: 0,
			byStatus: { new: 0, learning: 0, review: 0, relearn: 0 },
			byState: { due: 0, blocked: 0, suspended: 0, buried: 0, flagged: 0, missingParaIdx: 0 },
			bySubject: [] as Array<{ subject: string; total: number; due: number; blocked: number }>
		};

		const subjectMap = new Map<string, { total: number; due: number; blocked: number }>();
		const now = Date.now();

		// Get all deck files
		const deckFiles = this.app.vault.getFiles()
			.filter(file => file.name === "_flashcards.json");

		for (const deckFile of deckFiles) {
			const graph = await this.readDeck(deckFile.path);
			const allCards = Object.values(graph);

			for (const card of allCards) {
				stats.totalCards++;

				// Status counts
				if (card.status === "new") stats.byStatus.new++;
				else if (card.status === "learning") stats.byStatus.learning++;
				else if (card.status === "review") stats.byStatus.review++;
				else if (card.status === "relearn") stats.byStatus.relearn++;

				// State counts - only count non-blocked, non-suspended cards as due
				if (card.due <= now && !card.blocked && !card.suspended) stats.byState.due++;
				if (card.blocked) stats.byState.blocked++;
				if (card.suspended) stats.byState.suspended++;
				if (card.buried) stats.byState.buried++;
				if (card.flagged) stats.byState.flagged++;
				if (card.paraIdx === undefined || card.paraIdx === null) stats.byState.missingParaIdx++;

				// Subject counts - only count non-blocked, non-suspended cards as due
				const subject = this.subjectOf(card.chapter);
				if (!subjectMap.has(subject)) {
					subjectMap.set(subject, { total: 0, due: 0, blocked: 0 });
				}
				const subjectStats = subjectMap.get(subject)!;
				subjectStats.total++;
				if (card.due <= now && !card.blocked && !card.suspended) subjectStats.due++;
				if (card.blocked) subjectStats.blocked++;
			}
		}

		// Convert subject map to sorted array
		stats.bySubject = Array.from(subjectMap.entries())
			.map(([subject, counts]) => ({ subject, ...counts }))
			.sort((a, b) => b.total - a.total);

		return stats;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.initializeOpenAIClient();

		// Initialize enhanced image services
		this.imageManager = new ImageManager(this);
		this.imageStitcher = new ImageStitcher(this);
		this.snippingTool = new SnippingTool(this);

		// Load CMU dictionary for mnemonic generation (async, non-blocking)
		MajorSystemUtils.loadCMUDictionary(this).catch(err => {
			console.warn('Failed to load CMU dictionary:', err);
		});

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
			this.setupExplorerObserver();
		});
	}

	onunload(): void {
		// Clean up the explorer observer
		if (this.explorerObserver) {
			this.explorerObserver.disconnect();
			this.explorerObserver = null;
		}
		
		// Clear any pending timeout
		if (this.decorateTimeout) {
			clearTimeout(this.decorateTimeout);
			this.decorateTimeout = null;
		}
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
			callback: () => new CardBrowser(this, this.cardBrowserState).openWithNavigation(),
		});

		this.addCommand({
			id: "gn-study-overview",
			name: "Study overview",
			callback: () => new StudyOverviewModal(this).open(),
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

		// Enhanced image management commands
		this.addCommand({
			id: "gn-interactive-image-editor",
			name: "Open Interactive Image Editor",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;

				if (!checking) {
					const content = view.editor.getValue();
					new InteractiveEditor(
						this.app,
						this,
						content,
						[], // No images initially
						async (editedContent) => {
							view.editor.setValue(editedContent);
							new Notice("✅ Note updated!");
						},
						undefined // No PDF path for manual editor
					).open();
				}
				return true;
			},
		});

		this.addCommand({
			id: "gn-import-image-file",
			name: "Import Image File to Current Note",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;

				if (!checking) {
					const input = document.createElement("input");
					input.type = "file";
					input.accept = "image/*";
					input.onchange = async (e) => {
						const file = (e.target as HTMLInputElement).files?.[0];
						if (!file) return;

						try {
							const result =
								await this.snippingTool.processImageFile(file);
							if (result) {
								const cursor = view.editor.getCursor();
								await this.imageManager.embedImageInNote(
									view.file!,
									result.imageData,
									cursor.line,
									result.metadata?.filename
								);
								new Notice(
									`✅ Image ${file.name} imported successfully!`
								);
							}
						} catch (error) {
							new Notice(`❌ Failed to import image: ${error}`);
						}
					};
					input.click();
				}
				return true;
			},
		});

		this.addCommand({
			id: "gn-capture-screen-region",
			name: "Capture Image from Clipboard",
			callback: async () => {
				const result = await this.snippingTool.captureScreenRegion();
				if (result) {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile) {
						const timestamp = new Date()
							.toISOString()
							.replace(/[:.]/g, "-")
							.replace("T", "_")
							.substring(0, 19);
						await this.imageManager.embedImageInNote(
							activeFile,
							result.imageData,
							0,
							`screen_capture_${timestamp}.png`
						);
						new Notice("✅ Screen capture embedded in note!");
					} else {
						new Notice("⚠️ No active note to embed image");
					}
				}
			},
		});

		this.addCommand({
			id: "gn-capture-from-file",
			name: "Import Image from File",
			callback: async () => {
				const result = await this.snippingTool.captureFromFile();
				if (result) {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile) {
						const timestamp = new Date()
							.toISOString()
							.replace(/[:.]/g, "-")
							.replace("T", "_")
							.substring(0, 19);
						const filename =
							result.metadata?.fileName ||
							`imported_image_${timestamp}.png`;
						await this.imageManager.embedImageInNote(
							activeFile,
							result.imageData,
							0,
							filename
						);
						new Notice("✅ Image imported and embedded in note!");
					} else {
						new Notice("⚠️ No active note to embed image");
					}
				}
			},
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

		this.addCommand({
			id: "gn-remove-unused-images",
			name: "Remove unused images from vault",
			callback: () => {
				this.removeUnusedImages();
			},
		});
	}

	private registerRibbonIcons(): void {
		this.addRibbonIcon("target", "Note focus", () => {
			this.studyMode = StudyMode.NOTE;
			new Notice("🎯 Note focus mode");
			this.reviewDue();
		});

		this.addRibbonIcon("library", "Custom session", () => {
			this.showCustomSessionDialog();
		});

		this.addRibbonIcon("brain", "Review-only focus", () => {
			this.studyMode = StudyMode.REVIEW;
			new Notice("🧠 Review-only mode");
			this.reviewDue();
		});

		this.addRibbonIcon("wallet-cards", "Card Browser", () => {
			new CardBrowser(this, this.cardBrowserState).openWithNavigation();
		});

		this.addRibbonIcon("bar-chart", "Study Overview", () => {
			new StudyOverviewModal(this).open();
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
					method: init?.method ?? "GET",
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
			// Check if there are any future cards to review
			const futureQueue = await this.collectReviewPool(activePath, 24 * 60 * 60 * 1000); // Check up to 24 hours ahead
			if (futureQueue.length > 0) {
				// Ask user if they want to review ahead of schedule
				new ReviewAheadModal(
					this.app,
					this.studyMode,
					async (timeAheadMs: number) => {
						const aheadQueue = await this.collectReviewPool(activePath, timeAheadMs);
						if (aheadQueue.length > 0) {
							await this.processReviewQueue(aheadQueue, activePath, gateBefore, false);
						} else {
							new Notice("🎉 No cards found within the specified time range!");
						}
					},
					() => {
						new Notice("🎉 All reviews complete!");
					}
				).open();
				return;
			} else {
				new Notice("🎉 All reviews complete!");
				return;
			}
		}

		await this.processReviewQueue(queue, activePath, gateBefore, false);
	}

	/**
	 * Selects the next card to review using weighted sampling based on overdue seconds.
	 * @param queue The current review queue
	 * @returns The index of the selected card, or -1 if queue is empty
	 */
	private selectNextCardForReview(queue: { card: Flashcard; deck: TFile }[]): number {
		if (queue.length === 0) return -1;
		if (queue.length === 1) {
			this.logger(LogLevel.VERBOSE, "Interleaving: Only 1 card in queue, selecting index 0");
			return 0;
		}
		
		// Skip interleaving for chapter mode or if disabled
		if (this.studyMode === StudyMode.NOTE || !this.settings.enableInterleaving) {
			this.logger(LogLevel.VERBOSE, `Interleaving: Skipped (mode=${this.studyMode}, enabled=${this.settings.enableInterleaving}), selecting index 0`);
			return 0; // Just take the first card (already sorted)
		}

		this.logger(LogLevel.VERBOSE, `Interleaving: Starting selection from ${queue.length} cards using direct overdue weighting`);

		return this.selectCardByOverdueWeight(queue);
	}

	/**
	 * Select card using direct overdue weighting.
	 */
	private selectCardByOverdueWeight(queue: { card: Flashcard; deck: TFile }[]): number {
		const overdueSeconds = queue.map(({card}) => getOverdueSeconds(card));
		const cumulativeWeights: number[] = [];
		let total = 0;
		
		// Log overdue seconds for each card
		this.logger(LogLevel.VERBOSE, "Direct sampling - Card overdue seconds:", 
			overdueSeconds.map((seconds, i) => `[${i}] ${queue[i].card.front?.substring(0, 30)}... = ${seconds}s`));
		
		for (const seconds of overdueSeconds) {
			total += Math.max(1, seconds); // Minimum weight of 1 to include all cards
			cumulativeWeights.push(total);
		}
		
		this.logger(LogLevel.VERBOSE, `Direct sampling - Cumulative weights: [${cumulativeWeights.join(', ')}], total=${total}`);
		
		const selectedIndex = sampleFromCumulative(cumulativeWeights);
		this.logger(LogLevel.VERBOSE, `Direct sampling - Selected index ${selectedIndex}: "${queue[selectedIndex].card.front?.substring(0, 50)}..." (${overdueSeconds[selectedIndex]}s overdue)`);
		
		return selectedIndex;
	}


	private async processReviewQueue(
		queue: { card: Flashcard; deck: TFile }[],
		activePath: string,
		gateBefore: number,
		isSessionContinuation: boolean = false
	): Promise<void> {
		let reviewInterrupted = false;
		let remainingQueue = [...queue]; // Work with a copy
		let reviewCount = 0;

		// Clear skipped cards tracking at the start of new sessions (not continuations)
		if (!isSessionContinuation) {
			this.skippedCardIds.clear();
		}

		this.logger(LogLevel.VERBOSE, `Review queue processing: Starting with ${remainingQueue.length} cards`);

		while (remainingQueue.length > 0) {
			reviewCount++;
			this.logger(LogLevel.VERBOSE, `Review #${reviewCount}: ${remainingQueue.length} cards remaining`);
			
			// Select next card using weighted sampling
			const selectedIndex = this.selectNextCardForReview(remainingQueue);
			if (selectedIndex === -1) break;
			
			const { card, deck } = remainingQueue[selectedIndex];
			this.logger(LogLevel.VERBOSE, `Review #${reviewCount}: Presenting card "${card.front?.substring(0, 50)}..."`);
			
			// Log initial card properties for verbose logging
			this.logger(LogLevel.VERBOSE, `Card properties before review:`, {
				id: card.id,
				due: new Date(card.due).toLocaleString(),
				dueTimestamp: card.due,
				currentTime: new Date(Date.now()).toLocaleString(),
				currentTimestamp: Date.now(),
				interval: card.interval,
				ease_factor: card.ease_factor,
				status: card.status,
				buried: card.buried,
				suspended: card.suspended,
				flagged: card.flagged,
				blocked: card.blocked
			});
			
			const res = await this.openReviewModal(card, deck);

			// Track skipped cards for session continuation
			if (res === "skip") {
				this.skippedCardIds.add(card.id);
				this.logger(LogLevel.VERBOSE, `Review #${reviewCount}: Card ${card.id} skipped, added to skip list`);
			}

			// Remove the processed card from the queue
			remainingQueue.splice(selectedIndex, 1);
			this.logger(LogLevel.VERBOSE, `Review #${reviewCount}: Card processed (result: ${res}), ${remainingQueue.length} cards remaining`);

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
			
			// Queue recalculates automatically on next iteration
		}

		if (reviewInterrupted) {
			return;
		}

		const gateAfter = await this.getFirstBlockedParaIndex(activePath);

		if (gateAfter > gateBefore) {
			new Notice("✅ New content unlocked!");

			const mdView = await this.navigateToChapter(
				this.app.vault.getAbstractFileByPath(activePath) as TFile
			);
			if (!mdView) return;

			await this.findAndScrollToNextContentfulPara(
				gateBefore,
				mdView,
				this.app.vault.getAbstractFileByPath(activePath) as TFile
			);
		} else {
			// Check if this was a custom/review-only session that could continue
			if (this.studyMode === StudyMode.REVIEW || this.studyMode === StudyMode.CUSTOM_SESSION) {
				await this.checkForSessionContinuation(activePath);
			} else {
				new Notice("All reviews for this section are complete!");
			}
		}
	}

	private async checkForSessionContinuation(activePath: string): Promise<void> {
		// Check if any new cards have become due since the session started
		const allNewQueue = await this.collectReviewPool(activePath);
		
		// Filter out cards that were skipped during this session
		const newQueue = allNewQueue.filter(item => !this.skippedCardIds.has(item.card.id));
		
		this.logger(LogLevel.VERBOSE, `Session continuation check: ${allNewQueue.length} total due, ${newQueue.length} after filtering ${this.skippedCardIds.size} skipped cards`);
		
		if (newQueue.length > 0) {
			// New cards have become due - ask user if they want to continue
			const continueSession = confirm(
				`${newQueue.length} additional cards have become due. Would you like to review them now?`
			);
			
			if (continueSession) {
				// Continue the session with the new cards (mark as continuation)
				const gateBefore = await this.getFirstBlockedParaIndex(activePath);
				await this.processReviewQueue(newQueue, activePath, gateBefore, true);
				return;
			}
		}
		
		// No new cards or user declined - show completion message
		new Notice("🎉 All reviews complete!");
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
		activePath: string,
		futureTimeMs?: number
	): Promise<{ card: Flashcard; deck: TFile }[]> {
		const reviewPool: { card: Flashcard; deck: TFile }[] = [];
		const now = Date.now();
		const dueThreshold = futureTimeMs ? now + futureTimeMs : now;

		// Handle different study modes with different file discovery strategies
		let allCards: Flashcard[] = [];
		let relevantDeckFiles: TFile[] = [];

		switch (this.studyMode) {
			case StudyMode.NOTE:
				// Only read the deck file for the current note's folder
				const noteDeckPath = getDeckPathForChapter(activePath);
				if (await this.app.vault.adapter.exists(noteDeckPath)) {
					const deckFile = this.app.vault.getAbstractFileByPath(noteDeckPath) as TFile;
					if (deckFile) {
						relevantDeckFiles = [deckFile];
					}
				}
				break;
				
			case StudyMode.CUSTOM_SESSION:
				// Get cards from selected folder and subfolders
				allCards = await this.getCardsForCustomSession();
				break;
				
			case StudyMode.REVIEW:
			default:
				// Read all deck files in vault
				relevantDeckFiles = this.app.vault
					.getFiles()
					.filter((f) => f.name.endsWith(DECK_FILE_NAME));
				break;
		}

		// For modes that use relevantDeckFiles, read and filter the cards
		if (relevantDeckFiles.length > 0) {
			for (const deck of relevantDeckFiles) {
				const graph = await this.readDeck(deck.path);
				let cardsInScope: Flashcard[];

				switch (this.studyMode) {
					case StudyMode.NOTE:
						cardsInScope = Object.values(graph).filter(
							(c) => c.chapter === activePath
						);
						break;
					case StudyMode.REVIEW:
					default:
						cardsInScope = Object.values(graph);
						break;
				}

				// Convert to the expected format with deck reference
				for (const card of cardsInScope) {
					allCards.push(card);
				}
			}
		}

		// Calculate blocked paragraph index for note mode
		let firstBlockedParaIdx = Infinity;
		if (this.studyMode === StudyMode.NOTE) {
			const blockedCards = allCards.filter(
				(c) => c.blocked && !c.suspended && !isBuried(c)
			);
			if (blockedCards.length > 0) {
				firstBlockedParaIdx = Math.min(
					...blockedCards.map((c) => c.paraIdx ?? Infinity)
				);
			}
		}

		// Now process all collected cards for review pool
		for (const card of allCards) {
			if (card.suspended) continue;
			if (card.due > dueThreshold) continue;

			// In review-only mode, never include new cards
			if (this.studyMode === StudyMode.REVIEW && isUnseen(card)) {
				continue;
			}

			if (this.studyMode === StudyMode.NOTE) {
				// In note mode, we want to include:
				// 1. All cards at or before the first blocked paragraph 
				// 2. Blocked cards that are due AND not new (so they can be reviewed to unblock progress)
				const cardParaIdx = card.paraIdx ?? Infinity;
				const isNew = isUnseen(card);
				const isBlockedAndDue = card.blocked && card.due <= dueThreshold && !isNew;
				
				if (cardParaIdx > firstBlockedParaIdx && !isBlockedAndDue) {
					continue;
				}
			}

			// Find the deck file for this card
			const cardDeckPath = getDeckPathForChapter(card.chapter);
			const deckFile = this.app.vault.getAbstractFileByPath(cardDeckPath) as TFile;
			
			if (!deckFile) {
				console.warn(`Could not find deck file for card: ${cardDeckPath}`);
				continue;
			}

			reviewPool.push({ card, deck: deckFile });
		}

		if (this.studyMode === StudyMode.NOTE && reviewPool.length === 0) {
			this.logger(LogLevel.VERBOSE, `No cards found in review pool for note mode`);
		}

		reviewPool.sort((a, b) => {
			const aIsNew = isUnseen(a.card);
			const bIsNew = isUnseen(b.card);

			// In note focus mode, respect the review-before-new setting
			if (this.studyMode === StudyMode.NOTE) {
				if (aIsNew !== bIsNew) {
					return this.settings.chapterFocusReviewsFirst 
						? (aIsNew ? 1 : -1)  // Reviews first (non-new before new)
						: (aIsNew ? -1 : 1); // New first (new before non-new) - original behavior
				}
			} else if (this.studyMode === StudyMode.CUSTOM_SESSION) {
				// In custom session mode, always put review cards before new cards
				if (aIsNew !== bIsNew) {
					return aIsNew ? 1 : -1; // Reviews first (non-new before new)
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

	public getCardVariants(card: Flashcard): CardVariant[] {
		if (card.variants && card.variants.length > 0) {
			return card.variants;
		}
		// Fallback to legacy structure
		return [{ front: card.front || "", back: card.back || "" }];
	}

	public getCurrentVariant(card: Flashcard, index: number = 0): CardVariant {
		const variants = this.getCardVariants(card);
		return variants[Math.min(index, variants.length - 1)];
	}

	private getRandomVariant(card: Flashcard): CardVariant {
		const variants = this.getCardVariants(card);
		const randomIndex = Math.floor(Math.random() * variants.length);
		return variants[randomIndex];
	}

	public ensureVariantsStructure(card: Flashcard): void {
		// Convert legacy structure to variants structure if needed
		if (!card.variants && card.front !== undefined && card.back !== undefined) {
			card.variants = [{ front: card.front, back: card.back }];
		}
		
		// Always sync front/back with first variant for backwards compatibility
		if (card.variants && card.variants.length > 0) {
			card.front = card.variants[0].front;
			card.back = card.variants[0].back;
		}
	}

	private formatDueTime(dueTimestamp: number, currentTime: number, cardStatus: string): string {
		const diffMs = dueTimestamp - currentTime;
		
		// Helper function to format numbers with one decimal place, hiding .0
		const formatDecimal = (num: number): string => {
			const rounded = Math.round(num * 10) / 10;
			return rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(1);
		};
		
		// Convert to different units
		const seconds = diffMs / 1000;
		const minutes = seconds / 60;
		const hours = minutes / 60;
		const days = hours / 24;
		
		// Choose the most appropriate unit
		if (seconds < 60) {
			const formatted = formatDecimal(seconds);
			return formatted === "1" ? "1 second" : `${formatted} seconds`;
		} else if (minutes < 60) {
			const formatted = formatDecimal(minutes);
			return formatted === "1" ? "1 minute" : `${formatted} minutes`;
		} else if (hours < 24) {
			const formatted = formatDecimal(hours);
			return formatted === "1" ? "1 hour" : `${formatted} hours`;
		} else {
			const formatted = formatDecimal(days);
			return formatted === "1" ? "1 day" : `${formatted} days`;
		}
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

		// Clear buried flag when card is answered
		card.buried = false;

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
		
		// Log final card properties after answering
		this.logger(LogLevel.VERBOSE, `Card properties after answering with "${rating}":`, {
			id: card.id,
			due: new Date(card.due).toLocaleString(),
			dueTimestamp: card.due,
			currentTime: new Date(now).toLocaleString(),
			currentTimestamp: now,
			interval: card.interval,
			ease_factor: card.ease_factor,
			status: card.status,
			buried: card.buried,
			suspended: card.suspended,
			flagged: card.flagged,
			blocked: card.blocked,
			timeAdded: `${Math.round((card.due - now) / (1000 * 60 * 60 * 24))} days`
		});
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

			// Count total images for progress tracking
			let totalImages = 0;
			let processedImages = 0;
			for (const para of paragraphs) {
				const tempRegex = /!\[\[([^\]]+)\]\]/g;
				let tempMatch;
				while ((tempMatch = tempRegex.exec(para.markdown)) !== null) {
					const imageFile =
						this.app.metadataCache.getFirstLinkpathDest(
							tempMatch[1],
							file.path
						);
					if (imageFile instanceof TFile) {
						totalImages++;
					}
				}
			}

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
						processedImages++; // Increment counter for each image encountered
						const hash = await this.calculateFileHash(imageFile);
						imageHashMap.set(hash, para.id);

						let analysisEntry = imageDb[hash];

						if (!analysisEntry || !analysisEntry.analysis) {
							// Show processing notice with image preview
							this.showImageProcessingNotice(
								imageFile,
								`🤖 Processing image ${processedImages} of ${totalImages}: ${imageFile.name}`,
								notice
							);

							const newAnalysis = await this.analyzeImage(
								imageFile,
								para.markdown
							);
							if (newAnalysis) {
								analysisEntry = newAnalysis;
								imageDb[hash] = newAnalysis;
								await this.writeImageDb(imageDb);
							}
						} else {
							// Image already processed - show skip notice
							this.showImageProcessingNotice(
								imageFile,
								`✅ Already processed image ${processedImages} of ${totalImages}: ${imageFile.name} (cached)`,
								notice
							);
							// Brief pause to show the skip notice
							await new Promise((resolve) =>
								setTimeout(resolve, 300)
							);
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
		let cardsToFix: Pick<
			Flashcard,
			"front" | "back" | "tag" | "chapter"
		>[] = [];

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

			// Trigger review modal for the new card
			const deckPath = getDeckPathForChapter(file.path);
			const graph = await this.readDeck(deckPath);
			const deckFile = this.app.vault.getAbstractFileByPath(
				deckPath
			) as TFile;
			if (deckFile) {
				await this.promptToReviewNewCards([card], deckFile, graph);
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

				// Trigger review modal for the new cards
				const deckPath = getDeckPathForChapter(file.path);
				const graph = await this.readDeck(deckPath);
				const deckFile = this.app.vault.getAbstractFileByPath(
					deckPath
				) as TFile;
				if (deckFile && cards.length > 0) {
					await this.promptToReviewNewCards(cards, deckFile, graph);
				}

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
	): Pick<Flashcard, "front" | "back" | "tag" | "chapter">[] {
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
						this.logger(
							LogLevel.VERBOSE,
							"LLM response item filtered out: Not an object",
							item
						);
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
						this.logger(
							LogLevel.VERBOSE,
							"LLM response item filtered out: Missing required fields",
							item
						);
					}
					return hasRequiredFields;
				})
				.map((item) => ({
					front: item.front.trim(),
					back: item.back.trim(),
					tag: item.tag.trim(),
					chapter: chapterPath,
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
		const firstBlockedParaIdx = await this.getFirstBlockedParaIndex(
			chapterPath
		);

		for (const div of paragraphDivs) {
			const paraIdx = Number(div.getAttribute(PARA_ID_ATTR) || 0);
			if (paraIdx) {
				div.classList.toggle(
					"gn-hidden",
					paraIdx > firstBlockedParaIdx
				);
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

	private setupExplorerObserver(): void {
		// Clean up existing observer
		if (this.explorerObserver) {
			this.explorerObserver.disconnect();
		}

		// Find the file explorer container
		const explorerContainer = document.querySelector('.nav-files-container');
		if (!explorerContainer) {
			// Retry after a short delay if explorer isn't ready yet
			setTimeout(() => this.setupExplorerObserver(), 1000);
			return;
		}

		// Create observer to watch for changes in the file explorer DOM
		this.explorerObserver = new MutationObserver((mutations) => {
			let shouldRedecorate = false;
			
			for (const mutation of mutations) {
				// Check if any nodes were added that might be file items
				if (mutation.type === 'childList') {
					for (const node of mutation.addedNodes) {
						if (node.nodeType === Node.ELEMENT_NODE) {
							const element = node as Element;
							// Check if the added node contains file items or is a file item
							if (element.classList.contains('nav-file') || 
								element.classList.contains('nav-folder') ||
								element.querySelector('.nav-file-title')) {
								shouldRedecorate = true;
								break;
							}
						}
					}
				}
				
				if (shouldRedecorate) break;
			}
			
			if (shouldRedecorate) {
				// Debounce the redecoration to avoid excessive calls
				if (this.decorateTimeout) {
					clearTimeout(this.decorateTimeout);
				}
				this.decorateTimeout = setTimeout(() => {
					this.decorateExplorer();
				}, 100);
			}
		});

		// Start observing the explorer container and all its children
		this.explorerObserver.observe(explorerContainer, {
			childList: true,
			subtree: true
		});
	}

	private async navigateToChapter(file: TFile): Promise<MarkdownView | null> {
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
				await view.setState(
					{ ...view.getState(), mode: "preview" },
					{ history: false }
				);
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
		const paraSelector = `.${PARA_CLASS}[${PARA_ID_ATTR}="${
			card.paraIdx ?? 1
		}"]`;

		for (let attempt = 1; attempt <= 3; attempt++) {
			mdView.setEphemeralState({ scroll: targetLine });
			const wrapper = await waitForEl<HTMLElement>(
				paraSelector,
				mdView.previewMode.containerEl
			);

			if (wrapper) {
				const applyHighlight = (el: HTMLElement) => {
					el.style.setProperty("--highlight-color", highlightColor);
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
							const filename = imageInfo.path.split("/").pop();
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

								const style = document.createElement("style");
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
			
			.gn-image-placement-modal {
				width: 90vw;
				height: 85vh;
				max-width: 1400px;
				max-height: 900px;
				min-width: 800px;
				min-height: 600px;
			}
			
			.gn-image-placement-modal .modal-content {
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
			front?: string;
			back?: string;
			tag: string;
			chapter: string;
		}
	): Flashcard {
		const card: Flashcard = {
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

		// Create variants structure if front/back are provided
		if (data.front && data.back) {
			card.variants = [{ front: data.front, back: data.back }];
		}

		return card;
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

	private showImageProcessingNotice(
		imageFile: TFile,
		message: string,
		existingNotice?: Notice
	): void {
		try {
			// Create a mini preview of the image using createEl
			if (existingNotice) {
				// Update existing notice with HTML content
				const noticeEl = existingNotice.noticeEl;
				noticeEl.empty();

				const container = noticeEl.createDiv();
				container.style.cssText =
					"display: flex; align-items: center; gap: 10px; max-width: 400px;";

				// Create image element asynchronously
				this.app.vault
					.readBinary(imageFile)
					.then((imageData) => {
						const base64Image =
							Buffer.from(imageData).toString("base64");
						const fileExtension = imageFile.extension
							.toLowerCase()
							.replace("jpg", "jpeg");
						const imageUrl = `data:image/${fileExtension};base64,${base64Image}`;

						const img = container.createEl("img");
						img.src = imageUrl;
						img.style.cssText =
							"width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid var(--background-modifier-border); flex-shrink: 0;";
						img.onerror = () => {
							// If image fails to load, hide it
							img.style.display = "none";
						};
					})
					.catch(() => {
						// Image loading failed - just show text
					});

				const messageEl = container.createSpan();
				messageEl.textContent = message;
				messageEl.style.cssText =
					"font-size: 14px; overflow: hidden; text-overflow: ellipsis;";
			} else {
				// Fallback: create new notice with just text
				new Notice(message, 0);
			}
		} catch (error) {
			// Fallback to simple text notice
			this.logger(
				LogLevel.NORMAL,
				"Failed to create image preview notice:",
				error
			);
			if (existingNotice) {
				existingNotice.setMessage(message);
			} else {
				new Notice(message, 0);
			}
		}
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
			const isNew = isUnseen(card);
			const showIndicator = this.settings.showNewCardIndicators && isNew;
			const titleText = showIndicator ? `🌱 ${subject} ► ${chapterName}` : `${subject} ► ${chapterName}`;
			modal.titleEl.setText(titleText);

			let settled = false;
			const safeResolve = (v: ReviewResult) => {
				if (settled) return;
				settled = true;
				resolve(v);
			};

			let state: ReviewResult = "abort";
			modal.onClose = () => safeResolve(state);

			const frontContainer = modal.contentEl.createDiv();
			const selectedVariant = this.getRandomVariant(card);
			this.renderCardContent(selectedVariant.front, frontContainer, card.chapter);

			const bottomBar = modal.contentEl.createDiv({
				cls: "gn-action-bar",
			});

			const revealBtn = new ButtonComponent(bottomBar)
				.setButtonText("Show Answer")
				.setCta();

			const mnemonicBtn = new ButtonComponent(bottomBar)
				.setIcon("brain")
				.setTooltip("View mnemonics")
				.onClick(() => this.showMnemonicsPanel(card, selectedVariant, modal));

			modal.contentEl.createEl("hr");

			const showAnswer = async () => {
				revealBtn.buttonEl.style.display = "none";

				const backContainer = modal.contentEl.createDiv();
				await this.renderCardContent(
					selectedVariant.back,
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

								// Show when the card will be due again
								const dueTimeText = this.formatDueTime(
									cardInGraph.due,
									Date.now(),
									cardInGraph.status
								);
								new Notice(`Card will be due again in ${dueTimeText}`, 3000);

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
							console.log("REVIEW MODAL DEBUG: actionTaken:", actionTaken, "newCards:", newCards?.length || 0);
							if (actionTaken) {
								if (newCards && newCards.length > 0) {
									console.log("REVIEW MODAL DEBUG: Have new cards, setting state to answered");
									// We have new cards from split/refocus operation
									// Set state to "answered" to continue the review session
									state = "answered";
									modal.close();
									
									// Don't start a separate review - let the new cards appear in future reviews
									new Notice(`✅ Created ${newCards.length} new cards! They will appear in future reviews.`);
								} else {
									console.log("REVIEW MODAL DEBUG: No new cards, setting state to abort");
									// No new cards, just a regular edit - abort to refresh
									state = "abort";
									modal.close();
								}
							}
						},
						//{ index: 1, total: 1 }, // Indicate we're in a review session
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
					graph[card.id].buried = true;
					await this.writeDeck(deck.path, graph);
					this.refreshReadingAndPreserveScroll();
					state = "answered";
					modal.close();
				});

			// Add Related Cards button (non-blocking)
			this.addRelatedCardsButtonToReviewModal(bottomBar, card);

			new ButtonComponent(bottomBar).setButtonText("Skip").onClick(() => {
				state = "skip";
				modal.close();
			});

			modal.open();
		});
	}

	private async addRelatedCardsButtonToReviewModal(bottomBar: HTMLElement, card: Flashcard): Promise<void> {
		const relatedCards = await this.findRelatedCardsForReview(card);
		const relatedCount = relatedCards.length;
		
		if (relatedCount === 0) return; // Don't show button if no related cards
		
		new ButtonComponent(bottomBar)
			.setIcon("users")
			.setTooltip(`Find ${relatedCount} cards with the same tag: "${card.tag}"`)
			.onClick(() => {
				// Create search query to find cards with the same tag
				const searchQuery = `tag:"${card.tag}"`;
				
				// Open CardBrowser with the search query pre-filled
				new CardBrowser(
					this,
					this.cardBrowserState,
					undefined, // filter
					searchQuery // initialSearchQuery
				).openWithNavigation();
			});
	}

	private async findRelatedCardsForReview(card: Flashcard): Promise<Flashcard[]> {
		const relatedCards: Flashcard[] = [];
		
		// Only search the same deck - related cards (same tag) must be from the same note
		try {
			const deckPath = getDeckPathForChapter(card.chapter);
			const graph = await this.readDeck(deckPath);
			const cards = Object.values(graph) as Flashcard[];
			
			for (const deckCard of cards) {
				// Find cards with the same tag, but exclude the current card
				if (deckCard.tag === card.tag && deckCard.id !== card.id) {
					relatedCards.push(deckCard);
				}
			}
		} catch (error) {
			console.warn(`Could not read deck for ${card.chapter}:`, error);
		}
		
		return relatedCards;
	}

	private showMnemonicsPanel(card: Flashcard, variant: CardVariant, parentModal: Modal): void {
		// Check if card has any mnemonics (either major system or freeform notes)
		const hasMajorSystem = card.mnemonics?.majorSystem && card.mnemonics.majorSystem.length > 0;
		const hasFreeformNotes = card.mnemonics?.freeformNotes && card.mnemonics.freeformNotes.trim().length > 0;
		
		if (!hasMajorSystem && !hasFreeformNotes) {
			new Notice("No mnemonics saved for this card. Use the Edit modal to create mnemonics first.");
			return;
		}

		// Create a modal for viewing saved mnemonics
		const mnemonicModal = new Modal(this.app);
		mnemonicModal.titleEl.setText("🧠 Saved Mnemonics");
		
		const content = mnemonicModal.contentEl;
		
		// Show freeform notes section if available
		if (hasFreeformNotes) {
			content.createEl("h3", { text: "💭 Personal Mnemonic Notes", cls: "mnemonic-section-header" });
			const notesDiv = content.createDiv({ cls: "freeform-notes-display" });
			// Preserve line breaks by using pre-wrap
			notesDiv.textContent = card.mnemonics!.freeformNotes!;
			notesDiv.style.whiteSpace = "pre-wrap";
			
			// Add separator if there are also major system mnemonics
			if (hasMajorSystem) {
				content.createEl("hr", { cls: "mnemonic-display-separator" });
			}
		}
		
		// Show major system section if available
		if (hasMajorSystem) {
			content.createEl("h3", { text: "🔢 Major System Words", cls: "mnemonic-section-header" });
			
			card.mnemonics!.majorSystem!.forEach((mnemonic, index) => {
				const mnemonicDiv = content.createDiv({ cls: "mnemonic-entry" });
				
				// Number and position
				const header = mnemonicDiv.createEl("h4", { 
					text: `${mnemonic.number} (${mnemonic.position})${mnemonic.source && mnemonic.source !== mnemonic.number ? ` from "${mnemonic.source}"` : ""}`
				});
				
				// Show selected word (read-only)
				const selectedWord = mnemonicDiv.createDiv({ cls: "mnemonic-selected" });
				selectedWord.createEl("strong", { text: mnemonic.selected || "No word selected" });

				// Add some spacing
				if (index < card.mnemonics!.majorSystem!.length - 1) {
					mnemonicDiv.createEl("hr");
				}
			});
		}

		// Close button
		const buttonDiv = content.createDiv({ cls: "mnemonic-buttons" });
		new ButtonComponent(buttonDiv)
			.setButtonText("Close")
			.setCta()
			.onClick(() => mnemonicModal.close());

		// Style the modal
		content.createEl("style", {
			text: `
				.mnemonic-section-header {
					margin: 20px 0 10px 0;
					color: var(--text-accent);
					border-bottom: 1px solid var(--background-modifier-border);
					padding-bottom: 5px;
				}
				.mnemonic-section-header:first-child {
					margin-top: 10px;
				}
				.freeform-notes-display {
					margin: 10px 0 15px 0;
					padding: 15px;
					background: var(--background-secondary);
					border: 1px solid var(--background-modifier-border);
					border-radius: 8px;
					font-family: var(--font-interface);
					font-size: 14px;
					line-height: 1.4;
					color: var(--text-normal);
				}
				.mnemonic-display-separator {
					margin: 25px 0;
					border: none;
					border-top: 2px dashed var(--background-modifier-border);
				}
				.mnemonic-entry { margin: 15px 0; }
				.mnemonic-selected { 
					margin: 10px 0; 
					padding: 8px 12px; 
					background: var(--background-primary-alt);
					border-radius: 6px;
					font-size: 16px;
				}
				.mnemonic-buttons { 
					margin-top: 20px; 
					text-align: center; 
				}
			`
		});

		mnemonicModal.open();
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
		new EditModal(this, card, graph, deck, onDone, reviewContext).openWithNavigation();
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
					(actionTaken: boolean, newCards?: Flashcard[]) => {
						if (!actionTaken) {
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
					if (c.suspended) continue; // Skip suspended cards
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
		
		
		
		const nonBlockedCards = cards.filter((c) => !c.blocked);
		
		if (cards.some((c) => c.blocked && !c.suspended)) {
			return "blocked";
		}
		
		if (nonBlockedCards.some((c) => c.due <= Date.now() && !c.suspended)) {
			return "due";
		}
		
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
		imageUrl?: string | string[],
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
				const imageUrls = Array.isArray(imageUrl)
					? imageUrl
					: [imageUrl];
				imageUrls.forEach((url) => {
					messageContent.push({
						type: "image_url",
						image_url: {
							url: url,
							detail: "high", // Use high detail for PDF processing
						},
					});
				});
			}

			const payload: OpenAI.Chat.Completions.ChatCompletionCreateParams =
				{
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
			(c) => c.chapter === chapterPath && c.blocked && !c.suspended && !isBuried(c)
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
			const graph = JSON.parse(content) as FlashcardGraph;
			
			// Migrate legacy cards to variants structure
			let migrated = false;
			for (const card of Object.values(graph)) {
				const hadLegacyStructure = !card.variants && card.front !== undefined && card.back !== undefined;
				this.ensureVariantsStructure(card);
				if (hadLegacyStructure) {
					migrated = true;
				}
			}
			
			// Save the migrated data back to disk
			if (migrated) {
				await this.writeDeck(deckPath, graph);
				this.logger(LogLevel.VERBOSE, `Migrated legacy cards to variants structure in ${deckPath}`);
			}
			
			return graph;
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

	private async removeUnusedImages(): Promise<void> {
		const notice = new Notice("Scanning vault for unused images...", 0);

		try {
			// Find all images in vault
			const allImages = await this.findAllImages();
			notice.setMessage(
				`Found ${allImages.length} images. Checking usage...`
			);

			// Check which images are referenced
			const unusedImages = await this.findUnusedImages(allImages);

			notice.hide();

			if (unusedImages.length === 0) {
				new Notice("No unused images found!");
				return;
			}

			// Show review modal
			new UnusedImageReviewModal(
				this.app,
				unusedImages,
				async (imagesToDelete) => {
					if (imagesToDelete.length === 0) {
						new Notice("No images deleted.");
						return;
					}

					const deleteNotice = new Notice(
						`Deleting ${imagesToDelete.length} images...`,
						0
					);
					let deletedCount = 0;

					for (const image of imagesToDelete) {
						try {
							await this.app.vault.delete(image);
							deletedCount++;
						} catch (error) {
							console.error(
								`Failed to delete ${image.path}:`,
								error
							);
						}
					}

					deleteNotice.hide();
					new Notice(
						`Deleted ${deletedCount} of ${imagesToDelete.length} images.`
					);
				}
			).open();
		} catch (error) {
			notice.hide();
			console.error("Error scanning for unused images:", error);
			new Notice(
				"Error scanning for unused images. Check console for details."
			);
		}
	}

	private async findAllImages(): Promise<TFile[]> {
		const imageExtensions = new Set([
			"png",
			"jpg",
			"jpeg",
			"gif",
			"bmp",
			"svg",
			"webp",
		]);
		const allFiles = this.app.vault.getFiles();

		return allFiles.filter((file) => {
			const extension = file.extension.toLowerCase();
			return imageExtensions.has(extension);
		});
	}

	private async findUnusedImages(images: TFile[]): Promise<TFile[]> {
		const allNotes = this.app.vault.getMarkdownFiles();
		const unusedImages: TFile[] = [];

		// Get image database and all flashcard files
		const imageDb = await this.getImageDb();
		const allDeckFiles = this.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));

		// Create a map from image file path to its hash for faster lookups
		const imagePathToHash = new Map<string, string>();
		for (const [hash, imageData] of Object.entries(imageDb)) {
			imagePathToHash.set(imageData.path, hash);
		}

		for (const image of images) {
			let isUsed = false;
			const imageName = image.name;
			const imageHash = imagePathToHash.get(image.path);

			// Check all notes for references to this image
			for (const note of allNotes) {
				try {
					const content = await this.app.vault.cachedRead(note);

					// Check for various ways images might be referenced:
					// 1. Standard markdown: ![](imagename.png) or ![[imagename.png]]
					// 2. HTML img tags: <img src="..." />
					// 3. URL encoded in HTML attributes (like your example)
					// 4. Base64 encoded references
					if (
						content.includes(imageName) ||
						content.includes(encodeURIComponent(imageName)) ||
						content.includes(image.path)
					) {
						isUsed = true;
						break;
					}
				} catch (error) {
					console.warn(`Could not read note ${note.path}:`, error);
				}
			}

			// If not found in notes, check flashcards for image hash references
			if (!isUsed && imageHash) {
				const hashReference = `[[IMAGE HASH=${imageHash}]]`;
				
				for (const deckFile of allDeckFiles) {
					try {
						const graph = await this.readDeck(deckFile.path);
						
						// Check all cards in this deck
						for (const card of Object.values(graph)) {
							// Check front, back, and tag fields for image hash references
							if (
								(card.front && card.front.includes(hashReference)) ||
								(card.back && card.back.includes(hashReference)) ||
								card.tag.includes(hashReference)
							) {
								isUsed = true;
								break;
							}
						}
						
						if (isUsed) break;
					} catch (error) {
						console.warn(`Could not read deck ${deckFile.path}:`, error);
					}
				}
			}

			if (!isUsed) {
				unusedImages.push(image);
			}
		}

		return unusedImages;
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

		new Setting(this.contentEl)
			.setName("Select EPUB File")
			.addButton((btn) => {
				btn.setButtonText("Choose File").onClick(() =>
					this.fileInput.click()
				);
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
	private examplePdfFile: File | null = null;
	private examplePdfModeSelect!: HTMLSelectElement;
	private examplePdfModeContainer!: HTMLElement;
	private examplePdfPages: Array<{
		pageNum: number;
		imageData: string;
		textContent?: string;
	}> = [];
	private cleanupToggleComponent!: ToggleComponent;

	// Token limit controls
	private limitMainTokensToggle!: ToggleComponent;
	private mainTokensInput!: TextComponent;
	private limitNuclearReviewTokensToggle!: ToggleComponent;
	private nuclearReviewTokensInput!: TextComponent;
	private limitCleanupTokensToggle!: ToggleComponent;
	private cleanupTokensInput!: TextComponent;
	private guidanceInput?: TextAreaComponent;
	private processingModeSelect!: HTMLSelectElement;
	private dpiInput!: TextComponent;
	private maxWidthInput!: TextComponent;
	private pageRangeFromInput!: TextComponent;
	private pageRangeToInput!: TextComponent;
	private pageRangeErrorEl!: HTMLElement;
	private totalPdfPages: number = 0;
	private examplePdfPageRangeFromInput!: TextComponent;
	private examplePdfPageRangeToInput!: TextComponent;
	private examplePdfPageRangeErrorEl!: HTMLElement;
	private examplePdfTotalPages: number = 0;
	private includeTextToggle!: ToggleComponent;
	private preloadStatusEl!: HTMLElement;
	private isPreloadingImages = false;
	private preloadingPromise: Promise<void> | null = null;
	private renderedPages: Array<{
		pageNum: number;
		imageData: string;
		textContent?: string;
	}> = [];
	private extractedImages: ExtractedImage[] = [];
	private useContextToggle!: ToggleComponent;
	private contextPagesInput!: TextComponent;
	private contextPagesContainer!: HTMLElement;
	private useFutureContextToggle!: ToggleComponent;
	private futureContextPagesInput!: TextComponent;
	private futureContextContainer!: HTMLElement;
	private useNuclearOptionToggle!: ToggleComponent;

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
				btn.setButtonText("Choose File").onClick(() =>
					this.fileInput.click()
				);
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

		this.preloadStatusEl = this.contentEl.createDiv({
			cls: "gn-processing-status",
			attr: { style: "display: none;" },
		});

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

		this.setupContextControlSection();

		this.setupTokenLimitSection();

		this.setupNuclearOptionSection();

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
				toggle.setValue(false).onChange(() => {
					this.updateTokenControlVisibility();
					this.costUi?.update();
				});
			});

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(
			costContainer,
			async () => {
				const isHybridMode =
					this.processingModeSelect.value === "hybrid";
				const pageCount = this.getEstimatedPageCount();
				const textContentTokens = countTextTokens(this.extractedText);
				const guidance = this.guidanceInput?.getValue() || "";
				const useNuclearOption =
					this.useNuclearOptionToggle?.getValue() || false;

				let mainPromptText: string;
				let mainImageCount: number;
				const mainDetails: {
					textContentTokens: number;
					isHybrid: boolean;
					pageCount?: number;
					useNuclearOption: boolean;
					nuclearMultiplier?: number;
				} = {
					textContentTokens,
					isHybrid: isHybridMode,
					pageCount: isHybridMode ? pageCount : undefined,
					useNuclearOption,
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
						const estimatedHybridOutput = pageCount * 1000; // rough estimate of tokens per page

						// Build a sample cleanup prompt for cost estimation
						const sampleCleanupPrompt =
							this.buildReconstructionPrompt(
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

				// Nuclear option multiplier
				let finalPromptText = mainPromptText;
				let finalImageCount = mainImageCount;

				if (useNuclearOption) {
					// Nuclear option adds 2 passes:
					// 1. Initial processing (existing cost)
					// 2. Validation pass (small)
					// 3. Deduplication pass (medium)
					// 4. Final review pass (large)
					const estimatedNuclearMultiplier = 2.5; // Conservative estimate for 2-phase

					// Simulate additional processing cost
					finalPromptText = mainPromptText.repeat(
						Math.ceil(estimatedNuclearMultiplier)
					);
					finalImageCount = Math.ceil(mainImageCount * 1.2); // Images used in first pass only, plus small validation cost

					mainDetails.nuclearMultiplier = estimatedNuclearMultiplier;
				}

				return {
					promptText: finalPromptText,
					imageCount: finalImageCount,
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
						this.toggleExamplePdfModeControls();
						this.costUi?.update();
						// Image rendering will happen on-demand during Convert
					});
			});

		// Page Range (available for both text and hybrid modes)
		new Setting(modeSection)
			.setName("Page Range")
			.setDesc(
				"Specify page range to process (leave empty for all pages)"
			)
			.addText((text) => {
				this.pageRangeFromInput = text;
				text.setPlaceholder("From (e.g., 1)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validatePageRange();
					this.updateSmartDefaults();
					this.updateTextPreview();
					this.costUi?.update();
				});
			})
			.addText((text) => {
				this.pageRangeToInput = text;
				text.setPlaceholder("To (e.g., 10)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validatePageRange();
					this.updateSmartDefaults();
					this.updateTextPreview();
					this.costUi?.update();
				});
			});

		// Add error display for page range validation
		this.pageRangeErrorEl = modeSection.createDiv({
			attr: { style: "color: var(--color-red); font-size: 0.9em; margin-top: 5px; display: none;" }
		});

		const hybridControls = modeSection.createDiv({
			cls: "gn-hybrid-controls",
			attr: {
				style: "display: none; margin-top: 10px; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 5px;",
			},
		});

		hybridControls.createEl("h5", { text: "Hybrid Mode Settings" });

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

	private toggleExamplePdfModeControls(): void {
		const isMainHybrid = this.processingModeSelect.value === "hybrid";
		const hasExamplePdf = this.examplePdfFile !== null;

		// Only show example PDF mode controls if:
		// 1. Main PDF is in hybrid mode (so we have a choice)
		// 2. An example PDF has been selected
		if (isMainHybrid && hasExamplePdf) {
			this.examplePdfModeContainer.style.display = "block";
			// Update available options based on main PDF mode
			this.examplePdfModeSelect.innerHTML = `
				<option value="text">Text-only</option>
				<option value="hybrid">Hybrid (Text + Images)</option>
			`;
			// Process example PDF if switching to hybrid mode
			this.processExamplePdf();
		} else if (hasExamplePdf) {
			// If main PDF is text-only, hide the dropdown (text-only is implied)
			this.examplePdfModeContainer.style.display = "none";
			// Clear processed pages since we're not using hybrid mode
			this.examplePdfPages = [];
		} else {
			// No example PDF selected, hide controls
			this.examplePdfModeContainer.style.display = "none";
		}
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

			// Image rendering will happen on-demand during Convert if needed
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			this.pdfViewer.setText(`Error processing PDF: ${errorMessage}`);
			console.error("PDF processing error:", error);
		}
	}

	// Removed preloadPdfImages - images are now rendered on-demand during Convert

	private async extractTextFromPdf(file: File): Promise<void> {
		try {
			const pdfjsLib = await this.loadPdfJs();
			const typedArray = new Uint8Array(await file.arrayBuffer());
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			// Store total pages for validation
			this.totalPdfPages = pdf.numPages;

			// Respect page range for text extraction too
			const fromPage = parseInt(this.pageRangeFromInput?.getValue() || "1");
			const toPage = parseInt(this.pageRangeToInput?.getValue() || pdf.numPages.toString());

			let fullText = "";
			for (let i = Math.max(1, fromPage); i <= Math.min(pdf.numPages, toPage); i++) {
				const page = await pdf.getPage(i);

				// 1) Ask for marked content & let pdf.js pre-combine glyphs
				const textContent = await page.getTextContent({
					includeMarkedContent: true,
					disableCombineTextItems: false,
				});

				const pageText = this.extractBlocksFromReadingOrder(
					textContent.items
				);
				fullText += `\n\n--- PAGE ${i} ---\n\n` + pageText + "\n";
			}

			this.extractedText = fullText;
			console.log("fullText:",fullText);

			this.pdfViewer.empty();
			const preview = this.pdfViewer.createEl("div");
			const actualFrom = Math.max(1, fromPage);
			const actualTo = Math.min(pdf.numPages, toPage);
			const pageRangeText = actualFrom === actualTo 
				? `page ${actualFrom}` 
				: `pages ${actualFrom}-${actualTo}`;
			preview.createEl("p", {
				text: `✅ PDF processed: ${file.name} (${pageRangeText} of ${pdf.numPages} total)`,
			});
			const textPreview = preview.createEl("pre", {
				attr: {
					style: "max-height: 150px; overflow-y: auto; font-size: 12px; background: var(--background-secondary); padding: 10px;",
				},
			});
			textPreview.setText(fullText.substring(0, 500) + "...");

			// Trigger validation and smart defaults now that we know the total pages
			this.validatePageRange();
			this.updateSmartDefaults();
		} catch (error) {
			throw new Error(`Failed to extract text: ${error}`);
		}
	}

	/**
	 * Build cohesive blocks following pdf.js “selection” order
	 * (with includeMarkedContent), preserving intra-region flow.
	 * We split into lines, then split into blocks when the flow
	 * clearly jumps (new column/callout) or on explicit separators.
	 */
	private extractBlocksFromReadingOrder(items: any[]): string {
		type T = {
			str: string;
			x: number;
			y: number;
			w: number;
			h: number;
			font?: string;
			hasEOL?: boolean;
		};

		const textItems: T[] = items
			.filter((it) => typeof it.str === "string")
			.map((it) => ({
				str: it.str,
				x: it.transform[4],
				y: it.transform[5],
				w: it.width ?? 0,
				h: it.height ?? 0,
				font: it.fontName,
				hasEOL: !!it.hasEOL,
			}));

		if (!textItems.length) return "";

		// --- Step 1: turn items into "lines" (based on Y proximity) ---
		const yTol = 2.5; // same line if |Δy| <= yTol
		const xGapJoin = 8; // insert space if glyph gap is small (heuristic)

		const lines: { y: number; x0: number; text: string; font?: string }[] =
			[];
		let curLine: T[] = [];

		const flushLine = () => {
			if (!curLine.length) return;
			// sort a line by X, then join with spaces where gaps are reasonable
			curLine.sort((a, b) => a.x - b.x);
			let line = "";
			for (let i = 0; i < curLine.length; i++) {
				const t = curLine[i];
				if (i > 0) {
					const prev = curLine[i - 1];
					const gap = t.x - (prev.x + prev.w);
					if (gap > 0 && gap < xGapJoin) line += " ";
					else if (gap >= xGapJoin) line += " ";
				}
				line += t.str;
			}
			const yAvg = curLine.reduce((s, t) => s + t.y, 0) / curLine.length;
			const xMin = Math.min(...curLine.map((t) => t.x));
			lines.push({
				y: yAvg,
				x0: xMin,
				text: line.trim(),
				font: curLine[0].font,
			});
			curLine = [];
		};

		let prevY = textItems[0].y;
		for (const t of textItems) {
			// explicit empty + hasEOL acts like a hard line break separator
			if (t.hasEOL && t.str === "") {
				flushLine();
				// later we’ll treat this as a potential block boundary
				lines.push({
					y: Number.NaN,
					x0: 0,
					text: "\uE000_EOL_SPLIT\uE000",
				});
				prevY = t.y;
				continue;
			}

			if (!curLine.length) {
				curLine.push(t);
				prevY = t.y;
				continue;
			}

			// same line if Y is very close
			if (Math.abs(t.y - prevY) <= yTol) {
				curLine.push(t);
				prevY = t.y;
			} else {
				flushLine();
				curLine.push(t);
				prevY = t.y;
			}
		}
		flushLine();

		// --- Step 2: group lines into "blocks" (paragraphs/regions) ---
		// Heuristics:
		//  • start a new block if we see the explicit EOL_SPLIT sentinel
		//  • or Y goes *upward* significantly vs previous line (selection jumped)
		//  • or big X reset while Y is similar (moved to another text box)
		//  • or font-size family changes drastically (often headings/callouts)
		const blocks: string[] = [];
		const block: string[] = [];

		const newBlock = () => {
			const txt = block
				.join("\n")
				.replace(/\n{2,}/g, "\n")
				.trim();
			if (txt) blocks.push(txt);
			block.length = 0;
		};

		const yJumpUp = 18; // selection jumped higher on the page
		const xReset = 80; // moved to a distant left start
		const headingFontHint = (f?: string) => f && /_f1\b|_f3\b/.test(f); // tune per doc

		for (let i = 0; i < lines.length; i++) {
			const L = lines[i];
			if (L.text === "\uE000_EOL_SPLIT\uE000") {
				newBlock();
				continue;
			}

			const P = i > 0 ? lines[i - 1] : undefined;

			let boundary = false;
			if (P && isFinite(P.y) && isFinite(L.y)) {
				if (L.y - P.y > yJumpUp) boundary = true; // jumped upward
				if (
					!boundary &&
					Math.abs(L.y - P.y) <= yTol &&
					P.x0 - L.x0 > xReset
				)
					boundary = true; // big left reset at similar Y
			}

			if (!boundary && headingFontHint(L.font)) boundary = true;

			if (boundary) newBlock();
			block.push(L.text);
		}
		newBlock();

		return blocks.join("\n\n");
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
		// Use marked content order (proper reading order) instead of spatial heuristics
		return items
			.filter((item: any) => item.str && typeof item.str === 'string' && item.str.trim())
			.map((item: any) => item.str)
			.join('')
			.trim();
	}

	/**
	 * Improved text extraction that handles multi-column layouts by detecting columns
	 * and reading each column top-to-bottom before moving to the next column.
	 */
	private extractTextWithColumnAwareness(items: any[]): string {
		if (!items || items.length === 0) return "";

		// Define text item type
		type TextItem = {
			str: string;
			x: number;
			y: number;
			width: number;
			height: number;
		};

		const textItems: TextItem[] = items
			.filter((item) => item.str && item.str.trim())
			.map((item) => ({
				str: item.str,
				x: item.transform[4], // x coordinate
				y: item.transform[5], // y coordinate
				width: item.width || 0,
				height: item.height || 0,
			}));

		if (textItems.length === 0) return "";

		// Step 1: Detect columns by analyzing X-coordinate distribution
		const columns = this.detectColumns(textItems);

		// Step 2: Assign each text item to its appropriate column
		const columnTexts: string[] = [];

		for (const column of columns) {
			// Get all text items that belong to this column
			const columnItems = textItems.filter(
				(item) => item.x >= column.left && item.x <= column.right
			);

			// Sort by Y coordinate (top to bottom)
			columnItems.sort((a, b) => b.y - a.y); // Higher Y = top of page

			// Group into lines based on Y proximity
			const lines = this.groupIntoLines(columnItems);

			// Convert to text
			const columnText = lines
				.map((line) => line.join(" ").trim())
				.filter((text) => text)
				.join("\n");

			if (columnText) {
				columnTexts.push(columnText);
			}
		}

		return columnTexts.join("\n\n");
	}

	/**
	 * Detects column boundaries based on X-coordinate clustering
	 */
	private detectColumns(
		items: Array<{
			str: string;
			x: number;
			y: number;
			width: number;
			height: number;
		}>
	): Array<{ left: number; right: number; center: number }> {
		if (items.length === 0) return [];

		// Get all X coordinates
		const xCoords = items.map((item) => item.x).sort((a, b) => a - b);

		// Find clusters of X coordinates (potential column starts)
		const clusters: number[][] = [];
		const clusterTolerance = 30; // Items within 30 units are same column

		for (const x of xCoords) {
			// Find existing cluster this X belongs to
			let foundCluster = clusters.find((cluster) =>
				cluster.some(
					(clusterX) => Math.abs(x - clusterX) <= clusterTolerance
				)
			);

			if (foundCluster) {
				foundCluster.push(x);
			} else {
				clusters.push([x]);
			}
		}

		// Convert clusters to column definitions
		const columns = clusters
			.filter((cluster) => cluster.length >= 3) // Require at least 3 items to be a column
			.map((cluster) => {
				const minX = Math.min(...cluster);
				const maxX = Math.max(...cluster);

				// Expand column boundaries to capture nearby text
				const expansion = 50;

				return {
					left: minX - expansion,
					right: maxX + expansion,
					center: (minX + maxX) / 2,
				};
			})
			.sort((a, b) => a.center - b.center); // Left to right

		// If no clear columns detected, treat as single column
		if (columns.length === 0) {
			const minX = Math.min(...items.map((item) => item.x));
			const maxX = Math.max(...items.map((item) => item.x + item.width));
			return [
				{
					left: minX - 10,
					right: maxX + 10,
					center: (minX + maxX) / 2,
				},
			];
		}

		return columns;
	}

	/**
	 * Groups text items into lines based on Y-coordinate proximity
	 */
	private groupIntoLines(
		items: Array<{
			str: string;
			x: number;
			y: number;
			width: number;
			height: number;
		}>
	): string[][] {
		if (items.length === 0) return [];

		const lines: Array<
			Array<{
				str: string;
				x: number;
				y: number;
				width: number;
				height: number;
			}>
		> = [];
		const lineTolerance = 3; // Items within 3 units are on same line

		for (const item of items) {
			// Find existing line this item belongs to
			let foundLine = lines.find((line) =>
				line.some(
					(lineItem) => Math.abs(lineItem.y - item.y) <= lineTolerance
				)
			);

			if (foundLine) {
				foundLine.push(item);
			} else {
				lines.push([item]);
			}
		}

		// Sort lines by Y coordinate (top to bottom)
		lines.sort((a, b) => {
			const avgYA = a.reduce((sum, item) => sum + item.y, 0) / a.length;
			const avgYB = b.reduce((sum, item) => sum + item.y, 0) / b.length;
			return avgYB - avgYA; // Higher Y = top
		});

		// Sort items within each line by X coordinate (left to right)
		lines.forEach((line) => {
			line.sort((a, b) => a.x - b.x);
		});

		// Convert to string arrays
		return lines.map((line) => line.map((item) => item.str));
	}

	private async renderPdfPagesToImages(
		onProgress?: (message: string) => void
	): Promise<void> {
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
				onProgress?.(
					`Rendering page ${pageNum - fromPage + 1}/${
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
					const pageTextContent = await page.getTextContent({ includeMarkedContent: true });
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
		} catch (error) {
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

			// Add example PDF context if available
			if (this.examplePdfFile) {
				systemPrompt += this.buildExamplePdfContextText();
			}
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

	private buildHybridPromptWithContext(
		pageNum: number,
		textContent: string | undefined,
		previousTranscriptions: string[],
		previousTextContents: string[],
		futureTextContents: string[],
		customGuidance?: string
	): string {
		const totalContextImages =
			previousTranscriptions.length + futureTextContents.length;
		const currentImageIndex = previousTranscriptions.length + 1;

		let systemPrompt = `You are an expert document processor converting a PDF page image (with optional PDF text) into clean, well-structured Markdown. You are processing page ${pageNum} of a multi-page document.

IMAGES PROVIDED:`;

		if (previousTranscriptions.length > 0) {
			systemPrompt += `\n- Images 1-${previousTranscriptions.length}: Previous pages (for context only)`;
		}
		systemPrompt += `\n- Image ${currentImageIndex}: Current page (MAIN FOCUS - transcribe this page)`;
		if (futureTextContents.length > 0) {
			systemPrompt += `\n- Images ${currentImageIndex + 1}-${
				currentImageIndex + futureTextContents.length
			}: Future pages (for context only)`;
		}

		systemPrompt += `

INSTRUCTIONS:
- Only transcribe content from the current page (Image ${currentImageIndex})
- Use context images and data to:
  - Continue mid-sentence/paragraph flows from previous pages
  - Avoid repeating headers/footers that appear across pages
  - See where content is heading to make better structural decisions
  - Maintain consistent formatting and structure throughout
- Do NOT transcribe content from context images (previous or future pages)

Follow these rules strictly:
1. **Headers**: Convert section titles into markdown headers ("# Header", "## Subheader", etc.). Skip repeated headers from previous pages.
2. **Paragraphs**: If a paragraph continues from the previous page, continue it seamlessly. Merge consecutive lines into complete paragraphs.
3. **Footnotes**: If footnote citations and text appear on the same page, inline them in parentheses.
4. **Figures & Tables**: Use ![IMAGE_PLACEHOLDER] for figures or recreate tables in markdown. Include captions below.
5. **Mathematics**: Format all mathematical notation using LaTeX delimiters ("$" for inline, "$$" for block).
6. **Image is authoritative**: If PDF text conflicts with the image, trust the image. Mark illegible content as [[ILLEGIBLE]].
7. **Output**: ONLY the final Markdown text. No code fences or commentary.`;

		if (this.exampleNoteContent.trim()) {
			systemPrompt += `\n\nUse this structural template (but don't follow it too literally if the content doesn't match):\n${this.exampleNoteContent}`;

			// Add example PDF context if available
			if (this.examplePdfFile) {
				systemPrompt += this.buildExamplePdfContextText();
			}
		}

		let userPrompt = `You are processing page ${pageNum} of a multi-page document.`;

		if (previousTranscriptions.length > 0) {
			userPrompt += `\n\nPREVIOUS PAGE DATA (for context only):\n`;
			previousTranscriptions.forEach((transcription, index) => {
				const pageIndex =
					pageNum - previousTranscriptions.length + index;
				userPrompt += `--- PAGE ${pageIndex} TRANSCRIPTION ---\n${transcription}\n\n`;
				if (previousTextContents[index]) {
					userPrompt += `--- PAGE ${pageIndex} PDF TEXT ---\n${previousTextContents[index]}\n\n`;
				}
			});
		}

		if (futureTextContents.length > 0) {
			userPrompt += `\n\nFUTURE PAGE DATA (for context only):\n`;
			futureTextContents.forEach((textContent, index) => {
				const pageIndex = pageNum + index + 1;
				userPrompt += `--- PAGE ${pageIndex} PDF TEXT ---\n${textContent}\n\n`;
			});
		}

		const contextDescription = [];
		if (previousTranscriptions.length > 0) {
			contextDescription.push("continuing from previous content");
		}
		if (futureTextContents.length > 0) {
			contextDescription.push("with awareness of upcoming content");
		}

		if (contextDescription.length > 0) {
			userPrompt += `\nNow transcribe the current page (page ${pageNum}) ${contextDescription.join(
				" and "
			)}.`;
		} else {
			userPrompt += `\nTranscribe this page ${pageNum} to markdown.`;
		}

		if (customGuidance) {
			userPrompt += `\n\n**User's Custom Instructions:**\n${customGuidance}`;
		}

		if (textContent && textContent.trim()) {
			userPrompt += `\n\nCURRENT PAGE PDF TEXT CONTENT (may have layout issues; use current page IMAGE as ground truth):\n${textContent}`;
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

	// === NEW COMPREHENSIVE PDF PROCESSING METHODS ===

	private hashContent(content: string): string {
		// Simple hash function for content deduplication
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(16);
	}

	private extractBoundaryContent(
		transcription: string,
		type: "end" | "start",
		sentences: number = 2
	): string {
		const clean = transcription.replace(/#+\s+.*/g, "").trim();
		const paragraphs = clean
			.split(/\n\s*\n/)
			.filter((p) => p.trim().length > 20);

		if (paragraphs.length === 0) return "";

		if (type === "end") {
			const lastParagraph = paragraphs[paragraphs.length - 1];
			const sents = lastParagraph
				.split(/[.!?]+/)
				.filter((s) => s.trim().length > 10);
			return sents.slice(-sentences).join(". ").trim();
		} else {
			const firstParagraph = paragraphs[0];
			const sents = firstParagraph
				.split(/[.!?]+/)
				.filter((s) => s.trim().length > 10);
			return sents.slice(0, sentences).join(". ").trim();
		}
	}

	private extractStructuralInfo(transcription: string): {
		headers: string[];
		topics: string[];
	} {
		const headers = Array.from(transcription.matchAll(/^#+\s+(.+)$/gm)).map(
			(m) => m[1]
		);
		const topics = headers.map((h) =>
			h.replace(/^\d+\.?\s*/, "").toLowerCase()
		);
		return { headers, topics };
	}

	private buildMinimalContextPrompt(
		pageNum: number,
		textContent: string,
		previousBoundary?: string,
		previousStructure?: { headers: string[]; topics: string[] },
		futurePreview?: string,
		alreadyTranscribedHashes?: Set<string>,
		customGuidance?: string
	): string {
		const systemPrompt = `You are an expert document processor converting a PDF page image into clean, well-structured Markdown. You are processing page ${pageNum} of a multi-page document.

<XML_INSTRUCTIONS>
<CORE_TASK>
- ONLY transcribe content visible on the current page image
- Use provided context ONLY to maintain continuity and avoid repetition
- Output ONLY the final Markdown text (no code fences or commentary)
</CORE_TASK>

<CONTEXT_USAGE>
${
	previousBoundary
		? `<PREVIOUS_BOUNDARY>Last sentences from previous page: "${previousBoundary}"</PREVIOUS_BOUNDARY>`
		: ""
}
${
	previousStructure?.headers.length
		? `<PREVIOUS_HEADERS>${previousStructure.headers.join(
				", "
		  )}</PREVIOUS_HEADERS>`
		: ""
}
${
	futurePreview
		? `<FUTURE_PREVIEW>Upcoming content hint: "${futurePreview}"</FUTURE_PREVIEW>`
		: ""
}
${
	alreadyTranscribedHashes?.size
		? `<AVOID_REPETITION>Do not repeat previously processed content</AVOID_REPETITION>`
		: ""
}
</CONTEXT_USAGE>

<FORMATTING_RULES>
1. **Headers**: Convert to markdown headers. Skip if already covered in previous pages
2. **Paragraphs**: Continue mid-sentence flows seamlessly from previous boundary
3. **Figures**: Use ![IMAGE_PLACEHOLDER] with captions
4. **Math**: Use LaTeX notation ($inline$ and $$block$$)
5. **Tables**: Recreate in markdown format
6. **Citations**: Inline footnotes in parentheses when possible
</FORMATTING_RULES>

<ANTI_PATTERNS>
❌ Do NOT repeat headers/sections from previous pages
❌ Do NOT transcribe content from context images
❌ Do NOT start new paragraphs if continuing from previous page
❌ Do NOT include page numbers or footers
</ANTI_PATTERNS>
</XML_INSTRUCTIONS>`;

		let userPrompt = `<CURRENT_PAGE>
Process page ${pageNum} following the XML instructions above.`;

		if (customGuidance) {
			userPrompt += `\n\n<CUSTOM_GUIDANCE>${customGuidance}</CUSTOM_GUIDANCE>`;
		}

		if (textContent?.trim()) {
			userPrompt += `\n\n<PDF_TEXT_REFERENCE>
The following is extracted PDF text (may have layout issues - use the IMAGE as ground truth):
${textContent}
</PDF_TEXT_REFERENCE>`;
		}

		userPrompt += "\n</CURRENT_PAGE>";

		// Add example note template if available
		let finalSystemPrompt = systemPrompt;
		if (this.exampleNoteContent.trim()) {
			finalSystemPrompt += `\n\nUse this structural template (but don't follow it too literally if the content doesn't match):\n${this.exampleNoteContent}`;

			// Add example PDF context if available
			if (this.examplePdfFile) {
				finalSystemPrompt += this.buildExamplePdfContextText();
			}
		}

		return finalSystemPrompt + "\n\n" + userPrompt;
	}

	private buildImageArrayForLlm(
		currentPageImage: string,
		contextImages: string[] = [],
		futureContextImages: string[] = []
	): string[] {
		// Order: context images, current page, example PDF images, future context images
		const images = [...contextImages, currentPageImage];

		// Add example PDF images if available and in hybrid mode
		if (
			this.examplePdfPages.length > 0 &&
			this.examplePdfFile &&
			this.examplePdfModeSelect.value === "hybrid"
		) {
			// Add example PDF images after current page but before future context
			for (const examplePage of this.examplePdfPages) {
				images.push(examplePage.imageData);
			}
		}

		// Add future context images at the end
		images.push(...futureContextImages);

		return images;
	}

	private buildExamplePdfContextText(): string {
		if (!this.examplePdfFile || this.examplePdfPages.length === 0) {
			return "";
		}

		const exampleMode = this.examplePdfModeSelect.value;
		const hasImages =
			exampleMode === "hybrid" &&
			this.processingModeSelect.value === "hybrid";

		let contextText = "";

		if (hasImages) {
			contextText += `\n\nFor additional context on the expected format and style, refer to the ${this.examplePdfPages.length} example page image(s) from the corresponding PDF that produced the above template. These example pages are provided after the current page image.`;
		} else {
			contextText += `\n\nFor additional context on the expected format and style, refer to the corresponding PDF that produced the above template (text-only mode).`;
		}

		// Add text content from example PDF pages if available
		const hasTextContent = this.examplePdfPages.some(
			(page) => page.textContent && page.textContent.trim()
		);
		if (hasTextContent) {
			contextText += `\n\nEXAMPLE PDF TEXT CONTENT (for reference):`;
			for (const page of this.examplePdfPages) {
				if (page.textContent && page.textContent.trim()) {
					contextText += `\n--- EXAMPLE PAGE ${page.pageNum} ---\n${page.textContent}\n`;
				}
			}
		}

		return contextText;
	}

	private buildValidationPrompt(
		pageContent: string,
		previousContent: string,
		pageNum: number
	): string {
		return `You are a document validation AI. Check if this page content has any issues:

**Previous page content (last 200 chars):**
${previousContent.slice(-200)}

**Current page content:**
${pageContent}

**Check for these issues:**
1. Repeated headers/sections from previous page
2. Missing connection between pages (abrupt start)
3. Incomplete sentences or paragraphs
4. Content that seems out of sequence

Respond with either:
- "VALID" if no issues found
- "ISSUES: [specific problems found]"`;
	}

	private buildDeduplicationPrompt(allContent: string): string {
		return `You are a content deduplication expert. This document was processed page-by-page and has repetitive sections.

**Your tasks:**
1. Identify and remove duplicate headers, paragraphs, or sections
2. Merge content that was artificially split across pages
3. Ensure narrative flow is preserved
4. Keep all unique content and proper structure

**Content to clean:**
${allContent}

Return ONLY the cleaned markdown text.`;
	}

	private buildNuclearReviewPrompt(
		content: string,
		originalPdfText: string
	): string {
		return `You are performing a final comprehensive review of a PDF-to-markdown conversion. This is the "nuclear option" review - be extremely thorough.

**Original PDF Text Reference:**
\`\`\`
${originalPdfText}
\`\`\`

**Current Markdown:**
\`\`\`markdown
${content}
\`\`\`

**Comprehensive Review Tasks:**
1. **Completeness**: Ensure no significant content is missing compared to PDF text
2. **Structure**: Verify logical flow and proper markdown formatting
3. **Deduplication**: Remove any remaining duplicate content
4. **Continuity**: Fix paragraph breaks and sentence fragments
5. **Formatting**: Perfect headers, lists, math notation, and figures
6. **Quality**: Improve readability while preserving accuracy

Return ONLY the final, perfected markdown text.`;
	}

	private async processPagesWithNuclearOption(
		notice: Notice
	): Promise<{ response: string; usage?: OpenAI.CompletionUsage }> {
		const guidance = this.guidanceInput?.getValue() || "";
		// Always run full 2-phase when enabled (no partial phases)
		const maxPhase = 2;

		const totalUsage: OpenAI.CompletionUsage = {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		const addToTotalUsage = (usage?: OpenAI.CompletionUsage) => {
			if (usage) {
				totalUsage.prompt_tokens += usage.prompt_tokens;
				totalUsage.completion_tokens += usage.completion_tokens;
				totalUsage.total_tokens += usage.total_tokens;
			}
		};

		// Phase 1: Process each page with multimodal (page image + marked content text)
		const phase1Pages: Array<{ page: number; markdown: string }> = [];
		
		for (let i = 0; i < this.renderedPages.length; i++) {
			const pageData = this.renderedPages[i];
			notice.setMessage(
				`🎯 Nuclear Phase 1: Processing page ${i + 1}/${
					this.renderedPages.length
				} (multimodal)...`
			);

			const result = await this.runPhase1PerPage(
				pageData.imageData,
				pageData.textContent || "",
				guidance
			);
			addToTotalUsage(result.usage);

			phase1Pages.push({
				page: pageData.pageNum,
				markdown: result.content || ""
			});
		}

		// Early return if stopping after Phase 1
		if (maxPhase <= 1) {
			notice.setMessage(`✅ Nuclear processing complete (Phase 1 only)!`);
			return {
				response: phase1Pages.map(p => p.markdown).join("\n\n"),
				usage: totalUsage,
			};
		}

		// Phase 2: Final reconciliation pass
		notice.setMessage(`⚡ Nuclear Phase 2: Final reconciliation...`);
		
		// Get full marked content text for all pages
		const fullMarkedText = await this.getFullMarkedText();
		
		const finalResult = await this.runPhase2Final({
			guidance,
			phase1Pages,
			fullMarkedText,
			titleHint: this.selectedFile?.name.replace(/\.[^.]+$/, "") || "Document"
		});
		addToTotalUsage(finalResult.usage);

		notice.setMessage(`✅ Nuclear processing complete!`);
		return { response: finalResult.content || "", usage: totalUsage };
	}

	/**
	 * Phase 1: Process a single page with multimodal (image + marked content text)
	 */
	private async runPhase1PerPage(
		pageImageDataUrl: string,
		pageMarkedText: string,
		guidance: string
	): Promise<{ content: string; usage?: OpenAI.CompletionUsage }> {
		const systemPrompt = `You convert a single PDF page into clean markdown. ${guidance}

Guidelines:
- Convert this page to clean markdown preserving structure and meaning
- Use ![IMAGE_PLACEHOLDER] for figures, tables, charts, and infographics
- Keep callouts and sidebars as block quotes or formatted sections
- Preserve headings and subheadings with appropriate markdown levels
- Do not include page numbers, headers, or footers
- Focus on the substantive content of this page only`;

		const userPrompt = `Here is this page's text content (in proper reading order):\n\n${pageMarkedText}\n\nNow produce clean markdown for this page, using the page image for visual context and structure:`;
		const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

		const maxTokens = this.getMaxTokensForMainProcessing();
		return await this.plugin.sendToLlm(
			fullPrompt,
			pageImageDataUrl,
			maxTokens ? { maxTokens } : {}
		);
	}

	/**
	 * Get concatenated marked content text for the whole PDF (no page breaks)
	 */
	private async getFullMarkedText(): Promise<string> {
		if (!this.selectedFile) {
			return "";
		}

		const pdfjsLib = await this.loadPdfJs();
		const typedArray = new Uint8Array(await this.selectedFile.arrayBuffer());
		const pdf = await pdfjsLib.getDocument(typedArray).promise;

		const chunks: string[] = [];
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const textContent = await page.getTextContent({ includeMarkedContent: true });
			
			// Join items in the order PDF.js provides (marked content order)
			const pageText = textContent.items
				.filter((item: any) => item.str && typeof item.str === 'string' && item.str.trim())
				.map((item: any) => item.str)
				.join('')
				.trim();
			
			if (pageText) {
				chunks.push(pageText);
			}
		}
		
		// Join with double newlines (light page separation)
		return chunks.join('\n\n');
	}

	/**
	 * Phase 2: Final reconciliation pass that sees everything
	 */
	private async runPhase2Final(inputs: {
		guidance: string;
		phase1Pages: Array<{ page: number; markdown: string }>;
		fullMarkedText: string;
		titleHint: string;
	}): Promise<{ content: string; usage?: OpenAI.CompletionUsage }> {
		const { guidance, phase1Pages, fullMarkedText, titleHint } = inputs;

		const systemPrompt = `You are producing the FINAL single markdown note from a PDF document.
${guidance}

Rules:
- Output a single cohesive markdown document (no page headers or breaks)
- Reorder content logically if needed (titles → body → sidebars/callouts)  
- Keep callouts/biographies as intact blocks (use blockquotes or formatted sections)
- Use ![IMAGE_PLACEHOLDER] exactly where figures/tables/infographics belong
- Do not include headers/footers/page numbers or navigational elements
- Do not include "See also" sections or similar boilerplate
- Do not invent content - stick to what's in the source material
- Prefer exact quotes when appropriate, especially for important statements
- Ensure all substantive textual content from SOURCE_TEXT appears somewhere in the final note
- The page drafts may be incomplete or mis-ordered - use them as helpful hints but rely on SOURCE_TEXT for completeness`;

		// Prepare the user content
		const userParts: string[] = [];
		
		if (titleHint) {
			userParts.push(`# ${titleHint}\n`);
		}
		
		userParts.push(`## SOURCE_TEXT (marked-content, all pages, proper reading order)\n${fullMarkedText}`);
		
		userParts.push(`## PAGE_DRAFTS (Phase 1 outputs; may be incomplete or mis-ordered)\n${
			phase1Pages
				.sort((a, b) => a.page - b.page)
				.map(p => `### Page ${p.page}\n${p.markdown}`)
				.join('\n\n')
		}`);

		const fullPrompt = `${systemPrompt}\n\n${userParts.join('\n\n')}`;

		const maxTokens = this.getMaxTokensForNuclearReview(fullMarkedText.length);
		return await this.plugin.sendToLlm(
			fullPrompt,
			undefined,
			maxTokens ? { maxTokens } : {}
		);
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

		// Validate example note integration
		if (this.exampleNotePath && !this.exampleNoteContent.trim()) {
			new Notice(
				"Example note is still loading. Please wait a moment and try again."
			);
			this.plugin.logger(
				LogLevel.NORMAL,
				"Conversion blocked - example note still loading",
				{
					notePath: this.exampleNotePath,
					contentLength: this.exampleNoteContent.length,
				}
			);
			return;
		}

		// Log example note usage status
		if (this.exampleNoteContent.trim()) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Starting conversion with example note template",
				{
					notePath: this.exampleNotePath,
					contentLength: this.exampleNoteContent.length,
					preview: this.exampleNoteContent.substring(0, 100) + "...",
				}
			);
		} else {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Starting conversion without example note template"
			);
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
		const useNuclearOption =
			this.useNuclearOptionToggle?.getValue() || false;

		let confirmMessage = `This will convert the PDF to a note using ${
			isHybridMode ? "hybrid (text + images)" : "text-only"
		} mode.\n${finalCost}`;

		if (useNuclearOption) {
			confirmMessage += `\n\n⚡ 2-PHASE APPROACH ENABLED ⚡\nThis uses 2-phase processing for maximum quality:\n• Phase 1: Per-page multimodal analysis\n• Phase 2: Final reconciliation with complete source text\n\nThis provides the highest quality output with minimal manual cleanup needed.`;
		}

		confirmMessage += "\n\nProceed?";

		if (!confirm(confirmMessage)) {
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

				const cleanupMaxTokens = this.getMaxTokensForCleanup();
				const cleanupOptions: any = {
					model: this.plugin.settings.openaiModel,
				};
				if (cleanupMaxTokens) {
					cleanupOptions.maxTokens = cleanupMaxTokens;
				}

				const cleanupResult = await this.plugin.sendToLlm(
					cleanupPrompt,
					undefined,
					cleanupOptions
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

			// Apply post-processing to fix common LLM issues
			finalResponse = this.postProcessMarkdown(finalResponse);

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

			// Extract images from PDF and show placement modal if images found
			notice.setMessage("🖼️ Extracting images from PDF...");
			this.extractedImages = await this.extractImagesFromPdf();

			this.plugin.logger(
				LogLevel.NORMAL,
				`Extracted ${this.extractedImages.length} images from PDF`
			);

			if (this.extractedImages.length > 0) {
				notice.setMessage(
					"🧩 Analyzing for image stitching opportunities..."
				);

				// Detect and stitch adjacent images
				const adjacentGroups =
					this.plugin.imageStitcher.detectAdjacentImages(
						this.extractedImages
					);
				const stitchedImages: StitchedImage[] = [];

				for (const group of adjacentGroups) {
					try {
						const stitched =
							await this.plugin.imageStitcher.stitchImages(group);
						if (stitched) {
							stitchedImages.push(stitched);
							this.plugin.logger(
								LogLevel.NORMAL,
								`Stitched ${group.length} images into composite`
							);
						}
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							"Failed to stitch image group:",
							error
						);
					}
				}

				// Combine original and stitched images
				const allImages: (ExtractedImage | StitchedImage)[] = [
					...this.extractedImages,
					...stitchedImages,
				];

				notice.hide();
				this.close();

				// Show enhanced interactive editor
				setTimeout(() => {
					// Get PDF path from selected file and page range info
					const pdfPath = this.selectedFile
						? URL.createObjectURL(this.selectedFile)
						: undefined;
					
					const pageRangeStart = parseInt(this.pageRangeFromInput?.getValue() || "1");
					const pageRangeEnd = parseInt(this.pageRangeToInput?.getValue() || "999999");

					new InteractiveEditor(
						this.app,
						this.plugin,
						finalResponse,
						allImages,
						async (editedContent) => {
							// Process placeholders and save final content
							let finalContent = editedContent;

							// Replace all placeholders with actual image markdown
							const placeholderRegex =
								/\[IMAGE_PLACEHOLDER:([^\]]+)\]/g;
							const matches = Array.from(
								editedContent.matchAll(placeholderRegex)
							);

							for (const match of matches) {
								const placeholderId = match[1];
								const imageIndex = parseInt(
									placeholderId.split("_")[2]
								);

								if (imageIndex < allImages.length) {
									const image = allImages[imageIndex];
									try {
										const imagePath =
											await this.plugin.imageManager.saveImageToVault(
												image.imageData,
												image.filename
											);
										const imageMarkdown = `![[${image.filename}]]`;
										finalContent = finalContent.replace(
											match[0],
											imageMarkdown
										);
									} catch (error) {
										this.plugin.logger(
											LogLevel.NORMAL,
											"Failed to save image:",
											error
										);
										// Keep placeholder if save fails
									}
								}
							}

							// Update the note with final content
							await this.app.vault.modify(
								newFile as TFile,
								finalContent
							);
							new Notice(
								`✅ Note created with ${allImages.length} images processed!`
							);
						},
						pdfPath, // Pass the PDF path
						pageRangeStart, // Pass the starting page
						pageRangeEnd // Pass the ending page
					).open();
				}, 100);
			} else {
				this.close();
			}
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
		if (this.isPreloadingImages && this.preloadingPromise) {
			notice.setMessage("Waiting for image preloading to finish...");
			await this.preloadingPromise;
		}

		if (this.renderedPages.length === 0) {
			await this.renderPdfPagesToImages((message) =>
				notice.setMessage(`🔄 ${message}`)
			);
		}

		if (this.renderedPages.length === 0) {
			throw new Error("No pages were rendered successfully");
		}

		// Check if nuclear option is enabled
		const useNuclearOption =
			this.useNuclearOptionToggle?.getValue() || false;
		if (useNuclearOption) {
			return await this.processPagesWithNuclearOption(notice);
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
		const processedResults: string[] = []; // Track previous page results
		const useContext = this.useContextToggle?.getValue() || false;
		const contextPageCount = useContext
			? parseInt(this.contextPagesInput?.getValue() || "1") || 1
			: 0;
		const useFutureContext =
			useContext && (this.useFutureContextToggle?.getValue() || false);
		const futureContextPageCount = useFutureContext
			? parseInt(this.futureContextPagesInput?.getValue() || "1") || 1
			: 0;

		for (let i = 0; i < this.renderedPages.length; i++) {
			const pageData = this.renderedPages[i];
			notice.setMessage(
				`🤖 Processing page ${i + 1}/${
					this.renderedPages.length
				} with AI...`
			);

			// Collect context from previous pages
			const contextImages: string[] = [];
			const contextTranscriptions: string[] = [];
			const contextTextContent: string[] = [];

			if (useContext && i > 0) {
				// Determine how many previous pages to include
				const startIdx = Math.max(0, i - contextPageCount);
				const endIdx = i;

				// Collect previous page images, transcriptions, and PDF text
				for (let j = startIdx; j < endIdx; j++) {
					contextImages.push(this.renderedPages[j].imageData);
					if (j < processedResults.length) {
						contextTranscriptions.push(processedResults[j]);
					}
					// Add PDF text content from previous page
					if (this.renderedPages[j].textContent) {
						contextTextContent.push(
							this.renderedPages[j].textContent!
						);
					}
				}
			}

			// Collect context from future pages
			const futureContextImages: string[] = [];
			const futureContextTextContent: string[] = [];

			if (useFutureContext && i < this.renderedPages.length - 1) {
				// Determine how many future pages to include
				const startIdx = i + 1;
				const endIdx = Math.min(
					this.renderedPages.length,
					i + 1 + futureContextPageCount
				);

				// Collect future page images and PDF text
				for (let j = startIdx; j < endIdx; j++) {
					futureContextImages.push(this.renderedPages[j].imageData);
					if (this.renderedPages[j].textContent) {
						futureContextTextContent.push(
							this.renderedPages[j].textContent!
						);
					}
				}
			}

			const promptText =
				useContext && (i > 0 || useFutureContext)
					? this.buildHybridPromptWithContext(
							pageData.pageNum,
							pageData.textContent,
							contextTranscriptions,
							contextTextContent,
							futureContextTextContent,
							this.guidanceInput?.getValue()
					  )
					: this.buildHybridPrompt(
							pageData.pageNum,
							pageData.textContent,
							this.guidanceInput?.getValue()
					  );

			// Include context images plus current page image plus example PDF images plus future context images
			const allImages = this.buildImageArrayForLlm(
				pageData.imageData,
				contextImages,
				futureContextImages
			);

			const maxTokens = this.getMaxTokensForMainProcessing();
			const result = await this.plugin.sendToLlm(
				promptText,
				allImages.length > 1 ? allImages : pageData.imageData,
				maxTokens ? { maxTokens } : {}
			);

			if (!result.content) {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Warning: Empty response for page ${pageData.pageNum}`
				);
				continue;
			}

			let pageContent = result.content;
			// Remove markdown code fences if present
			if (
				pageContent.match(/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/)
			) {
				pageContent = pageContent.replace(
					/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/,
					"$1"
				);
			}

			// Store the processed result for context in next pages
			processedResults.push(pageContent.trim());

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

		// Example Note Selection
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

		// Example PDF Section (only shows if example note is selected)
		const examplePdfSection = exampleSection.createDiv({
			attr: { style: "margin-top: 20px; display: none;" },
		});
		examplePdfSection.id = "example-pdf-section";

		examplePdfSection.createEl("h5", { text: "Example PDF (Optional)" });
		examplePdfSection.createEl("p", {
			text: "Upload the PDF that corresponds to your example note for better formatting guidance.",
			cls: "setting-item-description",
		});

		const examplePdfButtonContainer = examplePdfSection.createDiv({
			cls: "gn-edit-row",
		});
		const examplePdfButton = examplePdfButtonContainer.createEl("button", {
			text: "Choose Example PDF",
		});

		const examplePdfRemoveButton = examplePdfButtonContainer.createEl(
			"button",
			{
				text: "Remove",
				attr: { style: "margin-left: 10px; display: none;" },
			}
		);

		const examplePdfDisplay = examplePdfSection.createDiv({
			attr: {
				style: "margin-top: 10px; font-style: italic; color: var(--text-muted);",
			},
		});
		examplePdfDisplay.setText("No example PDF selected");

		examplePdfButton.onclick = () =>
			this.selectExamplePdf(examplePdfDisplay, examplePdfRemoveButton);
		examplePdfRemoveButton.onclick = () =>
			this.clearExamplePdf(examplePdfDisplay, examplePdfRemoveButton);

		// Example PDF Processing Mode (only shows if main PDF is hybrid mode)
		this.examplePdfModeContainer = examplePdfSection.createDiv({
			attr: { style: "margin-top: 15px; display: none;" },
		});
		this.examplePdfModeContainer.id = "example-pdf-mode-container";

		const exampleModeLabel = this.examplePdfModeContainer.createEl(
			"label",
			{
				text: "Example PDF Processing Mode:",
				attr: {
					style: "display: block; margin-bottom: 5px; font-weight: 500;",
				},
			}
		);

		this.examplePdfModeSelect =
			this.examplePdfModeContainer.createEl("select");
		this.examplePdfModeSelect.style.cssText =
			"width: 100%; padding: 5px; border-radius: 4px; border: 1px solid var(--background-modifier-border);";

		// Options will be populated dynamically based on main PDF mode
		this.examplePdfModeSelect.innerHTML = `
			<option value="text">Text-only</option>
			<option value="hybrid">Hybrid (Text + Images)</option>
		`;

		// Add event handler for when example PDF mode changes
		this.examplePdfModeSelect.onchange = () => {
			if (this.examplePdfFile) {
				this.processExamplePdf();
			}
		};

		const exampleModeDesc = this.examplePdfModeContainer.createDiv({
			text: "How to process the example PDF content.",
			attr: {
				style: "font-size: 12px; color: var(--text-muted); margin-top: 5px;",
			},
		});

		// Example PDF Page Range (only shows if example PDF mode is visible)
		const examplePageRangeContainer = this.examplePdfModeContainer.createDiv({
			attr: { style: "margin-top: 15px;" }
		});

		const examplePageRangeSetting = new Setting(examplePageRangeContainer)
			.setName("Example PDF Page Range")
			.setDesc("Specify page range for example PDF (leave empty for all pages)")
			.addText((text) => {
				this.examplePdfPageRangeFromInput = text;
				text.setPlaceholder("From (e.g., 32)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validateExamplePdfPageRange();
					this.costUi?.update();
				});
			})
			.addText((text) => {
				this.examplePdfPageRangeToInput = text;
				text.setPlaceholder("To (e.g., 33)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validateExamplePdfPageRange();
					this.costUi?.update();
				});
			});

		// Add error display for example PDF page range validation
		this.examplePdfPageRangeErrorEl = examplePageRangeContainer.createDiv({
			attr: { style: "color: var(--color-red); font-size: 0.9em; margin-top: 5px; display: none;" }
		});
	}

	private setupContextControlSection(): void {
		const contextSection = this.contentEl.createDiv();
		contextSection.createEl("h4", {
			text: "Multi-Page Context (Optional)",
		});
		contextSection.createEl("p", {
			text: "Use previous pages for context to improve continuity and reduce hallucinations. Higher values use more tokens but may produce better results.",
			cls: "setting-item-description",
		});

		new Setting(contextSection)
			.setName("Use Previous Pages for Context")
			.setDesc(
				"Include previous page images and transcriptions to maintain flow"
			)
			.addToggle((toggle) => {
				this.useContextToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.contextPagesContainer.style.display = value
						? "block"
						: "none";
					this.costUi?.update();
				});
			});

		this.contextPagesContainer = contextSection.createDiv();
		this.contextPagesContainer.style.display = "none";

		new Setting(this.contextPagesContainer)
			.setName("Previous Pages to Include")
			.setDesc(
				"Number of previous pages to include for context (1-3 recommended, or 999 for all)"
			)
			.addText((text) => {
				this.contextPagesInput = text;
				text.setPlaceholder("1")
					.setValue("1")
					.onChange(() => this.costUi?.update());
			});

		new Setting(this.contextPagesContainer)
			.setName("Include Future Pages")
			.setDesc(
				"Also include upcoming pages for even better continuity (uses more tokens)"
			)
			.addToggle((toggle) => {
				this.useFutureContextToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.futureContextContainer.style.display = value
						? "block"
						: "none";
					this.costUi?.update();
				});
			});

		this.futureContextContainer = this.contextPagesContainer.createDiv();
		this.futureContextContainer.style.display = "none";

		new Setting(this.futureContextContainer)
			.setName("Future Pages to Include")
			.setDesc(
				"Number of upcoming pages to include for context (1-2 recommended)"
			)
			.addText((text) => {
				this.futureContextPagesInput = text;
				text.setPlaceholder("1")
					.setValue("1")
					.onChange(() => this.costUi?.update());
			});
	}

	private setupTokenLimitSection(): void {
		const tokenSection = this.contentEl.createDiv();
		tokenSection.createEl("h4", { text: "Token Limits (Optional)" });
		tokenSection.createEl("p", {
			text: "Control token limits for different AI operations. Unchecked = unlimited tokens.",
			cls: "setting-item-description",
		});

		// Main Page Processing Token Limit
		const mainTokenContainer = tokenSection.createDiv();
		new Setting(mainTokenContainer)
			.setName("Limit Main Processing Tokens")
			.setDesc("Limit tokens for individual page processing")
			.addToggle((toggle) => {
				this.limitMainTokensToggle = toggle;
				toggle.setValue(true).onChange((value) => {
					this.mainTokensInput.inputEl.style.display = value
						? "block"
						: "none";
				});
			});

		new Setting(mainTokenContainer)
			.setClass("gn-token-input")
			.addText((text) => {
				this.mainTokensInput = text;
				text
					.setPlaceholder("4000")
					.setValue("4000").inputEl.style.cssText =
					"width: 100px; margin-left: 20px;";
			});



		// Phase 2 Reconciliation Token Limit (2-phase approach)
		const phase2TokenContainer = tokenSection.createDiv();
		phase2TokenContainer.style.display = "none";
		phase2TokenContainer.addClass("gn-nuclear-token-control");

		new Setting(phase2TokenContainer)
			.setName("Limit Phase 2 Reconciliation Tokens")
			.setDesc("Limit tokens for final reconciliation pass")
			.addToggle((toggle) => {
				this.limitNuclearReviewTokensToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.nuclearReviewTokensInput.inputEl.style.display = value
						? "block"
						: "none";
				});
			})
			.addText((text) => {
				this.nuclearReviewTokensInput = text;
				text
					.setPlaceholder("12000")
					.setValue("12000").inputEl.style.cssText =
					"width: 100px; margin-left: 20px; display: none;";
			});

		// Cleanup Token Limit (only show when cleanup is enabled)
		const cleanupTokenContainer = tokenSection.createDiv();
		cleanupTokenContainer.style.display = "none";
		cleanupTokenContainer.addClass("gn-cleanup-token-control");

		new Setting(cleanupTokenContainer)
			.setName("Limit Cleanup Tokens")
			.setDesc("Limit tokens for final cleanup processing")
			.addToggle((toggle) => {
				this.limitCleanupTokensToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.cleanupTokensInput.inputEl.style.display = value
						? "block"
						: "none";
				});
			});

		new Setting(cleanupTokenContainer)
			.setClass("gn-token-input")
			.addText((text) => {
				this.cleanupTokensInput = text;
				text
					.setPlaceholder("8000")
					.setValue("8000").inputEl.style.cssText =
					"width: 100px; margin-left: 20px; display: none;";
			});
	}

	private updateTokenControlVisibility(): void {
		const useNuclearOption =
			this.useNuclearOptionToggle?.getValue() || false;
		const useCleanup = this.cleanupToggleComponent?.getValue() || false;

		// Show/hide nuclear option token controls
		const nuclearControls = this.contentEl.querySelectorAll(
			".gn-nuclear-token-control"
		);
		for (const control of nuclearControls) {
			(control as HTMLElement).style.display = useNuclearOption
				? "block"
				: "none";
		}

		// Show/hide cleanup token controls
		const cleanupControls = this.contentEl.querySelectorAll(
			".gn-cleanup-token-control"
		);
		for (const control of cleanupControls) {
			(control as HTMLElement).style.display = useCleanup
				? "block"
				: "none";
		}
	}

	private getMaxTokensForMainProcessing(): number | null {
		if (!this.limitMainTokensToggle?.getValue()) return null;
		const value = parseInt(this.mainTokensInput?.getValue() || "4000");
		return isNaN(value) ? 4000 : value;
	}


	private getMaxTokensForNuclearReview(contentLength: number): number | null {
		if (!this.limitNuclearReviewTokensToggle?.getValue()) return null;
		const inputValue = parseInt(
			this.nuclearReviewTokensInput?.getValue() || "12000"
		);
		const defaultValue = Math.max(12000, contentLength);
		return isNaN(inputValue) ? defaultValue : inputValue;
	}

	private getMaxTokensForCleanup(): number | null {
		if (!this.limitCleanupTokensToggle?.getValue()) return null;
		const value = parseInt(this.cleanupTokensInput?.getValue() || "8000");
		return isNaN(value) ? 8000 : value;
	}

	/**
	 * Validate page range inputs and show errors if invalid
	 */
	private validatePageRange(): boolean {
		if (this.totalPdfPages === 0) {
			// No PDF loaded yet, skip validation
			this.pageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromValue = this.pageRangeFromInput?.getValue()?.trim() || "";
		const toValue = this.pageRangeToInput?.getValue()?.trim() || "";

		// If both empty, it's valid (means all pages)
		if (!fromValue && !toValue) {
			this.pageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromPage = parseInt(fromValue) || 1;
		const toPage = parseInt(toValue) || this.totalPdfPages;

		let errorMessage = "";

		// Validate from page
		if (fromPage < 1) {
			errorMessage = "Start page must be 1 or greater";
		} else if (fromPage > this.totalPdfPages) {
			errorMessage = `Start page cannot exceed ${this.totalPdfPages}`;
		} 
		// Validate to page
		else if (toPage < 1) {
			errorMessage = "End page must be 1 or greater";
		} else if (toPage > this.totalPdfPages) {
			errorMessage = `End page cannot exceed ${this.totalPdfPages}`;
		}
		// Validate range order
		else if (fromPage > toPage) {
			errorMessage = "Start page cannot be greater than end page";
		}

		if (errorMessage) {
			this.pageRangeErrorEl.textContent = errorMessage;
			this.pageRangeErrorEl.style.display = "block";
			return false;
		} else {
			this.pageRangeErrorEl.style.display = "none";
			return true;
		}
	}

	/**
	 * Validate example PDF page range inputs and show errors if invalid
	 */
	private validateExamplePdfPageRange(): boolean {
		if (this.examplePdfTotalPages === 0) {
			// No example PDF loaded yet, skip validation
			this.examplePdfPageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromValue = this.examplePdfPageRangeFromInput?.getValue()?.trim() || "";
		const toValue = this.examplePdfPageRangeToInput?.getValue()?.trim() || "";

		// If both empty, it's valid (means all pages)
		if (!fromValue && !toValue) {
			this.examplePdfPageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromPage = parseInt(fromValue) || 1;
		const toPage = parseInt(toValue) || this.examplePdfTotalPages;

		let errorMessage = "";

		// Validate from page
		if (fromPage < 1) {
			errorMessage = "Start page must be 1 or greater";
		} else if (fromPage > this.examplePdfTotalPages) {
			errorMessage = `Start page cannot exceed ${this.examplePdfTotalPages}`;
		} 
		// Validate to page
		else if (toPage < 1) {
			errorMessage = "End page must be 1 or greater";
		} else if (toPage > this.examplePdfTotalPages) {
			errorMessage = `End page cannot exceed ${this.examplePdfTotalPages}`;
		}
		// Validate range order
		else if (fromPage > toPage) {
			errorMessage = "Start page cannot be greater than end page";
		}

		if (errorMessage) {
			this.examplePdfPageRangeErrorEl.textContent = errorMessage;
			this.examplePdfPageRangeErrorEl.style.display = "block";
			return false;
		} else {
			this.examplePdfPageRangeErrorEl.style.display = "none";
			return true;
		}
	}

	/**
	 * Get the actual selected page range as numbers
	 */
	private getSelectedPageRange(): { from: number; to: number; count: number } {
		const fromValue = this.pageRangeFromInput?.getValue()?.trim() || "";
		const toValue = this.pageRangeToInput?.getValue()?.trim() || "";

		const fromPage = parseInt(fromValue) || 1;
		const toPage = parseInt(toValue) || this.totalPdfPages || 1;

		const actualFrom = Math.max(1, fromPage);
		const actualTo = Math.min(this.totalPdfPages || 1, toPage);
		const count = Math.max(0, actualTo - actualFrom + 1);

		return { from: actualFrom, to: actualTo, count };
	}

	/**
	 * Update smart defaults for 2-phase approach based on selected page count
	 */
	private updateSmartDefaults(): void {
		if (!this.useNuclearOptionToggle) return;

		const { count } = this.getSelectedPageRange();
		const shouldEnable2Phase = count >= 2;
		
		// Only auto-change if user hasn't manually overridden
		// (We could track this with a flag if needed, for now just set the smart default)
		if (count === 1 && this.useNuclearOptionToggle.getValue()) {
			// Don't auto-disable if user explicitly enabled it
			return;
		}
		
		this.useNuclearOptionToggle.setValue(shouldEnable2Phase);
		
		// Update visibility of related controls
		this.updateTokenControlVisibility();
	}

	/**
	 * Update text preview based on current page range
	 */
	private updateTextPreview(): void {
		if (this.selectedFile && this.validatePageRange()) {
			// Refresh text extraction for the new page range
			this.extractTextFromPdf(this.selectedFile).catch(error => {
				console.error("Failed to update text preview:", error);
			});
			
			// Clear preloaded images so they get refreshed for new page range
			if (this.renderedPages.length > 0) {
				this.renderedPages = [];
				// Reset preloading status
				this.isPreloadingImages = false;
				this.preloadingPromise = null;
			}
		}
	}

	private setupNuclearOptionSection(): void {
		const nuclearSection = this.contentEl.createDiv();
		nuclearSection.createEl("h4", {
			text: "⚡ 2-Phase Approach (Maximum Quality)",
		});

		const nuclearWarning = nuclearSection.createEl("div", {
			attr: {
				style: "background: var(--background-modifier-error); border: 1px solid var(--color-red); border-radius: 4px; padding: 12px; margin: 10px 0;",
			},
		});
		nuclearWarning.createEl("div", {
			text: "⚠️ HIGH COST WARNING",
			attr: {
				style: "font-weight: bold; color: var(--color-red); margin-bottom: 8px;",
			},
		});
		nuclearWarning.createEl("p", {
			text: "2-Phase approach uses per-page multimodal analysis followed by final reconciliation. This costs 2-3x more tokens than standard processing but provides maximum accuracy with minimal manual cleanup needed.",
			attr: { style: "margin: 0; font-size: 0.9em;" },
		});

		new Setting(nuclearSection)
			.setName("Enable 2-Phase Approach")
			.setDesc(
				"Per-Page Multimodal → Final Reconciliation for maximum quality"
			)
			.addToggle((toggle) => {
				this.useNuclearOptionToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					if (value) {
						// Auto-enable context when 2-phase approach is enabled
						this.useContextToggle?.setValue(true);
						this.contextPagesContainer.style.display = "block";
					}
					this.updateTokenControlVisibility();
					this.costUi?.update();
				});
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

			// Debug logging
			this.plugin.logger(LogLevel.NORMAL, "Example note loaded:", {
				filename: file.name,
				originalLength: content.length,
				processedLength: this.exampleNoteContent.length,
				preview: this.exampleNoteContent.substring(0, 100) + "...",
			});

			await this.costUi?.update();

			// Show the example PDF section now that we have an example note
			const examplePdfSection = this.contentEl.querySelector(
				"#example-pdf-section"
			) as HTMLElement;
			if (examplePdfSection) {
				examplePdfSection.style.display = "block";
			}
		} catch (error) {
			console.error("Error loading example note:", error);
			this.exampleNoteContent = "";
		}
	}

	private selectExamplePdf(
		displayElement: HTMLElement,
		removeButton: HTMLElement
	): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".pdf";
		input.style.display = "none";

		input.onchange = (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (file) {
				this.examplePdfFile = file;
				displayElement.setText(`📄 ${file.name}`);
				displayElement.style.color = "var(--text-normal)";
				removeButton.style.display = "inline-block";
				this.toggleExamplePdfModeControls();
				// Process the PDF if needed
				if (this.processingModeSelect.value === "hybrid") {
					this.processExamplePdf();
				}
			}
			document.body.removeChild(input);
		};

		input.oncancel = () => {
			document.body.removeChild(input);
		};

		document.body.appendChild(input);
		input.click();
	}

	private clearExamplePdf(
		displayElement: HTMLElement,
		removeButton: HTMLElement
	): void {
		this.examplePdfFile = null;
		this.examplePdfPages = [];
		displayElement.setText("No example PDF selected");
		displayElement.style.color = "var(--text-muted)";
		removeButton.style.display = "none";
		this.toggleExamplePdfModeControls();
	}

	private async processExamplePdf(): Promise<void> {
		if (!this.examplePdfFile) return;

		const exampleMode = this.examplePdfModeSelect.value;

		// If text-only mode or main PDF is text-only, we don't need to process images
		if (
			exampleMode === "text" ||
			this.processingModeSelect.value === "text"
		) {
			// We could extract text from example PDF, but for now we just rely on the example note
			return;
		}

		// Process example PDF for hybrid mode
		try {
			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"PDF.js not available for example PDF processing"
				);
				return;
			}

			const typedArray = new Uint8Array(
				await this.examplePdfFile.arrayBuffer()
			);
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			// Store total pages for validation
			this.examplePdfTotalPages = pdf.numPages;
			
			// Validate page range now that we know total pages
			this.validateExamplePdfPageRange();

			this.examplePdfPages = [];

			// Respect the selected page range for example PDF
			const fromPage = parseInt(this.examplePdfPageRangeFromInput?.getValue() || "1");
			const toPage = parseInt(this.examplePdfPageRangeToInput?.getValue() || pdf.numPages.toString());
			const actualFrom = Math.max(1, fromPage);
			const actualTo = Math.min(pdf.numPages, toPage);

			// Process selected pages of the example PDF
			for (let pageNum = actualFrom; pageNum <= actualTo; pageNum++) {
				const page = await pdf.getPage(pageNum);

				// Render page to canvas
				const dpi = parseInt(this.dpiInput?.getValue() || "150");
				const scale = dpi / 72;
				const viewport = page.getViewport({ scale });

				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");
				canvas.height = viewport.height;
				canvas.width = viewport.width;

				const renderContext = {
					canvasContext: context!,
					viewport: viewport,
				};

				await page.render(renderContext).promise;

				// Convert to base64 image data
				const imageData = canvas.toDataURL("image/png");

				// Always extract text content for example PDF (might be used in text-only mode)
				let textContent = "";
				try {
					const pageTextContent = await page.getTextContent({ includeMarkedContent: true });
					textContent = this.extractParagraphsFromTextContent(
						pageTextContent.items
					);
				} catch (error) {
					this.plugin.logger(
						LogLevel.NORMAL,
						`Could not extract text from example PDF page ${pageNum}:`,
						error
					);
				}

				this.examplePdfPages.push({
					pageNum,
					imageData,
					textContent,
				});
			}

			this.plugin.logger(
				LogLevel.NORMAL,
				`Processed ${this.examplePdfPages.length} example PDF pages`
			);
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error processing example PDF:",
				error
			);
			this.examplePdfPages = [];
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

			// Keep headers, code blocks, and short content unchanged
			if (
				trimmed.startsWith("#") ||
				trimmed.startsWith("```") ||
				trimmed.includes("```") ||
				trimmed.split(/\s+/).length <= 10
			) {
				return trimmed;
			}

			// Handle bullet points and lists - preserve structure
			const lines = trimmed.split("\n");
			if (
				lines.some(
					(line) =>
						line.trim().startsWith("* ") ||
						line.trim().startsWith("- ") ||
						line.trim().match(/^\d+\./)
				)
			) {
				// This is a list - abbreviate each item while preserving structure
				return lines
					.map((line) => {
						const lineWords = line.trim().split(/\s+/);
						if (
							lineWords.length <= 8 ||
							(line.trim().startsWith("*") &&
								lineWords.length <= 12)
						) {
							return line; // Keep short lines or bullet points intact
						}
						const prefix =
							line.match(/^(\s*[\*\-\d]+\.?\s*)/)?.[1] || "";
						const content = line
							.replace(/^(\s*[\*\-\d]+\.?\s*)/, "")
							.trim();
						const contentWords = content.split(/\s+/);
						if (contentWords.length <= 6) {
							return line;
						}
						const firstThree = contentWords.slice(0, 3).join(" ");
						const lastTwo = contentWords.slice(-2).join(" ");
						return `${prefix}${firstThree} ... ${lastTwo}`;
					})
					.join("\n");
			}

			// Handle regular paragraphs
			const words = trimmed.split(/\s+/);
			if (words.length <= 8) {
				return trimmed;
			}

			const firstFour = words.slice(0, 4).join(" ");
			const lastThree = words.slice(-3).join(" ");
			return `${firstFour} ... ${lastThree}`;
		});

		return abbreviatedParagraphs.filter((p) => p).join("\n\n");
	}

	private postProcessMarkdown(content: string): string {
		// Step 1: Convert LaTeX syntax to MathJax
		content = this.convertLatexToMathJax(content);

		// Step 2: Clean up consecutive newlines after non-sentence endings
		content = this.cleanupConsecutiveNewlines(content);

		return content;
	}

	private convertLatexToMathJax(content: string): string {
		// Replace display math delimiters: \[ ... \] → $$ ... $$
		content = content.replace(/\\\[([\s\S]*?)\\\]/g, "$$\n$1\n$$");

		// Replace inline math delimiters: \( ... \) → $ ... $
		content = content.replace(/\\\((.*?)\\\)/g, "$$$1$$");

		return content;
	}

	private cleanupConsecutiveNewlines(content: string): string {
		// Pattern to match 2+ consecutive newlines that follow non-sentence ending characters
		// Non-sentence endings: colon, semicolon, comma (removed lowercase character)
		const pattern = /([,:;])\n{2,}/g;

		// Replace with single newline + space for better flow
		content = content.replace(pattern, "$1 ");

		// Also handle cases where there are excessive newlines (3+) anywhere
		content = content.replace(/\n{3,}/g, "\n\n");

		return content;
	}

	private async extractImagesFromPdf(): Promise<ExtractedImage[]> {
		if (!this.selectedFile) {
			return [];
		}

		try {
			const pdfjsLib = await this.loadPdfJs();
			const arrayBuffer = await this.selectedFile.arrayBuffer();
			const typedArray = new Uint8Array(arrayBuffer);
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			const extractedImages: ExtractedImage[] = [];
			const imageCount = { current: 0 };

			// Respect the selected page range
			const fromPage = parseInt(this.pageRangeFromInput?.getValue() || "1");
			const toPage = parseInt(this.pageRangeToInput?.getValue() || pdf.numPages.toString());
			const actualFrom = Math.max(1, fromPage);
			const actualTo = Math.min(pdf.numPages, toPage);

			for (let pageNum = actualFrom; pageNum <= actualTo; pageNum++) {
				// Check only selected pages
				const page = await pdf.getPage(pageNum);

				const pageImages = await this.extractImagesFromPage(
					page,
					pageNum,
					imageCount,
					pdfjsLib
				);
				extractedImages.push(...pageImages);
			}

			return extractedImages;
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error extracting images from PDF:",
				error
			);
			return [];
		}
	}

	private async extractImagesFromPage(
		page: any,
		pageNum: number,
		imageCount: { current: number },
		pdfjsLib: any
	): Promise<ExtractedImage[]> {
		const extractedImages: ExtractedImage[] = [];

		try {
			const operatorList = await page.getOperatorList();
			this.plugin.logger(
				LogLevel.NORMAL,
				`Page ${pageNum}: Analyzing ${operatorList.fnArray.length} operations for images`
			);

			// Look for all types of image operations like the debug modal does
			let imageOperations = 0;
			const seenDataRefs = new Set<string>();

			const imageOpsToCheck = [
				{
					name: "paintImageMaskXObject",
					op: pdfjsLib.OPS.paintImageMaskXObject,
				},
				{
					name: "paintImageXObject",
					op: pdfjsLib.OPS.paintImageXObject,
				},
				{ name: "paintJpegXObject", op: pdfjsLib.OPS.paintJpegXObject },
				{
					name: "paintInlineImageXObject",
					op: pdfjsLib.OPS.paintInlineImageXObject,
				},
			];

			for (let i = 0; i < operatorList.fnArray.length; i++) {
				const fn = operatorList.fnArray[i];
				const args = operatorList.argsArray[i];

				// Check if this is any type of image operation
				const imageOp = imageOpsToCheck.find((op) => fn === op.op);
				if (imageOp) {
					imageOperations++;
					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Found ${imageOp.name} operation ${imageOperations} at index ${i}`
					);
					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Args:`,
						args
					);

					// Handle two different argument formats:
					// Format 1: args[0] = {data, width, height} (object format)
					// Format 2: args[0] = 'img_ref', args[1] = width, args[2] = height (separate args format)
					let imageMetadata: any = null;
					let dataRef: string = "";

					if (args && args.length > 0 && args[0]) {
						if (
							typeof args[0] === "object" &&
							args[0].width &&
							args[0].height
						) {
							// Format 1: Object format
							imageMetadata = args[0];
							dataRef =
								imageMetadata.data ||
								imageMetadata.name ||
								`${imageOp.name}_${pageNum}_${i}`;
						} else if (
							typeof args[0] === "string" &&
							args.length >= 3 &&
							typeof args[1] === "number" &&
							typeof args[2] === "number"
						) {
							// Format 2: Separate arguments format
							imageMetadata = {
								data: args[0],
								name: args[0],
								width: args[1],
								height: args[2],
							};
							dataRef = args[0];
						}

						// Add transform matrix information from the operation
						// For image operations, check if there are additional transform arguments
						if (
							args.length >= 6 &&
							typeof args[args.length - 6] === "number"
						) {
							// Transform matrix is typically the last 6 arguments for image operations
							const transformStart = args.length - 6;
							imageMetadata.transform =
								args.slice(transformStart);
						} else if (
							imageOp.name.includes("Image") &&
							args.length > 3
						) {
							// For image operations, try to find transform data in different positions
							for (let j = 0; j < args.length - 5; j++) {
								const potential = args.slice(j, j + 6);
								if (
									potential.every(
										(val: any) => typeof val === "number"
									)
								) {
									imageMetadata.transform = potential;
									break;
								}
							}
						}
					}

					if (imageMetadata && dataRef) {
						// Check if we've already processed this image reference
						if (seenDataRefs.has(dataRef)) {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Page ${pageNum}: Skipping duplicate dataRef ${dataRef}`
							);
							continue;
						}
						seenDataRefs.add(dataRef);

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Processing unique ${imageOp.name} image ${imageMetadata.width}x${imageMetadata.height}px: ${dataRef}`
						);

						try {
							// Use appropriate extraction method based on operation type
							let extractedImage: ExtractedImage | null = null;

							if (imageOp.name === "paintImageMaskXObject") {
								extractedImage =
									await this.extractImageMaskFromPage(
										page,
										imageMetadata,
										pageNum,
										imageCount
									);
							} else {
								// For other image types, try the general extraction method
								extractedImage =
									await this.extractImageFromPage(
										page,
										imageMetadata,
										pageNum,
										imageCount,
										imageOp.name
									);
							}

							if (extractedImage) {
								extractedImages.push(extractedImage);
								this.plugin.logger(
									LogLevel.NORMAL,
									`Page ${pageNum}: Successfully extracted ${imageOp.name} image ${extractedImage.id} (${extractedImages.length} total so far)`
								);
							} else {
								this.plugin.logger(
									LogLevel.NORMAL,
									`Page ${pageNum}: Failed to extract ${imageOp.name} image ${dataRef} - extraction returned null`
								);
							}
						} catch (imageError) {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Failed to extract ${imageOp.name} image ${dataRef} from page ${pageNum}:`,
								imageError
							);
						}
					} else {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: ${imageOp.name} operation ${imageOperations} has invalid args:`,
							args
						);
					}
				}
			}

			this.plugin.logger(
				LogLevel.NORMAL,
				`Page ${pageNum}: Found ${imageOperations} image operations, extracted ${extractedImages.length} images`
			);

			if (imageOperations === 0) {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Page ${pageNum}: No image mask operations found`
				);
			}
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				`Error processing page ${pageNum} for images:`,
				error
			);
		}

		return extractedImages;
	}

	private async extractImageFromPage(
		page: any,
		imageMetadata: any,
		pageNum: number,
		imageCount: { current: number },
		opType: string
	): Promise<ExtractedImage | null> {
		return new Promise((resolve) => {
			// Use same timeout as mask extraction
			const timeout = setTimeout(() => {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Timeout extracting ${opType} image from page ${pageNum}`
				);
				resolve(null);
			}, 10000);

			try {
				const dataRef =
					imageMetadata.data || imageMetadata.name || imageMetadata;
				this.plugin.logger(
					LogLevel.NORMAL,
					`Page ${pageNum}: Attempting to extract ${opType} image with dataRef: ${dataRef}`
				);

				page.objs.get(dataRef, (obj: any) => {
					clearTimeout(timeout);

					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Retrieved ${opType} object for ${dataRef}:`,
						obj ? "SUCCESS" : "NULL"
					);

					if (!obj) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`No object found for ${opType} ${dataRef}`
						);
						resolve(null);
						return;
					}

					try {
						let canvas: HTMLCanvasElement;
						let ctx: CanvasRenderingContext2D;

						// Handle different object types
						if (obj.bitmap) {
							// ImageBitmap object (like paintImageMaskXObject)
							canvas = document.createElement("canvas");
							ctx = canvas.getContext("2d")!;
							canvas.width =
								obj.bitmap.width || imageMetadata.width;
							canvas.height =
								obj.bitmap.height || imageMetadata.height;
							ctx.drawImage(obj.bitmap, 0, 0);
						} else if (obj.data && obj.width && obj.height) {
							// Raw image data
							canvas = document.createElement("canvas");
							ctx = canvas.getContext("2d")!;
							canvas.width = obj.width;
							canvas.height = obj.height;

							const imageData = ctx.createImageData(
								obj.width,
								obj.height
							);
							imageData.data.set(obj.data);
							ctx.putImageData(imageData, 0, 0);
						} else {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Unsupported ${opType} object structure for ${dataRef}:`,
								obj
							);
							resolve(null);
							return;
						}

						const imageData = canvas.toDataURL("image/png");

						imageCount.current++;
						// Extract coordinates from transform matrix
						let x: number | undefined = undefined;
						let y: number | undefined = undefined;

						if (
							imageMetadata.transform &&
							Array.isArray(imageMetadata.transform)
						) {
							x = imageMetadata.transform[4];
							y = imageMetadata.transform[5];
						}

						const extractedImage: ExtractedImage = {
							id: `image_${pageNum}_${imageCount.current}`,
							pageNumber: pageNum,
							imageData: imageData,
							width: canvas.width,
							height: canvas.height,
							filename: `extracted_${opType.toLowerCase()}_${pageNum}_${
								imageCount.current
							}.png`,
							x: x,
							y: y,
						};

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Successfully extracted ${opType} image ${extractedImage.id} (${canvas.width}x${canvas.height}px)`
						);
						resolve(extractedImage);
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Error rendering ${opType} object for ${dataRef}:`,
							error
						);
						resolve(null);
					}
				});
			} catch (error) {
				clearTimeout(timeout);
				this.plugin.logger(
					LogLevel.NORMAL,
					`Error accessing ${opType} image ${imageMetadata.data}:`,
					error
				);
				resolve(null);
			}
		});
	}

	private async extractImageMaskFromPage(
		page: any,
		imageMetadata: any,
		pageNum: number,
		imageCount: { current: number }
	): Promise<ExtractedImage | null> {
		return new Promise((resolve) => {
			// Increase timeout to handle multiple images better
			const timeout = setTimeout(() => {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Timeout extracting image from page ${pageNum}`
				);
				resolve(null);
			}, 10000);

			try {
				const dataRef = imageMetadata.data;
				this.plugin.logger(
					LogLevel.NORMAL,
					`Page ${pageNum}: Attempting to extract image with dataRef: ${dataRef}`
				);

				page.objs.get(dataRef, (obj: any) => {
					clearTimeout(timeout);

					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Retrieved object for ${dataRef}:`,
						obj ? "SUCCESS" : "NULL"
					);

					if (!obj || !obj.bitmap) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`No bitmap found for ${dataRef}. Object:`,
							obj
						);
						resolve(null);
						return;
					}

					try {
						// Use the proven ImageBitmap extraction method
						const canvas = document.createElement("canvas");
						const ctx = canvas.getContext("2d")!;
						canvas.width = obj.bitmap.width || imageMetadata.width;
						canvas.height =
							obj.bitmap.height || imageMetadata.height;

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Creating canvas ${canvas.width}x${canvas.height}px for ${dataRef}`
						);

						// Draw the ImageBitmap to canvas
						ctx.drawImage(obj.bitmap, 0, 0);
						const imageData = canvas.toDataURL("image/png");

						imageCount.current++;
						// Extract coordinates from transform matrix
						let x: number | undefined = undefined;
						let y: number | undefined = undefined;

						if (
							imageMetadata.transform &&
							Array.isArray(imageMetadata.transform)
						) {
							x = imageMetadata.transform[4];
							y = imageMetadata.transform[5];
						}

						const extractedImage: ExtractedImage = {
							id: `image_${pageNum}_${imageCount.current}`,
							pageNumber: pageNum,
							imageData: imageData,
							width: canvas.width,
							height: canvas.height,
							filename: `extracted_image_${pageNum}_${imageCount.current}.png`,
							x: x,
							y: y,
						};

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Successfully extracted image ${extractedImage.id} (${canvas.width}x${canvas.height}px)`
						);
						resolve(extractedImage);
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Error rendering bitmap for ${dataRef}:`,
							error
						);
						resolve(null);
					}
				});
			} catch (error) {
				clearTimeout(timeout);
				this.plugin.logger(
					LogLevel.NORMAL,
					`Error accessing image ${imageMetadata.data}:`,
					error
				);
				resolve(null);
			}
		});
	}

	private async getImageFromPage(
		page: any,
		objId: string
	): Promise<{ imageData: string; width: number; height: number } | null> {
		return new Promise((resolve) => {
			try {
				// Try to get the image object
				page.objs.get(objId, (imgObj: any) => {
					if (!imgObj) {
						resolve(null);
						return;
					}

					try {
						// Handle different types of image objects
						let imageData:
							| ImageData
							| HTMLImageElement
							| HTMLCanvasElement = imgObj;

						// If it's raw image data, we need to process it
						if (imgObj.data && imgObj.width && imgObj.height) {
							// Create a canvas to convert the image data to a data URL
							const canvas = document.createElement("canvas");
							const ctx = canvas.getContext("2d");

							if (!ctx) {
								resolve(null);
								return;
							}

							canvas.width = imgObj.width;
							canvas.height = imgObj.height;

							// Create ImageData from the raw data
							const imageData = new ImageData(
								new Uint8ClampedArray(imgObj.data),
								imgObj.width,
								imgObj.height
							);

							ctx.putImageData(imageData, 0, 0);
							const dataUrl = canvas.toDataURL("image/png");

							resolve({
								imageData: dataUrl,
								width: imgObj.width,
								height: imgObj.height,
							});
						} else if (
							imgObj instanceof HTMLImageElement ||
							imgObj instanceof HTMLCanvasElement
						) {
							// If it's already an image or canvas, convert to data URL
							const canvas = document.createElement("canvas");
							const ctx = canvas.getContext("2d");

							if (!ctx) {
								resolve(null);
								return;
							}

							canvas.width =
								imgObj.width ||
								(imgObj as HTMLImageElement).naturalWidth;
							canvas.height =
								imgObj.height ||
								(imgObj as HTMLImageElement).naturalHeight;

							ctx.drawImage(imgObj, 0, 0);
							const dataUrl = canvas.toDataURL("image/png");

							resolve({
								imageData: dataUrl,
								width: canvas.width,
								height: canvas.height,
							});
						} else {
							resolve(null);
						}
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							"Error processing image object:",
							error
						);
						resolve(null);
					}
				});
			} catch (error) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"Error getting image from page:",
					error
				);
				resolve(null);
			}
		});
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
class EditModal extends NavigationAwareModal {
	private currentVariantIndex: number = 0;
	private variantDropdown!: HTMLSelectElement;
	private variantLabelEl!: HTMLLabelElement;
	private frontInput!: HTMLTextAreaElement;
	private backInput!: HTMLTextAreaElement;
	private mnemonicContainer!: HTMLDivElement;
	private currentMnemonics: MnemonicEntry[] = [];

	constructor(
		protected plugin: GatedNotesPlugin,
		private card: Flashcard,
		private graph: FlashcardGraph,
		private deck: TFile,
		private onDone: (actionTaken: boolean, newCards?: Flashcard[]) => void,
		private reviewContext?: { index: number; total: number },
		private parentContext?: "edit" | "review"
	) {
		super(plugin.app, plugin);
		// Ensure card has variants structure
		this.plugin.ensureVariantsStructure(this.card);
	}

	async onOpenContent() {
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

		// Variant selector
		const variantRow = createRow("", editPane); // Start with empty label, will be updated dynamically
		this.variantLabelEl = variantRow.querySelector('label') as HTMLLabelElement;
		this.variantDropdown = variantRow.createEl("select");
		this.refreshVariantDropdown();
		
		const addVariantBtn = variantRow.createEl("button", { text: "Add" });
		addVariantBtn.style.marginLeft = "8px";
		addVariantBtn.onclick = () => this.addVariant();
		
		const deleteVariantBtn = variantRow.createEl("button", { text: "Delete" });
		deleteVariantBtn.style.marginLeft = "4px";
		deleteVariantBtn.onclick = () => this.deleteCurrentVariant();
		
		const generateVariantsBtn = variantRow.createEl("button", { text: "🤖 Generate" });
		generateVariantsBtn.style.marginLeft = "4px";
		generateVariantsBtn.id = "generate-variants-btn"; // Add ID for easier reference
		generateVariantsBtn.onclick = () => this.generateVariantsWithAI();

		this.frontInput = createRow("Front:", editPane).createEl("textarea", {
			attr: { rows: 3 },
		}) as HTMLTextAreaElement;

		this.backInput = createRow("Back:", editPane).createEl("textarea", {
			attr: { rows: 3 },
		}) as HTMLTextAreaElement;

		// Populate fields from current variant
		this.populateFieldsFromCurrentVariant();

		// Handle variant dropdown changes
		this.variantDropdown.onchange = () => {
			this.saveCurrentVariant();
			this.currentVariantIndex = parseInt(this.variantDropdown.value);
			this.populateFieldsFromCurrentVariant();
			this.updateMnemonicsDisplay(); // Update mnemonics display when variant changes
		};

		// Add mnemonic section
		this.createMnemonicSection(editPane);

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
				this.frontInput.value,
				previewFrontContainer,
				this.card.chapter
			);

			previewBackContainer.createEl("hr");
			previewBackContainer.createEl("h4", { text: "Back Preview" });
			await this.plugin.renderCardContent(
				this.backInput.value,
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
						this.frontInput,
						this.backInput,
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
						this.frontInput,
						this.backInput,
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
							this.frontInput,
							this.backInput,
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
							this.frontInput,
							this.backInput,
							tagInput,
							paraInput
						);
						this.close();
						this.onDone(true);
					});
			}
			
			// Add Related Cards button for review context
			await this.addRelatedCardsButton(btnRow);
		} else {
			// Add Related Cards button for non-review context
			await this.addRelatedCardsButton(btnRow);
			
			new ButtonComponent(btnRow)
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					await this.saveCardState(
						this.frontInput,
						this.backInput,
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
		// Save current variant before saving other fields
		this.saveCurrentVariant();
		
		this.card.tag = tagInput.value.trim();
		this.card.paraIdx = Number(paraInput.value) || undefined;
		
		// Sync front/back fields with first variant for backwards compatibility
		if (this.card.variants && this.card.variants.length > 0) {
			this.card.front = this.card.variants[0].front;
			this.card.back = this.card.variants[0].back;
		}
		
		this.graph[this.card.id] = this.card;
		await this.plugin.writeDeck(this.deck.path, this.graph);
		this.plugin.refreshReading();
		this.plugin.refreshAllStatuses();
	}

	private refreshVariantDropdown() {
		this.variantDropdown.innerHTML = "";
		const variants = this.plugin.getCardVariants(this.card);
		
		// Update the label to be more informative
		if (this.variantLabelEl) {
			if (variants.length === 1) {
				this.variantLabelEl.textContent = "Variant (1 only):";
			} else {
				this.variantLabelEl.textContent = `Variant (${variants.length} total):`;
			}
		}
		
		variants.forEach((variant, index) => {
			const option = this.variantDropdown.createEl("option");
			option.value = index.toString();
			// Make options more descriptive
			const preview = variant.front.length > 30 
				? variant.front.substring(0, 30) + "..."
				: variant.front;
			option.text = `${index + 1}: ${preview || "(empty)"}`;
		});
		this.variantDropdown.value = this.currentVariantIndex.toString();
	}

	private populateFieldsFromCurrentVariant() {
		const currentVariant = this.plugin.getCurrentVariant(this.card, this.currentVariantIndex);
		this.frontInput.value = currentVariant.front;
		this.backInput.value = currentVariant.back;
	}

	private saveCurrentVariant() {
		if (!this.card.variants) {
			this.card.variants = [];
		}
		
		// Ensure the variants array is large enough
		while (this.card.variants.length <= this.currentVariantIndex) {
			this.card.variants.push({ front: "", back: "" });
		}
		
		this.card.variants[this.currentVariantIndex] = {
			front: this.frontInput.value.trim(),
			back: this.backInput.value.trim()
		};
		
		// If we're editing the first variant, sync front/back fields
		if (this.currentVariantIndex === 0) {
			this.syncFrontBackWithFirstVariant();
		}
	}

	private addVariant() {
		if (!this.card.variants) {
			this.card.variants = [];
		}
		
		this.card.variants.push({ front: "", back: "" });
		this.currentVariantIndex = this.card.variants.length - 1;
		this.refreshVariantDropdown();
		this.populateFieldsFromCurrentVariant();
		this.syncFrontBackWithFirstVariant();
	}

	private deleteCurrentVariant() {
		const variants = this.plugin.getCardVariants(this.card);
		if (variants.length <= 1) {
			new Notice("Cannot delete the only variant");
			return;
		}
		
		if (!this.card.variants) return;
		
		// Remove the variant
		this.card.variants.splice(this.currentVariantIndex, 1);
		
		// Adjust current index if needed
		if (this.currentVariantIndex >= this.card.variants.length) {
			this.currentVariantIndex = this.card.variants.length - 1;
		}
		
		this.refreshVariantDropdown();
		this.populateFieldsFromCurrentVariant();
		this.syncFrontBackWithFirstVariant();
	}

	private syncFrontBackWithFirstVariant() {
		if (this.card.variants && this.card.variants.length > 0) {
			this.card.front = this.card.variants[0].front;
			this.card.back = this.card.variants[0].back;
		}
	}

	private async generateVariantsWithAI() {
		try {
			// Save current variant first
			this.saveCurrentVariant();
			
			const currentVariant = this.plugin.getCurrentVariant(this.card, this.currentVariantIndex);
			
			if (!currentVariant.front.trim() || !currentVariant.back.trim()) {
				new Notice("Please fill in both front and back fields before generating variants");
				return;
			}

			const existingVariants = this.plugin.getCardVariants(this.card);
			let includeExisting = false;

			// If there are multiple variants, ask if we should include existing ones
			if (existingVariants.length > 1) {
				includeExisting = await this.showIncludeExistingDialog();
			}

			// Show quantity selection modal
			const options = await this.showVariantOptionsModal();
			if (!options) {
				return;
			}

			// Show cost confirmation modal
			const confirmed = await this.showGenerateVariantsConfirmation(currentVariant, existingVariants, includeExisting, options.quantity);
			if (!confirmed) {
				return;
			}

			// Show loading state
			const generateBtn = document.getElementById("generate-variants-btn") as HTMLButtonElement;
			if (generateBtn) {
				generateBtn.textContent = "⏳ Generating...";
				generateBtn.disabled = true;
			}

			// Execute the actual generation
			await this.executeVariantGeneration(currentVariant, existingVariants, includeExisting, options.quantity);
			
		} catch (error) {
			console.error("Error generating variants:", error);
			new Notice(`Error generating variants: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			// Reset button state
			const generateBtn = document.getElementById("generate-variants-btn") as HTMLButtonElement;
			if (generateBtn) {
				generateBtn.textContent = "🤖 Generate";
				generateBtn.disabled = false;
			}
		}
	}

	private showVariantOptionsModal(): Promise<{ quantity: "one" | "many" } | null> {
		return new Promise((resolve) => {
			new VariantOptionsModal(
				this.plugin,
				(result) => resolve(result)
			).open();
		});
	}

	private showGenerateVariantsConfirmation(
		currentVariant: CardVariant,
		existingVariants: CardVariant[], 
		includeExisting: boolean,
		quantity: "one" | "many"
	): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ActionConfirmationModal(
				this.plugin,
				"Generate Card Variants",
				() => {
					// Build prompt for cost estimation
					let promptVariants = "";
					if (includeExisting) {
						promptVariants = existingVariants.map((variant, index) => 
							`${index + 1}. Front: ${variant.front}\n   Back: ${variant.back}`
						).join("\n");
					} else {
						promptVariants = `1. Front: ${currentVariant.front}\n   Back: ${currentVariant.back}`;
					}

					const isMultiple = quantity === "many";
					const quantityText = isMultiple ? "2–3 NEW" : "1 NEW";
					const exampleCount = isMultiple ? 3 : 1;
					
					const prompt = `You are a flashcard variant generator.
I will give you ${includeExisting ? 'existing flashcard variants' : 'a flashcard'} with "front" (question or prompt) and "back" (answer).
Your task is to create ${quantityText} alternative version${isMultiple ? 's' : ''} that quiz${isMultiple ? '' : 'es'} the same knowledge.

Rules for variants:
- Each variant should quiz the **same knowledge** as the existing ones.
- Rephrase the wording, structure, or phrasing, but do not change the meaning.
- Keep the answer semantically equivalent, just optionally rephrased.
- Variants should still be suitable for spaced repetition flashcards.
- Do NOT repeat any of the existing variants - create NEW ones.

${includeExisting ? 'Existing variants:' : 'Flashcard:'}
${promptVariants}


Now return JSON with ${quantityText.toLowerCase()} variant${isMultiple ? 's' : ''} in this format:

{
  "variants": [
${Array.from({length: exampleCount}, (_, i) => `    {"front": "…", "back": "…"}${i < exampleCount - 1 ? ',' : ''}`).join('\n')}
  ]
}`;

					return {
						promptText: prompt,
						imageCount: 0,
						action: "generate_variants" as const,
						details: { cardCount: isMultiple ? 3 : 1, isVariableOutput: isMultiple } // Estimate based on quantity
					};
				},
				() => resolve(true)
			);
			
			modal.onClose = () => resolve(false);
			modal.open();
		});
	}

	private async executeVariantGeneration(
		currentVariant: CardVariant,
		existingVariants: CardVariant[],
		includeExisting: boolean,
		quantity: "one" | "many"
	) {

		// Build prompt with existing variants if requested
		let promptVariants = "";
		if (includeExisting) {
			promptVariants = existingVariants.map((variant, index) => 
				`${index + 1}. Front: ${variant.front}\n   Back: ${variant.back}`
			).join("\n");
		} else {
			promptVariants = `1. Front: ${currentVariant.front}\n   Back: ${currentVariant.back}`;
		}

		const isMultiple = quantity === "many";
		const quantityText = isMultiple ? "2–3 NEW" : "1 NEW";
		
		const prompt = `You are a flashcard variant generator.
I will give you ${includeExisting ? 'existing flashcard variants' : 'a flashcard'} with "front" (question or prompt) and "back" (answer).
Your task is to create ${quantityText} alternative version${isMultiple ? 's' : ''} that quiz${isMultiple ? '' : 'es'} the same knowledge.

Rules for variants:
- Each variant should quiz the **same knowledge** as the existing ones.
- Rephrase the wording, structure, or phrasing, but do not change the meaning.
- Keep the answer semantically equivalent, just optionally rephrased.
- Variants should still be suitable for spaced repetition flashcards.
- Do NOT repeat any of the existing variants - create NEW ones.

${includeExisting ? 'Existing variants:' : 'Flashcard:'}
${promptVariants}

Now return JSON with ${quantityText.toLowerCase()} variant${isMultiple ? 's' : ''} in this format:

{
  "variants": [
${Array.from({length: isMultiple ? 3 : 1}, (_, i) => `    {"front": "…", "back": "…"}${i < (isMultiple ? 2 : 0) ? ',' : ''}`).join('\n')}
  ]
}`;

		const response = await this.plugin.sendToLlm(prompt, [], {});
		
		// Parse the response
		const variants = this.parseVariantResponse(response.content);
		
		if (variants && variants.length > 0) {
			// Add the generated variants
			if (!this.card.variants) {
				this.card.variants = [];
			}
			
			// Add new variants to the card
			variants.forEach(variant => {
				this.card.variants!.push({
					front: variant.front.trim(),
					back: variant.back.trim()
				});
			});
			
			// Refresh UI
			this.refreshVariantDropdown();
			this.syncFrontBackWithFirstVariant();
			
			new Notice(`✅ Generated ${variants.length} new variants!`);
		} else {
			throw new Error("No valid variants were generated");
		}
	}

	private async showIncludeExistingDialog(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.plugin.app);
			modal.setTitle("Generate Variants");
			
			modal.contentEl.createEl("p", { 
				text: "This card already has multiple variants. Should the AI consider all existing variants when generating new ones, or just use the current variant?" 
			});
			
			const radioContainer = modal.contentEl.createDiv();
			radioContainer.style.margin = "20px 0";
			
			const includeLabel = radioContainer.createEl("label");
			includeLabel.style.display = "block";
			includeLabel.style.marginBottom = "10px";
			const includeRadio = includeLabel.createEl("input", { type: "radio", value: "include" });
			includeRadio.name = "variant-generation-mode";
			includeRadio.checked = true; // Default to true as requested
			includeLabel.appendText(" Include all existing variants (recommended for better variety)");
			
			const currentOnlyLabel = radioContainer.createEl("label");
			currentOnlyLabel.style.display = "block";
			const currentOnlyRadio = currentOnlyLabel.createEl("input", { type: "radio", value: "current" });
			currentOnlyRadio.name = "variant-generation-mode";
			currentOnlyLabel.appendText(" Use only the current variant");
			
			const buttonContainer = modal.contentEl.createDiv();
			buttonContainer.style.display = "flex";
			buttonContainer.style.justifyContent = "flex-end";
			buttonContainer.style.gap = "10px";
			buttonContainer.style.marginTop = "20px";
			
			const generateBtn = buttonContainer.createEl("button", { text: "Generate", cls: "mod-cta" });
			generateBtn.onclick = () => {
				const includeExisting = (modal.contentEl.querySelector('input[name="variant-generation-mode"]:checked') as HTMLInputElement)?.value === "include";
				modal.close();
				resolve(includeExisting);
			};
			
			const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
			cancelBtn.onclick = () => {
				modal.close();
				resolve(false);
			};
			
			modal.onClose = () => resolve(false);
			modal.open();
		});
	}

	private parseVariantResponse(response: string): Array<{front: string, back: string}> | null {
		try {
			// Try to extract JSON from the response
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error("No JSON found in response");
			}
			
			const parsed = JSON.parse(jsonMatch[0]);
			
			if (!parsed.variants || !Array.isArray(parsed.variants)) {
				throw new Error("Response doesn't contain variants array");
			}
			
			// Validate each variant
			const validVariants = parsed.variants.filter((variant: any) => 
				variant.front && variant.back && 
				typeof variant.front === 'string' && 
				typeof variant.back === 'string' &&
				variant.front.trim().length > 0 && 
				variant.back.trim().length > 0
			);
			
			return validVariants;
		} catch (error) {
			console.error("Error parsing variant response:", error);
			return null;
		}
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
						
						// If we're in a review context, pass the new cards to the callback instead of starting a separate review
						if (this.reviewContext) {
							this.onDone(true, newCards);
						} else {
							await this.plugin.promptToReviewNewCards(
								newCards,
								this.deck,
								this.graph
							);
							this.onDone(true, newCards);
						}
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

						// Suspend the original card instead of deleting it
						this.graph[this.card.id].suspended = true;
						newCards.forEach(
							(newCard) => (this.graph[newCard.id] = newCard)
						);
						await this.plugin.writeDeck(this.deck.path, this.graph);

						this.close();
						
						// If we're in a review context, pass the new cards to the callback instead of starting a separate review
						console.log("SPLIT DEBUG: reviewContext:", this.reviewContext);
						console.log("SPLIT DEBUG: newCards count:", newCards.length);
						if (this.reviewContext) {
							console.log("SPLIT DEBUG: In review context, calling onDone with newCards");
							this.onDone(true, newCards);
						} else {
							console.log("SPLIT DEBUG: Not in review context, calling promptToReviewNewCards");
							await this.plugin.promptToReviewNewCards(
								newCards,
								this.deck,
								this.graph
							);
							this.onDone(true, newCards);
						}
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

	private createMnemonicSection(editPane: HTMLElement): void {
		const mnemonicRow = editPane.createDiv({ cls: "gn-edit-row" });
		mnemonicRow.createEl("label", { text: "🧠 Mnemonics:" });
		
		this.mnemonicContainer = mnemonicRow.createDiv({ cls: "mnemonic-container" });
		
		// Button to open mnemonics modal
		const editMnemonicsBtn = mnemonicRow.createEl("button", { text: "Edit Mnemonics" });
		editMnemonicsBtn.style.marginLeft = "10px";
		editMnemonicsBtn.onclick = () => this.openMnemonicsModal();
		
		// Initialize display
		this.updateMnemonicsDisplay();
	}

	private updateMnemonicsDisplay(): void {
		// Clear existing content
		this.mnemonicContainer.empty();
		
		// Show saved mnemonics if any
		if (this.card.mnemonics?.majorSystem && this.card.mnemonics.majorSystem.length > 0) {
			this.card.mnemonics.majorSystem.forEach((mnemonic, index) => {
				const mnemonicDiv = this.mnemonicContainer.createDiv({ cls: "saved-mnemonic" });
				
				const headerText = `${mnemonic.number} (${mnemonic.position})${
					mnemonic.source && mnemonic.source !== mnemonic.number 
						? ` from "${mnemonic.source}"` 
						: ""
				}`;
				
				mnemonicDiv.createEl("span", { text: headerText, cls: "mnemonic-header" });
				mnemonicDiv.createEl("span", { text: " → ", cls: "mnemonic-arrow" });
				mnemonicDiv.createEl("strong", { text: mnemonic.selected || "No word selected" });
			});
		} else {
			this.mnemonicContainer.createEl("div", { 
				text: "No mnemonics configured",
				cls: "mnemonic-empty"
			});
		}
	}
	
	private openMnemonicsModal(): void {
		// Save current variant first to ensure we're working with latest content
		this.saveCurrentVariant();
		const currentVariant = this.plugin.getCurrentVariant(this.card, this.currentVariantIndex);
		
		new MnemonicsModal(
			this.plugin,
			this.card,
			currentVariant,
			async (selectedMnemonics: MnemonicEntry[], freeformNotes: string) => {
				// Save mnemonics to card
				if (!this.card.mnemonics) {
					this.card.mnemonics = {};
				}
				this.card.mnemonics.majorSystem = selectedMnemonics;
				this.card.mnemonics.enabled = selectedMnemonics.length > 0;
				this.card.mnemonics.freeformNotes = freeformNotes;
				
				// Update display
				this.updateMnemonicsDisplay();
				
				new Notice(`${selectedMnemonics.length} mnemonics saved!`);
			}
		).open();
	}

	// NavigationAwareModal implementation
	protected createNavigationContext(): EditModalContext {
		return {
			type: NavigationContextType.EDIT_MODAL,
			id: this.generateContextId(),
			title: this.reviewContext 
				? `Edit Card ${this.reviewContext.index}/${this.reviewContext.total}`
				: "Edit Card",
			timestamp: Date.now(),
			cardId: this.card.id,
			deckPath: this.deck.path,
			hasUnsavedChanges: false,
			originalCard: { ...this.card }
		};
	}

	protected restoreFromContext(context: EditModalContext): void {
		// Context restoration - the card and deck should already be set from constructor
		// We could restore form state here if we saved it
		this.populateFieldsFromCurrentVariant();
		this.updateMnemonicsDisplay();
	}

	protected saveToContext(): void {
		// Save current form state to the current variant
		this.saveCurrentVariant();
	}

	private async addRelatedCardsButton(btnRow: HTMLElement): Promise<void> {
		const relatedCards = await this.findRelatedCards();
		const relatedCount = relatedCards.length;
		
		if (relatedCount === 0) return; // Don't show button if no related cards
		
		new ButtonComponent(btnRow)
			.setButtonText(`Related: ${relatedCount}`)
			.setTooltip(`Find ${relatedCount} cards with the same tag: "${this.card.tag}"`)
			.onClick(() => {
				// Create search query to find cards with the same tag
				const searchQuery = `tag:"${this.card.tag}"`;
				
				// Open CardBrowser with the search query pre-filled
				const cardBrowser = new CardBrowser(
					this.plugin,
					this.plugin.cardBrowserState,
					undefined, // filter
					searchQuery // initialSearchQuery
				);
				
				// Use navigation system for proper context preservation
				this.navigateTo(cardBrowser);
			});
	}

	private async findRelatedCards(): Promise<Flashcard[]> {
		const relatedCards: Flashcard[] = [];
		
		// Only search the same deck - related cards (same tag) must be from the same note
		try {
			const deckPath = getDeckPathForChapter(this.card.chapter);
			const graph = await this.plugin.readDeck(deckPath);
			const cards = Object.values(graph) as Flashcard[];
			
			for (const card of cards) {
				// Find cards with the same tag, but exclude the current card
				if (card.tag === this.card.tag && card.id !== this.card.id) {
					relatedCards.push(card);
				}
			}
		} catch (error) {
			console.warn(`Could not read deck for ${this.card.chapter}:`, error);
		}
		
		return relatedCards;
	}

	protected onCloseContent(): void {
		// Clean up any resources specific to EditModal
		this.currentMnemonics = [];
	}
}

/**
 * A dedicated modal for viewing and editing mnemonic selections
 */
class MnemonicsModal extends Modal {
	private currentMnemonics: MnemonicEntry[] = [];
	private freeformNotesTextarea!: HTMLTextAreaElement;

	constructor(
		private plugin: GatedNotesPlugin,
		private card: Flashcard,
		private variant: CardVariant,
		private onSave: (mnemonics: MnemonicEntry[], freeformNotes: string) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("🧠 Configure Mnemonics");
		makeModalDraggable(this, this.plugin);
		
		// Add freeform notes section at the top
		this.addFreeformNotesSection();
		
		// Generate mnemonics from current variant
		const frontMnemonics = MajorSystemUtils.generateMnemonics(this.variant.front, 'front');
		const backMnemonics = MajorSystemUtils.generateMnemonics(this.variant.back, 'back');
		this.currentMnemonics = [...frontMnemonics, ...backMnemonics];
		
		// Load existing selections if available
		if (this.card.mnemonics?.majorSystem) {
			this.currentMnemonics.forEach(current => {
				const existing = this.card.mnemonics!.majorSystem!.find(
					saved => saved.number === current.number && saved.position === current.position
				);
				if (existing?.selected) {
					current.selected = existing.selected;
				}
			});
		}
		
		if (this.currentMnemonics.length === 0) {
			this.contentEl.createEl("p", { text: "No numbers detected in this card for mnemonic generation." });
			this.addCloseButton();
			this.addStyles();
			return;
		}
		
		// Add separator between freeform section and major system section
		this.contentEl.createEl("hr", { cls: "mnemonic-separator" });
		
		this.contentEl.createEl("p", { text: "Select mnemonic words for each number:" });
		this.renderMnemonics();
		this.addButtons();
		this.addStyles();
	}
	
	private addFreeformNotesSection(): void {
		// Create section header
		const freeformSection = this.contentEl.createDiv({ cls: "freeform-mnemonic-section" });
		freeformSection.createEl("h3", { text: "💭 Personal Mnemonic Notes" });
		freeformSection.createEl("p", { 
			text: "Add your own mnemonic notes or use AI to generate memory aids:",
			cls: "mnemonic-section-description"
		});
		
		// Create textarea for freeform notes
		this.freeformNotesTextarea = freeformSection.createEl("textarea", {
			cls: "freeform-mnemonic-textarea",
			placeholder: "Add your personal mnemonic notes here...\n\nFor example:\n🪖✉️=👨☕→🪲🎵\n\nGeneral Epistles go from Hebrews ('He Brews') to Jude (a song by the Beatles)"
		});
		this.freeformNotesTextarea.rows = 6;
		
		// Load existing freeform notes if available
		if (this.card.mnemonics?.freeformNotes) {
			this.freeformNotesTextarea.value = this.card.mnemonics.freeformNotes;
		}
		
		// Create AI buttons container
		const aiButtonsContainer = freeformSection.createDiv({ cls: "ai-buttons-container" });
		
		// Generate with AI button (for mental imagery)
		const generateAIBtn = new ButtonComponent(aiButtonsContainer)
			.setButtonText("🧠 Generate with AI")
			.setTooltip("Generate mental imagery description using AI")
			.onClick(() => this.generateMentalImagery());
		
		// Generate emoji sequence button
		const generateEmojiBtn = new ButtonComponent(aiButtonsContainer)
			.setButtonText("😊 Generate Emojis")
			.setTooltip("Generate emoji sequence using AI")
			.onClick(() => this.generateEmojiSequence());
	}
	
	private renderMnemonics(): void {
		const conflicts = MajorSystemUtils.getConflictingNumbers(this.currentMnemonics);
		
		this.currentMnemonics.forEach((mnemonic, index) => {
			const mnemonicDiv = this.contentEl.createDiv({ cls: "mnemonic-entry" });
			
			// Number header
			const headerText = `${mnemonic.number} (${mnemonic.position})${
				mnemonic.source && mnemonic.source !== mnemonic.number 
					? ` from "${mnemonic.source}"` 
					: ""
			}`;
			mnemonicDiv.createEl("h4", { text: headerText });
			
			// Word selection area
			const wordContainer = mnemonicDiv.createDiv({ cls: "mnemonic-words" });
			
			// Show first 8 words by default
			const initialWords = mnemonic.words.slice(0, 8);
			const remainingWords = mnemonic.words.slice(8);
			
			this.renderWordButtons(wordContainer, initialWords, mnemonic, conflicts);
			
			// "Show more" functionality
			if (remainingWords.length > 0) {
				const showMoreBtn = wordContainer.createEl("button", { 
					text: `Show ${remainingWords.length} more`,
					cls: "mnemonic-show-more"
				});
				
				showMoreBtn.addEventListener('click', () => {
					showMoreBtn.remove();
					this.renderWordButtons(wordContainer, remainingWords, mnemonic, conflicts);
				});
			}
			
			if (index < this.currentMnemonics.length - 1) {
				mnemonicDiv.createEl("hr");
			}
		});
	}
	
	private renderWordButtons(
		container: HTMLElement, 
		words: string[], 
		mnemonic: MnemonicEntry, 
		conflicts: Map<string, string[]>
	): void {
		words.forEach(word => {
			const wordBtn = container.createEl("button", { 
				text: word,
				cls: mnemonic.selected === word ? "mnemonic-word selected" : "mnemonic-word"
			});
			
			wordBtn.addEventListener('click', () => {
				// If clicking the same word, deselect it
				if (mnemonic.selected === word) {
					mnemonic.selected = undefined;
				} else {
					// Handle mutual exclusion - clear conflicting selections
					if (conflicts.has(mnemonic.number)) {
						const conflictingNumbers = conflicts.get(mnemonic.number)!;
						this.currentMnemonics.forEach(m => {
							if (conflictingNumbers.includes(m.number)) {
								m.selected = undefined;
							}
						});
					}
					
					// Set new selection
					mnemonic.selected = word;
				}
				
				this.updateSelectionDisplay();
			});
		});
	}
	
	private refreshDisplay(): void {
		this.contentEl.empty();
		this.renderMnemonics();
		this.addButtons();
	}
	
	private updateSelectionDisplay(): void {
		// Update all word button states without rebuilding the entire modal
		const wordButtons = this.contentEl.querySelectorAll('.mnemonic-word') as NodeListOf<HTMLButtonElement>;
		
		wordButtons.forEach(button => {
			const buttonText = button.textContent;
			let isSelected = false;
			
			// Find which mnemonic this button belongs to
			for (const mnemonic of this.currentMnemonics) {
				if (mnemonic.selected === buttonText) {
					isSelected = true;
					break;
				}
			}
			
			// Update button appearance
			if (isSelected) {
				button.classList.add('selected');
			} else {
				button.classList.remove('selected');
			}
		});
	}
	
	private addButtons(): void {
		const buttonContainer = this.contentEl.createDiv({ cls: "mnemonic-modal-buttons" });
		
		new ButtonComponent(buttonContainer)
			.setButtonText("Save")
			.setCta()
			.onClick(() => {
				const selectedMnemonics = this.currentMnemonics.filter(m => m.selected);
				const freeformNotes = this.freeformNotesTextarea.value.trim();
				this.onSave(selectedMnemonics, freeformNotes);
				this.close();
			});
			
		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => this.close());
	}
	
	private addCloseButton(): void {
		const buttonContainer = this.contentEl.createDiv({ cls: "mnemonic-modal-buttons" });
		new ButtonComponent(buttonContainer)
			.setButtonText("Close")
			.onClick(() => this.close());
	}
	
	private addStyles(): void {
		this.contentEl.createEl("style", {
			text: `
				.mnemonic-entry { margin: 15px 0; }
				.mnemonic-words { margin: 10px 0; }
				.mnemonic-word { 
					display: inline-block; 
					margin: 3px 5px; 
					padding: 6px 12px; 
					background: var(--background-modifier-border);
					border: 1px solid var(--background-modifier-border);
					border-radius: 6px;
					cursor: pointer;
					transition: all 0.2s ease;
					font-size: 14px;
				}
				.mnemonic-word:hover { 
					background: var(--background-modifier-hover);
					border-color: var(--background-modifier-hover);
				}
				.mnemonic-word.selected { 
					background: var(--interactive-accent); 
					color: var(--text-on-accent);
					border-color: var(--interactive-accent);
					font-weight: bold;
				}
				.mnemonic-show-more {
					margin: 5px;
					padding: 4px 8px;
					background: var(--background-secondary);
					border: 1px dashed var(--background-modifier-border);
					border-radius: 4px;
					cursor: pointer;
					font-size: 12px;
					opacity: 0.7;
				}
				.mnemonic-show-more:hover {
					opacity: 1;
					background: var(--background-modifier-hover);
				}
				.mnemonic-modal-buttons { 
					margin-top: 20px; 
					text-align: center; 
				}
				.mnemonic-modal-buttons button { margin: 0 5px; }
				.saved-mnemonic {
					margin: 5px 0;
					padding: 4px 0;
					font-size: 14px;
				}
				.mnemonic-arrow {
					color: var(--text-muted);
					margin: 0 5px;
				}
				.freeform-mnemonic-section {
					margin-bottom: 20px;
					padding: 15px;
					background: var(--background-secondary);
					border-radius: 8px;
					border: 1px solid var(--background-modifier-border);
				}
				.freeform-mnemonic-section h3 {
					margin: 0 0 8px 0;
					color: var(--text-accent);
				}
				.mnemonic-section-description {
					margin: 0 0 12px 0;
					color: var(--text-muted);
					font-size: 13px;
				}
				.freeform-mnemonic-textarea {
					width: 100%;
					min-height: 120px;
					padding: 12px;
					border: 1px solid var(--background-modifier-border);
					border-radius: 6px;
					background: var(--background-primary);
					color: var(--text-normal);
					font-family: var(--font-interface);
					font-size: 14px;
					resize: vertical;
					margin-bottom: 12px;
				}
				.freeform-mnemonic-textarea:focus {
					outline: none;
					border-color: var(--interactive-accent);
					box-shadow: 0 0 0 2px var(--interactive-accent-alpha);
				}
				.ai-buttons-container {
					display: flex;
					gap: 8px;
					justify-content: flex-start;
				}
				.mnemonic-separator {
					margin: 25px 0;
					border: none;
					border-top: 2px dashed var(--background-modifier-border);
				}
			`
		});
	}
	
	private async generateMentalImagery(): Promise<void> {
		const front = this.variant.front;
		const back = this.variant.back;
		
		try {
			new Notice("Generating mental imagery...", 3000);
			
			// Build Major System context if numbers are detected
			let majorSystemContext = "";
			if (this.currentMnemonics.length > 0) {
				majorSystemContext = "\n\nAVAILABLE MAJOR SYSTEM WORDS (you can optionally incorporate these):\n";
				this.currentMnemonics.forEach(mnemonic => {
					const wordList = mnemonic.words.slice(0, 10).join(", "); // Show first 10 words
					const moreCount = mnemonic.words.length > 10 ? ` (+${mnemonic.words.length - 10} more)` : "";
					majorSystemContext += `• Number "${mnemonic.number}" (${mnemonic.position}): ${wordList}${moreCount}\n`;
				});
				majorSystemContext += "\nYou can use any of these words in your mental imagery if it helps create a memorable story.";
			}
			
			const prompt = `Create a vivid mental image description to help remember this flashcard. Be creative and memorable:

FRONT: ${front}
BACK: ${back}${majorSystemContext}

Please create a short, vivid mental image description that connects the front and back of this flashcard. Use concrete, visual, and memorable imagery that tells a story or creates an association. Keep it concise but memorable.

Example: If the card is about "General Epistles go from Hebrews to Jude", you might say: "Picture a military GENERAL (🪖) holding LETTERS (✉️) while a HEBREW person drinks COFFEE (☕) and the BEATLES (🎵) play music for JUDE."

If Major System words are available above, feel free to incorporate any that would make the mental image more memorable, but don't force it if they don't fit naturally.

Provide only the mental imagery description, no additional explanation.`;

			const response = await this.plugin.sendToLlm(prompt, undefined, { temperature: 0.7 });
			
			if (response.content.trim()) {
				// Append to existing content or replace if empty
				const currentValue = this.freeformNotesTextarea.value.trim();
				if (currentValue) {
					this.freeformNotesTextarea.value = currentValue + "\n\n" + response.content.trim();
				} else {
					this.freeformNotesTextarea.value = response.content.trim();
				}
				new Notice("Mental imagery generated!");
			} else {
				new Notice("Failed to generate mental imagery. Please try again.");
			}
		} catch (error) {
			console.error("Error generating mental imagery:", error);
			new Notice("Error generating mental imagery. Please try again.");
		}
	}
	
	private async generateEmojiSequence(): Promise<void> {
		const front = this.variant.front;
		const back = this.variant.back;
		
		try {
			new Notice("Generating emoji sequence...", 3000);
			
			// Build Major System context if numbers are detected
			let majorSystemContext = "";
			if (this.currentMnemonics.length > 0) {
				majorSystemContext = "\n\nAVAILABLE MAJOR SYSTEM WORDS (you can optionally incorporate these):\n";
				this.currentMnemonics.forEach(mnemonic => {
					const wordList = mnemonic.words.slice(0, 10).join(", "); // Show first 10 words
					const moreCount = mnemonic.words.length > 10 ? ` (+${mnemonic.words.length - 10} more)` : "";
					majorSystemContext += `• Number "${mnemonic.number}" (${mnemonic.position}): ${wordList}${moreCount}\n`;
				});
				majorSystemContext += "\nYou can use any of these words in your emoji sequence if they help create memorable phonetic or visual connections.";
			}
			
			const prompt = `Create a creative emoji sequence to help remember this flashcard:

FRONT: ${front}
BACK: ${back}${majorSystemContext}

Create a memorable emoji sequence that connects the front and back of this flashcard. Use creative wordplay, phonetic connections, and visual associations.

Example formats:
- 🪖✉️=👨☕→🪲🎵 (General Epistles go from Hebrews (He+brews) to Jude (Hey Jude is a song by the Beatles))

Use emojis, arrows (→), equals (=), and brief explanations in curly braces when needed. Be creative with phonetic connections and visual wordplay. Keep it concise but memorable.

If Major System words are available above, feel free to incorporate any that create clever phonetic or visual connections in your emoji sequence.

Provide only the emoji sequence, no additional explanation.`;

			const response = await this.plugin.sendToLlm(prompt, undefined, { temperature: 0.8 });
			
			if (response.content.trim()) {
				// Append to existing content or replace if empty
				const currentValue = this.freeformNotesTextarea.value.trim();
				if (currentValue) {
					this.freeformNotesTextarea.value = currentValue + "\n\n" + response.content.trim();
				} else {
					this.freeformNotesTextarea.value = response.content.trim();
				}
				new Notice("Emoji sequence generated!");
			} else {
				new Notice("Failed to generate emoji sequence. Please try again.");
			}
		} catch (error) {
			console.error("Error generating emoji sequence:", error);
			new Notice("Error generating emoji sequence. Please try again.");
		}
	}
	
	onClose() {
		this.contentEl.empty();
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
 * A modal for selecting options before "generating variants" for a card with AI.
 */
class VariantOptionsModal extends Modal {
	constructor(
		private plugin: GatedNotesPlugin,
		private onDone: (
			result: {
				quantity: "one" | "many";
			} | null
		) => void
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Generate Variants");
		makeModalDraggable(this, this.plugin);

		let choiceMade = false;

		this.contentEl.createEl("p", {
			text: "How many variant flashcards would you like to generate?",
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
			this.onDone({ quantity: "one" });
		});

		new ButtonComponent(btnRow)
			.setButtonText("One or More")
			.setCta()
			.onClick(() => {
				choiceMade = true;
				this.close();
				this.onDone({ quantity: "many" });
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
class CardBrowser extends NavigationAwareModal {
	private flaggedFilter = FilterState.OFF;
	private suspendedFilter = FilterState.OFF;
	private newFilter = FilterState.OFF;
	private buriedFilter = FilterState.OFF;
	private searchQuery = "";
	private searchInput!: HTMLInputElement;
	private searchTimeout!: NodeJS.Timeout;
	private treePane!: HTMLElement;
	private editorPane!: HTMLElement;
	private selectedPaths: Set<string> = new Set();
	private filterCountUpdaters: {
		flagged: (count: number) => void;
		suspended: (count: number) => void;
		buried: (count: number) => void;
		new: (count: number) => void;
	} = {} as any;

	constructor(
		protected plugin: GatedNotesPlugin,
		private state: CardBrowserState,
		private filter?: (card: Flashcard) => boolean,
		initialSearchQuery?: string
	) {
		super(plugin.app, plugin);
		if (initialSearchQuery) {
			this.searchQuery = initialSearchQuery;
			// Clear any existing selections so search results show immediately
			this.selectedPaths.clear();
		}
		
		// Initialize filter states from persistent state
		this.flaggedFilter = state.flaggedFilter || FilterState.OFF;
		this.suspendedFilter = state.suspendedFilter || FilterState.OFF;
		this.buriedFilter = state.buriedFilter || FilterState.OFF;
		this.newFilter = state.newFilter || FilterState.OFF;
	}

	protected createNavigationContext(): CardBrowserContext {
		return {
			type: NavigationContextType.CARD_BROWSER,
			id: this.generateContextId(),
			title: "Card Browser",
			timestamp: Date.now(),
			searchQuery: this.searchQuery,
			selectedDeckPath: this.state.selectedDeckPath,
			selectedChapterPath: this.state.selectedChapterPath,
			scrollPosition: undefined,
			selectedFolders: new Set() // TODO: Add multi-selection
		};
	}

	protected restoreFromContext(context: CardBrowserContext): void {
		// Restore browser state from context
		if (context.selectedDeckPath) {
			this.state.selectedDeckPath = context.selectedDeckPath;
		}
		if (context.selectedChapterPath) {
			this.state.selectedChapterPath = context.selectedChapterPath;
		}
		if (context.searchQuery) {
			this.searchQuery = context.searchQuery;
			if (this.searchInput) {
				this.searchInput.value = this.searchQuery;
			}
		}
	}

	protected saveToContext(): void {
		if (this.context && this.context.type === NavigationContextType.CARD_BROWSER) {
			const browserContext = this.context as CardBrowserContext;
			browserContext.selectedDeckPath = this.state.selectedDeckPath;
			browserContext.selectedChapterPath = this.state.selectedChapterPath;
			browserContext.searchQuery = this.searchQuery;
		}
	}

	protected async onOpenContent() {
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onOpen -> Initializing modal."
		);
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onOpen -> Received state:",
			{ ...this.state, openSubjects: [...this.state.openSubjects] }
		);

		// Load persistent browser state
		this.loadBrowserState();

		this.modalEl.addClass("gn-browser");
		this.titleEl.setText(
			this.filter ? "Card Browser (Filtered)" : "Card Browser"
		);
		makeModalDraggable(this, this.plugin);

		const header = this.contentEl.createDiv({ cls: "gn-header" });
		const filtersContainer = header.createDiv({ cls: "gn-filters" });
		filtersContainer.style.display = "flex";
		filtersContainer.style.gap = "8px";
		filtersContainer.style.flexWrap = "wrap";
		filtersContainer.style.alignItems = "center";
		filtersContainer.style.marginBottom = "10px";
		
		// Add common filter button styles
		const addFilterButtonStyles = (button: HTMLElement) => {
			button.style.padding = "4px 8px";
			button.style.border = "1px solid var(--interactive-normal)";
			button.style.borderRadius = "4px";
			button.style.backgroundColor = "var(--interactive-normal)";
			button.style.cursor = "pointer";
			button.style.fontSize = "16px";
			button.style.minWidth = "32px";
			button.style.textAlign = "center";
		};

		// Flagged cards filter (three-state)
		const flaggedBtn = this.createThreeStateFilterButton(
			filtersContainer,
			"flag",
			() => this.flaggedFilter,
			(newState) => { this.flaggedFilter = newState; },
			"Filter flagged cards (click to cycle: off → only → hide)"
		);
		this.filterCountUpdaters.flagged = flaggedBtn.updateCount;

		// Suspended cards filter (three-state)
		const suspendedBtn = this.createThreeStateFilterButton(
			filtersContainer,
			"ban",
			() => this.suspendedFilter,
			(newState) => { this.suspendedFilter = newState; },
			"Filter suspended cards (click to cycle: off → only → hide)"
		);
		this.filterCountUpdaters.suspended = suspendedBtn.updateCount;

		// Buried cards filter (three-state)
		const buriedBtn = this.createThreeStateFilterButton(
			filtersContainer,
			"file-down",
			() => this.buriedFilter,
			(newState) => { this.buriedFilter = newState; },
			"Filter buried cards (click to cycle: off → only → hide)"
		);
		this.filterCountUpdaters.buried = buriedBtn.updateCount;

		// New cards filter (three-state)
		if (this.plugin.settings.showNewCardIndicators) {
			const newBtn = this.createThreeStateFilterButton(
				filtersContainer,
				"🌱",
				() => this.newFilter,
				(newState) => { this.newFilter = newState; },
				"Filter new cards (click to cycle: off → only → hide)",
				true // Use emoji instead of icon
			);
			this.filterCountUpdaters.new = newBtn.updateCount;
		}

		// Add search input
		const searchContainer = header.createDiv({ cls: "gn-search" });
		searchContainer.style.marginTop = "10px";
		searchContainer.style.display = "flex";
		searchContainer.style.gap = "8px";
		searchContainer.style.alignItems = "center";

		const searchLabel = searchContainer.createEl("label", { text: "Search:" });
		searchLabel.style.minWidth = "55px";
		
		this.searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: "Search cards (front, back, or tag:\"exact-tag\")"
		}) as HTMLInputElement;
		this.searchInput.style.flex = "1";
		this.searchInput.style.padding = "4px 8px";
		this.searchInput.style.border = "1px solid var(--interactive-normal)";
		this.searchInput.style.borderRadius = "4px";
		this.searchInput.value = this.searchQuery;

		// Add search functionality
		const performSearch = async () => {
			this.searchQuery = this.searchInput.value.trim();
			
			// Clear any previous selections when searching
			// Search should take precedence over manual selections
			if (this.searchQuery) {
				this.selectedPaths.clear();
			}
			
			await this.renderContent();
			
			// Only show search results in right pane after search is complete
			// and only if no manual selections are made
			if (this.selectedPaths.size === 0 && (this.searchQuery || this.hasActiveFilters())) {
				// Use a small delay to avoid interfering with typing
				setTimeout(() => {
					this.updateRightPaneForSelections();
				}, 100);
			}
		};

		this.searchInput.addEventListener("input", () => {
			// Debounce search to avoid excessive re-renders
			clearTimeout(this.searchTimeout);
			this.searchTimeout = setTimeout(performSearch, 200); // Fast, responsive search without expensive right pane updates
		});

		this.searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				clearTimeout(this.searchTimeout);
				performSearch();
			}
		});

		const clearBtn = searchContainer.createEl("button", { text: "Clear" });
		clearBtn.style.padding = "4px 8px";
		clearBtn.style.border = "1px solid var(--interactive-normal)";
		clearBtn.style.borderRadius = "4px";
		clearBtn.style.backgroundColor = "var(--interactive-normal)";
		clearBtn.style.cursor = "pointer";
		clearBtn.onclick = async () => {
			this.searchInput.value = "";
			this.searchQuery = "";
			this.selectedPaths.clear(); // Also clear selections when clearing search
			await this.renderContent();
			await this.updateRightPaneForSelections(); // Update right pane after clearing
		};

		// Add expand/collapse all button
		const expandCollapseBtn = filtersContainer.createEl("button");
		addFilterButtonStyles(expandCollapseBtn);
		expandCollapseBtn.setAttribute("aria-label", "Collapse all");
		expandCollapseBtn.addClass("clickable-icon", "nav-action-button");
		setIcon(expandCollapseBtn, "chevrons-down-up");
		expandCollapseBtn.onclick = () => this.toggleExpandCollapseAll();

		// Add Custom Study button
		const customStudyBtn = filtersContainer.createEl("button", { text: "🎯 Custom Study" });
		addFilterButtonStyles(customStudyBtn);
		customStudyBtn.style.backgroundColor = "var(--interactive-accent)";
		customStudyBtn.style.color = "var(--text-on-accent)";
		customStudyBtn.style.fontWeight = "bold";
		customStudyBtn.setAttribute("aria-label", "Start custom study session with selected/filtered cards");
		customStudyBtn.onclick = () => this.startCustomStudy();

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
		
		// If opened with initial search query, populate right pane with search results
		if (this.searchQuery && this.selectedPaths.size === 0) {
			await this.updateRightPaneForSelections();
		}
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

			// Apply search filter
			if (this.searchQuery) {
				cards = cards.filter(card => this.matchesSearch(card));
			}
			
			// Apply all filters using the centralized filter system
			cards = this.applyFiltersToCards(cards);

			if (!cards.length) {
				this.editorPane.setText("No cards match the current filter.");
				return;
			}
			cards.sort(
				(a, b) => (a.paraIdx ?? Infinity) - (b.paraIdx ?? Infinity)
			);

			for (const card of cards) {
				const row = this.editorPane.createDiv({ cls: "gn-cardrow" });
				
				// Add status icons
				if (this.plugin.settings.showNewCardIndicators && isUnseen(card)) {
					row.createEl("span", { text: "🌱" }).style.marginRight = "4px";
				}
				if (isBuried(card)) {
					const iconSpan = row.createEl("span");
					iconSpan.style.marginRight = "4px";
					setIcon(iconSpan, "file-down");
				}
				if (card.suspended) {
					const iconSpan = row.createEl("span");
					iconSpan.style.marginRight = "4px";
					setIcon(iconSpan, "ban");
				}
				if (card.flagged) {
					const iconSpan = row.createEl("span");
					iconSpan.style.marginRight = "4px";
					setIcon(iconSpan, "flag");
				}
				
				// Add card label (using first variant)
				const labelSpan = row.createEl("span");
				const firstVariant = this.plugin.getCurrentVariant(card, 0);
				labelSpan.setText(firstVariant.front || "(empty front)");

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
			// Apply search filter
			if (this.searchQuery) {
				cardsInDeck = cardsInDeck.filter(card => this.matchesSearch(card));
			}
			
			// Apply all filters using the centralized filter system
			cardsInDeck = this.applyFiltersToCards(cardsInDeck);
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

			const summaryEl = subjectEl.createEl("summary", { text: subject });
			
			// Apply selection styling to subject folder
			if (this.selectedPaths.has(subject)) {
				summaryEl.addClass("selected");
				summaryEl.style.backgroundColor = "var(--interactive-accent)";
				summaryEl.style.color = "var(--text-on-accent)";
			}

			// Toggle selection on click (no CTRL required)
			// But allow expand/collapse arrow to work normally
			summaryEl.addEventListener("click", (e) => {
				// Check if click was on the expand/collapse arrow area
				const summaryRect = summaryEl.getBoundingClientRect();
				const clickX = e.clientX - summaryRect.left;
				
				// The arrow is typically in the first ~20px on the left
				// If click is in that area, let the default expand/collapse happen
				if (clickX < 20) {
					return; // Let default behavior handle expand/collapse
				}
				
				// Otherwise, it's a selection click
				e.preventDefault();
				e.stopPropagation();
				
				const isSelected = this.selectedPaths.has(subject);
				if (isSelected) {
					this.selectedPaths.delete(subject);
				} else {
					this.selectedPaths.add(subject);
				}
				
				this.updateSelectionDisplay();
			});

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
				const chapterEl = subjectEl.createEl("div", {
					cls: "gn-chap",
					text: `${count} card(s) • ${chapterName}`,
					attr: { "data-chapter-path": chapterPath },
				});

				// Apply selection styling
				if (this.selectedPaths.has(chapterPath)) {
					chapterEl.addClass("selected");
					chapterEl.style.backgroundColor = "var(--interactive-accent)";
					chapterEl.style.color = "var(--text-on-accent)";
				}

				chapterEl.onclick = (e) => {
					// Toggle selection on click (no CTRL required)
					e.preventDefault();
					e.stopPropagation();
					
					const isSelected = this.selectedPaths.has(chapterPath);
					if (isSelected) {
						this.selectedPaths.delete(chapterPath);
					} else {
						this.selectedPaths.add(chapterPath);
					}
					
					this.updateSelectionDisplay();
				};
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
		
		// Update filter counts after rendering
		this.updateFilterCounts();
	}

	private matchesSearch(card: Flashcard): boolean {
		if (!this.searchQuery) return true;

		const query = this.searchQuery.toLowerCase();
		
		// Check for tag search: tag:"exact-tag" (handles nested quotes)
		const tagMatch = query.match(/tag:"(.+)"$/);
		if (tagMatch) {
			const tagQuery = tagMatch[1];
			return card.tag.toLowerCase() === tagQuery.toLowerCase();
		}

		// Check for tag search without quotes: tag:sometag
		const simpleTagMatch = query.match(/tag:(\S+)/);
		if (simpleTagMatch) {
			const tagQuery = simpleTagMatch[1];
			return card.tag.toLowerCase().includes(tagQuery.toLowerCase());
		}

		// Regular text search in front, back, and tag
		const searchFields = [
			card.front || "",
			card.back || "", 
			card.tag || ""
		];

		// Also search in variants
		if (card.variants) {
			card.variants.forEach(variant => {
				searchFields.push(variant.front || "", variant.back || "");
			});
		}

		return searchFields.some(field => 
			field.toLowerCase().includes(query)
		);
	}

	private updateSelectionDisplay() {
		// Refresh the tree to show updated selection styling
		this.renderContent();
		
		// Update the right pane to show selected content
		this.updateRightPaneForSelections();
		
		this.plugin.logger(
			LogLevel.VERBOSE,
			`CardBrowser: Selection updated -> ${this.selectedPaths.size} items selected: ${Array.from(this.selectedPaths).join(', ')}`
		);
	}

	private hasActiveFilters(): boolean {
		return this.flaggedFilter !== FilterState.OFF ||
			   this.suspendedFilter !== FilterState.OFF ||
			   this.buriedFilter !== FilterState.OFF ||
			   this.newFilter !== FilterState.OFF;
	}

	private async updateRightPaneForSelections() {
		if (this.selectedPaths.size === 0) {
			// No selections - show search/filter results if there's a search query or active filters
			if (this.searchQuery || this.hasActiveFilters()) {
				await this.showSearchAndFilterResultsInRightPane();
			} else {
				this.editorPane.empty();
				this.editorPane.setText("Search for cards, apply filters, or select folders/notes to see cards here.");
			}
			return;
		}

		this.editorPane.empty();
		this.editorPane.setText("Loading selected cards...");

		// Collect cards from all selected paths
		const allSelectedCards: Flashcard[] = [];
		
		for (const selectedPath of this.selectedPaths) {
			// Check if this is a subject (folder) or individual chapter (note)
			const isFolder = !selectedPath.includes('.md');
			
			if (isFolder) {
				// It's a subject folder - get all cards from all chapters in that subject
				const decks = this.app.vault
					.getFiles()
					.filter((f) => f.name.endsWith(DECK_FILE_NAME) && f.path.startsWith(selectedPath));
					
				for (const deck of decks) {
					const graph = await this.plugin.readDeck(deck.path);
					const cardsInDeck = Object.values(graph) as Flashcard[];
					allSelectedCards.push(...cardsInDeck);
				}
			} else {
				// It's an individual chapter - get cards from that specific chapter
				const deckPath = getDeckPathForChapter(selectedPath);
				try {
					const graph = await this.plugin.readDeck(deckPath);
					const cardsInDeck = Object.values(graph).filter(
						(card: Flashcard) => card.chapter === selectedPath
					) as Flashcard[];
					allSelectedCards.push(...cardsInDeck);
				} catch (error) {
					console.warn(`Could not read deck for ${selectedPath}:`, error);
				}
			}
		}

		// Apply search filter if active
		let filteredCards = allSelectedCards;
		if (this.searchQuery) {
			filteredCards = allSelectedCards.filter(card => this.matchesSearch(card));
		}

		// Apply all filters using the centralized filter system
		filteredCards = this.applyFiltersToCards(filteredCards);

		this.displayCardsInRightPane(filteredCards);
	}

	private async showSearchAndFilterResultsInRightPane() {
		if (!this.searchQuery && !this.hasActiveFilters()) {
			this.editorPane.empty();
			this.editorPane.setText("Enter a search query or apply filters to see results.");
			return;
		}

		this.editorPane.empty();
		this.editorPane.setText("Loading results...");

		// Get search results from entire vault
		const allDeckFiles = this.app.vault
			.getFiles()
			.filter((f) => f.name === DECK_FILE_NAME);
		
		const allCards: Flashcard[] = [];
		for (const deckFile of allDeckFiles) {
			try {
				const content = await this.app.vault.read(deckFile);
				const deckCards = JSON.parse(content);
				allCards.push(...(Object.values(deckCards) as Flashcard[]));
			} catch (error) {
				console.warn(`Could not read deck ${deckFile.path}:`, error);
			}
		}
		
		// Filter by search query
		const searchFiltered = allCards.filter(card => this.matchesSearch(card));
		const filteredCards = this.applyFiltersToCards(searchFiltered);

		// Limit results to prevent UI freezing with large result sets
		const MAX_DISPLAY_RESULTS = 100;
		const displayCards = filteredCards.slice(0, MAX_DISPLAY_RESULTS);
		
		// Show result count with truncation info if needed
		this.editorPane.empty();
		const headerEl = this.editorPane.createEl("div", { 
			text: filteredCards.length > MAX_DISPLAY_RESULTS 
				? `Found ${filteredCards.length} cards (showing first ${MAX_DISPLAY_RESULTS})`
				: `Found ${filteredCards.length} cards`,
			cls: "gn-search-results-header"
		});
		headerEl.style.padding = "10px";
		headerEl.style.backgroundColor = "var(--background-secondary)";
		headerEl.style.borderRadius = "4px";
		headerEl.style.marginBottom = "10px";
		headerEl.style.fontWeight = "bold";

		// Display cards directly without replacing the header
		await this.renderCardsInRightPane(displayCards);
	}

	private async renderCardsInRightPane(cards: Flashcard[]) {
		if (cards.length === 0) {
			const noResultsEl = this.editorPane.createEl("div", { text: "No matching cards found." });
			noResultsEl.style.padding = "10px";
			noResultsEl.style.fontStyle = "italic";
			return;
		}

		// Sort and display cards (same logic as displayCardsInRightPane but without header)
		cards.sort((a, b) => (a.paraIdx ?? Infinity) - (b.paraIdx ?? Infinity));
		
		for (const card of cards) {
			const row = this.editorPane.createDiv({ cls: "gn-cardrow" });
			
			// Add divider line between cards
			row.style.borderBottom = "1px solid var(--background-modifier-border)";
			row.style.paddingBottom = "8px";
			row.style.marginBottom = "8px";
			
			// Add status icons (same as existing logic)
			if (this.plugin.settings.showNewCardIndicators && isUnseen(card)) {
				row.createEl("span", { text: "🌱" }).style.marginRight = "4px";
			}
			if (isBuried(card)) {
				const iconSpan = row.createEl("span");
				iconSpan.style.marginRight = "4px";
				setIcon(iconSpan, "file-down");
			}
			if (card.suspended) {
				const iconSpan = row.createEl("span");
				iconSpan.style.marginRight = "4px";
				setIcon(iconSpan, "ban");
			}
			if (card.flagged) {
				const iconSpan = row.createEl("span");
				iconSpan.style.marginRight = "4px";
				setIcon(iconSpan, "flag");
			}
			
			// Add card label with markdown rendering - make it inline
			const labelSpan = row.createEl("span");
			labelSpan.style.display = "inline"; // Keep everything on the same line
			const firstVariant = this.plugin.getCurrentVariant(card, 0);
			const frontText = firstVariant.front || "(empty front)";
			
			// Render markdown content including MathJax
			labelSpan.empty();
			await MarkdownRenderer.render(
				this.plugin.app,
				fixMath(frontText),
				labelSpan,
				"", // sourcePath - empty since we don't have a specific file
				this.plugin // component
			);
			
			// Remove paragraph spacing and make paragraphs inline to maintain compact card display
			const paragraphs = labelSpan.querySelectorAll("p");
			paragraphs.forEach(p => {
				p.style.margin = "0";
				p.style.padding = "0";
				p.style.display = "inline"; // Make paragraphs inline so they don't break the line
			});
			
			// Add line break before chapter info
			row.createEl("br");
			
			// Add chapter info on new line, removing .md suffix
			const chapterSpan = row.createEl("span", { cls: "gn-chapter-info" });
			chapterSpan.style.opacity = "0.7";
			chapterSpan.style.fontSize = "0.9em";
			const chapterDisplay = card.chapter.replace(/\.md$/, "");
			chapterSpan.setText(`(${chapterDisplay})`);
			
			// Add click handler to edit card
			row.onclick = async () => {
				const deckPath = getDeckPathForChapter(card.chapter);
				const graph = await this.plugin.readDeck(deckPath);
				const deck = this.app.vault.getAbstractFileByPath(deckPath) as TFile;
				
				this.plugin.openEditModal(card, graph, deck, async () => {
					this.updateRightPaneForSelections(); // Refresh after editing
				});
			};
			
			// Add info button
			row.createEl("span", { text: "ℹ️", cls: "gn-info" }).onclick = (ev) => {
				ev.stopPropagation();
				new CardInfoModal(this.plugin.app, card).open();
			};
			
			// Add delete button
			row.createEl("span", {
				text: "🗑️",
				cls: "gn-trash",
			}).onclick = async (ev) => {
				ev.stopPropagation();
				if (!confirm("Delete this card permanently?")) return;
				
				// Get the deck for this card
				const deckPath = getDeckPathForChapter(card.chapter);
				const graph = await this.plugin.readDeck(deckPath);
				delete graph[card.id];
				await this.plugin.writeDeck(deckPath, graph);
				
				// Refresh badges and right pane
				this.plugin.refreshAllStatuses();
				
				// Refresh the display
				this.updateRightPaneForSelections();
			};
		}
	}

	private async startCustomStudy() {
		// Get all cards currently visible in the right pane
		const cardsToStudy = await this.getCardsForCustomStudy();
		
		if (cardsToStudy.length === 0) {
			new Notice("No cards available for custom study. Try adjusting your selection or filters.");
			return;
		}

		// Filter for due/reviewable cards
		const now = Date.now();
		const dueCards = cardsToStudy.filter(card => 
			!card.suspended && // Not suspended
			card.due <= now && // Due for review
			!isBuried(card) && // Not buried
			!isUnseen(card) // Not a new card - custom study should only review existing cards
		);

		if (dueCards.length === 0) {
			// No due cards - offer study ahead option
			const studyAhead = confirm(
				`No cards are currently due in your selection (${cardsToStudy.length} total cards). Would you like to study ahead?`
			);
			
			if (!studyAhead) return;
			
			// Use all cards for study ahead
			this.startCustomReviewSession(cardsToStudy);
		} else {
			// Start session with due cards
			const pathDisplay = this.selectedPaths.size === 0 
				? "search results"
				: this.selectedPaths.size === 1 
					? Array.from(this.selectedPaths)[0]
					: `${this.selectedPaths.size} selected items`;
					
			new Notice(`🎯 Custom study: ${dueCards.length} due cards from ${pathDisplay}`);
			this.startCustomReviewSession(dueCards);
		}
	}

	private async getCardsForCustomStudy(): Promise<Flashcard[]> {
		if (this.selectedPaths.size > 0) {
			// Use selected paths
			const allSelectedCards: Flashcard[] = [];
			
			for (const selectedPath of this.selectedPaths) {
				const isFolder = !selectedPath.includes('.md');
				
				if (isFolder) {
					// Subject folder - get all cards from that subject
					const decks = this.app.vault
						.getFiles()
						.filter((f) => f.name.endsWith(DECK_FILE_NAME) && f.path.startsWith(selectedPath));
						
					for (const deck of decks) {
						const graph = await this.plugin.readDeck(deck.path);
						const cardsInDeck = Object.values(graph) as Flashcard[];
						allSelectedCards.push(...cardsInDeck);
					}
				} else {
					// Individual chapter
					const deckPath = getDeckPathForChapter(selectedPath);
					try {
						const graph = await this.plugin.readDeck(deckPath);
						const cardsInDeck = Object.values(graph).filter(
							(card: Flashcard) => card.chapter === selectedPath
						) as Flashcard[];
						allSelectedCards.push(...cardsInDeck);
					} catch (error) {
						console.warn(`Could not read deck for ${selectedPath}:`, error);
					}
				}
			}

			// Apply search filtering if there's a search query
			const searchFiltered = this.searchQuery 
				? allSelectedCards.filter(card => this.matchesSearch(card))
				: allSelectedCards;
			
			return this.applyFiltersToCards(searchFiltered);
		} else if (this.searchQuery) {
			// Use search results from entire vault
			const allDeckFiles = this.app.vault
				.getFiles()
				.filter((f) => f.name === DECK_FILE_NAME);
			
			const allCards: Flashcard[] = [];
			for (const deckFile of allDeckFiles) {
				try {
					const content = await this.app.vault.read(deckFile);
					const deckCards = JSON.parse(content);
					allCards.push(...(Object.values(deckCards) as Flashcard[]));
				} catch (error) {
					console.warn(`Could not read deck ${deckFile.path}:`, error);
				}
			}
			
			// Filter by search query
			const searchFiltered = allCards.filter(card => this.matchesSearch(card));
			return this.applyFiltersToCards(searchFiltered);
		} else {
			// No selection or search - use entire vault
			const allDeckFiles = this.app.vault
				.getFiles()
				.filter((f) => f.name === DECK_FILE_NAME);
			
			const allCards: Flashcard[] = [];
			for (const deckFile of allDeckFiles) {
				try {
					const content = await this.app.vault.read(deckFile);
					const deckCards = JSON.parse(content);
					allCards.push(...(Object.values(deckCards) as Flashcard[]));
				} catch (error) {
					console.warn(`Could not read deck ${deckFile.path}:`, error);
				}
			}
			
			return this.applyFiltersToCards(allCards);
		}
	}

	private cycleFilterState(currentState: FilterState): FilterState {
		switch (currentState) {
			case FilterState.OFF:
				return FilterState.INCLUDE_ONLY;
			case FilterState.INCLUDE_ONLY:
				return FilterState.EXCLUDE;
			case FilterState.EXCLUDE:
				return FilterState.OFF;
		}
	}

	private getFilterButtonStyle(state: FilterState): { backgroundColor: string; color: string; text: string } {
		switch (state) {
			case FilterState.OFF:
				return {
					backgroundColor: "var(--interactive-normal)",
					color: "var(--text-normal)",
					text: "off"
				};
			case FilterState.INCLUDE_ONLY:
				return {
					backgroundColor: "var(--text-success)",
					color: "var(--text-on-accent)",
					text: "only"
				};
			case FilterState.EXCLUDE:
				return {
					backgroundColor: "var(--text-error)",
					color: "var(--text-on-accent)", 
					text: "hide"
				};
		}
	}

	private async calculateFilterCounts(): Promise<{
		flagged: { total: number; filtered: number };
		suspended: { total: number; filtered: number };
		buried: { total: number; filtered: number };
		new: { total: number; filtered: number };
	}> {
		// Get all cards currently visible (after search but before other filters)
		const allDeckFiles = this.app.vault
			.getFiles()
			.filter((f) => f.name === DECK_FILE_NAME);
		
		let allCards: Flashcard[] = [];
		for (const deckFile of allDeckFiles) {
			try {
				const graph = await this.plugin.readDeck(deckFile.path);
				allCards.push(...(Object.values(graph) as Flashcard[]));
			} catch (error) {
				console.warn(`Could not read deck ${deckFile.path}:`, error);
			}
		}
		
		// Apply search filter if active
		if (this.searchQuery) {
			allCards = allCards.filter(card => this.matchesSearch(card));
		}
		
		// Count totals for each property
		const flaggedTotal = allCards.filter(c => c.flagged).length;
		const suspendedTotal = allCards.filter(c => c.suspended).length;
		const buriedTotal = allCards.filter(c => isBuried(c)).length;
		const newTotal = allCards.filter(c => isUnseen(c)).length;
		
		// Apply current filters to see how many would remain
		const filteredCards = this.applyFiltersToCards(allCards);
		const flaggedFiltered = filteredCards.filter(c => c.flagged).length;
		const suspendedFiltered = filteredCards.filter(c => c.suspended).length;
		const buriedFiltered = filteredCards.filter(c => isBuried(c)).length;
		const newFiltered = filteredCards.filter(c => isUnseen(c)).length;
		
		return {
			flagged: { total: flaggedTotal, filtered: flaggedFiltered },
			suspended: { total: suspendedTotal, filtered: suspendedFiltered },
			buried: { total: buriedTotal, filtered: buriedFiltered },
			new: { total: newTotal, filtered: newFiltered }
		};
	}

	private async updateFilterCounts(): Promise<void> {
		const counts = await this.calculateFilterCounts();
		
		// Update each button with appropriate count based on its current state
		if (this.filterCountUpdaters.flagged) {
			this.filterCountUpdaters.flagged(counts.flagged.total);
		}
		if (this.filterCountUpdaters.suspended) {
			this.filterCountUpdaters.suspended(counts.suspended.total);
		}
		if (this.filterCountUpdaters.buried) {
			this.filterCountUpdaters.buried(counts.buried.total);
		}
		if (this.filterCountUpdaters.new) {
			this.filterCountUpdaters.new(counts.new.total);
		}
	}

	private createThreeStateFilterButton(
		container: HTMLElement, 
		iconOrText: string, 
		getCurrentState: () => FilterState,
		onStateChange: (newState: FilterState) => void,
		tooltip: string,
		useEmoji: boolean = false
	): { button: HTMLElement; updateCount: (count: number) => void } {
		const btn = container.createEl("button");
		const iconEl = btn.createEl("div");
		
		if (useEmoji) {
			iconEl.textContent = iconOrText;
		} else {
			setIcon(iconEl, iconOrText);
		}
		
		const currentState = getCurrentState();
		const stateEl = btn.createEl("div", { 
			cls: "filter-state-text",
			text: this.getFilterButtonStyle(currentState).text
		});
		stateEl.style.fontSize = "0.7em";
		stateEl.style.marginTop = "2px";
		
		// Add count display
		const countEl = btn.createEl("div", { 
			cls: "filter-count-text",
			text: "(0)"
		});
		countEl.style.fontSize = "0.6em";
		countEl.style.marginTop = "1px";
		countEl.style.opacity = "0.8";
		
		const addFilterButtonStyles = (button: HTMLElement) => {
			button.style.padding = "4px 8px";
			button.style.border = "1px solid var(--interactive-normal)";
			button.style.borderRadius = "4px";
			button.style.cursor = "pointer";
			button.style.fontSize = "14px";
			button.style.minWidth = "32px";
			button.style.textAlign = "center";
		};
		
		addFilterButtonStyles(btn);
		const style = this.getFilterButtonStyle(currentState);
		btn.style.backgroundColor = style.backgroundColor;
		btn.style.color = style.color;
		btn.setAttribute("aria-label", tooltip);
		
		btn.onclick = async () => {
			const currentState = getCurrentState();
			const newState = this.cycleFilterState(currentState);
			onStateChange(newState);
			
			const newStyle = this.getFilterButtonStyle(newState);
			btn.style.backgroundColor = newStyle.backgroundColor;
			btn.style.color = newStyle.color;
			stateEl.textContent = newStyle.text;
			await this.renderContent();
			await this.updateRightPaneForSelections(); // Refresh right pane with new filters
			await this.updateFilterCounts(); // Update counts after filter change
		};
		
		// Return button and count update function
		return {
			button: btn,
			updateCount: (count: number) => {
				const state = getCurrentState();
				if (state === FilterState.OFF) {
					countEl.textContent = ""; // Don't show anything when off
				} else if (state === FilterState.EXCLUDE) {
					countEl.textContent = `(-${count})`;
				} else {
					countEl.textContent = `(${count})`;
				}
			}
		};
	}

	private applyFiltersToCards(cards: Flashcard[]): Flashcard[] {
		let filteredCards = cards;
		
		// Apply legacy filter if exists
		if (this.filter) filteredCards = filteredCards.filter(this.filter);
		
		// Apply three-state filters
		// First apply all INCLUDE_ONLY filters (must match ALL)
		if (this.flaggedFilter === FilterState.INCLUDE_ONLY) {
			filteredCards = filteredCards.filter((c) => c.flagged);
		}
		if (this.suspendedFilter === FilterState.INCLUDE_ONLY) {
			filteredCards = filteredCards.filter((c) => c.suspended);
		}
		if (this.buriedFilter === FilterState.INCLUDE_ONLY) {
			filteredCards = filteredCards.filter((c) => isBuried(c));
		}
		if (this.newFilter === FilterState.INCLUDE_ONLY) {
			filteredCards = filteredCards.filter((c) => isUnseen(c));
		}
		
		// Then apply all EXCLUDE filters (must match NONE)
		if (this.flaggedFilter === FilterState.EXCLUDE) {
			filteredCards = filteredCards.filter((c) => !c.flagged);
		}
		if (this.suspendedFilter === FilterState.EXCLUDE) {
			filteredCards = filteredCards.filter((c) => !c.suspended);
		}
		if (this.buriedFilter === FilterState.EXCLUDE) {
			filteredCards = filteredCards.filter((c) => !isBuried(c));
		}
		if (this.newFilter === FilterState.EXCLUDE) {
			filteredCards = filteredCards.filter((c) => !isUnseen(c));
		}
		
		return filteredCards;
	}

	private startCustomReviewSession(cards: Flashcard[]) {
		// Close the CardBrowser
		this.close();
		
		// Start custom review with the specific filtered cards
		this.plugin.startCustomReviewFromCards(cards);
	}

	private displayCardsInRightPane(cards: Flashcard[]) {
		this.editorPane.empty();
		
		if (cards.length === 0) {
			this.editorPane.setText("No cards found in selected items with current filters.");
			return;
		}

		// Add header showing selection info
		const headerEl = this.editorPane.createDiv({ cls: "gn-selection-header" });
		headerEl.style.padding = "8px";
		headerEl.style.marginBottom = "10px";
		headerEl.style.borderBottom = "1px solid var(--background-modifier-border)";
		headerEl.createEl("strong", { 
			text: `${cards.length} cards from ${this.selectedPaths.size} selected items` 
		});

		// Sort and display cards
		cards.sort((a, b) => (a.paraIdx ?? Infinity) - (b.paraIdx ?? Infinity));
		
		for (const card of cards) {
			const row = this.editorPane.createDiv({ cls: "gn-cardrow" });
			
			// Add status icons (same as existing logic)
			if (this.plugin.settings.showNewCardIndicators && isUnseen(card)) {
				row.createEl("span", { text: "🌱" }).style.marginRight = "4px";
			}
			if (isBuried(card)) {
				const iconSpan = row.createEl("span");
				iconSpan.style.marginRight = "4px";
				setIcon(iconSpan, "file-down");
			}
			if (card.suspended) {
				const iconSpan = row.createEl("span");
				iconSpan.style.marginRight = "4px";
				setIcon(iconSpan, "ban");
			}
			if (card.flagged) {
				const iconSpan = row.createEl("span");
				iconSpan.style.marginRight = "4px";
				setIcon(iconSpan, "flag");
			}
			
			// Add card label
			const labelSpan = row.createEl("span");
			const firstVariant = this.plugin.getCurrentVariant(card, 0);
			labelSpan.setText(firstVariant.front || "(empty front)");

			// Add chapter info
			const chapterSpan = row.createEl("span", { cls: "gn-chapter-info" });
			chapterSpan.style.marginLeft = "8px";
			chapterSpan.style.opacity = "0.7";
			chapterSpan.style.fontSize = "0.9em";
			chapterSpan.setText(`(${card.chapter})`);

			// Add click handler to edit card
			row.onclick = async () => {
				const deckPath = getDeckPathForChapter(card.chapter);
				const graph = await this.plugin.readDeck(deckPath);
				const deck = this.app.vault.getAbstractFileByPath(deckPath) as TFile;
				
				this.plugin.openEditModal(card, graph, deck, async () => {
					this.updateRightPaneForSelections(); // Refresh after editing
				});
			};

			// Add info button
			row.createEl("span", { text: "ℹ️", cls: "gn-info" }).onclick = (ev) => {
				ev.stopPropagation();
				new CardInfoModal(this.plugin.app, card).open();
			};

			// Add delete button
			row.createEl("span", {
				text: "🗑️",
				cls: "gn-trash",
			}).onclick = async (ev) => {
				ev.stopPropagation();
				if (!confirm("Delete this card permanently?")) return;
				
				// Get the deck for this card
				const deckPath = getDeckPathForChapter(card.chapter);
				const graph = await this.plugin.readDeck(deckPath);
				
				// Delete the card
				delete graph[card.id];
				await this.plugin.writeDeck(deckPath, graph);
				this.plugin.refreshAllStatuses();
				
				// Refresh the display
				this.updateRightPaneForSelections();
			};
		}
	}

	private saveBrowserState() {
		// Convert Set to array for serialization
		this.plugin.settings.cardBrowserExpandedSubjects = Array.from(this.state.openSubjects);
		
		// Save filter states to cardBrowserState
		this.state.flaggedFilter = this.flaggedFilter;
		this.state.suspendedFilter = this.suspendedFilter;
		this.state.buriedFilter = this.buriedFilter;
		this.state.newFilter = this.newFilter;
		
		this.plugin.saveSettings();
		
		this.plugin.logger(
			LogLevel.VERBOSE,
			`CardBrowser: Saved state -> ${this.plugin.settings.cardBrowserExpandedSubjects.length} expanded subjects, filters: ${this.flaggedFilter}/${this.suspendedFilter}/${this.buriedFilter}/${this.newFilter}`
		);
	}

	private loadBrowserState() {
		// Convert array back to Set and merge with existing state
		const savedSubjects = new Set(this.plugin.settings.cardBrowserExpandedSubjects);
		
		// Merge with any existing state (in case of multiple browser instances)
		savedSubjects.forEach(subject => this.state.openSubjects.add(subject));
		
		this.plugin.logger(
			LogLevel.VERBOSE,
			`CardBrowser: Loaded state -> ${savedSubjects.size} expanded subjects restored`
		);
	}

	private toggleExpandCollapseAll() {
		// Find all details elements (subject folders) in the tree pane
		const allDetails = this.treePane.querySelectorAll('details.gn-node') as NodeListOf<HTMLDetailsElement>;
		
		if (allDetails.length === 0) return;

		// Check if majority are expanded to determine toggle direction
		const expandedCount = Array.from(allDetails).filter(detail => detail.open).length;
		const shouldExpand = expandedCount < allDetails.length / 2;

		// Update button icon and label based on action
		const expandCollapseBtn = this.contentEl.querySelector('button.nav-action-button') as HTMLButtonElement;
		if (expandCollapseBtn) {
			if (shouldExpand) {
				expandCollapseBtn.setAttribute("aria-label", "Collapse all");
				setIcon(expandCollapseBtn, "chevrons-down-up");
			} else {
				expandCollapseBtn.setAttribute("aria-label", "Expand all"); 
				setIcon(expandCollapseBtn, "chevrons-up-down");
			}
		}

		// Toggle all details and update state
		allDetails.forEach(detail => {
			detail.open = shouldExpand;
			
			// Extract subject name from the details summary
			const summaryEl = detail.querySelector('summary');
			if (summaryEl) {
				const subject = summaryEl.textContent?.trim() || '';
				if (shouldExpand) {
					this.state.openSubjects.add(subject);
				} else {
					this.state.openSubjects.delete(subject);
				}
			}
		});

		this.plugin.logger(
			LogLevel.VERBOSE,
			`CardBrowser: ${shouldExpand ? 'Expanded' : 'Collapsed'} all ${allDetails.length} folders`
		);
	}

	protected onCloseContent() {
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onClose -> Closing modal."
		);
		this.plugin.logger(
			LogLevel.VERBOSE,
			"CardBrowser: onClose -> Final state on close:",
			{ ...this.state, openSubjects: [...this.state.openSubjects] }
		);
		
		// Save persistent browser state
		this.saveBrowserState();
		
		// Clean up timeout
		if (this.searchTimeout) {
			clearTimeout(this.searchTimeout);
		}
		
		// Clear selections
		this.selectedPaths.clear();
		
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

class ReviewAheadModal extends Modal {
	constructor(
		app: App,
		private studyMode: StudyMode,
		private onConfirm: (timeAheadMs: number) => Promise<void>,
		private onCancel: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		const modeNames = {
			[StudyMode.NOTE]: "note",
			[StudyMode.CUSTOM_SESSION]: "custom session", 
			[StudyMode.REVIEW]: "review-only"
		};

		contentEl.createEl("h2", { text: "No cards due for review" });
		contentEl.createEl("p", { 
			text: `There are no cards due for ${modeNames[this.studyMode]} mode. Would you like to review cards that are due in the future?` 
		});

		const inputContainer = contentEl.createDiv();
		inputContainer.style.marginBottom = "15px";

		const label = inputContainer.createEl("label", { text: "Review cards due within:" });
		label.style.display = "block";
		label.style.marginBottom = "5px";

		const input = inputContainer.createEl("input", {
			type: "text",
			placeholder: "e.g., 5m, 2.5h, 1d"
		});
		input.style.width = "100%";
		input.style.padding = "8px";
		input.style.border = "1px solid var(--interactive-normal)";
		input.style.borderRadius = "4px";

		const helpText = inputContainer.createEl("div", {
			text: "Formats: 5m (5 minutes), 2.5h (2.5 hours), 1d (1 day)"
		});
		helpText.style.fontSize = "12px";
		helpText.style.color = "var(--text-muted)";
		helpText.style.marginTop = "5px";

		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.display = "flex";
		buttonContainer.style.gap = "10px";
		buttonContainer.style.justifyContent = "flex-end";

		const cancelBtn = new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.close();
				this.onCancel();
			});

		const confirmBtn = new ButtonComponent(buttonContainer)
			.setButtonText("Review Ahead")
			.setCta()
			.onClick(async () => {
				const timeMs = parseTimeInput(input.value);
				if (timeMs === null) {
					new Notice("Invalid time format. Use formats like 5m, 2.5h, or 1d");
					input.focus();
					return;
				}
				this.close();
				await this.onConfirm(timeMs);
			});

		// Focus input and allow Enter to submit
		input.focus();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				confirmBtn.buttonEl.click();
			} else if (e.key === "Escape") {
				cancelBtn.buttonEl.click();
			}
		});
	}
}

class UnusedImageReviewModal extends Modal {
	constructor(
		app: App,
		private unusedImages: TFile[],
		private onConfirm: (imagesToDelete: TFile[]) => Promise<void>
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", {
			text: `Review ${this.unusedImages.length} Unused Images`,
		});
		contentEl.createEl("p", {
			text: "These images don't appear to be referenced in any notes. Select which ones to delete:",
		});

		const scrollContainer = contentEl.createDiv({
			attr: {
				style: "max-height: 60vh; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 10px;",
			},
		});

		const imagesToDelete = new Set<TFile>();

		for (const image of this.unusedImages) {
			const imageContainer = scrollContainer.createDiv({
				attr: {
					style: "display: flex; align-items: center; margin: 10px 0; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px;",
				},
			});

			// Checkbox
			const checkbox = imageContainer.createEl("input", {
				type: "checkbox",
				attr: { style: "margin-right: 10px;" },
			});

			// Image preview
			const imagePreview = imageContainer.createEl("img", {
				attr: {
					src: this.app.vault.adapter.getResourcePath(image.path),
					style: "width: 100px; height: 100px; object-fit: cover; margin-right: 10px; border-radius: 4px;",
				},
			});

			// Image info
			const infoContainer = imageContainer.createDiv({
				attr: { style: "flex: 1;" },
			});

			infoContainer.createEl("div", {
				text: image.name,
				attr: { style: "font-weight: bold;" },
			});

			infoContainer.createEl("div", {
				text: image.path,
				attr: { style: "color: var(--text-muted); font-size: 0.9em;" },
			});

			// File size
			try {
				const stat = this.app.vault.adapter.stat(image.path);
				stat.then((s) => {
					if (s) {
						const sizeKB = Math.round(s.size / 1024);
						infoContainer.createEl("div", {
							text: `${sizeKB} KB`,
							attr: {
								style: "color: var(--text-muted); font-size: 0.8em;",
							},
						});
					}
				});
			} catch (error) {
				// Ignore stat errors
			}

			// Handle checkbox changes
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					imagesToDelete.add(image);
				} else {
					imagesToDelete.delete(image);
				}
			});
		}

		// Action buttons
		const buttonContainer = contentEl.createDiv({
			attr: { style: "margin-top: 20px; text-align: right;" },
		});

		// Select All / Deselect All
		const toggleButton = new ButtonComponent(buttonContainer)
			.setButtonText("Select All")
			.onClick(() => {
				const checkboxes = scrollContainer.querySelectorAll(
					'input[type="checkbox"]'
				);
				const allChecked = Array.from(checkboxes).every(
					(cb: any) => cb.checked
				);

				checkboxes.forEach((cb: any, index) => {
					cb.checked = !allChecked;
					if (!allChecked) {
						imagesToDelete.add(this.unusedImages[index]);
					} else {
						imagesToDelete.delete(this.unusedImages[index]);
					}
				});

				toggleButton.setButtonText(
					allChecked ? "Select All" : "Deselect All"
				);
			});

		buttonContainer.createSpan({ text: " " });

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.close();
			});

		buttonContainer.createSpan({ text: " " });

		new ButtonComponent(buttonContainer)
			.setButtonText("Delete Selected")
			.setCta()
			.onClick(async () => {
				await this.onConfirm(Array.from(imagesToDelete));
				this.close();
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
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
			.setName("Show new card indicators")
			.setDesc("Display green leaf (🌱) indicators for new flashcards in review and browser.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showNewCardIndicators)
					.onChange(async (value) => {
						this.plugin.settings.showNewCardIndicators = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show review cards before new cards (Chapter Focus)")
			.setDesc("In chapter focus mode, prioritize due review cards over new cards.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.chapterFocusReviewsFirst)
					.onChange(async (value) => {
						this.plugin.settings.chapterFocusReviewsFirst = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable smart interleaving")
			.setDesc("Randomly order cards while favoring more overdue ones (Subject/Review-only modes).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableInterleaving)
					.onChange(async (value) => {
						this.plugin.settings.enableInterleaving = value;
						await this.plugin.saveSettings();
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
 * Checks if a flashcard is buried (was manually buried and due time <= now).
 * @param card The flashcard to check.
 * @returns True if the card is buried, false otherwise.
 */
const isBuried = (card: Flashcard): boolean => !!card.buried && card.due <= Date.now();

/**
 * Parses time input strings like "5m", "2.5h", "1d" into milliseconds.
 * @param input The time string to parse.
 * @returns Milliseconds, or null if invalid input.
 */
const parseTimeInput = (input: string): number | null => {
	const trimmed = input.trim().toLowerCase();
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([mhd]?)$/);
	
	if (!match) return null;
	
	const value = parseFloat(match[1]);
	const unit = match[2] || 'm'; // default to minutes if no unit
	
	switch (unit) {
		case 'm': return value * 60 * 1000; // minutes to ms
		case 'h': return value * 60 * 60 * 1000; // hours to ms  
		case 'd': return value * 24 * 60 * 60 * 1000; // days to ms
		default: return null;
	}
};

/**
 * Calculates how many seconds a card is overdue (0 if not overdue).
 */
const getOverdueSeconds = (card: Flashcard): number => {
	const now = Date.now();
	return Math.max(0, Math.floor((now - card.due) / 1000));
};

/**
 * Samples from a weighted cumulative distribution.
 * @param cumulativeWeights Array of cumulative weights (should end with total weight)
 * @returns The index of the selected item
 */
const sampleFromCumulative = (cumulativeWeights: number[]): number => {
	if (cumulativeWeights.length === 0) return -1;
	if (cumulativeWeights.length === 1) return 0;
	
	const total = cumulativeWeights[cumulativeWeights.length - 1];
	if (total <= 0) return Math.floor(Math.random() * cumulativeWeights.length);
	
	const random = Math.random() * total;
	let selectedIndex = cumulativeWeights.length - 1;
	
	for (let i = 0; i < cumulativeWeights.length; i++) {
		if (random <= cumulativeWeights[i]) {
			selectedIndex = i;
			break;
		}
	}
	
	// Note: Could add logging here, but it would be called from plugin context
	// Individual sampling methods handle their own logging
	
	return selectedIndex;
};

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

interface TreeNode {
	name: string;
	path: string;
	type: "folder" | "note";
	children: Map<string, TreeNode>;
	expanded: boolean;
	hasChildren: boolean;
}

/**
 * Dialog for selecting a folder for custom session study mode
 */
class CustomSessionDialog extends Modal {
	private selectedPaths: Set<string> = new Set();
	private excludeNewCards: boolean = true;
	private treeStructure: TreeNode | null = null;

	constructor(app: App, private onConfirm: (paths: string[], excludeNewCards: boolean) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("📁 Select Custom Session Folder");

		const { contentEl } = this;
		contentEl.empty();

		// Description
		contentEl.createEl("p", {
			text: "Select folders to study flashcards from those folders and their subfolders. Click folders to toggle selection:",
		});

		// Exclude new cards option
		const optionsContainer = contentEl.createEl("div", {
			attr: { style: "margin: 15px 0; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px;" }
		});

		optionsContainer.createEl("h4", { text: "Study Options:" });
		
		const radioContainer = optionsContainer.createEl("div", {
			attr: { style: "display: flex; align-items: center; gap: 10px;" }
		});

		const excludeNewCardsCheckbox = radioContainer.createEl("input", {
			type: "checkbox",
			attr: { id: "exclude-new-cards-checkbox" }
		});
		excludeNewCardsCheckbox.checked = this.excludeNewCards;
		
		radioContainer.createEl("label", {
			text: "Exclude new cards (review-only mode)",
			attr: { for: "exclude-new-cards-checkbox" }
		});

		excludeNewCardsCheckbox.onchange = () => {
			this.excludeNewCards = excludeNewCardsCheckbox.checked;
		};

		// Build folder tree from existing deck files
		this.buildFolderTree(contentEl);

		// Buttons
		const buttonContainer = contentEl.createEl("div", {
			cls: "modal-button-container",
		});

		buttonContainer.createEl("button", {
			text: "Study Vault Root",
			cls: "mod-cta",
		}).onclick = () => {
			this.onConfirm([], this.excludeNewCards);
			this.close();
		};

		buttonContainer.createEl("button", {
			text: "Cancel",
		}).onclick = () => {
			this.close();
		};
	}

	private buildFolderTree(container: HTMLElement) {
		// Build folder structure with expandable folders and note files
		const treeContainer = container.createEl("div", {
			cls: "custom-session-tree",
			attr: { 
				style: "max-height: 300px; overflow-y: auto; border: 1px solid var(--background-modifier-border); padding: 10px; margin: 10px 0;" 
			}
		});

		// Get all finalized notes (notes that have _flashcards.json in their folder)
		const finalizedNotes = this.getFinalizedNotes();
		
		// Build tree structure starting from root level
		this.treeStructure = this.buildTreeStructure(finalizedNotes);
		
		// Render the tree starting from root
		this.renderTreeLevel(treeContainer, this.treeStructure, "", 0, container);
	}

	private getFinalizedNotes(): string[] {
		const deckFiles = this.app.vault
			.getFiles()
			.filter((f) => f.name === DECK_FILE_NAME);

		const finalizedNotes: string[] = [];

		for (const deckFile of deckFiles) {
			const folderPath = deckFile.path.replace(`/${DECK_FILE_NAME}`, "");
			
			// Find all markdown files in this folder
			const notesInFolder = this.app.vault
				.getFiles()
				.filter(f => 
					f.extension === "md" && 
					(folderPath === "" ? !f.path.includes("/") : f.path.startsWith(folderPath + "/") && f.path.split("/").length === folderPath.split("/").length + 1)
				)
				.map(f => f.path);

			finalizedNotes.push(...notesInFolder);
		}

		return finalizedNotes;
	}

	private buildTreeStructure(finalizedNotes: string[]): TreeNode {
		const root: TreeNode = { 
			name: "", 
			path: "", 
			type: "folder", 
			children: new Map(), 
			expanded: false,
			hasChildren: false
		};

		// Add all finalized notes to the tree structure
		for (const notePath of finalizedNotes) {
			this.addNoteToTree(root, notePath);
		}

		// Remove empty folders recursively
		this.pruneEmptyFolders(root);

		return root;
	}

	private addNoteToTree(root: TreeNode, notePath: string) {
		const parts = notePath.split("/");
		let currentNode = root;

		// Navigate through folders
		for (let i = 0; i < parts.length - 1; i++) {
			const folderName = parts[i];
			const folderPath = parts.slice(0, i + 1).join("/");

			if (!currentNode.children.has(folderName)) {
				currentNode.children.set(folderName, {
					name: folderName,
					path: folderPath,
					type: "folder",
					children: new Map(),
					expanded: false,
					hasChildren: false
				});
			}

			currentNode = currentNode.children.get(folderName)!;
		}

		// Add the note file
		const fileName = parts[parts.length - 1];
		const noteName = fileName.replace(".md", "");
		
		currentNode.children.set(fileName, {
			name: noteName,
			path: notePath,
			type: "note",
			children: new Map(),
			expanded: false,
			hasChildren: false
		});
	}

	private pruneEmptyFolders(node: TreeNode): boolean {
		if (node.type === "note") {
			return true; // Notes are always kept
		}

		// Check children recursively
		const childrenToKeep: string[] = [];
		for (const [childName, child] of node.children) {
			if (this.pruneEmptyFolders(child)) {
				childrenToKeep.push(childName);
			}
		}

		// Remove empty children
		for (const [childName] of node.children) {
			if (!childrenToKeep.includes(childName)) {
				node.children.delete(childName);
			}
		}

		// Update hasChildren flag
		node.hasChildren = node.children.size > 0;

		// Return true if this folder should be kept (has children)
		return node.children.size > 0 || node.path === ""; // Always keep root
	}

	private renderTreeLevel(
		treeContainer: HTMLElement,
		treeNode: TreeNode,
		currentPath: string,
		level: number,
		container: HTMLElement
	) {
		// Sort children: folders first, then notes, both alphabetically
		const sortedChildren = Array.from(treeNode.children.entries()).sort(([aName, aNode], [bName, bNode]) => {
			if (aNode.type !== bNode.type) {
				return aNode.type === "folder" ? -1 : 1;
			}
			return aName.localeCompare(bName);
		});

		for (const [childName, childNode] of sortedChildren) {
			const element = treeContainer.createEl("div", {
				cls: childNode.type === "folder" ? "custom-session-folder" : "custom-session-note",
				attr: { 
					style: `margin-left: ${level * 20}px; padding: 4px; cursor: pointer; border-radius: 4px; display: flex; align-items: center;`,
					"data-path": childNode.path
				}
			});

			// Add expand/collapse icon for folders with children
			if (childNode.type === "folder" && childNode.hasChildren) {
				const expandIcon = element.createEl("span", {
					text: childNode.expanded ? "▼" : "▶",
					attr: { 
						style: "margin-right: 4px; font-size: 10px; cursor: pointer;",
						"data-action": "expand"
					}
				});

				expandIcon.onclick = (e) => {
					e.stopPropagation();
					// Toggle expansion
					childNode.expanded = !childNode.expanded;
					this.rebuildTree(treeContainer, container);
				};
			} else {
				// Spacer for alignment
				element.createEl("span", {
					text: " ",
					attr: { style: "margin-right: 14px;" }
				});
			}

			// Add icon and name
			const icon = childNode.type === "folder" ? "📁" : "📝";
			const contentEl = element.createEl("span", {
				text: `${icon} ${childNode.name}`,
			});

			// Apply selection styling
			if (this.selectedPaths.has(childNode.path)) {
				element.addClass("selected");
				element.style.backgroundColor = "var(--interactive-accent)";
				element.style.color = "var(--text-on-accent)";
			}

			// Handle selection toggle (avoid clicking on expand icon)
			element.onclick = (e) => {
				if ((e.target as HTMLElement).getAttribute("data-action") === "expand") {
					return; // Let expand icon handle this
				}

				e.stopPropagation();
				
				// Toggle selection
				const isSelected = this.selectedPaths.has(childNode.path);
				if (isSelected) {
					this.selectedPaths.delete(childNode.path);
				} else {
					this.selectedPaths.add(childNode.path);
				}
				
				this.rebuildTree(treeContainer, container);
				this.updateConfirmButton(container);
			};

			// Recursively render expanded children
			if (childNode.type === "folder" && childNode.expanded && childNode.hasChildren) {
				this.renderTreeLevel(treeContainer, childNode, childNode.path, level + 1, container);
			}
		}
	}

	private rebuildTree(treeContainer: HTMLElement, container: HTMLElement) {
		// Clear and re-render the tree to maintain expansion and selection state
		treeContainer.empty();
		
		// Re-render using existing tree structure (preserves expansion state)
		if (this.treeStructure) {
			this.renderTreeLevel(treeContainer, this.treeStructure, "", 0, container);
		}
	}

	private updateConfirmButton(container: HTMLElement) {
		const confirmBtn = container.querySelector(".mod-cta") as HTMLButtonElement;
		if (!confirmBtn) return;

		const selectedCount = this.selectedPaths.size;
		
		if (selectedCount === 0) {
			confirmBtn.textContent = "Study Vault Root";
			confirmBtn.onclick = () => {
				this.onConfirm([], this.excludeNewCards);
				this.close();
			};
		} else {
			const folderText = selectedCount === 1 
				? "1 folder" 
				: `${selectedCount} folders`;
			confirmBtn.textContent = `Study ${folderText}`;
			confirmBtn.onclick = () => {
				this.onConfirm(Array.from(this.selectedPaths), this.excludeNewCards);
				this.close();
			};
		}
	}

	onClose() {
		this.selectedPaths.clear();
		this.treeStructure = null;
	}
}

class StudyOverviewModal extends Modal {
	constructor(private plugin: GatedNotesPlugin) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Study Overview");
		makeModalDraggable(this, this.plugin);

		// Show loading message
		const loadingEl = this.contentEl.createEl("p", {
			text: "Gathering statistics..."
		});

		try {
			// Gather statistics
			const stats = await this.plugin.gatherVaultStatistics();

			// Remove loading message
			loadingEl.remove();

			// Create main container
			const container = this.contentEl.createDiv({
				attr: {
					style: "font-family: var(--font-monospace); white-space: pre-line; font-size: 14px; line-height: 1.4;"
				}
			});

			// Build the overview text
			let overview = "=== Vault Study Overview ===\n\n";
			
			overview += `Total Cards: ${stats.totalCards.toLocaleString()}\n`;
			if (stats.totalCards > 0) {
				overview += `├─ New: ${stats.byStatus.new.toLocaleString()}\n`;
				overview += `├─ Learning: ${stats.byStatus.learning.toLocaleString()}\n`;
				overview += `├─ Review: ${stats.byStatus.review.toLocaleString()}\n`;
				overview += `└─ Relearn: ${stats.byStatus.relearn.toLocaleString()}\n\n`;

				overview += "Status Breakdown:\n";
				
				// Build status items array first, then format with correct tree structure
				const statusItems = [
					`Due: ${stats.byState.due.toLocaleString()}`
				];
				if (stats.byState.blocked > 0) statusItems.push(`Blocked: ${stats.byState.blocked.toLocaleString()}`);
				if (stats.byState.suspended > 0) statusItems.push(`Suspended: ${stats.byState.suspended.toLocaleString()}`);
				if (stats.byState.buried > 0) statusItems.push(`Buried: ${stats.byState.buried.toLocaleString()}`);
				if (stats.byState.flagged > 0) statusItems.push(`Flagged: ${stats.byState.flagged.toLocaleString()}`);
				if (stats.byState.missingParaIdx > 0) statusItems.push(`Missing Paragraph Index: ${stats.byState.missingParaIdx.toLocaleString()}`);
				
				statusItems.forEach((item, index) => {
					const isLast = index === statusItems.length - 1;
					const prefix = isLast ? "└─" : "├─";
					overview += `${prefix} ${item}\n`;
				});

				if (stats.bySubject.length > 0) {
					overview += "\nBy Subject:\n";
					stats.bySubject.forEach((subject, index) => {
						const isLast = index === stats.bySubject.length - 1;
						const prefix = isLast ? "└─" : "├─";
						let subjectLine = `${prefix} ${subject.subject}: ${subject.total.toLocaleString()} cards`;
						
						const details = [];
						if (subject.due > 0) details.push(`${subject.due} due`);
						if (subject.blocked > 0) details.push(`${subject.blocked} blocked`);
						
						if (details.length > 0) {
							subjectLine += ` (${details.join(", ")})`;
						}
						overview += subjectLine + "\n";
					});
				}
			} else {
				overview += "\nNo flashcards found in vault.\n";
			}

			container.setText(overview);

			// Add refresh button
			const buttonContainer = this.contentEl.createDiv({
				attr: { style: "margin-top: 20px; text-align: center;" }
			});

			const refreshButton = buttonContainer.createEl("button", {
				text: "Refresh",
				attr: { style: "padding: 8px 16px;" }
			});

			refreshButton.onclick = async () => {
				this.close();
				new StudyOverviewModal(this.plugin).open();
			};

		} catch (error) {
			loadingEl.setText("Error gathering statistics: " + error);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
