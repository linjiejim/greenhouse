/**
 * Bot computers — public surface of the computer subsystem (a barrel; the
 * modules behind it are owned by the computer runtime and the browser/vault
 * layers). Design: docs/specs/20261005-personal-assistant-bots.md §6, §8.
 */

export {
  getComputerRuntime,
  initBotComputers,
  shutdownBotComputers,
  computerStatusFor,
  stopUserComputer,
  purgeUserComputer,
  handleTakeoverDecision,
  botsComputerHealthView,
} from './runtime.js';
export { createBotsComputerRoutes, createComputerViewerRoutes, createAdminBotComputerRoutes } from './routes.js';
export { buildComputerTools, handleLoginDecision, releaseTurnLeases, SecureLoginError } from './tools.js';
export { createBotsVaultRoutes } from '../vault/routes.js';
