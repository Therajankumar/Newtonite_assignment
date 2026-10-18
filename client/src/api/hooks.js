import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from './client.js';

const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};

export const keys = {
  me: ['me'],
  teams: ['teams'],
  members: (teamId) => ['members', teamId],
  items: (filters) => ['items', filters],
  item: (id) => ['item', id],
  activity: (id) => ['activity', id],
  dashboard: ['dashboard'],
  notifications: ['notifications'],
};

export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => api('/teams').then((r) => r.teams), staleTime: 5 * 60_000 });

export const useMembers = (teamId, enabled = true) =>
  useQuery({
    queryKey: keys.members(teamId),
    queryFn: () => api(`/teams/${teamId}/members`).then((r) => r.members),
    enabled: !!teamId && enabled,
    staleTime: 5 * 60_000,
  });

export const useItems = (filters) =>
  useInfiniteQuery({
    queryKey: keys.items(filters),
    queryFn: ({ pageParam }) => api(`/items${qs({ ...filters, cursor: pageParam, limit: 30 })}`),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });

export const useItem = (id) => useQuery({ queryKey: keys.item(id), queryFn: () => api(`/items/${id}`).then((r) => r.item) });

export const useActivity = (id) =>
  useInfiniteQuery({
    queryKey: keys.activity(id),
    queryFn: ({ pageParam }) => api(`/items/${id}/activity${qs({ before: pageParam })}`),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useDashboard = () => useQuery({ queryKey: keys.dashboard, queryFn: () => api('/dashboard'), refetchInterval: 60_000 });

export const useNotifications = () =>
  useQuery({ queryKey: keys.notifications, queryFn: () => api('/notifications'), refetchInterval: 30_000 });

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids) => api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/** After any successful write, store the server's version of the item and refresh derived views. */
function useApplyItem() {
  const qc = useQueryClient();
  return (item) => {
    qc.setQueryData(keys.item(item.id), item);
    qc.invalidateQueries({ queryKey: keys.activity(item.id) });
    qc.invalidateQueries({ queryKey: ['items'] });
    qc.invalidateQueries({ queryKey: keys.dashboard });
  };
}

export function useCreateItem() {
  const applyItem = useApplyItem();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }) => api('/items', { method: 'POST', body: input, idempotencyKey }).then((r) => r.item),
    onSuccess: applyItem,
  });
}

/**
 * All item actions (claim, release, assign, edit, transitions). Each call gets a fresh
 * idempotency key, reused by the automatic retries inside api().
 *
 * Claiming is optimistic: the UI shows you as the owner immediately. If the server says
 * someone else got there first, we roll back to the server's authoritative state (sent in
 * the 409) rather than our guess.
 */
export function useItemAction(id, me) {
  const qc = useQueryClient();
  const applyItem = useApplyItem();
  return useMutation({
    mutationFn: ({ kind, name, body }) => {
      const idempotencyKey = newIdempotencyKey();
      const path = {
        claim: `/items/${id}/claim`,
        release: `/items/${id}/release`,
        assign: `/items/${id}/assign`,
        transition: `/items/${id}/transitions/${name}`,
        edit: `/items/${id}`,
      }[kind];
      return api(path, { method: kind === 'edit' ? 'PATCH' : 'POST', body: body ?? {}, idempotencyKey }).then((r) => r.item);
    },
    onMutate: async ({ kind }) => {
      if (kind !== 'claim') return {};
      await qc.cancelQueries({ queryKey: keys.item(id) });
      const previous = qc.getQueryData(keys.item(id));
      if (previous) {
        qc.setQueryData(keys.item(id), {
          ...previous,
          assignee: { id: me.id, name: me.name, email: me.email },
          status: 'in_progress',
          allowedActions: [],
          _optimistic: true,
        });
      }
      return { previous };
    },
    onError: (err, vars, ctx) => {
      const current = err.details?.current;
      if (current) qc.setQueryData(keys.item(id), current);
      else if (ctx?.previous) qc.setQueryData(keys.item(id), ctx.previous);
      qc.invalidateQueries({ queryKey: keys.activity(id) });
    },
    onSuccess: applyItem,
  });
}

export function useAddComment(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }) => api(`/items/${id}/comments`, { method: 'POST', body: { body }, idempotencyKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.activity(id) }),
  });
}
