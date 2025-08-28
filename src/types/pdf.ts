export interface EpubSection {
	id: string; // Made required since code expects it
	title: string;
	content?: string;
	href: string;
	level: number; // Made required since code expects it
	children: EpubSection[]; // Made required, defaults to empty array
	selected: boolean; // Made required, defaults to false
}

export interface EpubStructure {
	title: string;
	author?: string; // Made optional since it can be undefined
	sections: EpubSection[];
	manifest?: { [id: string]: { href: string; mediaType: string } }; // Added manifest property
}
