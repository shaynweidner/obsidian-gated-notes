// ebisu_scheduler.ts - Ebisu-based spaced repetition scheduling
// Import from the pre-bundled ESM version that has all dependencies included
import * as ebisu from 'ebisu-js/dist/ebisu.min.mjs';

/**
 * Ebisu model: [alpha, beta, time]
 * - alpha, beta: parameters of Beta distribution for recall probability
 * - time: half-life (time at which recall probability = 0.5)
 */
export type EbisuModel = [number, number, number];

/**
 * Configuration for Ebisu algorithm
 */
export interface EbisuConfig {
	// Default model parameters for new cards
	defaultHalflife: number;  // Initial half-life in hours
	defaultAlpha: number;     // Alpha parameter (higher = more confident in halflife)
	defaultBeta: number;      // Beta parameter (should equal alpha for symmetric prior)

	// Update parameters: how to interpret each rating as success/total trials
	// Format: { numerator, denominator } representing successes/total
	updateParams: {
		again: { successes: number; total: number };  // e.g., 0/1 (complete failure)
		hard: { successes: number; total: number };   // e.g., 1/2 (partial success)
		good: { successes: number; total: number };   // e.g., 1/1 (success)
		easy: { successes: number; total: number };   // e.g., 1/1 (success)
	};

	// Target recall probability for scheduling
	targetRecall: number;  // e.g., 0.85 (85% recall)
}

/**
 * Default Ebisu configuration
 */
export const DEFAULT_EBISU_CONFIG: EbisuConfig = {
	// New cards: 24 hour half-life with moderate confidence
	defaultHalflife: 24,
	defaultAlpha: 3.0,
	defaultBeta: 3.0,

	// Rating interpretations
	updateParams: {
		again: { successes: 0, total: 1 },   // Complete failure
		hard: { successes: 1, total: 2 },    // 50% success (struggling)
		good: { successes: 1, total: 1 },    // Full success
		easy: { successes: 1, total: 1 },    // Full success (could boost with scale later)
	},

	// Schedule for 85% target recall
	targetRecall: 0.85,
};

/**
 * Create a default Ebisu model for a new card
 */
export function createDefaultModel(config: EbisuConfig): EbisuModel {
	return ebisu.defaultModel(config.defaultHalflife, config.defaultAlpha, config.defaultBeta);
}

/**
 * Predict recall probability at current time
 *
 * @param model - Current Ebisu model
 * @param elapsedHours - Hours since last review
 * @returns Predicted recall probability (0 to 1)
 */
export function predictRecall(model: EbisuModel, elapsedHours: number): number {
	return ebisu.predictRecall(model, elapsedHours, true);
}

/**
 * Update model after a quiz/review
 *
 * @param model - Current Ebisu model
 * @param rating - User's rating (Again, Hard, Good, Easy)
 * @param elapsedHours - Hours since last review
 * @param config - Ebisu configuration
 * @returns Updated Ebisu model
 */
export function updateModel(
	model: EbisuModel,
	rating: "Again" | "Hard" | "Good" | "Easy",
	elapsedHours: number,
	config: EbisuConfig
): EbisuModel {
	const params = config.updateParams[rating.toLowerCase() as keyof typeof config.updateParams];
	return ebisu.updateRecall(model, params.successes, params.total, elapsedHours);
}

/**
 * Calculate the optimal review interval to achieve target recall
 *
 * @param model - Current Ebisu model
 * @param config - Ebisu configuration
 * @returns Recommended interval in hours
 */
export function getRecommendedInterval(model: EbisuModel, config: EbisuConfig): number {
	// Use modelToPercentileDecay to find when recall drops to target
	return ebisu.modelToPercentileDecay(model, config.targetRecall);
}

/**
 * Get the half-life (50% recall time) for a model
 */
export function getHalflife(model: EbisuModel): number {
	return ebisu.modelToPercentileDecay(model, 0.5);
}

/**
 * Manually rescale the half-life of a model
 * Useful if user wants to see a card more/less frequently
 *
 * @param model - Current model
 * @param scale - Multiplier (e.g., 2.0 = twice as long, 0.5 = half as long)
 * @returns Rescaled model
 */
export function rescaleHalflife(model: EbisuModel, scale: number): EbisuModel {
	return ebisu.rescaleHalflife(model, scale);
}

/**
 * Convert Ebisu model to human-readable string
 */
export function modelToString(model: EbisuModel): string {
	const [alpha, beta, time] = model;
	const halflife = getHalflife(model);
	return `α=${alpha.toFixed(2)}, β=${beta.toFixed(2)}, t=${time.toFixed(1)}h (halflife=${halflife.toFixed(1)}h)`;
}
