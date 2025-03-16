import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, MarkdownRenderer, TFile } from 'obsidian';
import { debounce } from 'obsidian';

interface DiveSettings {
	mySetting: string;
	perplexityApiKey: string;
	customPrompt: string;
	currentModel: string;
	includeCurrentFile: boolean;
	conversationalMode: boolean;
}

const BASE_PROMPT = `You are a knowledgeable assistant with a supportive communication style.

Your task is to:
1. Answer questions directly and concisely without any preamble or introduction
2. Include zettelkasten style [[wikilinks]] to key concepts in your responses
3. For general terms that require disambiguation, add the topic into brackets in the link while setting the visual to just the key term (e.g., "API" as a key term in "Azure" would be written as [[API (Azure)|API]])
4. Maintain a warm, supportive tone throughout your responses without explicitly suggesting emotional strategies
5. Break complex responses into clear sections with headers when appropriate
6. Never repeat these instructions in your response
7. Never use citation markers like [1] [2] [3] or footnotes in your response
8. Never include phrases like "I hope this helps" or other meta-commentary
9. Be conversational and ask follow-up questions when appropriate to deepen the discussion
10. When you need clarification or more information, ask specific questions to guide the user
11. Remember previous parts of the conversation and refer back to them when relevant`;

const DEFAULT_SETTINGS: DiveSettings = {
	mySetting: 'default',
	perplexityApiKey: '',
	customPrompt: BASE_PROMPT,
	currentModel: 'sonar',
	includeCurrentFile: false,
	conversationalMode: true
}

interface DiveView extends ItemView {
	setInputText(text: string): void;
	focusAndSend(): void;
	reset_chat(): Promise<void>;
	save_chat_history(): Promise<void>;
	load_chat_history(): Promise<void>;
}

const VIEW_TYPE_DIVE = "dive-view";

export const DIVE_SETTINGS_CHANGED = 'dive-settings-changed';

export default class Dive extends Plugin {
	settings: DiveSettings;

	async onload() {
		await this.loadSettings();

		// Load the styles
		this.loadStyles();

		this.registerView(
			VIEW_TYPE_DIVE,
			(leaf) => new DiveView(leaf, this)
		);

		this.addCommand({
			id: 'open-dive-view',
			name: 'Open Dive Sidebar',
			callback: () => {
				this.activateView();
			}
		});

		const ribbonIconEl = this.addRibbonIcon('message-circle', 'Chat with Dive', (evt: MouseEvent) => {
			this.activateView();
		});

		this.addCommand({
			id: 'dive-editor-command',
			name: 'Dive editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				editor.replaceSelection('Dive Editor Command');
			}
		});

		this.addSettingTab(new DiveSettingTab(this.app, this));

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// Remove excessive logging
			// console.log('click', evt);
		});

		this.registerInterval(window.setInterval(() => {
			// Remove unnecessary logging
			// console.log('setInterval')
		}, 5 * 60 * 1000));

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				const selection = editor.getSelection();
				if (selection) {
					menu.addItem((item) => {
						item
							.setTitle('Add selection to Dive')
							.setIcon('message-circle')
							.onClick(async () => {
								await this.activateView();
								const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIVE)[0];
								const view = leaf?.view as DiveView;
								if (view) {
									view.setInputText(selection);
								}
							});
					});

					menu.addItem((item) => {
						item
							.setTitle('Ask Dive about selection')
							.setIcon('message-circle')
							.onClick(async () => {
								await this.activateView();
								const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIVE)[0];
								const view = leaf?.view as DiveView;
								if (view) {
									const prefix = "Help me understand this text:\n\n";
									view.setInputText(prefix + selection);
									view.focusAndSend();
								}
							});
					});

					menu.addItem((item) => {
						item
							.setTitle('Ask Dive to expand this')
							.setIcon('expand')
							.onClick(async () => {
								await this.activateView();
								const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIVE)[0];
								const view = leaf?.view as DiveView;
								if (view) {
									const prefix = "Please expand and elaborate on this text:\n\n";
									view.setInputText(prefix + selection);
									view.focusAndSend();
								}
							});
					});
				}
			})
		);

		this.addCommand({
			id: 'clear-chat-history',
			name: 'Clear Chat History',
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType("dive-view");
				if (leaves.length > 0) {
					const view = leaves[0].view as DiveView;
					if (view) {
						view.reset_chat();
					}
				}
			}
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DIVE)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await leaf.setViewState({
				type: VIEW_TYPE_DIVE,
				active: true,
			});
		}

		workspace.revealLeaf(leaf);
	}

	public async check_time_related_query(query: string): Promise<{ name: string, content: string }[]> {
		const result: { name: string, content: string }[] = [];

		// Remove excessive logging
		// console.log("Checking time-related query:", query);

		// Combine patterns into fewer regex checks
		const yesterday_pattern = /what\s+(?:did|happened|occurred|took place)\s+yesterday|yesterday['']?s\s+(?:events|activities|notes|happenings)|tell\s+me\s+about\s+yesterday|what\s+(?:was|did)\s+(?:i|I)\s+(?:doing|working on|do)\s+yesterday/i;

		const today_pattern = /what\s+(?:did|happened|occurred|took place)\s+today|today['']?s\s+(?:events|activities|notes|happenings)|tell\s+me\s+about\s+today|what\s+(?:am|was)\s+(?:i|I)\s+(?:doing|working on)\s+today/i;

		const specific_date_pattern = /(?:what\s+(?:did|happened|occurred|took place)\s+on|tell\s+me\s+about|what\s+was\s+(?:i|I)\s+(?:doing|working on)\s+on)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}-\d{1,2}(?:-\d{2,4})?)/i;

		const day_of_week_pattern = /(?:what\s+(?:did|happened|occurred|took place)\s+(?:on|last|this))?\s+((?:last|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;

		let target_date: Date | null = null;

		// Use direct pattern matching instead of multiple .some() calls
		if (yesterday_pattern.test(query)) {
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			target_date = yesterday;
		}
		else if (today_pattern.test(query)) {
			target_date = new Date();
		}
		else if (specific_date_pattern.test(query)) {
			const match = query.match(specific_date_pattern);
			if (match && match[1]) {
				target_date = this.parse_date_string(match[1]);
			}
		}
		else if (day_of_week_pattern.test(query)) {
			const match = query.match(day_of_week_pattern);
			if (match && match[2]) {
				const prefix = match[1] ? match[1].trim().toLowerCase() : 'last';
				target_date = this.get_date_for_day_of_week(match[2], prefix);
			}
		}

		if (target_date) {
			const daily_note = await this.find_daily_note(target_date);
			if (daily_note) {
				result.push(daily_note);
			}
		}

		return result;
	}

	private parse_date_string(date_str: string): Date | null {
		let date: Date | null = null;

		if (/^\d{4}-\d{2}-\d{2}$/.test(date_str)) {
			date = new Date(date_str);
		}
		else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(date_str)) {
			const parts = date_str.split('/');
			const year = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
			date = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
		}
		else if (/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(date_str)) {
			const parts = date_str.split('-');
			const year = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
			date = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
		}

		return date && !isNaN(date.getTime()) ? date : null;
	}

	private get_date_for_day_of_week(day_name: string, prefix: string = 'last'): Date {
		const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
		const today = new Date();
		const today_day = today.getDay();
		const target_day = days.indexOf(day_name.toLowerCase());

		if (target_day === -1) return today;

		let diff = 0;

		if (prefix === 'this') {
			diff = target_day - today_day;
			if (diff < 0) diff += 7;
		} else {
			diff = target_day - today_day;
			if (diff >= 0) diff -= 7;
		}

		const result = new Date(today);
		result.setDate(today.getDate() + diff);
		return result;
	}

	private async find_daily_note(date: Date): Promise<{ name: string, content: string } | null> {
		// Remove excessive logging
		// console.log("Looking for daily note for date:", date.toISOString().split('T')[0]);

		const formats = [
			`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, // YYYY-MM-DD
			// Reduce the number of formats to check
			`${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${date.getFullYear()}`, // MM-DD-YYYY
			`daily/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, // daily/YYYY-MM-DD
			`journal/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` // journal/YYYY-MM-DD
		];

		// Remove excessive logging
		// console.log("Looking for daily note with formats:", formats);

		const files = this.app.vault.getMarkdownFiles();
		// Remove excessive logging
		// console.log("Total markdown files in vault:", files.length);
		// console.log("All markdown files:", files.map(f => f.basename));

		// Cache file basenames to avoid repeated property access
		const file_map = new Map();
		files.forEach(file => {
			file_map.set(file.basename.toLowerCase(), file);
		});

		for (const format of formats) {
			const format_lower = format.toLowerCase();
			const matching_file = file_map.get(format_lower);

			if (matching_file) {
				// Remove excessive logging
				// console.log(`Found file matching format '${format}':`, matching_file.basename);
				try {
					const content = await this.app.vault.read(matching_file);
					return {
						name: matching_file.basename,
						content
					};
				} catch (error) {
					console.error("Error reading daily note:", error);
				}
			}
		}

		// Add a default return statement at the end of the function
		return null;
	}

	private loadStyles() {
		// This ensures our styles are loaded
		this.registerDomEvent(document, 'DOMContentLoaded', () => {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = this.manifest.dir + '/styles.css';
			document.head.appendChild(link);

			// Register for cleanup
			this.register(() => link.remove());
		});
	}

	public clear_saved_data(): void {
		this.saveData({});
	}

	private async save_chat_history(): Promise<void> {
		try {
			// Get the view instance
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIVE);
			if (leaves.length > 0) {
				const view = leaves[0].view as DiveView;
				if (view) {
					// Call the save_chat_history method on the view
					await view.save_chat_history();
				}
			}
		} catch (error) {
			console.error("Error saving chat history:", error);
		}
	}

	public async reset_chat(): Promise<void> {
		// Get the view instance
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIVE);
		if (leaves.length > 0) {
			const view = leaves[0].view as DiveView;
			if (view) {
				await view.reset_chat();
			}
		}
	}
}

