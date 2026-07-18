import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  Modal,
  Alert,
  ActivityIndicator,
  Share,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import axios from 'axios';
import { API_URL } from '../constants/api';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';
import { useAuth } from '../contexts/AuthContext';

const AVATAR_COLORS = [
  '#5E5CE6',
  '#30D158',
  '#0A84FF',
  '#FF453A',
  '#FF9F0A',
  '#AC8E68',
];

const getAvatarColor = (userId: string) => {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const getInitials = (name: string) => {
  const parts = name.trim().split(' ');
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

const DEFAULT_RULES = [
  { icon: '⏱', text: 'Soft target: 2–4 hours' },
  { icon: '🔴', text: 'Hard cap: 6 hours max' },
  { icon: '📋', text: 'Announce in feed when plugging in' },
  { icon: '🚗', text: 'Move car promptly when done' },
];

const DAY_LABEL: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
};

export const ProfileScreen = () => {
  const { user, logout, deleteAccount, updateUser } = useAuth();

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This permanently removes your name, email, photo, and login. Your past charging history stays on the building’s books anonymously. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete My Account',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount();
            } catch (err: any) {
              Alert.alert('Error', err?.response?.data?.error || 'Could not delete account. Please try again.');
            }
          },
        },
      ]
    );
  };

  // Rules — fetched from API, fallback to defaults
  const [rules, setRules] = useState(DEFAULT_RULES);
  useEffect(() => {
    axios.get(`${API_URL}/settings/rules`)
      .then(res => { if (res.data?.data) setRules(res.data.data); })
      .catch(() => {}); // silently fall back to defaults
  }, []);

  // Avatar upload
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const handlePickAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in Settings to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.25,   // Lower quality keeps base64 payload well under 1MB
      base64: true,
    });
    if (result.canceled || !result.assets[0].base64) return;
    const avatarUrl = `data:image/jpeg;base64,${result.assets[0].base64}`;
    setUploadingAvatar(true);
    try {
      await axios.patch(`${API_URL}/users/me`, { avatar_url: avatarUrl });
      await updateUser({ avatar_url: avatarUrl });
    } catch {
      Alert.alert('Error', 'Could not update profile photo.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  // Unit editing
  const [editingUnit, setEditingUnit] = useState(false);
  const [unitText, setUnitText] = useState(user?.unit_number ?? '');
  const [savingUnit, setSavingUnit] = useState(false);

  // Notifications toggle — requests permission and saves/clears Expo push token on server
  const [notifsEnabled, setNotifsEnabled] = useState(false);
  useEffect(() => {
    SecureStore.getItemAsync('notifs_enabled').then((val) => setNotifsEnabled(val === 'true'));
  }, []);

  const handleNotifsToggle = async (val: boolean) => {
    if (val) {
      // Request permission
      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') {
        Alert.alert(
          'Notifications blocked',
          'Enable notifications for 2020EV in Settings → Notifications.'
        );
        return; // don't flip the toggle
      }
      try {
        const tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: 'cd194a68-e24e-4ae3-84cb-a25ba04e3e14',
        });
        await axios.patch(`${API_URL}/users/me`, { push_token: tokenData.data });
      } catch { /* non-fatal — token saved next time */ }
    } else {
      // Clear push token from server so no pushes are sent
      try {
        await axios.patch(`${API_URL}/users/me`, { push_token: null });
      } catch { /* non-fatal */ }
    }
    setNotifsEnabled(val);
    await SecureStore.setItemAsync('notifs_enabled', val ? 'true' : 'false');
  };

  // Rules expand
  const [rulesExpanded, setRulesExpanded] = useState(false);

  // Admin: Users modal (inline list)
  const [usersModalVisible, setUsersModalVisible] = useState(false);
  const [usersList, setUsersList] = useState<{ id: string; name: string; role: string; email: string }[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await axios.get(`${API_URL}/users`);
      setUsersList(res.data.data ?? []);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Could not load users.');
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const openUsersModal = () => {
    setUsersModalVisible(true);
    fetchUsers();
  };

  // Admin: Invite modal
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) {
      Alert.alert('Error', 'Please enter an email address.');
      return;
    }
    setInviteLoading(true);
    try {
      const res = await axios.post(`${API_URL}/auth/invite`, { email: inviteEmail.trim().toLowerCase() });
      const data = res.data.data;
      const token = data?.token ?? data?.invite_token ?? '';
      const url = token
        ? `ev2020://invite?token=${token}`
        : JSON.stringify(data);
      setInviteResult(url);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Could not generate invite.');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleCopyInvite = async () => {
    if (inviteResult) {
      await Share.share({ message: inviteResult });
    }
  };

  const handleSaveUnit = async () => {
    setSavingUnit(true);
    try {
      await axios.patch(`${API_URL}/users/me`, { unit_number: unitText.trim() });
      await updateUser({ unit_number: unitText.trim() });
      setEditingUnit(false);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Could not save unit number.');
    } finally {
      setSavingUnit(false);
    }
  };

  // Car profile editing (v1.1 — car profiles)
  const [editingCar, setEditingCar] = useState(false);
  const [savingCar, setSavingCar] = useState(false);
  const [carMakeText, setCarMakeText] = useState(user?.car_make ?? '');
  const [carModelText, setCarModelText] = useState(user?.car_model ?? '');
  const [batteryText, setBatteryText] = useState(user?.battery_kwh != null ? String(user.battery_kwh) : '');
  const [targetText, setTargetText] = useState(user?.target_percent != null ? String(user.target_percent) : '');

  const cancelCarEdit = () => {
    setEditingCar(false);
    setCarMakeText(user?.car_make ?? '');
    setCarModelText(user?.car_model ?? '');
    setBatteryText(user?.battery_kwh != null ? String(user.battery_kwh) : '');
    setTargetText(user?.target_percent != null ? String(user.target_percent) : '');
  };

  const handleSaveCar = async () => {
    const make = carMakeText.trim();
    const model = carModelText.trim();
    const batteryStr = batteryText.trim();
    const targetStr = targetText.trim();

    let battery: number | null = null;
    if (batteryStr) {
      battery = Number(batteryStr);
      if (!Number.isFinite(battery) || battery < 10 || battery > 300) {
        Alert.alert('Invalid battery size', 'Battery capacity must be between 10 and 300 kWh.');
        return;
      }
    }

    let target: number | null = null;
    if (targetStr) {
      target = Number(targetStr);
      if (!Number.isInteger(target) || target < 50 || target > 100) {
        Alert.alert('Invalid charge target', 'Charge target must be a whole number between 50 and 100%.');
        return;
      }
    }

    const body = {
      car_make: make || null,
      car_model: model || null,
      battery_kwh: battery,
      target_percent: target,
    };

    setSavingCar(true);
    try {
      await axios.patch(`${API_URL}/users/me`, body);
      await updateUser(body);
      setEditingCar(false);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Could not save car details.');
    } finally {
      setSavingCar(false);
    }
  };

  if (!user) return null;

  const avatarColor = getAvatarColor(user.id);
  const priorityDayLabel = user.priority_day ? (DAY_LABEL[user.priority_day] ?? user.priority_day) : null;

  // "Hyundai Ioniq 5 · 77 kWh · target 80%" — omit missing pieces gracefully
  const carSummaryParts: string[] = [];
  const carName = [user.car_make, user.car_model].filter(Boolean).join(' ');
  if (carName) carSummaryParts.push(carName);
  if (user.battery_kwh != null) carSummaryParts.push(`${user.battery_kwh} kWh`);
  if (user.target_percent != null) carSummaryParts.push(`target ${user.target_percent}%`);
  const carSummary = carSummaryParts.join(' · ');

  return (
    <MiamiBackground>
      <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} style={styles.scrollView}>
        {/* Avatar + Name */}
        <View style={styles.avatarSection}>
          <TouchableOpacity onPress={handlePickAvatar} disabled={uploadingAvatar} activeOpacity={0.8} style={styles.avatarWrapper}>
            {user.avatar_url ? (
              <Image source={{ uri: user.avatar_url }} style={styles.avatarCircle} />
            ) : (
              <View style={[styles.avatarCircle, { backgroundColor: avatarColor }]}>
                <Text style={styles.avatarText}>{getInitials(user.name)}</Text>
              </View>
            )}
            <View style={styles.avatarEditBadge}>
              {uploadingAvatar ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.avatarEditIcon}>📷</Text>
              )}
            </View>
          </TouchableOpacity>
          <Text style={[styles.userName, StrongTextShadow]}>{user.name}</Text>
          {user.role === 'admin' && (
            <View style={styles.adminBadge}>
              <Text style={styles.adminBadgeText}>Admin</Text>
            </View>
          )}
          <Text style={[styles.priorityDayText, TextShadow]}>
            {priorityDayLabel
              ? `Your priority day: ${priorityDayLabel}`
              : 'No day assigned'}
          </Text>
        </View>

        {/* Unit Number */}
        <GlassCard style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>Unit Number</Text>
              {editingUnit ? (
                <View style={styles.unitEditRow}>
                  <TextInput
                    style={styles.unitInput}
                    value={unitText}
                    onChangeText={setUnitText}
                    placeholder="e.g. 204"
                    placeholderTextColor={Colors.text.tertiary}
                    keyboardType="default"
                    autoFocus
                  />
                  <TouchableOpacity
                    style={[styles.saveUnitBtn, savingUnit && styles.btnDisabled]}
                    onPress={handleSaveUnit}
                    disabled={savingUnit}
                  >
                    {savingUnit ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.saveUnitBtnText}>Save</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.cancelUnitBtn}
                    onPress={() => { setEditingUnit(false); setUnitText(user.unit_number ?? ''); }}
                  >
                    <Text style={styles.cancelUnitBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text style={styles.unitValue}>
                  {user.unit_number ? `#${user.unit_number}` : 'Not set'}
                </Text>
              )}
            </View>
            {!editingUnit && (
              <TouchableOpacity onPress={() => setEditingUnit(true)} style={styles.editBtn}>
                <Text style={styles.editBtnText}>✏️</Text>
              </TouchableOpacity>
            )}
          </View>
        </GlassCard>

        {/* Your car */}
        <GlassCard style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>🚗 Your car</Text>
              {editingCar ? (
                <View style={styles.carEditBox}>
                  <TextInput
                    style={styles.carInput}
                    value={carMakeText}
                    onChangeText={setCarMakeText}
                    placeholder="e.g. Hyundai"
                    placeholderTextColor={Colors.text.tertiary}
                    autoFocus
                  />
                  <TextInput
                    style={styles.carInput}
                    value={carModelText}
                    onChangeText={setCarModelText}
                    placeholder="e.g. Ioniq 5"
                    placeholderTextColor={Colors.text.tertiary}
                  />
                  <View style={styles.carInputRow}>
                    <TextInput
                      style={[styles.carInput, { flex: 1 }]}
                      value={batteryText}
                      onChangeText={setBatteryText}
                      placeholder="kWh e.g. 77"
                      placeholderTextColor={Colors.text.tertiary}
                      keyboardType="numeric"
                    />
                    <Text style={styles.carSuffix}>kWh</Text>
                  </View>
                  <View style={styles.carInputRow}>
                    <TextInput
                      style={[styles.carInput, { flex: 1 }]}
                      value={targetText}
                      onChangeText={setTargetText}
                      placeholder="e.g. 80"
                      placeholderTextColor={Colors.text.tertiary}
                      keyboardType="numeric"
                    />
                    <Text style={styles.carSuffix}>%</Text>
                  </View>
                  <View style={styles.carBtnRow}>
                    <TouchableOpacity
                      style={[styles.saveUnitBtn, savingCar && styles.btnDisabled]}
                      onPress={handleSaveCar}
                      disabled={savingCar}
                    >
                      {savingCar ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.saveUnitBtnText}>Save</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.cancelUnitBtn} onPress={cancelCarEdit}>
                      <Text style={styles.cancelUnitBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : carSummary ? (
                <Text style={styles.unitValue}>{carSummary}</Text>
              ) : (
                <Text style={styles.carEmptyText}>
                  Add your car to show neighbors an honest finish estimate
                </Text>
              )}
            </View>
            {!editingCar && (
              <TouchableOpacity onPress={() => setEditingCar(true)} style={styles.editBtn}>
                <Text style={styles.editBtnText}>✏️</Text>
              </TouchableOpacity>
            )}
          </View>
        </GlassCard>

        {/* Notifications */}
        <GlassCard style={styles.card}>
          <Text style={styles.sectionTitle}>Notifications</Text>
          <View style={styles.rowBetween}>
            <Text style={styles.rowLabel}>Enable Notifications</Text>
            <Switch
              value={notifsEnabled}
              onValueChange={handleNotifsToggle}
              trackColor={{ false: Colors.background.glass, true: Colors.primary }}
              thumbColor="#fff"
            />
          </View>
        </GlassCard>

        {/* Rules */}
        <GlassCard style={styles.card}>
          <TouchableOpacity
            style={styles.rowBetween}
            onPress={() => setRulesExpanded((v) => !v)}
            activeOpacity={0.7}
          >
            <Text style={styles.rowLabel}>Rules</Text>
            <Text style={styles.chevron}>{rulesExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>
          {rulesExpanded && (
            <View style={styles.rulesExpanded}>
              {rules.map((rule, i) => (
                <View key={i} style={[styles.ruleRow, i < rules.length - 1 && styles.ruleDivider]}>
                  <Text style={styles.ruleIcon}>{rule.icon}</Text>
                  <Text style={styles.ruleText}>{rule.text}</Text>
                </View>
              ))}
            </View>
          )}
        </GlassCard>

        {/* Admin Section */}
        {user.role === 'admin' && (
          <GlassCard style={styles.card}>
            <Text style={styles.sectionTitle}>Admin</Text>

            <TouchableOpacity style={styles.adminRow} onPress={openUsersModal}>
              <Text style={styles.adminRowText}>Manage Users</Text>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>

            <View style={styles.rowDivider} />

            <TouchableOpacity
              style={styles.adminRow}
              onPress={() => {
                setInviteEmail('');
                setInviteResult(null);
                setInviteModalVisible(true);
              }}
            >
              <Text style={styles.adminRowText}>Invite User</Text>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          </GlassCard>
        )}

        {/* Sign Out */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={() =>
            Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign Out', style: 'destructive', onPress: logout },
            ])
          }
        >
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* Delete Account — required by App Store Guideline 5.1.1(v) */}
        <TouchableOpacity style={styles.deleteAccountBtn} onPress={handleDeleteAccount}>
          <Text style={styles.deleteAccountText}>Delete Account</Text>
        </TouchableOpacity>
      </ScrollView>
      </SafeAreaView>

      {/* ── MANAGE USERS MODAL ── */}
      <Modal
        visible={usersModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setUsersModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Manage Users</Text>
            <TouchableOpacity onPress={() => setUsersModalVisible(false)}>
              <Text style={styles.modalClose}>Done</Text>
            </TouchableOpacity>
          </View>
          {loadingUsers ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={Colors.primary} />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {usersList.map((u) => (
                <View key={u.id} style={styles.userRow}>
                  <View style={[styles.userAvatar, { backgroundColor: getAvatarColor(u.id) }]}>
                    <Text style={styles.userAvatarText}>{getInitials(u.name)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.userRowName}>{u.name}</Text>
                    <Text style={styles.userRowEmail}>{u.email}</Text>
                  </View>
                  {u.role === 'admin' && (
                    <View style={styles.adminBadge}>
                      <Text style={styles.adminBadgeText}>Admin</Text>
                    </View>
                  )}
                </View>
              ))}
              {usersList.length === 0 && (
                <Text style={styles.emptyText}>No users found.</Text>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* ── INVITE USER MODAL ── */}
      <Modal
        visible={inviteModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setInviteModalVisible(false);
          setInviteEmail('');
          setInviteResult(null);
        }}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Invite User</Text>
            <TouchableOpacity onPress={() => { setInviteModalVisible(false); setInviteEmail(''); setInviteResult(null); }}>
              <Text style={styles.modalClose}>Done</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.inviteBody}>
            <Text style={styles.inviteLabel}>Email address</Text>
            <TextInput
              style={styles.inviteInput}
              value={inviteEmail}
              onChangeText={setInviteEmail}
              placeholder="resident@example.com"
              placeholderTextColor={Colors.text.tertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.inviteBtn, inviteLoading && styles.btnDisabled]}
              onPress={handleInvite}
              disabled={inviteLoading}
            >
              {inviteLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.inviteBtnText}>Generate Invite</Text>
              )}
            </TouchableOpacity>

            {inviteResult && (
              <View style={styles.inviteResultBox}>
                <Text style={styles.inviteResultLabel}>Invite URL</Text>
                <Text style={styles.inviteResultUrl} selectable>{inviteResult}</Text>
                <TouchableOpacity style={styles.copyBtn} onPress={handleCopyInvite}>
                  <Text style={styles.copyBtnText}>Copy Link</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  scrollView: { backgroundColor: 'transparent' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scroll: { padding: 20, gap: 16, paddingBottom: 100 },

  // Avatar section
  avatarSection: { alignItems: 'center', marginTop: 8, marginBottom: 8, gap: 8 },
  avatarWrapper: {
    position: 'relative',
    width: 88,
    height: 88,
  },
  avatarCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarEditBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#0A0F1E',
  },
  avatarEditIcon: { fontSize: 14 },
  avatarText: { color: '#fff', fontSize: 30, fontWeight: '800' },
  userName: { fontSize: 26, fontWeight: '700', color: Colors.text.primary },
  adminBadge: {
    backgroundColor: 'rgba(255, 214, 10, 0.15)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 214, 10, 0.35)',
  },
  adminBadgeText: { color: '#FFD60A', fontSize: 13, fontWeight: '700' },
  priorityDayText: { fontSize: 14, color: Colors.text.secondary, marginTop: 2 },

  // Cards
  card: { marginBottom: 0 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.text.primary, marginBottom: 14 },
  cardLabel: { fontSize: 12, color: Colors.text.tertiary, marginBottom: 6, fontWeight: '500' },

  // Unit
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  unitEditRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  unitInput: {
    flex: 1,
    backgroundColor: Colors.background.glass,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    color: Colors.text.primary,
    borderWidth: 1,
    borderColor: Colors.border.glass,
  },
  unitValue: { fontSize: 17, color: Colors.text.primary, fontWeight: '500' },
  editBtn: { padding: 6 },
  editBtnText: { fontSize: 20 },
  saveUnitBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  saveUnitBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  cancelUnitBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  cancelUnitBtnText: { color: Colors.text.secondary, fontSize: 14 },
  btnDisabled: { opacity: 0.6 },

  // Your car
  carEditBox: { marginTop: 6, gap: 8 },
  carInput: {
    backgroundColor: Colors.background.glass,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    color: Colors.text.primary,
    borderWidth: 1,
    borderColor: Colors.border.glass,
  },
  carInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  carSuffix: { fontSize: 14, color: Colors.text.secondary, fontWeight: '500', width: 36 },
  carBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  carEmptyText: { fontSize: 14, color: Colors.text.secondary, lineHeight: 20 },

  // Rows
  rowLabel: { fontSize: 16, color: Colors.text.primary, fontWeight: '500' },
  chevron: { fontSize: 18, color: Colors.text.tertiary },
  rowDivider: { height: 1, backgroundColor: Colors.border.subtle, marginVertical: 8 },
  adminRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  adminRowText: { fontSize: 16, color: Colors.text.primary, fontWeight: '500' },

  // Rules expanded
  rulesExpanded: { marginTop: 14, gap: 0 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  ruleDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.border.subtle,
    paddingBottom: 10,
    marginBottom: 6,
  },
  ruleIcon: { fontSize: 18, width: 26, textAlign: 'center' },
  ruleText: { flex: 1, fontSize: 14, color: Colors.text.secondary, lineHeight: 20 },

  // Sign out
  signOutBtn: {
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 48, 0.3)',
    marginTop: 8,
  },
  signOutText: { color: Colors.danger, fontSize: 17, fontWeight: '600' },
  deleteAccountBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  deleteAccountText: { color: Colors.text.tertiary, fontSize: 14, fontWeight: '500' },

  // Modals
  modalContainer: { flex: 1, backgroundColor: '#0A0F1E' },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border.subtle,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: Colors.text.primary },
  modalClose: { fontSize: 17, color: Colors.primary, fontWeight: '600' },
  modalScroll: { padding: 16, gap: 4 },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border.subtle,
  },
  userAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userAvatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  userRowName: { fontSize: 16, fontWeight: '600', color: Colors.text.primary },
  userRowEmail: { fontSize: 13, color: Colors.text.secondary },
  emptyText: { textAlign: 'center', color: Colors.text.tertiary, marginTop: 40, fontSize: 15 },

  // Invite modal
  inviteBody: { padding: 20, gap: 14 },
  inviteLabel: { fontSize: 13, color: Colors.text.secondary, fontWeight: '500' },
  inviteInput: {
    backgroundColor: Colors.background.glass,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: Colors.text.primary,
    borderWidth: 1,
    borderColor: Colors.border.subtle,
  },
  inviteBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  inviteBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  inviteResultBox: {
    backgroundColor: Colors.background.surface,
    borderRadius: 12,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.border.glass,
  },
  inviteResultLabel: { fontSize: 12, color: Colors.text.tertiary, fontWeight: '500' },
  inviteResultUrl: { fontSize: 14, color: Colors.text.primary, lineHeight: 20 },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: Colors.background.glass,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border.glass,
  },
  copyBtnText: { color: Colors.primary, fontWeight: '600', fontSize: 14 },
});
