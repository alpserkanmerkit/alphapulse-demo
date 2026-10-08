import { create } from 'zustand';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';

export interface Position {
    id: string;
    ticker: string;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    updatedAt: string;
}

export interface Transaction {
    id: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    commission: number;
    timestamp: string;
}

export interface PortfolioStateModel {
    id: string;
    userId: string | null;
    totalBalance: number;
    cashBalance: number;
    currentVaR: number;
    positions: Position[];
    transactions: Transaction[];
    updatedAt: string;
}

interface SidebarPortfolioOption {
    id: string;
    name: string;
}

interface PortfolioState {
    portfolio: PortfolioStateModel | null;
    isLoading: boolean;
    isTrading: boolean;
    error: string | null;
    portfolios: SidebarPortfolioOption[];
    activePortfolioId: string;
    setActivePortfolio: (id: string) => void;
    fetchPortfolio: () => Promise<void>;
    tradeStock: (ticker: string, type: 'BUY' | 'SELL', quantity: number, price: number) => Promise<boolean>;
    portfolioPnL: () => { total: number; percent: number };
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
    portfolio: null,
    isLoading: false,
    isTrading: false,
    error: null,
    portfolios: [{ id: 'live', name: 'Live Portfolio' }],
    activePortfolioId: 'live',
    setActivePortfolio: (id) => set({ activePortfolioId: id }),

    fetchPortfolio: async () => {
        set({ isLoading: true, error: null });
        try {
            const response = await apiClient.get('/api/portfolio/state');
            if (response.data.success) {
                set({
                    portfolio: response.data.portfolio,
                    activePortfolioId: response.data.portfolio.id,
                    portfolios: [{ id: response.data.portfolio.id, name: 'Live Portfolio' }],
                });
            }
        } catch (error) {
            set({ error: getApiErrorMessage(error, 'Failed to fetch portfolio state') });
        } finally {
            set({ isLoading: false });
        }
    },

    tradeStock: async (ticker, type, quantity, price) => {
        set({ isTrading: true, error: null });
        try {
            const response = await apiClient.post('/api/portfolio/trade', { ticker, type, quantity, price });
            if (response.data.success) {
                await get().fetchPortfolio();
                return true;
            }
            return false;
        } catch (error) {
            set({ error: getApiErrorMessage(error, `Failed to log paper ${type} for ${ticker}`) });
            return false;
        } finally {
            set({ isTrading: false });
        }
    },

    portfolioPnL: () => {
        const portfolio = get().portfolio;
        if (!portfolio || portfolio.positions.length === 0) {
            return { total: 0, percent: 0 };
        }

        const totals = portfolio.positions.reduce(
            (acc, position) => ({
                cost: acc.cost + position.averagePrice * position.quantity,
                current: acc.current + position.currentPrice * position.quantity,
            }),
            { cost: 0, current: 0 }
        );

        if (totals.cost === 0) {
            return { total: 0, percent: 0 };
        }

        return {
            total: totals.current - totals.cost,
            percent: ((totals.current - totals.cost) / totals.cost) * 100,
        };
    },
}));
