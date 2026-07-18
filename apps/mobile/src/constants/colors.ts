// 2020EV Design System — Liquid Glass inspired

export const TextShadow = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 6,
};

export const StrongTextShadow = {
  textShadowColor: 'rgba(0,0,0,0.9)',
  textShadowOffset: { width: 0, height: 2 },
  textShadowRadius: 8,
};

export const Colors = {
  // Primary tints
  primary: '#007AFF',        // iOS blue
  primaryLight: '#4DA3FF',
  success: '#34C759',        // Charger available green
  warning: '#FF9F0A',        // In use amber
  danger: '#FF3B30',         // Near limit red

  // Backgrounds
  background: {
    dark: '#000000',
    card: 'rgba(28, 28, 30, 0.8)',
    glass: 'rgba(255, 255, 255, 0.08)',
    glassLight: 'rgba(255, 255, 255, 0.12)',
    surface: 'rgba(44, 44, 46, 0.9)',
  },

  // Text
  text: {
    primary: '#FFFFFF',
    secondary: 'rgba(255, 255, 255, 0.6)',
    tertiary: 'rgba(255, 255, 255, 0.3)',
  },

  // Borders
  border: {
    glass: 'rgba(255, 255, 255, 0.15)',
    subtle: 'rgba(255, 255, 255, 0.08)',
  },

  // Status colors
  charger: {
    available: '#34C759',
    inUse: '#FF9F0A',
    almostFull: '#FF3B30',
  },
};
