import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';

interface Props {
  inviteToken: string;
  onCancel: () => void;
}

export const RegisterScreen = ({ inviteToken, onCancel }: Props) => {
  const { completeInvite } = useAuth();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!name.trim()) {
      Alert.alert('Missing info', 'Please enter your full name.');
      return;
    }
    if (password.length < 12) {
      Alert.alert('Weak password', 'Password must be at least 12 characters.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Password mismatch', 'Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await completeInvite(inviteToken, name.trim(), password);
      // completeInvite logs the user in automatically — AppNavigator will swap to tabs
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Something went wrong. The invite may have expired.';
      Alert.alert('Registration failed', msg);
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
            <Text style={[styles.title, StrongTextShadow]}>Join 2020EV</Text>
            <Text style={[styles.subtitle, TextShadow]}>Create your resident account</Text>
          </View>

          <GlassCard style={styles.card}>
            <Text style={styles.inputLabel}>Your Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="First Last"
              placeholderTextColor={Colors.text.tertiary}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
            />

            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="At least 8 characters"
              placeholderTextColor={Colors.text.tertiary}
              secureTextEntry
              returnKeyType="next"
            />

            <Text style={styles.inputLabel}>Confirm Password</Text>
            <TextInput
              style={styles.input}
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Repeat password"
              placeholderTextColor={Colors.text.tertiary}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={handleRegister}
            />

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleRegister}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Create Account</Text>
              )}
            </TouchableOpacity>
          </GlassCard>

          <TouchableOpacity onPress={onCancel} style={styles.cancelRow}>
            <Text style={[styles.cancelText, TextShadow]}>Already have an account? Sign in</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  keyboardView: { flex: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 40 },
  logo: { fontSize: 56, marginBottom: 8 },
  title: { fontSize: 36, fontWeight: '800', color: Colors.text.primary, letterSpacing: -0.5 },
  subtitle: { fontSize: 16, color: 'rgba(255,255,255,0.75)', marginTop: 6, fontWeight: '400' },
  card: {},
  inputLabel: { fontSize: 13, color: Colors.text.secondary, marginBottom: 6, fontWeight: '500' },
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
  cancelRow: { alignItems: 'center', marginTop: 20 },
  cancelText: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },
});
