/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	HistoryManager,
	fetchTool,
	wikipediaTool,
	streamAiResponseToTelegram,
	createMockTelegramExecutionContext,
} from '@codebam/cf-workers-telegram-bot';

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

		console.log('[Workflow] AIWorkflow execution started. Payload:', JSON.stringify(task));

		const config = await step.do('Initialize Context', async () => {
			console.log('Step [Initialize Context]: Started.');
			try {
				const messages = [
					{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
					...(task.history || []),
					{ role: 'user', content: task.prompt },
				];
				const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';
				const output = { messages, modelId };
				console.log('Step [Initialize Context]: Succeeded. Config:', JSON.stringify(output));
				return output;
			} catch (error) {
				console.error('Step [Initialize Context]: Failed with error:', error);
				throw error;
			}
		});

		let stepResult: { content: string; toolExecutions?: any[] };

		try {
			stepResult = await step.do('Stream AI Response', async () => {
				console.log('Step [Stream AI Response]: Started execution for prompt:', task.prompt);
				const tctx = createMockTelegramExecutionContext(task);
				try {
					const toolExecutions: any[] = [];

					const wrapTool = (originalTool: any) => {
						return {
							...originalTool,
							function: async (args: any) => {
								console.log(`[Tool Call] Executing ${originalTool.name} with args:`, JSON.stringify(args));
								try {
									const result = await originalTool.function(args);
									const resultStr = String(result);
									toolExecutions.push({
										tool: originalTool.name,
										arguments: args,
										status: 'success',
										output: resultStr.length > 1000 ? resultStr.slice(0, 1000) + '... (truncated)' : resultStr,
									});
									console.log(`[Tool Call] ${originalTool.name} completed successfully.`);
									return result;
								} catch (error) {
									toolExecutions.push({
										tool: originalTool.name,
										arguments: args,
										status: 'error',
										error: String(error),
									});
									console.error(`[Tool Call] ${originalTool.name} failed with error:`, error);
									throw error;
								}
							},
						};
					};

					const wrappedFetch = wrapTool(fetchTool);
					const wrappedWikipedia = wrapTool(wikipediaTool);

					const responseContent = await streamAiResponseToTelegram(tctx, env.AI, config.modelId, config.messages, task, [
						wrappedFetch,
						wrappedWikipedia,
					]);

					console.log('Step [Stream AI Response]: Succeeded. Generated response length:', responseContent?.length || 0);
					if (toolExecutions.length > 0) {
						console.log('Step [Stream AI Response]: Captured tool executions:', JSON.stringify(toolExecutions));
					}

					return {
						content: responseContent,
						toolExecutions: toolExecutions.length > 0 ? toolExecutions : undefined,
					};
				} catch (error) {
					console.error('Step [Stream AI Response]: Failed with error:', error);
					throw error;
				}
			});
		} catch (e) {
			console.error('[Workflow] Error during streaming step execution:', e);
			try {
				const tctx = createMockTelegramExecutionContext(task);
				const errorMsg = 'Error: ' + String(e);
				if (errorMsg.trim()) {
					await tctx.reply(errorMsg);
				}
			} catch (replyError) {
				console.error('[Workflow] Failed to send error notification to Telegram:', replyError);
			}
			throw e; // Mark the workflow as failed
		}

		if (task.userId && stepResult.content) {
			await step.do('Save Conversation History', async () => {
				console.log('Step [Save Conversation History]: Started for user:', task.userId);
				try {
					const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
					await historyManager.addMessage(task.userId, task.prompt, stepResult.content, task.threadId);
					console.log('Step [Save Conversation History]: Succeeded.');
				} catch (error) {
					console.error('Step [Save Conversation History]: Failed with error:', error);
					throw error;
				}
			});
		} else {
			console.log('[Workflow] Save Conversation History step skipped. userId:', task.userId, 'hasContent:', !!stepResult.content);
		}

		console.log('[Workflow] AIWorkflow execution completed successfully.');
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
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
