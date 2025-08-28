import { Modal, App, TFile, ButtonComponent } from "obsidian";

export class UnusedImageReviewModal extends Modal {
	constructor(
		app: App,
		private unusedImages: TFile[],
		private onConfirm: (imagesToDelete: TFile[]) => Promise<void>
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", {
			text: `Review ${this.unusedImages.length} Unused Images`,
		});
		contentEl.createEl("p", {
			text: "These images don't appear to be referenced in any notes. Select which ones to delete:",
		});

		const scrollContainer = contentEl.createDiv({
			attr: {
				style: "max-height: 60vh; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 10px;",
			},
		});

		const imagesToDelete = new Set<TFile>();

		for (const image of this.unusedImages) {
			const imageContainer = scrollContainer.createDiv({
				attr: {
					style: "display: flex; align-items: center; margin: 10px 0; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px;",
				},
			});

			// Checkbox
			const checkbox = imageContainer.createEl("input", {
				type: "checkbox",
				attr: { style: "margin-right: 10px;" },
			});

			// Image preview
			const imagePreview = imageContainer.createEl("img", {
				attr: {
					src: this.app.vault.adapter.getResourcePath(image.path),
					style: "width: 100px; height: 100px; object-fit: cover; margin-right: 10px; border-radius: 4px;",
				},
			});

			// Image info
			const infoContainer = imageContainer.createDiv({
				attr: { style: "flex: 1;" },
			});

			infoContainer.createEl("div", {
				text: image.name,
				attr: { style: "font-weight: bold;" },
			});

			infoContainer.createEl("div", {
				text: image.path,
				attr: { style: "color: var(--text-muted); font-size: 0.9em;" },
			});

			// File size
			try {
				const stat = this.app.vault.adapter.stat(image.path);
				stat.then((s) => {
					if (s) {
						const sizeKB = Math.round(s.size / 1024);
						infoContainer.createEl("div", {
							text: `${sizeKB} KB`,
							attr: {
								style: "color: var(--text-muted); font-size: 0.8em;",
							},
						});
					}
				});
			} catch (error) {
				// Ignore stat errors
			}

			// Handle checkbox changes
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					imagesToDelete.add(image);
				} else {
					imagesToDelete.delete(image);
				}
			});
		}

		// Action buttons
		const buttonContainer = contentEl.createDiv({
			attr: { style: "margin-top: 20px; text-align: right;" },
		});

		// Select All / Deselect All
		const toggleButton = new ButtonComponent(buttonContainer)
			.setButtonText("Select All")
			.onClick(() => {
				const checkboxes = scrollContainer.querySelectorAll(
					'input[type="checkbox"]'
				);
				const allChecked = Array.from(checkboxes).every(
					(cb: any) => cb.checked
				);

				checkboxes.forEach((cb: any, index) => {
					cb.checked = !allChecked;
					if (!allChecked) {
						imagesToDelete.add(this.unusedImages[index]);
					} else {
						imagesToDelete.delete(this.unusedImages[index]);
					}
				});

				toggleButton.setButtonText(
					allChecked ? "Select All" : "Deselect All"
				);
			});

		buttonContainer.createSpan({ text: " " });

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.close();
			});

		buttonContainer.createSpan({ text: " " });

		new ButtonComponent(buttonContainer)
			.setButtonText("Delete Selected")
			.setCta()
			.onClick(async () => {
				await this.onConfirm(Array.from(imagesToDelete));
				this.close();
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
