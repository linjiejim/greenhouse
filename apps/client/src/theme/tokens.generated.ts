/** GENERATED from packages/ui/src/tokens/tokens.ts by `pnpm tokens:build` — do not edit by hand. */

/** The native palette per appearance (keys: apps/client/src/theme/palette.ts). */
export const nativePalette = {
  "light": {
    "accent": "#235D4D",
    "onAccent": "#FFFFFF",
    "accentFill": "#DAE8E0",
    "accentText": "#235D4D",
    "onTint": "#FFFFFF",
    "mark": "#235D4D",
    "seed": "#B6CA68",
    "background": "#F6F8F7",
    "secondaryBackground": "#F2F5F3",
    "tertiaryBackground": "#FFFFFF",
    "groupedBackground": "#F2F5F3",
    "secondaryGroupedBackground": "#FFFFFF",
    "tertiaryGroupedBackground": "#F6F8F7",
    "sidebarBackground": "#E8EDE9",
    "sidebarSelection": "rgba(35, 93, 77, 0.12)",
    "brandCanvas": "#F2F5F3",
    "label": "#1C1C1E",
    "secondaryLabel": "#424944",
    "tertiaryLabel": "#555C57",
    "quaternaryLabel": "rgba(60, 60, 67, 0.18)",
    "placeholder": "#555C57",
    "link": "#235D4D",
    "separator": "#C2CBC5",
    "opaqueSeparator": "#C2CBC5",
    "fill": "rgba(120, 120, 128, 0.2)",
    "secondaryFill": "rgba(120, 120, 128, 0.16)",
    "tertiaryFill": "rgba(118, 118, 128, 0.12)",
    "quaternaryFill": "rgba(116, 116, 128, 0.08)",
    "red": "#C23A34",
    "redFill": "#FCEBE9",
    "orange": "#9A5B08",
    "orangeFill": "#FFF2DE",
    "green": "#1F7A4C",
    "greenFill": "#E3F3E9",
    "blue": "#2A64AD",
    "blueFill": "#E6EEF9",
    "redTile": "#C23A34",
    "orangeTile": "#9A5B08",
    "greenTile": "#1F7A4C",
    "blueTile": "#2A64AD",
    "yellow": "#FFCC00",
    "indigo": "#1F6CC0",
    "purple": "#7A45AE",
    "gray": "#5F6168",
    "codeBg": "#1C1C1E",
    "codeHeader": "#2C2C2E",
    "codeText": "#E5E5EA",
    "codeComment": "#8E8E93",
    "codeLabel": "#AEAEB2",
    "codeKeyword": "#FC5FA3",
    "codeString": "#FC6A5D",
    "codeNumber": "#D0BF69",
    "scrim": "rgba(0, 0, 0, 0.22)"
  },
  "dark": {
    "accent": "#B1D2BF",
    "onAccent": "#10291F",
    "accentFill": "rgba(177, 210, 191, 0.14)",
    "accentText": "#B1D2BF",
    "onTint": "#FFFFFF",
    "mark": "#B1D2BF",
    "seed": "#B6CA68",
    "background": "#0F1510",
    "secondaryBackground": "#1A231B",
    "tertiaryBackground": "#243026",
    "groupedBackground": "#0F1510",
    "secondaryGroupedBackground": "#1A231B",
    "tertiaryGroupedBackground": "#243026",
    "sidebarBackground": "#0A0F0B",
    "sidebarSelection": "rgba(177, 210, 191, 0.16)",
    "brandCanvas": "#0F1510",
    "label": "#F2F6F0",
    "secondaryLabel": "#C6D0C3",
    "tertiaryLabel": "#9DAA9A",
    "quaternaryLabel": "rgba(235, 235, 245, 0.16)",
    "placeholder": "#9DAA9A",
    "link": "#B1D2BF",
    "separator": "rgba(84, 84, 88, 0.6)",
    "opaqueSeparator": "#38383A",
    "fill": "rgba(120, 120, 128, 0.36)",
    "secondaryFill": "rgba(120, 120, 128, 0.32)",
    "tertiaryFill": "rgba(118, 118, 128, 0.24)",
    "quaternaryFill": "rgba(118, 118, 128, 0.18)",
    "red": "#FF8A84",
    "redFill": "#43231F",
    "orange": "#FFC46B",
    "orangeFill": "#382B1B",
    "green": "#6FD39C",
    "greenFill": "#1A3326",
    "blue": "#8CBBF5",
    "blueFill": "#1B2A3D",
    "redTile": "#C23A34",
    "orangeTile": "#9A5B08",
    "greenTile": "#1F7A4C",
    "blueTile": "#2A64AD",
    "yellow": "#FFD60A",
    "indigo": "#7DB9FF",
    "purple": "#C9A2F5",
    "gray": "#B4B6BC",
    "codeBg": "#1C1C1E",
    "codeHeader": "#2C2C2E",
    "codeText": "#E5E5EA",
    "codeComment": "#8E8E93",
    "codeLabel": "#AEAEB2",
    "codeKeyword": "#FC5FA3",
    "codeString": "#FC6A5D",
    "codeNumber": "#D0BF69",
    "scrim": "rgba(0, 0, 0, 0.45)"
  }
} as const;

