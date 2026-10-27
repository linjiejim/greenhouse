import { GREENHOUSE_CONFIG } from '../config/greenhouse-config.js';
let bundled: readonly string[] = [];
export function registerSkillPacks(roots: readonly string[]): void {
  bundled = [...roots];
}
export function extensionSkillPackDirs(): string[] {
  return [...GREENHOUSE_CONFIG.packs.skills, ...bundled];
}
