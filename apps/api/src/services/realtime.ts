/**
 * Realtime (socket.io) registry — lets services and routes emit events without
 * importing the server entry (which would be a circular import: index.ts loads
 * the routers, and chargerWatch is required from index.ts's listen callback).
 *
 * Rooms are per building (`building:<id>`) so one tenant's events never reach
 * another tenant's sockets. index.ts joins each authenticated socket to its
 * building's room at connection time.
 */

import type { Server } from 'socket.io';

let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

export function buildingRoom(buildingId: string): string {
  return `building:${buildingId}`;
}

/** Emit an event to every socket in a building's room. No-op before setIo()
 *  (e.g. under NODE_ENV=test, where the server never starts). */
export function emitToBuilding(buildingId: string | null, event: string, payload: unknown): void {
  if (!io || !buildingId) return;
  io.to(buildingRoom(buildingId)).emit(event, payload);
}
