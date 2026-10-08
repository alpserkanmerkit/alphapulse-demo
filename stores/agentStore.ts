import { create } from 'zustand';
import { AgentArgument, DebateResult, ConsensusResult, NewsItem } from '../types';
import { AGENT_PERSONAS, AgentPersona } from '../shared/agentPersonas';
export type { AgentPersona } from '../shared/agentPersonas';
export { AGENT_PERSONAS } from '../shared/agentPersonas';

// =============================================
// STORE
// =============================================

interface AgentState {
    personas: AgentPersona[];
    activeDebates: Record<string, DebateResult>;
    isDebating: boolean;
    currentDebateNewsId: string | null;
    agentProgress: Record<string, 'pending' | 'thinking' | 'done'>;

    // Actions
    startDebate: (newsItem: NewsItem) => void;
    addArgument: (newsId: string, argument: AgentArgument) => void;
    setAgentProgress: (agentId: string, status: 'pending' | 'thinking' | 'done') => void;
    finalizeDebate: (newsId: string, consensus: ConsensusResult) => void;
    abortDebate: () => void;
    getDebateForNews: (newsId: string) => DebateResult | undefined;
    clearDebate: (newsId: string) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
    personas: AGENT_PERSONAS,
    activeDebates: {},
    isDebating: false,
    currentDebateNewsId: null,
    agentProgress: {},

    startDebate: (newsItem) => {
        const initialProgress: Record<string, 'pending' | 'thinking' | 'done'> = {};
        AGENT_PERSONAS.forEach((agent) => {
            initialProgress[agent.id] = 'pending';
        });

        set({
            isDebating: true,
            currentDebateNewsId: newsItem.id,
            agentProgress: initialProgress,
            activeDebates: {
                ...get().activeDebates,
                [newsItem.id]: {
                    newsId: newsItem.id,
                    arguments: [],
                    consensus: {
                        direction: 'WAIT',
                        confidence: 0,
                        bullishProbability: 0,
                        bearishProbability: 0,
                        neutralProbability: 100,
                        summary: 'Debate in progress...',
                    },
                    uncertainty: 'HIGH',
                    timestamp: Date.now(),
                },
            },
        });
    },

    addArgument: (newsId, argument) => {
        set((state) => {
            const debate = state.activeDebates[newsId];
            if (!debate) return state;
            const nextArguments = debate.arguments.some((item) => item.agentId === argument.agentId)
                ? debate.arguments.map((item) => item.agentId === argument.agentId ? argument : item)
                : [...debate.arguments, argument];

            return {
                activeDebates: {
                    ...state.activeDebates,
                    [newsId]: {
                        ...debate,
                        arguments: nextArguments,
                    },
                },
            };
        });
    },

    setAgentProgress: (agentId, status) => {
        set((state) => ({
            agentProgress: { ...state.agentProgress, [agentId]: status },
        }));
    },

    finalizeDebate: (newsId, consensus) => {
        set((state) => {
            const debate = state.activeDebates[newsId];
            if (!debate) return state;

            // Calculate uncertainty based on argument spread
            const args = debate.arguments;
            const positions = args.map((a) => a.position);
            const uniquePositions = new Set(positions);
            const uncertainty: 'LOW' | 'MEDIUM' | 'HIGH' =
                uniquePositions.size <= 1 ? 'LOW' : uniquePositions.size <= 2 ? 'MEDIUM' : 'HIGH';

            return {
                isDebating: false,
                currentDebateNewsId: null,
                activeDebates: {
                    ...state.activeDebates,
                    [newsId]: {
                        ...debate,
                        consensus,
                        uncertainty,
                        timestamp: Date.now(),
                    },
                },
            };
        });
    },

    abortDebate: () => {
        set({
            isDebating: false,
            currentDebateNewsId: null,
        });
    },

    getDebateForNews: (newsId) => {
        return get().activeDebates[newsId];
    },

    clearDebate: (newsId) => {
        set((state) => {
            const { [newsId]: _, ...rest } = state.activeDebates;
            return { activeDebates: rest };
        });
    },
}));
