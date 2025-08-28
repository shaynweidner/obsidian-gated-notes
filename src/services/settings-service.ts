import {
	GatedNotesPluginInterface,
	Settings,
	DEFAULT_SETTINGS,
} from "../types";

/**
 * Service for managing plugin settings persistence and validation
 */
export class SettingsService {
	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Load plugin settings from Obsidian's data store
	 */
	async loadSettings(): Promise<void> {
		const loadedData = await this.plugin.loadData();
		this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

		// Perform any settings migration if needed
		await this.migrateSettings();
	}

	/**
	 * Save current plugin settings to Obsidian's data store
	 */
	async saveSettings(): Promise<void> {
		await this.plugin.saveData(this.plugin.settings);
	}

	/**
	 * Update a specific setting and save
	 */
	async updateSetting<K extends keyof Settings>(
		key: K,
		value: Settings[K]
	): Promise<void> {
		this.plugin.settings[key] = value;
		await this.saveSettings();
	}

	/**
	 * Update multiple settings at once
	 */
	async updateSettings(updates: Partial<Settings>): Promise<void> {
		Object.assign(this.plugin.settings, updates);
		await this.saveSettings();
	}

	/**
	 * Reset settings to defaults
	 */
	async resetToDefaults(): Promise<void> {
		this.plugin.settings = { ...DEFAULT_SETTINGS };
		await this.saveSettings();
	}

	/**
	 * Validate settings and provide warnings for invalid configurations
	 */
	validateSettings(): string[] {
		const warnings: string[] = [];
		const { settings } = this.plugin;

		// API Provider validation
		if (settings.apiProvider === "openai" && !settings.openaiApiKey) {
			warnings.push(
				"OpenAI API key is required when using OpenAI provider"
			);
		}

		if (settings.apiProvider === "lmstudio" && !settings.lmStudioUrl) {
			warnings.push(
				"LM Studio URL is required when using LM Studio provider"
			);
		}

		// Model validation
		if (settings.apiProvider === "openai" && !settings.openaiModel) {
			warnings.push("OpenAI model must be selected");
		}

		if (settings.apiProvider === "lmstudio" && !settings.lmStudioModel) {
			warnings.push("LM Studio model must be selected");
		}

		// Temperature validation
		if (settings.openaiTemperature < 0 || settings.openaiTemperature > 2) {
			warnings.push("Temperature should be between 0 and 2");
		}

		// Learning steps validation
		if (settings.learningSteps.length === 0) {
			warnings.push("At least one learning step must be configured");
		}

		// Target paras per card validation
		if (settings.targetParasPerCard < 1) {
			warnings.push("Target paragraphs per card must be at least 1");
		}

		// Auto refocus delay validation
		if (settings.autoRefocusEnabled && settings.autoRefocusDelay < 100) {
			warnings.push("Auto refocus delay should be at least 100ms");
		}

		return warnings;
	}

	/**
	 * Get a safe copy of current settings (prevents accidental mutations)
	 */
	getSettings(): Readonly<Settings> {
		return { ...this.plugin.settings };
	}

	/**
	 * Migrate settings from older versions if needed
	 */
	private async migrateSettings(): Promise<void> {
		let needsSave = false;

		// Example migration: ensure new settings have default values
		if (this.plugin.settings.maxTagCorrectionRetries === undefined) {
			this.plugin.settings.maxTagCorrectionRetries =
				DEFAULT_SETTINGS.maxTagCorrectionRetries;
			needsSave = true;
		}

		if (this.plugin.settings.analyzeImagesOnGenerate === undefined) {
			this.plugin.settings.analyzeImagesOnGenerate =
				DEFAULT_SETTINGS.analyzeImagesOnGenerate;
			needsSave = true;
		}

		// Migrate old baseUrl to new apiProvider system if needed
		if (!this.plugin.settings.apiProvider) {
			this.plugin.settings.apiProvider =
				this.plugin.settings.baseUrl?.includes("localhost")
					? "lmstudio"
					: "openai";
			needsSave = true;
		}

		if (needsSave) {
			await this.saveSettings();
		}
	}
}
