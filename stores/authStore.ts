import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { TeamContext, UserRole } from '../types';

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    role: UserRole | string;
    teamContext?: TeamContext;
}

interface AuthState {
    token: string | null;
    user: AuthUser | null;
    isAuthenticated: boolean;
    setAuth: (token: string, user: AuthUser) => void;
    logout: () => void;
}

function readInitialAuth(): Pick<AuthState, 'token' | 'user' | 'isAuthenticated'> {
    if (typeof window === 'undefined') {
        return { token: null, user: null, isAuthenticated: false };
    }

    try {
        const stored = window.sessionStorage.getItem('alphapulse-auth');
        const parsed = stored ? JSON.parse(stored) : null;
        const state = parsed?.state;
        if (state?.isAuthenticated && state.token && state.user) {
            return {
                token: state.token,
                user: state.user,
                isAuthenticated: true,
            };
        }
    } catch {
        // Ignore invalid persisted auth and start logged out.
    }

    return { token: null, user: null, isAuthenticated: false };
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            ...readInitialAuth(),
            setAuth: (token, user) => set({ token, user, isAuthenticated: true }),
            logout: () => set({ token: null, user: null, isAuthenticated: false }),
        }),
        {
            name: 'alphapulse-auth',
            storage: createJSONStorage(() => sessionStorage),
        }
    )
);
