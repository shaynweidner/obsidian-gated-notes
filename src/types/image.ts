export interface ImageAnalysis {
	path: string;
	analysis?: {
		type: string;
		description: Record<string, string | string[]>;
	};
}

export interface ImageAnalysisGraph {
	[hash: string]: ImageAnalysis;
}

export interface ExtractedImage {
	id: string;
	pageNumber: number;
	imageData: string; // Base64 data URL
	width: number;
	height: number;
	filename: string;
	x?: number; // PDF coordinate if available
	y?: number; // PDF coordinate if available
}

export interface StitchedImage {
	id: string;
	originalImages: ExtractedImage[];
	imageData: string;
	width: number;
	height: number;
	filename: string;
}

export interface ImagePlaceholder {
	id: string;
	lineIndex: number;
	placeholderText: string;
}

export interface SnippingResult {
	imageData: string;
	width: number;
	height: number;
	sourceType: "pdf" | "screen" | "file";
	metadata?: {
		url?: string;
		fileName?: string;
		filename?: string; // Alternative name used in some places
		screenId?: number;
		screenName?: string;
		mimeType?: string;
		pdfPath?: string;
		fileSize?: number;
		size?: number;
		pageNumber?: number;
		lastModified?: string;
		captureTime?: string;
		region?: any;
		scale?: number;
		source?: string;
	};
}
