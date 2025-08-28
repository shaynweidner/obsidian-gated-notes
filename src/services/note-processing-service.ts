import { Notice, TFile } from "obsidian";
import { GatedNotesPluginInterface } from "../types";
import {
	SPLIT_TAG,
	PARA_CLASS,
	PARA_ID_ATTR,
	PARA_MD_ATTR,
} from "../constants";
import {
	escapeRegExp,
	md2attr,
	getParagraphsFromFinalizedNote,
} from "../utils";

/**
 * Service for processing and finalizing notes
 */
export class NoteProcessingService {
	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Auto-finalize a note by wrapping paragraphs
	 */
	async autoFinalizeNote(file: TFile): Promise<void> {
		const content = await this.plugin.app.vault.read(file);
		if (content.includes(PARA_CLASS)) {
			new Notice("Note is already finalized.");
			return;
		}

		if (content.includes(SPLIT_TAG)) {
			const userChoice = await this.showSplitMarkerConflictModal();

			if (userChoice === "manual") {
				await this.manualFinalizeNote(file);
				return;
			} else if (userChoice === "remove") {
				const contentWithoutSplits = content.replace(
					new RegExp(escapeRegExp(SPLIT_TAG), "g"),
					""
				);
				return this.performAutoFinalize(file, contentWithoutSplits);
			} else if (userChoice === null) {
				return;
			}
		} else {
			return this.performAutoFinalize(file, content);
		}
	}

	/**
	 * Perform the actual auto-finalization logic
	 */
	private async performAutoFinalize(
		file: TFile,
		content: string
	): Promise<void> {
		const paragraphs: string[] = [];
		let inFence = false;
		let buffer: string[] = [];

		for (const line of content.split("\n")) {
			if (line.trim().startsWith("```")) inFence = !inFence;
			buffer.push(line);
			if (!inFence && line.trim() === "") {
				const paragraph = buffer.join("\n").trim();
				if (paragraph) paragraphs.push(paragraph);
				buffer = [];
			}
		}
		if (buffer.length > 0) {
			const lastParagraph = buffer.join("\n").trim();
			if (lastParagraph) paragraphs.push(lastParagraph);
		}

		const wrappedContent = paragraphs
			.map(
				(md, i) =>
					`<br class="gn-sentinel"><div class="${PARA_CLASS}" ${PARA_ID_ATTR}="${
						i + 1
					}" ${PARA_MD_ATTR}="${md2attr(md)}"></div>`
			)
			.join("\n\n");
		await this.plugin.app.vault.modify(file, wrappedContent);
		new Notice("Note auto-finalized. Gating is now active.");
	}

	/**
	 * Manually finalize a note using split markers
	 */
	async manualFinalizeNote(file: TFile): Promise<void> {
		const content = await this.plugin.app.vault.read(file);
		if (!content.includes(SPLIT_TAG)) {
			new Notice("No split markers found in the note.");
			return;
		}
		if (content.includes(PARA_CLASS)) {
			new Notice("Note is already finalized.");
			return;
		}

		const normalizedContent = this.normalizeSplitContent(content);
		const chunks = normalizedContent.split(SPLIT_TAG);

		const wrappedContent = chunks
			.map((md, i) => {
				const trimmedMd = md.trim();
				return `<br class="gn-sentinel"><div class="${PARA_CLASS}" ${PARA_ID_ATTR}="${
					i + 1
				}" ${PARA_MD_ATTR}="${md2attr(trimmedMd)}"></div>`;
			})
			.join("\n\n");

		await this.plugin.app.vault.modify(file, wrappedContent);
		new Notice("Note manually finalized. Gating is now active.");
	}

	/**
	 * Normalize split content by cleaning up whitespace
	 */
	private normalizeSplitContent(content: string): string {
		let normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		normalized = normalized.replace(/\n{3,}/g, "\n\n");
		normalized = normalized.replace(
			new RegExp(`\\s*${escapeRegExp(SPLIT_TAG)}\\s*`, "g"),
			`\n${SPLIT_TAG}\n`
		);
		normalized = normalized.replace(/\n{3,}/g, "\n\n");
		return normalized;
	}

	/**
	 * Unfinalize a note by removing gating markup
	 */
	async unfinalize(file: TFile): Promise<void> {
		if (!(await this.showUnfinalizeConfirmModal())) return;

		const content = await this.plugin.app.vault.read(file);
		const paragraphs = getParagraphsFromFinalizedNote(content);

		if (paragraphs.length === 0) {
			new Notice("This note does not appear to be finalized.");
			return;
		}

		const plainContent = paragraphs.map((p) => p.markdown).join("\n\n");
		const cleanedContent = this.cleanupAfterSplitRemoval(plainContent);
		await this.plugin.app.vault.modify(file, cleanedContent);
		new Notice("Note unfinalized successfully.");
	}

	/**
	 * Clean up content after removing splits
	 */
	private cleanupAfterSplitRemoval(content: string): string {
		let cleaned = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
		cleaned = cleaned.replace(/^\n+|\n+$/g, "");
		return cleaned;
	}

	/**
	 * Show modal for split marker conflicts
	 */
	private showSplitMarkerConflictModal(): Promise<
		"manual" | "remove" | null
	> {
		return new Promise((resolve) => {
			const modal = new (require("obsidian").Modal)(this.plugin.app);
			modal.titleEl.setText("Split Markers Found");
			modal.contentEl.createEl("p", {
				text: "This note contains split markers. How would you like to proceed?",
			});

			const buttonContainer = modal.contentEl.createDiv();
			buttonContainer.style.cssText =
				"display: flex; gap: 10px; margin-top: 20px;";

			const manualBtn = buttonContainer.createEl("button", {
				text: "Manual Finalize",
				cls: "mod-cta",
			});
			manualBtn.addEventListener("click", () => {
				modal.close();
				resolve("manual");
			});

			const removeBtn = buttonContainer.createEl("button", {
				text: "Remove Splits & Auto",
			});
			removeBtn.addEventListener("click", () => {
				modal.close();
				resolve("remove");
			});

			const cancelBtn = buttonContainer.createEl("button", {
				text: "Cancel",
			});
			cancelBtn.addEventListener("click", () => {
				modal.close();
				resolve(null);
			});

			modal.open();
		});
	}

	/**
	 * Show confirmation modal for unfinalizing
	 */
	private showUnfinalizeConfirmModal(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new (require("obsidian").Modal)(this.plugin.app);
			modal.titleEl.setText("Unfinalize Note");
			modal.contentEl.createEl("p", {
				text: "Are you sure you want to unfinalize this note? This will remove all gating and convert the note back to plain markdown.",
			});

			const buttonContainer = modal.contentEl.createDiv();
			buttonContainer.style.cssText =
				"display: flex; gap: 10px; margin-top: 20px;";

			const confirmBtn = buttonContainer.createEl("button", {
				text: "Yes, Unfinalize",
				cls: "mod-warning",
			});
			confirmBtn.addEventListener("click", () => {
				modal.close();
				resolve(true);
			});

			const cancelBtn = buttonContainer.createEl("button", {
				text: "Cancel",
				cls: "mod-cta",
			});
			cancelBtn.addEventListener("click", () => {
				modal.close();
				resolve(false);
			});

			modal.open();
		});
	}
}
