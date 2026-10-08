// Demo-mode AI responses: fixed sample text templates, no Gemini call, no randomness and no artificial delay.
// The same headline always yields the same response. Content is not investment advice.
import { Sentiment } from '../../types';

export const DEMO_AI_NOTICE = 'Demo mode: sample AI output from fixed text templates (no external AI call).';

const POSITIVE_WORDS = ['soars', 'record', 'approved', 'beats', 'surge', 'bullish', 'rally', 'extends', 'resilient', 'steady', 'steadies', 'improves', 'upside', 'expands', 'holds', 'inflows'];
const NEGATIVE_WORDS = ['crash', 'plunge', 'miss', 'fall', 'drop', 'ban', 'crisis', 'recession', 'trim', 'cuts', 'slump', 'weak'];

const ASSET_KEYWORDS: Array<[string, string[]]> = [
    ['nvidia', ['NVDA', 'NDX']],
    ['apple', ['AAPL', 'NDX']],
    ['tesla', ['TSLA']],
    ['microsoft', ['MSFT', 'NDX']],
    ['jpmorgan', ['JPM', 'SPX']],
    ['bitcoin', ['BTC', 'ETH']],
    ['ethereum', ['ETH', 'BTC']],
    ['oil', ['CL=F', 'SPX']],
    ['gold', ['GC=F', 'SPX']],
    ['euro', ['EURUSD']],
    ['fed', ['SPX', 'NDX']],
    ['volatility', ['VIX', 'SPX']],
];

function hash(value: string): number {
    let h = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        h ^= value.charCodeAt(index);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function sentimentOf(headline: string): Sentiment {
    const words = headline.toLowerCase().split(/\W+/);
    const positive = words.filter((word) => POSITIVE_WORDS.includes(word)).length;
    const negative = words.filter((word) => NEGATIVE_WORDS.includes(word)).length;
    if (positive > negative) return Sentiment.POSITIVE;
    if (negative > positive) return Sentiment.NEGATIVE;
    return Sentiment.NEUTRAL;
}

function assetsOf(headline: string): string[] {
    const lower = headline.toLowerCase();
    const assets = ASSET_KEYWORDS.filter(([keyword]) => lower.includes(keyword)).flatMap(([, tickers]) => tickers);
    return Array.from(new Set(assets.length > 0 ? assets : ['SPX', 'NDX'])).slice(0, 3);
}

export function demoAnalyzeHeadline(headline: string) {
    const sentiment = sentimentOf(headline);
    const score = 55 + (hash(headline) % 40);
    const direction = sentiment === Sentiment.POSITIVE ? 'supportive' : sentiment === Sentiment.NEGATIVE ? 'cautionary' : 'mixed';
    return {
        score,
        scoreRationale: `Demo sample: the score reflects a fixed template for a ${direction} headline, not a live model reading.`,
        sentiment,
        summary: `Demo sample analysis: this headline reads as ${direction} for the affected assets. Real analysis requires a live AI key; this text is a fixed example.`,
        affectedAssets: assetsOf(headline),
        isAnalyzed: true,
        isAnalysing: false,
        mode: 'simulation' as const,
        reason: 'ai_simulation' as const,
        notice: DEMO_AI_NOTICE,
    };
}

export function demoDeepDive(headline: string): { content: string; scenarios: Array<Record<string, string>> } {
    const assets = assetsOf(headline);
    return {
        content: `**1. The Event (What)**\n"${headline}" is a sample headline in the AlphaPulse demo.\n\n**2. Context (Background)**\nThis section is a fixed demo template. No live model, web search or market feed was used.\n\n**3. Chain Impact (Ripple Effects)**\nIn the demo, the most exposed instruments are ${assets.join(', ')}, followed by broad index beta.\n\n**4. Forecast (Outlook)**\nSample outlook only: moderate conviction, wide uncertainty bands. Not investment advice.`,
        scenarios: [
            { direction: 'LONG', asset: assets[0], rationale: 'Sample scenario: momentum continues while the headline remains supported.', risk: 'MEDIUM' },
            { direction: 'HEDGE', asset: 'Volatility Basket', rationale: 'Sample scenario: protect against a reversal in sentiment.', risk: 'LOW' },
        ],
    };
}

export function demoAgentAnalysis(agentId: string, headline: string) {
    const common = `Demo sample for "${headline}".`;
    switch (agentId) {
        case 'agent-bear':
            return { position: 'SHORT', confidence: 62, reasoning: `${common} The bear case: expectations look stretched and downside risks are under-priced.`, evidence: ['Demo template: valuation stretch', 'Demo template: crowded positioning'], scenarios: [{ direction: 'SHORT', asset: assetsOf(headline)[0], rationale: 'Sample scenario: fade the move with tight risk limits.', risk: 'MEDIUM' }] };
        case 'agent-bull':
            return { position: 'LONG', confidence: 71, reasoning: `${common} The bull case: earnings momentum and flows continue to support the trend.`, evidence: ['Demo template: earnings momentum', 'Demo template: supportive flows'], scenarios: [{ direction: 'LONG', asset: assetsOf(headline)[0], rationale: 'Sample scenario: scale in on pullbacks.', risk: 'MEDIUM' }] };
        case 'agent-risk':
            return { position: 'HEDGE', confidence: 66, reasoning: `${common} Risk view: size positions conservatively and keep protection in place.`, evidence: ['Demo template: drawdown limits', 'Demo template: correlation spike risk'], scenarios: [{ direction: 'HEDGE', asset: 'Portfolio Overlay', rationale: 'Sample scenario: index put spread as overlay.', risk: 'LOW' }] };
        default:
            return { position: 'WAIT', confidence: 58, reasoning: `${common} Quant view: statistical confirmation is incomplete, so no edge is claimed.`, evidence: ['Demo template: signal below threshold', 'Demo template: wide confidence interval'], scenarios: [{ direction: 'WAIT', asset: 'Cash Buffer', rationale: 'Sample scenario: wait for confirmation.', risk: 'LOW' }] };
    }
}

export function demoChatReply(lastMessage: string): string {
    const text = lastMessage.toLowerCase();
    if (/\b(buy|invest)\b/.test(text)) {
        if (text.includes('risk')) {
            return '(Demo) Understood: medium-risk profile. Devil\'s advocate view: rallies can be overstretched, so phased entries are more defensible. This is a fixed sample reply, not advice.';
        }
        return '(Demo) AlphaPulse Orchestrator: before discussing the asset, what are your portfolio size and risk tolerance (Low/Medium/High)? This is a fixed sample reply.';
    }
    return '(Demo) AlphaPulse advisory demo is active. Replies are fixed sample text; no external AI is called.';
}
