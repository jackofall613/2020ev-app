import React, { useEffect, useState } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { View, ActivityIndicator } from 'react-native';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { HomeScreen } from './src/screens/HomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { RegisterScreen } from './src/screens/RegisterScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { FeedScreen } from './src/screens/FeedScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { DriversScreen } from './src/screens/DriversScreen';
import { Colors } from './src/constants/colors';

const Tab = createBottomTabNavigator();

/** Extract invite token from any supported URL format:
 *  - https://2020ev.app/invite?token=XXXX
 *  - ev2020://invite?token=XXXX
 */
function extractInviteToken(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = Linking.parse(url);
    // ev2020://invite?token=X → hostname='invite', path=''
    // https://2020ev.app/invite?token=X → path='invite'
    const isInvite =
      (parsed.hostname ?? '').includes('invite') ||
      (parsed.path ?? '').includes('invite');
    if (isInvite && parsed.queryParams?.token) {
      return String(parsed.queryParams.token);
    }
  } catch {}
  return null;
}

const AppNavigator = () => {
  const { user, isLoading } = useAuth();
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  // Handle invite links that launched or are received while app is running
  useEffect(() => {
    // App opened from a cold start via deep link
    Linking.getInitialURL().then((url) => {
      const token = extractInviteToken(url);
      if (token) setInviteToken(token);
    });

    // App was already open and a link came in
    const sub = Linking.addEventListener('url', ({ url }) => {
      const token = extractInviteToken(url);
      if (token) setInviteToken(token);
    });

    return () => sub.remove();
  }, []);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0A0F1E' }}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  // Already logged in — go straight to the app
  if (user) {
    return (
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            position: 'absolute',
            backgroundColor: 'rgba(10, 15, 30, 0.75)',
            borderTopColor: 'rgba(255,255,255,0.12)',
            borderTopWidth: 1,
            paddingBottom: 4,
            elevation: 0,
          },
          tabBarActiveTintColor: '#007AFF',
          tabBarInactiveTintColor: 'rgba(255,255,255,0.3)',
        }}
      >
        <Tab.Screen
          name="Home"
          component={HomeScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons name="flash" size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Session"
          component={SessionScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons name="car" size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Feed"
          component={FeedScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Schedule"
          component={ScheduleScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons name="calendar" size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Wallet"
          component={WalletScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons name="wallet" size={size} color={color} />,
          }}
        />
        {user.role === 'admin' && (
          <Tab.Screen
            name="Drivers"
            component={DriversScreen}
            options={{
              tabBarIcon: ({ color, size }) => <Ionicons name="car-sport" size={size} color={color} />,
            }}
          />
        )}
        <Tab.Screen
          name="Profile"
          component={ProfileScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
          }}
        />
      </Tab.Navigator>
    );
  }

  // Invite token detected — show registration
  if (inviteToken) {
    return (
      <RegisterScreen
        inviteToken={inviteToken}
        onCancel={() => setInviteToken(null)}
      />
    );
  }

  // Default: login
  return <LoginScreen />;
};

const navigationRef = createNavigationContainerRef();

export default function AppMain() {
  // Queue-offer pushes ("charger's free, held for you") deep-link to Home,
  // where the On my way / Pass card is.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { type?: string } | undefined;
      if (data?.type === 'queue_offer' && navigationRef.isReady()) {
        navigationRef.navigate('Home' as never);
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer ref={navigationRef}>
          <AppNavigator />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
