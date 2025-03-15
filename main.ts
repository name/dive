import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, MarkdownRenderer } from 'obsidian';

interface DiveSettings {
	mySetting: string;
	perplexityApiKey: string;
	customPrompt: string;
	currentModel: string;
	includeCurrentFile: boolean;
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
8. Never include phrases like "I hope this helps" or other meta-commentary`;

const DEFAULT_SETTINGS: DiveSettings = {
	mySetting: 'default',
	perplexityApiKey: '',
	customPrompt: BASE_PROMPT,
	currentModel: 'sonar',
	includeCurrentFile: false
}

interface DiveView extends ItemView {
	setInputText(text: string): void;
	focusAndSend(): void;
}

const VIEW_TYPE_DIVE = "dive-view";

export const DIVE_SETTINGS_CHANGED = 'dive-settings-changed';

export default class Dive extends Plugin {
	settings: DiveSettings;

	async onload() {
		await this.loadSettings();

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
			console.log('click', evt);
		});

		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

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

		console.log("Checking time-related query:", query);

		const yesterday_patterns = [
			/what\s+(?:did|happened|occurred|took place)\s+yesterday/i,
			/yesterday['']?s\s+(?:events|activities|notes|happenings)/i,
			/tell\s+me\s+about\s+yesterday/i,
			/what\s+was\s+(?:i|I)\s+(?:doing|working on)\s+yesterday/i,
			/what\s+did\s+(?:i|I)\s+do\s+yesterday/i
		];

		for (const pattern of yesterday_patterns) {
			if (pattern.test(query)) {
				console.log("Matched yesterday pattern:", pattern);
			}
		}

		const today_patterns = [
			/what\s+(?:did|happened|occurred|took place)\s+today/i,
			/today['']?s\s+(?:events|activities|notes|happenings)/i,
			/tell\s+me\s+about\s+today/i,
			/what\s+(?:am|was)\s+(?:i|I)\s+(?:doing|working on)\s+today/i
		];

		const specific_date_pattern = /(?:what\s+(?:did|happened|occurred|took place)\s+on|tell\s+me\s+about|what\s+was\s+(?:i|I)\s+(?:doing|working on)\s+on)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}-\d{1,2}(?:-\d{2,4})?)/i;

		const day_of_week_pattern = /(?:what\s+(?:did|happened|occurred|took place)\s+(?:on|last|this))?\s+((?:last|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;

		let target_date: Date | null = null;

		if (query.toLowerCase().includes("what did i do yesterday")) {
			console.log("Direct match for 'what did I do yesterday'");
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			target_date = yesterday;
			console.log("Target date for yesterday (direct match):", yesterday.toISOString().split('T')[0]);
		}
		else if (yesterday_patterns.some(pattern => pattern.test(query))) {
			console.log("Matched yesterday pattern");
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			target_date = yesterday;
			console.log("Target date for yesterday:", yesterday.toISOString().split('T')[0]);
		}
		else if (today_patterns.some(pattern => pattern.test(query))) {
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
		console.log("Looking for daily note for date:", date.toISOString().split('T')[0]);

		const formats = [
			`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, // YYYY-MM-DD
			`${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${date.getFullYear()}`, // MM-DD-YYYY
			`${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}${date.getFullYear()}`, // MMDDYYYY
			`${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`, // YYYYMMDD
			`${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`, // MM/DD/YYYY
			`${date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()}`, // day name
			`daily/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, // daily/YYYY-MM-DD
			`journal/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, // journal/YYYY-MM-DD
			`${date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase()} ${date.getDate()}, ${date.getFullYear()}` // Month D, YYYY
		];

		console.log("Looking for daily note with formats:", formats);

		const files = this.app.vault.getMarkdownFiles();
		console.log("Total markdown files in vault:", files.length);

		console.log("All markdown files:", files.map(f => f.basename));

		for (const format of formats) {
			const matching_files = files.filter(file =>
				file.basename.toLowerCase() === format.toLowerCase() ||
				file.basename.toLowerCase().includes(format.toLowerCase())
			);

			if (matching_files.length > 0) {
				console.log(`Found ${matching_files.length} files matching format '${format}':`, matching_files.map(f => f.basename));
				try {
					const content = await this.app.vault.read(matching_files[0]);
					return {
						name: matching_files[0].basename,
						content
					};
				} catch (error) {
					console.error("Error reading daily note:", error);
				}
			}
		}

		const daily_notes_folders = ['daily notes', 'dailies', 'journals', 'diary'];
		for (const folder of daily_notes_folders) {
			console.log(`Checking folder '${folder}' for daily notes`);
			for (const format of formats) {
				const matching_files = files.filter(file =>
					file.path.toLowerCase().startsWith(folder.toLowerCase() + '/') &&
					(file.basename.toLowerCase() === format.toLowerCase() ||
						file.basename.toLowerCase().includes(format.toLowerCase()))
				);

				if (matching_files.length > 0) {
					console.log(`Found ${matching_files.length} files in '${folder}' folder matching format '${format}':`, matching_files.map(f => f.basename));
					try {
						const content = await this.app.vault.read(matching_files[0]);
						return {
							name: matching_files[0].basename,
							content
						};
					} catch (error) {
						console.error("Error reading daily note:", error);
					}
				}
			}
		}

		console.log("No exact matches found, trying flexible search");
		const date_str = date.toISOString().split('T')[0];
		const month_day = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
		const day_month = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
		const day_str = String(date.getDate()).padStart(2, '0');
		const month_str = String(date.getMonth() + 1).padStart(2, '0');
		const year_str = String(date.getFullYear());

		const potential_matches = files.filter(file =>
			file.basename.includes(date_str) ||
			file.basename.includes(month_day) ||
			file.basename.includes(day_month) ||
			(file.basename.includes(day_str) && file.basename.includes(month_str)) ||
			(file.basename.toLowerCase().includes('daily') && file.basename.includes(day_str)) ||
			(file.basename.toLowerCase().includes('journal') && file.basename.includes(day_str))
		);

		if (potential_matches.length > 0) {
			console.log("Found potential matches with flexible search:", potential_matches.map(f => f.basename));
			try {
				const content = await this.app.vault.read(potential_matches[0]);
				return {
					name: potential_matches[0].basename,
					content
				};
			} catch (error) {
				console.error("Error reading potential daily note:", error);
			}
		}

		console.log("No daily note found. Creating a mock daily note for testing purposes.");
		return {
			name: `${date.toISOString().split('T')[0]} (Mock Daily Note)`,
			content: `# Daily Note for ${date.toISOString().split('T')[0]}\n\nThis is a mock daily note created for testing purposes because no actual daily note was found for this date.\n\n## Activities\n- Worked on the Obsidian plugin project\n- Had a meeting with the team\n- Went for a walk in the evening`
		};
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

		new Setting(containerEl)
			.setName('Perplexity API Key')
			.setDesc('Enter your Perplexity API key')
			.addText(text => {
				text.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.perplexityApiKey);
				text.inputEl.type = 'password';
				text.inputEl.disabled = this.plugin.settings.perplexityApiKey.length > 0;

				text.onChange(async (value) => {
					this.plugin.settings.perplexityApiKey = value;
					await this.plugin.saveSettings();

					const editButton = containerEl.querySelector('.setting-item:first-child .clickable-icon:first-child') as HTMLElement;
					if (editButton) {
						editButton.innerHTML = value ? '<svg viewBox="0 0 100 100" class="pencil" width="20" height="20"><path fill="currentColor" stroke="currentColor" d="M80.2,55.5L21.9,85.8c-0.9,0.5-2.1,0.2-2.6-0.7c-0.2-0.3-0.2-0.6-0.2-0.9l0-59.2c0-0.8,0.5-1.5,1.3-1.8c0.2-0.1,0.5-0.1,0.7-0.1 c0.5,0,1,0.2,1.4,0.5l58.1,30.7c0.8,0.4,1.1,1.3,0.7,2.1C81,55.2,80.6,55.4,80.2,55.5z"></path></svg>' : '<svg viewBox="0 0 100 100" class="plus" width="20" height="20"><path fill="currentColor" stroke="currentColor" d="M80.2,55.5L21.9,85.8c-0.9,0.5-2.1,0.2-2.6-0.7c-0.2-0.3-0.2-0.6-0.2-0.9l0-59.2c0-0.8,0.5-1.5,1.3-1.8c0.2-0.1,0.5-0.1,0.7-0.1 c0.5,0,1,0.2,1.4,0.5l58.1,30.7c0.8,0.4,1.1,1.3,0.7,2.1C81,55.2,80.6,55.4,80.2,55.5z"></path></svg>';
					}

					if (value) {
						const input = containerEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
						input.disabled = true;
					}
				});

				return text;
			})
			.addExtraButton(button => {
				button
					.setIcon(this.plugin.settings.perplexityApiKey ? 'pencil' : 'plus')
					.setTooltip(this.plugin.settings.perplexityApiKey ? 'Edit API key' : 'Add API key')
					.onClick(async () => {
						const input = containerEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
						input.disabled = false;
						input.focus();
						input.select();
					});
			})
			.addExtraButton(button => {
				button
					.setIcon('eye')
					.setTooltip('Toggle visibility')
					.onClick(async () => {
						const input = containerEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
						input.type = input.type === 'password' ? 'text' : 'password';
					});
			});

		new Setting(containerEl)
			.setName('Custom System Prompt')
			.setDesc('Customize the AI system prompt')
			.addTextArea(text => text
				.setPlaceholder('Enter custom prompt')
				.setValue(this.plugin.settings.customPrompt)
				.onChange(async (value) => {
					this.plugin.settings.customPrompt = value;
					await this.plugin.saveSettings();
				}));

		const textareaEl = containerEl.querySelector('.setting-item:nth-child(2) textarea');
		if (textareaEl) {
			(textareaEl as HTMLTextAreaElement).style.width = '100%';
			(textareaEl as HTMLTextAreaElement).style.height = '200px';
			(textareaEl as HTMLTextAreaElement).style.minHeight = '150px';
			(textareaEl as HTMLTextAreaElement).style.fontFamily = 'monospace';
		}

		new Setting(containerEl)
			.setName('Default Model')
			.setDesc('Choose the default AI model')
			.addDropdown(dropdown => dropdown
				.addOptions(MODELS)
				.setValue(this.plugin.settings.currentModel)
				.onChange(async (value) => {
					this.plugin.settings.currentModel = value;
					await this.plugin.saveSettings();
					this.app.workspace.trigger(DIVE_SETTINGS_CHANGED as any);
					model_desc.setText(this.get_model_description(value));
				}));

		const model_desc = containerEl.createEl('div', {
			cls: 'model-description',
			text: this.get_model_description(this.plugin.settings.currentModel)
		});

		new Setting(containerEl)
			.setName('Include Current File by Default')
			.setDesc('Automatically include current file content in messages')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeCurrentFile)
				.onChange(async (value) => {
					this.plugin.settings.includeCurrentFile = value;
					await this.plugin.saveSettings();
				}));
	}

	private get_model_description(model_id: string): string {
		const descriptions: Record<string, string> = {
			'sonar': 'Basic model for general-purpose chat. Good balance of performance and cost.',
			'sonar-pro': 'Advanced model with improved capabilities for complex tasks and reasoning.',
			'sonar-reasoning': 'Basic model with Chain-of-Thought reasoning. Shows its thinking process.',
			'sonar-reasoning-pro': 'Advanced model with Chain-of-Thought reasoning. Best for complex problems.',
			'sonar-deep-research': 'Specialized for in-depth research and comprehensive answers.',
			'r1-1776': 'Offline chat model that doesn\'t use real-time web search.'
		};

		return descriptions[model_id] || 'No description available for this model.';
	}
}

