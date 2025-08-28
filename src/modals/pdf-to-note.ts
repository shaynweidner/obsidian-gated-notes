import {
	Modal,
	Setting,
	TextComponent,
	TextAreaComponent,
	ToggleComponent,
	ButtonComponent,
	Notice,
	TFile,
} from "obsidian";
import {
	GatedNotesPluginInterface,
	ExtractedImage,
	LogLevel,
	StitchedImage,
} from "../types";
import {
	makeModalDraggable,
	countTextTokens,
	logLlmCall,
	getParagraphsFromFinalizedNote,
} from "../utils";
import { InteractiveEditor, ExampleNoteSuggester } from "../modals";
import OpenAI from "openai";

/**
 * A modal for converting a PDF file into a structured Obsidian note using AI.
 */
export class PdfToNoteModal extends Modal {
	private fileInput!: HTMLInputElement;
	private chapterNameInput!: TextComponent;
	private folderSelect!: HTMLSelectElement;
	private newFolderInput!: TextComponent;
	private pdfViewer!: HTMLElement;
	private costUi!: { update: () => Promise<string> };
	private extractedText: string = "";
	private selectedFile: File | null = null;
	private exampleNotePath: string = "";
	private exampleNoteContent: string = "";
	private examplePdfFile: File | null = null;
	private examplePdfModeSelect!: HTMLSelectElement;
	private examplePdfModeContainer!: HTMLElement;
	private examplePdfPages: Array<{
		pageNum: number;
		imageData: string;
		textContent?: string;
	}> = [];
	private cleanupToggleComponent!: ToggleComponent;

	// Token limit controls
	private limitMainTokensToggle!: ToggleComponent;
	private mainTokensInput!: TextComponent;
	private limitNuclearReviewTokensToggle!: ToggleComponent;
	private nuclearReviewTokensInput!: TextComponent;
	private limitCleanupTokensToggle!: ToggleComponent;
	private cleanupTokensInput!: TextComponent;
	private guidanceInput?: TextAreaComponent;
	private processingModeSelect!: HTMLSelectElement;
	private dpiInput!: TextComponent;
	private maxWidthInput!: TextComponent;
	private pageRangeFromInput!: TextComponent;
	private pageRangeToInput!: TextComponent;
	private pageRangeErrorEl!: HTMLElement;
	private totalPdfPages: number = 0;
	private examplePdfPageRangeFromInput!: TextComponent;
	private examplePdfPageRangeToInput!: TextComponent;
	private examplePdfPageRangeErrorEl!: HTMLElement;
	private examplePdfTotalPages: number = 0;
	private includeTextToggle!: ToggleComponent;
	private preloadStatusEl!: HTMLElement;
	private isPreloadingImages = false;
	private preloadingPromise: Promise<void> | null = null;
	private renderedPages: Array<{
		pageNum: number;
		imageData: string;
		textContent?: string;
	}> = [];
	private extractedImages: ExtractedImage[] = [];
	private useContextToggle!: ToggleComponent;
	private contextPagesInput!: TextComponent;
	private contextPagesContainer!: HTMLElement;
	private useFutureContextToggle!: ToggleComponent;
	private futureContextPagesInput!: TextComponent;
	private futureContextContainer!: HTMLElement;
	private useNuclearOptionToggle!: ToggleComponent;

	constructor(private plugin: GatedNotesPluginInterface) {
		super(plugin.app);
	}

