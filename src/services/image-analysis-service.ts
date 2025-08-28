import { TFile, Notice, normalizePath } from "obsidian";
import {
	GatedNotesPluginInterface,
	ImageAnalysisGraph,
	LogLevel,
} from "../types";
import { IMAGE_ANALYSIS_FILE_NAME } from "../constants";

/**
 * Service for managing image analysis data and operations
 */
export class ImageAnalysisService {
	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Get the image analysis database
	 */
	async getImageDb(): Promise<ImageAnalysisGraph> {
		const dbPath = normalizePath(
			this.plugin.app.vault.getRoot().path + IMAGE_ANALYSIS_FILE_NAME
		);
		if (!(await this.plugin.app.vault.adapter.exists(dbPath))) {
			return {};
		}
		try {
			const content = await this.plugin.app.vault.adapter.read(dbPath);
			return JSON.parse(content) as ImageAnalysisGraph;
		} catch (e) {
			this.plugin.logger(LogLevel.NORMAL, "Failed to read image DB", e);
			return {};
		}
	}

	/**
	 * Write the image analysis database to disk
	 */
	async writeImageDb(db: ImageAnalysisGraph): Promise<void> {
		const dbPath = normalizePath(
			this.plugin.app.vault.getRoot().path + IMAGE_ANALYSIS_FILE_NAME
		);
		await this.plugin.app.vault.adapter.write(
			dbPath,
			JSON.stringify(db, null, 2)
		);
	}

	/**
	 * Calculate SHA-256 hash for a file
	 */
	async calculateFileHash(file: TFile): Promise<string> {
		const arrayBuffer = await this.plugin.app.vault.readBinary(file);
		const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	/**
	 * Remove image analysis for a specific note
	 */
	async removeNoteImageAnalysis(file: TFile): Promise<void> {
		const imageDb = await this.getImageDb();
		const noteContent = await this.plugin.app.vault.read(file);
		const imageRegex = /!\[\[([^\]]+)\]\]/g;
		let match;
		const hashesToClear: string[] = [];

		while ((match = imageRegex.exec(noteContent)) !== null) {
			const imagePath = match[1];
			const imageFile =
				this.plugin.app.metadataCache.getFirstLinkpathDest(
					imagePath,
					file.path
				);
			if (imageFile instanceof TFile) {
				const hash = await this.calculateFileHash(imageFile);
				if (imageDb[hash]?.analysis) {
					hashesToClear.push(hash);
				}
			}
		}

		if (hashesToClear.length === 0) {
			new Notice("No analyzed images found in this note.");
			return;
		}

		if (
			!confirm(
				`Are you sure you want to remove the AI analysis for ${hashesToClear.length} image(s) in this note? The images can be re-analyzed later. This cannot be undone.`
			)
		) {
			return;
		}

		let clearedCount = 0;
		for (const hash of hashesToClear) {
			if (imageDb[hash]?.analysis) {
				delete imageDb[hash].analysis;
				clearedCount++;
			}
		}

		await this.writeImageDb(imageDb);
		new Notice(`✅ Cleared analysis for ${clearedCount} image(s).`);
	}

	/**
	 * Remove all image analysis data from the database
	 */
	async removeAllImageAnalysis(): Promise<void> {
		const imageDb = await this.getImageDb();
		const keysWithAnalysis = Object.keys(imageDb).filter(
			(k) => imageDb[k].analysis
		);

		if (keysWithAnalysis.length === 0) {
			new Notice("No image analysis data found to remove.");
			return;
		}

		if (
			!confirm(
				`Are you sure you want to remove ALL AI image analysis data from your vault? This will affect ${keysWithAnalysis.length} image(s). This cannot be undone.`
			)
		) {
			return;
		}

		for (const hash of keysWithAnalysis) {
			delete imageDb[hash].analysis;
		}

		await this.writeImageDb(imageDb);
		new Notice(
			`✅ Cleared all AI analysis data for ${keysWithAnalysis.length} image(s).`
		);
	}

