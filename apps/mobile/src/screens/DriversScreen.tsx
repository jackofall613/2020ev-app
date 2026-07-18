import React, { useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { API_URL } from '../constants/api';
import { Colors, StrongTextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';

interface Driver {
  id: string;
  driver_name: string;
  driver_account_number: string;
  chargepoint_user_id: string | null;
  status: 'pending' | 'mapped';
  user_id: string | null;
  mapped_user_name: string | null;
  mapped_user_email: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface AppUser {
  id: string;
  name: string;
  email: string;
  unit_number: string | null;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export const DriversScreen = () => {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mappingDriver, setMappingDriver] = useState<Driver | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchDrivers = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/wallet/drivers`);
      if (res.data?.data) setDrivers(res.data.data);
    } catch (err) {
      console.error('Drivers fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchDrivers(); }, [fetchDrivers]));

  const onRefresh = () => { setRefreshing(true); fetchDrivers(); };

  const openMapping = async (driver: Driver) => {
    setMappingDriver(driver);
    setUsersLoading(true);
    try {
      const res = await axios.get(`${API_URL}/wallet/users`);
      if (res.data?.data) setUsers(res.data.data);
    } catch {}
    setUsersLoading(false);
  };

  const mapToUser = async (userId: string) => {
    if (!mappingDriver) return;
    setSaving(true);
    try {
      await axios.post(`${API_URL}/wallet/drivers/${mappingDriver.id}/map`, { user_id: userId });
      setMappingDriver(null);
      fetchDrivers();
    } catch (err) {
      console.error('Map driver error:', err);
    }
    setSaving(false);
  };

  const pending = drivers.filter(d => d.status === 'pending');
  const mapped = drivers.filter(d => d.status === 'mapped');

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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        >
          <Text style={[styles.heading, StrongTextShadow]}>Drivers</Text>

          {pending.length > 0 && (
            <GlassCard>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Needs Mapping</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{pending.length}</Text>
                </View>
              </View>
              <Text style={styles.sectionNote}>
                These drivers appeared in ChargePoint reports but aren't linked to an app user yet. Tap to assign them.
              </Text>
              {pending.map((d, i) => (
                <TouchableOpacity
                  key={d.id}
                  style={[styles.driverRow, i < pending.length - 1 && styles.rowDivider]}
                  onPress={() => openMapping(d)}
                >
                  <View style={styles.driverLeft}>
                    <View style={styles.pendingDot} />
                    <View>
                      <Text style={styles.driverName}>{d.driver_name}</Text>
                      <Text style={styles.driverMeta}>
                        First seen {formatDate(d.first_seen_at)} · Last seen {formatDate(d.last_seen_at)}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.mapCta}>Map →</Text>
                </TouchableOpacity>
              ))}
            </GlassCard>
          )}

          {pending.length === 0 && (
            <GlassCard style={styles.allGoodCard}>
              <Text style={styles.allGoodIcon}>✅</Text>
              <Text style={styles.allGoodText}>All drivers mapped</Text>
            </GlassCard>
          )}

          {mapped.length > 0 && (
            <GlassCard>
              <Text style={styles.sectionTitle}>Mapped Drivers</Text>
              {mapped.map((d, i) => (
                <View key={d.id} style={[styles.driverRow, i < mapped.length - 1 && styles.rowDivider]}>
                  <View style={styles.driverLeft}>
                    <View style={styles.mappedDot} />
                    <View>
                      <Text style={styles.driverName}>{d.driver_name}</Text>
                      <Text style={styles.driverMeta}>→ {d.mapped_user_name} ({d.mapped_user_email})</Text>
                    </View>
                  </View>
                  <TouchableOpacity onPress={() => openMapping(d)}>
                    <Text style={styles.remapCta}>Change</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </GlassCard>
          )}
        </ScrollView>
      </SafeAreaView>

      {/* User picker modal */}
      <Modal visible={!!mappingDriver} animationType="slide" transparent onRequestClose={() => setMappingDriver(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>
              Map "{mappingDriver?.driver_name}"
            </Text>
            <Text style={styles.modalSubtitle}>Select the resident this ChargePoint driver belongs to</Text>

            {usersLoading ? (
              <ActivityIndicator color={Colors.primary} style={{ marginTop: 20 }} />
            ) : (
              <FlatList
                data={users}
                keyExtractor={u => u.id}
                style={styles.userList}
                renderItem={({ item: u }) => (
                  <TouchableOpacity
                    style={[styles.userRow, mappingDriver?.user_id === u.id && styles.userRowSelected]}
                    onPress={() => mapToUser(u.id)}
                    disabled={saving}
                  >
                    <View>
                      <Text style={styles.userName}>{u.name}</Text>
                      <Text style={styles.userEmail}>{u.email}{u.unit_number ? ` · Unit ${u.unit_number}` : ''}</Text>
                    </View>
                    {mappingDriver?.user_id === u.id && <Text style={styles.checkmark}>✓</Text>}
                  </TouchableOpacity>
                )}
              />
            )}

            <TouchableOpacity style={styles.cancelBtn} onPress={() => setMappingDriver(null)}>
              <Text style={styles.cancelText}>Cancel</Text>
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
  scroll: { padding: 20, gap: 16, paddingBottom: 100 },
  heading: { fontSize: 34, fontWeight: '700', color: Colors.text.primary, marginBottom: 8 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.text.primary },
  sectionNote: { fontSize: 13, color: Colors.text.secondary, marginBottom: 14, lineHeight: 18 },
  badge: { backgroundColor: Colors.danger, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  driverRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: Colors.border.subtle },
  driverLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.danger },
  mappedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.charger.available },
  driverName: { fontSize: 15, fontWeight: '600', color: Colors.text.primary },
  driverMeta: { fontSize: 12, color: Colors.text.tertiary, marginTop: 2 },
  mapCta: { fontSize: 14, color: Colors.primary, fontWeight: '600' },
  remapCta: { fontSize: 13, color: Colors.text.secondary },

  allGoodCard: { alignItems: 'center', paddingVertical: 24 },
  allGoodIcon: { fontSize: 36, marginBottom: 8 },
  allGoodText: { fontSize: 16, color: Colors.text.secondary },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#0F1628', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, maxHeight: '75%' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: Colors.text.primary, marginBottom: 4 },
  modalSubtitle: { fontSize: 14, color: Colors.text.secondary, marginBottom: 16 },
  userList: { maxHeight: 400 },
  userRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border.subtle, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  userRowSelected: { opacity: 0.7 },
  userName: { fontSize: 15, fontWeight: '600', color: Colors.text.primary },
  userEmail: { fontSize: 13, color: Colors.text.tertiary, marginTop: 2 },
  checkmark: { fontSize: 18, color: Colors.charger.available },
  cancelBtn: { marginTop: 16, alignItems: 'center', paddingVertical: 14 },
  cancelText: { fontSize: 16, color: Colors.text.secondary },
});
