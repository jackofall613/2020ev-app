import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { io } from 'socket.io-client';
import { API_URL, SOCKET_URL } from '../constants/api';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { GlassCard } from '../components/GlassCard';
import { MiamiBackground } from '../components/MiamiBackground';
import { useAuth } from '../contexts/AuthContext';
import { DID_YOU_KNOW_FACTS } from '../constants/facts';

interface ActiveSession {
  id: string;
  user_id: string;
  user_name: string;
  type: string;
  estimated_end: string;
  started_at: string;
}

interface QueueEntry {
  id: string;
  user_id: string;
  user_name: string;
  status: 'waiting' | 'offered';
  joined_at: string;
  offered_at: string | null;
  offer_expires_at: string | null;
  claimed_at: string | null; // "On my way" tapped — hold stays live until plug-in
}

interface QueueData {
  entries: QueueEntry[];
  waiting_count: number;
  offered: QueueEntry | null;
  me: (QueueEntry & { position: number }) | null;
}

/** Client-side mirror of the server's GET /queue payload, so socket
 *  `queue:update` events (which carry only the entries) render instantly. */
const computeQueue = (entries: QueueEntry[], myId?: string): QueueData => {
  const waiting = entries.filter((e) => e.status === 'waiting');
  const offered = entries.find((e) => e.status === 'offered') || null;
  const mine = myId ? entries.find((e) => e.user_id === myId) || null : null;
  return {
    entries,
    waiting_count: waiting.length,
    offered,
    me: mine
      ? { ...mine, position: mine.status === 'offered' ? 0 : waiting.findIndex((e) => e.id === mine.id) + 1 }
      : null,
  };
};

const formatClock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

/** Car-profile finish estimate from GET /chargepoint/load (v1.1 Feature 3),
 *  plus Feature 2's idle surfacing. All fields null when unavailable. */
interface LoadEta {
  car_label: string | null;
  estimated_free_at: string | null;
  idle_minutes: number | null;
}

const formatEtaDuration = (iso: string) => {
  const mins = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
};

interface TodaySchedule {
  day: string;
  rule: string;
  priority_user: { id: string; name: string } | null;
}

type ChargerStatus = 'AVAILABLE' | 'IN_USE' | 'OFFLINE' | 'UNKNOWN';

