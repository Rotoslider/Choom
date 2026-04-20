import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'ask_engineering_question',
    description:
      'Ask a question about engineering materials, processes, standards, formulas, ' +
      'reference tables, or specifications. The system uses RRF hybrid retrieval ' +
      '(BGE-M3 dense + BM25 + bge-reranker cross-encoder) over structural chunks, ' +
      'augments with Nemotron visual search for charts/diagrams, retrieves relevant ' +
      'pages from engineering handbooks, reads the actual page images using a vision ' +
      'LLM, and synthesizes an answer with [Page N] citations. Use this as the ' +
      'primary research tool when you want a synthesized answer.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The engineering question to answer. Be specific — include alloy designations, ' +
            'standard numbers, process names. Example: "What preheat does ASME IX require ' +
            'for P-1 materials over 1 inch thick?"',
        },
        collection: {
          type: 'string',
          description:
            'Optional: limit search to a specific collection (e.g., "asm_references", ' +
            '"mechanical_design"). Omit to search all collections.',
        },
        limit: {
          type: 'number',
          description: 'Number of source pages to read (default 5, max 10). More pages = more thorough but slower.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_relevant_chunks',
    description:
      'Retrieve the most relevant structural CHUNKS (paragraphs, tables, figures, ' +
      'equations) for a query without synthesizing an answer. Uses BGE-M3 dense + ' +
      'BM25 + bge-reranker over the chunk-level index. Returns raw chunk text + ' +
      'LLM-generated summary + section path + page/document linkage. Use this when ' +
      'you want to quote specific paragraphs or inspect specific tables, or when ' +
      'you want to gather evidence before synthesizing. Faster than ' +
      'ask_engineering_question (no VLM pass) — ideal for "what does section X say" ' +
      'or "find the tap drill table" queries.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The topic or phrase to search for. Natural language works ' +
            'well — summaries smooth out jargon differences.',
        },
        chunk_type: {
          type: 'string',
          description:
            'Optional: filter to a specific structural type. "table" for ' +
            'reference tables, "figure" for figure captions, "equation" for ' +
            'formula blocks, "list" for enumerated items, "text" for prose ' +
            'paragraphs. Omit to return all types.',
          enum: ['text', 'table', 'figure', 'equation', 'list', 'caption', 'heading'],
        },
        collection: {
          type: 'string',
          description: 'Optional: limit to a specific collection.',
        },
        limit: {
          type: 'number',
          description: 'Max chunks to return (default 10, max 50).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_engineering_docs',
    description:
      'Search engineering documents by keyword or visual similarity. Use mode="keyword" for ' +
      'exact codes/designations (C12000, QW-451.1, ASTM A 709). Use mode="visual" to find ' +
      'pages with specific charts, tables, or diagrams. Returns page references with snippets ' +
      'and image URLs — does NOT synthesize an answer (use ask_engineering_question for that).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — an exact code for keyword mode, or descriptive text for visual mode.',
        },
        mode: {
          type: 'string',
          description: 'Search mode: "keyword" for exact text match, "visual" for ColPali visual retrieval.',
          enum: ['keyword', 'visual'],
        },
        collection: {
          type: 'string',
          description: 'Optional: limit to a specific collection.',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_knowledge_graph',
    description:
      'Run a predefined graph query to find relationships between engineering entities. ' +
      'Query types: "material_standards" (what standards govern a material?), ' +
      '"process_materials" (what materials work with a process?), ' +
      '"standard_cross_references" (what standards reference each other?), ' +
      '"material_properties" (properties of a specific material), ' +
      '"equipment_requirements" (what applies to an equipment type?), ' +
      '"entity_pages" (all pages mentioning a specific entity).',
    parameters: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          description: 'The type of graph query to run.',
          enum: [
            'material_standards',
            'process_materials',
            'standard_cross_references',
            'material_properties',
            'equipment_requirements',
            'entity_pages',
          ],
        },
        parameters: {
          type: 'object',
          description:
            'Query parameters. Each query_type requires different keys: ' +
            'material_standards → {material: "Alloy 625"}, ' +
            'process_materials → {process: "GTAW"}, ' +
            'standard_cross_references → {standard: "ASME BPVC Section IX"}, ' +
            'material_properties → {material: "ASTM A36"}, ' +
            'equipment_requirements → {equipment: "pressure vessel"}, ' +
            'entity_pages → {entity_name: "C12000"}.',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 50).',
        },
      },
      required: ['query_type', 'parameters'],
    },
  },
  {
    name: 'explore_entity',
    description:
      'Explore the knowledge graph neighborhood of a specific entity. Returns all connected ' +
      'entities within N hops — materials, processes, standards, equipment, and the pages ' +
      'that mention them. Use this to discover relationships the user didn\'t ask about.',
    parameters: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          description: 'Type of entity to start from.',
          enum: ['material', 'process', 'standard', 'equipment'],
        },
        entity_name: {
          type: 'string',
          description:
            'Name of the entity. Use canonical designations: "ASTM A36", "GTAW", ' +
            '"ASME BPVC Section IX", "Alloy 625".',
        },
        depth: {
          type: 'number',
          description: 'How many hops to traverse (1-3, default 2). Higher = more connections but noisier.',
        },
      },
      required: ['entity_type', 'entity_name'],
    },
  },
  {
    name: 'list_knowledge_collections',
    description:
      'List all available engineering knowledge collections with document and page counts. ' +
      'Collections organize documents by domain (e.g., "asm_references", "mechanical_design", ' +
      '"firearms"). Use this to know what databases are available before searching.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
