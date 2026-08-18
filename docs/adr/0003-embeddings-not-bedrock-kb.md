# ADR-0003 — Titan embeddings with in-process retrieval instead of Bedrock Knowledge Bases

**Status:** Accepted · **Date:** 2026-08-14

## Context

Public university information needs semantic retrieval. The AWS-native answer is Amazon
Bedrock Knowledge Bases, which requires an OpenSearch Serverless collection.

## Decision

Use Amazon Titan Text Embeddings v2 through Bedrock, with heading-aware chunking and cosine
similarity over a persisted index, behind a `search(query, topK)` interface.

## Rationale

OpenSearch Serverless has a minimum capacity floor that costs money continuously and takes
minutes to provision — for a corpus of 41 chunks. Retrieval is genuinely vector-based
either way; what Bedrock KB adds at this scale is operational cost and provisioning time,
not answer quality.

Chunking splits on markdown headings rather than a fixed token count, which keeps a fee
table or a document checklist intact. That matters more for answer quality here than the
choice of vector store.

## Consequences

**Positive.** Real semantic retrieval, no standing infrastructure cost, sub-second startup.
A deterministic lexical scorer is retained as an offline fallback, so tests and air-gapped
demos exercise the same code path and the same failure behaviour.

**Negative.** The index is rebuilt at process start and held in memory. This does not
survive to production scale — a corpus of thousands of documents across a hundred tenants
will not sit in one process, and rebuilding on every deploy wastes embedding spend.

**Production path.** Swap the `KnowledgeService.search` implementation for Bedrock KB +
OpenSearch Serverless. The interface, the citation contract and the failure behaviour do
not change.

## Failure behaviour

Retrieval failure raises `UPSTREAM_UNAVAILABLE`, which escalates to a human. It does not
degrade to the model answering from general knowledge — that would violate the
no-fabrication principle (constitution Principle IV) and is covered by an E2E test.
