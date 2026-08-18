/**
 * UCC API client.
 *
 * The browser holds NO AWS credentials and makes NO direct AWS calls (spec FR-020).
 * Every AWS interaction — Bedrock, DynamoDB, S3, Connect — happens server-side in ucc-api.
 */

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export class UccApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'UccApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const err = body as ApiError;
    throw new UccApiError(
      err?.error ?? 'REQUEST_FAILED',
      err?.message ?? response.statusText,
      response.status,
      err?.details,
    );
  }
  return body as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

export const api = {
  health: () => get<any>('/health'),
  demoState: () => get<any>('/api/demo/state'),
  setFailureMode: (target: 'knowledge' | 'applications', enabled: boolean) =>
    post<any>('/api/demo/failure-mode', { target, enabled }),

  // calls
  listCalls: () => get<any[]>('/api/calls'),
  getCall: (id: string) => get<any>(`/api/calls/${id}`),
  startInbound: (callerPhoneNumber: string) =>
    post<any>('/api/calls/inbound', { callerPhoneNumber }),
  turn: (callId: string, utterance: string) =>
    post<any>(`/api/calls/${callId}/turn`, { utterance }),
  verify: (callId: string, code: string) => post<any>(`/api/calls/${callId}/verify`, { code }),
  aiResolve: (callId: string, summary: string) =>
    post<any>(`/api/calls/${callId}/ai-resolve`, { summary }),
  endCall: (callId: string, reason?: string) =>
    post<any>(`/api/calls/${callId}/end`, reason ? { reason } : {}),

  // tickets
  listTickets: () => get<any[]>('/api/tickets'),
  getTicket: (id: string) => get<any>(`/api/tickets/${id}`),
  acceptTicket: (id: string, agentId: string) =>
    post<any>(`/api/tickets/${id}/accept`, { agentId }),
  addNote: (id: string, agentId: string, body: string) =>
    post<any>(`/api/tickets/${id}/notes`, { agentId, body }),
  resolveTicket: (id: string, agentId: string, resolution: string) =>
    post<any>(`/api/tickets/${id}/resolve`, { agentId, resolution }),
  closeTicket: (id: string, agentId?: string) =>
    post<any>(`/api/tickets/${id}/close`, agentId ? { agentId } : {}),

  // org
  listAgents: () => get<any[]>('/api/agents'),
  setAgentStatus: (id: string, status: string) =>
    post<any>(`/api/agents/${id}/status`, { status }),
  listQueues: () => get<any[]>('/api/queues'),

  // knowledge
  knowledge: () => get<any>('/api/knowledge'),
  searchKnowledge: (query: string) => post<any>('/api/knowledge/search', { query }),

  // outbound
  listCampaigns: () => get<any[]>('/api/campaigns'),
  createCampaign: () => post<any>('/api/campaigns'),
  runCampaign: (id: string) => post<any>(`/api/campaigns/${id}/run`),

  // callbacks
  listCallbacks: () => get<any[]>('/api/callbacks'),
  completeCallback: (id: string, agentId: string) =>
    post<any>(`/api/callbacks/${id}/complete`, { agentId }),

  // supervisor
  supervisor: () => get<any>('/api/supervisor/dashboard'),

  // protected application data (requires a call context — verification is per-contact)
  applications: (callId: string) => get<any>(`/api/applications?callId=${callId}`),
  applicationStatus: (applicationId: string, callId: string) =>
    get<any>(`/api/applications/${applicationId}/status?callId=${callId}`),
};

/** Subscribe to the realtime event stream. Returns an unsubscribe function. */
export function subscribeRealtime(onMessage: (msg: any) => void): () => void {
  const source = new EventSource('/api/realtime');
  source.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => source.close();
}
