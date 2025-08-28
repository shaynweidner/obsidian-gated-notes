import { Notice } from "obsidian";
import { GatedNotesPluginInterface, SnippingResult, LogLevel } from "../types";

/**
 * Tool for capturing images from various sources
 */
export class SnippingTool {
	constructor(private plugin: GatedNotesPluginInterface) {}

	async captureScreenRegion(): Promise<SnippingResult | null> {
		try {
			// First try clipboard (most reliable across environments)
			try {
				const clipboardResult = await this.captureFromClipboard();
				if (clipboardResult) {
					return clipboardResult;
				}
			} catch (clipboardError) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"Clipboard capture failed:",
					clipboardError
				);
			}

			// Then try Electron if available
			if (this.isElectronEnvironment()) {
				try {
					return await this.captureScreenElectron();
				} catch (electronError) {
					this.plugin.logger(
						LogLevel.NORMAL,
						"Electron screen capture failed:",
						electronError
					);
				}
			}

			// If both methods fail, provide helpful guidance
			new Notice(
				"📋 Screen capture: First copy an image to clipboard, then run this command.\n\n💡 Tip: Use Win+Shift+S (Windows) or Cmd+Shift+4 (Mac) to take a screenshot to clipboard."
			);
			return null;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "Screen capture error:", error);
			new Notice(
				"Screen capture failed. Try copying an image to clipboard first."
			);
			return null;
		}
	}

	private isElectronEnvironment(): boolean {
		try {
			return (
				typeof window !== "undefined" &&
				typeof (window as any).require === "function" &&
				typeof (window as any).require("electron") === "object"
			);
		} catch {
			return false;
		}
	}

	private async captureScreenElectron(): Promise<SnippingResult | null> {
		try {
			// For Electron environment, we can use native screen capture
			const electron = (window as any).require("electron");
			const { desktopCapturer } = electron;

			if (!desktopCapturer) {
				throw new Error(
					"Desktop capturer not available in this Obsidian version"
				);
			}

			// Get available sources (screens)
			const sources = await desktopCapturer.getSources({
				types: ["screen"],
				thumbnailSize: { width: 1920, height: 1080 },
			});

			if (sources.length === 0) {
				throw new Error("No screens available for capture");
			}

			// For now, use the first screen. In the future, could show a selection dialog
			const primaryScreen = sources[0];

			// Convert the thumbnail to our format
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d")!;

			const img = new Image();
			await new Promise<void>((resolve, reject) => {
				img.onload = () => {
					canvas.width = img.width;
					canvas.height = img.height;
					ctx.drawImage(img, 0, 0);
					resolve();
				};
				img.onerror = reject;
				img.src = primaryScreen.thumbnail.toDataURL();
			});

			return {
				imageData: canvas.toDataURL("image/png"),
				width: canvas.width,
				height: canvas.height,
				sourceType: "screen",
				metadata: {
					screenId: primaryScreen.id,
					screenName: primaryScreen.name,
					captureTime: new Date().toISOString(),
				},
			};
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Electron screen capture failed:",
				error
			);
			// Fall back to clipboard method
			return await this.captureFromClipboard();
		}
	}

	private async captureFromClipboard(): Promise<SnippingResult | null> {
		try {
			if (!navigator.clipboard) {
				throw new Error(
					"Clipboard API not supported in this environment"
				);
			}

			if (!navigator.clipboard.read) {
				throw new Error("Clipboard read permission not available");
			}

			let clipboardItems;
			try {
				clipboardItems = await navigator.clipboard.read();
			} catch (permissionError) {
				throw new Error(
					"Clipboard access denied - please allow clipboard permissions"
				);
			}

			if (!clipboardItems || clipboardItems.length === 0) {
				throw new Error("Clipboard is empty");
			}

			for (const clipboardItem of clipboardItems) {
				const imageTypes = clipboardItem.types.filter((type) =>
					type.startsWith("image/")
				);

				if (imageTypes.length === 0) {
					continue; // No image types in this clipboard item
				}

				for (const type of imageTypes) {
					try {
						const blob = await clipboardItem.getType(type);
						if (blob.size === 0) {
							continue; // Empty blob
						}

						const imageData = await this.blobToDataUrl(blob);
						const { width, height } = await this.getImageDimensions(
							imageData
						);

						return {
							imageData,
							width,
							height,
							sourceType: "screen",
							metadata: {
								mimeType: type,
								size: blob.size,
								captureTime: new Date().toISOString(),
								source: "clipboard",
							},
						};
					} catch (typeError) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Failed to process clipboard type ${type}:`,
							typeError
						);
						continue; // Try next type
					}
				}
			}

			throw new Error("No valid image found in clipboard");
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	async captureFromFile(filePath?: string): Promise<SnippingResult | null> {
		try {
			if (!filePath) {
				// Show file picker
				const input = document.createElement("input");
				input.type = "file";
				input.accept = "image/*";
				input.style.display = "none";

				return new Promise((resolve) => {
					input.onchange = async (e) => {
						const file = (e.target as HTMLInputElement).files?.[0];
						if (file) {
							const result = await this.processImageFile(file);
							resolve(result);
						} else {
							resolve(null);
						}
						document.body.removeChild(input);
					};

					input.oncancel = () => {
						document.body.removeChild(input);
						resolve(null);
					};

					document.body.appendChild(input);
					input.click();
				});
			} else {
				// Load from specified file path (if we have file system access)
				const response = await fetch(`file://${filePath}`);
				const blob = await response.blob();
				const file = new File(
					[blob],
					filePath.split("/").pop() || "image",
					{ type: blob.type }
				);
				return await this.processImageFile(file);
			}
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "File capture error:", error);
			new Notice("Failed to load image from file");
			return null;
		}
	}

	async captureFromPdf(
		pdfPath: string,
		pageNumber: number,
		region?: { x: number; y: number; width: number; height: number }
	): Promise<SnippingResult | null> {
		try {
			// Check if PDF.js is available
			if (typeof window !== "undefined" && (window as any).pdfjsLib) {
				return await this.capturePdfWithPdfJs(
					pdfPath,
					pageNumber,
					region
				);
			}

			// Fallback: Use file system access if available
			if (typeof window !== "undefined" && (window as any).require) {
				return await this.capturePdfWithElectron(
					pdfPath,
					pageNumber,
					region
				);
			}

			new Notice(
				"PDF capture requires PDF.js library or desktop environment"
			);
			return null;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF capture error:", error);
			new Notice(
				`PDF capture failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return null;
		}
	}

	private async capturePdfWithPdfJs(
		pdfPath: string,
		pageNumber: number,
		region?: { x: number; y: number; width: number; height: number }
	): Promise<SnippingResult | null> {
		try {
			const pdfjsLib = (window as any).pdfjsLib;

			// Load the PDF document
			const loadingTask = pdfjsLib.getDocument(pdfPath);
			const pdf = await loadingTask.promise;

			// Get the specified page
			const page = await pdf.getPage(pageNumber);

			// Set up canvas for rendering
			const scale = 2.0; // Higher resolution
			const viewport = page.getViewport({ scale });

			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d")!;
			canvas.height = viewport.height;
			canvas.width = viewport.width;

			// Render page to canvas
			const renderContext = {
				canvasContext: context,
				viewport: viewport,
			};

			await page.render(renderContext).promise;

			// Extract region if specified
			if (region) {
				const croppedCanvas = document.createElement("canvas");
				const croppedCtx = croppedCanvas.getContext("2d")!;

				croppedCanvas.width = region.width;
				croppedCanvas.height = region.height;

				croppedCtx.drawImage(
					canvas,
					region.x * scale,
					region.y * scale,
					region.width * scale,
					region.height * scale,
					0,
					0,
					region.width,
					region.height
				);

				return {
					imageData: croppedCanvas.toDataURL("image/png"),
					width: region.width,
					height: region.height,
					sourceType: "pdf",
					metadata: {
						pdfPath,
						pageNumber,
						region,
						scale,
						captureTime: new Date().toISOString(),
					},
				};
			} else {
				return {
					imageData: canvas.toDataURL("image/png"),
					width: viewport.width / scale,
					height: viewport.height / scale,
					sourceType: "pdf",
					metadata: {
						pdfPath,
						pageNumber,
						scale,
						captureTime: new Date().toISOString(),
					},
				};
			}
		} catch (error) {
			throw new Error(
				`PDF.js capture failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async capturePdfWithElectron(
		pdfPath: string,
		pageNumber: number,
		region?: { x: number; y: number; width: number; height: number }
	): Promise<SnippingResult | null> {
		try {
			// This is a placeholder for Electron-based PDF processing
			// You could potentially use node-based PDF libraries here
			// For now, we'll indicate it's not implemented

			new Notice("Electron-based PDF capture not yet implemented");
			return null;
		} catch (error) {
			throw new Error(
				`Electron PDF capture failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	async loadPdfJsIfNeeded(): Promise<boolean> {
		try {
			// Check if PDF.js is already loaded
			if (typeof window !== "undefined" && (window as any).pdfjsLib) {
				return true;
			}

			// Attempt to load PDF.js dynamically
			// This would require PDF.js to be available in the plugin's resources
			// For now, just return false to indicate it's not available

			return false;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF.js loading error:", error);
			return false;
		}
	}

	async processImageFile(file: File): Promise<SnippingResult | null> {
		try {
			const imageData = await this.fileToDataUrl(file);
			const { width, height } = await this.getImageDimensions(imageData);

			return {
				imageData,
				width,
				height,
				sourceType: "file",
				metadata: {
					fileName: file.name,
					fileSize: file.size,
					mimeType: file.type,
					lastModified: new Date(file.lastModified).toISOString(),
					captureTime: new Date().toISOString(),
				},
			};
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Image processing error:",
				error
			);
			return null;
		}
	}

	private async blobToDataUrl(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	private async fileToDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	private async getImageDimensions(
		dataUrl: string
	): Promise<{ width: number; height: number }> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () =>
				resolve({ width: img.width, height: img.height });
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	async resizeImage(
		dataUrl: string,
		maxWidth: number,
		maxHeight: number,
		quality: number = 0.9
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d")!;

				// Calculate new dimensions while maintaining aspect ratio
				let { width, height } = img;

				if (width > maxWidth || height > maxHeight) {
					const widthRatio = maxWidth / width;
					const heightRatio = maxHeight / height;
					const ratio = Math.min(widthRatio, heightRatio);

					width = Math.round(width * ratio);
					height = Math.round(height * ratio);
				}

				canvas.width = width;
				canvas.height = height;

				// Use better image quality settings
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = "high";

				ctx.drawImage(img, 0, 0, width, height);

				// Convert to appropriate format
				const format = dataUrl.startsWith("data:image/png")
					? "image/png"
					: "image/jpeg";
				resolve(canvas.toDataURL(format, quality));
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	async cropImage(
		dataUrl: string,
		cropRegion: { x: number; y: number; width: number; height: number }
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d")!;

				canvas.width = cropRegion.width;
				canvas.height = cropRegion.height;

				ctx.drawImage(
					img,
					cropRegion.x,
					cropRegion.y,
					cropRegion.width,
					cropRegion.height,
					0,
					0,
					cropRegion.width,
					cropRegion.height
				);

				resolve(canvas.toDataURL("image/png"));
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	async convertFormat(
		dataUrl: string,
		format: "png" | "jpeg" | "webp",
		quality: number = 0.9
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d")!;

				canvas.width = img.width;
				canvas.height = img.height;

				// Fill with white background for JPEG (since it doesn't support transparency)
				if (format === "jpeg") {
					ctx.fillStyle = "white";
					ctx.fillRect(0, 0, canvas.width, canvas.height);
				}

				ctx.drawImage(img, 0, 0);

				const mimeType = `image/${format}`;
				resolve(canvas.toDataURL(mimeType, quality));
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}
}
