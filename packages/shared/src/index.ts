// ─── User ────────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'member';

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | null;

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  priority_day: Weekday;
  unit_number?: string;
  push_token?: string;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  name: string;
  role: UserRole;
  priority_day: Weekday;
  unit_number?: string;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export type SessionType = 'top_up' | 'normal' | 'long';
export type SessionStatus = 'active' | 'completed' | 'cancelled';

export interface Session {
  id: string;
  user_id: string;
  user_name: string;
  type: SessionType;
  status: SessionStatus;
  started_at: string;
  estimated_end: string;
  actual_end?: string;
  notes?: string;
  created_at: string;
}

// ─── Feed Messages ────────────────────────────────────────────────────────────

export type FeedMessageType =
  | 'session_start'
  | 'session_end'
  | 'session_update'
  | 'chat'
  | 'exception'
  | 'system';

export interface FeedMessage {
  id: string;
  user_id: string;
  user_name: string;
  type: FeedMessageType;
  body: string;
  session_id?: string;
  created_at: string;
}

// ─── Schedule ────────────────────────────────────────────────────────────────

export interface WeekdayAssignment {
  day: Weekday;
  user_id: string | null;
  user_name: string | null;
}

export interface Schedule {
  assignments: WeekdayAssignment[];
  weekend_rule: 'fcfs';
}

// ─── Invite Codes ────────────────────────────────────────────────────────────

export interface InviteCode {
  id: string;
  token: string;
  email?: string;
  created_by: string;
  used_by?: string;
  used_at?: string;
  expires_at: string;
  created_at: string;
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface ApiResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

// ─── Socket Events ────────────────────────────────────────────────────────────

export interface SocketEvents {
  // Server → Client
  charger_status_update: { session: Session | null };
  feed_new_message: { message: FeedMessage };
  session_warning: { session: Session; minutesRemaining: number };
  user_joined: { user: PublicUser };

  // Client → Server
  join_room: { token: string };
}