export const HomeScreen = () => {
  const { user, accessToken } = useAuth();
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [todaySchedule, setTodaySchedule] = useState<TodaySchedule | null>(null);
  const [chargerStatus, setChargerStatus] = useState<ChargerStatus>('UNKNOWN');
  const [chargerStale, setChargerStale] = useState(false);
  const [loadKw, setLoadKw] = useState<number | null>(null);
  const [eta, setEta] = useState<LoadEta | null>(null);
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Pick a random fact once per mount (new fact each time you open the app)
  const dailyFact = useMemo(
    () => DID_YOU_KNOW_FACTS[Math.floor(Math.random() * DID_YOU_KNOW_FACTS.length)],
    []
  );

  const fetchData = async () => {
    try {
      const [sessionRes, scheduleRes] = await Promise.all([
        axios.get(`${API_URL}/sessions/active`),
        axios.get(`${API_URL}/schedule/today`),
      ]);
      setActiveSession(sessionRes.data.data);
      setTodaySchedule(scheduleRes.data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }

    // Real charger status — non-blocking, doesn't affect loading state
    axios.get(`${API_URL}/chargepoint/status`)
      .then(res => {
        if (res.data?.data?.status) setChargerStatus(res.data.data.status);
        setChargerStale(res.data?.stale === true);
      })
      .catch(() => { setChargerStale(true); }); // mark stale on error

    // Load (kW) — only shown when in use. Also carries the car-profile ETA
    // + idle surfacing (v1.1 Features 2 & 3).
    axios.get(`${API_URL}/chargepoint/load`)
      .then(res => {
        const kw = res.data?.data?.loadKw;
        setLoadKw(typeof kw === 'number' && kw > 0 ? kw : null);
        setEta(res.data?.data?.eta ?? null);
      })
      .catch(() => {});

    // "Next Up" queue — non-blocking
    axios.get(`${API_URL}/queue`)
      .then(res => setQueue(res.data.data))
      .catch(() => {});
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Live queue updates — the API broadcasts `queue:update` to the building's
  // room on every mutation, so open apps re-render without waiting for a poll.
  useEffect(() => {
    if (!accessToken) return;
    const socket = io(SOCKET_URL, { auth: { token: accessToken }, transports: ['websocket'] });
    socket.on('queue:update', (payload: { entries?: QueueEntry[] }) => {
      setQueue(computeQueue(payload?.entries ?? [], user?.id));
      // The charger itself likely changed hands — refresh the session card too.
      axios.get(`${API_URL}/sessions/active`)
        .then(res => setActiveSession(res.data.data))
        .catch(() => {});
    });
    return () => { socket.disconnect(); };
  }, [accessToken, user?.id]);

  const queueAction = async (action: 'join' | 'leave' | 'claim' | 'pass') => {
    setQueueBusy(true);
    try {
      const res = await axios.post(`${API_URL}/queue/${action}`);
      setQueue(res.data.data);
    } catch (err: any) {
      Alert.alert('Queue', err?.response?.data?.error || 'Something went wrong — pull to refresh.');
    } finally {
      setQueueBusy(false);
    }
  };

  const getTimeRemaining = (estimatedEnd: string) => {
    const diff = new Date(estimatedEnd).getTime() - Date.now();
    if (diff <= 0) return 'Overdue';
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    return hrs > 0 ? `${hrs}h ${mins % 60}m remaining` : `${mins}m remaining`;
  };

  // Real status from ChargePoint API; fall back to session-based if unknown
  const resolvedStatus: ChargerStatus =
    chargerStatus !== 'UNKNOWN' ? chargerStatus : (activeSession ? 'IN_USE' : 'AVAILABLE');
  const chargerAvailable = resolvedStatus === 'AVAILABLE';
  const chargerOffline = resolvedStatus === 'OFFLINE';

  // "Next Up" queue derivations
  const myOffer = queue?.me?.status === 'offered' ? queue.me : null;
  const inQueueWaiting = queue?.me?.status === 'waiting';
  const isMyActiveSession = !!(activeSession && user && activeSession.user_id === user.id);
  const heldForOther = !!(queue?.offered && queue.offered.user_id !== user?.id);
  const chargerBusy = !!activeSession || (!chargerAvailable && !chargerOffline);
  const showQueueCard =
    !!queue && !myOffer && !isMyActiveSession && (chargerBusy || heldForOther || inQueueWaiting);
  const statusColor = chargerOffline
    ? Colors.text.tertiary
    : chargerAvailable
    ? Colors.charger.available
    : Colors.charger.inUse;

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
              onRefresh={() => { setRefreshing(true); fetchData(); }}
              tintColor={Colors.primary}
            />
          }
        >
          {/* Header */}
          <Text style={[styles.greeting, StrongTextShadow]}>
            Good {getTimeOfDay()},{'\n'}{user?.name?.split(' ')[0]}
          </Text>

          {/* Charger Status Card */}
          <GlassCard style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: statusColor, shadowColor: statusColor, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }]} />
              <Text style={[styles.statusText, { color: statusColor }]}>
                {chargerOffline ? 'Charger Offline' : chargerAvailable ? 'Charger Available' : 'Charger In Use'}
              </Text>
              {loadKw !== null && !chargerAvailable && (
                <Text style={styles.loadBadge}>{loadKw.toFixed(1)} kW</Text>
              )}
              {chargerStale && (
                <Text style={styles.staleBadge}>· Status may be delayed</Text>
              )}
            </View>

            {chargerOffline ? (
              <Text style={styles.availableText}>The charger may be unreachable or faulted</Text>
            ) : activeSession ? (
              <View style={styles.sessionInfo}>
                <Text style={styles.sessionUser}>{eta?.car_label ?? activeSession.user_name}</Text>
                {eta?.estimated_free_at ? (
                  // Honest car-profile estimate from the live draw — preferred
                  // over the user-typed guess when available (Feature 3).
                  <Text style={styles.sessionTime}>
                    Free in ~{formatEtaDuration(eta.estimated_free_at)} (est.)
                  </Text>
                ) : (
                  <Text style={styles.sessionTime}>
                    {getTimeRemaining(activeSession.estimated_end)}
                  </Text>
                )}
                <Text style={styles.sessionEstimate}>
                  Done ~{new Date(
                    eta?.estimated_free_at ?? activeSession.estimated_end
                  ).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </Text>
                {eta?.idle_minutes != null && (
                  <Text style={styles.idleText}>
                    ⚠️ Car looks done — idle for {eta.idle_minutes}m
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.availableText}>Plug in and announce to the group</Text>
            )}
          </GlassCard>

          {/* Next Up — your hold on the charger */}
          {myOffer && (
            <GlassCard style={styles.offerCard}>
              {myOffer.claimed_at ? (
                // Already said "On my way" — the hold stays yours until you plug in.
                <>
                  <Text style={styles.offerTitle}>⚡ Held for you — plug in when you arrive</Text>
                  <Text style={styles.offerBody}>
                    Your hold lasts until {formatClock(myOffer.offer_expires_at)}. Start your session once you’re plugged in.
                  </Text>
                  <TouchableOpacity
                    style={[styles.queueBtnGhost, queueBusy && styles.queueBtnDisabled]}
                    disabled={queueBusy}
                    onPress={() => queueAction('pass')}
                  >
                    <Text style={styles.queueBtnGhostText}>Pass — let the next person go</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.offerTitle}>⚡ Charger’s free — it’s your turn</Text>
                  <Text style={styles.offerBody}>
                    Held for you until {formatClock(myOffer.offer_expires_at)}. On your way, or pass it to the next person?
                  </Text>
                  <View style={styles.queueBtnRow}>
                    <TouchableOpacity
                      style={[styles.queueBtnPrimary, queueBusy && styles.queueBtnDisabled]}
                      disabled={queueBusy}
                      onPress={() => queueAction('claim')}
                    >
                      <Text style={styles.queueBtnPrimaryText}>On my way</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.queueBtnGhost, queueBusy && styles.queueBtnDisabled]}
                      disabled={queueBusy}
                      onPress={() => queueAction('pass')}
                    >
                      <Text style={styles.queueBtnGhostText}>Pass</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </GlassCard>
          )}

          {/* Next Up — the queue */}
          {showQueueCard && (
            <GlassCard style={styles.queueCard}>
              <Text style={styles.cardLabel}>Next Up</Text>
              {heldForOther && queue?.offered && (
                <Text style={styles.queueHeldText}>
                  Held for {queue.offered.user_name} until {formatClock(queue.offered.offer_expires_at)}
                </Text>
              )}
              <Text style={styles.queueCount}>
                {inQueueWaiting && queue?.me
                  ? `You’re #${queue.me.position} in line`
                  : queue && queue.waiting_count > 0
                  ? `${queue.waiting_count} ${queue.waiting_count === 1 ? 'person' : 'people'} waiting`
                  : 'No one waiting yet — be first in line'}
              </Text>
              <TouchableOpacity
                style={[
                  inQueueWaiting ? styles.queueBtnGhost : styles.queueBtnPrimary,
                  queueBusy && styles.queueBtnDisabled,
                ]}
                disabled={queueBusy}
                onPress={() => queueAction(inQueueWaiting ? 'leave' : 'join')}
              >
                {queueBusy ? (
                  <ActivityIndicator color={inQueueWaiting ? Colors.text.secondary : '#fff'} />
                ) : inQueueWaiting ? (
                  <Text style={styles.queueBtnGhostText}>Leave queue</Text>
                ) : (
                  <Text style={styles.queueBtnPrimaryText}>Join queue</Text>
                )}
              </TouchableOpacity>
            </GlassCard>
          )}

          {/* Today's Priority */}
          {todaySchedule && (
            <GlassCard style={styles.priorityCard}>
              <Text style={styles.cardLabel}>
                {todaySchedule.rule === 'fcfs' ? 'Weekend' : `${capitalize(todaySchedule.day)} Priority`}
              </Text>
              <Text style={styles.priorityName}>
                {todaySchedule.rule === 'fcfs'
                  ? 'First Come, First Served'
                  : todaySchedule.priority_user
                  ? todaySchedule.priority_user.id === user?.id
                    ? 'You have priority today'
                    : todaySchedule.priority_user.name
                  : 'No priority assigned'}
              </Text>
            </GlassCard>
          )}

          {/* Did You Know */}
          <GlassCard style={styles.factCard}>
            <View style={styles.factHeader}>
              <Text style={styles.factEmoji}>💡</Text>
              <Text style={styles.factTitle}>Did you know?</Text>
            </View>
            <Text style={styles.factBody}>{dailyFact}</Text>
          </GlassCard>
        </ScrollView>
      </SafeAreaView>
    </MiamiBackground>
  );
};

