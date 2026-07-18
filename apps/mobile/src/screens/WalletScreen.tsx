import React, { useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
// SDK 54's expo-file-system v19 moved downloadAsync to the legacy entry point.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_URL } from '../constants/api';
import { Colors, StrongTextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';

interface WalletTransaction {
  id: string;
  amount_cents: number;
  type: 'credit' | 'charge';
  description: string;
  kwh: number | null;
  created_at: string;
  chargepoint_session_id: string | null;
}

const formatDollars = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Parse the description format: "May 10 · 48.17 kWh · 291m" */
function parseChargingDesc(desc: string): { date: string; kwh: string; duration: string } | null {
  const parts = desc.split('·').map(s => s.trim());
  if (parts.length < 3) return null;
  const kwhMatch = parts[1].match(/([\d.]+)\s*kWh/i);
  const minMatch = parts[2].match(/(\d+)m/);
  if (!kwhMatch) return null;
  const mins = minMatch ? parseInt(minMatch[1]) : 0;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  const durationStr = hours > 0 ? `${hours}h ${remainMins}m` : `${mins}m`;
  return { date: parts[0], kwh: kwhMatch[1], duration: durationStr };
}

export const WalletScreen = () => {
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Download the last 12 months as CSV and hand it to the iOS share sheet
  // (AirDrop, Mail, Files, Numbers…). The API sets the filename.
  const exportHistory = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const auth = axios.defaults.headers.common['Authorization'] as string | undefined;
      const dest = `${FileSystem.documentDirectory}2020ev-charging-history.csv`;
      const dl = await FileSystem.downloadAsync(`${API_URL}/wallet/me/export`, dest, {
        headers: auth ? { Authorization: auth } : {},
      });
      if (dl.status !== 200) throw new Error(`status ${dl.status}`);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dest, { mimeType: 'text/csv', dialogTitle: 'Charging history' });
      } else {
        Alert.alert('Saved', 'Report saved to the app documents folder.');
      }
    } catch (err) {
      console.error('Export error:', err);
      Alert.alert('Export failed', 'Could not download your history — please try again.');
    } finally {
      setExporting(false);
    }
  };

  const fetchWallet = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/wallet/me`);
      if (res.data?.data) {
        setBalanceCents(res.data.data.balance_cents);
        setTransactions(res.data.data.transactions);
      }
    } catch (err) {
      console.error('Wallet fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchWallet(); }, [fetchWallet]));

  const onRefresh = () => { setRefreshing(true); fetchWallet(); };

  if (loading) {
    return (
      <MiamiBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </MiamiBackground>
    );
  }

  const balanceDollars = (balanceCents ?? 0) / 100;
  const isLow = balanceDollars < 100;
  const charges = transactions.filter(t => t.type === 'charge');
  const totalKwh = charges.reduce((sum, t) => sum + (t.kwh ?? 0), 0);

  return (
    <MiamiBackground>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          style={styles.scrollView}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        >
          <Text style={[styles.heading, StrongTextShadow]}>Wallet</Text>

          {/* Balance Card */}
          <GlassCard style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>Available Balance</Text>
            <Text style={[styles.balanceAmount, { color: isLow ? Colors.danger : Colors.charger.available }]}>
              ${balanceDollars.toFixed(2)}
            </Text>
            {isLow && (
              <Text style={styles.lowWarning}>⚠️ Balance is low — contact admin to top up</Text>
            )}
            <Text style={styles.balanceNote}>Charging deducted daily · $0.18/kWh</Text>
          </GlassCard>

          {/* Usage summary */}
          {totalKwh > 0 && (
            <GlassCard style={styles.summaryCard}>
              <View style={styles.summaryRow}>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{totalKwh.toFixed(1)}</Text>
                  <Text style={styles.summaryLabel}>kWh used</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{charges.length}</Text>
                  <Text style={styles.summaryLabel}>sessions</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>
                    ${(charges.reduce((s, t) => s + Math.abs(t.amount_cents), 0) / 100).toFixed(2)}
                  </Text>
                  <Text style={styles.summaryLabel}>total billed</Text>
                </View>
              </View>
            </GlassCard>
          )}

          {/* Transaction History */}
          <GlassCard style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <Text style={styles.sectionTitle}>Charging History</Text>
              {transactions.length > 0 && (
                <TouchableOpacity onPress={exportHistory} disabled={exporting} style={styles.exportBtn}>
                  <Text style={styles.exportBtnText}>{exporting ? 'Exporting…' : '⬆ Export'}</Text>
                </TouchableOpacity>
              )}
            </View>
            {transactions.length === 0 ? (
              <Text style={styles.emptyText}>No transactions yet</Text>
            ) : (
              transactions.map((tx, i) => {
                const parsed = tx.type === 'charge' ? parseChargingDesc(tx.description) : null;
                return (
                  <View key={tx.id} style={[styles.txRow, i < transactions.length - 1 && styles.txDivider]}>
                    <View style={styles.txLeft}>
                      <Text style={styles.txIcon}>{tx.type === 'credit' ? '💳' : '⚡'}</Text>
                      <View style={styles.txInfo}>
                        {parsed ? (
                          <>
                            <Text style={styles.txDesc}>{parsed.date}</Text>
                            <View style={styles.txMeta}>
                              <Text style={styles.txMetaChip}>{parsed.kwh} kWh</Text>
                              <Text style={styles.txMetaChip}>{parsed.duration}</Text>
                            </View>
                          </>
                        ) : (
                          <Text style={styles.txDesc} numberOfLines={2}>{tx.description}</Text>
                        )}
                        <Text style={styles.txDate}>{formatDate(tx.created_at)}</Text>
                      </View>
                    </View>
                    <Text style={[styles.txAmount, { color: tx.amount_cents > 0 ? Colors.charger.available : Colors.text.primary }]}>
                      {tx.amount_cents > 0 ? '+' : '-'}{formatDollars(tx.amount_cents)}
                    </Text>
                  </View>
                );
              })
            )}
          </GlassCard>
        </ScrollView>
      </SafeAreaView>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  scrollView: { backgroundColor: 'transparent' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 20, gap: 16, paddingBottom: 100 },

  heading: { fontSize: 34, fontWeight: '700', color: Colors.text.primary, marginBottom: 8 },

  balanceCard: { alignItems: 'center', paddingVertical: 28 },
  balanceLabel: { fontSize: 14, color: Colors.text.secondary, fontWeight: '500', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 },
  balanceAmount: { fontSize: 56, fontWeight: '800', letterSpacing: -1 },
  lowWarning: { fontSize: 13, color: Colors.danger, marginTop: 8, textAlign: 'center' },
  balanceNote: { fontSize: 12, color: Colors.text.tertiary, marginTop: 10 },

  summaryCard: { paddingVertical: 16 },
  summaryRow: { flexDirection: 'row', alignItems: 'center' },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryValue: { fontSize: 22, fontWeight: '700', color: Colors.text.primary },
  summaryLabel: { fontSize: 11, color: Colors.text.tertiary, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  summaryDivider: { width: 1, height: 36, backgroundColor: Colors.border.subtle },

  historyCard: {},
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.text.primary, marginBottom: 14 },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  exportBtn: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 14,
  },
  exportBtnText: { color: Colors.text.primary, fontSize: 13, fontWeight: '600' },
  emptyText: { color: Colors.text.tertiary, fontSize: 14, textAlign: 'center', paddingVertical: 20 },

  txRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  txDivider: { borderBottomWidth: 1, borderBottomColor: Colors.border.subtle },
  txLeft: { flexDirection: 'row', alignItems: 'flex-start', flex: 1, gap: 10 },
  txIcon: { fontSize: 20, width: 28, textAlign: 'center', marginTop: 2 },
  txInfo: { flex: 1 },
  txDesc: { fontSize: 14, color: Colors.text.primary, fontWeight: '600', lineHeight: 20 },
  txMeta: { flexDirection: 'row', gap: 6, marginTop: 4 },
  txMetaChip: { fontSize: 12, color: Colors.text.secondary, backgroundColor: 'rgba(255,255,255,0.07)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  txDate: { fontSize: 12, color: Colors.text.tertiary, marginTop: 3 },
  txAmount: { fontSize: 16, fontWeight: '700', marginLeft: 8 },
});
