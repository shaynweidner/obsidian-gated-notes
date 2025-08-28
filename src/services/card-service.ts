import { Notice, MarkdownRenderer, Modal, TFile } from "obsidian";
import {
	GatedNotesPluginInterface,
	Flashcard,
	CardRating,
	FlashcardGraph,
	ReviewLog,
	StudyMode,
	LogLevel,
} from "../types";
import { getDeckPathForChapter } from "../utils";

/**
 * Service for managing flashcard operations and review sessions
 */
export class CardService {
	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Start a review session for due cards
	 */
	async reviewDue(): Promise<void> {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file to review.");
			return;
		}

		const deckPath = getDeckPathForChapter(activeFile.path);
		if (!(await this.plugin.app.vault.adapter.exists(deckPath))) {
			new Notice("No flashcard deck found for this chapter's subject.");
			return;
		}

		const graph = await this.plugin.deckService.readDeck(deckPath);
		const now = Date.now();
		let dueCards = (Object.values(graph) as Flashcard[]).filter((card) => {
			if (card.due > now) return false;
			switch (this.plugin.studyMode) {
				case StudyMode.CHAPTER:
					return card.chapter === activeFile.path;
				case StudyMode.SUBJECT:
					return card.chapter.startsWith(
						activeFile.path.replace(/\/[^\/]+$/, "")
					);
				case StudyMode.REVIEW:
					return card.status !== "new";
				default:
					return true;
			}
		});

		if (dueCards.length === 0) {
			let message = "No cards due for review";
			switch (this.plugin.studyMode) {
				case StudyMode.CHAPTER:
					message += " in this chapter.";
					break;
				case StudyMode.SUBJECT:
					message += " in this subject.";
					break;
				case StudyMode.REVIEW:
					message += " (review-only mode).";
					break;
				default:
					message += ".";
			}
			new Notice(message);
			return;
		}

		// Prioritize learning cards, then review cards
		dueCards.sort((a, b) => {
			const aIsLearning = a.status === "learning";
			const bIsLearning = b.status === "learning";
			if (aIsLearning && !bIsLearning) return -1;
			if (!aIsLearning && bIsLearning) return 1;
			return a.due - b.due;
		});

