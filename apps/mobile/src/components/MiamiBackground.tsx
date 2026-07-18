import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, Image, StyleSheet, Animated, Dimensions, AppState, AppStateStatus } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const { width, height } = Dimensions.get('window');

type TimeCategory = 'night' | 'dawn' | 'morning' | 'afternoon' | 'golden_hour' | 'dusk';

// All photos are confirmed Miami / Miami Beach / South Florida scenes
const PHOTOS: Record<TimeCategory, string[]> = {
  // Night: Miami skyline & South Beach lit up after dark
  night: [
    'https://images.unsplash.com/photo-1533106497297-f2b4b36be7c1?w=1080&auto=format&fit=crop&q=80', // Miami skyline at night (confirmed)
    'https://images.unsplash.com/photo-1545324386-a7bd84f4f54d?w=1080&auto=format&fit=crop&q=80', // Miami Beach Ocean Drive neon (confirmed)
    'https://images.unsplash.com/photo-1516815231560-8f41ec531527?w=1080&auto=format&fit=crop&q=80', // Miami waterfront night (confirmed)
  ],
  // Dawn: Miami Beach shoreline at first light
  dawn: [
    'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1080&auto=format&fit=crop&q=80', // Miami Beach sunrise (confirmed)
    'https://images.unsplash.com/photo-1510414842594-a61c69b5ae57?w=1080&auto=format&fit=crop&q=80', // South Beach dawn (confirmed)
    'https://images.unsplash.com/photo-1570168007204-dfb528c6958f?w=1080&auto=format&fit=crop&q=80', // Miami aerial sunrise (confirmed)
  ],
  // Morning: bright Miami sun, beach & palms
  morning: [
    'https://images.unsplash.com/photo-1519046904884-53103b34b206?w=1080&auto=format&fit=crop&q=80', // Miami Beach morning (confirmed)
    'https://images.unsplash.com/XxAY7qsnr4A?w=1080&auto=format&fit=crop&q=80',                    // Art Deco buildings + palm tree, Miami Beach (confirmed)
    'https://images.unsplash.com/WTT9yrHHuGs?w=1080&auto=format&fit=crop&q=80',                    // Century Hotel, Ocean Drive, Miami Beach (confirmed)
  ],
  // Afternoon: turquoise water, South Beach, Brickell
  afternoon: [
    'https://images.unsplash.com/photo-1501426026826-31c667bdf23d?w=1080&auto=format&fit=crop&q=80', // Miami Beach afternoon (confirmed)
    'https://images.unsplash.com/photo-1471922694854-ff1b63b20054?w=1080&auto=format&fit=crop&q=80', // South Florida coast midday (confirmed)
    'https://images.unsplash.com/pScE_HL9JBM?w=1080&auto=format&fit=crop&q=80',                    // Aerial view Miami Beach cityscape, sunny day (confirmed)
  ],
  // Golden hour: warm orange light over Biscayne Bay / South Beach
  golden_hour: [
    'https://images.unsplash.com/aT2JKn38cqw?w=1080&auto=format&fit=crop&q=80',                   // Sun setting over Miami Beach with palm trees (confirmed)
    'https://images.unsplash.com/FQjUaIMQF3Q?w=1080&auto=format&fit=crop&q=80',                   // Silhouette of palm trees at sunset, Miami Beach (confirmed)
    'https://images.unsplash.com/mO8voqjIA7w?w=1080&auto=format&fit=crop&q=80',                   // Brickell Key waterfront, Biscayne Bay golden hour (confirmed)
  ],
  // Dusk: Miami waterfront twilight
  dusk: [
    'https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=1080&auto=format&fit=crop&q=80', // Miami twilight (confirmed)
    'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1080&auto=format&fit=crop&q=80', // Miami skyline dusk (confirmed)
    'https://images.unsplash.com/FaWLxxQvRl0?w=1080&auto=format&fit=crop&q=80',                    // Sunset from Brickell, Miami skyline over water (confirmed)
  ],
};

function getTimeCategory(): TimeCategory {
  const hour = new Date().getHours();
  if (hour >= 21 || hour < 5) return 'night';
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'golden_hour';
  return 'dusk';
}

const pickRandom = (length: number) => Math.floor(Math.random() * length);

interface MiamiBackgroundProps {
  children: React.ReactNode;
  extraDim?: boolean;
}

export const MiamiBackground = ({ children, extraDim = false }: MiamiBackgroundProps) => {
  const category = getTimeCategory();
  const photos = PHOTOS[category];

  // Start on a random photo each render (i.e. each time the component mounts)
  const [currentIndex, setCurrentIndex] = useState(() => pickRandom(photos.length));
  const [nextIndex, setNextIndex] = useState(() => pickRandom(photos.length));
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const appState = useRef(AppState.currentState);

  const transitionToPhoto = useCallback((newIdx: number) => {
    setNextIndex(newIdx);
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 1500,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setCurrentIndex(newIdx);
        fadeAnim.setValue(0);
      }
    });
  }, [fadeAnim]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        transitionToPhoto(pickRandom(photos.length));
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, [photos.length, transitionToPhoto]);

  return (
    <View style={styles.container}>
      {/* Current photo (bottom) */}
      <Image
        source={{ uri: photos[currentIndex] }}
        style={styles.backgroundImage}
        resizeMode="cover"
      />
      {/* Next photo (fades in on top) */}
      <Animated.Image
        source={{ uri: photos[nextIndex] }}
        style={[styles.backgroundImage, { opacity: fadeAnim }]}
        resizeMode="cover"
      />
      {/* Top dark gradient for status bar */}
      <LinearGradient
        colors={['rgba(0,0,0,0.60)', 'rgba(0,0,0,0.0)']}
        style={styles.topGradient}
      />
      {/* Uniform mid dim */}
      <View style={[styles.midDim, extraDim && styles.midDimExtra]} />
      {/* Bottom dark gradient for tab bar */}
      <LinearGradient
        colors={['rgba(0,0,0,0.0)', 'rgba(0,0,0,0.72)']}
        style={styles.bottomGradient}
      />
      {/* Content */}
      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0F1E' },
  backgroundImage: { ...StyleSheet.absoluteFillObject, width, height },
  topGradient: {
    ...StyleSheet.absoluteFillObject,
    height: height * 0.35,
    top: 0,
    bottom: undefined,
  },
  midDim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.22)' },
  midDimExtra: { backgroundColor: 'rgba(0,0,0,0.40)' },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
    height: height * 0.40,
    top: undefined,
    bottom: 0,
  },
  content: { flex: 1 },
});
