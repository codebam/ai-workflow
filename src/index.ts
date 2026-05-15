import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { TelegramBot, TelegramExecutionContext, markdownToHtml, fetchTool, PartialTelegramUpdate } from '@codebam/cf-workers-telegram-bot';

export interface Task {
	type: 'code' | 'message' | 'business_message' | 'photo' | 'gen_photo' | 'voice' | 'tool_call';
	updateType?: string;
	updateId?: number;
	guestQueryId?: string;
	businessConnectionId?: string;
	prompt: string;
	userId?: number;
	senderId?: number;
	chatId?: string;
	threadId?: number;
	history?: { role: string; content: string }[];
	modelId?: string;
	fileId?: string;
	systemPrompt?: string;
	telegramToken?: string;
	tools?: Record<string, unknown>[];
	stream?: boolean;
}

export class AIWorkflow extends WorkflowEntrypoint<Env, Task> {
		async run(event: WorkflowEvent<Task>) {
		const task = event.payload;
		const env = this.env;

		const token = task.telegramToken || (env as unknown as { SECRET_TELEGRAM_API_TOKEN: string }).SECRET_TELEGRAM_API_TOKEN;
		if (!token) {
			throw new Error('Telegram token missing in task and environment');
		}

		const bot = new TelegramBot(token);
		const dummyUpdate: PartialTelegramUpdate = {
			update_id: 0
		};

		const chatId = task.chatId ? parseInt(task.chatId) : (task.userId || 0);
		const senderId = task.senderId || task.userId || 0;

		if (task.updateType === 'guest_message') {
			dummyUpdate.guest_message = {
				message_id: 0,
				from: { id: senderId, is_bot: false, first_name: 'User' } as unknown as any,
				chat: { id: chatId, type: 'private' } as unknown as any,
				date: Math.floor(Date.now() / 1000),
				text: task.prompt,
				guest_query_id: task.guestQueryId || ''
			};
		} else if (task.updateType === 'business_message') {
			dummyUpdate.business_message = {
				message_id: 0,
				from: { id: senderId, is_bot: false, first_name: 'User' } as unknown as any,
				chat: { id: chatId, type: 'private' } as unknown as any,
				date: Math.floor(Date.now() / 1000),
				text: task.prompt,
				business_connection_id: task.businessConnectionId || ''
			};
		} else {
			dummyUpdate.message = {
				message_id: 0,
				from: { id: senderId, is_bot: false, first_name: 'User' } as unknown as any,
				chat: { id: chatId, type: 'private' } as unknown as any,
				date: Math.floor(Date.now() / 1000),
				text: task.prompt,
				message_thread_id: task.threadId
			};
		}
		const tctx = new TelegramExecutionContext(bot, dummyUpdate as unknown as any);

		const messages: Record<string, any>[] = [
			{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
			...(task.history || []),
			{ role: 'user', content: task.prompt }
		];

		const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

		try {
			await streamAiResponseToTelegram(tctx, env, modelId, messages, task);
		} catch (e) {
			console.error('Error in workflow execution:', e);
			await tctx.reply('Error: ' + String(e));
		}
	}
}


async function customRunWithTools(ai: Ai, model: string, input: { messages: Record<string, any>[], tools?: Record<string, any>[] }, config: { streamFinalResponse: boolean }) {
	const messages = [...input.messages];
	const tools = input.tools || [];
	const isGemini = model.includes('google/gemini');

	const cfTools = tools.map((t: Record<string, any>) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));

	const runModel = async (msgs: any[], stream: boolean) => {
		if (isGemini) {
			const systemMessage = msgs.find((m) => m.role === 'system');
			const otherMessages = msgs.filter((m) => m.role !== 'system');
			const geminiInput: Record<string, any> = {
				contents: otherMessages.map((m) => ({
					role: m.role === 'assistant' ? 'model' : 'user',
					parts: [{ text: m.content }]
				})),
				stream
			};
			if (systemMessage) {
				geminiInput.system_instruction = {
					parts: [{ text: systemMessage.content }]
				};
			}
			return await ai.run(model, geminiInput);
		}
		return await ai.run(model, { messages: msgs, tools: cfTools.length > 0 ? cfTools : undefined, stream });
	};

