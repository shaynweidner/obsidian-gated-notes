export interface LlmLogEntry {
	timestamp: number; // Changed from string to number to match actual usage
	model: string;
	action:
		| "generate"
		| "generate_additional"
		| "edit"
		| "image_analysis"
		| "text_extraction"
		| "other"
		| "refocus"
		| "split"
		| "correct_tag"
		| "analyze_image"
		| "generate_from_selection_single"
		| "generate_from_selection_many"
		| "pdf_to_note"; // Added missing action types used in code
	inputTokens: number;
	outputTokens: number;
	costUsd?: number; // Made optional since it's often calculated elsewhere
	cost?: number | null; // Alternative property name used in some places
	cardsGenerated?: number; // Optional property used for card generation
	textContentTokens?: number; // Optional property used for PDF processing
}

export interface GetDynamicInputsResult {
	promptText: string;
	imageCount: number;
	action: LlmLogEntry["action"];
	details?: {
		cardCount?: number;
		textContentTokens?: number;
		isVariableOutput?: boolean;
		isHybrid?: boolean;
		pageCount?: number;
		useNuclearOption?: boolean;
		nuclearMultiplier?: number;
	};
}
