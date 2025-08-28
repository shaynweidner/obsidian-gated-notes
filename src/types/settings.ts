export interface Settings {
	openaiApiKey: string;
	openaiModel: string;
	openaiTemperature: number;
	availableModels: string[];
	learningSteps: number[];
	relearnSteps: number[];
	buryDelayHours: number;
	gatingEnabled: boolean;
	blockedBgColor: string;
	unblockedBgColor: string;
	chapterBgColor: string;
	targetParasPerCard: number;
	chapterTitleStyle: "underline" | "bold" | "italic";
	cardGenDebugMode: boolean;
	autoRefocusEnabled: boolean;
	autoRefocusDelay: number;
	baseUrl: string;
	costMode: "openai" | "lmstudio";
	// Additional properties found in the code
	logLevel: number;
	apiProvider: "openai" | "lmstudio";
	lmStudioUrl: string;
	lmStudioModel: string;
	openaiMultimodalModel: string;
	analyzeImagesOnGenerate: boolean;
	autoCorrectTags: boolean;
	maxTagCorrectionRetries: number;
}

export const DEFAULT_SETTINGS: Settings = {
	openaiApiKey: "",
	openaiModel: "gpt-4o-mini",
	openaiTemperature: 0.1,
	availableModels: ["gpt-4o", "gpt-4o-mini", "gpt-4o-2024-08-06"],
	learningSteps: [1, 10],
	relearnSteps: [10],
	buryDelayHours: 4,
	gatingEnabled: true,
	blockedBgColor: "#fee2e2",
	unblockedBgColor: "#ffffff",
	chapterBgColor: "#fef3c7",
	targetParasPerCard: 1,
	chapterTitleStyle: "underline",
	cardGenDebugMode: false,
	autoRefocusEnabled: false,
	autoRefocusDelay: 2000,
	baseUrl: "https://api.openai.com/v1",
	costMode: "openai",
	// Additional properties found in the code
	logLevel: 1,
	apiProvider: "openai",
	lmStudioUrl: "http://localhost:1234",
	lmStudioModel: "gpt-3.5-turbo",
	openaiMultimodalModel: "gpt-4o",
	analyzeImagesOnGenerate: false,
	autoCorrectTags: false,
	maxTagCorrectionRetries: 3,
};
