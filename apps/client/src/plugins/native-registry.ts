/** Official client glue is owned by each plugin; the host only indexes entries. */
import { screen as knowledge } from './knowledge';
import { screen as tables } from './tables';
import { screen as projects } from './projects';
import { screen as feedback } from './feedback';
import { screen as memory } from './memory';
import { screen as computer } from './computer';
import { screen as email } from './email';
import { screen as skills } from './skills';
import { screen as reports } from './reports';
import { screen as retro } from './retro';
export const nativeScreens = Object.fromEntries(
  [knowledge, tables, projects, feedback, memory, computer, email, skills, reports, retro].map((screen) => [
    screen.screen,
    screen,
  ]),
);
