import { TFile, Notice } from "obsidian";
import { GatedNotesPluginInterface, FlashcardGraph, LogLevel } from "../types";

/**
 * Service for managing flashcard deck operations
 */
export class DeckService {
	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Read a flashcard deck from file
	 */
	async readDeck(deckPath: string): Promise<FlashcardGraph> {
		if (!(await this.plugin.app.vault.adapter.exists(deckPath))) return {};
		try {
			const content = await this.plugin.app.vault.adapter.read(deckPath);
			return JSON.parse(content) as FlashcardGraph;
		} catch (e: unknown) {
			this.plugin.logger(
				LogLevel.NORMAL,
				`Failed to parse deck at ${deckPath}:`,
				e
			);
			new Notice(
				`Warning: Could not read flashcard file at ${deckPath}. File may be corrupt.`
			);
			return {};
		}
	}

	/**
	 * Write a flashcard deck to file
	 */
	async writeDeck(
		deckPath: string,
		graph: FlashcardGraph
	): Promise<void> {
		const content = JSON.stringify(graph, null, 2);
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(deckPath);
			if (file instanceof TFile) {
				await this.plugin.app.vault.modify(file, content);
			} else {
				if (file) {
					this.plugin.logger(
						LogLevel.NORMAL,
						`Deck path is a folder, cannot write file: ${deckPath}`
					);
					new Notice(
						`Error: Cannot save flashcards, path is a folder.`
					);
					return;
				}
				await this.plugin.app.vault.create(deckPath, content);
			}
		} catch (e: unknown) {
			this.plugin.logger(
				LogLevel.NORMAL,
				`Failed to write deck to ${deckPath}`,
				e
			);
			new Notice(`Error: Failed to save flashcards to ${deckPath}.`);
		}
	}

	/**
	 * Save a flashcard deck (alias for writeDeck)
	 */
	async saveDeck(
		deckPath: string,
		graph: FlashcardGraph
	): Promise<void> {
		return this.writeDeck(deckPath, graph);
	}
}