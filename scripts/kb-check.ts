/** Verify live Bedrock embedding retrieval. */
import { buildContainer } from '../apps/ucc-api/src/bootstrap/container.ts';

const c = await buildContainer();
console.log('retrieval:', c.knowledge.isLexicalFallback() ? 'LEXICAL_FALLBACK' : 'BEDROCK_EMBEDDINGS');
console.log('chunks:', c.knowledge.size());
const hits = await c.knowledge.search('what paperwork does a masters applicant have to send in', 3);
for (const h of hits) console.log(`   ${h.score.toFixed(3)}  ${h.title}`);
process.exit(0);
