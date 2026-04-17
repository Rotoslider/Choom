---
name: knowledge-graph
description: Search and query the ForgeRAG engineering knowledge graph. Ask questions about materials, welding, standards, and specifications — get answers with page citations from ASM handbooks, ASME codes, and other engineering references.
version: 1.0.0
author: system
tools:
  - ask_engineering_question
  - search_engineering_docs
  - query_knowledge_graph
  - explore_entity
  - list_knowledge_collections
dependencies: []
---

# Engineering Knowledge Graph (ForgeRAG)

Search engineering handbooks, standards, and specifications. The knowledge graph contains materials, processes, standards, equipment, and their relationships extracted from ingested PDF documents.

## When to Use
- User asks about engineering materials, alloys, welding, heat treatment, mechanical properties → `ask_engineering_question`
- User needs to find a specific code, alloy designation, clause number, or standard → `search_engineering_docs` with mode="keyword"
- User needs to find pages with specific charts, tables, or diagrams → `search_engineering_docs` with mode="visual"
- User asks how materials, processes, and standards relate to each other → `query_knowledge_graph`
- User wants to know everything connected to a specific material, process, or standard → `explore_entity`
- User asks what engineering databases/collections are available → `list_knowledge_collections`

## Important
- `ask_engineering_question` is the primary tool — it searches, reads page images via VLM, and synthesizes an answer with citations
- For specific alloy codes (C12000, A36) or clause IDs (QW-451.1), use `search_engineering_docs` with mode="keyword" first
- The knowledge graph contains relationships between entities — use `explore_entity` to discover connections the user didn't ask about
- Collections organize documents by domain (asm_references, mechanical_design, etc.) — specify a collection to narrow searches
- Answers include page numbers — cite them when reporting findings
- The system reads actual page images, so it can interpret tables, charts, and diagrams that text extraction misses
