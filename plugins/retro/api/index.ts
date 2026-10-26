import manifest from '../manifest.js';
import { defineExtension, requireSuper } from '@greenhouse/api/extension-kit';
import routes from './routes.js';
import { startMonthlyRetroJob, stopMonthlyRetroJob, monthlyRetroNextRun } from './job.js';
export default defineExtension({
  ...manifest,
  routes: [{ path: '/api/admin/retro', app: routes, guards: [requireSuper()] }],
  schedules: [{ nextRun: monthlyRetroNextRun }],
  workspaceTimeZoneChanged: [
    async () => {
      await startMonthlyRetroJob();
    },
  ],
  onBoot: async () => {
    await startMonthlyRetroJob();
  },
  onShutdown: stopMonthlyRetroJob,
});
