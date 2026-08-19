import { useCallback, useEffect, useRef, useState } from 'react';
import { Device, type Call } from '@twilio/voice-sdk';

/**
 * Turns the agent's browser into a voice endpoint.
 *
 * The agent answers and speaks to the caller inside the UCC workspace, with the case, AI
 * summary and verification status already on screen — so the caller never repeats
 * themselves to the human.
 *
 * Ownership is unchanged from the Amazon Connect design: TaskRouter decides *who* gets the
 * call and bridges the audio. This hook only registers the browser as reachable and exposes
 * accept / hang up / mute. It never selects work for itself.
 *
 * The token is fetched from the UCC API and refreshed before it expires; if it lapsed
 * mid-shift the agent would silently stop receiving calls, which is worse than an error.
 */

export type SoftphoneState =
  | 'IDLE'          // not registered yet
  | 'CONNECTING'    // fetching token / registering
  | 'READY'         // registered, waiting for work
  | 'RINGING'       // a call is being offered
  | 'ON_CALL'
  | 'ERROR';

export interface Softphone {
  state: SoftphoneState;
  error?: string;
  /** Caller number for the active or incoming call, when Twilio provides one. */
  from?: string;
  muted: boolean;
  /** Seconds since the call connected. */
  elapsed: number;
  register: () => Promise<void>;
  accept: () => void;
  reject: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  /** True when the browser has microphone permission; false blocks any real conversation. */
  micReady: boolean;
}

/** Refresh a little before expiry so a renewal failure has room to retry. */
const REFRESH_MARGIN_SECONDS = 120;

export function useSoftphone(agentId: string | undefined): Softphone {
  const [state, setState] = useState<SoftphoneState>('IDLE');
  const [error, setError] = useState<string>();
  const [from, setFrom] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micReady, setMicReady] = useState(false);

  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchToken = useCallback(async (): Promise<{ token: string; ttl: number }> => {
    const res = await fetch(`/api/agents/${agentId}/voice-token`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `Token request failed (${res.status})`);
    }
    const body = await res.json();
    return { token: body.token, ttl: body.expiresInSeconds ?? 3600 };
  }, [agentId]);

  const stopTick = () => {
    if (tickTimer.current) clearInterval(tickTimer.current);
    tickTimer.current = null;
  };

  const bindCall = useCallback((call: Call) => {
    callRef.current = call;
    setFrom(call.parameters?.From);

    call.on('accept', () => {
      setState('ON_CALL');
      setElapsed(0);
      stopTick();
      tickTimer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    });

    const finish = () => {
      callRef.current = null;
      setFrom(undefined);
      setMuted(false);
      stopTick();
      // Back to READY rather than IDLE: the device is still registered for the next call.
      setState((s) => (s === 'ERROR' ? s : 'READY'));
    };

    call.on('disconnect', finish);
    call.on('cancel', finish);
    call.on('reject', finish);
    call.on('error', (e: { message?: string }) => {
      setError(e?.message ?? 'Call error');
      finish();
    });
  }, []);

  const register = useCallback(async () => {
    if (!agentId) return;
    setState('CONNECTING');
    setError(undefined);

    try {
      // Ask for the microphone up front. Discovering it is blocked at the moment a caller
      // is waiting is the worst possible time.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        setMicReady(true);
      } catch {
        setMicReady(false);
        throw new Error('Microphone permission is required to take calls.');
      }

      const { token, ttl } = await fetchToken();
      const device = new Device(token, { logLevel: 'error' });
      deviceRef.current = device;

      device.on('registered', () => setState('READY'));
      device.on('incoming', (call: Call) => {
        bindCall(call);
        setState('RINGING');
      });
      device.on('error', (e: { message?: string }) => {
        setError(e?.message ?? 'Device error');
        setState('ERROR');
      });
      device.on('tokenWillExpire', async () => {
        try {
          const next = await fetchToken();
          device.updateToken(next.token);
        } catch (e) {
          setError(`Token refresh failed: ${(e as Error).message}`);
          setState('ERROR');
        }
      });

      await device.register();

      // Belt and braces: the SDK's own expiry event has been unreliable across versions,
      // so refresh on a timer too. Registering twice is harmless; lapsing is not.
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(
        () => void device.emit('tokenWillExpire'),
        Math.max(30, ttl - REFRESH_MARGIN_SECONDS) * 1000,
      );
    } catch (e) {
      setError((e as Error).message);
      setState('ERROR');
    }
  }, [agentId, bindCall, fetchToken]);

  const accept = useCallback(() => callRef.current?.accept(), []);
  const reject = useCallback(() => callRef.current?.reject(), []);
  const hangUp = useCallback(() => callRef.current?.disconnect(), []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !call.isMuted();
    call.mute(next);
    setMuted(next);
  }, []);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      stopTick();
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, []);

  return {
    state,
    error,
    from,
    muted,
    elapsed,
    register,
    accept,
    reject,
    hangUp,
    toggleMute,
    micReady,
  };
}
