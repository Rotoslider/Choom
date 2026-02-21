import type { Memory, MemoryStats, MemoryType } from './types';
import { ensureEndpoint } from './utils';

export interface MemoryServerResult {
  success: boolean;
  reason?: string;
  data?: unknown[];
}

export class MemoryClient {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: Record<string, unknown>
  ): Promise<MemoryServerResult> {
    const url = ensureEndpoint(this.endpoint, path);

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, reason: `Request failed: ${error}` };
    }

    return response.json();
  }

  // Store a new memory
  async remember(
    title: string,
    content: string,
    options: {
      tags?: string;
      importance?: number;
      memory_type?: MemoryType;
      companion_id?: string;
    } = {}
  ): Promise<MemoryServerResult> {
    return this.request('/memory/remember', 'POST', {
      title,
      content,
      tags: options.tags || '',
      importance: options.importance || 5,
      memory_type: options.memory_type || 'conversation',
      companion_id: options.companion_id || 'default',
    });
  }

  // Semantic search
  async search(
    query: string,
    limit: number = 10,
    companion_id?: string
  ): Promise<MemoryServerResult> {
    return this.request('/memory/search', 'POST', {
      query,
      limit,
      companion_id,
    });
  }

  // Search by memory type
  async searchByType(
    memory_type: MemoryType,
    limit: number = 20,
    companion_id?: string
  ): Promise<MemoryServerResult> {
    return this.request('/memory/search_by_type', 'POST', {
      memory_type,
      limit,
      companion_id,
    });
  }

  // Search by tags
  async searchByTags(
    tags: string,
    limit: number = 20,
    companion_id?: string
  ): Promise<MemoryServerResult> {
    return this.request('/memory/search_by_tags', 'POST', {
      tags,
      limit,
      companion_id,
    });
  }

  // Search by date range
  async searchByDateRange(
    date_from: string,
    date_to?: string,
    limit: number = 50,
    companion_id?: string
  ): Promise<MemoryServerResult> {
    return this.request('/memory/search_by_date_range', 'POST', {
      date_from,
      date_to,
      limit,
      companion_id,
    });
  }

  // Get recent memories
  async getRecent(limit: number = 20, companion_id?: string): Promise<MemoryServerResult> {
    return this.request('/memory/recent', 'POST', {
      limit,
      companion_id,
    });
  }

  // Update a memory
  async update(
    memory_id: string,
    updates: {
      title?: string;
      content?: string;
      tags?: string;
      importance?: number;
      memory_type?: MemoryType;
    }
  ): Promise<MemoryServerResult> {
    return this.request(`/memory/${memory_id}`, 'PUT', updates);
  }

  // Delete a memory
  async delete(memory_id: string): Promise<MemoryServerResult> {
    return this.request(`/memory/${memory_id}`, 'DELETE');
  }

  // Get memory statistics
  async getStats(companion_id?: string): Promise<MemoryServerResult> {
    if (companion_id) {
      return this.request('/memory/stats', 'POST', { companion_id });
    }
    return this.request('/memory/stats', 'GET');
  }

  // Create backup
  async createBackup(): Promise<MemoryServerResult> {
    return this.request('/memory/backup', 'POST');
  }

  // Rebuild vector index
  async rebuildVectors(): Promise<MemoryServerResult> {
    return this.request('/memory/rebuild_vectors', 'POST');
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.getStats();
      return result.success;
    } catch {
      return false;
    }
  }
}

// Execute a memory tool by name
export async function executeMemoryTool(
  client: MemoryClient,
  toolName: string,
  args: Record<string, unknown>,
  companionId?: string
): Promise<MemoryServerResult> {
  switch (toolName) {
    case 'remember':
      return client.remember(
        args.title as string,
        args.content as string,
        {
          tags: args.tags as string,
          importance: args.importance as number,
          memory_type: args.memory_type as MemoryType,
          companion_id: companionId,
        }
      );

    case 'search_memories':
      return client.search(
        args.query as string,
        (args.limit as number) || 10,
        companionId
      );

    case 'search_by_type':
      return client.searchByType(
        args.memory_type as MemoryType,
        (args.limit as number) || 20,
        companionId
      );

    case 'search_by_tags':
      return client.searchByTags(
        args.tags as string,
        (args.limit as number) || 20,
        companionId
      );

    case 'get_recent_memories':
      return client.getRecent((args.limit as number) || 20, companionId);

    case 'search_by_date_range':
      return client.searchByDateRange(
        args.date_from as string,
        args.date_to as string,
        (args.limit as number) || 50,
        companionId
      );

    case 'update_memory':
      return client.update(args.memory_id as string, {
        title: args.title as string,
        content: args.content as string,
        tags: args.tags as string,
        importance: args.importance as number,
        memory_type: args.memory_type as MemoryType,
      });

    case 'delete_memory':
      return client.delete(args.memory_id as string);

    case 'get_memory_stats':
      return client.getStats(companionId);

    default:
      return { success: false, reason: `Unknown memory tool: ${toolName}` };
  }
}
