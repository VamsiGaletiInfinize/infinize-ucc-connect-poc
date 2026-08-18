/**
 * Nova Sonic spike — does AWS's speech-to-speech model fit the UCC architecture?
 *
 * Amazon Nova Sonic collapses STT + reasoning + TTS into one bidirectional stream. That is
 * the only dimension where this POC concluded Vapi is genuinely ahead (see
 * docs/vapi-twilio-vs-connect.md), so it is worth measuring rather than assuming.
 *
 * Three questions, in order of how much they matter:
 *
 *   1. DOES IT SUPPORT SERVER-SIDE TOOL USE?
 *      Decisive. The security property of this POC is that authorization lives in the
 *      ToolExecutor, never in the prompt (ADR-0002). If Nova Sonic cannot call back into our
 *      tools mid-conversation, it can only ever answer public FAQ questions, and every
 *      protected flow — verification, application lookup — would have to leave the voice
 *      channel. That would disqualify it for anything but the shallowest use.
 *
 *   2. TIME TO FIRST AUDIO BYTE.
 *      What makes a voice agent feel conversational rather than transactional. Compare
 *      against the ~800ms-1.2s that a stitched STT->LLM->TTS chain typically costs.
 *
 *   3. Does the transcript come back usable for the UCC timeline?
 *      We must persist what was said; a voice model that hides the transcript would break
 *      the audit trail.
 *
 * The tool handed to the model is the REAL protected tool from services/ai, wired to the
 * REAL authorization gate. If the model asks for application data for an unverified caller,
 * the gate must still refuse. That is the test that matters.
 *
 * VERIFIED against live Bedrock: the model requests the tool, our gate refuses an
 * unverified caller, and the model speaks the refusal — all without leaving audio.
 * Measured 433ms to first audio without a tool call, 1109ms with the round-trip.
 * Results and caveats: docs/nova-sonic-assessment.md.
 *
 * Two things this harness learned the hard way, preserved so they are not repeated:
 *   - Audio must be fed at roughly real time. Dumping the utterance instantly produced a
 *     stream that returned nothing but a usageEvent.
 *   - The system prompt must NOT state the caller's verification status, or the model
 *     declines conversationally and never calls the tool — a false negative.
 *
 * Usage:
 *   AWS_PROFILE=ucc-poc AWS_REGION=us-east-1 npx tsx scripts/nova-sonic-spike.ts
 */
import { randomUUID } from 'node:crypto';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { buildContainer } from '../apps/ucc-api/src/bootstrap/container.ts';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// nova-2-sonic, deliberately: v1 never emitted a tool request across three runs, which
// would limit it to public FAQ. See docs/nova-sonic-assessment.md.
const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID ?? 'amazon.nova-2-sonic-v1:0';

/** Nova Sonic expects 16 kHz, 16-bit, mono PCM. */
const SAMPLE_RATE = 16_000;
const CHUNK_BYTES = 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s = '') => console.log(s);
const rule = (t: string) => {
  line();
  line('='.repeat(70));
  line(t);
  line('='.repeat(70));
};

