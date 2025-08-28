// File and API constants
export const DECK_FILE_NAME = "_flashcards.json";
export const IMAGE_ANALYSIS_FILE_NAME = "_images.json";
export const LLM_LOG_FILE = "_llm_log.json";
export const SPLIT_TAG = "---GATED-NOTES-SPLIT---";

// DOM constants
export const PARA_CLASS = "gn-paragraph";
export const PARA_ID_ATTR = "data-para-id";
export const PARA_MD_ATTR = "data-gn-md";

// API endpoints (now using OpenAI package methods instead of direct URLs)
// export const API_URL_COMPLETIONS = "https://api.openai.com/v1/chat/completions";
// export const API_URL_MODELS = "https://api.openai.com/v1/models";

// Token costs
export const IMAGE_TOKEN_COST = 1105;

// UI constants
export const ICONS = {
	blocked: "⏳",
	due: "📆",
	done: "✅",
	settings: "⚙️",
};

export const HIGHLIGHT_COLORS = {
	unlocked: "rgba(0, 255, 0, 0.3)",
	context: "var(--text-highlight-bg)",
	failed: "rgba(255, 0, 0, 0.3)",
};
