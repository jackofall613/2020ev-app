import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { query } from '../db';

const expo = new Expo();

export const sendPushToAllUsers = async (
  title: string,
  body: string,
  excludeUserId?: string
) => {
  try {
    const result = await query(
      `SELECT push_token FROM users WHERE push_token IS NOT NULL ${excludeUserId ? 'AND id != $1' : ''}`,
      excludeUserId ? [excludeUserId] : []
    );

    const messages: ExpoPushMessage[] = result.rows
      .filter((row) => Expo.isExpoPushToken(row.push_token))
      .map((row) => ({
        to: row.push_token,
        title,
        body,
        sound: 'default',
        data: {},
      }));

    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        console.error('Push notification chunk error:', err);
      }
    }
  } catch (err) {
    console.error('Push notification error:', err);
  }
};

export const sendPushToUser = async (userId: string, title: string, body: string) => {
  try {
    const result = await query('SELECT push_token FROM users WHERE id = $1', [userId]);
    const token = result.rows[0]?.push_token;
    if (!token || !Expo.isExpoPushToken(token)) return;

    await expo.sendPushNotificationsAsync([{ to: token, title, body, sound: 'default' }]);
  } catch (err) {
    console.error('Push notification error:', err);
  }
};