		let currentIndex = 0;
		const showCard = async () => {
			if (currentIndex >= dueCards.length) {
				new Notice(
					`🎉 Review session complete! ${dueCards.length} cards reviewed.`
				);
				return;
			}

			const card = dueCards[currentIndex];
			const cardInGraph = graph[card.id];
			if (!cardInGraph) return;

			const reviewModal = new Modal(this.plugin.app);
			reviewModal.titleEl.setText(
				`Card ${currentIndex + 1} of ${dueCards.length}`
			);

			const frontContainer = reviewModal.contentEl.createDiv();
			await this.renderCardContent(
				card.front,
				frontContainer,
				card.chapter
			);

			const bottomBar = reviewModal.contentEl.createDiv({
				cls: "gn-action-bar",
			});

			let showingBack = false;
			const showAnswerBtn = bottomBar.createEl("button", {
				text: "Show Answer",
				cls: "mod-cta",
			});

			showAnswerBtn.addEventListener("click", async () => {
				if (showingBack) return;
				showingBack = true;
				showAnswerBtn.remove();

				const backContainer = reviewModal.contentEl.createDiv();
				await this.renderCardContent(
					card.back,
					backContainer,
					card.chapter
				);

				const ratingContainer = bottomBar.createDiv({
					cls: "gn-rating-buttons",
				});

				const ratingButtons = [
					{
						label: "Again",
						value: "Again" as CardRating,
						shortcut: "1",
					},
					{
						label: "Hard",
						value: "Hard" as CardRating,
						shortcut: "2",
					},
					{
						label: "Good",
						value: "Good" as CardRating,
						shortcut: "3",
					},
					{
						label: "Easy",
						value: "Easy" as CardRating,
						shortcut: "4",
					},
				];

				const buttonElements: HTMLButtonElement[] = [];
				ratingButtons.forEach(({ label, value: lbl, shortcut }) => {
					const btn = ratingContainer.createEl("button", {
						text: `${label} (${shortcut})`,
					});
					buttonElements.push(btn);
					btn.addEventListener("click", async () => {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Card rated: ${lbl} (${label})`
						);

						this.applySm2(cardInGraph, lbl);

						const gateAfter =
							await this.plugin.getFirstBlockedParaIndex(
								card.chapter,
								graph
							);
						if (gateAfter !== null) {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Gating after paragraph ${gateAfter} for ${card.chapter}`
							);
						}

						await this.plugin.deckService.saveDeck(deckPath, graph);
						await this.plugin.refreshReadingAndPreserveScroll();
						this.plugin.refreshDueCardStatus();

						reviewModal.close();
						currentIndex++;
						showCard();
					});
				});

				// Add keyboard shortcuts
				reviewModal.scope.register([], "1", () =>
					buttonElements[0]?.click()
				);
				reviewModal.scope.register([], "2", () =>
					buttonElements[1]?.click()
				);
				reviewModal.scope.register([], "3", () =>
					buttonElements[2]?.click()
				);
				reviewModal.scope.register([], "4", () =>
					buttonElements[3]?.click()
				);
			});

			reviewModal.open();
		};

		showCard();
	}

	/**
	 * Apply SM2 spaced repetition algorithm to update card scheduling
	 */
	applySm2(card: Flashcard, rating: CardRating): void {
		this.plugin.cardAlgorithmService.applySm2(card, rating);
		
		this.plugin.logger(LogLevel.NORMAL, `Card ${card.id} updated:`, {
			rating,
			newStatus: card.status,
			newInterval: card.interval,
			newDue: new Date(card.due).toISOString(),
			newEaseFactor: card.ease_factor,
		});
	}

	/**
	 * Reset a flashcard to its initial state
	 */
	resetCardProgress(card: Flashcard): void {
		this.plugin.cardAlgorithmService.resetCardProgress(card);
	}

	/**
	 * Delete all flashcards for a specific chapter
	 */
	async deleteChapterCards(file: TFile): Promise<void> {
		const deckPath = getDeckPathForChapter(file.path);
		if (!(await this.plugin.app.vault.adapter.exists(deckPath))) {
			new Notice("No flashcard deck found for this chapter's subject.");
			return;
		}

		const graph = await this.plugin.deckService.readDeck(deckPath);
		const cardsToDelete = Object.keys(graph).filter(
			(cardId) => graph[cardId].chapter === file.path
		);

		if (cardsToDelete.length === 0) {
			new Notice("No cards found for this chapter.");
			return;
		}

		cardsToDelete.forEach((cardId) => {
			delete graph[cardId];
		});

		await this.plugin.deckService.saveDeck(deckPath, graph);
		new Notice(`Deleted ${cardsToDelete.length} cards from this chapter.`);

		await this.plugin.refreshReadingAndPreserveScroll();
		this.plugin.refreshDueCardStatus();
	}

	/**
	 * Render flashcard content with proper markdown processing
	 */
	async renderCardContent(
		content: string,
		container: HTMLElement,
		sourcePath: string
	): Promise<void> {
		let processedContent = content;

		// Handle image links and other markdown processing
		const imgRegex = /!\[\[([^\]]+)\]\]/g;
		processedContent = processedContent.replace(
			imgRegex,
			(match, filename) => {
				const imagePath =
					this.plugin.app.metadataCache.getFirstLinkpathDest(
						filename,
						sourcePath
					);
				if (imagePath) {
					const resourcePath =
						this.plugin.app.vault.getResourcePath(imagePath);
					return `<img src="${resourcePath}" alt="${filename}" style="max-width: 100%; height: auto;">`;
				}
				return match;
			}
		);

		// Handle internal links
		const linkRegex = /\[\[([^\]]+)\]\]/g;
		processedContent = processedContent.replace(
			linkRegex,
			(match, linkText) => {
				const [path, display] = linkText.split("|");
				const displayText = display || path;
				return `<a href="#" class="internal-link" data-path="${path}">${displayText}</a>`;
			}
		);

		// Render markdown
		await MarkdownRenderer.render(
			this.plugin.app,
			processedContent,
			container,
			sourcePath,
			this.plugin
		);

		// Add click handlers for internal links
		container.querySelectorAll("a.internal-link").forEach((link) => {
			link.addEventListener("click", (e) => {
				e.preventDefault();
				const path = link.getAttribute("data-path");
				if (path) {
					const file =
						this.plugin.app.metadataCache.getFirstLinkpathDest(
							path,
							sourcePath
						);
					if (file) {
						this.plugin.app.workspace.openLinkText(
							path,
							sourcePath
						);
					}
				}
			});
		});
	}
}
