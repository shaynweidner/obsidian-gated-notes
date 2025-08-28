import { Notice, TFile } from "obsidian";
import { GatedNotesPluginInterface } from "../types";
import { DECK_FILE_NAME } from "../constants";
import { UnusedImageReviewModal } from "../modals";

/**
 * Service for managing file operations and cleanup
 */
export class FileManagementService {
	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Remove unused images from the vault
	 */
	async removeUnusedImages(): Promise<void> {
		const notice = new Notice("Scanning vault for unused images...", 0);

		try {
			// Find all images in vault
			const allImages = await this.findAllImages();
			notice.setMessage(
				`Found ${allImages.length} images. Checking usage...`
			);

			// Check which images are referenced
			const unusedImages = await this.findUnusedImages(allImages);

			notice.hide();

			if (unusedImages.length === 0) {
				new Notice("No unused images found!");
				return;
			}

			// Show review modal
			new UnusedImageReviewModal(
				this.plugin.app,
				unusedImages,
				async (imagesToDelete) => {
					if (imagesToDelete.length === 0) {
						new Notice("No images deleted.");
						return;
					}

					const deleteNotice = new Notice(
						`Deleting ${imagesToDelete.length} images...`,
						0
					);
					let deletedCount = 0;

					for (const image of imagesToDelete) {
						try {
							await this.plugin.app.vault.delete(image);
							deletedCount++;
						} catch (error) {
							console.error(
								`Failed to delete ${image.path}:`,
								error
							);
						}
					}

					deleteNotice.hide();
					new Notice(
						`Deleted ${deletedCount} of ${imagesToDelete.length} images.`
					);
				}
			).open();
		} catch (error) {
			notice.hide();
			console.error("Error scanning for unused images:", error);
			new Notice(
				"Error scanning for unused images. Check console for details."
			);
		}
	}

	/**
	 * Find all image files in the vault
	 */
	private async findAllImages(): Promise<TFile[]> {
		const imageExtensions = new Set([
			"png",
			"jpg",
			"jpeg",
			"gif",
			"bmp",
			"svg",
			"webp",
		]);
		const allFiles = this.plugin.app.vault.getFiles();

		return allFiles.filter((file) => {
			const extension = file.extension.toLowerCase();
			return imageExtensions.has(extension);
		});
	}

	/**
	 * Find unused images by checking references in notes and flashcards
	 */
	private async findUnusedImages(images: TFile[]): Promise<TFile[]> {
		const allNotes = this.plugin.app.vault.getMarkdownFiles();
		const unusedImages: TFile[] = [];

		// Get image database and all flashcard files
		const imageDb = await this.plugin.imageAnalysisService.getImageDb();
		const allDeckFiles = this.plugin.app.vault
			.getFiles()
			.filter((f) => f.name.endsWith(DECK_FILE_NAME));

		// Create a map from image file path to its hash for faster lookups
		const imagePathToHash = new Map<string, string>();
		for (const [hash, imageData] of Object.entries(imageDb)) {
			if (
				imageData &&
				typeof imageData === "object" &&
				"path" in imageData
			) {
				imagePathToHash.set((imageData as any).path, hash);
			}
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
						1,
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
							1,
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
}