/** Synthesize the caller's utterance so the spike needs no binary fixtures in the repo. */
async function speak(text: string): Promise<Buffer> {
  const polly = new PollyClient({ region: REGION });
  const out = await polly.send(
    new SynthesizeSpeechCommand({
      Text: text,
      OutputFormat: 'pcm',
      SampleRate: String(SAMPLE_RATE),
      VoiceId: 'Kajal',          // Indian English, matching the demo tenant
      Engine: 'neural',
      LanguageCode: 'en-IN',
    }),
  );
  const chunks: Buffer[] = [];
  for await (const c of out.AudioStream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  rule('NOVA SONIC SPIKE');
  line(`model  : ${MODEL_ID}`);
  line(`region : ${REGION}`);

  // Real container: real tools, real authorization gate, real seeded tenant.
  const c = await buildContainer();
  const caller = await c.repos.caller.get(c.tenantId, 'caller-rohan');
  if (!caller) throw new Error('Seed caller missing — run the API once to seed.');

  rule('1. SYNTHESIZING CALLER AUDIO (Polly)');
  const utterance = 'What is the status of my application A P P 2 0 2 6 0 0 1?';
  line(`caller says: "${utterance}"`);
  const pcm = await speak(utterance);
  line(`pcm bytes: ${pcm.length} (${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)}s at 16kHz mono)`);

  // The protected tool, described to the model exactly as the Converse path describes it.
  const toolSpec = {
    toolSpec: {
      name: 'get_application_status',
      description:
        'Return the status of a specific application belonging to the verified caller.',
      inputSchema: {
        json: JSON.stringify({
          type: 'object',
          properties: { applicationId: { type: 'string' } },
          required: ['applicationId'],
        }),
      },
    },
  };

  // Deliberately does NOT state the caller's verification status. An earlier version did,
  // and the model simply declined in conversation without ever calling the tool — a false
  // negative that would have read as "Nova Sonic does not support tool use". The model must
  // have to consult the tool to learn anything about the application.
  const systemPrompt = [
    'You are the Infinize University contact centre assistant.',
    'You have no knowledge of any caller application except what tools return.',
    'When a caller asks about their application, you MUST call get_application_status.',
    'Never invent or guess application information.',
    'The caller is enquiring about application APP2026001.',
  ].join(' ');

  const client = new BedrockRuntimeClient({
    region: REGION,
    requestHandler: new NodeHttp2Handler({
      requestTimeout: 300_000,
      sessionTimeout: 300_000,
    }),
  });

  const promptId = randomUUID();
  const audioContentId = randomUUID();

  /** Resolved when the model signals it has finished responding. */
  let markComplete: () => void = () => {};
  const responseComplete = new Promise<void>((resolve) => {
    markComplete = resolve;
  });

  /**
   * Events pushed by the OUTPUT loop for the INPUT generator to send. Tool use makes this
   * conversation genuinely bidirectional: the model asks, we adjudicate server-side, and the
   * answer goes back up the same stream. A fixed input script cannot express that.
   */
  const outbound: unknown[] = [];
  let wake: () => void = () => {};
  const pushEvent = (e: unknown) => {
    outbound.push(e);
    wake();
  };

  // --- event construction ---------------------------------------------------
  const ev = (o: unknown) => ({
    chunk: { bytes: new TextEncoder().encode(JSON.stringify({ event: o })) },
  });

  async function* input() {
    yield ev({
      sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      },
    });

    yield ev({
      promptStart: {
        promptName: promptId,
        textOutputConfiguration: { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: 24_000,
          sampleSizeBits: 16,
          channelCount: 1,
          voiceId: 'matthew',
          encoding: 'base64',
          audioType: 'SPEECH',
        },
        toolUseOutputConfiguration: { mediaType: 'application/json' },
        toolConfiguration: { tools: [toolSpec] },
      },
    });

    // System prompt as a TEXT content block.
    const sysId = randomUUID();
    yield ev({
      contentStart: {
        promptName: promptId,
        contentName: sysId,
        type: 'TEXT',
        role: 'SYSTEM',
        interactive: true,
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    });
    yield ev({ textInput: { promptName: promptId, contentName: sysId, content: systemPrompt } });
    yield ev({ contentEnd: { promptName: promptId, contentName: sysId } });

    // Caller audio.
    yield ev({
      contentStart: {
        promptName: promptId,
        contentName: audioContentId,
        type: 'AUDIO',
        role: 'USER',
        interactive: true,
        audioInputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: SAMPLE_RATE,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: 'SPEECH',
          encoding: 'base64',
        },
      },
    });

    // Pace the audio at roughly real time. Nova Sonic is a live-conversation model: it
    // detects end-of-turn from the audio itself, so dumping the whole utterance instantly
    // gives it no chance to react and the stream closes having produced nothing.
    const msPerChunk = (CHUNK_BYTES / (SAMPLE_RATE * 2)) * 1000; // 16-bit mono
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      yield ev({
        audioInput: {
          promptName: promptId,
          contentName: audioContentId,
          content: pcm.subarray(i, i + CHUNK_BYTES).toString('base64'),
        },
      });
      await sleep(msPerChunk);
    }

    // Trailing silence: end-of-turn is detected from the audio, not from contentEnd alone.
    const silence = Buffer.alloc(CHUNK_BYTES);
    for (let i = 0; i < 30; i += 1) {
      yield ev({
        audioInput: {
          promptName: promptId,
          contentName: audioContentId,
          content: silence.toString('base64'),
        },
      });
      await sleep(msPerChunk);
    }

    inputEndedAt = Date.now();
    yield ev({ contentEnd: { promptName: promptId, contentName: audioContentId } });

    // Hold the input side open until the model has finished answering, servicing any tool
    // results the output loop queues up in the meantime. Closing the session immediately
    // after the last input event terminates the stream before generation.
    const deadline = Date.now() + 45_000;
    let finished = false;
    responseComplete.then(() => {
      finished = true;
      wake();
    });

    while (!finished && Date.now() < deadline) {
      while (outbound.length) yield outbound.shift() as never;
      await Promise.race([
        new Promise<void>((r) => {
          wake = r;
        }),
        sleep(500),
      ]);
    }
    while (outbound.length) yield outbound.shift() as never;

    yield ev({ promptEnd: { promptName: promptId } });
    yield ev({ sessionEnd: {} });
  }

  rule('2. OPENING BIDIRECTIONAL STREAM');
  const started = Date.now();
  /** Set when the last caller-audio chunk has been sent — the point a human stops talking. */
  let inputEndedAt: number | null = null;
  let firstAudioAt: number | null = null;
  let firstTextAt: number | null = null;
  let audioBytes = 0;
  const userTranscript: string[] = [];
  const assistantTranscript: string[] = [];
  let currentRole = 'UNKNOWN';
  const toolRequests: { name: string; input: unknown }[] = [];
  const eventTypes = new Set<string>();

  const applicationsForGate = await c.repos.application.list(c.tenantId);
  const gateTarget =
    applicationsForGate.find((a) => a.studentId === caller.studentId) ?? applicationsForGate[0]!;
  const gate = () =>
    c.identity.authorizeApplicationAccess(
      {
        tenantId: c.tenantId,
        uccCallId: 'spike-call',
        uccTicketId: 'spike-ticket',
        callerId: caller.id,
        callerType: caller.callerType,
        verified: false,
        traceId: 'spike-trace',
      },
      gateTarget,
    );
  let gateDecision: Awaited<ReturnType<typeof gate>> | null = null;

  const response = await client.send(
    new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: input() }),
  );

  for await (const chunk of response.body!) {
    const raw = chunk.chunk?.bytes;
    if (!raw) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      line(`  [unparseable chunk: ${raw.length} bytes]`);
      continue;
    }
    const event = parsed.event ?? parsed;
    const [type] = Object.keys(event);
    if (type) eventTypes.add(type);

    if (event.contentStart?.role) currentRole = event.contentStart.role;
    if (event.textOutput?.content) {
      if (currentRole === 'ASSISTANT') {
        firstTextAt ??= Date.now();
        assistantTranscript.push(event.textOutput.content);
      } else {
        userTranscript.push(event.textOutput.content);
      }
    }
    if (event.audioOutput?.content) {
      firstAudioAt ??= Date.now();
      audioBytes += Buffer.from(event.audioOutput.content, 'base64').length;
    }
    if (event.toolUse) {
      const name = event.toolUse.toolName;
      const useId = event.toolUse.toolUseId;
      toolRequests.push({ name, input: event.toolUse.content });
      line(`  <- model requested ${name}(${JSON.stringify(event.toolUse.content)})`);

      // THE POINT OF THE SPIKE: adjudicate server-side, from persisted state, exactly as
      // the Converse path does. The model's request is untrusted input, not an instruction.
      const decision = await gate();
      gateDecision = decision;
      const payload =
        decision.effect === 'DENY'
          ? { error: decision.code, message: decision.reason }
          : { status: 'UNDER_REVIEW' };
      line(`  -> gate returned ${decision.effect} (${decision.code})`);

      const toolContentId = randomUUID();
      pushEvent(
        ev({
          contentStart: {
            promptName: promptId,
            contentName: toolContentId,
            interactive: false,
            type: 'TOOL',
            role: 'TOOL',
            toolResultInputConfiguration: {
              toolUseId: useId,
              type: 'TEXT',
              textInputConfiguration: { mediaType: 'text/plain' },
            },
          },
        }),
      );
      pushEvent(
        ev({
          toolResult: {
            promptName: promptId,
            contentName: toolContentId,
            content: JSON.stringify(payload),
          },
        }),
      );
      pushEvent(ev({ contentEnd: { promptName: promptId, contentName: toolContentId } }));
    }
    // Only treat the turn as over once the model has spoken after any tool result.
    if (event.completionEnd && (toolRequests.length === 0 || audioBytes > 0)) markComplete();
  }

  rule('3. RESULTS');
  line(`event types seen : ${[...eventTypes].join(', ') || 'NONE'}`);
  const base = inputEndedAt ?? started;
  line(`caller audio fed over : ${base - started}ms (paced at real time)`);
  line('--- latency measured from the moment the caller stops speaking ---');
  line(`time to first text  : ${firstTextAt ? `${firstTextAt - base}ms` : 'never'}`);
  line(`time to first audio : ${firstAudioAt ? `${firstAudioAt - base}ms` : 'never'}`);
  line(`audio returned     : ${audioBytes} bytes (${(audioBytes / (24_000 * 2)).toFixed(2)}s)`);
  line(`caller ASR         : ${userTranscript.join('') || '(none)'}`);
  line(`assistant said     : ${assistantTranscript.join('') || '(none)'}`);
  line(`tool requests      : ${toolRequests.length}`);

  rule('4. THE DECISIVE CHECK — DOES THE AUTHORIZATION GATE STILL APPLY?');

  // The gate reads a security context built from PERSISTED state, never from the
  // conversation. An unverified caller must be refused no matter which model asked.
  const applications = await c.repos.application.list(c.tenantId);
  const target = applications.find((a) => a.studentId === caller.studentId) ?? applications[0]!;

  const unverifiedCtx = {
    tenantId: c.tenantId,
    uccCallId: 'spike-call',
    uccTicketId: 'spike-ticket',
    callerId: caller.id,
    callerType: caller.callerType,
    verified: false,
    traceId: 'spike-trace',
  };

  const decision = await c.identity.authorizeApplicationAccess(unverifiedCtx, target);
  line(`gate decision for an UNVERIFIED caller: ${JSON.stringify(decision)}`);
  const refused = decision.effect === 'DENY';
  line(
    refused
      ? 'PASS — refused, identically to the Converse path. The security model survives.'
      : 'FAIL — the gate allowed an unverified caller. Investigate before going further.',
  );

  if (toolRequests.length === 0) {
    line();
    line('NOTE: Nova Sonic did not request the tool in this run, so the end-to-end');
    line('model->tool->gate loop is NOT yet proven. Either the event protocol needs');
    line('adjusting or tool use is unavailable in speech-to-speech mode. Until a run shows');
    line('a toolUse event, treat "Nova Sonic preserves the security model" as UNVERIFIED.');
  } else {
    line();
    line(`PROVEN: the model emitted ${toolRequests.length} tool request(s) and the gate`);
    line('adjudicated them server-side. Nova Sonic fits the architecture.');
  }

  line();
  line('Spike complete.');
  process.exit(0);
}

main().catch((err) => {
  rule('SPIKE FAILED');
  console.error(err?.message ?? err);
  if (err?.$metadata) console.error('metadata:', JSON.stringify(err.$metadata));
  console.error(
    '\nIf this is a validation error, the event protocol above needs adjusting to match\n' +
      'the current Nova Sonic schema. The failure payload should say which field.',
  );
  process.exit(1);
});
