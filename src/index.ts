/* eslint-disable @typescript-eslint/no-explicit-any */
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { TelegramBot, TelegramExecutionContext } from '@codebam/cf-workers-telegram-bot';
import { marked } from 'marked';

export interface Task {
	type: 'code' | 'message' | 'business_message' | 'photo' | 'gen_photo' | 'voice' | 'tool_call';
	updateType?: string;
	guestQueryId?: string;
	businessConnectionId?: string;
	prompt: string;
	userId?: number;
	threadId?: number;
	history?: { role: string; content: string }[];
	modelId?: string;
	fileId?: string;
	systemPrompt?: string;
	telegramToken?: string;
	tools?: any[];
	stream?: boolean;
}

export class AIWorkflow extends WorkflowEntrypoint<Env, Task> {
	async run(event: WorkflowEvent<Task>, step: WorkflowStep) {
		const task = event.payload;
		const env = this.env;

		const token = task.telegramToken || (env as any).SECRET_TELEGRAM_API_TOKEN;
		if (!token) {
			throw new Error('Telegram token missing in task and environment');
		}

		const bot = new TelegramBot(token);
		const dummyUpdate: any = {
			update_id: 0
		};

		if (task.updateType === 'guest_message') {
			dummyUpdate.guest_message = {
				message_id: 0,
				from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
				chat: { id: task.userId || 0, type: 'private' },
				date: Math.floor(Date.now() / 1000),
				text: task.prompt,
				guest_query_id: task.guestQueryId
			};
		} else if (task.updateType === 'business_message') {
			dummyUpdate.business_message = {
				message_id: 0,
				from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
				chat: { id: task.userId || 0, type: 'private' },
				date: Math.floor(Date.now() / 1000),
				text: task.prompt,
				business_connection_id: task.businessConnectionId
			};
		} else {
			dummyUpdate.message = {
				message_id: 0,
				from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
				chat: { id: task.userId || 0, type: 'private' },
				date: Math.floor(Date.now() / 1000),
				text: task.prompt,
				message_thread_id: task.threadId
			};
		}
		const tctx = new TelegramExecutionContext(bot, dummyUpdate as any);

		await step.do('process-ai-task', async () => {
			try {
				const messages: any[] = [
					{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
					...(task.history || []),
					{ role: 'user', content: task.prompt }
				];

				const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

				await streamAiResponseToTelegram(tctx, env, modelId, messages, task);
			} catch (e) {
				console.error('Error in workflow process-ai-task:', e);
				await tctx.reply(`Error: ${String(e)}`);
				throw e;
			}
		});
	}
}

async function markdownToHtml(s: string): Promise<string> {
	const parsed = (await marked.parse(s)) as string;
	const allowedTags = [
		'b',
		'strong',
		'i',
		'em',
		'u',
		'ins',
		's',
		'strike',
		'del',
		'code',
		'pre',
		'a',
		'blockquote',
		'span'
	];
	const tagStack: string[] = [];
	let result = '';
	let i = 0;

	while (i < parsed.length) {
		if (parsed[i] === '<') {
			const tagMatch = /^<\/?([a-z1-6]+)(?:\s+[^>]*)?>/i.exec(parsed.slice(i));
			if (tagMatch) {
				const fullTag = tagMatch[0];
				const tagName = tagMatch[1].toLowerCase();
				const isClosing = fullTag.startsWith('</');

				if (allowedTags.includes(tagName)) {
					if (isClosing) {
						if (tagStack.includes(tagName)) {
							while (tagStack.length > 0) {
								const top = tagStack.pop();
								if (top) {
									result += `</${top}>`;
									if (top === tagName) {
										break;
									}
								}
							}
						}
					} else {
						tagStack.push(tagName);
						if (tagName === 'a') {
							const hrefMatch = /href="([^"]*)"/i.exec(fullTag);
							result += hrefMatch ? `<a href="${hrefMatch[1]}">` : '<a>';
						} else {
							result += `<${tagName}>`;
						}
					}
					i += fullTag.length;
					continue;
				} else if (tagName === 'p') {
					if (isClosing) {
						result += '\n\n';
					}
					i += fullTag.length;
					continue;
				} else if (tagName === 'br') {
					result += '\n';
					i += fullTag.length;
					continue;
				} else if (tagName === 'li') {
					if (!isClosing) {
						result += '• ';
					} else {
						result += '\n';
					}
					i += fullTag.length;
					continue;
				} else if (/^h[1-6]$/.test(tagName)) {
					if (isClosing) {
						result += '</b>\n\n';
					} else {
						result += '<b>';
					}
					i += fullTag.length;
					continue;
				} else {
					i += fullTag.length;
					continue;
				}
			}
		}

		if (parsed[i] === '<') {
			result += '&lt;';
		} else if (parsed[i] === '>') {
			result += '&gt;';
		} else if (parsed[i] === '&') {
			const entityMatch = /^&[a-z0-9#]+;/i.exec(parsed.slice(i));
			if (entityMatch) {
				result += entityMatch[0];
				i += entityMatch[0].length;
				continue;
			}
			result += '&amp;';
		} else {
			result += parsed[i];
		}
		i++;
	}

	while (tagStack.length > 0) {
		const top = tagStack.pop();
		if (top) {
			result += `</${top}>`;
		}
	}

	return result.trim();
}