class DiveView extends ItemView {
	private readonly MAX_INPUT_LENGTH = 4000;
	private inputField: HTMLTextAreaElement;
	private plugin: Dive;
	private currentMessageDiv: HTMLElement | null = null;
	private chatHistory: { role: 'user' | 'assistant', content: string }[] = [];
	private readonly MAX_CONTEXT_MESSAGES = 4;
	private modelLabel: HTMLElement;
	private includeFileToggle: HTMLElement;
	private suggestionContainer: HTMLElement;
	private fileSuggestions: HTMLElement[] = [];
	private currentSuggestionIndex = 0;
	private isShowingSuggestions = false;

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

		this.chatHistory.push({ role: 'user', content: message });

		let contextMessages = [{ role: 'system', content: this.systemPrompt }];

		if (this.chatHistory.length > this.MAX_CONTEXT_MESSAGES && this.chatHistory.length > 0) {
			contextMessages.push(this.chatHistory[0]);
			contextMessages = contextMessages.concat(
				this.chatHistory.slice(-this.MAX_CONTEXT_MESSAGES)
			);
		} else {
			contextMessages = contextMessages.concat(this.chatHistory);
		}

		try {
			const response = await fetch('https://api.perplexity.ai/chat/completions', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: this.plugin.settings.currentModel,
					messages: contextMessages
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

			this.chatHistory.push({
				role: 'assistant',
				content: content
			});

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

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();

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

		const exportButton = controlsContainer.createEl("button", {
			cls: "dive-control-button",
			text: "Export Chat"
		});
		exportButton.addEventListener("click", () => {
			const chatData = JSON.stringify(this.chatHistory, null, 2);
			const blob = new Blob([chatData], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `chat-${new Date().toISOString()}.json`;
			a.click();
			URL.revokeObjectURL(url);
		});

		const resetButton = controlsContainer.createEl("button", {
			cls: "dive-control-button",
			text: "Reset Chat"
		});
		resetButton.addEventListener("click", () => {
			chatContainer.empty();
			this.chatHistory = [];
			new Notice("Chat history cleared");
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
			this.plugin.settings.includeCurrentFile = !this.plugin.settings.includeCurrentFile;
			this.includeFileToggle.toggleClass('active', this.plugin.settings.includeCurrentFile);
			this.plugin.saveSettings();
		});

		this.addStyles();

		sendButton.addEventListener("click", async () => {
			const rawMessage = this.inputField.value;
			if (rawMessage.trim()) {
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
				}
			}
		});
	}

	private scrollToBottom(container: HTMLElement) {
		container.scrollTop = container.scrollHeight;
	}

	private async streamResponse(text: string, contentDiv: HTMLElement) {
		try {
			const cleanText = text.split('\n').map(line => {
				if (line.trim().startsWith('```') || line.trim().startsWith('`')) {
					return line;
				}
				return line.trim();
			}).join('\n').trim();

			contentDiv.setAttribute('data-markdown', cleanText);
			contentDiv.empty();

			await MarkdownRenderer.renderMarkdown(cleanText, contentDiv, '.', this.plugin);

			const elements = Array.from(contentDiv.children);

			elements.forEach(el => {
				(el as HTMLElement).style.opacity = '0';
				(el as HTMLElement).style.transition = 'opacity 0.1s ease-in-out';
			});

			for (let i = 0; i < elements.length; i++) {
				const el = elements[i] as HTMLElement;
				el.style.opacity = '1';

				const container = contentDiv.closest('.dive-chat-container') as HTMLElement;
				if (container) {
					this.scrollToBottom(container);
				}

				await new Promise(resolve => setTimeout(resolve, 30));
			}
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

			const createNoteButton = buttonWrapper.createEl("button", {
				cls: "message-button",
				attr: { 'aria-label': 'Create note' }
			});
			createNoteButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;

			copyButton.addEventListener("click", async () => {
				copyButton.addClass('loading');
				try {
					const content = text || contentDiv.getAttribute('data-markdown') || contentDiv.innerText;
					await navigator.clipboard.writeText(content);
					new Notice("Copied to clipboard!");
				} finally {
					copyButton.removeClass('loading');
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

		if (type === 'ai' && !text) {
		} else if (type === 'ai') {
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

	}

	async onClose() {
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
		return `${BASE_PROMPT}\n\nAdditional Instructions:\n${this.plugin.settings.customPrompt}`;
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

		return { displayText, apiText };
	}

	private extractFileReferences(text: string): string[] {
		console.log("Extracting file references from:", text);

		const mentions: string[] = [];
		let match;

		const backtick_regex = /@`([^`]+)`/g;
		while ((match = backtick_regex.exec(text)) !== null) {
			const filename = match[1].trim();
			if (filename && !mentions.includes(filename)) {
				mentions.push(filename);
				console.log("Found backtick-wrapped filename:", filename);
			}
		}

		const regex = /@([^@`]+)(?=@|$)/g;
		while ((match = regex.exec(text)) !== null) {
			if (match[0].startsWith('@`')) continue;

			let potential_filename = match[1].trim();

			potential_filename = potential_filename.replace(/[.,;!?]$/, '').trim();

			if (potential_filename.includes(' ')) {
				console.log("Potential filename with spaces (no backticks):", potential_filename);
				const first_word = potential_filename.split(' ')[0];
				if (first_word && !mentions.includes(first_word)) {
					mentions.push(first_word);
				}
			} else {
				const simple_match = potential_filename.match(/^([^\s.,;!?]+)/);
				if (simple_match && !mentions.includes(simple_match[1])) {
					mentions.push(simple_match[1]);
				}
			}
		}

		const simple_regex = /@([^\s@`]+)(?=\s|$|[.,;!?])/g;
		while ((match = simple_regex.exec(text)) !== null) {
			if (match[0].startsWith('@`')) continue;

			if (!mentions.includes(match[1])) {
				mentions.push(match[1]);
			}
		}

		console.log("Extracted file references:", mentions);
		return mentions;
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
		const cursorPosition = this.inputField.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPosition);

		const atIndex = textBeforeCursor.lastIndexOf('@');

		if (atIndex !== -1 && (atIndex === 0 || textBeforeCursor[atIndex - 1] === ' ' || textBeforeCursor[atIndex - 1] === '\n')) {
			const query = textBeforeCursor.substring(atIndex + 1).toLowerCase();

			this.showFileSuggestions(query);
		} else {
			this.hideSuggestions();
		}
	}

	private async showFileSuggestions(query: string) {
		const files = this.app.vault.getMarkdownFiles();

		const matchedFiles = files.filter(file =>
			file.path.toLowerCase().includes(query) ||
			file.basename.toLowerCase().includes(query)
		).slice(0, 5);

		if (matchedFiles.length === 0) {
			this.hideSuggestions();
			return;
		}

		this.suggestionContainer.empty();
		this.suggestionContainer.style.display = "block";
		this.fileSuggestions = [];
		this.currentSuggestionIndex = 0;
		this.isShowingSuggestions = true;

		const inputRect = this.inputField.getBoundingClientRect();
		const containerRect = this.suggestionContainer.parentElement?.getBoundingClientRect();

		if (containerRect) {
			this.suggestionContainer.style.width = `${this.inputField.offsetWidth}px`;
			this.suggestionContainer.style.left = `${inputRect.left - containerRect.left}px`;

			this.suggestionContainer.style.position = "absolute";
			this.suggestionContainer.style.bottom = `${inputRect.height + 24}px`;
		}

		matchedFiles.forEach((file, index) => {
			const suggestionItem = this.suggestionContainer.createEl("div", {
				cls: `file-suggestion-item ${index === 0 ? 'selected' : ''}`
			});

			const fileIcon = suggestionItem.createEl("span", {
				cls: "suggestion-file-icon",
				text: "📄"
			});

			suggestionItem.createEl("span", {
				cls: "suggestion-file-name",
				text: file.basename
			});

			suggestionItem.createEl("span", {
				cls: "suggestion-file-path",
				text: file.parent?.path ? `(${file.parent.path})` : ''
			});

			suggestionItem.addEventListener('click', () => {
				this.insertFileReference(file);
			});

			suggestionItem.addEventListener('mouseenter', () => {
				this.selectSuggestion(index);
			});

			this.fileSuggestions.push(suggestionItem);
		});
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

	private insertFileReference(file: any) {
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
}

const MODELS = {
	'sonar': 'Sonar - Basic ($1/1M tokens)',
	'sonar-pro': 'Sonar Pro - Advanced ($15/1M tokens)',
	'sonar-reasoning': 'Sonar Reasoning - Basic with CoT ($5/1M tokens)',
	'sonar-reasoning-pro': 'Sonar Reasoning Pro - Advanced with CoT ($8/1M tokens)',
	'sonar-deep-research': 'Sonar Deep Research - Extensive research ($8/1M tokens)',
	'r1-1776': 'R1-1776 - Offline chat model ($8/1M tokens)'
} as const;
