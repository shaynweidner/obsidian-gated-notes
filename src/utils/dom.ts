import { Modal } from "obsidian";

export function findTextRange(tag: string, container: HTMLElement): Range {
	const walker = document.createTreeWalker(
		container,
		NodeFilter.SHOW_TEXT,
		null
	);

	let node: Node | null;
	while ((node = walker.nextNode())) {
		const text = node.textContent || "";
		const index = text.toLowerCase().indexOf(tag.toLowerCase());

		if (index !== -1) {
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + tag.length);
			return range;
		}
	}

	// Fallback: return empty range
	const range = document.createRange();
	range.setStart(container, 0);
	range.setEnd(container, 0);
	return range;
}

export function makeModalDraggable(modal: Modal, plugin: any): void {
	const modalEl = modal.modalEl;
	const titleBar = modalEl.querySelector(".modal-title") as HTMLElement;

	if (!titleBar || !modalEl) return;

	let isDragging = false;
	let currentX = 0;
	let currentY = 0;
	let initialX = 0;
	let initialY = 0;

	const handleMouseDown = (e: MouseEvent) => {
		if (e.target !== titleBar) return;

		isDragging = true;
		initialX = e.clientX - currentX;
		initialY = e.clientY - currentY;

		titleBar.style.cursor = "grabbing";
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
	};

	const handleMouseMove = (e: MouseEvent) => {
		if (!isDragging) return;

		e.preventDefault();
		currentX = e.clientX - initialX;
		currentY = e.clientY - initialY;

		const transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
		modalEl.style.transform = transform;

		// Store transform for potential restoration
		plugin.lastModalTransform = transform;
	};

	const handleMouseUp = () => {
		if (!isDragging) return;

		isDragging = false;
		titleBar.style.cursor = "grab";
		document.removeEventListener("mousemove", handleMouseMove);
		document.removeEventListener("mouseup", handleMouseUp);
	};

	titleBar.style.cursor = "grab";
	titleBar.addEventListener("mousedown", handleMouseDown);

	// Restore previous position if available
	if (plugin.lastModalTransform) {
		modalEl.style.transform = plugin.lastModalTransform;
	}
}

/**
 * Waits for a specific element to appear in the DOM and be ready.
 * "Ready" means it has been processed by the plugin's post-processor or is not empty.
 * @param selector The CSS selector for the element.
 * @param container The parent element to search within.
 * @returns A promise that resolves to the found element, or null if it times out.
 */
export async function waitForEl<T extends HTMLElement>(
	selector: string,
	container: HTMLElement
): Promise<T | null> {
	return new Promise((resolve) => {
		const interval = setInterval(() => {
			const el = container.querySelector<T>(selector);
			if (
				el &&
				(el.dataset.gnProcessed === "true" ||
					el.innerText.trim() !== "")
			) {
				clearInterval(interval);
				resolve(el);
			}
		}, 50);
		setTimeout(() => {
			clearInterval(interval);
			resolve(null);
		}, 3000);
	});
}
