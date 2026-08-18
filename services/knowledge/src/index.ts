import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { upstreamUnavailable, type KnowledgeHit } from '@ucc/types';
import { buildChunks, type CorpusChunk } from './corpus.ts';

export * from './corpus.ts';

interface IndexedChunk extends CorpusChunk {
  embedding: number[];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'what', 'which',
  'how', 'for', 'to', 'of', 'in', 'on', 'at', 'and', 'or', 'my', 'i', 'me', 'you',
  'can', 'need', 'want', 'about', 'tell', 'please',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

/**
 * Public knowledge retrieval for Infinize University.
 *
 * Vectors come from Amazon Titan Text Embeddings v2 via Bedrock — this is genuine
 * semantic retrieval, not keyword matching. A deterministic lexical scorer is retained
 * as an offline fallback so tests and air-gapped demos still exercise the same code path.
 *
 * ARCHITECTURE NOTE (ADR-0003): production should swap this for a Bedrock Knowledge Base
 * backed by OpenSearch Serverless. The `search` contract does not change.
 */
export class KnowledgeService {
  private index: IndexedChunk[] = [];
  private lexicalOnly = false;
  private ready = false;
  private failureMode = false;
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly tenantId: string = config().DEFAULT_TENANT_ID) {
    this.client = new BedrockRuntimeClient({ region: config().AWS_REGION });
  }

  /** Demo seam: force a KB outage so the escalation path can be proven. */
  setFailureMode(enabled: boolean): void {
    this.failureMode = enabled;
    logger.warn('Knowledge base failure mode changed', { enabled });
  }

  isReady(): boolean {
    return this.ready;
  }

  isLexicalFallback(): boolean {
    return this.lexicalOnly;
  }

  size(): number {
    return this.index.length;
  }

  /**
   * Build the vector index.
   *
   * If Bedrock embedding is unavailable the service degrades to lexical scoring and says
   * so, rather than silently returning poor results.
   */
  async initialize(): Promise<void> {
    if (this.ready) return;
    const chunks = await buildChunks();

    if (config().UCC_RETRIEVAL === 'lexical') {
      this.index = chunks.map((c) => ({ ...c, embedding: [] }));
      this.lexicalOnly = true;
      this.ready = true;
      logger.info('Knowledge base ready (lexical mode)', { chunks: this.index.length });
      return;
    }

    try {
      // Embed with bounded concurrency. One request per chunk serially takes minutes for a
      // corpus this size; Bedrock handles the parallelism comfortably and the cap keeps us
      // well inside per-account request limits.
      const CONCURRENCY = 8;
      const embedded: IndexedChunk[] = new Array(chunks.length);
      let next = 0;

      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next;
          next += 1;
          if (i >= chunks.length) return;
          const chunk = chunks[i]!;
          embedded[i] = { ...chunk, embedding: await this.embed(chunk.content) };
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()),
      );

      this.index = embedded;
      this.lexicalOnly = false;
      this.ready = true;
      logger.info('Knowledge base ready (Bedrock embeddings)', {
        chunks: this.index.length,
        model: config().BEDROCK_EMBEDDING_MODEL_ID,
      });
    } catch (error) {
      logger.error('Embedding failed; falling back to lexical retrieval', {
        error: String(error),
      });
      this.index = chunks.map((c) => ({ ...c, embedding: [] }));
      this.lexicalOnly = true;
      this.ready = true;
    }
  }

  private async embed(text: string): Promise<number[]> {
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: config().BEDROCK_EMBEDDING_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text.slice(0, 8000) }),
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
    return parsed.embedding;
  }

  /**
   * Retrieve passages relevant to a public question.
   *
   * Throws `UPSTREAM_UNAVAILABLE` when the knowledge base is unusable, so the orchestrator
   * escalates instead of answering unsourced (spec FR-012).
   */
  async search(query: string, topK = 4): Promise<KnowledgeHit[]> {
    if (this.failureMode) throw upstreamUnavailable('The knowledge base');
    if (!this.ready) await this.initialize();
    if (this.index.length === 0) throw upstreamUnavailable('The knowledge base');

    const scored = this.lexicalOnly
      ? this.scoreLexical(query)
      : await this.scoreSemantic(query);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter((hit) => hit.score > 0);
  }

  private async scoreSemantic(query: string): Promise<KnowledgeHit[]> {
    let queryVector: number[];
    try {
      queryVector = await this.embed(query);
    } catch (error) {
      logger.warn('Query embedding failed; using lexical scoring for this query', {
        error: String(error),
      });
      return this.scoreLexical(query);
    }
    return this.index.map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      title: chunk.title,
      category: chunk.category,
      content: chunk.content,
      sourceUri: chunk.sourceUri,
      score: cosine(queryVector, chunk.embedding),
    }));
  }

  /** Deterministic offline scorer: term overlap weighted by inverse chunk length. */
  private scoreLexical(query: string): KnowledgeHit[] {
    const terms = tokenize(query);
    return this.index.map((chunk) => {
      const haystack = `${chunk.title} ${chunk.content}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const occurrences = haystack.split(term).length - 1;
        if (occurrences > 0) score += 1 + Math.log(occurrences);
      }
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        title: chunk.title,
        category: chunk.category,
        content: chunk.content,
        sourceUri: chunk.sourceUri,
        score: terms.length ? score / terms.length : 0,
      };
    });
  }

  /** Document listing for the /knowledge screen. */
  async documents(): Promise<{ documentId: string; title: string; category: string; chunks: number }[]> {
    if (!this.ready) await this.initialize();
    const byDoc = new Map<string, { title: string; category: string; chunks: number }>();
    for (const chunk of this.index) {
      const existing = byDoc.get(chunk.documentId);
      if (existing) existing.chunks += 1;
      else
        byDoc.set(chunk.documentId, {
          title: chunk.title.split(' — ')[0]!,
          category: chunk.category,
          chunks: 1,
        });
    }
    return [...byDoc.entries()].map(([documentId, v]) => ({ documentId, ...v }));
  }
}
