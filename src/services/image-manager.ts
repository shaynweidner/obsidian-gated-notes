import { TFile, normalizePath } from "obsidian";
import { GatedNotesPluginInterface } from "../types";

/**
 * Core service for managing image embedding operations
 */
export class ImageManager {
	constructor(private plugin: GatedNotesPluginInterface) {}

	async saveImageToVault(
		imageData: string,
		filename: string,
		targetFolder?: string
	): Promise<string> {
		try {
			// Convert data URL to blob
			const response = await fetch(imageData);
			const blob = await response.blob();
			const arrayBuffer = await blob.arrayBuffer();

			// Determine target path
			let targetPath = filename;
			if (targetFolder) {
				if (
					!(await this.plugin.app.vault.adapter.exists(targetFolder))
				) {
					await this.plugin.app.vault.createFolder(targetFolder);
				}
				targetPath = normalizePath(`${targetFolder}/${filename}`);
			}

			// Handle filename conflicts
			let finalPath = targetPath;
			let counter = 1;
			while (await this.plugin.app.vault.adapter.exists(finalPath)) {
				const ext = filename.split(".").pop() || "png";
				const baseName = filename.replace(`.${ext}`, "");
				finalPath = targetFolder
					? normalizePath(
							`${targetFolder}/${baseName}_${counter}.${ext}`
					  )
					: `${baseName}_${counter}.${ext}`;
				counter++;
			}

			await this.plugin.app.vault.createBinary(finalPath, arrayBuffer);
			return finalPath;
		} catch (error) {
			throw new Error(`Failed to save image: ${error}`);
		}
	}

	generateImagePlaceholder(id: string): string {
		return `[IMAGE_PLACEHOLDER:${id}]`;
	}

	async embedImageInNote(
		noteFile: TFile,
		imageData: string,
		lineIndex: number,
		filename?: string
	): Promise<void> {
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace("T", "_")
			.substring(0, 19);
		const finalFilename = filename || `embedded_image_${timestamp}.png`;

		// Get attachment folder from Obsidian settings
		const attachmentFolder = this.getAttachmentFolder(noteFile);
		const imagePath = await this.saveImageToVault(
			imageData,
			finalFilename,
			attachmentFolder
		);
		const imageMarkdown = `![[${finalFilename}]]`;

		const content = await this.plugin.app.vault.read(noteFile);
		const lines = content.split("\n");

		lines.splice(lineIndex, 0, imageMarkdown);

		await this.plugin.app.vault.modify(noteFile, lines.join("\n"));
	}

	/**
	 * Get the appropriate attachment folder based on Obsidian settings
	 */
	private getAttachmentFolder(noteFile: TFile): string | undefined {
		// Access Obsidian's file config settings
		const config = (this.plugin.app as any).vault.config;
		const attachmentFolderPath = config?.attachmentFolderPath;

		if (!attachmentFolderPath) {
			// No attachment folder configured, save to vault root
			return undefined;
		}

		if (attachmentFolderPath === "./") {
			// Same folder as current note
			return noteFile.parent?.path || undefined;
		}

		// Specific folder path
		return attachmentFolderPath;
	}

	replacePlaceholder(
		content: string,
		placeholderId: string,
		imageMarkdown: string
	): string {
		const placeholder = this.generateImagePlaceholder(placeholderId);
		return content.replace(placeholder, imageMarkdown);
	}
}