	async onOpen() {
		this.titleEl.setText("Convert PDF to Note (Enhanced)");
		this.modalEl.addClass("gn-pdf-modal");
		makeModalDraggable(this, this.plugin);

		const warningEl = this.contentEl.createDiv({
			attr: {
				style: "background: var(--background-modifier-error); padding: 10px; border-radius: 5px; margin-bottom: 15px;",
			},
		});
		warningEl.createEl("strong", { text: "⚠️ Enhanced PDF Conversion" });
		warningEl.createEl("p", {
			text: "This enhanced PDF converter supports both text-only and hybrid (text + image) modes for better handling of complex documents with formulas and figures.",
			attr: { style: "margin: 5px 0 0 0; font-size: 0.9em;" },
		});

		new Setting(this.contentEl)
			.setName("Select PDF File")
			.addButton((btn) => {
				btn.setButtonText("Choose File").onClick(() =>
					this.fileInput.click()
				);
			});

		this.fileInput = this.contentEl.createEl("input", {
			type: "file",
			attr: { accept: ".pdf", style: "display: none;" },
		}) as HTMLInputElement;

		this.fileInput.onchange = (e) => this.handleFileSelection(e);

		this.pdfViewer = this.contentEl.createDiv({
			cls: "pdf-viewer",
			attr: {
				style: "margin-top: 10px; min-height: 200px; border: 1px solid var(--background-modifier-border); padding: 10px;",
			},
		});
		this.pdfViewer.setText("No PDF selected");

		this.setupProcessingModeControls();

		this.preloadStatusEl = this.contentEl.createDiv({
			cls: "gn-processing-status",
			attr: { style: "display: none;" },
		});

		new Setting(this.contentEl)
			.setName("Chapter Name")
			.setDesc("Name for the new note/chapter")
			.addText((text) => {
				this.chapterNameInput = text;
				text.setPlaceholder("Enter chapter name...");
				text.onChange(() => this.costUi?.update());
			});

		const folderSetting = new Setting(this.contentEl).setName(
			"Destination Folder"
		);
		this.folderSelect = folderSetting.controlEl.createEl("select");
		this.newFolderInput = new TextComponent(folderSetting.controlEl);

		await this.populateFolderOptions();

		this.folderSelect.onchange = () => {
			const isNewFolder = this.folderSelect.value === "__new__";
			this.newFolderInput.inputEl.style.display = isNewFolder
				? "block"
				: "none";
		};

		this.newFolderInput.setPlaceholder("Enter new folder name...");
		this.newFolderInput.inputEl.style.display = "none";

		this.setupExampleNoteSection();

		this.setupContextControlSection();

		this.setupTokenLimitSection();

		this.setupNuclearOptionSection();

		const guidanceContainer = this.contentEl.createDiv();
		const addGuidanceBtn = new ButtonComponent(guidanceContainer)
			.setButtonText("Add Custom Guidance")
			.onClick(() => {
				addGuidanceBtn.buttonEl.style.display = "none";
				new Setting(guidanceContainer)
					.setName("Custom Guidance")
					.setDesc(
						"Provide specific instructions for the AI (e.g., 'Focus on definitions', 'Summarize each section')."
					)
					.addTextArea((text) => {
						this.guidanceInput = text;
						text.setPlaceholder("Your custom instructions...");
						text.inputEl.rows = 4;
						text.inputEl.style.width = "100%";
						text.onChange(() => this.costUi?.update());
					});
			});

		const postProcessingSection = this.contentEl.createDiv();
		postProcessingSection.createEl("h4", {
			text: "Post-Processing (Optional)",
		});
		new Setting(postProcessingSection)
			.setName("Clean repetitive headers/footers")
			.setDesc(
				"Runs an additional AI pass to remove recurring text like chapter titles from page headers. This will incur additional cost and time."
			)
			.addToggle((toggle) => {
				this.cleanupToggleComponent = toggle;
				toggle.setValue(false).onChange(() => {
					this.updateTokenControlVisibility();
					this.costUi?.update();
				});
			});

		const costContainer = this.contentEl.createDiv();
		this.costUi = this.plugin.createCostEstimatorUI(
			costContainer,
			async () => {
				const isHybridMode =
					this.processingModeSelect.value === "hybrid";
				const pageCount = this.getEstimatedPageCount();
				const textContentTokens = countTextTokens(this.extractedText);
				const guidance = this.guidanceInput?.getValue() || "";
				const useNuclearOption =
					this.useNuclearOptionToggle?.getValue() || false;

				let mainPromptText: string;
				let mainImageCount: number;
				const mainDetails: {
					textContentTokens: number;
					isHybrid: boolean;
					pageCount?: number;
					useNuclearOption: boolean;
					nuclearMultiplier?: number;
				} = {
					textContentTokens,
					isHybrid: isHybridMode,
					pageCount: isHybridMode ? pageCount : undefined,
					useNuclearOption,
				};

				if (isHybridMode) {
					// Estimate for hybrid processing
					mainPromptText = this.buildHybridPrompt(
						1,
						"Sample text for estimation",
						guidance
					);
					mainImageCount = pageCount;

					// If cleanup is enabled, add estimated tokens for the cleanup pass
					if (this.cleanupToggleComponent?.getValue()) {
						// Estimate the output size from hybrid processing
						const estimatedHybridOutput = pageCount * 1000; // rough estimate of tokens per page

						// Build a sample cleanup prompt for cost estimation
						const sampleCleanupPrompt =
							this.buildReconstructionPrompt(
								"X".repeat(estimatedHybridOutput), // Dummy markdown content
								this.extractedText // Use actual PDF text
							);

						// Add cleanup prompt tokens to the total
						mainPromptText += "\n\n" + sampleCleanupPrompt;
					}
				} else {
					// Text-only mode
					mainPromptText = this.buildPrompt(
						this.extractedText,
						this.exampleNoteContent,
						guidance
					);
					mainImageCount = 0;

					// If cleanup is enabled for text mode
					if (this.cleanupToggleComponent?.getValue()) {
						const estimatedTextOutput = textContentTokens; // Assume similar size output
						const sampleCleanupPrompt = this.buildCleanupPrompt(
							"X".repeat(estimatedTextOutput)
						);
						mainPromptText += "\n\n" + sampleCleanupPrompt;
					}
				}

				// Nuclear option multiplier
				let finalPromptText = mainPromptText;
				let finalImageCount = mainImageCount;

				if (useNuclearOption) {
					// Nuclear option adds 2 passes:
					// 1. Initial processing (existing cost)
					// 2. Validation pass (small)
					// 3. Deduplication pass (medium)
					// 4. Final review pass (large)
					const estimatedNuclearMultiplier = 2.5; // Conservative estimate for 2-phase

					// Simulate additional processing cost
					finalPromptText = mainPromptText.repeat(
						Math.ceil(estimatedNuclearMultiplier)
					);
					finalImageCount = Math.ceil(mainImageCount * 1.2); // Images used in first pass only, plus small validation cost

					mainDetails.nuclearMultiplier = estimatedNuclearMultiplier;
				}

				return {
					promptText: finalPromptText,
					imageCount: finalImageCount,
					action: "pdf_to_note",
					details: mainDetails,
				};
			}
		);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Convert")
					.setCta()
					.onClick(() => this.handleConvert())
			);
	}

	private setupProcessingModeControls(): void {
		const modeSection = this.contentEl.createDiv();
		modeSection.createEl("h4", { text: "Processing Mode" });

		new Setting(modeSection)
			.setName("Conversion Mode")
			.setDesc(
				"Choose between text-only extraction or hybrid mode with images"
			)
			.addDropdown((dropdown) => {
				this.processingModeSelect = dropdown.selectEl;
				dropdown
					.addOption("text", "Text Only (Fast, Lower Cost)")
					.addOption(
						"hybrid",
						"Hybrid (Text + Images, Better for Formulas)"
					)
					.setValue("text")
					.onChange(() => {
						this.toggleHybridControls();
						this.toggleExamplePdfModeControls();
						this.costUi?.update();
						// Image rendering will happen on-demand during Convert
					});
			});

		// Page Range (available for both text and hybrid modes)
		new Setting(modeSection)
			.setName("Page Range")
			.setDesc(
				"Specify page range to process (leave empty for all pages)"
			)
			.addText((text) => {
				this.pageRangeFromInput = text;
				text.setPlaceholder("From (e.g., 1)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validatePageRange();
					this.updateSmartDefaults();
					this.updateTextPreview();
					this.costUi?.update();
				});
			})
			.addText((text) => {
				this.pageRangeToInput = text;
				text.setPlaceholder("To (e.g., 10)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validatePageRange();
					this.updateSmartDefaults();
					this.updateTextPreview();
					this.costUi?.update();
				});
			});

		// Add error display for page range validation
		this.pageRangeErrorEl = modeSection.createDiv({
			attr: {
				style: "color: var(--color-red); font-size: 0.9em; margin-top: 5px; display: none;",
			},
		});

		const hybridControls = modeSection.createDiv({
			cls: "gn-hybrid-controls",
			attr: {
				style: "display: none; margin-top: 10px; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 5px;",
			},
		});

		hybridControls.createEl("h5", { text: "Hybrid Mode Settings" });

		new Setting(hybridControls)
			.setName("Image Quality")
			.setDesc(
				"DPI for page rendering (higher = better quality, larger files)"
			)
			.addText((text) => {
				this.dpiInput = text;
				text.setValue("200");
				text.setPlaceholder("200");
				text.inputEl.style.width = "80px";
			});

		new Setting(hybridControls)
			.setName("Max Image Width")
			.setDesc(
				"Maximum width in pixels (keeps images compact while maintaining detail)"
			)
			.addText((text) => {
				this.maxWidthInput = text;
				text.setValue("1400");
				text.setPlaceholder("1400");
				text.inputEl.style.width = "100px";
			});

		new Setting(hybridControls)
			.setName("Include Text Context")
			.setDesc(
				"Include PDF text extraction alongside images for better AI processing"
			)
			.addToggle((toggle) => {
				this.includeTextToggle = toggle;
				toggle.setValue(true);
			});

		this.hybridControls = hybridControls;
	}

	private hybridControls!: HTMLElement;

	private toggleHybridControls(): void {
		const isHybrid = this.processingModeSelect.value === "hybrid";
		this.hybridControls.style.display = isHybrid ? "block" : "none";
	}

	private toggleExamplePdfModeControls(): void {
		const isMainHybrid = this.processingModeSelect.value === "hybrid";
		const hasExamplePdf = this.examplePdfFile !== null;

		// Only show example PDF mode controls if:
		// 1. Main PDF is in hybrid mode (so we have a choice)
		// 2. An example PDF has been selected
		if (isMainHybrid && hasExamplePdf) {
			this.examplePdfModeContainer.style.display = "block";
			// Update available options based on main PDF mode
			this.examplePdfModeSelect.innerHTML = `
				<option value="text">Text-only</option>
				<option value="hybrid">Hybrid (Text + Images)</option>
			`;
			// Process example PDF if switching to hybrid mode
			this.processExamplePdf();
		} else if (hasExamplePdf) {
			// If main PDF is text-only, hide the dropdown (text-only is implied)
			this.examplePdfModeContainer.style.display = "none";
			// Clear processed pages since we're not using hybrid mode
			this.examplePdfPages = [];
		} else {
			// No example PDF selected, hide controls
			this.examplePdfModeContainer.style.display = "none";
		}
	}

	private getEstimatedPageCount(): number {
		if (!this.selectedFile) return 1;

		const fromPage = parseInt(this.pageRangeFromInput?.getValue() || "1");
		const toPage = parseInt(this.pageRangeToInput?.getValue() || "");

		if (toPage && fromPage) {
			return Math.max(1, toPage - fromPage + 1);
		}

		// Rough estimate based on file size (very approximate)
		const mbSize = this.selectedFile.size / (1024 * 1024);
		return Math.max(1, Math.round(mbSize * 10)); // ~10 pages per MB estimate
	}

	private async handleFileSelection(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		this.selectedFile = file;
		this.pdfViewer.setText("Processing PDF...");

		try {
			// Always try text extraction first for preview
			await this.extractTextFromPdf(file);

			if (!this.chapterNameInput.getValue()) {
				const suggestedName = file.name.replace(/\.pdf$/i, "");
				this.chapterNameInput.setValue(suggestedName);
			}

			await this.costUi.update();

			// Image rendering will happen on-demand during Convert if needed
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			this.pdfViewer.setText(`Error processing PDF: ${errorMessage}`);
			console.error("PDF processing error:", error);
		}
	}

	// Removed preloadPdfImages - images are now rendered on-demand during Convert

	private async extractTextFromPdf(file: File): Promise<void> {
		try {
			const pdfjsLib = await this.loadPdfJs();
			const typedArray = new Uint8Array(await file.arrayBuffer());
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			// Store total pages for validation
			this.totalPdfPages = pdf.numPages;

			// Respect page range for text extraction too
			const fromPage = parseInt(
				this.pageRangeFromInput?.getValue() || "1"
			);
			const toPage = parseInt(
				this.pageRangeToInput?.getValue() || pdf.numPages.toString()
			);

			let fullText = "";
			for (
				let i = Math.max(1, fromPage);
				i <= Math.min(pdf.numPages, toPage);
				i++
			) {
				const page = await pdf.getPage(i);

				// 1) Ask for marked content & let pdf.js pre-combine glyphs
				const textContent = await page.getTextContent({
					includeMarkedContent: true,
					disableCombineTextItems: false,
				});

				const pageText = this.extractBlocksFromReadingOrder(
					textContent.items
				);
				fullText += `\n\n--- PAGE ${i} ---\n\n` + pageText + "\n";
			}

			this.extractedText = fullText;
			console.log("fullText:", fullText);

			this.pdfViewer.empty();
			const preview = this.pdfViewer.createEl("div");
			const actualFrom = Math.max(1, fromPage);
			const actualTo = Math.min(pdf.numPages, toPage);
			const pageRangeText =
				actualFrom === actualTo
					? `page ${actualFrom}`
					: `pages ${actualFrom}-${actualTo}`;
			preview.createEl("p", {
				text: `✅ PDF processed: ${file.name} (${pageRangeText} of ${pdf.numPages} total)`,
			});
			const textPreview = preview.createEl("pre", {
				attr: {
					style: "max-height: 150px; overflow-y: auto; font-size: 12px; background: var(--background-secondary); padding: 10px;",
				},
			});
			textPreview.setText(fullText.substring(0, 500) + "...");

			// Trigger validation and smart defaults now that we know the total pages
			this.validatePageRange();
			this.updateSmartDefaults();
		} catch (error) {
			throw new Error(`Failed to extract text: ${error}`);
		}
	}

	/**
	 * Build cohesive blocks following pdf.js “selection” order
	 * (with includeMarkedContent), preserving intra-region flow.
	 * We split into lines, then split into blocks when the flow
	 * clearly jumps (new column/callout) or on explicit separators.
	 */
	private extractBlocksFromReadingOrder(items: any[]): string {
		type T = {
			str: string;
			x: number;
			y: number;
			w: number;
			h: number;
			font?: string;
			hasEOL?: boolean;
		};

		const textItems: T[] = items
			.filter((it) => typeof it.str === "string")
			.map((it) => ({
				str: it.str,
				x: it.transform[4],
				y: it.transform[5],
				w: it.width ?? 0,
				h: it.height ?? 0,
				font: it.fontName,
				hasEOL: !!it.hasEOL,
			}));

		if (!textItems.length) return "";

		// --- Step 1: turn items into "lines" (based on Y proximity) ---
		const yTol = 2.5; // same line if |Δy| <= yTol
		const xGapJoin = 8; // insert space if glyph gap is small (heuristic)

		const lines: { y: number; x0: number; text: string; font?: string }[] =
			[];
		let curLine: T[] = [];

		const flushLine = () => {
			if (!curLine.length) return;
			// sort a line by X, then join with spaces where gaps are reasonable
			curLine.sort((a, b) => a.x - b.x);
			let line = "";
			for (let i = 0; i < curLine.length; i++) {
				const t = curLine[i];
				if (i > 0) {
					const prev = curLine[i - 1];
					const gap = t.x - (prev.x + prev.w);
					if (gap > 0 && gap < xGapJoin) line += " ";
					else if (gap >= xGapJoin) line += " ";
				}
				line += t.str;
			}
			const yAvg = curLine.reduce((s, t) => s + t.y, 0) / curLine.length;
			const xMin = Math.min(...curLine.map((t) => t.x));
			lines.push({
				y: yAvg,
				x0: xMin,
				text: line.trim(),
				font: curLine[0].font,
			});
			curLine = [];
		};

		let prevY = textItems[0].y;
		for (const t of textItems) {
			// explicit empty + hasEOL acts like a hard line break separator
			if (t.hasEOL && t.str === "") {
				flushLine();
				// later we’ll treat this as a potential block boundary
				lines.push({
					y: Number.NaN,
					x0: 0,
					text: "\uE000_EOL_SPLIT\uE000",
				});
				prevY = t.y;
				continue;
			}

			if (!curLine.length) {
				curLine.push(t);
				prevY = t.y;
				continue;
			}

			// same line if Y is very close
			if (Math.abs(t.y - prevY) <= yTol) {
				curLine.push(t);
				prevY = t.y;
			} else {
				flushLine();
				curLine.push(t);
				prevY = t.y;
			}
		}
		flushLine();

		// --- Step 2: group lines into "blocks" (paragraphs/regions) ---
		// Heuristics:
		//  • start a new block if we see the explicit EOL_SPLIT sentinel
		//  • or Y goes *upward* significantly vs previous line (selection jumped)
		//  • or big X reset while Y is similar (moved to another text box)
		//  • or font-size family changes drastically (often headings/callouts)
		const blocks: string[] = [];
		const block: string[] = [];

		const newBlock = () => {
			const txt = block
				.join("\n")
				.replace(/\n{2,}/g, "\n")
				.trim();
			if (txt) blocks.push(txt);
			block.length = 0;
		};

		const yJumpUp = 18; // selection jumped higher on the page
		const xReset = 80; // moved to a distant left start
		const headingFontHint = (f?: string) => f && /_f1\b|_f3\b/.test(f); // tune per doc

		for (let i = 0; i < lines.length; i++) {
			const L = lines[i];
			if (L.text === "\uE000_EOL_SPLIT\uE000") {
				newBlock();
				continue;
			}

			const P = i > 0 ? lines[i - 1] : undefined;

			let boundary = false;
			if (P && isFinite(P.y) && isFinite(L.y)) {
				if (L.y - P.y > yJumpUp) boundary = true; // jumped upward
				if (
					!boundary &&
					Math.abs(L.y - P.y) <= yTol &&
					P.x0 - L.x0 > xReset
				)
					boundary = true; // big left reset at similar Y
			}

			if (!boundary && headingFontHint(L.font)) boundary = true;

			if (boundary) newBlock();
			block.push(L.text);
		}
		newBlock();

		return blocks.join("\n\n");
	}

	private async loadPdfJs(): Promise<any> {
		if ((window as any).pdfjsLib) {
			return (window as any).pdfjsLib;
		}

		try {
			const script = document.createElement("script");
			script.src =
				"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
			document.head.appendChild(script);

			return new Promise((resolve, reject) => {
				script.onload = () => {
					const pdfjsLib = (window as any).pdfjsLib;
					if (pdfjsLib) {
						pdfjsLib.GlobalWorkerOptions.workerSrc =
							"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
						resolve(pdfjsLib);
					} else {
						reject(new Error("pdf.js failed to load"));
					}
				};
				script.onerror = () =>
					reject(new Error("Failed to load pdf.js from CDN"));
				setTimeout(
					() => reject(new Error("pdf.js loading timeout")),
					10000
				);
			});
		} catch (error) {
			throw new Error(
				"pdf.js not available. Please check your internet connection."
			);
		}
	}

	private extractParagraphsFromTextContent(items: any[]): string {
		// Use marked content order (proper reading order) instead of spatial heuristics
		return items
			.filter(
				(item: any) =>
					item.str && typeof item.str === "string" && item.str.trim()
			)
			.map((item: any) => item.str)
			.join("")
			.trim();
	}

	/**
	 * Improved text extraction that handles multi-column layouts by detecting columns
	 * and reading each column top-to-bottom before moving to the next column.
	 */
	private extractTextWithColumnAwareness(items: any[]): string {
		if (!items || items.length === 0) return "";

		// Define text item type
		type TextItem = {
			str: string;
			x: number;
			y: number;
			width: number;
			height: number;
		};

		const textItems: TextItem[] = items
			.filter((item) => item.str && item.str.trim())
			.map((item) => ({
				str: item.str,
				x: item.transform[4], // x coordinate
				y: item.transform[5], // y coordinate
				width: item.width || 0,
				height: item.height || 0,
			}));

		if (textItems.length === 0) return "";

		// Step 1: Detect columns by analyzing X-coordinate distribution
		const columns = this.detectColumns(textItems);

		// Step 2: Assign each text item to its appropriate column
		const columnTexts: string[] = [];

		for (const column of columns) {
			// Get all text items that belong to this column
			const columnItems = textItems.filter(
				(item) => item.x >= column.left && item.x <= column.right
			);

			// Sort by Y coordinate (top to bottom)
			columnItems.sort((a, b) => b.y - a.y); // Higher Y = top of page

			// Group into lines based on Y proximity
			const lines = this.groupIntoLines(columnItems);

			// Convert to text
			const columnText = lines
				.map((line) => line.join(" ").trim())
				.filter((text) => text)
				.join("\n");

			if (columnText) {
				columnTexts.push(columnText);
			}
		}

		return columnTexts.join("\n\n");
	}

	/**
	 * Detects column boundaries based on X-coordinate clustering
	 */
	private detectColumns(
		items: Array<{
			str: string;
			x: number;
			y: number;
			width: number;
			height: number;
		}>
	): Array<{ left: number; right: number; center: number }> {
		if (items.length === 0) return [];

		// Get all X coordinates
		const xCoords = items.map((item) => item.x).sort((a, b) => a - b);

		// Find clusters of X coordinates (potential column starts)
		const clusters: number[][] = [];
		const clusterTolerance = 30; // Items within 30 units are same column

		for (const x of xCoords) {
			// Find existing cluster this X belongs to
			let foundCluster = clusters.find((cluster) =>
				cluster.some(
					(clusterX) => Math.abs(x - clusterX) <= clusterTolerance
				)
			);

			if (foundCluster) {
				foundCluster.push(x);
			} else {
				clusters.push([x]);
			}
		}

		// Convert clusters to column definitions
		const columns = clusters
			.filter((cluster) => cluster.length >= 3) // Require at least 3 items to be a column
			.map((cluster) => {
				const minX = Math.min(...cluster);
				const maxX = Math.max(...cluster);

				// Expand column boundaries to capture nearby text
				const expansion = 50;

				return {
					left: minX - expansion,
					right: maxX + expansion,
					center: (minX + maxX) / 2,
				};
			})
			.sort((a, b) => a.center - b.center); // Left to right

		// If no clear columns detected, treat as single column
		if (columns.length === 0) {
			const minX = Math.min(...items.map((item) => item.x));
			const maxX = Math.max(...items.map((item) => item.x + item.width));
			return [
				{
					left: minX - 10,
					right: maxX + 10,
					center: (minX + maxX) / 2,
				},
			];
		}

		return columns;
	}

	/**
	 * Groups text items into lines based on Y-coordinate proximity
	 */
	private groupIntoLines(
		items: Array<{
			str: string;
			x: number;
			y: number;
			width: number;
			height: number;
		}>
	): string[][] {
		if (items.length === 0) return [];

		const lines: Array<
			Array<{
				str: string;
				x: number;
				y: number;
				width: number;
				height: number;
			}>
		> = [];
		const lineTolerance = 3; // Items within 3 units are on same line

		for (const item of items) {
			// Find existing line this item belongs to
			let foundLine = lines.find((line) =>
				line.some(
					(lineItem) => Math.abs(lineItem.y - item.y) <= lineTolerance
				)
			);

			if (foundLine) {
				foundLine.push(item);
			} else {
				lines.push([item]);
			}
		}

		// Sort lines by Y coordinate (top to bottom)
		lines.sort((a, b) => {
			const avgYA = a.reduce((sum, item) => sum + item.y, 0) / a.length;
			const avgYB = b.reduce((sum, item) => sum + item.y, 0) / b.length;
			return avgYB - avgYA; // Higher Y = top
		});

		// Sort items within each line by X coordinate (left to right)
		lines.forEach((line) => {
			line.sort((a, b) => a.x - b.x);
		});

		// Convert to string arrays
		return lines.map((line) => line.map((item) => item.str));
	}

	private async renderPdfPagesToImages(
		onProgress?: (message: string) => void
	): Promise<void> {
		try {
			const pdfjsLib = await this.loadPdfJs();
			const arrayBuffer = await this.selectedFile!.arrayBuffer();
			const typedArray = new Uint8Array(arrayBuffer);
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			const fromPage = parseInt(
				this.pageRangeFromInput.getValue() || "1"
			);
			const toPage = parseInt(
				this.pageRangeToInput.getValue() || pdf.numPages.toString()
			);
			const dpi = parseInt(this.dpiInput.getValue() || "200");
			const maxWidth = parseInt(this.maxWidthInput.getValue() || "1400");

			this.renderedPages = [];

			for (
				let pageNum = fromPage;
				pageNum <= Math.min(toPage, pdf.numPages);
				pageNum++
			) {
				onProgress?.(
					`Rendering page ${pageNum - fromPage + 1}/${
						toPage - fromPage + 1
					}...`
				);

				const page = await pdf.getPage(pageNum);
				const viewport = page.getViewport({ scale: dpi / 72 });

				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d")!;
				let scale = 1;

				if (viewport.width > maxWidth) {
					scale = maxWidth / viewport.width;
				}

				canvas.width = viewport.width * scale;
				canvas.height = viewport.height * scale;

				await page.render({
					canvasContext: context,
					viewport: page.getViewport({ scale: (dpi / 72) * scale }),
				}).promise;

				const imageData = canvas.toDataURL("image/png");

				// Extract text content for this page using PDF.js
				let textContent = "";
				if (this.includeTextToggle?.getValue()) {
					const pageTextContent = await page.getTextContent({
						includeMarkedContent: true,
					});
					textContent = this.extractParagraphsFromTextContent(
						pageTextContent.items
					);
				}

				this.renderedPages.push({
					pageNum,
					imageData,
					textContent: textContent || undefined,
				});
			}
		} catch (error) {
			throw error;
		}
	}

	private buildHybridPrompt(
		pageNum: number,
		textContent?: string,
		customGuidance?: string
	): string {
		let systemPrompt = `You are an expert document processor converting a PDF page image (with optional PDF text) into clean, well-structured Markdown. Follow these rules strictly:

1. **Headers**: Convert section titles into markdown headers ("# Header", "## Subheader", etc.).
2. **Paragraphs**: Merge consecutive lines into complete paragraphs, removing unnecessary line breaks.
3. **Footnotes**: If footnote citations and text appear on the same page, inline them in parentheses.
4. **Figures & Tables**: Use ![IMAGE_PLACEHOLDER] for figures or recreate tables in markdown. Include captions below.
5. **Mathematics**: Format all mathematical notation using LaTeX delimiters ("$" for inline, "$$" for block).
6. **Image is authoritative**: If PDF text conflicts with the image, trust the image. Mark illegible content as [[ILLEGIBLE]].
7. **Output**: ONLY the final Markdown text. No code fences or commentary.`;

		if (this.exampleNoteContent.trim()) {
			systemPrompt += `\n\nUse this structural template:\n${this.exampleNoteContent}`;

			// Add example PDF context if available
			if (this.examplePdfFile) {
				systemPrompt += this.buildExamplePdfContextText();
			}
		}

		let userPrompt = `Convert this PDF page ${pageNum} to markdown.`;

		if (customGuidance) {
			userPrompt += `\n\n**User's Custom Instructions:**\n${customGuidance}`;
		}

		if (textContent && textContent.trim()) {
			userPrompt += `\n\nPDF TEXT CONTENT (may have layout issues; use IMAGE as ground truth):\n${textContent}`;
		}

		return systemPrompt + "\n\n" + userPrompt;
	}

	private buildHybridPromptWithContext(
		pageNum: number,
		textContent: string | undefined,
		previousTranscriptions: string[],
		previousTextContents: string[],
		futureTextContents: string[],
		customGuidance?: string
	): string {
		const totalContextImages =
			previousTranscriptions.length + futureTextContents.length;
		const currentImageIndex = previousTranscriptions.length + 1;

		let systemPrompt = `You are an expert document processor converting a PDF page image (with optional PDF text) into clean, well-structured Markdown. You are processing page ${pageNum} of a multi-page document.

IMAGES PROVIDED:`;

		if (previousTranscriptions.length > 0) {
			systemPrompt += `\n- Images 1-${previousTranscriptions.length}: Previous pages (for context only)`;
		}
		systemPrompt += `\n- Image ${currentImageIndex}: Current page (MAIN FOCUS - transcribe this page)`;
		if (futureTextContents.length > 0) {
			systemPrompt += `\n- Images ${currentImageIndex + 1}-${
				currentImageIndex + futureTextContents.length
			}: Future pages (for context only)`;
		}

		systemPrompt += `

INSTRUCTIONS:
- Only transcribe content from the current page (Image ${currentImageIndex})
- Use context images and data to:
  - Continue mid-sentence/paragraph flows from previous pages
  - Avoid repeating headers/footers that appear across pages
  - See where content is heading to make better structural decisions
  - Maintain consistent formatting and structure throughout
- Do NOT transcribe content from context images (previous or future pages)

Follow these rules strictly:
1. **Headers**: Convert section titles into markdown headers ("# Header", "## Subheader", etc.). Skip repeated headers from previous pages.
2. **Paragraphs**: If a paragraph continues from the previous page, continue it seamlessly. Merge consecutive lines into complete paragraphs.
3. **Footnotes**: If footnote citations and text appear on the same page, inline them in parentheses.
4. **Figures & Tables**: Use ![IMAGE_PLACEHOLDER] for figures or recreate tables in markdown. Include captions below.
5. **Mathematics**: Format all mathematical notation using LaTeX delimiters ("$" for inline, "$$" for block).
6. **Image is authoritative**: If PDF text conflicts with the image, trust the image. Mark illegible content as [[ILLEGIBLE]].
7. **Output**: ONLY the final Markdown text. No code fences or commentary.`;

		if (this.exampleNoteContent.trim()) {
			systemPrompt += `\n\nUse this structural template (but don't follow it too literally if the content doesn't match):\n${this.exampleNoteContent}`;

			// Add example PDF context if available
			if (this.examplePdfFile) {
				systemPrompt += this.buildExamplePdfContextText();
			}
		}

		let userPrompt = `You are processing page ${pageNum} of a multi-page document.`;

		if (previousTranscriptions.length > 0) {
			userPrompt += `\n\nPREVIOUS PAGE DATA (for context only):\n`;
			previousTranscriptions.forEach((transcription, index) => {
				const pageIndex =
					pageNum - previousTranscriptions.length + index;
				userPrompt += `--- PAGE ${pageIndex} TRANSCRIPTION ---\n${transcription}\n\n`;
				if (previousTextContents[index]) {
					userPrompt += `--- PAGE ${pageIndex} PDF TEXT ---\n${previousTextContents[index]}\n\n`;
				}
			});
		}

		if (futureTextContents.length > 0) {
			userPrompt += `\n\nFUTURE PAGE DATA (for context only):\n`;
			futureTextContents.forEach((textContent, index) => {
				const pageIndex = pageNum + index + 1;
				userPrompt += `--- PAGE ${pageIndex} PDF TEXT ---\n${textContent}\n\n`;
			});
		}

		const contextDescription = [];
		if (previousTranscriptions.length > 0) {
			contextDescription.push("continuing from previous content");
		}
		if (futureTextContents.length > 0) {
			contextDescription.push("with awareness of upcoming content");
		}

		if (contextDescription.length > 0) {
			userPrompt += `\nNow transcribe the current page (page ${pageNum}) ${contextDescription.join(
				" and "
			)}.`;
		} else {
			userPrompt += `\nTranscribe this page ${pageNum} to markdown.`;
		}

		if (customGuidance) {
			userPrompt += `\n\n**User's Custom Instructions:**\n${customGuidance}`;
		}

		if (textContent && textContent.trim()) {
			userPrompt += `\n\nCURRENT PAGE PDF TEXT CONTENT (may have layout issues; use current page IMAGE as ground truth):\n${textContent}`;
		}

		return systemPrompt + "\n\n" + userPrompt;
	}

	private buildReconstructionPrompt(
		aiGeneratedMarkdown: string,
		originalPdfText: string
	): string {
		const systemPrompt = `You are an expert document reconstruction AI. Your task is to clean and merge a markdown document that was converted from a PDF page-by-page, fixing artifacts from that process.
	
	You have TWO inputs:
	1. The AI-generated markdown (converted page-by-page, may have splits and repetitions)
	2. The original PDF text extraction (continuous but may have layout issues)
	
	**Your tasks:**
	1. **Remove Repetitive Headers/Footers**: Delete page-level artifacts like repeated chapter titles or page numbers
	2. **Merge Split Paragraphs**: Identify paragraphs that were artificially split across pages and merge them
	3. **Preserve Figures/Tables**: Keep all ![IMAGE_PLACEHOLDER] markers and table structures intact
	4. **Fix Split Sentences**: Sentences ending abruptly at one point and continuing later should be joined
	5. **Maintain Structure**: Preserve all legitimate headers, lists, and formatting
	
	**How to identify split paragraphs:**
	- A paragraph ending mid-sentence (no period, question mark, or exclamation)
	- The next section starting with a lowercase letter or continuing the thought
	- Mathematical equations or code blocks split unnaturally
	- Lists that continue across boundaries
	
	**Important**: The original PDF text is for reference only - the AI-generated markdown is your primary source. Use the PDF text to understand where natural paragraph boundaries should be.`;

		const userPrompt = `Please reconstruct this document:
	
	**ORIGINAL PDF TEXT (for reference - may have layout issues):**
	\`\`\`
	${originalPdfText}
	\`\`\`
	
	**AI-GENERATED MARKDOWN (your primary source):**
	\`\`\`markdown
	${aiGeneratedMarkdown}
	\`\`\`
	
	Return ONLY the cleaned, merged markdown text.`;

		return systemPrompt + "\n\n" + userPrompt;
	}

	private buildPrompt(
		textContent: string,
		exampleContent: string,
		customGuidance?: string
	): string {
		let systemPrompt = `You are an expert document processor. Your task is to convert raw text extracted from a PDF into clean, well-structured markdown suitable for a note-taking app like Obsidian. Follow these rules strictly:

1.  **Headers**: Convert section titles (e.g., "1.1 Trading protocol") into markdown headers ("# 1.1 Trading protocol", "## 1.1.1 Order-driven markets", etc.).
2.  **Paragraphs**: Merge consecutive lines of text into complete paragraphs, removing unnecessary line breaks.
3.  **Footnotes**: Find footnote citations (e.g., a superscript number) and inject the corresponding footnote text directly into the main text in parentheses. For example, "...a reference^1" with footnote "1 This is the info" becomes "...a reference (This is the info)".
4.  **Figures & Tables**: For any figures or tables, use a placeholder like "![IMAGE_PLACEHOLDER]" or recreate the table in markdown. Any accompanying text, source, or caption should be placed immediately below the placeholder or markdown table, separated by a single newline.
5.  **Mathematics**: Format all mathematical and scientific notations using LaTeX delimiters ("$" for inline, "$$" for block).
6.  **Output**: The response should ONLY contain the final markdown text. Do not include any conversational phrases, introductions, or apologies.`;

		let userPrompt = `Please convert the following text to markdown based on the system instructions.`;

		if (customGuidance) {
			userPrompt += `\n\n**User's Custom Instructions:**\n${customGuidance}`;
		}

		if (exampleContent.trim()) {
			userPrompt += `

[EXAMPLE_NOTE_START]
The following is an example of the desired structure and formatting style. Use this as a template for organizing and formatting your output. The "..." represents abbreviated content - you should expand these sections based on the PDF content while maintaining the same structural pattern and formatting style.

${exampleContent}
[EXAMPLE_NOTE_END]`;
		}

		userPrompt += `

[START_TEXT_CONTENT]
${textContent}
[END_TEXT_CONTENT]`;

		return systemPrompt + "\n\n" + userPrompt;
	}

	private buildCleanupPrompt(messyMarkdown: string): string {
		const systemPrompt = `You are a text-cleaning AI expert. Your task is to refine a markdown document converted from a PDF. The document contains repetitive headers and footers from the original PDF layout. Your goal is to remove these artifacts while preserving the core content and structure.`;

		const userPrompt = `Please clean the following markdown text.

**Instructions:**
1.  **Identify Repetitive Text:** Scan the document for phrases, titles, or section numbers that appear repeatedly. For example, a chapter title like '# 2. Overview of Supervised Learning' or a section title like '## 2.3 Least Squares and Nearest Neighbors' might appear multiple times.
2.  **Remove Redundancy:** Delete these repetitive headers and footers. The main section heading should appear only once where it is first introduced.
3.  **Merge Content:** Ensure that paragraphs broken apart by these removed headers are seamlessly joined.
4.  **Preserve Structure:** Do not alter the legitimate markdown structure (headings, lists, LaTeX equations, etc.). Only remove the redundant page-level artifacts.
5.  **Output:** Return ONLY the cleaned, final markdown text. Do not add any commentary or explanation.

**Markdown to Clean:**
\`\`\`markdown
${messyMarkdown}
\`\`\`
`;
		return systemPrompt + "\n\n" + userPrompt;
	}

	// === NEW COMPREHENSIVE PDF PROCESSING METHODS ===

	private hashContent(content: string): string {
		// Simple hash function for content deduplication
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(16);
	}

	private extractBoundaryContent(
		transcription: string,
		type: "end" | "start",
		sentences: number = 2
	): string {
		const clean = transcription.replace(/#+\s+.*/g, "").trim();
		const paragraphs = clean
			.split(/\n\s*\n/)
			.filter((p) => p.trim().length > 20);

		if (paragraphs.length === 0) return "";

		if (type === "end") {
			const lastParagraph = paragraphs[paragraphs.length - 1];
			const sents = lastParagraph
				.split(/[.!?]+/)
				.filter((s) => s.trim().length > 10);
			return sents.slice(-sentences).join(". ").trim();
		} else {
			const firstParagraph = paragraphs[0];
			const sents = firstParagraph
				.split(/[.!?]+/)
				.filter((s) => s.trim().length > 10);
			return sents.slice(0, sentences).join(". ").trim();
		}
	}

	private extractStructuralInfo(transcription: string): {
		headers: string[];
		topics: string[];
	} {
		const headers = Array.from(transcription.matchAll(/^#+\s+(.+)$/gm)).map(
			(m) => m[1]
		);
		const topics = headers.map((h) =>
			h.replace(/^\d+\.?\s*/, "").toLowerCase()
		);
		return { headers, topics };
	}

	private buildMinimalContextPrompt(
		pageNum: number,
		textContent: string,
		previousBoundary?: string,
		previousStructure?: { headers: string[]; topics: string[] },
		futurePreview?: string,
		alreadyTranscribedHashes?: Set<string>,
		customGuidance?: string
	): string {
		const systemPrompt = `You are an expert document processor converting a PDF page image into clean, well-structured Markdown. You are processing page ${pageNum} of a multi-page document.

<XML_INSTRUCTIONS>
<CORE_TASK>
- ONLY transcribe content visible on the current page image
- Use provided context ONLY to maintain continuity and avoid repetition
- Output ONLY the final Markdown text (no code fences or commentary)
</CORE_TASK>

<CONTEXT_USAGE>
${
	previousBoundary
		? `<PREVIOUS_BOUNDARY>Last sentences from previous page: "${previousBoundary}"</PREVIOUS_BOUNDARY>`
		: ""
}
${
	previousStructure?.headers.length
		? `<PREVIOUS_HEADERS>${previousStructure.headers.join(
				", "
		  )}</PREVIOUS_HEADERS>`
		: ""
}
${
	futurePreview
		? `<FUTURE_PREVIEW>Upcoming content hint: "${futurePreview}"</FUTURE_PREVIEW>`
		: ""
}
${
	alreadyTranscribedHashes?.size
		? `<AVOID_REPETITION>Do not repeat previously processed content</AVOID_REPETITION>`
		: ""
}
</CONTEXT_USAGE>

<FORMATTING_RULES>
1. **Headers**: Convert to markdown headers. Skip if already covered in previous pages
2. **Paragraphs**: Continue mid-sentence flows seamlessly from previous boundary
3. **Figures**: Use ![IMAGE_PLACEHOLDER] with captions
4. **Math**: Use LaTeX notation ($inline$ and $$block$$)
5. **Tables**: Recreate in markdown format
6. **Citations**: Inline footnotes in parentheses when possible
</FORMATTING_RULES>

<ANTI_PATTERNS>
❌ Do NOT repeat headers/sections from previous pages
❌ Do NOT transcribe content from context images
❌ Do NOT start new paragraphs if continuing from previous page
❌ Do NOT include page numbers or footers
</ANTI_PATTERNS>
</XML_INSTRUCTIONS>`;

		let userPrompt = `<CURRENT_PAGE>
Process page ${pageNum} following the XML instructions above.`;

		if (customGuidance) {
			userPrompt += `\n\n<CUSTOM_GUIDANCE>${customGuidance}</CUSTOM_GUIDANCE>`;
		}

		if (textContent?.trim()) {
			userPrompt += `\n\n<PDF_TEXT_REFERENCE>
The following is extracted PDF text (may have layout issues - use the IMAGE as ground truth):
${textContent}
</PDF_TEXT_REFERENCE>`;
		}

		userPrompt += "\n</CURRENT_PAGE>";

		// Add example note template if available
		let finalSystemPrompt = systemPrompt;
		if (this.exampleNoteContent.trim()) {
			finalSystemPrompt += `\n\nUse this structural template (but don't follow it too literally if the content doesn't match):\n${this.exampleNoteContent}`;

			// Add example PDF context if available
			if (this.examplePdfFile) {
				finalSystemPrompt += this.buildExamplePdfContextText();
			}
		}

		return finalSystemPrompt + "\n\n" + userPrompt;
	}

	private buildImageArrayForLlm(
		currentPageImage: string,
		contextImages: string[] = [],
		futureContextImages: string[] = []
	): string[] {
		// Order: context images, current page, example PDF images, future context images
		const images = [...contextImages, currentPageImage];

		// Add example PDF images if available and in hybrid mode
		if (
			this.examplePdfPages.length > 0 &&
			this.examplePdfFile &&
			this.examplePdfModeSelect.value === "hybrid"
		) {
			// Add example PDF images after current page but before future context
			for (const examplePage of this.examplePdfPages) {
				images.push(examplePage.imageData);
			}
		}

		// Add future context images at the end
		images.push(...futureContextImages);

		return images;
	}

	private buildExamplePdfContextText(): string {
		if (!this.examplePdfFile || this.examplePdfPages.length === 0) {
			return "";
		}

		const exampleMode = this.examplePdfModeSelect.value;
		const hasImages =
			exampleMode === "hybrid" &&
			this.processingModeSelect.value === "hybrid";

		let contextText = "";

		if (hasImages) {
			contextText += `\n\nFor additional context on the expected format and style, refer to the ${this.examplePdfPages.length} example page image(s) from the corresponding PDF that produced the above template. These example pages are provided after the current page image.`;
		} else {
			contextText += `\n\nFor additional context on the expected format and style, refer to the corresponding PDF that produced the above template (text-only mode).`;
		}

		// Add text content from example PDF pages if available
		const hasTextContent = this.examplePdfPages.some(
			(page) => page.textContent && page.textContent.trim()
		);
		if (hasTextContent) {
			contextText += `\n\nEXAMPLE PDF TEXT CONTENT (for reference):`;
			for (const page of this.examplePdfPages) {
				if (page.textContent && page.textContent.trim()) {
					contextText += `\n--- EXAMPLE PAGE ${page.pageNum} ---\n${page.textContent}\n`;
				}
			}
		}

		return contextText;
	}

	private buildValidationPrompt(
		pageContent: string,
		previousContent: string,
		pageNum: number
	): string {
		return `You are a document validation AI. Check if this page content has any issues:

**Previous page content (last 200 chars):**
${previousContent.slice(-200)}

**Current page content:**
${pageContent}

**Check for these issues:**
1. Repeated headers/sections from previous page
2. Missing connection between pages (abrupt start)
3. Incomplete sentences or paragraphs
4. Content that seems out of sequence

Respond with either:
- "VALID" if no issues found
- "ISSUES: [specific problems found]"`;
	}

	private buildDeduplicationPrompt(allContent: string): string {
		return `You are a content deduplication expert. This document was processed page-by-page and has repetitive sections.

**Your tasks:**
1. Identify and remove duplicate headers, paragraphs, or sections
2. Merge content that was artificially split across pages
3. Ensure narrative flow is preserved
4. Keep all unique content and proper structure

**Content to clean:**
${allContent}

Return ONLY the cleaned markdown text.`;
	}

	private buildNuclearReviewPrompt(
		content: string,
		originalPdfText: string
	): string {
		return `You are performing a final comprehensive review of a PDF-to-markdown conversion. This is the "nuclear option" review - be extremely thorough.

**Original PDF Text Reference:**
\`\`\`
${originalPdfText}
\`\`\`

**Current Markdown:**
\`\`\`markdown
${content}
\`\`\`

**Comprehensive Review Tasks:**
1. **Completeness**: Ensure no significant content is missing compared to PDF text
2. **Structure**: Verify logical flow and proper markdown formatting
3. **Deduplication**: Remove any remaining duplicate content
4. **Continuity**: Fix paragraph breaks and sentence fragments
5. **Formatting**: Perfect headers, lists, math notation, and figures
6. **Quality**: Improve readability while preserving accuracy

Return ONLY the final, perfected markdown text.`;
	}

	private async processPagesWithNuclearOption(
		notice: Notice
	): Promise<{ response: string; usage?: OpenAI.CompletionUsage }> {
		const guidance = this.guidanceInput?.getValue() || "";
		// Always run full 2-phase when enabled (no partial phases)
		const maxPhase = 2;

		const totalUsage: OpenAI.CompletionUsage = {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		const addToTotalUsage = (usage?: OpenAI.CompletionUsage) => {
			if (usage) {
				totalUsage.prompt_tokens += usage.prompt_tokens;
				totalUsage.completion_tokens += usage.completion_tokens;
				totalUsage.total_tokens += usage.total_tokens;
			}
		};

		// Phase 1: Process each page with multimodal (page image + marked content text)
		const phase1Pages: Array<{ page: number; markdown: string }> = [];

		for (let i = 0; i < this.renderedPages.length; i++) {
			const pageData = this.renderedPages[i];
			notice.setMessage(
				`🎯 Nuclear Phase 1: Processing page ${i + 1}/${
					this.renderedPages.length
				} (multimodal)...`
			);

			const result = await this.runPhase1PerPage(
				pageData.imageData,
				pageData.textContent || "",
				guidance
			);
			addToTotalUsage(result.usage);

			phase1Pages.push({
				page: pageData.pageNum,
				markdown: result.content || "",
			});
		}

		// Early return if stopping after Phase 1
		if (maxPhase <= 1) {
			notice.setMessage(`✅ Nuclear processing complete (Phase 1 only)!`);
			return {
				response: phase1Pages.map((p) => p.markdown).join("\n\n"),
				usage: totalUsage,
			};
		}

		// Phase 2: Final reconciliation pass
		notice.setMessage(`⚡ Nuclear Phase 2: Final reconciliation...`);

		// Get full marked content text for all pages
		const fullMarkedText = await this.getFullMarkedText();

		const finalResult = await this.runPhase2Final({
			guidance,
			phase1Pages,
			fullMarkedText,
			titleHint:
				this.selectedFile?.name.replace(/\.[^.]+$/, "") || "Document",
		});
		addToTotalUsage(finalResult.usage);

		notice.setMessage(`✅ Nuclear processing complete!`);
		return { response: finalResult.content || "", usage: totalUsage };
	}

	/**
	 * Phase 1: Process a single page with multimodal (image + marked content text)
	 */
	private async runPhase1PerPage(
		pageImageDataUrl: string,
		pageMarkedText: string,
		guidance: string
	): Promise<{ content: string; usage?: OpenAI.CompletionUsage }> {
		const systemPrompt = `You convert a single PDF page into clean markdown. ${guidance}

Guidelines:
- Convert this page to clean markdown preserving structure and meaning
- Use ![IMAGE_PLACEHOLDER] for figures, tables, charts, and infographics
- Keep callouts and sidebars as block quotes or formatted sections
- Preserve headings and subheadings with appropriate markdown levels
- Do not include page numbers, headers, or footers
- Focus on the substantive content of this page only`;

		const userPrompt = `Here is this page's text content (in proper reading order):\n\n${pageMarkedText}\n\nNow produce clean markdown for this page, using the page image for visual context and structure:`;
		const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

		const maxTokens = this.getMaxTokensForMainProcessing();
		return await this.plugin.sendToLlm(
			fullPrompt,
			pageImageDataUrl,
			maxTokens ? { maxTokens } : {}
		);
	}

	/**
	 * Get concatenated marked content text for the whole PDF (no page breaks)
	 */
	private async getFullMarkedText(): Promise<string> {
		if (!this.selectedFile) {
			return "";
		}

		const pdfjsLib = await this.loadPdfJs();
		const typedArray = new Uint8Array(
			await this.selectedFile.arrayBuffer()
		);
		const pdf = await pdfjsLib.getDocument(typedArray).promise;

		const chunks: string[] = [];
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const textContent = await page.getTextContent({
				includeMarkedContent: true,
			});

			// Join items in the order PDF.js provides (marked content order)
			const pageText = textContent.items
				.filter(
					(item: any) =>
						item.str &&
						typeof item.str === "string" &&
						item.str.trim()
				)
				.map((item: any) => item.str)
				.join("")
				.trim();

			if (pageText) {
				chunks.push(pageText);
			}
		}

		// Join with double newlines (light page separation)
		return chunks.join("\n\n");
	}

	/**
	 * Phase 2: Final reconciliation pass that sees everything
	 */
	private async runPhase2Final(inputs: {
		guidance: string;
		phase1Pages: Array<{ page: number; markdown: string }>;
		fullMarkedText: string;
		titleHint: string;
	}): Promise<{ content: string; usage?: OpenAI.CompletionUsage }> {
		const { guidance, phase1Pages, fullMarkedText, titleHint } = inputs;

		const systemPrompt = `You are producing the FINAL single markdown note from a PDF document.
${guidance}

Rules:
- Output a single cohesive markdown document (no page headers or breaks)
- Reorder content logically if needed (titles → body → sidebars/callouts)  
- Keep callouts/biographies as intact blocks (use blockquotes or formatted sections)
- Use ![IMAGE_PLACEHOLDER] exactly where figures/tables/infographics belong
- Do not include headers/footers/page numbers or navigational elements
- Do not include "See also" sections or similar boilerplate
- Do not invent content - stick to what's in the source material
- Prefer exact quotes when appropriate, especially for important statements
- Ensure all substantive textual content from SOURCE_TEXT appears somewhere in the final note
- The page drafts may be incomplete or mis-ordered - use them as helpful hints but rely on SOURCE_TEXT for completeness`;

		// Prepare the user content
		const userParts: string[] = [];

		if (titleHint) {
			userParts.push(`# ${titleHint}\n`);
		}

		userParts.push(
			`## SOURCE_TEXT (marked-content, all pages, proper reading order)\n${fullMarkedText}`
		);

		userParts.push(
			`## PAGE_DRAFTS (Phase 1 outputs; may be incomplete or mis-ordered)\n${phase1Pages
				.sort((a, b) => a.page - b.page)
				.map((p) => `### Page ${p.page}\n${p.markdown}`)
				.join("\n\n")}`
		);

		const fullPrompt = `${systemPrompt}\n\n${userParts.join("\n\n")}`;

		const maxTokens = this.getMaxTokensForNuclearReview(
			fullMarkedText.length
		);
		return await this.plugin.sendToLlm(
			fullPrompt,
			undefined,
			maxTokens ? { maxTokens } : {}
		);
	}

	private async handleConvert(): Promise<void> {
		if (!this.selectedFile) {
			new Notice("Please select a PDF file first.");
			return;
		}

		const chapterName = this.chapterNameInput.getValue().trim();
		if (!chapterName) {
			new Notice("Please enter a chapter name.");
			return;
		}

		// Validate example note integration
		if (this.exampleNotePath && !this.exampleNoteContent.trim()) {
			new Notice(
				"Example note is still loading. Please wait a moment and try again."
			);
			this.plugin.logger(
				LogLevel.NORMAL,
				"Conversion blocked - example note still loading",
				{
					notePath: this.exampleNotePath,
					contentLength: this.exampleNoteContent.length,
				}
			);
			return;
		}

		// Log example note usage status
		if (this.exampleNoteContent.trim()) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Starting conversion with example note template",
				{
					notePath: this.exampleNotePath,
					contentLength: this.exampleNoteContent.length,
					preview: this.exampleNoteContent.substring(0, 100) + "...",
				}
			);
		} else {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Starting conversion without example note template"
			);
		}

		const isHybridMode = this.processingModeSelect.value === "hybrid";

		let folderPath = this.folderSelect.value;
		if (folderPath === "__new__") {
			const newFolderName = this.newFolderInput.getValue().trim();
			if (!newFolderName) {
				new Notice("Please enter a new folder name.");
				return;
			}
			folderPath = newFolderName;
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
		}

		const finalCost = await this.costUi.update();
		const useNuclearOption =
			this.useNuclearOptionToggle?.getValue() || false;

		let confirmMessage = `This will convert the PDF to a note using ${
			isHybridMode ? "hybrid (text + images)" : "text-only"
		} mode.\n${finalCost}`;

		if (useNuclearOption) {
			confirmMessage += `\n\n⚡ 2-PHASE APPROACH ENABLED ⚡\nThis uses 2-phase processing for maximum quality:\n• Phase 1: Per-page multimodal analysis\n• Phase 2: Final reconciliation with complete source text\n\nThis provides the highest quality output with minimal manual cleanup needed.`;
		}

		confirmMessage += "\n\nProceed?";

		if (!confirm(confirmMessage)) {
			return;
		}

		const notice = new Notice("🤖 Converting PDF to note...", 0);

		try {
			let response: string;
			let usage: OpenAI.CompletionUsage | undefined;

			if (isHybridMode) {
				// Process with hybrid mode FIRST
				const result = await this.processHybridMode(notice);
				response = result.response;
				usage = result.usage;
			} else {
				// Process with text-only mode
				const promptText = this.buildPrompt(
					this.extractedText,
					this.exampleNoteContent,
					this.guidanceInput?.getValue()
				);
				const result = await this.plugin.sendToLlm(promptText);
				response = result.content;
				usage = result.usage;
			}

			if (!response) {
				throw new Error("LLM returned an empty response.");
			}

			let finalResponse = response;
			let cleanupUsage: OpenAI.CompletionUsage | undefined;

			// NOW we can do cleanup/reconstruction with actual content
			if (this.cleanupToggleComponent.getValue()) {
				notice.setMessage("🤖 Reconstructing document structure...");

				let cleanupPrompt: string;
				if (isHybridMode) {
					// Use reconstruction for hybrid mode
					cleanupPrompt = this.buildReconstructionPrompt(
						response, // Now we have actual content!
						this.extractedText
					);
				} else {
					// Use original cleanup for text mode
					cleanupPrompt = this.buildCleanupPrompt(response);
				}

				const cleanupMaxTokens = this.getMaxTokensForCleanup();
				const cleanupOptions: any = {
					model: this.plugin.settings.openaiModel,
				};
				if (cleanupMaxTokens) {
					cleanupOptions.maxTokens = cleanupMaxTokens;
				}

				const cleanupResult = await this.plugin.sendToLlm(
					cleanupPrompt,
					undefined,
					cleanupOptions
				);

				if (cleanupResult.content) {
					finalResponse = cleanupResult.content;
					cleanupUsage = cleanupResult.usage;
				} else {
					this.plugin.logger(
						LogLevel.NORMAL,
						"Cleanup pass returned an empty response. Using original content."
					);
				}
			}

			// Apply post-processing to fix common LLM issues
			finalResponse = this.postProcessMarkdown(finalResponse);

			const fileName = chapterName.endsWith(".md")
				? chapterName
				: `${chapterName}.md`;
			const notePath = folderPath
				? `${folderPath}/${fileName}`
				: fileName;

			await this.app.vault.create(notePath, finalResponse);

			if (usage) {
				let totalInputTokens = usage.prompt_tokens;
				let totalOutputTokens = usage.completion_tokens;

				if (cleanupUsage) {
					totalInputTokens += cleanupUsage.prompt_tokens;
					totalOutputTokens += cleanupUsage.completion_tokens;
				}

				await logLlmCall(this.plugin, {
					action: "pdf_to_note",
					model: isHybridMode
						? this.plugin.settings.openaiMultimodalModel
						: this.plugin.settings.openaiModel,
					inputTokens: totalInputTokens,
					outputTokens: totalOutputTokens,
					textContentTokens: countTextTokens(this.extractedText),
				});
			}

			notice.setMessage(`✅ Successfully created note: ${notePath}`);
			setTimeout(() => notice.hide(), 3000);

			const newFile = this.app.vault.getAbstractFileByPath(notePath);
			if (newFile instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(newFile);
			}

			// Extract images from PDF and show placement modal if images found
			notice.setMessage("🖼️ Extracting images from PDF...");
			this.extractedImages = await this.extractImagesFromPdf();

			this.plugin.logger(
				LogLevel.NORMAL,
				`Extracted ${this.extractedImages.length} images from PDF`
			);

			if (this.extractedImages.length > 0) {
				notice.setMessage(
					"🧩 Analyzing for image stitching opportunities..."
				);

				// Detect and stitch adjacent images
				const adjacentGroups =
					this.plugin.imageStitcher.detectAdjacentImages(
						this.extractedImages
					);
				const stitchedImages: StitchedImage[] = [];

				for (const group of adjacentGroups) {
					try {
						const stitched =
							await this.plugin.imageStitcher.stitchImages(group);
						if (stitched) {
							stitchedImages.push(stitched);
							this.plugin.logger(
								LogLevel.NORMAL,
								`Stitched ${group.length} images into composite`
							);
						}
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							"Failed to stitch image group:",
							error
						);
					}
				}

				// Combine original and stitched images
				const allImages: (ExtractedImage | StitchedImage)[] = [
					...this.extractedImages,
					...stitchedImages,
				];

				notice.hide();
				this.close();

				// Show enhanced interactive editor
				setTimeout(() => {
					// Get PDF path from selected file and page range info
					const pdfPath = this.selectedFile
						? URL.createObjectURL(this.selectedFile)
						: undefined;

					const pageRangeStart = parseInt(
						this.pageRangeFromInput?.getValue() || "1"
					);
					const pageRangeEnd = parseInt(
						this.pageRangeToInput?.getValue() || "999999"
					);

					new InteractiveEditor(
						this.app,
						this.plugin,
						finalResponse,
						allImages,
						async (editedContent) => {
							// Process placeholders and save final content
							let finalContent = editedContent;

							// Replace all placeholders with actual image markdown
							const placeholderRegex =
								/\[IMAGE_PLACEHOLDER:([^\]]+)\]/g;
							const matches = Array.from(
								editedContent.matchAll(placeholderRegex)
							);

							for (const match of matches) {
								const placeholderId = match[1];
								const imageIndex = parseInt(
									placeholderId.split("_")[2]
								);

								if (imageIndex < allImages.length) {
									const image = allImages[imageIndex];
									try {
										const imagePath =
											await this.plugin.imageManager.saveImageToVault(
												image.imageData,
												image.filename
											);
										const imageMarkdown = `![[${image.filename}]]`;
										finalContent = finalContent.replace(
											match[0],
											imageMarkdown
										);
									} catch (error) {
										this.plugin.logger(
											LogLevel.NORMAL,
											"Failed to save image:",
											error
										);
										// Keep placeholder if save fails
									}
								}
							}

							// Update the note with final content
							await this.app.vault.modify(
								newFile as TFile,
								finalContent
							);
							new Notice(
								`✅ Note created with ${allImages.length} images processed!`
							);
						},
						pdfPath, // Pass the PDF path
						pageRangeStart, // Pass the starting page
						pageRangeEnd // Pass the ending page
					).open();
				}, 100);
			} else {
				this.close();
			}
		} catch (error) {
			notice.hide();
			const errorMessage =
				error instanceof Error
					? error.message
					: "Unknown error occurred";
			new Notice(`Failed to convert PDF: ${errorMessage}`);
			this.plugin.logger(LogLevel.NORMAL, "PDF conversion error:", error);
		}
	}

	private async processHybridMode(
		notice: Notice
	): Promise<{ response: string; usage?: OpenAI.CompletionUsage }> {
		if (this.isPreloadingImages && this.preloadingPromise) {
			notice.setMessage("Waiting for image preloading to finish...");
			await this.preloadingPromise;
		}

		if (this.renderedPages.length === 0) {
			await this.renderPdfPagesToImages((message) =>
				notice.setMessage(`🔄 ${message}`)
			);
		}

		if (this.renderedPages.length === 0) {
			throw new Error("No pages were rendered successfully");
		}

		// Check if nuclear option is enabled
		const useNuclearOption =
			this.useNuclearOptionToggle?.getValue() || false;
		if (useNuclearOption) {
			return await this.processPagesWithNuclearOption(notice);
		}

		let combinedResponse = "";
		let totalUsage: OpenAI.CompletionUsage = {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		// Collect all PDF text for potential reconstruction
		let fullPdfText = "";
		for (const pageData of this.renderedPages) {
			if (pageData.textContent) {
				fullPdfText += `\n--- PAGE ${pageData.pageNum} ---\n${pageData.textContent}\n`;
			}
		}

		// Process each page
		const processedResults: string[] = []; // Track previous page results
		const useContext = this.useContextToggle?.getValue() || false;
		const contextPageCount = useContext
			? parseInt(this.contextPagesInput?.getValue() || "1") || 1
			: 0;
		const useFutureContext =
			useContext && (this.useFutureContextToggle?.getValue() || false);
		const futureContextPageCount = useFutureContext
			? parseInt(this.futureContextPagesInput?.getValue() || "1") || 1
			: 0;

		for (let i = 0; i < this.renderedPages.length; i++) {
			const pageData = this.renderedPages[i];
			notice.setMessage(
				`🤖 Processing page ${i + 1}/${
					this.renderedPages.length
				} with AI...`
			);

			// Collect context from previous pages
			const contextImages: string[] = [];
			const contextTranscriptions: string[] = [];
			const contextTextContent: string[] = [];

			if (useContext && i > 0) {
				// Determine how many previous pages to include
				const startIdx = Math.max(0, i - contextPageCount);
				const endIdx = i;

				// Collect previous page images, transcriptions, and PDF text
				for (let j = startIdx; j < endIdx; j++) {
					contextImages.push(this.renderedPages[j].imageData);
					if (j < processedResults.length) {
						contextTranscriptions.push(processedResults[j]);
					}
					// Add PDF text content from previous page
					if (this.renderedPages[j].textContent) {
						contextTextContent.push(
							this.renderedPages[j].textContent!
						);
					}
				}
			}

			// Collect context from future pages
			const futureContextImages: string[] = [];
			const futureContextTextContent: string[] = [];

			if (useFutureContext && i < this.renderedPages.length - 1) {
				// Determine how many future pages to include
				const startIdx = i + 1;
				const endIdx = Math.min(
					this.renderedPages.length,
					i + 1 + futureContextPageCount
				);

				// Collect future page images and PDF text
				for (let j = startIdx; j < endIdx; j++) {
					futureContextImages.push(this.renderedPages[j].imageData);
					if (this.renderedPages[j].textContent) {
						futureContextTextContent.push(
							this.renderedPages[j].textContent!
						);
					}
				}
			}

			const promptText =
				useContext && (i > 0 || useFutureContext)
					? this.buildHybridPromptWithContext(
							pageData.pageNum,
							pageData.textContent,
							contextTranscriptions,
							contextTextContent,
							futureContextTextContent,
							this.guidanceInput?.getValue()
					  )
					: this.buildHybridPrompt(
							pageData.pageNum,
							pageData.textContent,
							this.guidanceInput?.getValue()
					  );

			// Include context images plus current page image plus example PDF images plus future context images
			const allImages = this.buildImageArrayForLlm(
				pageData.imageData,
				contextImages,
				futureContextImages
			);

			const maxTokens = this.getMaxTokensForMainProcessing();
			const result = await this.plugin.sendToLlm(
				promptText,
				allImages.length > 1 ? allImages : pageData.imageData,
				maxTokens ? { maxTokens } : {}
			);

			if (!result.content) {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Warning: Empty response for page ${pageData.pageNum}`
				);
				continue;
			}

			let pageContent = result.content;
			// Remove markdown code fences if present
			if (
				pageContent.match(/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/)
			) {
				pageContent = pageContent.replace(
					/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/,
					"$1"
				);
			}

			// Store the processed result for context in next pages
			processedResults.push(pageContent.trim());

			combinedResponse += `\n\n${pageContent.trim()}\n\n`;

			if (result.usage) {
				totalUsage.prompt_tokens += result.usage.prompt_tokens;
				totalUsage.completion_tokens += result.usage.completion_tokens;
				totalUsage.total_tokens += result.usage.total_tokens;
			}
		}

		// Clean up spacing before returning
		combinedResponse = combinedResponse
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]+/g, " ")
			.trim();

		return {
			response: combinedResponse,
			usage: totalUsage,
		};
	}

	private async populateFolderOptions(): Promise<void> {
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((file) => file.parent?.isRoot() && "children" in file)
			.map((folder) => folder.name)
			.sort();

		this.folderSelect.createEl("option", {
			value: "",
			text: "📁 Vault Root",
		});
		folders.forEach((folderName) => {
			this.folderSelect.createEl("option", {
				value: folderName,
				text: `📁 ${folderName}`,
			});
		});
		this.folderSelect.createEl("option", {
			value: "__new__",
			text: "➕ Create New Folder",
		});
	}

	private setupExampleNoteSection(): void {
		const exampleSection = this.contentEl.createDiv();
		exampleSection.createEl("h4", { text: "Example Note (Optional)" });
		exampleSection.createEl("p", {
			text: "Select an existing note to use as a structural template for the conversion.",
			cls: "setting-item-description",
		});

		// Example Note Selection
		const exampleButtonContainer = exampleSection.createDiv({
			cls: "gn-edit-row",
		});
		const exampleButton = exampleButtonContainer.createEl("button", {
			text: "Choose Example Note",
		});

		const exampleDisplay = exampleSection.createDiv({
			attr: {
				style: "margin-top: 10px; font-style: italic; color: var(--text-muted);",
			},
		});
		exampleDisplay.setText("No example note selected");

		exampleButton.onclick = () =>
			this.openExampleNoteSelector(exampleDisplay);

		// Example PDF Section (only shows if example note is selected)
		const examplePdfSection = exampleSection.createDiv({
			attr: { style: "margin-top: 20px; display: none;" },
		});
		examplePdfSection.id = "example-pdf-section";

		examplePdfSection.createEl("h5", { text: "Example PDF (Optional)" });
		examplePdfSection.createEl("p", {
			text: "Upload the PDF that corresponds to your example note for better formatting guidance.",
			cls: "setting-item-description",
		});

		const examplePdfButtonContainer = examplePdfSection.createDiv({
			cls: "gn-edit-row",
		});
		const examplePdfButton = examplePdfButtonContainer.createEl("button", {
			text: "Choose Example PDF",
		});

		const examplePdfRemoveButton = examplePdfButtonContainer.createEl(
			"button",
			{
				text: "Remove",
				attr: { style: "margin-left: 10px; display: none;" },
			}
		);

		const examplePdfDisplay = examplePdfSection.createDiv({
			attr: {
				style: "margin-top: 10px; font-style: italic; color: var(--text-muted);",
			},
		});
		examplePdfDisplay.setText("No example PDF selected");

		examplePdfButton.onclick = () =>
			this.selectExamplePdf(examplePdfDisplay, examplePdfRemoveButton);
		examplePdfRemoveButton.onclick = () =>
			this.clearExamplePdf(examplePdfDisplay, examplePdfRemoveButton);

		// Example PDF Processing Mode (only shows if main PDF is hybrid mode)
		this.examplePdfModeContainer = examplePdfSection.createDiv({
			attr: { style: "margin-top: 15px; display: none;" },
		});
		this.examplePdfModeContainer.id = "example-pdf-mode-container";

		const exampleModeLabel = this.examplePdfModeContainer.createEl(
			"label",
			{
				text: "Example PDF Processing Mode:",
				attr: {
					style: "display: block; margin-bottom: 5px; font-weight: 500;",
				},
			}
		);

		this.examplePdfModeSelect =
			this.examplePdfModeContainer.createEl("select");
		this.examplePdfModeSelect.style.cssText =
			"width: 100%; padding: 5px; border-radius: 4px; border: 1px solid var(--background-modifier-border);";

		// Options will be populated dynamically based on main PDF mode
		this.examplePdfModeSelect.innerHTML = `
			<option value="text">Text-only</option>
			<option value="hybrid">Hybrid (Text + Images)</option>
		`;

		// Add event handler for when example PDF mode changes
		this.examplePdfModeSelect.onchange = () => {
			if (this.examplePdfFile) {
				this.processExamplePdf();
			}
		};

		const exampleModeDesc = this.examplePdfModeContainer.createDiv({
			text: "How to process the example PDF content.",
			attr: {
				style: "font-size: 12px; color: var(--text-muted); margin-top: 5px;",
			},
		});

		// Example PDF Page Range (only shows if example PDF mode is visible)
		const examplePageRangeContainer =
			this.examplePdfModeContainer.createDiv({
				attr: { style: "margin-top: 15px;" },
			});

		const examplePageRangeSetting = new Setting(examplePageRangeContainer)
			.setName("Example PDF Page Range")
			.setDesc(
				"Specify page range for example PDF (leave empty for all pages)"
			)
			.addText((text) => {
				this.examplePdfPageRangeFromInput = text;
				text.setPlaceholder("From (e.g., 32)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validateExamplePdfPageRange();
					this.costUi?.update();
				});
			})
			.addText((text) => {
				this.examplePdfPageRangeToInput = text;
				text.setPlaceholder("To (e.g., 33)");
				text.inputEl.style.width = "80px";
				text.onChange(() => {
					this.validateExamplePdfPageRange();
					this.costUi?.update();
				});
			});

		// Add error display for example PDF page range validation
		this.examplePdfPageRangeErrorEl = examplePageRangeContainer.createDiv({
			attr: {
				style: "color: var(--color-red); font-size: 0.9em; margin-top: 5px; display: none;",
			},
		});
	}

	private setupContextControlSection(): void {
		const contextSection = this.contentEl.createDiv();
		contextSection.createEl("h4", {
			text: "Multi-Page Context (Optional)",
		});
		contextSection.createEl("p", {
			text: "Use previous pages for context to improve continuity and reduce hallucinations. Higher values use more tokens but may produce better results.",
			cls: "setting-item-description",
		});

		new Setting(contextSection)
			.setName("Use Previous Pages for Context")
			.setDesc(
				"Include previous page images and transcriptions to maintain flow"
			)
			.addToggle((toggle) => {
				this.useContextToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.contextPagesContainer.style.display = value
						? "block"
						: "none";
					this.costUi?.update();
				});
			});

		this.contextPagesContainer = contextSection.createDiv();
		this.contextPagesContainer.style.display = "none";

		new Setting(this.contextPagesContainer)
			.setName("Previous Pages to Include")
			.setDesc(
				"Number of previous pages to include for context (1-3 recommended, or 999 for all)"
			)
			.addText((text) => {
				this.contextPagesInput = text;
				text.setPlaceholder("1")
					.setValue("1")
					.onChange(() => this.costUi?.update());
			});

		new Setting(this.contextPagesContainer)
			.setName("Include Future Pages")
			.setDesc(
				"Also include upcoming pages for even better continuity (uses more tokens)"
			)
			.addToggle((toggle) => {
				this.useFutureContextToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.futureContextContainer.style.display = value
						? "block"
						: "none";
					this.costUi?.update();
				});
			});

		this.futureContextContainer = this.contextPagesContainer.createDiv();
		this.futureContextContainer.style.display = "none";

		new Setting(this.futureContextContainer)
			.setName("Future Pages to Include")
			.setDesc(
				"Number of upcoming pages to include for context (1-2 recommended)"
			)
			.addText((text) => {
				this.futureContextPagesInput = text;
				text.setPlaceholder("1")
					.setValue("1")
					.onChange(() => this.costUi?.update());
			});
	}

	private setupTokenLimitSection(): void {
		const tokenSection = this.contentEl.createDiv();
		tokenSection.createEl("h4", { text: "Token Limits (Optional)" });
		tokenSection.createEl("p", {
			text: "Control token limits for different AI operations. Unchecked = unlimited tokens.",
			cls: "setting-item-description",
		});

		// Main Page Processing Token Limit
		const mainTokenContainer = tokenSection.createDiv();
		new Setting(mainTokenContainer)
			.setName("Limit Main Processing Tokens")
			.setDesc("Limit tokens for individual page processing")
			.addToggle((toggle) => {
				this.limitMainTokensToggle = toggle;
				toggle.setValue(true).onChange((value) => {
					this.mainTokensInput.inputEl.style.display = value
						? "block"
						: "none";
				});
			});

		new Setting(mainTokenContainer)
			.setClass("gn-token-input")
			.addText((text) => {
				this.mainTokensInput = text;
				text
					.setPlaceholder("4000")
					.setValue("4000").inputEl.style.cssText =
					"width: 100px; margin-left: 20px;";
			});

		// Phase 2 Reconciliation Token Limit (2-phase approach)
		const phase2TokenContainer = tokenSection.createDiv();
		phase2TokenContainer.style.display = "none";
		phase2TokenContainer.addClass("gn-nuclear-token-control");

		new Setting(phase2TokenContainer)
			.setName("Limit Phase 2 Reconciliation Tokens")
			.setDesc("Limit tokens for final reconciliation pass")
			.addToggle((toggle) => {
				this.limitNuclearReviewTokensToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.nuclearReviewTokensInput.inputEl.style.display = value
						? "block"
						: "none";
				});
			})
			.addText((text) => {
				this.nuclearReviewTokensInput = text;
				text
					.setPlaceholder("12000")
					.setValue("12000").inputEl.style.cssText =
					"width: 100px; margin-left: 20px; display: none;";
			});

		// Cleanup Token Limit (only show when cleanup is enabled)
		const cleanupTokenContainer = tokenSection.createDiv();
		cleanupTokenContainer.style.display = "none";
		cleanupTokenContainer.addClass("gn-cleanup-token-control");

		new Setting(cleanupTokenContainer)
			.setName("Limit Cleanup Tokens")
			.setDesc("Limit tokens for final cleanup processing")
			.addToggle((toggle) => {
				this.limitCleanupTokensToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					this.cleanupTokensInput.inputEl.style.display = value
						? "block"
						: "none";
				});
			});

		new Setting(cleanupTokenContainer)
			.setClass("gn-token-input")
			.addText((text) => {
				this.cleanupTokensInput = text;
				text
					.setPlaceholder("8000")
					.setValue("8000").inputEl.style.cssText =
					"width: 100px; margin-left: 20px; display: none;";
			});
	}

	private updateTokenControlVisibility(): void {
		const useNuclearOption =
			this.useNuclearOptionToggle?.getValue() || false;
		const useCleanup = this.cleanupToggleComponent?.getValue() || false;

		// Show/hide nuclear option token controls
		const nuclearControls = this.contentEl.querySelectorAll(
			".gn-nuclear-token-control"
		);
		for (const control of nuclearControls) {
			(control as HTMLElement).style.display = useNuclearOption
				? "block"
				: "none";
		}

		// Show/hide cleanup token controls
		const cleanupControls = this.contentEl.querySelectorAll(
			".gn-cleanup-token-control"
		);
		for (const control of cleanupControls) {
			(control as HTMLElement).style.display = useCleanup
				? "block"
				: "none";
		}
	}

	private getMaxTokensForMainProcessing(): number | null {
		if (!this.limitMainTokensToggle?.getValue()) return null;
		const value = parseInt(this.mainTokensInput?.getValue() || "4000");
		return isNaN(value) ? 4000 : value;
	}

	private getMaxTokensForNuclearReview(contentLength: number): number | null {
		if (!this.limitNuclearReviewTokensToggle?.getValue()) return null;
		const inputValue = parseInt(
			this.nuclearReviewTokensInput?.getValue() || "12000"
		);
		const defaultValue = Math.max(12000, contentLength);
		return isNaN(inputValue) ? defaultValue : inputValue;
	}

	private getMaxTokensForCleanup(): number | null {
		if (!this.limitCleanupTokensToggle?.getValue()) return null;
		const value = parseInt(this.cleanupTokensInput?.getValue() || "8000");
		return isNaN(value) ? 8000 : value;
	}

	/**
	 * Validate page range inputs and show errors if invalid
	 */
	private validatePageRange(): boolean {
		if (this.totalPdfPages === 0) {
			// No PDF loaded yet, skip validation
			this.pageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromValue = this.pageRangeFromInput?.getValue()?.trim() || "";
		const toValue = this.pageRangeToInput?.getValue()?.trim() || "";

		// If both empty, it's valid (means all pages)
		if (!fromValue && !toValue) {
			this.pageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromPage = parseInt(fromValue) || 1;
		const toPage = parseInt(toValue) || this.totalPdfPages;

		let errorMessage = "";

		// Validate from page
		if (fromPage < 1) {
			errorMessage = "Start page must be 1 or greater";
		} else if (fromPage > this.totalPdfPages) {
			errorMessage = `Start page cannot exceed ${this.totalPdfPages}`;
		}
		// Validate to page
		else if (toPage < 1) {
			errorMessage = "End page must be 1 or greater";
		} else if (toPage > this.totalPdfPages) {
			errorMessage = `End page cannot exceed ${this.totalPdfPages}`;
		}
		// Validate range order
		else if (fromPage > toPage) {
			errorMessage = "Start page cannot be greater than end page";
		}

		if (errorMessage) {
			this.pageRangeErrorEl.textContent = errorMessage;
			this.pageRangeErrorEl.style.display = "block";
			return false;
		} else {
			this.pageRangeErrorEl.style.display = "none";
			return true;
		}
	}

	/**
	 * Validate example PDF page range inputs and show errors if invalid
	 */
	private validateExamplePdfPageRange(): boolean {
		if (this.examplePdfTotalPages === 0) {
			// No example PDF loaded yet, skip validation
			this.examplePdfPageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromValue =
			this.examplePdfPageRangeFromInput?.getValue()?.trim() || "";
		const toValue =
			this.examplePdfPageRangeToInput?.getValue()?.trim() || "";

		// If both empty, it's valid (means all pages)
		if (!fromValue && !toValue) {
			this.examplePdfPageRangeErrorEl.style.display = "none";
			return true;
		}

		const fromPage = parseInt(fromValue) || 1;
		const toPage = parseInt(toValue) || this.examplePdfTotalPages;

		let errorMessage = "";

		// Validate from page
		if (fromPage < 1) {
			errorMessage = "Start page must be 1 or greater";
		} else if (fromPage > this.examplePdfTotalPages) {
			errorMessage = `Start page cannot exceed ${this.examplePdfTotalPages}`;
		}
		// Validate to page
		else if (toPage < 1) {
			errorMessage = "End page must be 1 or greater";
		} else if (toPage > this.examplePdfTotalPages) {
			errorMessage = `End page cannot exceed ${this.examplePdfTotalPages}`;
		}
		// Validate range order
		else if (fromPage > toPage) {
			errorMessage = "Start page cannot be greater than end page";
		}

		if (errorMessage) {
			this.examplePdfPageRangeErrorEl.textContent = errorMessage;
			this.examplePdfPageRangeErrorEl.style.display = "block";
			return false;
		} else {
			this.examplePdfPageRangeErrorEl.style.display = "none";
			return true;
		}
	}

	/**
	 * Get the actual selected page range as numbers
	 */
	private getSelectedPageRange(): {
		from: number;
		to: number;
		count: number;
	} {
		const fromValue = this.pageRangeFromInput?.getValue()?.trim() || "";
		const toValue = this.pageRangeToInput?.getValue()?.trim() || "";

		const fromPage = parseInt(fromValue) || 1;
		const toPage = parseInt(toValue) || this.totalPdfPages || 1;

		const actualFrom = Math.max(1, fromPage);
		const actualTo = Math.min(this.totalPdfPages || 1, toPage);
		const count = Math.max(0, actualTo - actualFrom + 1);

		return { from: actualFrom, to: actualTo, count };
	}

	/**
	 * Update smart defaults for 2-phase approach based on selected page count
	 */
	private updateSmartDefaults(): void {
		if (!this.useNuclearOptionToggle) return;

		const { count } = this.getSelectedPageRange();
		const shouldEnable2Phase = count >= 2;

		// Only auto-change if user hasn't manually overridden
		// (We could track this with a flag if needed, for now just set the smart default)
		if (count === 1 && this.useNuclearOptionToggle.getValue()) {
			// Don't auto-disable if user explicitly enabled it
			return;
		}

		this.useNuclearOptionToggle.setValue(shouldEnable2Phase);

		// Update visibility of related controls
		this.updateTokenControlVisibility();
	}

	/**
	 * Update text preview based on current page range
	 */
	private updateTextPreview(): void {
		if (this.selectedFile && this.validatePageRange()) {
			// Refresh text extraction for the new page range
			this.extractTextFromPdf(this.selectedFile).catch((error) => {
				console.error("Failed to update text preview:", error);
			});

			// Clear preloaded images so they get refreshed for new page range
			if (this.renderedPages.length > 0) {
				this.renderedPages = [];
				// Reset preloading status
				this.isPreloadingImages = false;
				this.preloadingPromise = null;
			}
		}
	}

	private setupNuclearOptionSection(): void {
		const nuclearSection = this.contentEl.createDiv();
		nuclearSection.createEl("h4", {
			text: "⚡ 2-Phase Approach (Maximum Quality)",
		});

		const nuclearWarning = nuclearSection.createEl("div", {
			attr: {
				style: "background: var(--background-modifier-error); border: 1px solid var(--color-red); border-radius: 4px; padding: 12px; margin: 10px 0;",
			},
		});
		nuclearWarning.createEl("div", {
			text: "⚠️ HIGH COST WARNING",
			attr: {
				style: "font-weight: bold; color: var(--color-red); margin-bottom: 8px;",
			},
		});
		nuclearWarning.createEl("p", {
			text: "2-Phase approach uses per-page multimodal analysis followed by final reconciliation. This costs 2-3x more tokens than standard processing but provides maximum accuracy with minimal manual cleanup needed.",
			attr: { style: "margin: 0; font-size: 0.9em;" },
		});

		new Setting(nuclearSection)
			.setName("Enable 2-Phase Approach")
			.setDesc(
				"Per-Page Multimodal → Final Reconciliation for maximum quality"
			)
			.addToggle((toggle) => {
				this.useNuclearOptionToggle = toggle;
				toggle.setValue(false).onChange((value) => {
					if (value) {
						// Auto-enable context when 2-phase approach is enabled
						this.useContextToggle?.setValue(true);
						this.contextPagesContainer.style.display = "block";
					}
					this.updateTokenControlVisibility();
					this.costUi?.update();
				});
			});
	}

	private openExampleNoteSelector(displayElement: HTMLElement): void {
		const suggester = new ExampleNoteSuggester(this.app, (file: TFile) => {
			this.exampleNotePath = file.path;
			displayElement.setText(`📄 ${file.basename}`);
			this.loadExampleNoteContent(file);
		});
		suggester.open();
	}

	private async loadExampleNoteContent(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.cachedRead(file);
			this.exampleNoteContent = this.processExampleNote(content);

			// Debug logging
			this.plugin.logger(LogLevel.NORMAL, "Example note loaded:", {
				filename: file.name,
				originalLength: content.length,
				processedLength: this.exampleNoteContent.length,
				preview: this.exampleNoteContent.substring(0, 100) + "...",
			});

			await this.costUi?.update();

			// Show the example PDF section now that we have an example note
			const examplePdfSection = this.contentEl.querySelector(
				"#example-pdf-section"
			) as HTMLElement;
			if (examplePdfSection) {
				examplePdfSection.style.display = "block";
			}
		} catch (error) {
			console.error("Error loading example note:", error);
			this.exampleNoteContent = "";
		}
	}

	private selectExamplePdf(
		displayElement: HTMLElement,
		removeButton: HTMLElement
	): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".pdf";
		input.style.display = "none";

		input.onchange = (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (file) {
				this.examplePdfFile = file;
				displayElement.setText(`📄 ${file.name}`);
				displayElement.style.color = "var(--text-normal)";
				removeButton.style.display = "inline-block";
				this.toggleExamplePdfModeControls();
				// Process the PDF if needed
				if (this.processingModeSelect.value === "hybrid") {
					this.processExamplePdf();
				}
			}
			document.body.removeChild(input);
		};

		input.oncancel = () => {
			document.body.removeChild(input);
		};

		document.body.appendChild(input);
		input.click();
	}

	private clearExamplePdf(
		displayElement: HTMLElement,
		removeButton: HTMLElement
	): void {
		this.examplePdfFile = null;
		this.examplePdfPages = [];
		displayElement.setText("No example PDF selected");
		displayElement.style.color = "var(--text-muted)";
		removeButton.style.display = "none";
		this.toggleExamplePdfModeControls();
	}

	private async processExamplePdf(): Promise<void> {
		if (!this.examplePdfFile) return;

		const exampleMode = this.examplePdfModeSelect.value;

		// If text-only mode or main PDF is text-only, we don't need to process images
		if (
			exampleMode === "text" ||
			this.processingModeSelect.value === "text"
		) {
			// We could extract text from example PDF, but for now we just rely on the example note
			return;
		}

		// Process example PDF for hybrid mode
		try {
			const pdfjsLib = (window as any).pdfjsLib;
			if (!pdfjsLib) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"PDF.js not available for example PDF processing"
				);
				return;
			}

			const typedArray = new Uint8Array(
				await this.examplePdfFile.arrayBuffer()
			);
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			// Store total pages for validation
			this.examplePdfTotalPages = pdf.numPages;

			// Validate page range now that we know total pages
			this.validateExamplePdfPageRange();

			this.examplePdfPages = [];

			// Respect the selected page range for example PDF
			const fromPage = parseInt(
				this.examplePdfPageRangeFromInput?.getValue() || "1"
			);
			const toPage = parseInt(
				this.examplePdfPageRangeToInput?.getValue() ||
					pdf.numPages.toString()
			);
			const actualFrom = Math.max(1, fromPage);
			const actualTo = Math.min(pdf.numPages, toPage);

			// Process selected pages of the example PDF
			for (let pageNum = actualFrom; pageNum <= actualTo; pageNum++) {
				const page = await pdf.getPage(pageNum);

				// Render page to canvas
				const dpi = parseInt(this.dpiInput?.getValue() || "150");
				const scale = dpi / 72;
				const viewport = page.getViewport({ scale });

				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");
				canvas.height = viewport.height;
				canvas.width = viewport.width;

				const renderContext = {
					canvasContext: context!,
					viewport: viewport,
				};

				await page.render(renderContext).promise;

				// Convert to base64 image data
				const imageData = canvas.toDataURL("image/png");

				// Always extract text content for example PDF (might be used in text-only mode)
				let textContent = "";
				try {
					const pageTextContent = await page.getTextContent({
						includeMarkedContent: true,
					});
					textContent = this.extractParagraphsFromTextContent(
						pageTextContent.items
					);
				} catch (error) {
					this.plugin.logger(
						LogLevel.NORMAL,
						`Could not extract text from example PDF page ${pageNum}:`,
						error
					);
				}

				this.examplePdfPages.push({
					pageNum,
					imageData,
					textContent,
				});
			}

			this.plugin.logger(
				LogLevel.NORMAL,
				`Processed ${this.examplePdfPages.length} example PDF pages`
			);
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error processing example PDF:",
				error
			);
			this.examplePdfPages = [];
		}
	}

	private processExampleNote(content: string): string {
		const isFinalized = content.includes('class="gn-paragraph"');

		let processedContent: string;

		if (isFinalized) {
			const paragraphs = getParagraphsFromFinalizedNote(content);
			processedContent = paragraphs.map((p) => p.markdown).join("\n\n");
		} else {
			processedContent = content;
		}

		processedContent = processedContent.replace(
			/!\[\[([^\]]+)\]\]/g,
			"![IMAGE_PLACEHOLDER]"
		);
		processedContent = processedContent.replace(
			/!\[([^\]]*)\]\([^)]+\)/g,
			"![IMAGE_PLACEHOLDER]"
		);

		processedContent = processedContent.replace(
			/<div class="gn-split-placeholder"><\/div>/g,
			""
		);

		const paragraphs = processedContent.split(/\n\s*\n/);
		const abbreviatedParagraphs = paragraphs.map((paragraph) => {
			const trimmed = paragraph.trim();
			if (!trimmed) return "";

			// Keep headers, code blocks, and short content unchanged
			if (
				trimmed.startsWith("#") ||
				trimmed.startsWith("```") ||
				trimmed.includes("```") ||
				trimmed.split(/\s+/).length <= 10
			) {
				return trimmed;
			}

			// Handle bullet points and lists - preserve structure
			const lines = trimmed.split("\n");
			if (
				lines.some(
					(line) =>
						line.trim().startsWith("* ") ||
						line.trim().startsWith("- ") ||
						line.trim().match(/^\d+\./)
				)
			) {
				// This is a list - abbreviate each item while preserving structure
				return lines
					.map((line) => {
						const lineWords = line.trim().split(/\s+/);
						if (
							lineWords.length <= 8 ||
							(line.trim().startsWith("*") &&
								lineWords.length <= 12)
						) {
							return line; // Keep short lines or bullet points intact
						}
						const prefix =
							line.match(/^(\s*[\*\-\d]+\.?\s*)/)?.[1] || "";
						const content = line
							.replace(/^(\s*[\*\-\d]+\.?\s*)/, "")
							.trim();
						const contentWords = content.split(/\s+/);
						if (contentWords.length <= 6) {
							return line;
						}
						const firstThree = contentWords.slice(0, 3).join(" ");
						const lastTwo = contentWords.slice(-2).join(" ");
						return `${prefix}${firstThree} ... ${lastTwo}`;
					})
					.join("\n");
			}

			// Handle regular paragraphs
			const words = trimmed.split(/\s+/);
			if (words.length <= 8) {
				return trimmed;
			}

			const firstFour = words.slice(0, 4).join(" ");
			const lastThree = words.slice(-3).join(" ");
			return `${firstFour} ... ${lastThree}`;
		});

		return abbreviatedParagraphs.filter((p) => p).join("\n\n");
	}

	private postProcessMarkdown(content: string): string {
		// Step 1: Convert LaTeX syntax to MathJax
		content = this.convertLatexToMathJax(content);

		// Step 2: Clean up consecutive newlines after non-sentence endings
		content = this.cleanupConsecutiveNewlines(content);

		return content;
	}

	private convertLatexToMathJax(content: string): string {
		// Replace display math delimiters: \[ ... \] → $$ ... $$
		content = content.replace(/\\\[([\s\S]*?)\\\]/g, "$$\n$1\n$$");

		// Replace inline math delimiters: \( ... \) → $ ... $
		content = content.replace(/\\\((.*?)\\\)/g, "$$$1$$");

		return content;
	}

	private cleanupConsecutiveNewlines(content: string): string {
		// Pattern to match 2+ consecutive newlines that follow non-sentence ending characters
		// Non-sentence endings: colon, semicolon, comma (removed lowercase character)
		const pattern = /([,:;])\n{2,}/g;

		// Replace with single newline + space for better flow
		content = content.replace(pattern, "$1 ");

		// Also handle cases where there are excessive newlines (3+) anywhere
		content = content.replace(/\n{3,}/g, "\n\n");

		return content;
	}

	private async extractImagesFromPdf(): Promise<ExtractedImage[]> {
		if (!this.selectedFile) {
			return [];
		}

		try {
			const pdfjsLib = await this.loadPdfJs();
			const arrayBuffer = await this.selectedFile.arrayBuffer();
			const typedArray = new Uint8Array(arrayBuffer);
			const pdf = await pdfjsLib.getDocument(typedArray).promise;

			const extractedImages: ExtractedImage[] = [];
			const imageCount = { current: 0 };

			// Respect the selected page range
			const fromPage = parseInt(
				this.pageRangeFromInput?.getValue() || "1"
			);
			const toPage = parseInt(
				this.pageRangeToInput?.getValue() || pdf.numPages.toString()
			);
			const actualFrom = Math.max(1, fromPage);
			const actualTo = Math.min(pdf.numPages, toPage);

			for (let pageNum = actualFrom; pageNum <= actualTo; pageNum++) {
				// Check only selected pages
				const page = await pdf.getPage(pageNum);

				const pageImages = await this.extractImagesFromPage(
					page,
					pageNum,
					imageCount,
					pdfjsLib
				);
				extractedImages.push(...pageImages);
			}

			return extractedImages;
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error extracting images from PDF:",
				error
			);
			return [];
		}
	}

	private async extractImagesFromPage(
		page: any,
		pageNum: number,
		imageCount: { current: number },
		pdfjsLib: any
	): Promise<ExtractedImage[]> {
		const extractedImages: ExtractedImage[] = [];

		try {
			const operatorList = await page.getOperatorList();
			this.plugin.logger(
				LogLevel.NORMAL,
				`Page ${pageNum}: Analyzing ${operatorList.fnArray.length} operations for images`
			);

			// Look for all types of image operations like the debug modal does
			let imageOperations = 0;
			const seenDataRefs = new Set<string>();

			const imageOpsToCheck = [
				{
					name: "paintImageMaskXObject",
					op: pdfjsLib.OPS.paintImageMaskXObject,
				},
				{
					name: "paintImageXObject",
					op: pdfjsLib.OPS.paintImageXObject,
				},
				{ name: "paintJpegXObject", op: pdfjsLib.OPS.paintJpegXObject },
				{
					name: "paintInlineImageXObject",
					op: pdfjsLib.OPS.paintInlineImageXObject,
				},
			];

			for (let i = 0; i < operatorList.fnArray.length; i++) {
				const fn = operatorList.fnArray[i];
				const args = operatorList.argsArray[i];

				// Check if this is any type of image operation
				const imageOp = imageOpsToCheck.find((op) => fn === op.op);
				if (imageOp) {
					imageOperations++;
					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Found ${imageOp.name} operation ${imageOperations} at index ${i}`
					);
					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Args:`,
						args
					);

					// Handle two different argument formats:
					// Format 1: args[0] = {data, width, height} (object format)
					// Format 2: args[0] = 'img_ref', args[1] = width, args[2] = height (separate args format)
					let imageMetadata: any = null;
					let dataRef: string = "";

					if (args && args.length > 0 && args[0]) {
						if (
							typeof args[0] === "object" &&
							args[0].width &&
							args[0].height
						) {
							// Format 1: Object format
							imageMetadata = args[0];
							dataRef =
								imageMetadata.data ||
								imageMetadata.name ||
								`${imageOp.name}_${pageNum}_${i}`;
						} else if (
							typeof args[0] === "string" &&
							args.length >= 3 &&
							typeof args[1] === "number" &&
							typeof args[2] === "number"
						) {
							// Format 2: Separate arguments format
							imageMetadata = {
								data: args[0],
								name: args[0],
								width: args[1],
								height: args[2],
							};
							dataRef = args[0];
						}

						// Add transform matrix information from the operation
						// For image operations, check if there are additional transform arguments
						if (
							args.length >= 6 &&
							typeof args[args.length - 6] === "number"
						) {
							// Transform matrix is typically the last 6 arguments for image operations
							const transformStart = args.length - 6;
							imageMetadata.transform =
								args.slice(transformStart);
						} else if (
							imageOp.name.includes("Image") &&
							args.length > 3
						) {
							// For image operations, try to find transform data in different positions
							for (let j = 0; j < args.length - 5; j++) {
								const potential = args.slice(j, j + 6);
								if (
									potential.every(
										(val: any) => typeof val === "number"
									)
								) {
									imageMetadata.transform = potential;
									break;
								}
							}
						}
					}

					if (imageMetadata && dataRef) {
						// Check if we've already processed this image reference
						if (seenDataRefs.has(dataRef)) {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Page ${pageNum}: Skipping duplicate dataRef ${dataRef}`
							);
							continue;
						}
						seenDataRefs.add(dataRef);

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Processing unique ${imageOp.name} image ${imageMetadata.width}x${imageMetadata.height}px: ${dataRef}`
						);

						try {
							// Use appropriate extraction method based on operation type
							let extractedImage: ExtractedImage | null = null;

							if (imageOp.name === "paintImageMaskXObject") {
								extractedImage =
									await this.extractImageMaskFromPage(
										page,
										imageMetadata,
										pageNum,
										imageCount
									);
							} else {
								// For other image types, try the general extraction method
								extractedImage =
									await this.extractImageFromPage(
										page,
										imageMetadata,
										pageNum,
										imageCount,
										imageOp.name
									);
							}

							if (extractedImage) {
								extractedImages.push(extractedImage);
								this.plugin.logger(
									LogLevel.NORMAL,
									`Page ${pageNum}: Successfully extracted ${imageOp.name} image ${extractedImage.id} (${extractedImages.length} total so far)`
								);
							} else {
								this.plugin.logger(
									LogLevel.NORMAL,
									`Page ${pageNum}: Failed to extract ${imageOp.name} image ${dataRef} - extraction returned null`
								);
							}
						} catch (imageError) {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Failed to extract ${imageOp.name} image ${dataRef} from page ${pageNum}:`,
								imageError
							);
						}
					} else {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: ${imageOp.name} operation ${imageOperations} has invalid args:`,
							args
						);
					}
				}
			}

			this.plugin.logger(
				LogLevel.NORMAL,
				`Page ${pageNum}: Found ${imageOperations} image operations, extracted ${extractedImages.length} images`
			);

			if (imageOperations === 0) {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Page ${pageNum}: No image mask operations found`
				);
			}
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				`Error processing page ${pageNum} for images:`,
				error
			);
		}

		return extractedImages;
	}

	private async extractImageFromPage(
		page: any,
		imageMetadata: any,
		pageNum: number,
		imageCount: { current: number },
		opType: string
	): Promise<ExtractedImage | null> {
		return new Promise((resolve) => {
			// Use same timeout as mask extraction
			const timeout = setTimeout(() => {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Timeout extracting ${opType} image from page ${pageNum}`
				);
				resolve(null);
			}, 10000);

			try {
				const dataRef =
					imageMetadata.data || imageMetadata.name || imageMetadata;
				this.plugin.logger(
					LogLevel.NORMAL,
					`Page ${pageNum}: Attempting to extract ${opType} image with dataRef: ${dataRef}`
				);

				page.objs.get(dataRef, (obj: any) => {
					clearTimeout(timeout);

					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Retrieved ${opType} object for ${dataRef}:`,
						obj ? "SUCCESS" : "NULL"
					);

					if (!obj) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`No object found for ${opType} ${dataRef}`
						);
						resolve(null);
						return;
					}

					try {
						let canvas: HTMLCanvasElement;
						let ctx: CanvasRenderingContext2D;

						// Handle different object types
						if (obj.bitmap) {
							// ImageBitmap object (like paintImageMaskXObject)
							canvas = document.createElement("canvas");
							ctx = canvas.getContext("2d")!;
							canvas.width =
								obj.bitmap.width || imageMetadata.width;
							canvas.height =
								obj.bitmap.height || imageMetadata.height;
							ctx.drawImage(obj.bitmap, 0, 0);
						} else if (obj.data && obj.width && obj.height) {
							// Raw image data
							canvas = document.createElement("canvas");
							ctx = canvas.getContext("2d")!;
							canvas.width = obj.width;
							canvas.height = obj.height;

							const imageData = ctx.createImageData(
								obj.width,
								obj.height
							);
							imageData.data.set(obj.data);
							ctx.putImageData(imageData, 0, 0);
						} else {
							this.plugin.logger(
								LogLevel.NORMAL,
								`Unsupported ${opType} object structure for ${dataRef}:`,
								obj
							);
							resolve(null);
							return;
						}

						const imageData = canvas.toDataURL("image/png");

						imageCount.current++;
						// Extract coordinates from transform matrix
						let x: number | undefined = undefined;
						let y: number | undefined = undefined;

						if (
							imageMetadata.transform &&
							Array.isArray(imageMetadata.transform)
						) {
							x = imageMetadata.transform[4];
							y = imageMetadata.transform[5];
						}

						const extractedImage: ExtractedImage = {
							id: `image_${pageNum}_${imageCount.current}`,
							pageNumber: pageNum,
							imageData: imageData,
							width: canvas.width,
							height: canvas.height,
							filename: `extracted_${opType.toLowerCase()}_${pageNum}_${
								imageCount.current
							}.png`,
							x: x,
							y: y,
						};

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Successfully extracted ${opType} image ${extractedImage.id} (${canvas.width}x${canvas.height}px)`
						);
						resolve(extractedImage);
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Error rendering ${opType} object for ${dataRef}:`,
							error
						);
						resolve(null);
					}
				});
			} catch (error) {
				clearTimeout(timeout);
				this.plugin.logger(
					LogLevel.NORMAL,
					`Error accessing ${opType} image ${imageMetadata.data}:`,
					error
				);
				resolve(null);
			}
		});
	}

	private async extractImageMaskFromPage(
		page: any,
		imageMetadata: any,
		pageNum: number,
		imageCount: { current: number }
	): Promise<ExtractedImage | null> {
		return new Promise((resolve) => {
			// Increase timeout to handle multiple images better
			const timeout = setTimeout(() => {
				this.plugin.logger(
					LogLevel.NORMAL,
					`Timeout extracting image from page ${pageNum}`
				);
				resolve(null);
			}, 10000);

			try {
				const dataRef = imageMetadata.data;
				this.plugin.logger(
					LogLevel.NORMAL,
					`Page ${pageNum}: Attempting to extract image with dataRef: ${dataRef}`
				);

				page.objs.get(dataRef, (obj: any) => {
					clearTimeout(timeout);

					this.plugin.logger(
						LogLevel.NORMAL,
						`Page ${pageNum}: Retrieved object for ${dataRef}:`,
						obj ? "SUCCESS" : "NULL"
					);

					if (!obj || !obj.bitmap) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`No bitmap found for ${dataRef}. Object:`,
							obj
						);
						resolve(null);
						return;
					}

					try {
						// Use the proven ImageBitmap extraction method
						const canvas = document.createElement("canvas");
						const ctx = canvas.getContext("2d")!;
						canvas.width = obj.bitmap.width || imageMetadata.width;
						canvas.height =
							obj.bitmap.height || imageMetadata.height;

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Creating canvas ${canvas.width}x${canvas.height}px for ${dataRef}`
						);

						// Draw the ImageBitmap to canvas
						ctx.drawImage(obj.bitmap, 0, 0);
						const imageData = canvas.toDataURL("image/png");

						imageCount.current++;
						// Extract coordinates from transform matrix
						let x: number | undefined = undefined;
						let y: number | undefined = undefined;

						if (
							imageMetadata.transform &&
							Array.isArray(imageMetadata.transform)
						) {
							x = imageMetadata.transform[4];
							y = imageMetadata.transform[5];
						}

						const extractedImage: ExtractedImage = {
							id: `image_${pageNum}_${imageCount.current}`,
							pageNumber: pageNum,
							imageData: imageData,
							width: canvas.width,
							height: canvas.height,
							filename: `extracted_image_${pageNum}_${imageCount.current}.png`,
							x: x,
							y: y,
						};

						this.plugin.logger(
							LogLevel.NORMAL,
							`Page ${pageNum}: Successfully extracted image ${extractedImage.id} (${canvas.width}x${canvas.height}px)`
						);
						resolve(extractedImage);
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							`Error rendering bitmap for ${dataRef}:`,
							error
						);
						resolve(null);
					}
				});
			} catch (error) {
				clearTimeout(timeout);
				this.plugin.logger(
					LogLevel.NORMAL,
					`Error accessing image ${imageMetadata.data}:`,
					error
				);
				resolve(null);
			}
		});
	}

	private async getImageFromPage(
		page: any,
		objId: string
	): Promise<{ imageData: string; width: number; height: number } | null> {
		return new Promise((resolve) => {
			try {
				// Try to get the image object
				page.objs.get(objId, (imgObj: any) => {
					if (!imgObj) {
						resolve(null);
						return;
					}

					try {
						// Handle different types of image objects
						let imageData:
							| ImageData
							| HTMLImageElement
							| HTMLCanvasElement = imgObj;

						// If it's raw image data, we need to process it
						if (imgObj.data && imgObj.width && imgObj.height) {
							// Create a canvas to convert the image data to a data URL
							const canvas = document.createElement("canvas");
							const ctx = canvas.getContext("2d");

							if (!ctx) {
								resolve(null);
								return;
							}

							canvas.width = imgObj.width;
							canvas.height = imgObj.height;

							// Create ImageData from the raw data
							const imageData = new ImageData(
								new Uint8ClampedArray(imgObj.data),
								imgObj.width,
								imgObj.height
							);

							ctx.putImageData(imageData, 0, 0);
							const dataUrl = canvas.toDataURL("image/png");

							resolve({
								imageData: dataUrl,
								width: imgObj.width,
								height: imgObj.height,
							});
						} else if (
							imgObj instanceof HTMLImageElement ||
							imgObj instanceof HTMLCanvasElement
						) {
							// If it's already an image or canvas, convert to data URL
							const canvas = document.createElement("canvas");
							const ctx = canvas.getContext("2d");

							if (!ctx) {
								resolve(null);
								return;
							}

							canvas.width =
								imgObj.width ||
								(imgObj as HTMLImageElement).naturalWidth;
							canvas.height =
								imgObj.height ||
								(imgObj as HTMLImageElement).naturalHeight;

							ctx.drawImage(imgObj, 0, 0);
							const dataUrl = canvas.toDataURL("image/png");

							resolve({
								imageData: dataUrl,
								width: canvas.width,
								height: canvas.height,
							});
						} else {
							resolve(null);
						}
					} catch (error) {
						this.plugin.logger(
							LogLevel.NORMAL,
							"Error processing image object:",
							error
						);
						resolve(null);
					}
				});
			} catch (error) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"Error getting image from page:",
					error
				);
				resolve(null);
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
