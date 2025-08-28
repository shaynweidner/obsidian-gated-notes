import { App, Modal, MarkdownRenderer, Notice } from "obsidian";
import {
	ExtractedImage,
	StitchedImage,
	ImagePlaceholder,
	GatedNotesPluginInterface,
} from "../types";
import { makeModalDraggable } from "../utils";

/**
 * Interactive modal for live markdown editing with image placement
 */
export class InteractiveEditor extends Modal {
	private editor!: HTMLTextAreaElement;
	private preview!: HTMLElement;
	private imageList!: HTMLElement;
	private content: string;
	private images: (ExtractedImage | StitchedImage)[];
	private placeholders: Map<string, ImagePlaceholder> = new Map();
	private onSave: (content: string) => void;
	private imageManager: any; // ImageManager type - will need to be imported
	private previewUpdateTimeout: NodeJS.Timeout | undefined;
	private selectedImages: Set<number> = new Set();
	private selectedImagesDisplay!: HTMLElement;
	private isPreviewMode: boolean = false;
	private scrollSyncPosition: number = 0;
	private toggleButton!: HTMLButtonElement;
	private editorContainer!: HTMLElement;
	private previewContainer!: HTMLElement;

	constructor(
		app: App,
		private plugin: GatedNotesPluginInterface,
		initialContent: string,
		images: (ExtractedImage | StitchedImage)[],
		onSave: (content: string) => void,
		private sourcePdfPath?: string, // Add optional PDF path
		private pageRangeStart?: number, // Starting page of range
		private pageRangeEnd?: number // Ending page of range
	) {
		super(app);
		this.content = initialContent;
		this.images = images;
		this.onSave = onSave;
		this.imageManager = new (this.plugin as any).ImageManager(plugin); // Temporary cast
		this.setTitle("Interactive Note Editor with Images");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("interactive-editor-modal");

		// Make modal draggable and resizable
		makeModalDraggable(this, this.plugin);
		this.makeResizable();

		// Create layout
		const container = contentEl.createDiv("editor-container");
		container.style.display = "flex";
		container.style.height = "70vh";
		container.style.gap = "20px";

		// Set initial modal size
		this.modalEl.style.width = "90vw";
		this.modalEl.style.height = "80vh";

		// Left panel: Combined Editor/Preview with toggle
		const editorPreviewPanel = container.createDiv("editor-preview-panel");
		editorPreviewPanel.style.flex = "1";
		editorPreviewPanel.style.display = "flex";
		editorPreviewPanel.style.flexDirection = "column";

		// Toggle button container
		const toggleContainer =
			editorPreviewPanel.createDiv("toggle-container");
		toggleContainer.style.display = "flex";
		toggleContainer.style.alignItems = "center";
		toggleContainer.style.marginBottom = "10px";
		toggleContainer.style.gap = "10px";

		toggleContainer.createEl("h3", { text: "Edit/Preview" });

		const toggleButton = toggleContainer.createEl("button", {
			text: "📝 Edit Mode",
			cls: "mod-cta",
		});
		toggleButton.onclick = () => this.toggleEditPreview();

		// Editor
		const editorContainer =
			editorPreviewPanel.createDiv("editor-container");
		editorContainer.style.flex = "1";
		editorContainer.style.display = "flex";
		editorContainer.style.flexDirection = "column";

		this.editor = editorContainer.createEl("textarea");
		this.editor.style.flex = "1";
		this.editor.style.fontFamily = "monospace";
		this.editor.style.fontSize = "14px";
		this.editor.style.resize = "none";
		this.editor.value = this.content;

		// Store references for later use
		this.toggleButton = toggleButton;
		this.editorContainer = editorContainer;

		this.editor.addEventListener("input", () => {
			this.content = this.editor.value;
			// Debounce preview updates to avoid freezing on rapid typing
			clearTimeout(this.previewUpdateTimeout);
			this.previewUpdateTimeout = setTimeout(() => {
				this.updatePreview().catch((error) => {
					console.error("Preview update failed:", error);
				});
			}, 300);
		});

		// Sync scroll position when scrolling in editor
		this.editor.addEventListener("scroll", () => {
			this.scrollSyncPosition = this.editor.scrollTop;
		});

		// Preview (initially hidden)
		const previewContainer =
			editorPreviewPanel.createDiv("preview-container");
		previewContainer.style.flex = "1";
		previewContainer.style.display = "none";
		previewContainer.style.flexDirection = "column";

		this.preview = previewContainer.createDiv("preview-content");
		this.preview.style.flex = "1";
		this.preview.style.border =
			"1px solid var(--background-modifier-border)";
		this.preview.style.padding = "10px";
		this.preview.style.overflow = "auto";
		this.preview.style.backgroundColor = "var(--background-primary)";

		// Store reference for later use
		this.previewContainer = previewContainer;

		// Sync scroll position when scrolling in preview
		this.preview.addEventListener("scroll", () => {
			this.scrollSyncPosition = this.preview.scrollTop;
		});

		// Right panel: Images
		const imagePanel = container.createDiv("image-panel");
		imagePanel.style.width = "300px";
		imagePanel.style.display = "flex";
		imagePanel.style.flexDirection = "column";

		imagePanel.createEl("h3", { text: "Available Images" });

		this.imageList = imagePanel.createDiv("image-list");
		this.imageList.style.flex = "1";
		this.imageList.style.overflow = "auto";
		this.imageList.style.border =
			"1px solid var(--background-modifier-border)";
		this.imageList.style.padding = "10px";

		// Populate image list
		this.populateImageList();

		// Initial preview update
		this.updatePreview();

		// Buttons
		const buttonContainer = contentEl.createDiv("button-container");
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "10px";
		buttonContainer.style.marginTop = "20px";

		const saveButton = buttonContainer.createEl("button", {
			text: "Save & Close",
		});
		saveButton.style.backgroundColor = "var(--interactive-accent)";
		saveButton.style.color = "white";
		saveButton.onclick = () => {
			this.onSave(this.content);
			this.close();
		};

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelButton.onclick = () => this.close();
	}

