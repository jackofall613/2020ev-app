import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { API_URL } from '../constants/api';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';
import { useAuth } from '../contexts/AuthContext';

type SessionType = 'top_up' | 'normal' | 'long';

interface Session {
  id: string;
  user_id: string;
  user_name: string;
  type: SessionType;
  estimated_hours: number;
  estimated_end: string;
  started_at: string;
  notes?: string;
}

const SESSION_TYPE_OPTIONS: { key: SessionType; label: string }[] = [
  { key: 'top_up', label: 'Top-up · 1-2h' },
  { key: 'normal', label: 'Normal · 2-4h' },
  { key: 'long', label: 'Long · 4-6h' },
];

const DURATION_OPTIONS: Record<SessionType, number[]> = {
  top_up: [1, 1.5, 2],
  normal: [2, 3, 4],
  long: [4, 5, 6],
};

const formatHour = (h: number) => {
  if (h === Math.floor(h)) return `${h}h`;
  return `${Math.floor(h)}h ${(h % 1) * 60}m`;
};

const formatTime = (date: Date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const getElapsed = (startedAt: string) => {
  const diff = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
};

const getTimeRemaining = (estimatedEnd: string) => {
  const diff = new Date(estimatedEnd).getTime() - Date.now();
  if (diff <= 0) return 'Overdue';
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m remaining` : `${mins}m remaining`;
};

const TYPE_LABEL: Record<SessionType, string> = {
  top_up: 'Top-up',
  normal: 'Normal',
  long: 'Long',
};

export const SessionScreen = () => {
  const { user } = useAuth();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state
  const [selectedType, setSelectedType] = useState<SessionType>('normal');
  const [selectedHours, setSelectedHours] = useState<number>(3);
  const [customHoursText, setCustomHoursText] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchSession = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/sessions/active`);
      setSession(res.data.data);
    } catch (err) {
      console.error('fetchSession error', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSession();
    const interval = setInterval(fetchSession, 15000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  const handleTypeChange = (type: SessionType) => {
    setSelectedType(type);
    setSelectedHours(DURATION_OPTIONS[type][0]);
    setUseCustom(false);
    setCustomHoursText('');
  };

  const getEffectiveHours = (): number => {
    if (useCustom) {
      const parsed = parseFloat(customHoursText);
      return isNaN(parsed) ? 0 : parsed;
    }
    return selectedHours;
  };

  const getFinishTime = () => {
    const hours = getEffectiveHours();
    if (!hours) return null;
    const finish = new Date(Date.now() + hours * 60 * 60 * 1000);
    return formatTime(finish);
  };

  const handleStart = async () => {
    const hours = getEffectiveHours();
    if (!hours || hours <= 0) {
      Alert.alert('Error', 'Please select or enter a valid duration.');
      return;
    }
    setSubmitting(true);
    try {
      await axios.post(`${API_URL}/sessions/start`, {
        type: selectedType,
        estimated_hours: hours,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setNotes('');
      setUseCustom(false);
      setCustomHoursText('');
      await fetchSession();
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Could not start session.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnd = async () => {
    if (!session) return;
    Alert.alert('End Session', 'Unplug and announce to the group?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Done — Unplug',
        style: 'default',
        onPress: async () => {
          setSubmitting(true);
          try {
            const res = await axios.post(`${API_URL}/sessions/${session.id}/end`);
            await fetchSession();
            if (res.data?.queue_notified) {
              Alert.alert(
                'Charger released',
                'The next resident in the queue has been notified — the charger is held for them.'
              );
            }
          } catch (err: any) {
            Alert.alert('Error', err?.response?.data?.error || 'Could not end session.');
          } finally {
            setSubmitting(false);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <MiamiBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </MiamiBackground>
    );
  }

  const isMySession = session && user && session.user_id === user.id;
  const isSomeoneElsesSession = session && !isMySession;
  const chargerAvailable = !session;

  return (
    <MiamiBackground>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            style={styles.scrollView}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.title, StrongTextShadow]}>Session</Text>

            {/* ── CHARGER AVAILABLE ── */}
            {chargerAvailable && (
              <>
                <GlassCard style={styles.availableCard}>
                  <View style={styles.statusRow}>
                    <View style={[styles.dot, { backgroundColor: Colors.charger.available, shadowColor: Colors.charger.available, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }]} />
                    <Text style={[styles.statusText, { color: Colors.charger.available }]}>
                      Charger Available
                    </Text>
                  </View>
                  <Text style={styles.availableHint}>Start a session to claim the charger.</Text>
                </GlassCard>

                {/* Session Type Picker */}
                <Text style={[styles.sectionLabel, TextShadow]}>Session type</Text>
                <View style={styles.typeRow}>
                  {SESSION_TYPE_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        styles.typeBtn,
                        selectedType === opt.key && styles.typeBtnActive,
                      ]}
                      onPress={() => handleTypeChange(opt.key)}
                    >
                      <Text
                        style={[
                          styles.typeBtnText,
                          selectedType === opt.key && styles.typeBtnTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Duration Presets */}
                <Text style={[styles.sectionLabel, TextShadow]}>Estimated duration</Text>
                <View style={styles.durationRow}>
                  {DURATION_OPTIONS[selectedType].map((h) => (
                    <TouchableOpacity
                      key={h}
                      style={[
                        styles.durationBtn,
                        !useCustom && selectedHours === h && styles.durationBtnActive,
                      ]}
                      onPress={() => {
                        setSelectedHours(h);
                        setUseCustom(false);
                        setCustomHoursText('');
                      }}
                    >
                      <Text
                        style={[
                          styles.durationBtnText,
                          !useCustom && selectedHours === h && styles.durationBtnTextActive,
                        ]}
                      >
                        {formatHour(h)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[styles.durationBtn, useCustom && styles.durationBtnActive]}
                    onPress={() => setUseCustom(true)}
                  >
                    <Text
                      style={[styles.durationBtnText, useCustom && styles.durationBtnTextActive]}
                    >
                      Custom
                    </Text>
                  </TouchableOpacity>
                </View>

                {useCustom && (
                  <TextInput
                    style={styles.customInput}
                    value={customHoursText}
                    onChangeText={setCustomHoursText}
                    placeholder="Hours (e.g. 2.5)"
                    placeholderTextColor={Colors.text.tertiary}
                    keyboardType="decimal-pad"
                  />
                )}

                {/* Notes */}
                <Text style={[styles.sectionLabel, TextShadow]}>Notes (optional)</Text>
                <TextInput
                  style={[styles.customInput, styles.notesInput]}
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="e.g. leaving early today"
                  placeholderTextColor={Colors.text.tertiary}
                  multiline
                />

                {/* Start Button */}
                <TouchableOpacity
                  style={[styles.startBtn, submitting && styles.btnDisabled]}
                  onPress={handleStart}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.startBtnText}>⚡ Plug In & Announce</Text>
                  )}
                </TouchableOpacity>

                {getFinishTime() && (
                  <Text style={[styles.finishHint, TextShadow]}>Done around {getFinishTime()}</Text>
                )}
              </>
            )}

            {/* ── MY ACTIVE SESSION ── */}
            {isMySession && session && (
              <>
                <GlassCard style={styles.mySessionCard}>
                  <View style={styles.statusRow}>
                    <View style={[styles.dot, { backgroundColor: Colors.charger.inUse, shadowColor: Colors.charger.inUse, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }]} />
                    <Text style={[styles.statusText, { color: Colors.charger.inUse }]}>
                      Your Session Active
                    </Text>
                  </View>
                  <View style={styles.badgeRow}>
                    <View style={styles.typeBadge}>
                      <Text style={styles.typeBadgeText}>{TYPE_LABEL[session.type]}</Text>
                    </View>
                  </View>
                  <Text style={styles.sessionStatLabel}>Elapsed</Text>
                  <Text style={styles.sessionStatValue}>{getElapsed(session.started_at)}</Text>
                  <Text style={styles.sessionStatLabel}>Est. finish</Text>
                  <Text style={styles.sessionStatValue}>
                    {formatTime(new Date(session.estimated_end))}
                    {'  '}
                    <Text style={styles.sessionTimeRemaining}>
                      ({getTimeRemaining(session.estimated_end)})
                    </Text>
                  </Text>
                  {session.notes ? (
                    <>
                      <Text style={styles.sessionStatLabel}>Notes</Text>
                      <Text style={styles.sessionStatValue}>{session.notes}</Text>
                    </>
                  ) : null}
                </GlassCard>

                <TouchableOpacity
                  style={[styles.endBtn, submitting && styles.btnDisabled]}
                  onPress={handleEnd}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.endBtnText}>Done — Unplug & Announce</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {/* ── SOMEONE ELSE'S SESSION ── */}
            {isSomeoneElsesSession && session && (
              <GlassCard style={styles.otherSessionCard}>
                <View style={styles.statusRow}>
                  <View style={[styles.dot, { backgroundColor: Colors.charger.inUse, shadowColor: Colors.charger.inUse, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }]} />
                  <Text style={[styles.statusText, { color: Colors.charger.inUse }]}>
                    Charger In Use
                  </Text>
                </View>
                <Text style={styles.otherUserName}>{session.user_name}</Text>
                <View style={styles.badgeRow}>
                  <View style={styles.typeBadge}>
                    <Text style={styles.typeBadgeText}>{TYPE_LABEL[session.type]}</Text>
                  </View>
                </View>
                <Text style={styles.sessionStatLabel}>Est. finish</Text>
                <Text style={styles.sessionStatValue}>
                  {formatTime(new Date(session.estimated_end))}
                  {'  '}
                  <Text style={styles.sessionTimeRemaining}>
                    ({getTimeRemaining(session.estimated_end)})
                  </Text>
                </Text>
                <Text style={styles.inUseHint}>
                  The charger is currently occupied. Check back later.
                </Text>
              </GlassCard>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  scrollView: { backgroundColor: 'transparent' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 20, gap: 16, paddingBottom: 40 },
  title: {
    fontSize: 34,
    fontWeight: '700',
    color: Colors.text.primary,
    marginBottom: 4,
  },
  sectionLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '500',
    marginBottom: 8,
    marginTop: 4,
  },
  availableCard: {},
  availableHint: { fontSize: 14, color: Colors.text.secondary, marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 16, fontWeight: '600' },

  // Type picker
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  typeBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(10,15,40,0.85)',
    alignItems: 'center',
  },
  typeBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  typeBtnText: { fontSize: 12, color: Colors.text.secondary, fontWeight: '500', textAlign: 'center' },
  typeBtnTextActive: { color: '#fff', fontWeight: '700' },

  // Duration presets
  durationRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  durationBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(10,15,40,0.85)',
    alignItems: 'center',
  },
  durationBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  durationBtnText: { fontSize: 14, color: Colors.text.secondary, fontWeight: '500' },
  durationBtnTextActive: { color: '#fff', fontWeight: '700' },

  customInput: {
    backgroundColor: 'rgba(10,15,40,0.85)',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: Colors.text.primary,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  notesInput: { minHeight: 72, textAlignVertical: 'top' },

  // Start button
  startBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 6,
  },
  startBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  finishHint: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    marginTop: -4,
  },
  btnDisabled: { opacity: 0.6 },

  // My session card
  mySessionCard: {},
  badgeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  typeBadge: {
    backgroundColor: 'rgba(255, 159, 10, 0.25)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 159, 10, 0.5)',
  },
  typeBadgeText: { color: Colors.warning, fontSize: 12, fontWeight: '600' },
  sessionStatLabel: { fontSize: 12, color: Colors.text.tertiary, marginTop: 8 },
  sessionStatValue: { fontSize: 18, fontWeight: '600', color: Colors.text.primary, marginTop: 2 },
  sessionTimeRemaining: { fontSize: 14, color: Colors.warning, fontWeight: '400' },

  // End button
  endBtn: {
    backgroundColor: Colors.success,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 4,
    shadowColor: Colors.success,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 6,
  },
  endBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },

  // Someone else's session
  otherSessionCard: {},
  otherUserName: { fontSize: 22, fontWeight: '700', color: Colors.text.primary, marginBottom: 8 },
  inUseHint: { fontSize: 14, color: Colors.text.tertiary, marginTop: 10 },
});