const fetchTool = {
	name: 'fetch',
	description:
		'Make an HTTP request to fetch a website or API, returning the HTML or JSON. You MUST use this tool when the user asks to fetch a URL, visit a website, or make a GET request, instead of writing code.',
	parameters: {
		type: 'object',
		properties: {
			url: { type: 'string', description: 'The URL to fetch' },
			method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
			headers: { type: 'object', description: 'HTTP headers to include in the request' },
			body: { type: 'string', description: 'The request body' }
		},
		required: ['url']
	},
	function: async ({
		url,
		method,
		headers,
		body
	}: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	}) => {
		try {
			const res = await fetch(url, {
				method: method || 'GET',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Cloudflare Worker Telegram Bot)',
					...headers
				},
				body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
			});
			const text = await res.text();
			return text.slice(0, 10000);
		} catch (e) {
			return `Error executing fetch: ${String(e)}`;
		}
	}
};

async function customRunWithTools(ai: any, model: string, input: any, config: any) {
	const messages = [...input.messages];
	const tools = input.tools || [];

	// 1. RESTORED: Cloudflare API requires the strict OpenAI format wrapper
	const cfTools = tools.map((t: any) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));

	if (cfTools.length === 0) {
		return await ai.run(model, {
			messages,
			stream: config.streamFinalResponse
		});
	}

	const response = await ai.run(model, {
		messages,
		tools: cfTools,
		stream: false
	}) as any;

	if (response && response.tool_calls && response.tool_calls.length > 0) {
		// 2. FIX: Normalize the tool calls to prevent 500 Schema Errors
		// Cloudflare sometimes returns arguments as an object or omits the ID. 
		// We MUST ensure it matches the strict OpenAI format for the history array.
		const normalizedToolCalls = response.tool_calls.map((call: any, index: number) => {
			const name = call.name || (call.function && call.function.name);
			let args = call.arguments || (call.function && call.function.arguments);
			
			// History expects arguments to be a JSON string, not a raw object
			if (typeof args !== 'string') {
				try { args = JSON.stringify(args); } catch(e) { args = '{}'; }
			}
			
			return {
				// Generate a fallback ID if Cloudflare omitted it, required to map the tool response
				id: call.id || `call_${Math.random().toString(36).substring(2, 9)}_${index}`,
				type: 'function',
				function: {
					name: name,
					arguments: args
				}
			};
		});

		// Push the normalized assistant intent to history
		messages.push({ 
			role: 'assistant', 
			content: response.response || '', 
			tool_calls: normalizedToolCalls 
		});
		
		for (const call of normalizedToolCalls) {
			const toolName = call.function.name;
			const toolId = call.id; // Now guaranteed to exist
			const toolArgsString = call.function.arguments;
			
			const tool = tools.find((t: any) => t.name === toolName);
			
			if (tool && tool.function) {
				try {
					const parsedArgs = JSON.parse(toolArgsString);
					const result = await tool.function(parsedArgs);
					// Push the tool result, properly linked by ID
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(result) });
				} catch (e) {
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(e) });
				}
			} else {
				messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: 'Tool not found' });
			}
		}
		
		// 3. Run the final inference with the perfectly formatted history
		return await ai.run(model, {
			messages,
			tools: cfTools,
			stream: config.streamFinalResponse
		});
	}

	if (config.streamFinalResponse) {
		return await ai.run(model, {
			messages,
			stream: true
		});
	}

	return response;
}

async function streamAiResponseToTelegram(
	bot: TelegramExecutionContext,
	env: Env,
	model: string,
	messages: any[],
	task: Task
): Promise<string> {
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
		const content =
			(aiResponse as any).response || (aiResponse as any).choices?.[0]?.message?.content || '';
		await bot.reply(await markdownToHtml(content), 'HTML');
		return content;
	}

	const reader = aiResponse.getReader();
	const decoder = new TextDecoder();
	let streamContent = '';
	let lastUpdate = 0;
	let messageId: number | undefined;
	let buffer = '';

	await bot.sendTyping();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine || trimmedLine === 'data: [DONE]') {
				continue;
			}

			if (trimmedLine.startsWith('data: ')) {
				try {
					const data = JSON.parse(trimmedLine.slice(6)) as any;
					const content = data.choices?.[0]?.delta?.content ?? data.response ?? '';

					if (content) {
						streamContent += content;

						if (!messageId && streamContent.trim() && bot.update_type !== 'guest_message') {
							const res = await bot.reply(await markdownToHtml(streamContent), 'HTML');
							if (res && res.status === 200) {
								const json = (await res.json()) as any;
								if (json.ok && json.result?.message_id) {
									messageId = json.result.message_id;
									lastUpdate = Date.now();
								}
							}
						} else if (messageId && Date.now() - lastUpdate > 1500) {
							try {
								await bot.api.editMessageText(bot.bot.api.toString(), {
									chat_id: bot.chatId,
									message_id: messageId,
									text: await markdownToHtml(streamContent + '...'),
									parse_mode: 'HTML'
								});
							} catch {
								/* ignore */
							}
							lastUpdate = Date.now();
						}
					}
				} catch {
					/* ignore */
				}
			}
		}
	}

	const finalHtml = await markdownToHtml(streamContent);

	if (messageId) {
		try {
			await bot.api.editMessageText(bot.bot.api.toString(), {
				chat_id: bot.chatId,
				message_id: messageId,
				text: finalHtml,
				parse_mode: 'HTML'
			});
		} catch {
			await bot.reply(finalHtml, 'HTML');
		}
	} else {
		await bot.reply(finalHtml, 'HTML');
	}

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
