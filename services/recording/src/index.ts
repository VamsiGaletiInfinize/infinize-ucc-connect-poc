import {
  notFound,
  type Recording,
  type Transcript,
  type TranscriptSegmentKind,
  type TranscriptSpeaker,
  type TranscriptTurn,
  type UccCall,
} from '@ucc/types';
import { config } from '@ucc/config';
import { logger, newId, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';

/**
 * Recording metadata.
 *
 * Audio binaries live in S3 and NEVER in DynamoDB (spec FR-015). UCC stores only the
 * pointer, duration and retention policy, and exposes them from the ticket.
 *
 * With a live Amazon Connect instance, Connect writes the audio to its configured S3
 * bucket and reports the key on the Contact Trace Record; `registerFromProvider` is the
 * ingestion point for that. Without a live instance no audio exists, and the POC records
 * that fact rather than inventing a file.
 */
export class RecordingService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
  ) {}

  /** Register recording metadata reported by the telephony provider. */
  async registerFromProvider(params: {
    call: UccCall;
    uccTicketId: string;
    storageLocation: string;
    duration: number;
    sizeBytes?: number;
    format?: 'wav' | 'mp3';
  }): Promise<Recording> {
    const recording: Recording = {
      id: newId('rec'),
      tenantId: params.call.tenantId,
      uccCallId: params.call.id,
      provider: params.call.provider,
      providerContactId: params.call.providerContactId,
      storageLocation: params.storageLocation,
      duration: params.duration,
      format: params.format ?? 'wav',
      sizeBytes: params.sizeBytes,
      retentionPolicy: 'RETAIN_90_DAYS_THEN_DELETE',
      createdAt: nowIso(),
    };

    await this.repos.recording.put(recording);

    await this.events.emit({
      tenantId: params.call.tenantId,
      uccCallId: params.call.id,
      uccTicketId: params.uccTicketId,
      type: 'RECORDING_AVAILABLE',
      actor: 'PROVIDER',
      traceId: params.call.traceId,
      discriminator: recording.id,
      payload: {
        recordingId: recording.id,
        duration: recording.duration,
        retentionPolicy: recording.retentionPolicy,
      },
    });

    logger.info('Recording metadata registered', {
      traceId: params.call.traceId,
      tenantId: params.call.tenantId,
      uccCallId: params.call.id,
      recordingId: recording.id,
    });

    return recording;
  }

  /**
   * Where the recording for this call would be stored.
   *
   * Returned so the ticket UI can show the exact S3 location a live Connect instance
   * would write to, without pretending an audio file exists.
   */
  plannedLocation(call: UccCall): string {
    const bucket = config().UCC_BUCKET_NAME ?? 'ucc-recordings-bucket';
    const date = call.startedAt.slice(0, 10);
    return `s3://${bucket}/recordings/${call.tenantId}/${date}/${call.providerContactId}.wav`;
  }

  get(tenantId: string, recordingId: string) {
    return this.repos.recording.get(tenantId, recordingId);
  }

  list(tenantId: string) {
    return this.repos.recording.list(tenantId);
  }
}

/**
 * Normalized UCC conversation representation.
 *
 * Both the AI segment and the agent segment land in one transcript, so a supervisor reads
 * a single ordered conversation rather than stitching two sources together.
 */
export class TranscriptService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
  ) {}

  private async ensure(call: UccCall, uccTicketId: string): Promise<Transcript> {
    const existing = await this.repos.transcript.byCallId(call.tenantId, call.id);
    if (existing) return existing;
    const transcript: Transcript = {
      id: newId('trs'),
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId,
      provider: call.provider,
      providerContactId: call.providerContactId,
      turns: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.transcript.put(transcript);
    return transcript;
  }

  /** Append a conversation turn. */
  async append(params: {
    call: UccCall;
    uccTicketId: string;
    speaker: TranscriptSpeaker;
    speakerName?: string;
    kind: TranscriptSegmentKind;
    content: string;
  }): Promise<Transcript> {
    const transcript = await this.ensure(params.call, params.uccTicketId);
    const now = nowIso();
    const turn: TranscriptTurn = {
      id: newId('turn'),
      speaker: params.speaker,
      speakerName: params.speakerName,
      kind: params.kind,
      content: params.content,
      offsetMs: Math.max(0, Date.parse(now) - Date.parse(params.call.startedAt)),
      timestamp: now,
    };
    const updated: Transcript = {
      ...transcript,
      turns: [...transcript.turns, turn],
      updatedAt: now,
    };
    await this.repos.transcript.put(updated);
    return updated;
  }

  /** Mark the transcript complete once the contact ends. */
  async finalize(call: UccCall, uccTicketId: string): Promise<Transcript | null> {
    const transcript = await this.repos.transcript.byCallId(call.tenantId, call.id);
    if (!transcript) return null;
    await this.events.emit({
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId,
      type: 'TRANSCRIPT_AVAILABLE',
      actor: 'SYSTEM',
      traceId: call.traceId,
      discriminator: transcript.id,
      payload: { transcriptId: transcript.id, turns: transcript.turns.length },
    });
    return transcript;
  }

  byCall(tenantId: string, uccCallId: string) {
    return this.repos.transcript.byCallId(tenantId, uccCallId);
  }
}
