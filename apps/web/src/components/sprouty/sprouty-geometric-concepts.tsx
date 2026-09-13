import React from 'react';
import { COLOR_PRESETS } from './sprouty-constants.js';

export type SproutyGeometricConcept = 'seed-core' | 'three-leaf' | 'radial-bloom' | 'canopy-knot';

export interface SproutyGeometricConceptMeta {
  id: SproutyGeometricConcept;
  name: string;
  description: string;
  role: string;
  recommended?: boolean;
}

export const SPROUTY_GEOMETRIC_CONCEPTS: SproutyGeometricConceptMeta[] = [
  {
    id: 'seed-core',
    name: 'Seed Core',
    description: 'Nested seed and leaf contours; quiet, stable, and exceptionally clear at tiny sizes.',
    role: 'Best compact system mark',
  },
  {
    id: 'three-leaf',
    name: 'Three-Leaf Sigil',
    description: 'A geometric translation of the Greenhouse three-leaf logo with a modular central seed.',
    role: 'Best primary brand direction',
    recommended: true,
  },
  {
    id: 'radial-bloom',
    name: 'Radial Bloom',
    description: 'Petal count, rotation, and color can encode Agent families, skills, or live state.',
    role: 'Best functional identity system',
  },
  {
    id: 'canopy-knot',
    name: 'Canopy Knot',
    description: 'Interlocking leaves form a soft pinwheel that can generate many individual personalities.',
    role: 'Best generative character family',
  },
];

interface SproutyGeometricMarkProps {
  concept: SproutyGeometricConcept;
  color?: string;
  size?: number;
  className?: string;
}

export function SproutyGeometricMark({
  concept,
  color = 'forest',
  size = 96,
  className = '',
}: SproutyGeometricMarkProps) {
  const palette = COLOR_PRESETS[color] ?? COLOR_PRESETS.forest;
  const commonProps = {
    width: size,
    height: size,
    viewBox: '0 0 100 100',
    className,
    role: 'img',
    'aria-label': SPROUTY_GEOMETRIC_CONCEPTS.find((item) => item.id === concept)?.name ?? concept,
  };

  if (concept === 'seed-core') {
    return (
      <svg {...commonProps}>
        <path d="M50 7C72 8 86 25 82 46C78 67 61 82 50 92C39 82 22 67 18 46C14 25 28 8 50 7Z" fill={palette.leafDark} />
        <path d="M50 15C67 16 77 29 74 46C71 61 59 72 50 81C41 72 29 61 26 46C23 29 33 16 50 15Z" fill={palette.leaf} />
        <path
          d="M50 25C61 25 68 34 66 45C64 55 56 63 50 69C44 63 36 55 34 45C32 34 39 25 50 25Z"
          fill={palette.leafLight}
        />
        <path
          d="M50 35C56 35 60 40 59 46C58 51 53 56 50 59C47 56 42 51 41 46C40 40 44 35 50 35Z"
          fill={palette.bodyHighlight}
        />
        <path d="M31 60C40 56 47 58 50 65C42 69 35 68 31 60Z" fill={palette.body} opacity="0.9" />
        <path d="M69 60C60 56 53 58 50 65C58 69 65 68 69 60Z" fill={palette.body} opacity="0.9" />
      </svg>
    );
  }

  if (concept === 'three-leaf') {
    return (
      <svg {...commonProps}>
        <path
          d="M50 82V46M50 60L29 42M50 58L71 38"
          fill="none"
          stroke={palette.leafDark}
          strokeLinecap="round"
          strokeWidth="5"
        />
        <path
          d="M50 7C62 17 63 31 50 43C37 31 38 17 50 7Z"
          fill={palette.leafLight}
          stroke={palette.leafDark}
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <path
          d="M13 31C29 28 40 35 41 50C25 53 16 46 13 31Z"
          fill={palette.leaf}
          stroke={palette.leafDark}
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <path
          d="M87 27C85 44 75 52 59 49C60 34 70 27 87 27Z"
          fill={palette.body}
          stroke={palette.leafDark}
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <path
          d="M50 55L63 68L50 83L37 68Z"
          fill={palette.bodyHighlight}
          stroke={palette.leafDark}
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <circle cx="50" cy="68" r="5" fill={palette.bodyDark} />
      </svg>
    );
  }

  if (concept === 'radial-bloom') {
    return (
      <svg {...commonProps}>
        {Array.from({ length: 8 }, (_, index) => (
          <path
            key={index}
            d="M50 5L60 31L50 44L40 31Z"
            fill={index % 2 === 0 ? palette.leaf : palette.body}
            stroke={palette.leafDark}
            strokeLinejoin="round"
            strokeWidth="2.5"
            transform={`rotate(${index * 45} 50 50)`}
          />
        ))}
        <circle cx="50" cy="50" r="16" fill={palette.bodyHighlight} stroke={palette.leafDark} strokeWidth="3" />
        <circle cx="50" cy="50" r="6" fill={palette.bodyDark} />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      {Array.from({ length: 5 }, (_, index) => (
        <path
          key={index}
          d="M50 50C31 47 22 32 29 17C44 19 55 31 50 50Z"
          fill={index % 2 === 0 ? palette.leaf : palette.body}
          stroke={palette.leafDark}
          strokeLinejoin="round"
          strokeWidth="2.5"
          transform={`rotate(${index * 72} 50 50)`}
          opacity={0.9}
        />
      ))}
      <path
        d="M50 38L62 50L50 62L38 50Z"
        fill={palette.bodyHighlight}
        stroke={palette.leafDark}
        strokeLinejoin="round"
        strokeWidth="3"
      />
      <circle cx="50" cy="50" r="4.5" fill={palette.bodyDark} />
    </svg>
  );
}
