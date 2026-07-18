import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';

export const LoginScreen = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter your email and password');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (err: any) {
      Alert.alert('Login Failed', err?.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MiamiBackground extraDim>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.keyboardView}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <Text style={styles.logo}>⚡</Text>
            <Text style={[styles.title, StrongTextShadow]}>2020EV</Text>
            <Text style={[styles.subtitle, TextShadow]}>Shared Charger Community</Text>
          </View>

          <GlassCard style={styles.card}>
            <Text style={styles.inputLabel}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@email.com"
              placeholderTextColor={Colors.text.tertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="password"
              placeholderTextColor={Colors.text.tertiary}
              secureTextEntry
            />

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Sign In</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => Linking.openURL('https://2020ev-admin.vercel.app/reset')}
              style={styles.forgotBtn}
            >
              <Text style={styles.forgotText}>Forgot password?</Text>
            </TouchableOpacity>
          </GlassCard>

          <Text style={[styles.footer, TextShadow]}>
            Don't have access? Ask an admin for an invite.
          </Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  keyboardView: { flex: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 40 },
  logo: { fontSize: 64, marginBottom: 8 },
  title: { fontSize: 40, fontWeight: '800', color: Colors.text.primary, letterSpacing: -1 },
  subtitle: { fontSize: 17, color: 'rgba(255,255,255,0.8)', marginTop: 6, fontWeight: '400', letterSpacing: 0.3 },
  card: {},
  inputLabel: { fontSize: 13, color: Colors.text.secondary, marginBottom: 6, fontWeight: '500' },
  forgotBtn: { alignSelf: 'center', marginTop: 14, padding: 4 },
  forgotText: { color: Colors.text.secondary, fontSize: 14, fontWeight: '500' },
  input: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: Colors.text.primary,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    marginBottom: 16,
  },
  button: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 6,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  footer: { textAlign: 'center', color: 'rgba(255,255,255,0.5)', marginTop: 24, fontSize: 14 },
});