	/**
	 * Show image processing notice with preview
	 */
	showImageProcessingNotice(
		imageFile: TFile,
		message: string,
		existingNotice?: Notice
	): void {
		try {
			// Create a mini preview of the image using createEl
			if (existingNotice) {
				// Update existing notice with HTML content
				const noticeEl = existingNotice.noticeEl;
				noticeEl.empty();

				const container = noticeEl.createDiv();
				container.style.cssText =
					"display: flex; align-items: center; gap: 10px; font-size: 12px; max-width: 400px;";

				// Add image preview
				const imgEl = container.createEl("img");
				imgEl.src = this.plugin.app.vault.getResourcePath(imageFile);
				imgEl.style.cssText =
					"width: 24px; height: 24px; object-fit: cover; border-radius: 4px; flex-shrink: 0;";

				// Add text content
				const textEl = container.createDiv();
				textEl.textContent = message;
				textEl.style.cssText = "flex: 1; line-height: 1.2;";
			} else {
				new Notice(message, 2000);
			}
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error showing image processing notice:",
				error
			);
			new Notice(message, 2000);
		}
	}

	/**
	 * Process image hash placeholders in card content
	 */
	async processImageHashPlaceholders(content: string): Promise<string> {
		let processedContent = content;
		const imageRegex = /\[\[IMAGE HASH=([a-f0-9]{64})\]\]/g;
		let match;
		const contentToScan = content;
		const imageDb = await this.getImageDb();

		while ((match = imageRegex.exec(contentToScan)) !== null) {
			const hash = match[1];
			const imageInfo = imageDb[hash];
			if (imageInfo) {
				processedContent = processedContent.replace(
					match[0],
					`![[${imageInfo.path}]]`
				);
			} else {
				processedContent = processedContent.replace(
					match[0],
					`> [!warning] Gated Notes: Image with hash ${hash.substring(
						0,
						8
					)}... not found in database.`
				);
			}
		}

		return processedContent;
	}

	/**
	 * Find unused images in the vault
	 */
	async findUnusedImages(images: TFile[]): Promise<TFile[]> {
		const allNotes = this.plugin.app.vault.getMarkdownFiles();
		const unusedImages: TFile[] = [];
		const { DECK_FILE_NAME } = await import("../constants");

		// Get image database and all flashcard files
		const imageDb = await this.getImageDb();
		const allDeckFiles = this.plugin.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));

		// Create a map from image file path to its hash for faster lookups
		const imagePathToHash = new Map<string, string>();
		for (const [hash, imageData] of Object.entries(imageDb)) {
			imagePathToHash.set(imageData.path, hash);
		}

		for (const image of images) {
			let isUsed = false;
			const imageName = image.name;
			const imageHash = imagePathToHash.get(image.path);

			// Check all notes for references to this image
			for (const note of allNotes) {
				try {
					const content = await this.plugin.app.vault.cachedRead(
						note
					);

					// Check for direct image references
					if (
						content.includes(`[[${imageName}]]`) ||
						content.includes(`![[${imageName}]]`) ||
						content.includes(image.path)
					) {
						isUsed = true;
						break;
					}

					// Check for hash-based references
					if (
						imageHash &&
						content.includes(`IMAGE HASH=${imageHash}`)
					) {
						isUsed = true;
						break;
					}
				} catch (error) {
					this.plugin.logger(
						LogLevel.NORMAL,
						`Error reading note ${note.path}:`,
						error
					);
					continue;
				}
			}

			// Check flashcard files for hash references
			if (!isUsed && imageHash) {
				for (const deckFile of allDeckFiles) {
					try {
						const deckContent =
							await this.plugin.app.vault.cachedRead(deckFile);
						if (deckContent.includes(`IMAGE HASH=${imageHash}`)) {
							isUsed = true;
							break;
						}
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Error reading deck ${deckFile.path}:`,
							error
						);
						continue;
					}
				}
			}

			if (!isUsed) {
				unusedImages.push(image);
			}
		}

		return unusedImages;
	}

	/**
	 * Create an image hash map for a given note
	 */
	async createImageHashMap(file: TFile): Promise<Map<string, number>> {
		const imageHashMap = new Map<string, number>();
		const paragraphs = await this.plugin.getParagraphs(file);

		for (const p of paragraphs) {
			const imageRegex = /!\[\[([^\]]+)\]\]/g;
			let match;
			while ((match = imageRegex.exec(p.markdown)) !== null) {
				const imagePath = match[1];
				const imageFile =
					this.plugin.app.metadataCache.getFirstLinkpathDest(
						imagePath,
						file.path
					);
				if (imageFile instanceof TFile) {
					const hash = await this.calculateFileHash(imageFile);
					imageHashMap.set(hash, p.id);
				}
			}
		}

		return imageHashMap;
	}
}