const getTimeOfDay = () => {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  scrollView: { backgroundColor: 'transparent' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 20, gap: 16 },
  greeting: {
    fontSize: 34,
    fontWeight: '700',
    color: Colors.text.primary,
    marginBottom: 8,
    lineHeight: 42,
  },
  statusCard: { marginBottom: 0 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  statusDot: { width: 12, height: 12, borderRadius: 6 },
  statusText: { fontSize: 18, fontWeight: '600', ...TextShadow },
  loadBadge: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.charger.inUse,
    backgroundColor: 'rgba(255,159,10,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
    marginLeft: 4,
  },
  staleBadge: {
    fontSize: 11,
    color: Colors.text.tertiary,
    fontStyle: 'italic',
    marginLeft: 4,
  },
  sessionInfo: { gap: 4 },
  sessionUser: { fontSize: 22, fontWeight: '700', color: Colors.text.primary },
  sessionTime: { fontSize: 16, color: Colors.warning },
  sessionEstimate: { fontSize: 14, color: Colors.text.secondary },
  idleText: { fontSize: 13, color: Colors.warning, marginTop: 2, fontWeight: '600' },
  availableText: { fontSize: 15, color: Colors.text.secondary },
  priorityCard: { marginBottom: 0 },
  cardLabel: { fontSize: 13, color: Colors.text.secondary, marginBottom: 6, fontWeight: '500' },
  // Next Up queue
  offerCard: { marginBottom: 0, borderColor: 'rgba(52,199,89,0.5)', borderWidth: 1 },
  offerTitle: { fontSize: 18, fontWeight: '700', color: Colors.charger.available, marginBottom: 6, ...TextShadow },
  offerBody: { fontSize: 14, color: Colors.text.primary, lineHeight: 20, marginBottom: 14 },
  queueCard: { marginBottom: 0 },
  queueHeldText: { fontSize: 14, color: Colors.warning, marginBottom: 6, fontWeight: '600' },
  queueCount: { fontSize: 17, fontWeight: '600', color: Colors.text.primary, marginBottom: 12 },
  queueBtnRow: { flexDirection: 'row', gap: 10 },
  queueBtnPrimary: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  queueBtnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  queueBtnGhost: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(10,15,40,0.5)',
  },
  queueBtnGhostText: { color: Colors.text.secondary, fontSize: 15, fontWeight: '600' },
  queueBtnDisabled: { opacity: 0.6 },
  priorityName: { fontSize: 18, fontWeight: '600', color: Colors.text.primary },
  // Did You Know card
  factCard: { marginBottom: 0 },
  factHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  factEmoji: { fontSize: 20 },
  factTitle: { fontSize: 15, fontWeight: '700', color: Colors.text.secondary },
  factBody: { fontSize: 15, color: Colors.text.primary, lineHeight: 22 },
});
