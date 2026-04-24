import { useEffect, useRef, useState } from 'react';

export interface LiveModel {
  id: string;
  name: string;
  loaded?: boolean;
}

interface ProviderLike {
  id: string;
  endpoint: string;
  apiKey?: string;
  models?: string[];
}

interface UseLiveModelsOptions {
  // Provider selection: when set, use the provider's endpoint/apiKey. When '_local'/undefined, use localEndpoint.
  providerId: string | undefined;
  providers: ProviderLike[];
  localEndpoint?: string;
  // Skip fetching (e.g., component not open yet)
  enabled?: boolean;
}

/**
 * Fetches the live list of models from whichever endpoint the caller is pointing at.
 * Auto-refetches when providerId or localEndpoint changes. Discards stale responses
 * (e.g., a slow fetch from the old endpoint resolving after the user switched).
 */
export function useLiveModels({ providerId, providers, localEndpoint, enabled = true }: UseLiveModelsOptions) {
  const [models, setModels] = useState<LiveModel[]>([]);
  const [loading, setLoading] = useState(false);
  const activeEndpoint = useRef<string>('');

  const resolveTarget = (): { endpoint: string; apiKey?: string; fallbackList: string[] } | null => {
    if (providerId && providerId !== '_local') {
      const p = providers.find((x) => x.id === providerId);
      if (!p || !p.endpoint) return null;
      return { endpoint: p.endpoint, apiKey: p.apiKey, fallbackList: p.models || [] };
    }
    if (!localEndpoint) return null;
    return { endpoint: localEndpoint, fallbackList: [] };
  };

  const refetch = async () => {
    if (!enabled) return;
    const target = resolveTarget();
    if (!target) {
      setModels([]);
      return;
    }
    activeEndpoint.current = target.endpoint;
    setLoading(true);
    try {
      const params = new URLSearchParams({ endpoint: target.endpoint });
      if (target.apiKey) params.set('apiKey', target.apiKey);
      const res = await fetch(`/api/services/models?${params}`);
      if (!res.ok) {
        if (activeEndpoint.current === target.endpoint) {
          setModels(target.fallbackList.map((id) => ({ id, name: id })));
        }
        return;
      }
      const data = await res.json();
      if (activeEndpoint.current !== target.endpoint) return; // stale
      const raw: LiveModel[] = (data.models || []).map((m: { id: string; loaded?: boolean }) => ({
        id: m.id,
        name: m.id,
        ...(typeof m.loaded === 'boolean' ? { loaded: m.loaded } : {}),
      }));
      const seen = new Set<string>();
      const deduped = raw.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      setModels(deduped.length > 0 ? deduped : target.fallbackList.map((id) => ({ id, name: id })));
    } catch {
      const target2 = resolveTarget();
      if (target2 && activeEndpoint.current === target2.endpoint) {
        setModels(target2.fallbackList.map((id) => ({ id, name: id })));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refetch();
    // Intentionally not depending on providers array identity — only id/endpoint shape matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, localEndpoint, enabled]);

  return { models, loading, refetch };
}
