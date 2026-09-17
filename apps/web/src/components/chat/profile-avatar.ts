import type { Profile } from '../../lib/api';
import type { EyeStyle, SproutyVariant, LeafStyle } from '../sprouty/index.js';

/** Resolve profile appearance fields to Sprouty props. */
export function profileToSprouty(p: Profile): {
  variant: SproutyVariant;
  color?: string;
  accessories?: string[];
  leafStyle?: LeafStyle;
  eyeStyle?: EyeStyle;
} {
  if (p.is_custom) {
    const avatar = p.avatar;
    return {
      variant: 'custom',
      color: avatar?.color,
      accessories: avatar?.accessories,
      leafStyle: avatar?.leafStyle,
      eyeStyle: avatar?.eyeStyle,
    };
  }
  if (p.id === 'team') return { variant: 'team' };
  return { variant: 'default' };
}
