/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	HistoryManager,
	fetchTool,
	streamAiResponseToTelegram,
	createMockTelegramExecutionContext,
} from '@codebam/cf-workers-telegram-bot';

import { WorkflowEntrypoint, WorkflowEvent } from 'cloudflare:workers';

export interface Env {
	CONVERSATION_HISTORY: KVNamespace;
	R2: R2Bucket;
	AI: Ai;
	AI_WORKFLOW: Workflow;
}

export class AIWorkflow extends WorkflowEntrypoint<Env, any> {
	async run(event: WorkflowEvent<any>): Promise<void> {
		const task = event.payload;
		const env = this.env;

		const tctx = createMockTelegramExecutionContext(task);

		const messages = [
			{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
			...(task.history || []),
			{ role: 'user', content: task.prompt },
		];

		const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

		try {
			const content = await streamAiResponseToTelegram(tctx, env.AI, modelId, messages, task, [fetchTool]);
			if (task.userId && content) {
				const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
				await historyManager.addMessage(task.userId, task.prompt, content, task.threadId);
			}
		} catch (e) {
			console.error('Error in workflow execution:', e);
			try {
				const errorMsg = 'Error: ' + String(e);
				if (errorMsg.trim()) {
					await tctx.reply(errorMsg);
				}
			} catch (replyError) {
				console.error('Failed to send error reply to Telegram:', replyError);
			}
		}
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
