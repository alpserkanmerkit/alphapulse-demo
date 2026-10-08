import { GoogleGenAI } from '@google/genai';
import { withRetry } from '../../shared/retry';
import { requestQuantForecast } from './quantClient';
import { toAiRouteError, withAiTimeout } from './aiRuntime';
import { isDemoMode } from '../demo/demoMode';
import { demoChatReply } from '../demo/demoAi';

const ORCHESTRATOR_SYSTEM_PROMPT = `You are AlphaPulse Orchestrator, an elite institutional financial advisor and AI routing system.

CRITICAL RULES YOU MUST FOLLOW:
1. INTERCEPTION (Profiling): If the user asks for investment advice or directional sentiment (e.g., "Should I buy Gold?", "Is it a good time to invest in BTC?"), DO NOT give an immediate answer.
   - You MUST first ask a brief clarifying question to understand their: (A) Risk Tolerance (Low/Medium/High) and (B) Estimated capital size/portfolio context.

2. DEVIL'S ADVOCATE MODE (Agent Bear): If the user states a very optimistic or bullish assumption (e.g., "Market is pumping, going all in", "Tech stocks will never fall"), you MUST act as the "Macro Bear".
   - Acknowledge their view, but immediately provide 3 macroeconomic or historical risks as to why their assumption might fail.
   - Explain a potential "Hedge" or contra-trade scenario.

3. QUANT MODE: If the user asks for pure numerical data (e.g., moving averages, standard deviation, volume), switch to a robotic, strictly analytical tone. Give the data objectively without emotional commentary.

4. ALIGNMENT (Once profiled): Once the user provides their risk profile and capital, synthesize a comprehensive answer combining the asset's current momentum, the "Devil's Advocate" risks, and a logical sizing strategy (e.g., "Given your moderate risk, a 5% allocation makes mathematical sense").

Tone: Professional, slightly skeptical, institutional. NEVER give guaranteed financial advice; use terms like "historical probability", "risk-adjusted", and "mathematical consensus".`;

export async function processAdvisoryChat(messages: { id?: string; role: string; text: string }[]): Promise<string> {
    if (isDemoMode()) return demoChatReply(messages[messages.length - 1]?.text ?? '');

    if (!process.env.GEMINI_API_KEY) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const lastMsg = messages[messages.length - 1]?.text?.toLowerCase() || '';

        if (lastMsg.includes('buy') || lastMsg.includes('invest') || lastMsg.includes('al')) {
            if (lastMsg.includes('risk')) {
                return '(Simulation) Understood. We will proceed with a medium-risk profile. Devil\'s advocate view: historical data suggests this rally may be overstretched, so phased entries remain more defensible. Do you want a more detailed breakdown?';
            }

            return '(Simulation) AlphaPulse Orchestrator: before discussing the asset, what are your portfolio size and risk tolerance (Low/Medium/High)? That context is required for a cautious analysis.';
        }

        return '(Simulation) AlphaPulse advisory mode is active. GEMINI_API_KEY is missing, so this is a default response.';
    }

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        let dynamicSystemPrompt = ORCHESTRATOR_SYSTEM_PROMPT;

        const lastUserMessage = messages[messages.length - 1]?.text || '';
        const tickerMatch = lastUserMessage.match(/\$([A-Z]+)/i) || lastUserMessage.match(/\b([A-Z]{3,5})\b/);

        if (tickerMatch) {
            const ticker = tickerMatch[1].toUpperCase();

            try {
                const quantResult = await requestQuantForecast<{ data?: unknown }>(
                    'long-term',
                    { ticker, risk_free_rate: 0.04 },
                    10000
                );

                if (quantResult.ok && quantResult.data.data) {
                    dynamicSystemPrompt += `\n\n[QUANT ENGINE INJECTION - CONFIDENTIAL]\nThe Python Quant Engine has provided the following DCF and Fama-French baseline target for the mentioned asset (${ticker}):\n${JSON.stringify(quantResult.data.data)}\nUse this mathematical truth (±5% bands) as the ultimate anchor. Explain this to the user professionally.`;
                } else if (!quantResult.ok) {
                    console.warn(`Quant Engine not reachable or failed. reason=${quantResult.reason}`);
                }
            } catch (err) {
                console.warn('Quant Engine not reachable or failed:', err);
            }
        }

        const filteredMessages = messages.filter((message) => message.id !== 'init').map((message) => ({
            role: message.role === 'model' ? 'model' : 'user',
            parts: [{ text: message.text }],
        }));

        const response = await withAiTimeout(
            withRetry(() => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: filteredMessages,
                config: {
                    systemInstruction: dynamicSystemPrompt,
                },
            })),
            30000,
            'Backend advisory chat timed out before the model responded.'
        );

        return response.text || 'No response received from AlphaPulse Brain.';
    } catch (error) {
        throw toAiRouteError(error, 'Backend advisory chat request failed.');
    }
}
