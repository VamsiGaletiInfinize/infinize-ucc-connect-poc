import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CorpusDocument {
  documentId: string;
  title: string;
  category: string;
  sourceUri: string;
  body: string;
}

export interface CorpusChunk {
  id: string;
  documentId: string;
  title: string;
  category: string;
  sourceUri: string;
  content: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** services/knowledge/src -> repo root -> data/knowledge */
export const KNOWLEDGE_DIR = path.resolve(here, '../../../data/knowledge');

/** Parse the YAML-ish frontmatter block used by the corpus files. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

export async function loadCorpus(dir: string = KNOWLEDGE_DIR): Promise<CorpusDocument[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  const docs: CorpusDocument[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    docs.push({
      documentId: file.replace(/\.md$/, ''),
      title: meta.title ?? file,
      category: meta.category ?? 'General',
      sourceUri: meta.sourceUri ?? `file://${file}`,
      body: body.trim(),
    });
  }
  return docs;
}

/**
 * Split a document on markdown headings, then pack sections into chunks.
 *
 * Heading-aware splitting keeps a fee table or a document checklist intact, which matters
 * far more for answer quality than a uniform token count would.
 */
export function chunkDocument(doc: CorpusDocument, maxChars = 1400): CorpusChunk[] {
  const sections: { heading: string; text: string }[] = [];
  let heading = doc.title;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of doc.body.split(/\r?\n/)) {
    if (/^#{1,3}\s+/.test(line)) {
      flush();
      heading = line.replace(/^#+\s+/, '').trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  const chunks: CorpusChunk[] = [];
  let index = 0;
  for (const section of sections) {
    // A section longer than the budget is split on paragraph boundaries so tables and
    // lists are not cut mid-row.
    const parts: string[] = [];
    if (section.text.length <= maxChars) {
      parts.push(section.text);
    } else {
      let current = '';
      for (const para of section.text.split(/\n\s*\n/)) {
        if (current && current.length + para.length > maxChars) {
          parts.push(current.trim());
          current = '';
        }
        current += `${para}\n\n`;
      }
      if (current.trim()) parts.push(current.trim());
    }

    for (const part of parts) {
      chunks.push({
        id: `${doc.documentId}#${index}`,
        documentId: doc.documentId,
        title: `${doc.title} — ${section.heading}`,
        category: doc.category,
        sourceUri: doc.sourceUri,
        // The heading is prepended so the embedding captures section context.
        content: `${section.heading}\n\n${part}`,
      });
      index += 1;
    }
  }

  return chunks;
}

export async function buildChunks(dir?: string): Promise<CorpusChunk[]> {
  const docs = await loadCorpus(dir);
  return docs.flatMap((d) => chunkDocument(d));
}