class DiveSettingTab extends PluginSettingTab {
	plugin: Dive;

	constructor(app: App, plugin: Dive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Create all settings at once to reduce DOM operations
		const settings = [
			this.createApiKeySetting(containerEl),
			this.createPromptSetting(containerEl),
			this.createModelSetting(containerEl),
			this.createIncludeFileSetting(containerEl),
			this.createConversationalModeSetting(containerEl)
		];

		// Apply styles after all DOM elements are created
		this.applyStyles(containerEl);
	}

	private createApiKeySetting(containerEl: HTMLElement): Setting {
		return new Setting(containerEl)
			.setName('Perplexity API Key')
			.setDesc('Enter your Perplexity API key')
			.addText(text => {
				text.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.perplexityApiKey);
				text.inputEl.type = 'password';
				text.inputEl.disabled = this.plugin.settings.perplexityApiKey.length > 0;

				// Use a more efficient approach for onChange
				const save_api_key = async (value: string) => {
					this.plugin.settings.perplexityApiKey = value;
					await this.plugin.saveSettings();
				};

				text.onChange(save_api_key);

				return text;
			})
			.addExtraButton(button => {
				button
					.setIcon(this.plugin.settings.perplexityApiKey ? 'pencil' : 'plus')
					.setTooltip(this.plugin.settings.perplexityApiKey ? 'Edit API key' : 'Add API key')
					.onClick(() => {
						const input = containerEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
						if (input) {
							input.disabled = false;
							input.focus();
							input.select();
						}
					});
			})
			.addExtraButton(button => {
				button
					.setIcon('eye')
					.setTooltip('Toggle visibility')
					.onClick(() => {
						const input = containerEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
						if (input) {
							input.type = input.type === 'password' ? 'text' : 'password';
						}
					});
			});
	}

	private createPromptSetting(containerEl: HTMLElement): Setting {
		return new Setting(containerEl)
			.setName('Custom System Prompt')
			.setDesc('Customize the AI system prompt')
			.addTextArea(text => text
				.setPlaceholder('Enter custom prompt')
				.setValue(this.plugin.settings.customPrompt)
				.onChange(async (value) => {
					this.plugin.settings.customPrompt = value;
					await this.plugin.saveSettings();
				}));
	}

	private createModelSetting(containerEl: HTMLElement): Setting {
		const setting = new Setting(containerEl)
			.setName('Default Model')
			.setDesc('Choose the default AI model');

		const model_desc = containerEl.createEl('div', {
			cls: 'model-description',
			text: this.get_model_description(this.plugin.settings.currentModel)
		});

		setting.addDropdown(dropdown => {
			dropdown
				.addOptions(MODELS)
				.setValue(this.plugin.settings.currentModel)
				.onChange(value => {
					// Update UI immediately
					model_desc.setText(this.get_model_description(value));

					// Then update settings asynchronously
					requestAnimationFrame(async () => {
						this.plugin.settings.currentModel = value;
						await this.plugin.saveSettings();
						this.app.workspace.trigger(DIVE_SETTINGS_CHANGED as any);
					});
				});
		});

		return setting;
	}

	private createIncludeFileSetting(containerEl: HTMLElement): Setting {
		return new Setting(containerEl)
			.setName('Include Current File by Default')
			.setDesc('Automatically include current file content in messages')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeCurrentFile)
				.onChange(async (value) => {
					this.plugin.settings.includeCurrentFile = value;
					await this.plugin.saveSettings();
				}));
	}

	private createConversationalModeSetting(containerEl: HTMLElement): Setting {
		return new Setting(containerEl)
			.setName('Conversational Mode')
			.setDesc('Enable AI to ask follow-up questions and maintain conversation flow')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.conversationalMode)
				.onChange(async (value) => {
					this.plugin.settings.conversationalMode = value;
					await this.plugin.saveSettings();
				}));
	}

	private applyStyles(containerEl: HTMLElement): void {
		// Apply all styles in one batch
		requestAnimationFrame(() => {
			const textareaEl = containerEl.querySelector('.setting-item:nth-child(2) textarea');
			if (textareaEl) {
				Object.assign((textareaEl as HTMLTextAreaElement).style, {
					width: '100%',
					height: '200px',
					minHeight: '150px',
					fontFamily: 'monospace'
				});
			}
		});
	}

	private get_model_description(model_id: string): string {
		const descriptions: Record<string, string> = {
			'sonar': 'Basic model for general-purpose chat. Good balance of performance and cost.',
			'sonar-pro': 'Advanced model with improved capabilities for complex tasks and reasoning.',
			'sonar-reasoning': 'Basic model with Chain-of-Thought reasoning. Shows its thinking process.',
			'sonar-reasoning-pro': 'Advanced model with Chain-of-Thought reasoning. Best for complex problems.',
			'sonar-deep-research': 'Specialized for in-depth research and comprehensive answers.',
			'r1-1776': 'R1-1776 - Offline chat model ($8/1M tokens)'
		};

		return descriptions[model_id] || 'No description available for this model.';
	}
}

