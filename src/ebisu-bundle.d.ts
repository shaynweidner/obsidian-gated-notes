// Type declarations for bundled ebisu-js
declare module 'ebisu-js/dist/ebisu.min.mjs' {
	export type EbisuModel = [number, number, number];

	export function defaultModel(halflife: number, alpha?: number, beta?: number): EbisuModel;

	export function predictRecall(model: EbisuModel, tnow: number, exact?: boolean): number;

	export function updateRecall(
		prior: EbisuModel,
		successes: number,
		total: number,
		tnow: number,
		rebalance?: boolean,
		tback?: number,
		options?: { useLog?: boolean; tolerance?: number }
	): EbisuModel;

	export function modelToPercentileDecay(model: EbisuModel, percentile?: number, tolerance?: number): number;

	export function rescaleHalflife(model: EbisuModel, scale?: number): EbisuModel;
}
