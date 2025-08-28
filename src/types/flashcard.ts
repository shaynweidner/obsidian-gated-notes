export type CardStatus =
	| "new"
	| "learning"
	| "review"
	| "relearn"
	| "graduated";

export type CardRating = "Again" | "Hard" | "Good" | "Easy";

export interface ReviewLog {
	timestamp?: number; // Made optional for flexibility
	date?: string; // Alternative property name
	rating: CardRating | 1 | 2 | 3 | 4 | string; // Support both CardRating and numeric ratings
	state?: CardStatus; // Made optional since not always present
	ease_factor: number;
	interval: number;
	due?: number; // Made optional since not always present in creation
	review_time_ms?: number; // Made optional since not always used
}

export interface Flashcard {
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

export interface FlashcardGraph {
	[id: string]: Flashcard;
}

export interface CardBrowserState {
	openSubjects: Set<string>;
	activeChapterPath: string | null;
	treeScroll: number;
	editorScroll: number;
	isFirstRender: boolean;
}
