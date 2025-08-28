import { App, Plugin, TFile } from "obsidian";
import {
	Settings,
	LogLevel,
	FlashcardGraph,
	Flashcard,
	StudyMode,
} from "./index";

/**
 * Interface defining the contract for the GatedNotesPlugin.
 * This allows other files to depend on the interface instead of the concrete implementation,
 * preventing circular dependencies.
 */
export interface GatedNotesPluginInterface extends Plugin {
	app: App;
	settings: Settings;
	lastModalTransform: string | null;
	studyMode: StudyMode;

	// Service instances
	imageManager: any;
	imageStitcher: any;
	snippingTool: any;
	cardService: any;
	llmService: any;
	settingsService: any;
	imageAnalysisService: any;
	noteProcessingService: any;
	fileManagementService: any;
	deckService: any;
	cardAlgorithmService: any;

	// Core methods that other files need
	logger(level: LogLevel, message: string, error?: any): void;

	// Settings management
	loadSettings(): Promise<void>;
	saveSettings(): Promise<void>;


	// Card operations
	openEditModal(
		card: Flashcard,
		graph: FlashcardGraph,
		deck: TFile,
		callback: () => void,
		reviewContext?: any,
		parentContext?: any
	): void;
	renderCardContent(
		content: string,
		container: HTMLElement,
		sourcePath: string
	): Promise<void>;
	promptToReviewNewCards(
		cards: Flashcard[],
		deck: TFile,
		graph: FlashcardGraph
	): Promise<void>;

	// UI operations
	refreshAllStatuses(): void;
	refreshReading(): void;
	refreshReadingAndPreserveScroll(): Promise<void>;
	refreshDueCardStatus(): void;
	createCostEstimatorUI(container: HTMLElement, getCostInfo: () => any): any;

	// LLM operations
	sendToLlm(
		prompt: string,
		imageData?: string | string[],
		options?: any
	): Promise<{ content: string; usage?: any }>;
	fetchAvailableModels(): Promise<string[]>;

	// Additional methods needed by services
	getFirstBlockedParaIndex(
		chapterPath: string,
		graphToUse?: FlashcardGraph
	): Promise<number>;
	getParagraphs(file: TFile): Promise<any[]>;
}
