import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    timeout: 30000, // 30 secondes pour les tests réseau
    include: ['src/**/*.test.ts'],
  },
});

