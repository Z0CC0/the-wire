import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Venti secondi in locale restano la regola. Sulle macchine di GitHub,
    // con due core e Argon2id a 64 MB per ogni identita' creata, i test di
    // presenza e dispositivi sforavano senza che niente fosse rotto.
    testTimeout: process.env['CI'] ? 120000 : 20000,
  },
});