	if (cfTools.length === 0 || isGemini || config.streamFinalResponse) {
		return await runModel(messages, config.streamFinalResponse);
	}

	const response = (await runModel(messages, false)) as Record<string, any>;

	// FIX: Robustly extract from BOTH Cloudflare formats (Standard and OpenAI-compatible)
	let toolCalls: any[] = [];
	if (response?.tool_calls) {
		toolCalls = [...response.tool_calls];
	} else if (response?.choices?.[0]?.message?.tool_calls) {
		toolCalls = [...response.choices[0].message.tool_calls];
	}

	let responseText = response?.response || response?.choices?.[0]?.message?.content || '';

	// GEMMA FALLBACK: Catch raw tokens if native interception fails
	if (toolCalls.length === 0 && responseText.includes('<|tool_call>')) {
		// Use [\s\S]*? to safely match across multiple lines if Gemma formats the JSON nicely
		const gemmaRegex = /<\|tool_call>\s*call:\s*([a-zA-Z0-9_]+)([\s\S]*?)<tool_call\|>/g;
		let match;
		while ((match = gemmaRegex.exec(responseText)) !== null) {
			let name = match[1].trim();
			if (name === 'http_fetch' || name === 'api_fetch') name = 'fetch'; 
			
			let argsString = match[2].trim();
			// Sanitize Gemma's malformed JSON syntax to ensure JSON.parse doesn't throw
			argsString = argsString.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
								   .replace(/:\s*'([^']*)'/g, ': "$1"');
			
			toolCalls.push({
				id: `call_${Math.random().toString(36).substring(2, 9)}`,
				type: 'function',
				function: { name, arguments: argsString }
			});
		}
		// Strip the raw tokens from the visible response so the user never sees them
		responseText = responseText.replace(/<\|tool_call>[\s\S]*?<tool_call\|>/g, '').trim();
	}

	if (toolCalls.length > 0) {
		const normalizedToolCalls = toolCalls.map((call: Record<string, any>, index: number) => {
			const name = call.name || (call.function && call.function.name);
			let args = call.arguments || (call.function && call.function.arguments);
			if (typeof args !== 'string') {
				try { args = JSON.stringify(args); } catch(e) { args = '{}'; }
			}
			return {
				id: call.id || `call_${Math.random().toString(36).substring(2, 9)}_${index}`,
				type: 'function',
				function: { name, arguments: args }
			};
		});

		messages.push({ 
			role: 'assistant', 
			content: responseText, 
			tool_calls: normalizedToolCalls 
		});
		
		for (const call of normalizedToolCalls) {
			const toolName = call.function.name;
			const toolId = call.id;
			const toolArgsString = call.function.arguments;
			const tool = tools.find((t: any) => t.name === toolName);
			
			if (tool && tool.function) {
				try {
					let parsedArgs;
					try { parsedArgs = JSON.parse(toolArgsString); } catch(e) { parsedArgs = toolArgsString; }
					const result = await tool.function(parsedArgs);
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(result) });
				} catch (e) {
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(e) });
				}
			} else {
				messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: 'Tool not found' });
			}
		}
		
		return await ai.run(model, {
			messages,
			tools: cfTools,
			stream: config.streamFinalResponse
		});
	}

	if (config.streamFinalResponse) {
		return await ai.run(model, { messages, stream: true });
	}

	return response;
}

/**
 * Robustly extract text from various AI response formats.
 * Handles OpenAI, Cloudflare, and Google Gemini structures.
 */
