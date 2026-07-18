import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import axios from 'axios';
import { API_URL } from '../constants/api';

interface User {
  id: string;
  name: string;
  role: 'admin' | 'member';
  priority_day: string | null;
  unit_number?: string;
  avatar_url?: string | null;
  // v1.1 car profile — used for honest finish estimates on the charger queue
  car_make?: string | null;
  car_model?: string | null;
  battery_kwh?: number | null;
  target_percent?: number | null;
  // Multi-tenant: the resident's building, resolved server-side at login from
  // their email. The app points at one shared API (EXPO_PUBLIC_API_URL) for all
  // buildings — no building picker needed, since the JWT scopes every request.
  building_id?: string;
}

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  completeInvite: (token: string, name: string, password: string) => Promise<void>;
  updateUser: (patch: Partial<User>) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadStoredAuth();
  }, []);

  const loadStoredAuth = async () => {
    try {
      const stored = await SecureStore.getItemAsync('auth');
      if (stored) {
        const { user, accessToken, refreshToken } = JSON.parse(stored);
        // Try to refresh
        const res = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
        const newTokens = res.data.data;
        await saveAuth(user, newTokens.accessToken, newTokens.refreshToken);
        setUser(user);
        setAccessToken(newTokens.accessToken);
      }
    } catch {
      await SecureStore.deleteItemAsync('auth');
    } finally {
      setIsLoading(false);
    }
  };

  const saveAuth = async (user: User, accessToken: string, refreshToken: string) => {
    await SecureStore.setItemAsync('auth', JSON.stringify({ user, accessToken, refreshToken }));
    setUser(user);
    setAccessToken(accessToken);
    axios.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
    registerPushToken(accessToken);
  };

  const registerPushToken = async (token: string) => {
    try {
      if (Platform.OS === 'web') return;
      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') return;
      const { data: pushToken } = await Notifications.getExpoPushTokenAsync({
        projectId: 'cd194a68-e24e-4ae3-84cb-a25ba04e3e14',
      });
      await axios.post(`${API_URL}/users/push-token`, { token: pushToken }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Non-critical — silently ignore if push registration fails
    }
  };

  const login = async (email: string, password: string) => {
    const res = await axios.post(`${API_URL}/auth/login`, { email, password });
    const { user, accessToken, refreshToken } = res.data.data;
    await saveAuth(user, accessToken, refreshToken);
  };

  const completeInvite = async (token: string, name: string, password: string) => {
    const res = await axios.post(`${API_URL}/auth/register`, { token, name, password });
    const { user, accessToken, refreshToken } = res.data.data;
    await saveAuth(user, accessToken, refreshToken);
  };

  const updateUser = async (patch: Partial<User>) => {
    if (!user) return;
    const updated = { ...user, ...patch };
    const stored = await SecureStore.getItemAsync('auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      await SecureStore.setItemAsync('auth', JSON.stringify({ ...parsed, user: updated }));
    }
    setUser(updated);
  };

  const logout = async () => {
    try {
      await axios.post(`${API_URL}/auth/logout`);
    } catch {}
    await SecureStore.deleteItemAsync('auth');
    setUser(null);
    setAccessToken(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  const deleteAccount = async () => {
    // Throws on failure so the caller can show the server's error (e.g. sole admin)
    await axios.delete(`${API_URL}/users/me`);
    await SecureStore.deleteItemAsync('auth');
    setUser(null);
    setAccessToken(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  return (
    <AuthContext.Provider value={{ user, accessToken, isLoading, login, logout, deleteAccount, completeInvite, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
