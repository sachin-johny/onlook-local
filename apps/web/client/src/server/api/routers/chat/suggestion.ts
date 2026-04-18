import { initModel, SUGGESTION_SYSTEM_PROMPT } from '@onlook/ai';
import { conversations } from '@onlook/db';
import type { ChatSuggestion } from '@onlook/models';
import { LLMProvider, OPENROUTER_MODELS } from '@onlook/models';
import { ChatSuggestionsSchema } from '@onlook/models/chat';
import { convertToModelMessages, generateObject } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../../trpc';

export const suggestionsRouter = createTRPCRouter({
    generate: protectedProcedure
        .input(z.object({
            conversationId: z.string(),
            messages: z.array(z.object({
                role: z.enum(['user', 'assistant', 'system']),
                content: z.string(),
            })),
        }))
        .mutation(async ({ ctx, input }) => {
            let suggestions: ChatSuggestion[];

            try {
                const { model, headers } = initModel({
                    provider: LLMProvider.OPENROUTER,
                    model: OPENROUTER_MODELS.OPEN_AI_GPT_5_NANO,
                });
                const { object } = await generateObject({
                    model,
                    headers,
                    schema: ChatSuggestionsSchema,
                    messages: [
                        {
                            role: 'system',
                            content: SUGGESTION_SYSTEM_PROMPT,
                        },
                        ...convertToModelMessages(
                            input.messages.map((m) => ({
                                role: m.role,
                                parts: [{ type: 'text', text: m.content }],
                            })),
                        ),
                        {
                            role: 'user',
                            content:
                                'Based on our conversation, what should I work on next to improve this page? Provide 3 specific, actionable suggestions. These should be realistic and achievable. Return the suggestions as a JSON object. DO NOT include any other text.',
                        },
                    ],
                    maxOutputTokens: 10000,
                });
                suggestions = object.suggestions satisfies ChatSuggestion[];
            } catch (error) {
                console.error('Error generating suggestions:', error);
                suggestions = [
                    {
                        title: 'Review Layout Structure',
                        prompt: 'Audit the current page structure and identify one section to simplify or reorganize for better readability.',
                    },
                    {
                        title: 'Improve Primary Action',
                        prompt: 'Refine the primary call-to-action so users can understand the next step within 3 seconds of landing on the page.',
                    },
                    {
                        title: 'Polish Visual Hierarchy',
                        prompt: 'Adjust typography, spacing, and contrast in one area to make the most important content stand out more clearly.',
                    },
                ];
            }

            try {
                await ctx.db.update(conversations).set({
                    suggestions,
                }).where(eq(conversations.id, input.conversationId));
            } catch (error) {
                console.error('Error updating conversation suggestions:', error);
            }
            return suggestions;
        }),
});