function extractText(obj: any): string {
	if (typeof obj === 'string') return obj;
	if (typeof obj !== 'object' || obj === null) return '';

	// Direct fields
	if (typeof obj.response === 'string') return obj.response;
	if (typeof obj.text === 'string') return obj.text;
	if (typeof obj.content === 'string') return obj.content;
	if (typeof obj.delta === 'string') return obj.delta;

	// Nested fields
	if (obj.choices && Array.isArray(obj.choices) && obj.choices.length > 0) {
		return extractText(obj.choices[0]);
	}
	if (obj.message) return extractText(obj.message);
	if (obj.delta) return extractText(obj.delta);
	if (obj.candidates && Array.isArray(obj.candidates) && obj.candidates.length > 0) {
		return extractText(obj.candidates[0]);
	}
	if (obj.content) return extractText(obj.content);
	if (obj.parts && Array.isArray(obj.parts) && obj.parts.length > 0) {
		return extractText(obj.parts[0]);
	}

	return '';
}

async function streamAiResponseToTelegram(
	bot: TelegramExecutionContext,
	env: Env,
	model: string,
	messages: any[],
	task: Task
): Promise<string> {
	// Send an initial draft to show we're thinking
	const draftId = task.updateId || 0;
	await bot.streamReply('...', draftId, 'HTML');

	const aiResponse = await customRunWithTools(
		env.AI as any,
		model as any,
		{
			messages: messages as any,
			tools: (task.type === 'tool_call' || (task.tools && task.tools.length > 0)) ? [fetchTool] : []
		},
		{
			streamFinalResponse: true
		}
	);

	if (!(aiResponse instanceof ReadableStream)) {
		const content = extractText(aiResponse);
		if (!content.trim()) {
			throw new Error('AI returned an empty response');
		}
		await bot.reply(await markdownToHtml(content), 'HTML');
		return content;
	}

	const reader = aiResponse.getReader();
	const decoder = new TextDecoder();
	let streamContent = '';
	let buffer = '';
	let streamFinished = false;
	let lastReportedContent = '';

	// Start a non-blocking reporter loop
	const reporter = (async () => {
		while (!streamFinished) {
			if (streamContent !== lastReportedContent && streamContent.trim()) {
				const html = await markdownToHtml(streamContent);
				if (html !== lastReportedContent) {
					await bot.streamReply(html, draftId, 'HTML');
					lastReportedContent = html;
				}
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
	})();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmedLine = line.trim();
				if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;

				if (trimmedLine.startsWith('data: ')) {
					try {
						const data = JSON.parse(trimmedLine.slice(6));
						streamContent += extractText(data);
					} catch {
						streamContent += trimmedLine.slice(6);
					}
				} else {
					streamContent += trimmedLine;
				}
			}
		}
	} finally {
		streamFinished = true;
		await reporter;
	}

	await bot.streamReply(await markdownToHtml(streamContent), draftId, 'HTML', {}, true);

	return streamContent;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'POST') {
			try {
				const task = (await request.json()) as Task;

				if (task.stream) {
					const messages: any[] = [
						{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
						...(task.history || []),
						{ role: 'user', content: task.prompt }
					];

					const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

					const aiResponse = await customRunWithTools(
						env.AI as any,
						modelId as any,
						{
							messages: messages as any,
							tools: (task.type === 'tool_call' || (task.tools && task.tools.length > 0)) ? [fetchTool] : []
						},
						{
							streamFinalResponse: true
						}
					);

					if (aiResponse instanceof ReadableStream) {
						return new Response(aiResponse, {
							headers: {
								'Content-Type': 'text/event-stream',
								'Cache-Control': 'no-cache',
								Connection: 'keep-alive'
							}
						});
					} else {
						return Response.json(aiResponse);
					}
				}

				const instance = await env.AI_WORKFLOW.create({ params: task });
				return new Response(JSON.stringify({ id: instance.id }), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (e) {
				return new Response(String(e), { status: 500 });
			}
		}
		return new Response('AI Workflow Worker');
	}
};
