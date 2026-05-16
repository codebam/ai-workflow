import {
	TelegramBot,
	TelegramExecutionContext,
	Webhook,
	TelegramApi,
	HistoryManager,
	getBalance,
	markdownToHtml,
	fetchTool,
	TelegramCommand,
	TelegramGuestMessage,
	PartialTelegramUpdate,
	TelegramInlineQueryType,
} from '@codebam/cf-workers-telegram-bot';

// @ts-ignore
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export interface Env {
	CONVERSATION_HISTORY: KVNamespace;
	R2: R2Bucket;
	AI: Ai;
	AI_WORKFLOW: Workflow;
}

export class AIWorkflow extends WorkflowEntrypoint<Env, any> {
	async run(event: WorkflowEvent<any>, step: WorkflowStep): Promise<void> {
		const task = event.payload;
		const env = this.env;

		// Mock TelegramExecutionContext
		const tctx = {
			chat: { id: task.chatId },
			from: { id: task.userId },
			reply: async (text: string, options: any = {}) => {
				const api = new TelegramApi();
				return await api.sendMessage(`https://api.telegram.org/bot${task.token}`, {
					chat_id: task.chatId,
					text,
					parse_mode: options.parse_mode || 'HTML',
					reply_markup: options.reply_markup,
				});
			},
		} as unknown as TelegramExecutionContext;

		const messages = [
			{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
			...(task.history || []),
			{ role: 'user', content: task.prompt },
		];

		const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

		try {
			const content = await streamAiResponseToTelegram(tctx, env, modelId, messages, task);
			if (task.userId && content) {
				const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
				await historyManager.addMessage(task.userId, task.prompt, content, task.threadId);
			}
		} catch (e) {
			console.error('Error in workflow execution:', e);
			try {
				await tctx.reply('Error: ' + String(e));
			} catch (replyError) {
				console.error('Failed to send error reply to Telegram:', replyError);
			}
		}
	}
}

async function customRunWithTools(
	ai: Ai,
	model: string,
	input: { messages: any[]; tools?: any[] },
	config: { streamFinalResponse: boolean },
) {
	const messages = [...input.messages];
	const tools = input.tools || [];
	const isGemini = model.includes('google/gemini');

	const cfTools = tools.map((t: any) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));

	const runModel = async (msgs: any[], stream: boolean) => {
		if (isGemini) {
			const systemMessage = msgs.find((m) => m.role === 'system');
			const otherMessages = msgs.filter((m) => m.role !== 'system');
			const geminiInput: Record<string, unknown> = {
				contents: otherMessages.map((m) => ({
					role: m.role === 'assistant' ? 'model' : 'user',
					parts: [{ text: m.content as string }],
				})),
				stream,
			};
			if (systemMessage) {
				geminiInput.system_instruction = {
					parts: [{ text: systemMessage.content as string }],
				};
			}
			return await ai.run(model, geminiInput);
		}
		return await ai.run(model, { messages: msgs, tools: cfTools.length > 0 ? cfTools : undefined, stream });
	};

	if (cfTools.length === 0 || isGemini) {
		return await runModel(messages, config.streamFinalResponse);
	}

	const response = (await runModel(messages, false)) as any;

	// FIX: Robustly extract from BOTH Cloudflare formats (Standard and OpenAI-compatible)
	let toolCalls: any[] = [];
	if (response?.tool_calls) {
		toolCalls = [...response.tool_calls];
	} else if (response?.choices?.[0]?.message?.tool_calls) {
		toolCalls = [...response.choices[0].message.tool_calls];
	}

	let responseText = response?.response || response?.choices?.[0]?.message?.content || '';

	// GEMMA/LLAMA FALLBACK: Catch raw tokens if native interception fails
	if (toolCalls.length === 0) {
		const gemmaRegex = /<\|tool_call>\s*call:\s*([a-zA-Z0-9_]+)([\s\S]*?)<tool_call\|>/g;
		const standardRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

		let match;
		while ((match = gemmaRegex.exec(responseText)) !== null) {
			let name = match[1].trim();
			if (name === 'http_fetch' || name === 'api_fetch') {
				name = 'fetch';
			}

			let argsString = match[2].trim();
			// Sanitize malformed JSON syntax
			argsString = argsString.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ': "$1"');

			toolCalls.push({
				id: `call_${Math.random().toString(36).substring(2, 9)}`,
				type: 'function',
				function: { name, arguments: argsString },
			});
		}

