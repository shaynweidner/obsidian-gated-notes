export function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractJsonArray<T>(s: string): T[] {
	const jsonArrayRegex = /\[[\s\S]*?\]/g;
	const matches = s.match(jsonArrayRegex);

	if (!matches) return [];

	const results: T[] = [];
	for (const match of matches) {
		try {
			const fixed = fixCommonJsonIssues(match);
			const parsed = JSON.parse(fixed);
			if (Array.isArray(parsed)) {
				results.push(...parsed);
			}
		} catch (error) {
			console.warn("Failed to parse JSON array:", match, error);
		}
	}

	return results;
}

export function extractJsonObjects<T>(s: string): T[] {
	const jsonObjectRegex = /\{[\s\S]*?\}/g;
	const matches = s.match(jsonObjectRegex);

	if (!matches) return [];

	const results: T[] = [];
	for (const match of matches) {
		try {
			const fixed = fixCommonJsonIssues(match);
			const parsed = JSON.parse(fixed);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				results.push(parsed);
			}
		} catch (error) {
			console.warn("Failed to parse JSON object:", match, error);
		}
	}

	return results;
}

export function fixCommonJsonIssues(jsonString: string): string {
	let fixed = jsonString;

	// Remove trailing commas
	fixed = fixed.replace(/,(\s*[}\]])/g, "$1");

	// Fix unescaped quotes in strings
	fixed = fixed.replace(
		/"([^"]*)"([^"]*)"([^"]*)":/g,
		(match, p1, p2, p3) => {
			return `"${p1}\\"${p2}\\"${p3}":`;
		}
	);

	// Fix missing quotes around property names
	fixed = fixed.replace(
		/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
		'$1"$2":'
	);

	// Fix single quotes to double quotes
	fixed = fixed.replace(/'/g, '"');

	// Handle markdown content with quotes
	fixed = fixed.replace(/:\s*"([^"]*(?:\\.[^"]*)*)"/g, (match, content) => {
		const escapedContent = content.replace(/(?<!\\)"/g, '\\"');
		return `: "${escapedContent}"`;
	});

	return fixed;
}
