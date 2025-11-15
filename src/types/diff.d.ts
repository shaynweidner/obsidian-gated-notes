declare module 'diff' {
	export interface Change {
		value: string;
		added?: boolean;
		removed?: boolean;
	}

	export function diffWordsWithSpace(oldStr: string, newStr: string): Change[];
}