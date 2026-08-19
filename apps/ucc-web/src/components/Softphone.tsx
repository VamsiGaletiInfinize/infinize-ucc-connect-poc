import { useSoftphone } from '../hooks/useSoftphone.ts';
import { duration } from './ui.tsx';

/**
 * Agent softphone.
 *
 * Deliberately small and always visible rather than a modal: an agent needs to see at a
 * glance whether they are reachable, and a modal that has to be dismissed is a modal that
 * hides a ringing call.
 *
 * The states map to what the agent must decide:
 *   IDLE / ERROR  →  you are not reachable, here is the one button that fixes it
 *   READY         →  you are reachable, nothing to do
 *   RINGING       →  answer or decline
 *   ON_CALL       →  mute, hang up, and how long you have been talking
 */
export function Softphone({ agentId }: { agentId: string | undefined }) {
  const phone = useSoftphone(agentId);

  const tone: Record<string, string> = {
    IDLE: 'var(--text-muted)',
    CONNECTING: 'var(--amber)',
    READY: 'var(--green)',
    RINGING: 'var(--accent)',
    ON_CALL: 'var(--accent)',
    ERROR: 'var(--red)',
  };

  const label: Record<string, string> = {
    IDLE: 'Not connected',
    CONNECTING: 'Connecting…',
    READY: 'Ready for calls',
    RINGING: 'Incoming call',
    ON_CALL: 'On call',
    ERROR: 'Unavailable',
  };

  return (
    <div className="softphone" role="region" aria-label="Agent softphone">
      <div className="softphone-head">
        <span className="softphone-dot" style={{ background: tone[phone.state] }} aria-hidden />
        <strong>{label[phone.state]}</strong>
        {phone.state === 'ON_CALL' && (
          <span className="softphone-timer">{duration(phone.elapsed)}</span>
        )}
      </div>

      {phone.from && (
        <div className="softphone-from">
          Caller <code>{phone.from}</code>
        </div>
      )}

      {phone.error && (
        <div className="softphone-error" role="alert">
          {phone.error}
          {!phone.micReady && (
            <div className="softphone-hint">
              Allow microphone access in the browser, then reconnect.
            </div>
          )}
        </div>
      )}

      <div className="softphone-actions">
        {(phone.state === 'IDLE' || phone.state === 'ERROR') && (
          <button className="primary" onClick={() => void phone.register()}>
            Go available
          </button>
        )}

        {phone.state === 'RINGING' && (
          <>
            <button className="success" onClick={phone.accept}>
              Answer
            </button>
            <button onClick={phone.reject}>Decline</button>
          </>
        )}

        {phone.state === 'ON_CALL' && (
          <>
            <button onClick={phone.toggleMute} aria-pressed={phone.muted}>
              {phone.muted ? 'Unmute' : 'Mute'}
            </button>
            <button className="danger" onClick={phone.hangUp}>
              Hang up
            </button>
          </>
        )}
      </div>
    </div>
  );
}
