import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Keyboard,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import axios from 'axios';
import { API_URL } from '../constants/api';
import { Colors, StrongTextShadow, TextShadow } from '../constants/colors';
import { MiamiBackground } from '../components/MiamiBackground';
import { useAuth } from '../contexts/AuthContext';

type MessageType = 'session_start' | 'session_end' | 'chat' | 'exception' | 'system';

interface FeedMessage {
  id: string;
  type: MessageType;
  user_id: string | null;
  user_name: string | null;
  body: string;
  created_at: string;
}

const QUICK_REPLIES = [
  '⚡ Plugging in now',
  'Done, charger open',
  'Running ~30m late',
  'Need charger today',
];

const AVATAR_COLORS = [
  '#5E5CE6',
  '#30D158',
  '#0A84FF',
  '#FF453A',
  '#FF9F0A',
  '#AC8E68',
];

const getAvatarColor = (userId: string | null) => {
  if (!userId) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const getInitials = (name: string | null) => {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

const getRelativeTime = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return 'yesterday';
};

const SessionStartItem = ({ item }: { item: FeedMessage }) => (
  <View style={styles.sessionStartItem}>
    <View style={styles.sessionStartBorder} />
    <View style={styles.sessionItemContent}>
      <Text style={styles.sessionItemHeader}>
        <Text style={styles.sessionItemName}>{item.user_name ?? 'Unknown'}</Text>
        {'  '}
        <Text style={styles.sessionItemTime}>{getRelativeTime(item.created_at)}</Text>
      </Text>
      <Text style={styles.sessionItemBody}>⚡ {item.body}</Text>
    </View>
  </View>
);

const SessionEndItem = ({ item }: { item: FeedMessage }) => (
  <View style={styles.sessionEndItem}>
    <View style={styles.sessionEndBorder} />
    <View style={styles.sessionItemContent}>
      <Text style={styles.sessionItemHeader}>
        <Text style={styles.sessionItemName}>{item.user_name ?? 'Unknown'}</Text>
        {'  '}
        <Text style={styles.sessionItemTime}>{getRelativeTime(item.created_at)}</Text>
      </Text>
      <Text style={styles.sessionItemBody}>✅ {item.body}</Text>
    </View>
  </View>
);

const ChatItem = ({ item, isMe }: { item: FeedMessage; isMe: boolean }) => (
  <View style={[styles.chatItem, isMe && styles.chatItemMe]}>
    {!isMe && (
      <View style={[styles.avatarCircle, { backgroundColor: getAvatarColor(item.user_id) }]}>
        <Text style={styles.avatarText}>{getInitials(item.user_name)}</Text>
      </View>
    )}
    <View style={[styles.chatBubble, isMe && styles.chatBubbleMe]}>
      {!isMe && (
        <Text style={styles.chatBubbleName}>{item.user_name ?? 'Unknown'}</Text>
      )}
      <Text style={styles.chatBubbleBody}>{item.body}</Text>
      <Text style={[styles.chatBubbleTime, isMe && styles.chatBubbleTimeMe]}>
        {getRelativeTime(item.created_at)}
      </Text>
    </View>
    {isMe && (
      <View style={[styles.avatarCircle, { backgroundColor: getAvatarColor(item.user_id) }]}>
        <Text style={styles.avatarText}>{getInitials(item.user_name)}</Text>
      </View>
    )}
  </View>
);

const SystemItem = ({ item }: { item: FeedMessage }) => (
  <View style={styles.systemItem}>
    <Text style={styles.systemText}>{item.body}</Text>
  </View>
);

export const FeedScreen = () => {
  const { user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  // How far above the tab bar the input needs to sit (tab bar content only — SafeAreaView handles the rest)
  const bottomOffset = tabBarHeight - insets.bottom;
  // Keyboard height tracking — drives input area position without KAV interference
  const [kbHeight, setKbHeight] = useState(0);
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<FeedMessage>>(null);

  const fetchFeed = useCallback(async (scroll = false) => {
    try {
      const res = await axios.get(`${API_URL}/feed?limit=50`);
      const data: FeedMessage[] = res.data.data ?? [];
      const sorted = [...data].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      setMessages(sorted);
      if (scroll) {
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
      }
    } catch (err) {
      console.error('fetchFeed error', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeed(true);
    const interval = setInterval(() => fetchFeed(false), 20000);
    return () => clearInterval(interval);
  }, [fetchFeed]);

  // Keyboard listener — explicit height tracking replaces KeyboardAvoidingView
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      setKbHeight(e.endCoordinates.height);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // When keyboard is shown: lift input area to sit flush above it (minus SafeAreaView bottom inset)
  // When keyboard is hidden: lift input area to sit above the absolute-positioned tab bar
  const inputAreaBottom = kbHeight > 0 ? kbHeight - insets.bottom : bottomOffset;

  const handleSend = async (text?: string) => {
    const body = (text ?? inputText).trim();
    if (!body) return;
    setSending(true);
    try {
      await axios.post(`${API_URL}/feed`, { body, type: 'chat' });
      setInputText('');
      await fetchFeed(true);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'Could not send message.');
    } finally {
      setSending(false);
    }
  };

  const renderItem = ({ item }: { item: FeedMessage }) => {
    const isMe = item.user_id === user?.id;
    switch (item.type) {
      case 'session_start':
        return <SessionStartItem item={item} />;
      case 'session_end':
        return <SessionEndItem item={item} />;
      case 'chat':
      case 'exception':
        return <ChatItem item={item} isMe={isMe} />;
      case 'system':
        return <SystemItem item={item} />;
      default:
        return <ChatItem item={item} isMe={isMe} />;
    }
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

  return (
    <MiamiBackground>
      <SafeAreaView style={styles.safeArea}>
        <View style={{ flex: 1 }}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.headerTitle, StrongTextShadow]}>Feed</Text>
          </View>

          {/* Messages */}
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={[styles.emptyText, TextShadow]}>No messages yet. Say hello!</Text>
              </View>
            }
          />

          {/* Input area: chips + text input, lifts above keyboard or tab bar */}
          <View style={[styles.inputArea, { marginBottom: inputAreaBottom }]}>
            {/* Quick Reply Chips */}
            <View style={styles.chipsWrapper}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipsScroll}
              >
                {QUICK_REPLIES.map((chip) => (
                  <TouchableOpacity
                    key={chip}
                    style={styles.chip}
                    onPress={() => setInputText(chip)}
                  >
                    <Text style={styles.chipText}>{chip}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Input Bar */}
            <View style={styles.inputBar}>
              <TextInput
                style={styles.input}
                value={inputText}
                onChangeText={setInputText}
                placeholder="Message the group..."
                placeholderTextColor={Colors.text.tertiary}
                multiline
                maxLength={500}
              />
              <TouchableOpacity
                style={[styles.sendBtn, (!inputText.trim() || sending) && styles.sendBtnDisabled]}
                onPress={() => handleSend()}
                disabled={!inputText.trim() || sending}
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.sendBtnText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </MiamiBackground>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  headerTitle: { fontSize: 28, fontWeight: '700', color: Colors.text.primary },
  listContent: { padding: 12, gap: 4, paddingBottom: 8 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  emptyText: { color: Colors.text.tertiary, fontSize: 15 },

  // Session start
  sessionStartItem: {
    flexDirection: 'row',
    marginVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(52, 199, 89, 0.12)',
  },
  sessionStartBorder: {
    width: 4,
    backgroundColor: Colors.success,
    borderRadius: 2,
  },
  sessionItemContent: { flex: 1, padding: 12 },
  sessionItemHeader: { marginBottom: 4 },
  sessionItemName: { fontSize: 13, fontWeight: '600', color: Colors.text.primary },
  sessionItemTime: { fontSize: 12, color: Colors.text.tertiary },
  sessionItemBody: { fontSize: 14, color: Colors.text.secondary },

  // Session end
  sessionEndItem: {
    flexDirection: 'row',
    marginVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  sessionEndBorder: {
    width: 4,
    backgroundColor: Colors.text.tertiary,
    borderRadius: 2,
  },

  // Chat bubble
  chatItem: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: 4,
    gap: 8,
    paddingHorizontal: 4,
  },
  chatItemMe: { flexDirection: 'row-reverse' },
  avatarCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  avatarText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  chatBubble: {
    backgroundColor: 'rgba(10,15,40,0.88)',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    padding: 10,
    maxWidth: '72%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  chatBubbleMe: {
    backgroundColor: Colors.primary,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 4,
    borderColor: 'transparent',
  },
  chatBubbleName: { fontSize: 12, fontWeight: '600', color: Colors.text.secondary, marginBottom: 3 },
  chatBubbleBody: { fontSize: 15, color: Colors.text.primary, lineHeight: 20 },
  chatBubbleTime: { fontSize: 11, color: Colors.text.tertiary, marginTop: 4, textAlign: 'right' },
  chatBubbleTimeMe: { color: 'rgba(255,255,255,0.5)' },

  // System
  systemItem: { alignItems: 'center', marginVertical: 8 },
  systemText: {
    fontSize: 12,
    color: Colors.text.tertiary,
    fontStyle: 'italic',
    textAlign: 'center',
  },

  // Unified input area (chips + bar) — marginBottom drives keyboard avoidance
  inputArea: {
    backgroundColor: 'rgba(10,15,40,0.95)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },

  // Quick reply chips
  chipsWrapper: {
    paddingVertical: 10,
  },
  chipsScroll: { paddingHorizontal: 12, gap: 8 },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  chipText: { color: Colors.text.secondary, fontSize: 13, fontWeight: '500' },

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.07)',
  },
  input: {
    flex: 1,
    backgroundColor: 'rgba(10,15,40,0.85)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.text.primary,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 64,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
