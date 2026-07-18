import crypto from 'crypto';

export const generateInviteToken = (): string =>
  crypto.randomBytes(32).toString('hex');
