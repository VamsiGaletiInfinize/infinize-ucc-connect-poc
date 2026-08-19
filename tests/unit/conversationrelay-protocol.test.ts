import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ConversationRelay protocol constants.
 *
 * A live call was lost to this: the server sent `end_session`, Twilio rejected it as an
 * unknown type, the websocket stayed open, and the caller spent two minutes being told a
 * transfer had happened while nothing routed. The failure was invisible in our own tests
 * because both sides were ours.
 *
 * These assertions pin the two field names Twilio actually documents, so a plausible-
 * looking rename cannot silently strand callers again.
 *
 *   server → Twilio   { "type": "end", "handoffData": "<json string>" }
 *   Twilio → server   { "type": "prompt", "voicePrompt": "...", "last": true }
 */
const source = readFileSync('apps/ucc-api/src/routes/twilio.ts', 'utf8');

describe('ConversationRelay protocol constants', () => {
  it("ends the session with type 'end', never 'end_session'", () => {
    expect(source).toContain("type: 'end'");
    expect(source).not.toContain("type: 'end_session'");
  });

  it('reads the caller utterance from voicePrompt', () => {
    expect(source).toMatch(/msg\.voicePrompt/);
  });

  it('sends handoffData as a JSON string, not an object', () => {
    // Twilio requires a string; an object is silently unusable at the action URL.
    const handoffs = source.match(/handoffData:\s*([^\n]+)/g) ?? [];
    expect(handoffs.length).toBeGreaterThan(0);
    for (const h of handoffs) expect(h).toContain('JSON.stringify');
  });

  it('speaks with the documented text token shape', () => {
    expect(source).toMatch(/type:\s*'text',\s*token/);
  });

  it('logs the whole error frame so a rejection is never detail-free', () => {
    expect(source).toMatch(/payload:\s*JSON\.stringify\(msg\)/);
  });
});
