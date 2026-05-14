/* eslint-disable @typescript-eslint/no-explicit-any */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { TelegramBot, TelegramExecutionContext } from '@codebam/cf-workers-telegram-bot';
import { marked } from 'marked';
export class AIWorkflow extends WorkflowEntrypoint {
    async run(event, step) {
        const task = event.payload;
        const env = this.env;
        const token = task.telegramToken || env.SECRET_TELEGRAM_API_TOKEN;
        if (!token) {
            throw new Error('Telegram token missing in task and environment');
        }
        const bot = new TelegramBot(token);
        const dummyUpdate = {
            update_id: 0,
        };
        if (task.updateType === 'guest_message') {
            dummyUpdate.guest_message = {
                message_id: 0,
                from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
                chat: { id: task.userId || 0, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: task.prompt,
                guest_query_id: task.guestQueryId,
            };
        }
        else if (task.updateType === 'business_message') {
            dummyUpdate.business_message = {
                message_id: 0,
                from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
                chat: { id: task.userId || 0, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: task.prompt,
                business_connection_id: task.businessConnectionId,
            };
        }
        else {
            dummyUpdate.message = {
                message_id: 0,
                from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
                chat: { id: task.userId || 0, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: task.prompt,
                message_thread_id: task.threadId,
            };
        }
        const tctx = new TelegramExecutionContext(bot, dummyUpdate);
        await step.do('process-ai-task', async () => {
            try {
                const messages = [
                    { role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
                    ...(task.history || []),
                    { role: 'user', content: task.prompt },
                ];
                const modelId = task.modelId || '@cf/google/gemma-4-26b-a4b-it';
                await streamAiResponse(tctx, env, modelId, messages, task);
            }
            catch (e) {
                console.error('Error in workflow process-ai-task:', e);
                await tctx.reply(`Error: ${String(e)}`);
                throw e;
            }
        });
    }
}
async function markdownToHtml(s) {
    const parsed = (await marked.parse(s));
    const allowedTags = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'span'];
    const tagStack = [];
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
                    }
                    else {
                        tagStack.push(tagName);
                        if (tagName === 'a') {
                            const hrefMatch = /href="([^"]*)"/i.exec(fullTag);
                            result += hrefMatch ? `<a href="${hrefMatch[1]}">` : '<a>';
                        }
                        else {
                            result += `<${tagName}>`;
                        }
                    }
                    i += fullTag.length;
                    continue;
                }
                else if (tagName === 'p') {
                    if (isClosing) {
                        result += '\n\n';
                    }
                    i += fullTag.length;
                    continue;
                }
                else if (tagName === 'br') {
                    result += '\n';
                    i += fullTag.length;
                    continue;
                }
                else if (tagName === 'li') {
                    if (!isClosing) {
                        result += '• ';
                    }
                    else {
                        result += '\n';
                    }
                    i += fullTag.length;
                    continue;
                }
            }
        }
        if (parsed[i] === '<') {
            result += '&lt;';
        }
        else if (parsed[i] === '>') {
            result += '&gt;';
        }
        else if (parsed[i] === '&') {
            const entityMatch = /^&[a-z0-9#]+;/i.exec(parsed.slice(i));
            if (entityMatch) {
                result += entityMatch[0];
                i += entityMatch[0].length;
                continue;
            }
            result += '&amp;';
        }
        else {
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
async function streamAiResponse(bot, env, model, messages, task) {
    const currentMessages = [...messages];
    let fullResponse = '';
    if (task.type === 'tool_call') {
        const tools = task.tools || [];
        for (let i = 0; i < 5; i++) {
            const response = (await env.AI.run(model, {
                messages: currentMessages,
                tools: tools.map((t) => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                    },
                })),
            }, { gateway: { id: 'default' } }));
            const toolCalls = response.tool_calls || response.choices?.[0]?.message?.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                currentMessages.push({
                    role: 'assistant',
                    content: response.choices?.[0]?.message?.content || null,
                    tool_calls: toolCalls,
                });
                for (const toolCall of toolCalls) {
                    const name = toolCall.name || toolCall.function?.name;
                    let args = toolCall.arguments || toolCall.function?.arguments;
                    if (typeof args === 'string') {
                        try {
                            args = JSON.parse(args);
                        }
                        catch {
                            /* ignore */
                        }
                    }
                    const toolDef = tools.find((t) => t.name === name);
                    if (toolDef && toolDef.run) {
                        try {
                            const result = await toolDef.run(args);
                            currentMessages.push({
                                role: 'tool',
                                name: name,
                                tool_call_id: toolCall.id,
                                content: typeof result === 'string' ? result : JSON.stringify(result),
                            });
                        }
                        catch (e) {
                            currentMessages.push({
                                role: 'tool',
                                name: name,
                                tool_call_id: toolCall.id,
                                content: `Error executing tool: ${String(e)}`,
                            });
                        }
                    }
                }
            }
            else {
                fullResponse = response.response || response.choices?.[0]?.message?.content || '';
                break;
            }
        }
    }
    const response = await env.AI.run(model, {
        messages: fullResponse ? [...currentMessages, { role: 'assistant', content: fullResponse }] : currentMessages,
        stream: true,
    }, { gateway: { id: 'default' } });
    if (!(response instanceof ReadableStream)) {
        const data = response;
        const content = data.response || data.choices?.[0]?.message?.[0]?.content || data.choices?.[0]?.message?.content || '';
        await bot.reply(await markdownToHtml(content), 'HTML');
        return content;
    }
    const reader = response.getReader();
    const decoder = new TextDecoder();
    let streamContent = '';
    let lastUpdate = 0;
    let messageId;
    let buffer = '';
    if (bot.update_type !== 'guest_message') {
        const res = await bot.reply('<i>Thinking...</i>', 'HTML');
        if (res && res.status === 200) {
            const json = (await res.json());
            if (json.ok && json.result?.message_id) {
                messageId = json.result.message_id;
            }
        }
    }
    else {
        await bot.sendTyping();
    }
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
                    const data = JSON.parse(trimmedLine.slice(6));
                    const content = data.choices?.[0]?.delta?.content ?? data.response ?? '';
                    if (content) {
                        streamContent += content;
                        if (messageId && Date.now() - lastUpdate > 1500) {
                            try {
                                await bot.api.editMessageText(bot.bot.api.toString(), {
                                    chat_id: bot.chatId,
                                    message_id: messageId,
                                    text: await markdownToHtml(streamContent + '...'),
                                    parse_mode: 'HTML',
                                });
                            }
                            catch {
                                /* ignore */
                            }
                            lastUpdate = Date.now();
                        }
                    }
                }
                catch {
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
                parse_mode: 'HTML',
            });
        }
        catch {
            await bot.reply(finalHtml, 'HTML');
        }
    }
    else {
        await bot.reply(finalHtml, 'HTML');
    }
    return streamContent;
}
export default {
    async fetch(request, env) {
        if (request.method === 'POST') {
            try {
                const task = (await request.json());
                const instance = await env.AI_WORKFLOW.create({ params: task });
                return new Response(JSON.stringify({ id: instance.id }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            catch (e) {
                return new Response(String(e), { status: 500 });
            }
        }
        return new Response('AI Workflow Worker');
    },
};
