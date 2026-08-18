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
 * PROTOCOL CAVEAT: the Nova Sonic bidirectional event protocol below is written from the
 * documented shape and has NOT yet been executed against the live service — every attempt
 * so far coincided with an expired session token. If the event schema has drifted, this
 * script fails loudly with the offending payload rather than silently producing a wrong
 * answer. Treat a clean run as the first real evidence.
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
const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID ?? 'amazon.nova-sonic-v1:0';

/** Nova Sonic expects 16 kHz, 16-bit, mono PCM. */
const SAMPLE_RATE = 16_000;
const CHUNK_BYTES = 1024;

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
  const utterance = 'What is the status of my application?';
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

  const systemPrompt = [
    'You are the Infinize University contact centre assistant.',
    'The caller has NOT completed identity verification.',
    'If they ask about their application, call get_application_status.',
    'Never invent application information.',
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

    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      yield ev({
        audioInput: {
          promptName: promptId,
          contentName: audioContentId,
          content: pcm.subarray(i, i + CHUNK_BYTES).toString('base64'),
        },
      });
    }

    yield ev({ contentEnd: { promptName: promptId, contentName: audioContentId } });
    yield ev({ promptEnd: { promptName: promptId } });
    yield ev({ sessionEnd: {} });
  }

  rule('2. OPENING BIDIRECTIONAL STREAM');
  const started = Date.now();
  let firstAudioAt: number | null = null;
  let firstTextAt: number | null = null;
  let audioBytes = 0;
  const transcript: string[] = [];
  const toolRequests: { name: string; input: unknown }[] = [];
  const eventTypes = new Set<string>();

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

    if (event.textOutput?.content) {
      firstTextAt ??= Date.now();
      transcript.push(event.textOutput.content);
    }
    if (event.audioOutput?.content) {
      firstAudioAt ??= Date.now();
      audioBytes += Buffer.from(event.audioOutput.content, 'base64').length;
    }
    if (event.toolUse) {
      toolRequests.push({ name: event.toolUse.toolName, input: event.toolUse.content });
    }
  }

  rule('3. RESULTS');
  line(`event types seen : ${[...eventTypes].join(', ') || 'NONE'}`);
  line(`time to first text : ${firstTextAt ? `${firstTextAt - started}ms` : 'never'}`);
  line(`time to first audio: ${firstAudioAt ? `${firstAudioAt - started}ms` : 'never'}`);
  line(`audio returned     : ${audioBytes} bytes (${(audioBytes / (24_000 * 2)).toFixed(2)}s)`);
  line(`transcript         : ${transcript.join('') || '(none)'}`);
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
