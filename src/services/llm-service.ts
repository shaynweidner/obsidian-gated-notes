import { Notice, requestUrl } from "obsidian";
import OpenAI from "openai";
import { GatedNotesPluginInterface, LogLevel } from "../types";

/**
 * Service for managing Large Language Model operations
 */
export class LLMService {
	private openai: OpenAI | null = null;

	constructor(private plugin: GatedNotesPluginInterface) {}

	/**
	 * Initialize OpenAI client based on current settings
	 */
	private async initializeOpenAIClient(): Promise<void> {
		const { apiProvider, lmStudioUrl, openaiApiKey } = this.plugin.settings;

		if (apiProvider === "lmstudio") {
			if (!lmStudioUrl) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"LM Studio URL is not configured."
				);
				return;
			}
			this.openai = new OpenAI({
				baseURL: `${lmStudioUrl.replace(/\/$/, "")}/v1`,
				apiKey: "lm-studio",
				dangerouslyAllowBrowser: true,
			});
		} else if (apiProvider === "openai") {
			if (!openaiApiKey) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"OpenAI API key is not configured."
				);
				return;
			}
			this.openai = new OpenAI({
				apiKey: openaiApiKey,
				dangerouslyAllowBrowser: true,
			});
		}
	}

	/**
	 * Send a prompt to the configured LLM and return the response
	 */
	async sendToLlm(
		prompt: string,
		imageUrl?: string | string[],
		options: {
			maxTokens?: number;
			temperature?: number;
			model?: string;
		} = {}
	): Promise<{ content: string; usage?: OpenAI.CompletionUsage }> {
		if (!this.openai) {
			await this.initializeOpenAIClient();
			if (!this.openai) {
				new Notice(
					"AI client is not configured. Check plugin settings."
				);
				return { content: "" };
			}
		}

		const { apiProvider, lmStudioModel, openaiTemperature } =
			this.plugin.settings;

		if (apiProvider === "lmstudio" && imageUrl) {
			new Notice("Image analysis is not supported with LM Studio.");
			return { content: "" };
		}

		let model: string;
		if (options.model) {
			model = options.model;
		} else if (imageUrl) {
			model = this.plugin.settings.openaiMultimodalModel;
		} else {
			model =
				apiProvider === "openai"
					? this.plugin.settings.openaiModel
					: lmStudioModel;
		}

		try {
			const messageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
				[{ type: "text", text: prompt }];

			if (imageUrl) {
				const imageUrls = Array.isArray(imageUrl)
					? imageUrl
					: [imageUrl];
				imageUrls.forEach((url) => {
					messageContent.push({
						type: "image_url",
						image_url: {
							url: url,
							detail: "high", // Use high detail for PDF processing
						},
					});
				});
			}

			const payload: OpenAI.Chat.Completions.ChatCompletionCreateParams =
				{
					model,
					temperature: options.temperature ?? openaiTemperature,
					messages: [{ role: "user", content: messageContent }],
				};

			if (options.maxTokens) {
				payload.max_tokens = options.maxTokens;
			}

			this.plugin.logger(
				LogLevel.VERBOSE,
				"Sending payload to LLM:",
				payload
			);

			const response = await this.openai.chat.completions.create(payload);

			this.plugin.logger(
				LogLevel.VERBOSE,
				"Received payload from LLM:",
				response
			);

			const responseText = response.choices?.[0]?.message?.content ?? "";
			this.plugin.logger(
				LogLevel.VERBOSE,
				"Received response content from LLM:",
				responseText
			);

			return {
				content: responseText,
				usage: response.usage,
			};
		} catch (e: unknown) {
			this.plugin.logger(
				LogLevel.NORMAL,
				`API Error for ${apiProvider}:`,
				e
			);
			new Notice(`${apiProvider} API error – see developer console.`);
			return { content: "" };
		}
	}

	/**
	 * Fetch available models from the configured AI provider
	 */
	async fetchAvailableModels(): Promise<string[]> {
		const { apiProvider, lmStudioUrl, openaiApiKey } = this.plugin.settings;

		if (apiProvider === "lmstudio") {
			// Keep existing LMStudio logic using requestUrl
			const apiUrl = `${lmStudioUrl.replace(/\/$/, "")}/v1/models`;
			try {
				const response = await requestUrl({
					url: apiUrl,
					method: "GET",
					headers: {},
				});
				const modelIds = response.json.data.map(
					(m: { id: string }) => m.id
				) as string[];
				this.plugin.settings.availableModels = modelIds;
				await this.plugin.saveSettings();
				return modelIds;
			} catch (e: unknown) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"Failed to fetch LMStudio models",
					e
				);
				return [];
			}
		} else {
			// Use OpenAI package for OpenAI models
			if (!openaiApiKey) {
				new Notice("OpenAI API key is not set in plugin settings.");
				return [];
			}

			try {
				await this.initializeOpenAIClient();
				if (!this.openai) {
					return [];
				}

				const response = await this.openai.models.list();
				const modelIds = response.data.map(
					(model) => model.id
				) as string[];

				this.plugin.settings.availableModels = modelIds;
				await this.plugin.saveSettings();
				return modelIds;
			} catch (e: unknown) {
				this.plugin.logger(
					LogLevel.NORMAL,
					"Failed to fetch OpenAI models",
					e
				);
				return [];
			}
		}
	}

	/**
	 * Re-initialize the OpenAI client (call when settings change)
	 */
	async reinitializeClient(): Promise<void> {
		this.openai = null;
		await this.initializeOpenAIClient();
	}
}
