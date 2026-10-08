import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
        setupFiles: ['./tests/setup.ts'],
        restoreMocks: true,
        clearMocks: true,
        testTimeout: 60_000,
    },
});
