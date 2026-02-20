// Per-workspace theming via CSS custom properties
// Light theme with colored accents per workspace

const COLOR_MAP = {
  purple: { primary: '#7C5CFC', light: '#EDE9FE', hover: '#F5F3FF', border: '#C4B5FD' },
  blue:   { primary: '#3B82F6', light: '#DBEAFE', hover: '#EFF6FF', border: '#93C5FD' },
  cyan:   { primary: '#06B6D4', light: '#CFFAFE', hover: '#ECFEFF', border: '#67E8F9' },
  green:  { primary: '#22C55E', light: '#DCFCE7', hover: '#F0FDF4', border: '#86EFAC' },
  yellow: { primary: '#EAB308', light: '#FEF9C3', hover: '#FEFCE8', border: '#FDE047' },
  orange: { primary: '#F97316', light: '#FFEDD5', hover: '#FFF7ED', border: '#FDBA74' },
  red:    { primary: '#EF4444', light: '#FEE2E2', hover: '#FEF2F2', border: '#FCA5A5' },
  pink:   { primary: '#EC4899', light: '#FCE7F3', hover: '#FDF2F8', border: '#F9A8D4' },
  grey:   { primary: '#6B7280', light: '#F3F4F6', hover: '#F9FAFB', border: '#D1D5DB' },
};

class ThemeService {
  /**
   * Apply a workspace's color scheme to the document.
   * @param {string} colorScheme - One of the COLOR_MAP keys
   */
  apply(colorScheme) {
    const colors = COLOR_MAP[colorScheme] || COLOR_MAP.purple;
    const root = document.documentElement;

    root.style.setProperty('--arc-primary', colors.primary);
    root.style.setProperty('--arc-primary-light', colors.light);
    root.style.setProperty('--arc-primary-hover', colors.hover);
    root.style.setProperty('--arc-primary-border', colors.border);
  }

  /**
   * Get all available color schemes.
   */
  getColorSchemes() {
    return Object.entries(COLOR_MAP).map(([name, colors]) => ({
      name,
      ...colors
    }));
  }
}

export const themeService = new ThemeService();
