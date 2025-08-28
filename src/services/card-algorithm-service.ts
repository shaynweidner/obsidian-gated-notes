import { Flashcard, CardRating, ReviewLog } from "../types";

/**
 * Service for card-related algorithms and utilities
 */
export class CardAlgorithmService {
	/**
	 * Apply SM-2 spaced repetition algorithm to a card based on user rating
	 */
	applySm2(card: Flashcard, rating: CardRating): void {
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
		} else if (rating === "Hard") {
			if (originalStatus === "learning") {
				card.learning_step_index = 0;
				card.due = now + 6 * ONE_MINUTE_MS;
			} else {
				card.ease_factor = Math.max(1.3, card.ease_factor - 0.15);
				card.interval = Math.ceil(card.interval * 1.2);
				card.due = now + card.interval * ONE_DAY_MS;
			}
		} else if (rating === "Good") {
			if (originalStatus === "learning" || originalStatus === "relearn") {
				const steps = [1, 10];
				card.learning_step_index = card.learning_step_index || 0;
				if (card.learning_step_index < steps.length - 1) {
					card.learning_step_index++;
					card.due = now + steps[card.learning_step_index] * ONE_MINUTE_MS;
				} else {
					card.status = "review";
					card.interval = 1;
					card.due = now + ONE_DAY_MS;
					delete card.learning_step_index;
				}
			} else {
				card.interval = Math.ceil(card.interval * card.ease_factor);
				card.due = now + card.interval * ONE_DAY_MS;
			}
		} else if (rating === "Easy") {
			if (originalStatus === "learning" || originalStatus === "relearn") {
				card.status = "review";
				card.interval = 4;
				card.due = now + 4 * ONE_DAY_MS;
				delete card.learning_step_index;
			} else {
				card.ease_factor += 0.15;
				card.interval = Math.ceil(card.interval * card.ease_factor * 1.3);
				card.due = now + card.interval * ONE_DAY_MS;
			}
		}

		card.last_reviewed = new Date(now).toISOString();
	}

	/**
	 * Reset a card's progress to new status
	 */
	resetCardProgress(card: Flashcard): void {
		card.status = "new";
		card.last_reviewed = null;
		card.interval = 0;
		card.ease_factor = 2.5;
		card.due = Date.now();
		card.blocked = true;
		card.review_history = [];
		delete card.learning_step_index;
	}

	/**
	 * Create a new flashcard object with default values
	 */
	createCardObject(
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
}