class DiveView extends ItemView {
	private readonly MAX_INPUT_LENGTH = 4000;
	private inputField: HTMLTextAreaElement;
	private plugin: Dive;
	private currentMessageDiv: HTMLElement | null = null;
	private chatHistory: {
		role: 'user' | 'assistant',
		content: string
	}[] = [];
	private readonly MAX_CONTEXT_MESSAGES = 4;
	private modelLabel: HTMLElement;
	private includeFileToggle: HTMLElement;
	private suggestionContainer: HTMLElement;
	private fileSuggestions: HTMLElement[] = [];
	private currentSuggestionIndex = 0;
	private isShowingSuggestions = false;
	private _cached_files: TFile[] = [];
	private handle_file_suggestions = debounce(
		(query: string) => this.show_file_suggestions_impl(query),
		100, // 100ms debounce time
		true  // leading edge execution
	);
	private conversation_context: string = '';
	private awaiting_user_response: boolean = false;
	private conversation_id: string = '';
	private conversationStatusLabel: HTMLElement;
	private current_selection: {
		text: string,
		is_in_ai_message: boolean,
		range: Range
	} | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: Dive) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DIVE;
	}

	getIcon(): string {
		return "message-circle";
	}

	getDisplayText(): string {
		return "Dive";
	}

	private async sendToPerplexity(message: string): Promise<{ content: string, reasoning?: string, citations?: any[] }> {
		const apiKey = this.plugin.settings.perplexityApiKey;
		if (!apiKey) {
			new Notice('Please set your Perplexity API key in settings');
			return { content: '' };
		}

		// Initialize conversation ID if not already set
		if (!this.conversation_id) {
			this.conversation_id = this.generate_conversation_id();
		}

		this.chatHistory.push({ role: 'user', content: message });

		let contextMessages = [{
			role: 'system',
			content: this.systemPrompt + '\n\nThis is a continuous conversation. Ask follow-up questions when appropriate and maintain context from previous messages.'
		}];

		// Include all chat history for better context
		contextMessages = contextMessages.concat(this.chatHistory);

		try {
			const response = await fetch('https://api.perplexity.ai/chat/completions', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: this.plugin.settings.currentModel,
					messages: contextMessages,
					// Add conversation ID for continuity
					conversation_id: this.conversation_id
				})
			});

			if (!response.ok) {
				throw new Error(`API error: ${response.status}`);
			}

			const data = await response.json();
			const isReasoningModel = this.plugin.settings.currentModel.includes('reasoning');

			let content = data.choices[0].message.content;
			let reasoning = '';

			if (isReasoningModel && content.includes('<think>')) {
				const parts = content.split('</think>');
				if (parts.length > 1) {
					const thinkPart = parts[0].replace('<think>', '').trim();
					reasoning = thinkPart.split('\n')
						.map((line: string) => line.trim() ? `*${line.trim()}*` : '')
						.join('\n');
					content = parts[1].trim();
				}
			}

			// Check if the response contains a question
			this.awaiting_user_response = this.detect_question_in_response(content);

			this.chatHistory.push({
				role: 'assistant',
				content: content
			});

			// Save after adding assistant message
			await this.save_chat_history();

			return {
				content,
				reasoning,
				citations: data.choices[0].message.citations
			};
		} catch (error) {
			new Notice(`Error: ${error.message}`);
			return { content: '' };
		}
	}

	// Add this method to detect questions in the AI's response
	private detect_question_in_response(content: string): boolean {
		// Simple regex to detect questions
		const question_patterns = [
			/\?\s*$/m,                                // Ends with question mark
			/\bwhat\b|\bhow\b|\bwhy\b|\bwhen\b|\bwhere\b|\bwhich\b/i,  // Question words
			/\bcan you\b|\bcould you\b|\bwould you\b/i,  // Request phrases
			/let me know/i,                           // Prompting for response
			/\bthoughts\b/i                           // Asking for thoughts
		];

		return question_patterns.some(pattern => pattern.test(content));
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();

		// Load saved chat history - await the result
		await this.load_chat_history();

		const hour = new Date().getHours();
		let greeting = "Hello";
		if (hour < 12) {
			greeting = "Good morning";
		} else if (hour < 17) {
			greeting = "Good afternoon";
		} else {
			greeting = "Good evening";
		}
		container.createEl("h4", { text: greeting });

		const chatContainer = container.createEl("div", { cls: "dive-chat-container" });

		const controlsContainer = container.createEl("div", { cls: "controls-container" });

		const exportToNoteButton = controlsContainer.createEl("button", {
			cls: "dive-control-button",
			text: "Export to Note"
		});

		exportToNoteButton.addEventListener("click", async () => {
			// Format the chat history as markdown
			let markdown_content = "# Dive Chat Export\n\n";

			this.chatHistory.forEach(message => {
				const role_label = message.role === 'user' ? '**You**' : '**AI**';

				// For user messages, just add the text
				if (message.role === 'user') {
					markdown_content += `${role_label}: ${message.content}\n\n`;
				}
				// For AI messages, preserve the markdown formatting
				// but remove any citation markers or references
				else {
					let clean_content = message.content;

					// Remove citation markers like [1], [2], etc.
					clean_content = clean_content.replace(/\[\d+\]/g, '');

					markdown_content += `${role_label}:\n\n${clean_content}\n\n`;
				}
			});

			// Generate a filename with date and time
			const date_prefix = new Date().toISOString().split('T')[0];
			const time_suffix = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
			const file_name = `${date_prefix}_dive_chat_${time_suffix}.md`;

			// Create the note in Obsidian
			try {
				const file = await this.app.vault.create(file_name, markdown_content);
				new Notice(`Chat exported to note: ${file_name}`);

				// Open the newly created note
				this.app.workspace.getLeaf(false).openFile(file);
			} catch (error) {
				new Notice(`Error exporting chat: ${error.message}`);
				console.error("Error exporting chat to note:", error);
			}
		});

		const newConversationButton = controlsContainer.createEl("button", {
			cls: "dive-control-button",
			text: "New Conversation"
		});

		newConversationButton.addEventListener("click", () => {
			// Reset conversation state
			this.conversation_id = this.generate_conversation_id();
			this.awaiting_user_response = false;
			this.conversationStatusLabel.setText("New conversation");
			this.conversationStatusLabel.removeClass("awaiting-response");

			// Add a visual separator in the chat
			const separatorEl = chatContainer.createEl("div", {
				cls: "conversation-separator"
			});
			separatorEl.createEl("span", {
				text: "New conversation started"
			});

			// Don't clear chat history completely, just add a separator
			this.chatHistory = [];

			// Save the empty chat history
			this.save_chat_history();

			new Notice("Started a new conversation");
		});

		const clearHistoryButton = controlsContainer.createEl("button", {
			cls: "dive-control-button",
			text: "Clear History"
		});

		clearHistoryButton.addEventListener("click", () => {
			// Show a confirmation dialog
			const confirmClear = () => {
				this.reset_chat();
				new Notice("Chat history cleared");
			};

			// Create a simple confirmation modal
			const modal = new Modal(this.app);
			modal.titleEl.setText("Clear Chat History");
			modal.contentEl.createEl("p", {
				text: "Are you sure you want to clear all chat history? This cannot be undone."
			});

			const buttonContainer = modal.contentEl.createEl("div", {
				cls: "dive-modal-buttons"
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel"
			});
			cancelButton.addEventListener("click", () => {
				modal.close();
			});

			const confirmButton = buttonContainer.createEl("button", {
				cls: "mod-warning",
				text: "Clear History"
			});
			confirmButton.addEventListener("click", () => {
				confirmClear();
				modal.close();
			});

			modal.open();
		});

		const inputContainer = container.createEl("div", { cls: "dive-input-container" });

		this.suggestionContainer = inputContainer.createEl("div", {
			cls: "file-suggestions-container"
		});
		this.suggestionContainer.style.display = "none";

		const inputRow = inputContainer.createEl("div", { cls: "input-row" });

		this.inputField = inputRow.createEl("textarea", {
			cls: "dive-input-field",
			attr: {
				placeholder: "Type your message...(Use @ to reference files)",
				maxLength: this.MAX_INPUT_LENGTH.toString()
			}
		});

		const infoContainer = inputContainer.createEl("div", {
			cls: "info-container"
		});

		const charCount = infoContainer.createEl('div', {
			cls: 'char-count',
			text: '0/' + this.MAX_INPUT_LENGTH
		});

		this.modelLabel = infoContainer.createEl("div", {
			cls: "model-label",
			text: `Using ${MODELS[this.plugin.settings.currentModel as keyof typeof MODELS]}`
		});

		this.conversationStatusLabel = infoContainer.createEl("div", {
			cls: "conversation-status",
			text: "New conversation"
		});

		this.registerEvent(
			this.app.workspace.on(DIVE_SETTINGS_CHANGED as any, () => {
				this.modelLabel.setText(
					`Using ${MODELS[this.plugin.settings.currentModel as keyof typeof MODELS]}`
				);
			})
		);

		this.inputField.addEventListener('input', () => {
			const count = this.inputField.value.length;
			charCount.setText(`${count}/${this.MAX_INPUT_LENGTH}`);
			charCount.toggleClass('near-limit', count > this.MAX_INPUT_LENGTH * 0.9);

			this.handleFileSuggestions();
		});

		this.inputField.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				if (this.isShowingSuggestions) {
					e.preventDefault();
					this.selectCurrentSuggestion();
				} else {
					e.preventDefault();
					sendButton.click();
				}
			}

			if (this.isShowingSuggestions) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					this.navigateSuggestion(1);
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					this.navigateSuggestion(-1);
				} else if (e.key === "Escape") {
					e.preventDefault();
					this.hideSuggestions();
				} else if (e.key === "Tab") {
					e.preventDefault();
					this.selectCurrentSuggestion();
				}
			}
		});

		const buttonContainer = inputRow.createEl("div", {
			cls: "button-container"
		});

		const sendButton = buttonContainer.createEl("button", {
			cls: "dive-send-button",
			text: "Send"
		});

		this.includeFileToggle = buttonContainer.createEl("button", {
			cls: `toggle-button ${this.plugin.settings.includeCurrentFile ? 'active' : ''}`,
			text: "📄 Include file"
		});

		this.includeFileToggle.addEventListener("click", () => {
			this.includeFileToggle.toggleClass('active', !this.plugin.settings.includeCurrentFile);

			requestAnimationFrame(async () => {
				this.plugin.settings.includeCurrentFile = !this.plugin.settings.includeCurrentFile;
				await this.plugin.saveSettings();
			});
		});

		this.addStyles();

		sendButton.addEventListener("click", async () => {
			const rawMessage = this.inputField.value;
			if (rawMessage.trim()) {
				// Update conversation status
				if (this.awaiting_user_response) {
					this.awaiting_user_response = false;
					this.conversationStatusLabel.setText("Continuing conversation");
				} else if (!this.conversation_id) {
					this.conversation_id = this.generate_conversation_id();
					this.conversationStatusLabel.setText("New conversation");
				} else {
					this.conversationStatusLabel.setText("Continuing conversation");
				}

				const messageData = await this.prepareMessage(rawMessage);
				this.addMessage(chatContainer, messageData.displayText, 'user');
				this.inputField.value = "";
				charCount.setText(`0/${this.MAX_INPUT_LENGTH}`);
				this.scrollToBottom(chatContainer);

				const loadingEl = chatContainer.createEl("div", {
					cls: "dive-message ai-message loading"
				});

				const loadingContent = loadingEl.createEl("div", {
					cls: "message-content"
				});

				loadingContent.createEl("div", { cls: "typing-dot" });
				loadingContent.createEl("div", { cls: "typing-dot" });
				loadingContent.createEl("div", { cls: "typing-dot" });

				this.scrollToBottom(chatContainer);

				const response = await this.sendToPerplexity(messageData.apiText);
				loadingEl.remove();

				if (response.reasoning) {
					const reasoningDiv = this.addMessage(chatContainer, '', 'ai');
					const reasoningContent = reasoningDiv.querySelector('.message-content')!;
					await this.streamResponse(response.reasoning, reasoningContent as HTMLElement);
				}

				if (response.content) {
					const messageDiv = this.addMessage(chatContainer, '', 'ai', response.citations);
					const contentDiv = messageDiv.querySelector('.message-content')!;
					await this.streamResponse(response.content, contentDiv as HTMLElement);

					// Update conversation status if AI is asking a question
					if (this.awaiting_user_response) {
						this.conversationStatusLabel.setText("Waiting for your response");
						this.conversationStatusLabel.addClass("awaiting-response");

						// Focus the input field to encourage response
						this.inputField.focus();
					} else {
						this.conversationStatusLabel.setText("Conversation active");
						this.conversationStatusLabel.removeClass("awaiting-response");
					}
				}
			}
		});

		// Add context menu for selections
		this.addContextMenuForSelection();

		// After creating the chat container, render the saved messages
		if (this.chatHistory.length > 0) {
			this.render_saved_chat_history(chatContainer);

			// Update conversation status based on loaded state
			if (this.awaiting_user_response) {
				this.conversationStatusLabel.setText("Waiting for your response");
				this.conversationStatusLabel.addClass("awaiting-response");
			} else if (this.conversation_id) {
				this.conversationStatusLabel.setText("Conversation active");
			}
		}
	}

	private scrollToBottom(container: HTMLElement) {
		container.scrollTop = container.scrollHeight;
	}

	private async streamResponse(text: string, contentDiv: HTMLElement) {
		try {
			const clean_text = text.trim();

			// Store the original markdown for copying
			contentDiv.setAttribute('data-markdown', clean_text);
			contentDiv.empty();

			// Add fade-in class but don't make visible yet
			contentDiv.addClass('fade-in-content');

			// Add typing indicator
			const typingIndicator = contentDiv.createEl("div", {
				cls: "typing-indicator"
			});

			for (let i = 0; i < 3; i++) {
				typingIndicator.createEl("span", { cls: "typing-dot" });
			}

			// Simulate typing delay based on text length
			const delay = Math.min(1000, Math.max(300, clean_text.length * 5));
			await new Promise(resolve => setTimeout(resolve, delay));

			// Remove typing indicator and render content
			typingIndicator.remove();

			await new Promise<void>(resolve => {
				requestAnimationFrame(async () => {
					// Clean the text before rendering by removing citation markers
					let display_text = clean_text;

					// Remove citation markers like [1], [2], etc.
					display_text = display_text.replace(/\[\d+\]/g, '');

					// Remove citation sections at the end of the message
					// Using a workaround for the dotAll flag
					display_text = display_text.replace(/(\n+)(Sources|References|Citations):[^]*$/i, '');

					await MarkdownRenderer.renderMarkdown(display_text, contentDiv, '.', this.plugin);

					// Animate in the content after rendering
					setTimeout(() => {
						contentDiv.addClass('visible');
					}, 10);

					// Scroll after rendering
					const container = contentDiv.closest('.dive-chat-container') as HTMLElement;
					if (container) {
						this.scrollToBottom(container);
					}

					resolve();
				});
			});
		} catch (error) {
			contentDiv.empty();
			contentDiv.createEl('div', { text: 'Error rendering response. Original text preserved in copy.' });
			contentDiv.setAttribute('data-markdown', text);
		}
	}

	private addMessage(container: HTMLElement, message: string | { text: string, fileName?: string, fileNames?: string[] }, type: 'user' | 'ai', citations?: any[]): HTMLElement {
		const messageDiv = container.createEl("div", {
			cls: `dive-message ${type}-message`
		});

		const contentDiv = messageDiv.createEl("div", {
			cls: "message-content"
		});

		let text = typeof message === 'string' ? message : message.text;

		if (type === 'ai') {
			const buttonWrapper = messageDiv.createEl("div", {
				cls: "button-wrapper"
			});

			const copyButton = buttonWrapper.createEl("button", {
				cls: "message-button",
				attr: { 'aria-label': 'Copy message' }
			});
			copyButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

			// Add a copy markdown button
			const copyMarkdownButton = buttonWrapper.createEl("button", {
				cls: "message-button",
				attr: { 'aria-label': 'Copy as markdown' }
			});
			copyMarkdownButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`;

			const createNoteButton = buttonWrapper.createEl("button", {
				cls: "message-button",
				attr: { 'aria-label': 'Create note' }
			});
			createNoteButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;

			copyButton.addEventListener("click", async () => {
				copyButton.addClass('loading');
				try {
					// Copy as plain text (rendered content)
					const content = contentDiv.innerText;
					await navigator.clipboard.writeText(content);
					this.show_copy_feedback("Copied as plain text");
				} finally {
					copyButton.removeClass('loading');
				}
			});

			copyMarkdownButton.addEventListener("click", async () => {
				copyMarkdownButton.addClass('loading');
				try {
					// Copy the original markdown
					const markdown_content = contentDiv.getAttribute('data-markdown') || text;
					await navigator.clipboard.writeText(markdown_content);
					this.show_copy_feedback("Copied as markdown");
				} finally {
					copyMarkdownButton.removeClass('loading');
				}
			});

			createNoteButton.addEventListener("click", async () => {
				const content = text || contentDiv.getAttribute('data-markdown') || contentDiv.innerText;

				let title = '';

				const heading_match = content.match(/^#+\s+(.+)$/m);
				if (heading_match && heading_match[1]) {
					title = heading_match[1].trim();
				}
				else {
					const sentence_match = content.match(/^(.+?[.!?])\s/);
					if (sentence_match && sentence_match[1]) {
						title = sentence_match[1].trim();
					} else {
						title = content.split('\n')[0].trim();
					}
				}

				title = title.substring(0, 40).trim();

				if (!title || title.replace(/[^\w\s]/g, '').trim() === '') {
					title = 'ai_note';
				}

				const clean_title = title
					.replace(/[<>:"\/\\|?*]/g, '')
					.replace(/\//g, '-')
					.replace(/\\/g, '-')
					.replace(/\s+/g, ' ')
					.trim();

				const final_title = heading_match ? clean_title : clean_title.replace(/\s+/g, '_').toLowerCase();

				const date_prefix = new Date().toISOString().split('T')[0];
				const file_name = `${date_prefix}_${final_title}.md`;

				const file = await this.app.vault.create(file_name, content);
				new Notice(`Note created: ${file_name}`);
				this.app.workspace.getLeaf(false).openFile(file);
			});
		}

		if (type === 'ai') {
			MarkdownRenderer.renderMarkdown(text, contentDiv, '.', this.plugin);
		} else {
			const formattedText = text.split('\n')
				.filter(line => line.trim())
				.join('\n');

			contentDiv.createEl("p", {
				text: formattedText,
				cls: "message-paragraph"
			});

			if (typeof message !== 'string') {
				if (message.fileName) {
					this.addFileIndicator(messageDiv, message.fileName);
				}

				if (message.fileNames && message.fileNames.length > 0) {
					message.fileNames.forEach(fileName => {
						this.addFileIndicator(messageDiv, fileName);
					});
				}
			}
		}

		if (citations && citations.length > 0) {
			const citationsDiv = messageDiv.createEl("div", {
				cls: "citations-container"
			});

			citationsDiv.createEl("p", {
				text: "Sources:",
				cls: "citations-header"
			});

			citations.forEach(citation => {
				const citationEl = citationsDiv.createEl("div", {
					cls: "citation-item"
				});
				if (citation.url) {
					const link = citationEl.createEl("a", {
						text: citation.title || citation.url,
						cls: "citation-link"
					});
					link.href = citation.url;
				} else {
					citationEl.setText(citation.text || "Unknown source");
				}
			});
		}

		return messageDiv;
	}

	private addFileIndicator(messageDiv: HTMLElement, fileName: string) {
		const fileIndicator = messageDiv.createEl("div", {
			cls: "file-indicator"
		});

		const fileIcon = fileIndicator.createEl("span", {
			cls: "file-icon",
			text: "📄"
		});

		fileIndicator.createEl("span", {
			cls: "file-name",
			text: fileName
		});
	}

	private addStyles() {
		const containerEl = this.containerEl.children[1] as HTMLElement;
		containerEl.style.display = "flex";
		containerEl.style.flexDirection = "column";
		containerEl.style.height = "100%";

		// Instead of adding inline styles, we'll just add a class to the container
		containerEl.addClass("dive-container");
	}

	async onClose() {
		await this.save_chat_history();
	}

	public setInputText(text: string) {
		if (this.inputField) {
			let formattedText;
			if (text.includes('\n\n')) {
				const [prefix, content] = text.split('\n\n');
				const quotedContent = content
					.split('\n')
					.map(line => `> ${line}`)
					.join('\n');
				formattedText = prefix + '\n\n' + quotedContent + '\n';
			} else {
				formattedText = text
					.split('\n')
					.map(line => `> ${line}`)
					.join('\n') + '\n';
			}

			const currentText = this.inputField.value;
			const newText = currentText ? currentText + '\n' + formattedText : formattedText;

			this.inputField.value = newText;
			this.inputField.focus();
			this.inputField.setSelectionRange(newText.length, newText.length);
		}
	}

	private get systemPrompt(): string {
		let prompt = BASE_PROMPT;

		if (this.plugin.settings.conversationalMode) {
			prompt += `\n\nThis is a conversational interface. You should:
1. Ask follow-up questions when appropriate
2. Remember previous parts of the conversation
3. Refer back to earlier topics when relevant
4. Maintain a natural dialogue flow
5. Be friendly and engaging, your name is Dive`;
		} else {
			prompt += `\n\nThis is a question-answering interface. You should:
1. Focus on providing complete answers
2. Avoid asking follow-up questions
3. Be thorough and comprehensive`;
		}

		return `${prompt}\n\nAdditional Instructions:\n${this.plugin.settings.customPrompt}`;
	}

	public focusAndSend() {
		if (this.inputField) {
			this.inputField.focus();
			const sendButton = this.containerEl.querySelector('.dive-send-button');
			if (sendButton instanceof HTMLElement) {
				sendButton.click();
			}
		}
	}

	private async getCurrentFileContent(): Promise<string | null> {
		const currentFile = this.app.workspace.getActiveFile();
		if (!currentFile) return null;

		try {
			return await this.app.vault.read(currentFile);
		} catch (error) {
			new Notice("Could not read current file");
			return null;
		}
	}

	private async prepareMessage(userInput: string): Promise<{ displayText: string | { text: string, fileNames: string[] }, apiText: string }> {
		let displayText: string | { text: string, fileNames: string[] } = userInput;
		let apiText = userInput;

		const fileReferences = this.extractFileReferences(userInput);
		const includedFiles: { name: string, content: string }[] = [];

		console.log("File references found:", fileReferences);

		const time_related_files = await this.plugin.check_time_related_query(userInput);
		if (time_related_files.length > 0) {
			time_related_files.forEach((file: { name: string, content: string }) => {
				if (!fileReferences.some(ref => ref.toLowerCase() === file.name.toLowerCase())) {
					includedFiles.push(file);
					console.log("Added time-related file:", file.name);
				}
			});
		}

		if (fileReferences.length > 0) {
			for (const fileName of fileReferences) {
				const file = this.app.vault.getMarkdownFiles().find(f =>
					f.basename.toLowerCase() === fileName.toLowerCase());

				if (file) {
					try {
						const content = await this.app.vault.read(file);
						includedFiles.push({ name: file.basename, content });
						console.log("Added file:", file.basename);
					} catch (error) {
						new Notice(`Could not read file: ${fileName}`);
						console.error("Error reading file:", fileName, error);
					}
				} else {
					const fuzzy_match = this.app.vault.getMarkdownFiles().find(f =>
						f.basename.toLowerCase().includes(fileName.toLowerCase()) ||
						fileName.toLowerCase().includes(f.basename.toLowerCase()));

					if (fuzzy_match) {
						try {
							const content = await this.app.vault.read(fuzzy_match);
							includedFiles.push({ name: fuzzy_match.basename, content });
							console.log("Added file (fuzzy match):", fuzzy_match.basename);
						} catch (error) {
							new Notice(`Could not read file: ${fuzzy_match.basename}`);
							console.error("Error reading file:", fuzzy_match.basename, error);
						}
					} else {
						new Notice(`File not found: ${fileName}`);
						console.warn("File not found:", fileName);
					}
				}
			}
		}

		if (this.plugin.settings.includeCurrentFile) {
			const fileContent = await this.getCurrentFileContent();
			const currentFile = this.app.workspace.getActiveFile();

			if (fileContent && currentFile && !fileReferences.some(ref =>
				ref.toLowerCase() === currentFile.basename.toLowerCase())) {
				includedFiles.push({ name: currentFile.basename, content: fileContent });
				console.log("Added current file:", currentFile.basename);
			}
		}

		if (includedFiles.length > 0) {
			let filesContent = '';
			for (const file of includedFiles) {
				const is_daily_note = file.name.match(/\d{4}-\d{2}-\d{2}/) ||
					file.name.toLowerCase().includes('daily') ||
					file.name.toLowerCase().includes('journal') ||
					file.name.toLowerCase().match(/\b(mon|tue|wed|thu|fri|sat|sun)/);

				if (is_daily_note) {
					const date_parts = file.name.match(/(\d{4})-(\d{2})-(\d{2})/) || [];
					const date_str = date_parts.length > 0
						? `${date_parts[1]}-${date_parts[2]}-${date_parts[3]}`
						: file.name;

					filesContent += `Your daily note for ${date_str}. This contains your activities and notes for this day:\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
				} else {
					filesContent += `File: ${file.name}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
				}
			}

			apiText = `${filesContent}\n\nUser question:\n${userInput}\n\nPlease answer based on the content of the provided files.`;

			displayText = {
				text: this.removeFileReferences(userInput),
				fileNames: includedFiles.map(f => f.name)
			};

			console.log("Display text with file names:", displayText);
		}

		// Add conversation context analysis
		this.analyze_conversation_context(userInput);

		if (this.conversation_context && this.chatHistory.length > 0) {
			apiText = `${apiText}\n\nConversation context: ${this.conversation_context}`;
		}

		return { displayText, apiText };
	}

	private extractFileReferences(text: string): string[] {
		// Create a Set for faster lookups and to avoid duplicates
		const mentions_set = new Set<string>();
		let match;

		// Process backtick-wrapped references
		const backtick_regex = /@`([^`]+)`/g;
		while ((match = backtick_regex.exec(text)) !== null) {
			const filename = match[1].trim();
			if (filename) mentions_set.add(filename);
		}

		// Process simple references
		const simple_regex = /@([^\s@`.,;!?]+)/g;
		while ((match = simple_regex.exec(text)) !== null) {
			mentions_set.add(match[1]);
		}

		// Convert Set to Array for return
		return Array.from(mentions_set);
	}

	private removeFileReferences(text: string): string {
		console.log("Removing file references from:", text);

		let cleaned_text = text.replace(/@`[^`]+`/g, '');

		const extracted_refs = this.extractFileReferences(text);

		extracted_refs.sort((a, b) => b.length - a.length);

		for (const ref of extracted_refs) {
			if (text.includes(`@\`${ref}\``)) continue;

			const escaped_ref = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const ref_regex = new RegExp(`@${escaped_ref}(?=\\s|$|[.,;!?])`, 'g');
			cleaned_text = cleaned_text.replace(ref_regex, '');
		}

		cleaned_text = cleaned_text.replace(/\s+/g, ' ').trim();

		console.log("Cleaned text:", cleaned_text);
		return cleaned_text;
	}

	private handleFileSuggestions() {
		const text = this.inputField.value;
		const cursor_position = this.inputField.selectionStart;
		const text_before_cursor = text.substring(0, cursor_position);

		const at_index = text_before_cursor.lastIndexOf('@');

		if (at_index !== -1 && (at_index === 0 || text_before_cursor[at_index - 1] === ' ' || text_before_cursor[at_index - 1] === '\n')) {
			const query = text_before_cursor.substring(at_index + 1).toLowerCase();
			this.handle_file_suggestions(query);
		} else {
			this.hideSuggestions();
		}
	}

	private async show_file_suggestions_impl(query: string) {
		// Cache DOM elements and file list for better performance
		if (this._cached_files.length === 0) {
			this._cached_files = this.app.vault.getMarkdownFiles();
		}

		// Use more efficient filtering with early return for empty query
		if (!query.trim()) {
			this.hideSuggestions();
			return;
		}

		// Use a more efficient filtering approach
		const query_lower = query.toLowerCase();
		const matched_files = this._cached_files
			.filter((file: TFile) => {
				const basename_lower = file.basename.toLowerCase();
				if (basename_lower.includes(query_lower)) return true;

				const parent_path = file.parent?.path?.toLowerCase();
				return parent_path && parent_path.includes(query_lower);
			})
			.slice(0, 5);

		if (matched_files.length === 0) {
			this.hideSuggestions();
			return;
		}

		// Create a document fragment for batch DOM operations
		const fragment = document.createDocumentFragment();
		this.suggestionContainer.empty();
		this.fileSuggestions = [];
		this.currentSuggestionIndex = 0;

		// Set container properties once
		this.suggestionContainer.style.display = "block";

		// Position the container
		const input_rect = this.inputField.getBoundingClientRect();
		const container_rect = this.suggestionContainer.parentElement?.getBoundingClientRect();

		if (container_rect) {
			Object.assign(this.suggestionContainer.style, {
				width: `${this.inputField.offsetWidth}px`,
				left: `${input_rect.left - container_rect.left}px`,
				position: "absolute",
				bottom: `${input_rect.height + 24}px`
			});
		}

		// Create all suggestion items in the fragment
		matched_files.forEach((file: TFile, index: number) => {
			const suggestion_item = document.createElement('div');
			suggestion_item.className = `file-suggestion-item ${index === 0 ? 'selected' : ''}`;

			const file_icon = document.createElement('span');
			file_icon.className = 'suggestion-file-icon';
			file_icon.textContent = '📄';
			suggestion_item.appendChild(file_icon);

			const file_name = document.createElement('span');
			file_name.className = 'suggestion-file-name';
			file_name.textContent = file.basename;
			suggestion_item.appendChild(file_name);

			const file_path = document.createElement('span');
			file_path.className = 'suggestion-file-path';
			file_path.textContent = file.parent?.path ? `(${file.parent.path})` : '';
			suggestion_item.appendChild(file_path);

			suggestion_item.addEventListener('click', () => {
				this.insertFileReference(file);
			});

			suggestion_item.addEventListener('mouseenter', () => {
				this.selectSuggestion(index);
			});

			fragment.appendChild(suggestion_item);
			this.fileSuggestions.push(suggestion_item);
		});

		// Add all items to the DOM at once
		this.suggestionContainer.appendChild(fragment);
		this.isShowingSuggestions = true;
	}

	private hideSuggestions() {
		this.suggestionContainer.style.display = "none";
		this.suggestionContainer.empty();
		this.fileSuggestions = [];
		this.isShowingSuggestions = false;
	}

	private navigateSuggestion(direction: number) {
		if (this.fileSuggestions.length === 0) return;

		this.fileSuggestions[this.currentSuggestionIndex].removeClass('selected');

		this.currentSuggestionIndex = (this.currentSuggestionIndex + direction + this.fileSuggestions.length) % this.fileSuggestions.length;

		this.selectSuggestion(this.currentSuggestionIndex);
	}

	private selectSuggestion(index: number) {
		if (index >= 0 && index < this.fileSuggestions.length) {
			this.fileSuggestions.forEach(item => item.removeClass('selected'));

			this.fileSuggestions[index].addClass('selected');
			this.currentSuggestionIndex = index;
		}
	}

	private selectCurrentSuggestion() {
		if (this.fileSuggestions.length === 0) return;

		const files = this.app.vault.getMarkdownFiles();
		const text = this.inputField.value;
		const cursorPosition = this.inputField.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPosition);
		const atIndex = textBeforeCursor.lastIndexOf('@');
		const query = textBeforeCursor.substring(atIndex + 1).toLowerCase();

		const matchedFiles = files.filter(file =>
			file.path.toLowerCase().includes(query) ||
			file.basename.toLowerCase().includes(query)
		).slice(0, 5);

		if (matchedFiles.length > this.currentSuggestionIndex) {
			this.insertFileReference(matchedFiles[this.currentSuggestionIndex]);
		}
	}

	private insertFileReference(file: TFile) {
		const text = this.inputField.value;
		const cursorPosition = this.inputField.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPosition);
		const textAfterCursor = text.substring(cursorPosition);
		const atIndex = textBeforeCursor.lastIndexOf('@');

		const needs_backticks = file.basename.includes(' ') || true;

		const newText = textBeforeCursor.substring(0, atIndex) +
			(needs_backticks ? `@\`${file.basename}\`` : `@${file.basename}`) +
			(textAfterCursor.startsWith(' ') ? '' : ' ') +
			textAfterCursor;

		this.inputField.value = newText;

		const reference_length = needs_backticks
			? file.basename.length + 2
			: file.basename.length;

		const newCursorPosition = atIndex + 1 + reference_length + (textAfterCursor.startsWith(' ') ? 0 : 1);
		this.inputField.setSelectionRange(newCursorPosition, newCursorPosition);
		this.inputField.focus();

		this.hideSuggestions();

		console.log("Inserted file reference:", file.basename, "with backticks:", needs_backticks);
	}

	private generate_conversation_id(): string {
		return Date.now().toString(36) + Math.random().toString(36).substring(2);
	}

	private analyze_conversation_context(message: string): void {
		// Extract key topics from the message
		const words = message.toLowerCase()
			.replace(/[^\w\s]/g, '')
			.split(/\s+/)
			.filter(word => word.length > 3)
			.filter(word => !['what', 'when', 'where', 'which', 'this', 'that', 'there', 'their', 'about'].includes(word));

		// Count word frequency
		const word_counts: Record<string, number> = {};
		words.forEach(word => {
			word_counts[word] = (word_counts[word] || 0) + 1;
		});

		// Get top 5 most frequent words
		const top_words = Object.entries(word_counts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(entry => entry[0]);

		// Update conversation context
		this.conversation_context = top_words.join(', ');
	}

	// Add this new method to show copy feedback
	private show_copy_feedback(message: string): void {
		// Remove any existing feedback
		const existing = document.querySelector('.copy-feedback');
		if (existing) existing.remove();

		// Create new feedback element
		const feedback = document.createElement('div');
		feedback.className = 'copy-feedback';
		feedback.textContent = message;
		document.body.appendChild(feedback);

		// Show with animation
		setTimeout(() => feedback.classList.add('visible'), 10);

		// Hide and remove after delay
		setTimeout(() => {
			feedback.classList.remove('visible');
			setTimeout(() => feedback.remove(), 300);
		}, 2000);
	}

	private addContextMenuForSelection(): void {
		this.registerDomEvent(document, 'selectionchange', () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) return;

			// Check if selection is within a message content div
			const range = selection.getRangeAt(0);
			const container = range.commonAncestorContainer.parentElement;
			const is_in_message = container?.closest('.message-content');

			if (is_in_message) {
				// We have a valid selection in a message
				const selected_text = selection.toString().trim();
				if (selected_text) {
					// Store the selection for potential use
					this.current_selection = {
						text: selected_text,
						is_in_ai_message: !!container?.closest('.ai-message'),
						range: range
					};
				}
			}
		});

		// Add context menu for selections
		this.plugin.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				if (this.current_selection && this.current_selection.text) {
					menu.addItem((item) => {
						item
							.setTitle('Copy selected text')
							.setIcon('copy')
							.onClick(async () => {
								if (this.current_selection) {
									await navigator.clipboard.writeText(this.current_selection.text);
									this.show_copy_feedback("Text copied");
								}
							});
					});

					if (this.current_selection.is_in_ai_message) {
						// Try to get markdown for the selection if it's in an AI message
						if (this.current_selection.range && this.current_selection.range.commonAncestorContainer) {
							// Use optional chaining and type assertion
							const node = this.current_selection.range.commonAncestorContainer as Node;
							const element = node.nodeType === Node.ELEMENT_NODE
								? node as Element
								: node.parentElement;

							const message_div = element?.closest('.message-content');

							if (message_div) {
								const full_markdown = message_div.getAttribute('data-markdown') || '';

								menu.addItem((item) => {
									item
										.setTitle('Copy as markdown')
										.setIcon('code')
										.onClick(async () => {
											if (this.current_selection) {
												await navigator.clipboard.writeText(this.current_selection.text);
												this.show_copy_feedback("Copied as markdown");
											}
										});
								});
							}
						}
					}
				}
			})
		);
	}

	public async load_chat_history(): Promise<void> {
		try {
			const data = await this.plugin.loadData();
			if (data && data.chat_history) {
				this.chatHistory = data.chat_history;
				this.conversation_id = data.conversation_id || this.generate_conversation_id();
				this.awaiting_user_response = data.awaiting_user_response || false;
			}
		} catch (error) {
			console.error("Error loading chat history:", error);
		}
	}

	// Add a method to render the saved chat history
	private render_saved_chat_history(container: HTMLElement): void {
		this.chatHistory.forEach(message => {
			if (message.role === 'user') {
				this.addMessage(container, message.content, 'user');
			} else {
				const messageDiv = this.addMessage(container, '', 'ai');
				const contentDiv = messageDiv.querySelector('.message-content') as HTMLElement;
				if (contentDiv) {
					// Use a non-animated version for loading saved messages
					this.render_saved_message(message.content, contentDiv);
				}
			}
		});

		// Scroll to the bottom after rendering all messages
		this.scrollToBottom(container);
	}

	// Add a method to render saved messages without animation
	private async render_saved_message(text: string, contentDiv: HTMLElement): Promise<void> {
		try {
			const clean_text = text.trim();

			// Store the original markdown for copying
			contentDiv.setAttribute('data-markdown', clean_text);

			// Clean the text before rendering by removing citation markers
			let display_text = clean_text;

			// Remove citation markers like [1], [2], etc.
			display_text = display_text.replace(/\[\d+\]/g, '');

			// Remove citation sections at the end of the message
			display_text = display_text.replace(/(\n+)(Sources|References|Citations):[^]*$/i, '');

			await MarkdownRenderer.renderMarkdown(display_text, contentDiv, '.', this.plugin);

			// Make content visible immediately without animation
			contentDiv.addClass('fade-in-content');
			contentDiv.addClass('visible');
		} catch (error) {
			contentDiv.empty();
			contentDiv.createEl('div', { text: 'Error rendering response. Original text preserved in copy.' });
			contentDiv.setAttribute('data-markdown', text);
		}
	}

	public async reset_chat(): Promise<void> {
		this.chatHistory = [];
		this.conversation_id = this.generate_conversation_id();
		this.awaiting_user_response = false;

		// Save the empty state - await to ensure it completes
		await this.save_chat_history();

		// Refresh the view
		await this.onOpen();
	}

	public async save_chat_history(): Promise<void> {
		try {
			// First load existing data
			const existing_data = await this.plugin.loadData() || {};

			// Update with new chat history
			const updated_data = {
				...existing_data,
				chat_history: this.chatHistory,
				conversation_id: this.conversation_id,
				awaiting_user_response: this.awaiting_user_response
			};

			// Save the updated data
			await this.plugin.saveData(updated_data);
		} catch (error) {
			console.error("Error saving chat history:", error);
		}
	}
}

const MODELS = {
	'sonar': 'Sonar - Basic ($1/1M tokens)',
	'sonar-pro': 'Sonar Pro - Advanced ($15/1M tokens)',
	'sonar-reasoning': 'Sonar Reasoning - Basic with CoT ($5/1M tokens)',
	'sonar-reasoning-pro': 'Sonar Reasoning Pro - Advanced with CoT ($8/1M tokens)',
	'sonar-deep-research': 'Sonar Deep Research - Extensive research ($8/1M tokens)',
	'r1-1776': 'R1-1776 - Offline chat model ($8/1M tokens)'
} as const;
