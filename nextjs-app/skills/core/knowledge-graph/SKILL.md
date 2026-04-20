---
name: knowledge-graph
description: Search and query the ForgeRAG engineering knowledge graph. Ask questions about materials, welding, standards, formulas, reference tables, and specifications — get answers with page citations from ASM handbooks, ASME codes, NFPA, IEEE, and other engineering references.
version: 1.1.0
author: system
tools:
  - ask_engineering_question
  - find_relevant_chunks
  - search_engineering_docs
  - query_knowledge_graph
  - explore_entity
  - list_knowledge_collections
dependencies: []
---

# Engineering Knowledge Graph (ForgeRAG)

Search engineering handbooks, standards, and specifications. The knowledge graph contains materials, processes, standards, equipment, formulas, reference tables, and their relationships extracted from ingested PDF documents — now with paragraph-level structural chunking, LLM-generated chunk summaries, and RRF hybrid retrieval (BGE-M3 dense + BM25 + cross-encoder reranker).

## When to Use

| Tool | Use when… |
|---|---|
| `ask_engineering_question` | The user wants a synthesized answer with citations. Uses RRF hybrid + VLM reading of page images. Primary tool. |
| `find_relevant_chunks` | You need precise evidence to quote (a specific paragraph, table, or equation). Returns raw chunk text + summary without the VLM synthesis step. Faster than ask_engineering_question. |
| `search_engineering_docs` (mode="keyword") | Looking up a specific code, alloy designation, clause number, or standard (C12000, QW-451.1, NFPA 70, SEMI S2). |
| `search_engineering_docs` (mode="visual") | Finding pages by visual similarity — charts, tables, diagrams, schematics. Uses Nemotron ColEmbed. |
| `query_knowledge_graph` | How entities relate to each other — what standards govern a material, what materials are compatible with a process, which standards cross-reference. |
| `explore_entity` | Everything connected to one specific entity (N-hop neighborhood). |
| `list_knowledge_collections` | Discovery — what engineering databases are available. |

## Tool selection patterns

- **"What does ASTM A36 require for…"** → `ask_engineering_question` (narrative answer)
- **"Quote the exact text of QW-451.1"** → `find_relevant_chunks` (precise quotation)
- **"Find the tap drill table"** → `find_relevant_chunks` with chunk_type="table"
- **"What formula is used for beam deflection?"** → `find_relevant_chunks` with chunk_type="equation", then `ask_engineering_question` if more context needed
- **"Show me the torque chart"** → `search_engineering_docs` with mode="visual" (page images)

## Important

- `ask_engineering_question` is the primary synthesis tool — RRF hybrid retrieval + VLM reading pages + graph context → answer with [Page N] citations
- `find_relevant_chunks` returns paragraph/table-precise results with LLM summaries — use it for precise quoting or when you want to inspect the raw evidence before synthesizing
- For specific alloy codes (C12000, A36) or clause IDs (QW-451.1, NFPA 70-15A §7.2.3), keyword search often nails exact matches faster than the hybrid retriever
- The graph stores Materials, Processes, Standards, Equipment, **Formulas**, and **RefTables** — use `explore_entity` to discover cross-references and relationships
- Standards have BOTH a short `code` (e.g., "SEMI S2") and a `title` (e.g., "Environmental, Health, and Safety Guideline for Semiconductor Manufacturing Equipment") — queries resolve either form
- Collections organize documents by domain (asm_references, mechanical_design, firearms, etc.) — specify a collection to narrow searches
- Page-level `topic_tags` classify content topically (tap-drill-chart, fastener-torque, conductor-ampacity, etc.) — helpful for filtering
- Answers include page numbers — cite them when reporting findings
- The system reads actual page images via a VLM, so it can interpret tables, charts, and diagrams that text extraction misses
