import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Modal,
  Alert,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { API_URL } from '../constants/api';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';
import { useAuth } from '../contexts/AuthContext';

interface ScheduleDay {
  day: string;
  user_id: string | null;
  user_name: string | null;
  priority_user?: { id: string; name: string } | null;
}

interface PublicUser {
  id: string;
  name: string;
  role: string;
  priority_day: string | null;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

const DAY_LABEL: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
};

const RULES = [
  { icon: '⏱', text: 'Soft target: 2–4 hours' },
  { icon: '🔴', text: 'Hard cap: 6 hours max' },
  { icon: '📋', text: 'Announce in feed when plugging in' },
  { icon: '🚗', text: 'Move car promptly when done' },
];

const getTodayDayName = () => {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[new Date().getDay()];
};

export const ScheduleScreen = ({ navigation }: { navigation?: any }) => {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState<ScheduleDay[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  const fetchSchedule = useCallback(async () => {
    try {
      const [schedRes, usersRes] = await Promise.all([
        axios.get(`${API_URL}/schedule`),
        axios.get(`${API_URL}/users`),
      ]);
      setSchedule(schedRes.data.data.assignments ?? []);
      setUsers(usersRes.data.data ?? []);
    } catch (err) {
      console.error('fetchSchedule error', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const todayDay = getTodayDayName();
  const isAdmin = user?.role === 'admin';

  const getDayEntry = (day: string): ScheduleDay => {
    const found = schedule.find((s) => s.day === day);
    return found ?? { day, user_id: null, user_name: null };
  };

  const handleDayPress = (day: string, entry: ScheduleDay) => {
    const isToday = day === todayDay;
    const isMyDay = entry.user_id === user?.id;

    if (isAdmin) {
      setSelectedDay(day);
      setAssignModalVisible(true);
    } else if (isToday || isMyDay) {
      navigation?.navigate('Session');
    }
  };

  const handleAssign = async (userId: string | null) => {
    if (!selectedDay) return;
    setAssigning(true);
    try {
      const currentEntry = getDayEntry(selectedDay);
      if (currentEntry.user_id) {
        await axios.patch(`${API_URL}/users/${currentEntry.user_id}`, { priority_day: null });
      }
      if (userId) {
        await axios.patch(`${API_URL}/users/${userId}`, { priority_day: selectedDay });
      }
      setAssignModalVisible(false);
      setSelectedDay(null);
      await fetchSchedule();
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Failed to update schedule');
    } finally {
      setAssigning(false);
    }
  };

  const selectedDayEntry = selectedDay ? getDayEntry(selectedDay) : null;

  if (loading) {
    return (
      <MiamiBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </MiamiBackground>
    );
  }

  return (
    <MiamiBackground>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          style={styles.scrollView}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchSchedule(); }}
              tintColor={Colors.primary}
            />
          }
        >
          <Text style={[styles.title, StrongTextShadow]}>Schedule</Text>
          <Text style={[styles.subtitle, TextShadow]}>
            {isAdmin ? 'Tap a day to assign a resident' : 'Tap today or your day to start a session'}
          </Text>

          {/* Weekday Cards */}
          <View style={styles.grid}>
            {WEEKDAYS.map((day) => {
              const entry = getDayEntry(day);
              const isToday = day === todayDay;
              const isMyDay = entry.user_id === user?.id;
              const isTappable = isAdmin || isToday || isMyDay;

              const dayCardStyle: ViewStyle = {
                ...styles.dayCard,
                ...(isToday ? styles.todayCard : {}),
                ...(isMyDay ? styles.myDayCard : {}),
              };

              return (
                <TouchableOpacity
                  key={day}
                  onPress={() => handleDayPress(day, entry)}
                  activeOpacity={isTappable ? 0.7 : 1}
                  disabled={!isTappable}
                >
                  <GlassCard style={dayCardStyle}>
                    <View style={styles.dayCardInner}>
                      <View style={styles.dayCardLeft}>
                        <Text style={[styles.dayName, isToday && styles.dayNameToday]}>
                          {DAY_LABEL[day]}
                        </Text>
                        <Text style={[
                          styles.ownerName,
                          !entry.user_id && styles.ownerNameUnassigned,
                        ]}>
                          {entry.user_name ?? 'Unassigned'}
                        </Text>
                      </View>
                      <View style={styles.dayCardRight}>
                        {isToday && (
                          <View style={styles.todayBadge}>
                            <Text style={styles.todayBadgeText}>Today</Text>
                          </View>
                        )}
                        {isMyDay && !isToday && (
                          <View style={styles.myDayBadge}>
                            <Text style={styles.myDayBadgeText}>⭐ Your day</Text>
                          </View>
                        )}
                        {isAdmin && (
                          <Text style={styles.editHint}>
                            {entry.user_id ? '✏️' : '+ Assign'}
                          </Text>
                        )}
                      </View>
                    </View>
                  </GlassCard>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Weekend Card */}
          <GlassCard style={styles.weekendCard}>
            <Text style={styles.weekendTitle}>Sat & Sun</Text>
            <View style={styles.fcssBadge}>
              <Text style={styles.fcssBadgeText}>First Come, First Served</Text>
            </View>
            <Text style={styles.weekendDesc}>
              No reservations on weekends — whoever plugs in first gets the charger.
            </Text>
          </GlassCard>

          {/* Rules */}
          <Text style={[styles.sectionTitle, TextShadow]}>Rules at a Glance</Text>
          <GlassCard style={styles.rulesCard}>
            {RULES.map((rule, i) => (
              <View key={i} style={[styles.ruleRow, i < RULES.length - 1 && styles.ruleDivider]}>
                <Text style={styles.ruleIcon}>{rule.icon}</Text>
                <Text style={styles.ruleText}>{rule.text}</Text>
              </View>
            ))}
          </GlassCard>
        </ScrollView>
      </SafeAreaView>

      {/* Admin Assign Modal */}
      <Modal
        visible={assignModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => { setAssignModalVisible(false); setSelectedDay(null); }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>
              Assign {selectedDay ? DAY_LABEL[selectedDay] : ''}
            </Text>
            {selectedDayEntry?.user_id && (
              <Text style={styles.modalCurrent}>
                Currently: {selectedDayEntry.user_name}
              </Text>
            )}

            <ScrollView style={styles.modalList}>
              <TouchableOpacity
                style={styles.modalUserRow}
                onPress={() => handleAssign(null)}
                disabled={assigning}
              >
                <View style={[styles.modalAvatar, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
                  <Text style={styles.modalAvatarText}>—</Text>
                </View>
                <Text style={[styles.modalUserName, { color: Colors.text.secondary }]}>
                  Unassigned
                </Text>
              </TouchableOpacity>

              {users.map((u) => {
                const isCurrentlyAssigned = u.id === selectedDayEntry?.user_id;
                const hasOtherDay = u.priority_day && u.priority_day !== selectedDay;
                return (
                  <TouchableOpacity
                    key={u.id}
                    style={[styles.modalUserRow, isCurrentlyAssigned && styles.modalUserRowActive]}
                    onPress={() => handleAssign(u.id)}
                    disabled={assigning}
                  >
                    <View style={[styles.modalAvatar, { backgroundColor: Colors.primary }]}>
                      <Text style={styles.modalAvatarText}>
                        {u.name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalUserName}>{u.name}</Text>
                      {hasOtherDay && (
                        <Text style={styles.modalUserSub}>
                          Currently on {DAY_LABEL[u.priority_day!]}
                        </Text>
                      )}
                    </View>
                    {isCurrentlyAssigned && (
                      <Text style={{ color: Colors.primary }}>✓</Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => { setAssignModalVisible(false); setSelectedDay(null); }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  scrollView: { backgroundColor: 'transparent' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 20, gap: 16, paddingBottom: 40 },
  title: { fontSize: 34, fontWeight: '700', color: Colors.text.primary },
  subtitle: { fontSize: 14, color: 'rgba(255,255,255,0.7)', marginTop: 2, marginBottom: 4 },
  grid: { gap: 10 },
  dayCard: { marginBottom: 0 },
  todayCard: {
    borderWidth: 1.5,
    borderColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  myDayCard: {
    borderWidth: 1,
    borderColor: 'rgba(255, 214, 10, 0.45)',
  },
  dayCardInner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dayCardLeft: { gap: 4 },
  dayCardRight: { gap: 6, alignItems: 'flex-end' },
  dayName: { fontSize: 18, fontWeight: '700', color: Colors.text.primary },
  dayNameToday: { color: Colors.primary },
  ownerName: { fontSize: 15, fontWeight: '500', color: Colors.text.secondary },
  ownerNameUnassigned: { color: Colors.text.tertiary, fontStyle: 'italic' },
  todayBadge: {
    backgroundColor: 'rgba(0, 122, 255, 0.25)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(0, 122, 255, 0.5)',
  },
  todayBadgeText: { color: Colors.primary, fontSize: 12, fontWeight: '700' },
  myDayBadge: {
    backgroundColor: 'rgba(255, 214, 10, 0.18)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 214, 10, 0.40)',
  },
  myDayBadgeText: { color: '#FFD60A', fontSize: 12, fontWeight: '700' },
  editHint: { color: Colors.text.tertiary, fontSize: 13 },
  weekendCard: {},
  weekendTitle: { fontSize: 18, fontWeight: '700', color: Colors.text.primary, marginBottom: 8 },
  fcssBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  fcssBadgeText: { color: Colors.text.secondary, fontSize: 12, fontWeight: '600' },
  weekendDesc: { fontSize: 14, color: Colors.text.secondary, lineHeight: 20 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: Colors.text.primary, marginTop: 4 },
  rulesCard: {},
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 4 },
  ruleDivider: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)', paddingBottom: 12, marginBottom: 8 },
  ruleIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  ruleText: { flex: 1, fontSize: 15, color: Colors.text.secondary, lineHeight: 22 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: 'rgba(18,18,24,0.97)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    maxHeight: '75%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: Colors.text.primary, marginBottom: 4 },
  modalCurrent: { fontSize: 14, color: Colors.text.secondary, marginBottom: 16 },
  modalList: { marginBottom: 16 },
  modalUserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  modalUserRowActive: { backgroundColor: 'rgba(0,122,255,0.10)', borderRadius: 12, paddingHorizontal: 8 },
  modalAvatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  modalAvatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  modalUserName: { fontSize: 16, fontWeight: '500', color: Colors.text.primary },
  modalUserSub: { fontSize: 12, color: Colors.text.tertiary, marginTop: 2 },
  modalCancel: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  modalCancelText: { color: Colors.text.secondary, fontSize: 16, fontWeight: '600' },
});
