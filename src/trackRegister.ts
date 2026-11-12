import { appLogger } from './logger.js';
import type { TrackPoint } from './trackingSubscription.js';

const logger = appLogger.child({ module: 'trackRegister' });

export type LiveTrackPoint = TrackPoint & { token?: string; deviceId?: number };

export type TrackPointListener = (point: LiveTrackPoint) => void;

/** Live-point listeners by device id or access token. */
const trackRegister = new Map<number | string, Set<TrackPointListener>>();

export function addTrackListener(
  key: number | string,
  listener: TrackPointListener,
) {
  let listeners = trackRegister.get(key);

  if (!listeners) {
    listeners = new Set();

    trackRegister.set(key, listeners);
  }

  listeners.add(listener);
}

export function removeTrackListener(
  key: number | string,
  listener: TrackPointListener,
) {
  const listeners = trackRegister.get(key);

  if (listeners?.delete(listener) && listeners.size === 0) {
    trackRegister.delete(key);
  }
}

export function removeTrackListenerEverywhere(listener: TrackPointListener) {
  for (const key of [...trackRegister.keys()]) {
    removeTrackListener(key, listener);
  }
}

export function notifyTrackListeners(
  key: number | string,
  point: LiveTrackPoint,
) {
  for (const listener of trackRegister.get(key) ?? []) {
    try {
      listener(point);
    } catch (err) {
      logger.error({ err }, 'track listener failed');
    }
  }
}
