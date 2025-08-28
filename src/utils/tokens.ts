import { encode as gptEncode } from "gpt-tokenizer";
import { IMAGE_TOKEN_COST } from "../constants";

export function countTextTokens(text: string): number {
	try {
		return gptEncode(text).length;
	} catch (error) {
		// Fallback estimation: ~4 characters per token
		return Math.ceil(text.length / 4);
	}
}

export function calculateImageTokens(imageCount: number): number {
	return imageCount * IMAGE_TOKEN_COST;
}
