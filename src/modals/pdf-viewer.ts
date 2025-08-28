import { App, Modal, Notice } from "obsidian";
import { ExtractedImage, StitchedImage, LogLevel } from "../types";
import { GatedNotesPluginInterface } from "../types";

/**
 * Modal for viewing PDFs and capturing missing images via bounding box selection
 */
export class PDFViewerModal extends Modal {
	private pdfContainer!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private currentPage: number = 1;
	private totalPages: number = 0;
	private currentPdf: any = null;
	private currentScale: number = 1.5;
	private isSelecting: boolean = false;
	private selectionStart: { x: number; y: number } | null = null;
	private selectionRect: HTMLElement | null = null;
	private onImageCaptured: (image: ExtractedImage | StitchedImage) => void;

	constructor(
		app: App,
		private plugin: GatedNotesPluginInterface,
		onImageCaptured: (image: ExtractedImage | StitchedImage) => void,
		private sourcePdfPath?: string, // Optional source PDF path
		private startingPage?: number // Page to start viewing at
	) {
		super(app);
		this.onImageCaptured = onImageCaptured;
		this.setTitle("PDF Viewer - Capture Missing Images");
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass("pdf-viewer-modal");

		// Make modal large and resizable
		this.modalEl.style.width = "90vw";
		this.modalEl.style.height = "90vh";
		this.modalEl.style.maxWidth = "1200px";
		this.modalEl.style.maxHeight = "800px";

		// Create layout
		await this.createLayout();

		// Load source PDF if available, otherwise show file picker
		if (this.sourcePdfPath) {
			await this.loadPDFFromPath(this.sourcePdfPath);
		} else {
			await this.showPDFSelection();
		}
	}

	private async createLayout(): Promise<void> {
		const { contentEl } = this;

		// Controls bar
		const controls = contentEl.createDiv("pdf-controls");
		controls.style.cssText = `
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 10px;
			background: var(--background-secondary);
			border-radius: 4px;
			margin-bottom: 10px;
		`;

		// Page navigation
		const pageControls = controls.createDiv();
		pageControls.style.display = "flex";
		pageControls.style.alignItems = "center";
		pageControls.style.gap = "10px";

		const prevBtn = pageControls.createEl("button", { text: "◀" });
		prevBtn.onclick = () => this.previousPage();
		prevBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		const pageInfo = pageControls.createEl("span");
		pageInfo.id = "page-info";
		pageInfo.textContent = "Page 0 of 0";

		const nextBtn = pageControls.createEl("button", { text: "▶" });
		nextBtn.onclick = () => this.nextPage();
		nextBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		// Zoom controls
		const zoomControls = controls.createDiv();
		zoomControls.style.display = "flex";
		zoomControls.style.alignItems = "center";
		zoomControls.style.gap = "10px";

		const zoomOutBtn = zoomControls.createEl("button", { text: "−" });
		zoomOutBtn.onclick = () => this.zoomOut();
		zoomOutBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		const zoomInfo = zoomControls.createEl("span");
		zoomInfo.id = "zoom-info";
		zoomInfo.textContent = "150%";

		const zoomInBtn = zoomControls.createEl("button", { text: "+" });
		zoomInBtn.onclick = () => this.zoomIn();
		zoomInBtn.style.cssText = "padding: 5px 10px; border-radius: 4px;";

		// Instructions
		const instructions = controls.createDiv();
		instructions.style.cssText = `
			font-size: 12px;
			color: var(--text-muted);
			text-align: right;
		`;
		instructions.innerHTML = `
			<strong>Instructions:</strong><br/>
			Right-click + drag to select image region
		`;

		// PDF container
		this.pdfContainer = contentEl.createDiv("pdf-container");
		this.pdfContainer.style.cssText = `
			flex: 1;
			overflow: auto;
			border: 1px solid var(--background-modifier-border);
			border-radius: 4px;
			position: relative;
			background: #f0f0f0;
			min-height: 500px;
		`;

		// Create canvas for PDF rendering
		this.canvas = this.pdfContainer.createEl("canvas");
		this.canvas.style.cssText = `
			display: block;
			margin: 20px auto;
			cursor: crosshair;
			box-shadow: 0 4px 8px rgba(0,0,0,0.1);
		`;
		this.ctx = this.canvas.getContext("2d")!;

		// Add selection event handlers
		this.setupSelectionHandlers();

		// Button container
		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.cssText = `
			display: flex;
			justify-content: flex-end;
			gap: 10px;
			margin-top: 20px;
		`;

		const selectPdfBtn = buttonContainer.createEl("button", {
			text: "📂 Select Different PDF",
		});
		selectPdfBtn.onclick = () => this.showPDFSelection();
		selectPdfBtn.style.cssText = `
			padding: 8px 16px;
			border-radius: 4px;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border: 1px solid var(--background-modifier-border);
		`;

		const closeBtn = buttonContainer.createEl("button", { text: "Close" });
		closeBtn.onclick = () => this.close();
		closeBtn.style.cssText = `
			padding: 8px 16px;
			border-radius: 4px;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border: 1px solid var(--background-modifier-border);
		`;
	}

