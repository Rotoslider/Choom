/**
 * ForgeRAG HTTP client — mirrors the MemoryClient pattern.
 *
 * Calls the ForgeRAG service (default: http://localhost:8200) for
 * engineering knowledge graph search, answer generation, graph queries,
 * and entity exploration.
 */

import { ensureEndpoint } from './utils';

export interface ForgeResult {
  success: boolean;
  reason?: string;
  data?: unknown;
}

export class ForgeRAGClient {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: Record<string, unknown>
  ): Promise<ForgeResult> {
    const url = ensureEndpoint(this.endpoint, path);
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120000), // 2 min timeout for VLM answers
      });
      if (!response.ok) {
        const error = await response.text();
        return { success: false, reason: `HTTP ${response.status}: ${error.slice(0, 500)}` };
      }
      return response.json();
    } catch (err) {
      return {
        success: false,
        reason: `ForgeRAG request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---- Health ----

  async health(): Promise<ForgeResult> {
    return this.request('/health');
  }

  // ---- Collections ----

  async listCollections(): Promise<ForgeResult> {
    return this.request('/collections');
  }

  // ---- Search / Answer ----

  async answer(
    query: string,
    options: {
      limit?: number;
      search_mode?: string;
      use_vision?: boolean;
      use_graph?: boolean;
      include_adjacent?: boolean;
      collection?: string;
    } = {}
  ): Promise<ForgeResult> {
    return this.request('/search/answer', 'POST', {
      query,
      limit: options.limit || 5,
      // "auto" uses chunk-aware RRF hybrid (BGE-M3 + BM25 + bge-reranker)
      // fused with Nemotron visual. Callers can still override to
      // "keyword" / "visual" / "semantic" / "hybrid".
      search_mode: options.search_mode || 'auto',
      use_vision: options.use_vision !== false,
      use_graph: options.use_graph !== false,
      include_adjacent: options.include_adjacent !== false,
      ...(options.collection ? { filters: { collection: options.collection } } : {}),
    });
  }

  async searchKeyword(
    query: string,
    options: { limit?: number; collection?: string } = {}
  ): Promise<ForgeResult> {
    return this.request('/search/keyword', 'POST', {
      query,
      limit: options.limit || 10,
    });
  }

  async searchVisual(
    query: string,
    options: { limit?: number; candidate_pool?: number } = {}
  ): Promise<ForgeResult> {
    return this.request('/search/visual', 'POST', {
      query,
      limit: options.limit || 5,
      candidate_pool: options.candidate_pool || 30,
    });
  }

  /**
   * Chunk-level retrieval — BGE-M3 dense + BM25 + bge-reranker over
   * structural chunks (paragraphs, tables, figures, equations).
   * Returns raw chunk text + summary + section_path for precise
   * quoting, without running the VLM. Use this when you need to cite
   * a specific paragraph or table rather than synthesize an answer.
   */
  async searchChunks(
    query: string,
    options: {
      limit?: number;
      chunk_type?: string;
      collection?: string;
      rerank?: boolean;
    } = {}
  ): Promise<ForgeResult> {
    return this.request('/search/chunks', 'POST', {
      query,
      limit: options.limit || 10,
      rerank: options.rerank !== false,
      ...(options.chunk_type ? { chunk_type: options.chunk_type } : {}),
      ...(options.collection
        ? { filters: { collection: options.collection } }
        : {}),
    });
  }

  // ---- Graph ----

  async graphQuery(
    queryType: string,
    parameters: Record<string, string>,
    options: { limit?: number } = {}
  ): Promise<ForgeResult> {
    return this.request('/graph/query', 'POST', {
      query_type: queryType,
      parameters,
      limit: options.limit || 50,
    });
  }

  async graphExplore(
    entityType: string,
    entityName: string,
    options: { depth?: number; limit?: number } = {}
  ): Promise<ForgeResult> {
    return this.request('/graph/explore', 'POST', {
      entity_type: entityType,
      entity_name: entityName,
      depth: options.depth || 2,
      limit: options.limit || 50,
    });
  }

  async graphStats(): Promise<ForgeResult> {
    return this.request('/graph/stats');
  }

  async listEntities(
    entityType: string,
    options: { limit?: number } = {}
  ): Promise<ForgeResult> {
    return this.request(
      `/graph/entities/${entityType}?limit=${options.limit || 100}`
    );
  }

  // ---- Documents ----

  async listDocuments(options: { collection?: string; limit?: number } = {}): Promise<ForgeResult> {
    const params = new URLSearchParams({ limit: String(options.limit || 50) });
    if (options.collection) params.set('collection', options.collection);
    return this.request(`/documents?${params}`);
  }

  async getPageDetail(docId: string, pageNumber: number): Promise<ForgeResult> {
    return this.request(`/documents/${docId}/pages/${pageNumber}`);
  }
}

/**
 * Execute a ForgeRAG tool call — dispatcher for the skill handler.
 */
export async function executeForgeRAGTool(
  client: ForgeRAGClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<ForgeResult> {
  switch (toolName) {
    case 'ask_engineering_question': {
      const query = String(args.query || '');
      if (!query) return { success: false, reason: 'query is required' };
      return client.answer(query, {
        limit: Number(args.limit) || 5,
        collection: args.collection ? String(args.collection) : undefined,
        use_vision: args.use_vision !== false,
        use_graph: args.use_graph !== false,
      });
    }

    case 'search_engineering_docs': {
      const query = String(args.query || '');
      if (!query) return { success: false, reason: 'query is required' };
      const mode = String(args.mode || 'keyword');
      if (mode === 'keyword') {
        return client.searchKeyword(query, {
          limit: Number(args.limit) || 10,
          collection: args.collection ? String(args.collection) : undefined,
        });
      }
      return client.searchVisual(query, {
        limit: Number(args.limit) || 5,
      });
    }

    case 'find_relevant_chunks': {
      const query = String(args.query || '');
      if (!query) return { success: false, reason: 'query is required' };
      return client.searchChunks(query, {
        limit: Number(args.limit) || 10,
        chunk_type: args.chunk_type ? String(args.chunk_type) : undefined,
        collection: args.collection ? String(args.collection) : undefined,
        rerank: args.rerank !== false,
      });
    }

    case 'query_knowledge_graph': {
      const queryType = String(args.query_type || '');
      const parameters = (args.parameters || {}) as Record<string, string>;
      if (!queryType) return { success: false, reason: 'query_type is required' };
      return client.graphQuery(queryType, parameters, {
        limit: Number(args.limit) || 50,
      });
    }

    case 'explore_entity': {
      const entityType = String(args.entity_type || '');
      const entityName = String(args.entity_name || '');
      if (!entityType || !entityName)
        return { success: false, reason: 'entity_type and entity_name are required' };
      return client.graphExplore(entityType, entityName, {
        depth: Number(args.depth) || 2,
        limit: Number(args.limit) || 50,
      });
    }

    case 'list_knowledge_collections': {
      return client.listCollections();
    }

    default:
      return { success: false, reason: `Unknown ForgeRAG tool: ${toolName}` };
  }
}
