/** Ports, the database and the people of the browser tests. */

export const E2E = {
  databaseUrl: process.env.E2E_DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:55432/greenhouse_v2_e2e',
  webPort: Number(process.env.E2E_WEB_PORT ?? 4590),
  apiPort: Number(process.env.E2E_API_PORT ?? 4591),
  llmPort: Number(process.env.E2E_LLM_PORT ?? 4592),
};

export const PEOPLE = {
  lin: { email: 'lin@example.com', name: 'Lin', role: 'admin' as const, password: 'correct horse battery' },
  mei: { email: 'mei@example.com', name: 'Mei', role: 'member' as const, password: 'correct horse battery' },
};