	private async showPDFSelection(): Promise<void> {
		// Create file input for PDF selection
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".pdf";
		input.style.display = "none";

		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (file) {
				await this.loadPDF(file);
			}
			document.body.removeChild(input);
		};

		input.oncancel = () => {
			document.body.removeChild(input);
		};

		document.body.appendChild(input);
		input.click();
	}

	private async loadPDFFromPath(pdfPath: string): Promise<void> {
		try {
			// Check if PDF.js is available
			if (!(await this.plugin.snippingTool.loadPdfJsIfNeeded())) {
				new Notice("PDF.js library is required but not available");
				await this.showPDFSelection(); // Fallback to file picker
				return;
			}

			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) {
				new Notice("PDF.js library not found");
				await this.showPDFSelection(); // Fallback to file picker
				return;
			}

			// Load PDF from path (this may require file system access)
			let loadingTask;
			try {
				// Try to load as URL first (for web contexts)
				loadingTask = pdfjsLib.getDocument(pdfPath);
			} catch (urlError) {
				// If URL loading fails, try fetching as file
				try {
					const response = await fetch(pdfPath);
					const arrayBuffer = await response.arrayBuffer();
					loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
				} catch (fetchError) {
					throw new Error(
						`Could not load PDF from path: ${
							fetchError instanceof Error
								? fetchError.message
								: String(fetchError)
						}`
					);
				}
			}

			this.currentPdf = await loadingTask.promise;
			this.totalPages = this.currentPdf.numPages;
			this.currentPage =
				this.startingPage &&
				this.startingPage >= 1 &&
				this.startingPage <= this.totalPages
					? this.startingPage
					: 1;

			// Render first page (or starting page)
			await this.renderCurrentPage();
			this.updatePageInfo();

			const fileName =
				pdfPath.split("/").pop() || pdfPath.split("\\").pop() || "PDF";
			new Notice(
				`📄 Loaded source PDF: ${fileName} (${this.totalPages} pages)`
			);
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"PDF path loading error:",
				error
			);
			new Notice(
				`Failed to load PDF from path. ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			// Fallback to file picker
			await this.showPDFSelection();
		}
	}

	private async loadPDF(file: File): Promise<void> {
		try {
			// Check if PDF.js is available
			if (!(await this.plugin.snippingTool.loadPdfJsIfNeeded())) {
				new Notice("PDF.js library is required but not available");
				return;
			}

			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) {
				new Notice("PDF.js library not found");
				return;
			}

			// Convert file to array buffer
			const arrayBuffer = await file.arrayBuffer();

			// Load PDF
			const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
			this.currentPdf = await loadingTask.promise;
			this.totalPages = this.currentPdf.numPages;
			this.currentPage = 1;

			// Render first page
			await this.renderCurrentPage();
			this.updatePageInfo();

			new Notice(
				`📄 Loaded PDF: ${file.name} (${this.totalPages} pages)`
			);
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF loading error:", error);
			new Notice(
				`Failed to load PDF: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async renderCurrentPage(): Promise<void> {
		if (!this.currentPdf) return;

		try {
			const page = await this.currentPdf.getPage(this.currentPage);
			const viewport = page.getViewport({ scale: this.currentScale });

			this.canvas.width = viewport.width;
			this.canvas.height = viewport.height;

			const renderContext = {
				canvasContext: this.ctx,
				viewport: viewport,
			};

			await page.render(renderContext).promise;
		} catch (error) {
			this.plugin.logger(LogLevel.NORMAL, "PDF rendering error:", error);
			new Notice("Failed to render PDF page");
		}
	}

	private setupSelectionHandlers(): void {
		let startX: number, startY: number;

		this.canvas.addEventListener("contextmenu", (e) => {
			e.preventDefault(); // Prevent browser context menu
		});

		this.canvas.addEventListener("mousedown", (e) => {
			if (e.button !== 2) return; // Only right mouse button

			e.preventDefault();
			this.isSelecting = true;

			const rect = this.canvas.getBoundingClientRect();
			startX = e.clientX - rect.left;
			startY = e.clientY - rect.top;

			this.selectionStart = { x: startX, y: startY };

			// Create selection rectangle overlay
			this.selectionRect = document.createElement("div");
			this.selectionRect.style.cssText = `
				position: absolute;
				border: 2px dashed var(--interactive-accent);
				background: rgba(var(--interactive-accent-rgb), 0.1);
				pointer-events: none;
				z-index: 1000;
			`;

			// Position relative to the canvas container
			const containerRect = this.pdfContainer.getBoundingClientRect();
			const canvasRect = this.canvas.getBoundingClientRect();

			this.selectionRect.style.left =
				canvasRect.left - containerRect.left + startX + "px";
			this.selectionRect.style.top =
				canvasRect.top - containerRect.top + startY + "px";
			this.selectionRect.style.width = "0px";
			this.selectionRect.style.height = "0px";

			this.pdfContainer.appendChild(this.selectionRect);
		});

		this.canvas.addEventListener("mousemove", (e) => {
			if (
				!this.isSelecting ||
				!this.selectionStart ||
				!this.selectionRect
			)
				return;

			const rect = this.canvas.getBoundingClientRect();
			const currentX = e.clientX - rect.left;
			const currentY = e.clientY - rect.top;

			const left = Math.min(this.selectionStart.x, currentX);
			const top = Math.min(this.selectionStart.y, currentY);
			const width = Math.abs(currentX - this.selectionStart.x);
			const height = Math.abs(currentY - this.selectionStart.y);

			// Update selection rectangle
			const containerRect = this.pdfContainer.getBoundingClientRect();
			const canvasRect = this.canvas.getBoundingClientRect();

			this.selectionRect.style.left =
				canvasRect.left - containerRect.left + left + "px";
			this.selectionRect.style.top =
				canvasRect.top - containerRect.top + top + "px";
			this.selectionRect.style.width = width + "px";
			this.selectionRect.style.height = height + "px";
		});

		this.canvas.addEventListener("mouseup", (e) => {
			if (!this.isSelecting || e.button !== 2) return;

			this.isSelecting = false;

			if (this.selectionStart && this.selectionRect) {
				const rect = this.canvas.getBoundingClientRect();
				const endX = e.clientX - rect.left;
				const endY = e.clientY - rect.top;

				const left = Math.min(this.selectionStart.x, endX);
				const top = Math.min(this.selectionStart.y, endY);
				const width = Math.abs(endX - this.selectionStart.x);
				const height = Math.abs(endY - this.selectionStart.y);

				// Only process if selection has meaningful size
				if (width > 10 && height > 10) {
					this.handleSelection({ x: left, y: top, width, height });
				}
			}

			// Clean up selection UI
			if (this.selectionRect) {
				this.pdfContainer.removeChild(this.selectionRect);
				this.selectionRect = null;
			}
			this.selectionStart = null;
		});
	}

	private async handleSelection(selection: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): Promise<void> {
		try {
			// Capture the selected region from the canvas
			const imageData = this.ctx.getImageData(
				selection.x,
				selection.y,
				selection.width,
				selection.height
			);

			// Create a temporary canvas for the selection
			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = selection.width;
			tempCanvas.height = selection.height;
			const tempCtx = tempCanvas.getContext("2d")!;
			tempCtx.putImageData(imageData, 0, 0);

			const capturedDataUrl = tempCanvas.toDataURL("image/png");

			// Show confirmation modal
			this.showConfirmationModal(capturedDataUrl, selection);
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Selection capture error:",
				error
			);
			new Notice("Failed to capture selection");
		}
	}

	private showConfirmationModal(
		imageData: string,
		selection: { x: number; y: number; width: number; height: number }
	): void {
		const confirmModal = new Modal(this.app);
		confirmModal.setTitle("Confirm Captured Image");

		confirmModal.contentEl.style.maxWidth = "600px";

		// Preview
		const preview = confirmModal.contentEl.createDiv();
		preview.style.textAlign = "center";
		preview.style.marginBottom = "20px";

		const img = preview.createEl("img");
		img.src = imageData;
		img.style.cssText = `
			max-width: 100%;
			max-height: 300px;
			border: 1px solid var(--background-modifier-border);
			border-radius: 4px;
		`;

		// Info
		const info = confirmModal.contentEl.createDiv();
		info.style.cssText = `
			text-align: center;
			color: var(--text-muted);
			font-size: 12px;
			margin-bottom: 20px;
		`;
		info.innerHTML = `
			<strong>Captured from:</strong> Page ${this.currentPage}<br/>
			<strong>Size:</strong> ${selection.width} × ${selection.height} pixels<br/>
			<strong>Scale:</strong> ${Math.round(this.currentScale * 100)}%
		`;

		// Buttons
		const buttons = confirmModal.contentEl.createDiv();
		buttons.style.cssText = `
			display: flex;
			justify-content: center;
			gap: 10px;
		`;

		const acceptBtn = buttons.createEl("button", { text: "✅ Looks Good" });
		acceptBtn.style.cssText = `
			padding: 10px 20px;
			background: var(--interactive-accent);
			color: white;
			border: none;
			border-radius: 4px;
			cursor: pointer;
		`;
		acceptBtn.onclick = () => {
			// Create ExtractedImage object and pass to callback
			const extractedImage: ExtractedImage = {
				id: `pdf_capture_${Date.now()}`,
				pageNumber: this.currentPage,
				imageData: imageData,
				width: selection.width,
				height: selection.height,
				filename: `pdf_capture_page${
					this.currentPage
				}_${Date.now()}.png`,
				x: selection.x / this.currentScale, // Convert back to PDF coordinates
				y: selection.y / this.currentScale,
			};

			this.onImageCaptured(extractedImage);
			confirmModal.close();
		};

		const retryBtn = buttons.createEl("button", { text: "🔄 Try Again" });
		retryBtn.style.cssText = `
			padding: 10px 20px;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border: 1px solid var(--background-modifier-border);
			border-radius: 4px;
			cursor: pointer;
		`;
		retryBtn.onclick = () => {
			confirmModal.close();
			// Modal remains open for another selection
		};

		confirmModal.open();
	}

	private async previousPage(): Promise<void> {
		if (this.currentPage > 1) {
			this.currentPage--;
			await this.renderCurrentPage();
			this.updatePageInfo();
		}
	}

	private async nextPage(): Promise<void> {
		if (this.currentPage < this.totalPages) {
			this.currentPage++;
			await this.renderCurrentPage();
			this.updatePageInfo();
		}
	}

	private async zoomIn(): Promise<void> {
		this.currentScale = Math.min(this.currentScale * 1.2, 3.0);
		await this.renderCurrentPage();
		this.updateZoomInfo();
	}

	private async zoomOut(): Promise<void> {
		this.currentScale = Math.max(this.currentScale / 1.2, 0.5);
		await this.renderCurrentPage();
		this.updateZoomInfo();
	}

	private updatePageInfo(): void {
		const pageInfo = this.contentEl.querySelector("#page-info");
		if (pageInfo) {
			pageInfo.textContent = `Page ${this.currentPage} of ${this.totalPages}`;
		}
	}

	private updateZoomInfo(): void {
		const zoomInfo = this.contentEl.querySelector("#zoom-info");
		if (zoomInfo) {
			zoomInfo.textContent = `${Math.round(this.currentScale * 100)}%`;
		}
	}

	onClose(): void {
		// Clean up
		if (
			this.selectionRect &&
			this.pdfContainer.contains(this.selectionRect)
		) {
			this.pdfContainer.removeChild(this.selectionRect);
		}
	}
}