/** User-chosen colours (projects, tags, options): text or icon `fg` on `fill`. */
export const categoricalHex = {
  "light": {
    "gray": {
      "fg": "#5F6168",
      "fill": "#EEEEF1"
    },
    "red": {
      "fg": "#C8302F",
      "fill": "#FDECEB"
    },
    "orange": {
      "fg": "#AD4600",
      "fill": "#FEEEDF"
    },
    "amber": {
      "fg": "#9C6100",
      "fill": "#FDF3D3"
    },
    "green": {
      "fg": "#1D7A4F",
      "fill": "#E4F4EA"
    },
    "teal": {
      "fg": "#00796A",
      "fill": "#DFF4F0"
    },
    "blue": {
      "fg": "#1F6CC0",
      "fill": "#E5F0FC"
    },
    "purple": {
      "fg": "#7A45AE",
      "fill": "#F2EBFB"
    },
    "pink": {
      "fg": "#B42F7E",
      "fill": "#FCEAF4"
    }
  },
  "dark": {
    "gray": {
      "fg": "#B4B6BC",
      "fill": "#26272B"
    },
    "red": {
      "fg": "#FF9590",
      "fill": "#3B1B1B"
    },
    "orange": {
      "fg": "#FFA25C",
      "fill": "#35210F"
    },
    "amber": {
      "fg": "#FFCB47",
      "fill": "#33270D"
    },
    "green": {
      "fg": "#5ED59A",
      "fill": "#16301F"
    },
    "teal": {
      "fg": "#3CD3BA",
      "fill": "#0F2E2A"
    },
    "blue": {
      "fg": "#7DB9FF",
      "fill": "#13294A"
    },
    "purple": {
      "fg": "#C9A2F5",
      "fill": "#2C1F3D"
    },
    "pink": {
      "fg": "#FF8FCB",
      "fill": "#3A1B30"
    }
  }
} as const;

/** The shared radius scale in points. */
export const radiusScale = {
  "xs": 4,
  "sm": 6,
  "md": 8,
  "lg": 12,
  "xl": 16,
  "2xl": 20,
  "sheet": 24,
  "full": 9999
} as const;

/** Motion durations in ms and easing curves. */
export const motionTokens = {
  "fast": 140,
  "base": 200,
  "slow": 240,
  "exit": 180,
  "loop": 1000,
  "easeStandard": "cubic-bezier(0.2, 0, 0, 1)",
  "easeEnter": "cubic-bezier(0.05, 0.7, 0.1, 1)",
  "easeExit": "cubic-bezier(0.3, 0, 1, 1)"
} as const;

/** Brand colours of the mark. */
export const brandHex = {
  "mark": {
    "light": "#235D4D",
    "dark": "#B1D2BF"
  },
  "seed": {
    "light": "#B6CA68",
    "dark": "#B6CA68"
  }
} as const;