		while ((match = standardRegex.exec(responseText)) !== null) {
			const content = match[1].trim();
			try {
				// Handle both raw JSON and name/args format
				const parsed = JSON.parse(content.replace(/'/g, '"'));
				const name = parsed.name || 'fetch';
				const args = parsed.arguments || parsed;
				toolCalls.push({
					id: `call_${Math.random().toString(36).substring(2, 9)}`,
					type: 'function',
					function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
				});
			} catch (e) {
				console.error('Failed to parse tool call:', content, e);
			}
		}

		// Strip the raw tokens from the visible response
		responseText = responseText
			.replace(/<\|tool_call>[\s\S]*?<tool_call\|>/g, '')
			.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
			.trim();
	}

	if (toolCalls.length > 0) {
		const normalizedToolCalls = toolCalls.map((call: any, index: number) => {
			const name = call.name || (call.function && call.function.name);
			let args = call.arguments || (call.function && call.function.arguments);
			if (typeof args !== 'string') {
				try {
					args = JSON.stringify(args);
				} catch {
					args = '{}';
				}
			}
			return {
				id: call.id || `call_${Math.random().toString(36).substring(2, 9)}_${index}`,
				type: 'function',
				function: { name, arguments: args },
			};
		});

		messages.push({
			role: 'assistant',
			content: responseText,
			tool_calls: normalizedToolCalls,
		});

		for (const call of normalizedToolCalls) {
			const toolName = call.function.name;
			const toolId = call.id;
			const toolArgsString = call.function.arguments;
			const tool = tools.find((t: any) => t.name === toolName);

			if (tool && tool.function) {
				try {
					let parsedArgs;
					try {
						parsedArgs = JSON.parse(toolArgsString);
					} catch {
						parsedArgs = toolArgsString;
					}
					const result = await tool.function(parsedArgs);
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(result) });
				} catch (e) {
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(e) });
				}
			} else {
				messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: 'Tool not found' });
			}
		}

		return await runModel(messages, true);
	}

	return response;
}

/**
 * Robustly extract text from various AI response formats.
 * Handles OpenAI, Cloudflare, and Google Gemini structures.
 */
function extractText(obj: any): string {
	if (typeof obj === 'string') {
		return obj;
	}
	if (typeof obj !== 'object' || obj === null) {
		return '';
	}

	// Direct fields
	if (typeof obj.response === 'string') {
		return obj.response;
	}
	if (typeof obj.text === 'string') {
		return obj.text;
	}
	if (typeof obj.content === 'string') {
		return obj.content;
	}
	if (typeof obj.delta === 'string') {
		return obj.delta;
	}

	// Nested fields
	if (obj.choices && Array.isArray(obj.choices) && obj.choices.length > 0) {
		return extractText(obj.choices[0]);
	}
	if (obj.message) {
		return extractText(obj.message);
	}
	if (obj.delta) {
		return extractText(obj.delta);
	}
	if (obj.candidates && Array.isArray(obj.candidates) && obj.candidates.length > 0) {
		return extractText(obj.candidates[0]);
	}
	if (obj.content) {
		return extractText(obj.content);
	}
	if (obj.parts && Array.isArray(obj.parts) && obj.parts.length > 0) {
		return extractText(obj.parts[0]);
	}

	return '';
}

async function streamAiResponseToTelegram(
	bot: TelegramExecutionContext,
	env: Env,
	modelId: string,
	messages: any[],
	task: any,
): Promise<string> {
	const botApi = new TelegramApi();
	const draftResponse = await botApi.sendMessage(`https://api.telegram.org/bot${task.token}`, {
		chat_id: task.chatId,
		text: 'Thinking...',
		parse_mode: 'HTML',
	});
	const draftJson = (await draftResponse.json()) as { ok: boolean; result: { message_id: number } };
	const draftId = draftJson.result.message_id;

	let streamContent = '';
	let lastUpdate = Date.now();

	try {
		const aiResponse = await customRunWithTools(
			env.AI,
			modelId,
			{
				messages,
				tools: [fetchTool],
			},
			{ streamFinalResponse: true },
		);

		const stream = aiResponse as ReadableStream;
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split('\n');

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') {
						break;
					}
					try {
						const parsed = JSON.parse(data);
						const text = extractText(parsed);
						streamContent += text;
					} catch {
						// Ignore malformed JSON chunks
					}
				}
			}

			// Update Telegram every 2 seconds to avoid rate limits
			if (Date.now() - lastUpdate > 2000 && streamContent.trim()) {
				const currentContent = streamContent;
				bot.streamReply(await markdownToHtml(currentContent + '...'), draftId, 'HTML').catch((e) => console.error('Streaming error:', e));
				lastUpdate = Date.now();
			}
		}
	} catch (e) {
		console.error('Error reading AI stream:', e);
	}

	// Send final response (blocking)
	await bot.streamReply(await markdownToHtml(streamContent), draftId, 'HTML', {}, true);
	return streamContent;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const bot = new TelegramBot(''); // Token not used for setWebhook in this context

		if (request.method === 'POST') {
			try {
				const task = (await request.json()) as any;
				const instance = await env.AI_WORKFLOW.create({ params: task });
				return new Response(JSON.stringify({ id: instance.id }), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (e) {
				return new Response(String(e), { status: 500 });
			}
		}
		return new Response('AI Workflow Worker');
	},
};