	/**
	 * Toggle between edit and preview modes with scroll synchronization
	 */
	private toggleEditPreview(): void {
		this.isPreviewMode = !this.isPreviewMode;

		if (this.isPreviewMode) {
			// Switch to preview mode
			this.editorContainer.style.display = "none";
			this.previewContainer.style.display = "flex";
			this.toggleButton.textContent = "👁️ Preview Mode";

			// Update preview content
			this.updatePreview()
				.then(() => {
					// Sync scroll position from editor to preview
					this.preview.scrollTop = this.scrollSyncPosition;
				})
				.catch((error) => {
					console.error("Failed to update preview:", error);
				});
		} else {
			// Switch to edit mode
			this.previewContainer.style.display = "none";
			this.editorContainer.style.display = "flex";
			this.toggleButton.textContent = "📝 Edit Mode";

			// Sync scroll position from preview to editor
			setTimeout(() => {
				this.editor.scrollTop = this.scrollSyncPosition;
			}, 50);
		}
	}

	/**
	 * Rotate an image 90 degrees clockwise
	 */
	private async rotateImage(
		imageIndex: number,
		imgElement: HTMLImageElement
	): Promise<void> {
		try {
			const image = this.images[imageIndex];

			// Create a canvas to rotate the image
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				throw new Error("Could not get canvas context");
			}

			// Create a new image object to load the current image data
			const img = new Image();
			img.onload = () => {
				// Set canvas dimensions (swap width/height for 90-degree rotation)
				canvas.width = img.height;
				canvas.height = img.width;

				// Rotate the canvas 90 degrees clockwise
				ctx.translate(canvas.width / 2, canvas.height / 2);
				ctx.rotate(Math.PI / 2);
				ctx.drawImage(img, -img.width / 2, -img.height / 2);

				// Get the rotated image data
				const rotatedDataUrl = canvas.toDataURL("image/png");

				// Update the image in our array
				const updatedImage = {
					...image,
					imageData: rotatedDataUrl,
					width: image.height, // Swap dimensions
					height: image.width,
				};
				this.images[imageIndex] = updatedImage;

				// Update the display
				imgElement.src = rotatedDataUrl;

				// Show feedback
				new Notice("Image rotated 90° clockwise");
			};

			img.src = image.imageData;
		} catch (error) {
			console.error("Failed to rotate image:", error);
			new Notice("Failed to rotate image");
		}
	}

	private populateImageList(): void {
		this.imageList.empty();

		if (this.images.length === 0) {
			this.imageList.createEl("p", { text: "No images available" });
			return;
		}

		this.images.forEach((image, index) => {
			const imageItem = this.imageList.createDiv("image-item");
			imageItem.style.marginBottom = "20px";
			imageItem.style.padding = "10px";
			imageItem.style.border =
				"1px solid var(--background-modifier-border)";
			imageItem.style.borderRadius = "5px";
			imageItem.style.cursor = "pointer";

			// Image preview
			const img = imageItem.createEl("img");
			img.src = image.imageData;
			img.style.maxWidth = "100%";
			img.style.maxHeight = "150px";
			img.style.objectFit = "contain";
			img.style.display = "block";
			img.style.marginBottom = "10px";

			// Image info
			const info = imageItem.createDiv();
			info.style.fontSize = "12px";
			info.style.color = "var(--text-muted)";

			if ("originalImages" in image) {
				info.innerHTML = `<strong>Stitched Image</strong><br/>
					${image.width}×${image.height}px<br/>
					${image.originalImages.length} fragments`;
			} else {
				info.innerHTML = `<strong>Page ${image.pageNumber}</strong><br/>
					${image.width}×${image.height}px<br/>
					${image.filename}`;
			}

			// Action buttons
			const actionButtons = imageItem.createDiv("action-buttons");
			actionButtons.style.display = "flex";
			actionButtons.style.gap = "5px";
			actionButtons.style.marginTop = "8px";
			actionButtons.style.justifyContent = "center";

			// Rotate button
			const rotateButton = actionButtons.createEl("button", {
				text: "↻ Rotate",
				cls: "mod-cta",
			});
			rotateButton.style.fontSize = "11px";
			rotateButton.style.padding = "2px 8px";
			rotateButton.onclick = async (e) => {
				e.preventDefault();
				e.stopPropagation();
				await this.rotateImage(index, img);
			};

			// Click to add placeholder or select for stitching
			imageItem.onclick = async (e) => {
				e.preventDefault();
				e.stopPropagation();

				// Check if Ctrl/Cmd is held for multi-selection
				if (e.ctrlKey || e.metaKey) {
					// Toggle selection
					if (this.selectedImages.has(index)) {
						this.selectedImages.delete(index);
						imageItem.style.border =
							"1px solid var(--background-modifier-border)";
					} else {
						this.selectedImages.add(index);
						imageItem.style.border =
							"3px solid var(--interactive-accent)";
					}

					// Update selection display
					this.updateSelectedImagesDisplay();
					return;
				}

				try {
					const placeholderId = `img_${Date.now()}_${index}`;
					const placeholder =
						this.imageManager.generateImagePlaceholder(
							placeholderId
						);

					// Insert at cursor position
					const cursorPos = this.editor.selectionStart;
					const beforeCursor = this.editor.value.substring(
						0,
						cursorPos
					);
					const afterCursor = this.editor.value.substring(cursorPos);

					this.editor.value =
						beforeCursor + placeholder + "\n" + afterCursor;
					this.content = this.editor.value;

					// Store placeholder info
					this.placeholders.set(placeholderId, {
						id: placeholderId,
						lineIndex: beforeCursor.split("\n").length - 1,
						placeholderText: placeholder,
					});

					// Visual feedback first (synchronous)
					imageItem.style.backgroundColor =
						"var(--background-modifier-success)";
					setTimeout(() => {
						imageItem.style.backgroundColor = "";
					}, 500);

					// Update preview asynchronously without blocking UI
					this.updatePreview().catch((error) => {
						console.error("Preview update failed:", error);
					});
				} catch (error) {
					console.error("Error adding image placeholder:", error);
					new Notice("Failed to add image placeholder");
				}
			};
		});

		// Add manual stitching controls
		const stitchingControls =
			this.imageList.createDiv("stitching-controls");
		stitchingControls.style.marginTop = "20px";
		stitchingControls.style.padding = "10px";
		stitchingControls.style.backgroundColor = "var(--background-secondary)";
		stitchingControls.style.borderRadius = "5px";

		const stitchButton = stitchingControls.createEl("button", {
			text: "Manual Stitch Selected Images",
		});
		stitchButton.style.cssText = `
			width: 100%; 
			margin-bottom: 10px; 
			background: var(--interactive-accent); 
			color: white; 
			border: none; 
			padding: 8px; 
			border-radius: 4px; 
			cursor: pointer;
		`;
		stitchButton.onclick = () => this.showManualStitchingModal();

		// Add Missing Images button
		const missingImagesButton = stitchingControls.createEl("button", {
			text: "📄 Capture Missing Images",
		});
		missingImagesButton.style.cssText = `
			width: 100%; 
			margin-bottom: 10px; 
			background: var(--interactive-normal); 
			color: var(--text-normal); 
			border: 1px solid var(--background-modifier-border); 
			padding: 8px; 
			border-radius: 4px; 
			cursor: pointer;
		`;
		missingImagesButton.onclick = () => this.showPDFViewerModal();

		const selectedCountEl = stitchingControls.createDiv();
		selectedCountEl.style.fontSize = "12px";
		selectedCountEl.style.color = "var(--text-muted)";
		selectedCountEl.textContent =
			"Select images by clicking them while holding Ctrl/Cmd";
		this.selectedImagesDisplay = selectedCountEl;

		// Add instructions
		const instructions = this.imageList.createDiv("instructions");
		instructions.style.marginTop = "20px";
		instructions.style.padding = "10px";
		instructions.style.backgroundColor = "var(--background-secondary)";
		instructions.style.borderRadius = "5px";
		instructions.style.fontSize = "12px";
		instructions.innerHTML = `
			<strong>Instructions:</strong><br/>
			• Click an image to insert a placeholder at cursor position<br/>
			• Ctrl/Cmd+Click to select multiple images for stitching<br/>
			• Edit the markdown text as needed<br/>
			• Placeholders will be replaced with actual images when saved
		`;
	}

	private async updatePreview(): Promise<void> {
		try {
			// Clear existing content first
			this.preview.empty();

			// Create a temporary container for rendering
			const tempContainer = this.preview.createDiv();

			// First, render the markdown as-is (with placeholders intact)
			const renderPromise = MarkdownRenderer.render(
				this.app,
				this.content,
				tempContainer,
				"",
				this.plugin as any
			);

			// Add timeout protection
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Render timeout")), 5000)
			);

			await Promise.race([renderPromise, timeoutPromise]);

			// After rendering, replace placeholders with clickable images
			this.placeholders.forEach((placeholder, id) => {
				const imageIndex = parseInt(id.split("_")[2]);
				if (imageIndex >= 0 && imageIndex < this.images.length) {
					const image = this.images[imageIndex];

					// Use a tree walker to find text nodes containing placeholders
					const walker = document.createTreeWalker(
						tempContainer,
						NodeFilter.SHOW_TEXT,
						null
					);

					const textNodes: Text[] = [];
					let node: Node | null;
					while ((node = walker.nextNode())) {
						if (
							node.textContent?.includes(
								placeholder.placeholderText
							)
						) {
							textNodes.push(node as Text);
						}
					}

					textNodes.forEach((textNode) => {
						if (
							textNode.textContent?.includes(
								placeholder.placeholderText
							)
						) {
							// Create clickable image element
							const imageEl = document.createElement("div");
							imageEl.className = "gn-clickable-placeholder";
							imageEl.style.cssText = `
								display: inline-block; 
								cursor: pointer; 
								margin: 5px; 
								border: 2px solid var(--interactive-accent);
								border-radius: 8px;
								padding: 5px;
								background: var(--background-secondary);
								position: relative;
								max-width: 300px;
							`;

							const img = imageEl.createEl("img");
							img.src = image.imageData;
							img.style.cssText = `
								max-width: 100%; 
								max-height: 150px; 
								display: block;
								border-radius: 4px;
							`;

							const label = imageEl.createEl("div");
							label.textContent = `Click to change image`;
							label.style.cssText = `
								font-size: 10px; 
								text-align: center; 
								color: var(--text-muted);
								margin-top: 5px;
							`;

							// Make it clickable to select different image
							imageEl.addEventListener("click", (e) => {
								e.stopPropagation();
								this.showImageSelectionForPlaceholder(id);
							});

							// Replace the text node with the image element
							const newContent = textNode.textContent.replace(
								placeholder.placeholderText,
								`<!-- PLACEHOLDER_REPLACEMENT_${id} -->`
							);

							if (textNode.parentNode) {
								// Create a temporary div to hold the new content
								const tempDiv = document.createElement("div");
								tempDiv.innerHTML = newContent;

								// Replace the placeholder marker with the actual image
								tempDiv.innerHTML = tempDiv.innerHTML.replace(
									`<!-- PLACEHOLDER_REPLACEMENT_${id} -->`,
									imageEl.outerHTML
								);

								// Replace the text node with the new content
								const fragment =
									document.createDocumentFragment();
								while (tempDiv.firstChild) {
									fragment.appendChild(tempDiv.firstChild);
								}
								textNode.parentNode.replaceChild(
									fragment,
									textNode
								);
							}
						}
					});
				}
			});
		} catch (error) {
			console.error("Preview rendering error:", error);
			this.preview.innerHTML = `
				<div style="color: var(--text-error); padding: 10px; background: var(--background-secondary); border-radius: 4px;">
					<strong>Preview Error:</strong><br/>
					${error instanceof Error ? error.message : String(error)}<br/>
					<small>Content will still be saved correctly.</small>
				</div>
			`;
		}
	}

	private updateSelectedImagesDisplay(): void {
		const count = this.selectedImages.size;
		if (count === 0) {
			this.selectedImagesDisplay.textContent =
				"Select images by clicking them while holding Ctrl/Cmd";
		} else {
			this.selectedImagesDisplay.textContent = `${count} image(s) selected for stitching`;
		}
	}

	private showPDFViewerModal(): void {
		// This will need to be imported from another modal file
		const PDFViewerModal = (this.plugin as any).PDFViewerModal;
		const pdfViewerModal = new PDFViewerModal(
			this.app,
			this.plugin,
			(capturedImage: ExtractedImage) => {
				// Callback when an image is captured from PDF
				this.images.push(capturedImage);
				this.populateImageList(); // Refresh the image list
				new Notice(
					`✅ Image captured from PDF! Added to image library.`
				);
			},
			this.sourcePdfPath, // Pass the source PDF path if available
			this.pageRangeStart // Start at first page of processed range
		);
		pdfViewerModal.open();
	}

	private showManualStitchingModal(): void {
		if (this.selectedImages.size < 2) {
			new Notice(
				"Please select at least 2 images to stitch together (Ctrl/Cmd+Click)"
			);
			return;
		}

		const selectedImageObjects = Array.from(this.selectedImages)
			.map((index) => this.images[index])
			.filter((img) => img);

		const modal = new Modal(this.app);
		modal.setTitle("Manual Image Stitching");

		modal.contentEl.createEl("p", {
			text: `You've selected ${selectedImageObjects.length} images. Choose how to arrange them:`,
		});

		// Preview of selected images
		const previewContainer = modal.contentEl.createDiv();
		previewContainer.style.display = "grid";
		previewContainer.style.gridTemplateColumns =
			"repeat(auto-fit, minmax(100px, 1fr))";
		previewContainer.style.gap = "10px";
		previewContainer.style.marginBottom = "20px";

		selectedImageObjects.forEach((image, index) => {
			const imgContainer = previewContainer.createDiv();
			imgContainer.style.textAlign = "center";

			const img = imgContainer.createEl("img");
			img.src = image.imageData;
			img.style.cssText =
				"max-width: 100px; max-height: 80px; object-fit: contain; border: 1px solid var(--background-modifier-border);";

			const label = imgContainer.createDiv();
			label.textContent = `${index + 1}`;
			label.style.fontSize = "12px";
			label.style.color = "var(--text-muted)";
		});

		// Arrangement options
		const arrangeContainer = modal.contentEl.createDiv();
		arrangeContainer.style.display = "flex";
		arrangeContainer.style.gap = "10px";
		arrangeContainer.style.marginBottom = "20px";

		const horizontalBtn = arrangeContainer.createEl("button", {
			text: "Arrange Horizontally",
		});
		const verticalBtn = arrangeContainer.createEl("button", {
			text: "Arrange Vertically",
		});
		const smartBtn = arrangeContainer.createEl("button", {
			text: "Smart Arrangement",
		});

		[horizontalBtn, verticalBtn, smartBtn].forEach((btn) => {
			btn.style.flex = "1";
			btn.style.padding = "10px";
			btn.style.border = "1px solid var(--background-modifier-border)";
			btn.style.borderRadius = "4px";
			btn.style.cursor = "pointer";
		});

		horizontalBtn.onclick = () => {
			modal.close();
			this.performManualStitch(selectedImageObjects, "horizontal");
		};

		verticalBtn.onclick = () => {
			modal.close();
			this.performManualStitch(selectedImageObjects, "vertical");
		};

		smartBtn.onclick = () => {
			modal.close();
			this.performManualStitch(selectedImageObjects, "smart");
		};

		modal.open();
	}

	private async performManualStitch(
		images: (ExtractedImage | StitchedImage)[],
		arrangement: "horizontal" | "vertical" | "smart"
	): Promise<void> {
		try {
			new Notice("🧩 Stitching images together...");

			// Convert to ExtractedImage format for stitching
			const extractedImages: ExtractedImage[] = images.map((img) => {
				if ("originalImages" in img) {
					// If it's already a stitched image, use the first original
					return img.originalImages[0];
				}
				return img as ExtractedImage;
			});

			// Arrange images based on selection
			let arrangedImages: ExtractedImage[];
			if (arrangement === "horizontal") {
				// Position images side-by-side from left to right
				let currentX = 0;
				arrangedImages = extractedImages.map((img, index) => {
					const positioned = {
						...img,
						x: currentX,
						y: 0,
					};
					currentX += img.width; // No spacing - images should touch
					return positioned;
				});
			} else if (arrangement === "vertical") {
				// Position images top-to-bottom
				let currentY = 0;
				arrangedImages = extractedImages.map((img, index) => {
					const positioned = {
						...img,
						x: 0,
						y: currentY,
					};
					currentY += img.height; // No spacing - images should touch
					return positioned;
				});
			} else {
				// Smart arrangement - for now, default to horizontal
				let currentX = 0;
				arrangedImages = extractedImages.map((img, index) => {
					const positioned = {
						...img,
						x: currentX,
						y: 0,
					};
					currentX += img.width;
					return positioned;
				});
			}

			const stitched = await (
				this.plugin as any
			).imageStitcher.stitchImages(arrangedImages);

			if (stitched) {
				// Add the stitched image to our images array
				this.images.push(stitched);

				// Clear selection
				this.selectedImages.clear();

				// Refresh the image list
				this.populateImageList();

				new Notice(
					`✅ Images stitched successfully! New composite image created.`
				);
			} else {
				new Notice("❌ Failed to stitch images together");
			}
		} catch (error) {
			console.error("Manual stitching error:", error);
			new Notice(
				`❌ Stitching failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private makeResizable(): void {
		const modalEl = this.modalEl;

		// Make the modal resizable
		modalEl.style.resize = "both";
		modalEl.style.overflow = "auto";
		modalEl.style.minWidth = "800px";
		modalEl.style.minHeight = "500px";
		modalEl.style.maxWidth = "95vw";
		modalEl.style.maxHeight = "95vh";

		// Add resize handle indicator
		const resizeHandle = modalEl.createDiv();
		resizeHandle.style.cssText = `
			position: absolute;
			bottom: 0;
			right: 0;
			width: 20px;
			height: 20px;
			background: linear-gradient(-45deg, transparent 30%, var(--text-muted) 30%, var(--text-muted) 35%, transparent 35%, transparent 65%, var(--text-muted) 65%, var(--text-muted) 70%, transparent 70%);
			cursor: nw-resize;
			pointer-events: none;
		`;

		// Adjust container height on resize (with delay for DOM setup)
		setTimeout(() => {
			const container = this.contentEl.querySelector(
				".editor-container"
			) as HTMLElement;
			if (container) {
				const resizeObserver = new ResizeObserver(() => {
					const modalHeight = modalEl.clientHeight;
					const headerHeight = 60; // Approximate header height
					const buttonHeight = 60; // Approximate button area height
					const padding = 40; // Padding and margins

					const availableHeight =
						modalHeight - headerHeight - buttonHeight - padding;
					container.style.height =
						Math.max(400, availableHeight) + "px";
				});

				resizeObserver.observe(modalEl);

				// Store observer for cleanup
				(this as any).resizeObserver = resizeObserver;
			}
		}, 100);
	}

	private showImageSelectionForPlaceholder(placeholderId: string): void {
		// Create a mini modal to select a different image for this placeholder
		const modal = new Modal(this.app);
		modal.setTitle("Select Image for Placeholder");

		const grid = modal.contentEl.createDiv();
		grid.style.display = "grid";
		grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(150px, 1fr))";
		grid.style.gap = "10px";
		grid.style.maxHeight = "400px";
		grid.style.overflow = "auto";

		this.images.forEach((image, index) => {
			const imageItem = grid.createDiv();
			imageItem.style.cssText = `
				cursor: pointer;
				padding: 10px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 5px;
				text-align: center;
			`;

			const img = imageItem.createEl("img");
			img.src = image.imageData;
			img.style.cssText =
				"max-width: 100%; max-height: 100px; object-fit: contain;";

			const info = imageItem.createDiv();
			info.style.fontSize = "10px";
			info.style.color = "var(--text-muted)";
			info.style.marginTop = "5px";

			if ("originalImages" in image) {
				info.textContent = `Stitched (${image.originalImages.length} parts)`;
			} else {
				info.textContent = `Page ${image.pageNumber}`;
			}

			imageItem.onclick = () => {
				// Update the placeholder to point to this image
				const newPlaceholderId = `img_${Date.now()}_${index}`;
				const newPlaceholder =
					this.imageManager.generateImagePlaceholder(
						newPlaceholderId
					);
				const oldPlaceholder = this.placeholders.get(placeholderId);

				if (oldPlaceholder) {
					// Replace in content
					this.content = this.content.replace(
						oldPlaceholder.placeholderText,
						newPlaceholder
					);
					this.editor.value = this.content;

					// Update placeholders map
					this.placeholders.delete(placeholderId);
					this.placeholders.set(newPlaceholderId, {
						id: newPlaceholderId,
						lineIndex: oldPlaceholder.lineIndex,
						placeholderText: newPlaceholder,
					});
				}

				modal.close();
				this.updatePreview();
			};
		});

		modal.open();
	}

	onClose(): void {
		// Clean up timeout
		if (this.previewUpdateTimeout) {
			clearTimeout(this.previewUpdateTimeout);
		}

		// Clean up resize observer
		if ((this as any).resizeObserver) {
			((this as any).resizeObserver as ResizeObserver).disconnect();
		}
	}
}
