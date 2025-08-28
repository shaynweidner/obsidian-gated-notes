import {
	GatedNotesPluginInterface,
	ExtractedImage,
	StitchedImage,
	LogLevel,
} from "../types";

/**
 * Utility for stitching adjacent image fragments together
 */
export class ImageStitcher {
	constructor(private plugin: GatedNotesPluginInterface) {}

	detectAdjacentImages(
		images: ExtractedImage[],
		proximityThreshold: number = 50
	): ExtractedImage[][] {
		if (images.length === 0) return [];

		// Group images by page first
		const pageGroups = new Map<number, ExtractedImage[]>();
		images.forEach((img) => {
			if (!pageGroups.has(img.pageNumber)) {
				pageGroups.set(img.pageNumber, []);
			}
			pageGroups.get(img.pageNumber)!.push(img);
		});

		const adjacentGroups: ExtractedImage[][] = [];

		// For each page, find adjacent images
		pageGroups.forEach((pageImages) => {
			const visited = new Set<string>();

			pageImages.forEach((image) => {
				if (visited.has(image.id) || !image.x || !image.y) {
					return;
				}

				const group: ExtractedImage[] = [image];
				visited.add(image.id);

				// Find all adjacent images recursively
				this.findAdjacentRecursive(
					image,
					pageImages,
					group,
					visited,
					proximityThreshold
				);

				// Only consider groups with multiple images
				if (group.length > 1) {
					adjacentGroups.push(group);
				}
			});
		});

		return adjacentGroups;
	}

	private findAdjacentRecursive(
		currentImage: ExtractedImage,
		allImages: ExtractedImage[],
		group: ExtractedImage[],
		visited: Set<string>,
		threshold: number
	): void {
		allImages.forEach((candidate) => {
			if (visited.has(candidate.id)) return;
			if (!candidate.x || !candidate.y) return;

			const distance = Math.sqrt(
				Math.pow(currentImage.x! - candidate.x, 2) +
					Math.pow(currentImage.y! - candidate.y, 2)
			);

			if (distance <= threshold) {
				group.push(candidate);
				visited.add(candidate.id);
				this.findAdjacentRecursive(
					candidate,
					allImages,
					group,
					visited,
					threshold
				);
			}
		});
	}

	async stitchImages(
		imageGroup: ExtractedImage[]
	): Promise<StitchedImage | null> {
		if (imageGroup.length < 2) return null;

		try {
			// Sort images by position (top-to-bottom, left-to-right)
			const sortedImages = [...imageGroup].sort((a, b) => {
				if (Math.abs((a.y || 0) - (b.y || 0)) < 10) {
					return (a.x || 0) - (b.x || 0); // Same row, sort by x
				}
				return (a.y || 0) - (b.y || 0); // Sort by y
			});

			// Calculate canvas dimensions
			const minX = Math.min(...sortedImages.map((img) => img.x || 0));
			const minY = Math.min(...sortedImages.map((img) => img.y || 0));
			const maxX = Math.max(
				...sortedImages.map((img) => (img.x || 0) + img.width)
			);
			const maxY = Math.max(
				...sortedImages.map((img) => (img.y || 0) + img.height)
			);

			const canvasWidth = maxX - minX;
			const canvasHeight = maxY - minY;

			// Create canvas
			const canvas = document.createElement("canvas");
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
			const ctx = canvas.getContext("2d")!;

			// Fill with white background
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, canvasWidth, canvasHeight);

			// Draw each image at its relative position
			for (const image of sortedImages) {
				const img = new Image();
				await new Promise<void>((resolve, reject) => {
					img.onload = () => {
						const relativeX = (image.x || 0) - minX;
						const relativeY = (image.y || 0) - minY;
						ctx.drawImage(img, relativeX, relativeY);
						resolve();
					};
					img.onerror = reject;
					img.src = image.imageData;
				});
			}

			const stitchedImageData = canvas.toDataURL("image/png");
			const timestamp = Date.now();

			return {
				id: `stitched_${timestamp}`,
				originalImages: imageGroup,
				imageData: stitchedImageData,
				width: canvasWidth,
				height: canvasHeight,
				filename: `stitched_image_${timestamp}.png`,
			};
		} catch (error) {
			this.plugin.logger(
				LogLevel.NORMAL,
				"Error stitching images:",
				error
			);
			return null;
		}
	}
}
