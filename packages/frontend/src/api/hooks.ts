import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiDraft,
  AnalyticsBundle,
  AuditLogEntry,
  EventDetail,
  FeedFilterInput,
  FeedItem,
  MapMarker,
  ModerationQueueItem,
  ProcessingError,
  ProcessingJob,
  ProfanityReport,
  Publication,
  Source,
  SourcePostDetail,
  User,
} from '@nnm/shared';
import { api } from './client.js';

/**
 * Хуки доступа к данным.
 *
 * Ключи запросов построены так, чтобы точечно обновлять затронутые данные:
 * после действия модератора незачем перезагружать всю ленту и аналитику.
 */

export const queryKeys = {
  me: ['me'] as const,
  dashboard: (period: string) => ['dashboard', period] as const,
  feed: (filter: FeedFilterInput) => ['feed', filter] as const,
  event: (id: string) => ['event', id] as const,
  post: (id: string) => ['post', id] as const,
  sources: ['sources'] as const,
  source: (id: string) => ['source', id] as const,
  moderation: (status?: string[]) => ['moderation', status ?? 'all'] as const,
  categories: ['categories'] as const,
  settings: ['settings'] as const,
  diagnostics: ['diagnostics'] as const,
  errors: ['diagnostics', 'errors'] as const,
  jobs: ['diagnostics', 'jobs'] as const,
  audit: ['audit'] as const,
  map: (hours: number) => ['map', hours] as const,
  publications: ['publications'] as const,
  drafts: (eventId: string) => ['drafts', eventId] as const,
};

// --- Аутентификация ---------------------------------------------------------

export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<{ user: User }>('/auth/me').then((r) => r.user),
    // Сессия проверяется один раз при загрузке; 401 обрабатывается отдельно.
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: User; mustChangePassword: boolean }>('/auth/login', input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.me, data.user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      // После выхода в кэше не должно остаться ничего приватного.
      queryClient.clear();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post<{ ok: boolean; message: string }>('/auth/change-password', input),
  });
}

// --- Дашборд и лента ---------------------------------------------------------

export function useDashboard(period: '24h' | '7d' | '30d') {
  return useQuery({
    queryKey: queryKeys.dashboard(period),
    queryFn: () => api.get<AnalyticsBundle>('/analytics/dashboard', { period }),
    // Показатели обновляются и живыми событиями, и фоновым опросом —
    // на случай, если поток SSE прервался незаметно.
    refetchInterval: 60_000,
  });
}

export function useFeed(filter: FeedFilterInput) {
  return useQuery({
    queryKey: queryKeys.feed(filter),
    queryFn: () =>
      api.get<{ items: FeedItem[]; total: number; limit: number; offset: number }>(
        '/feed',
        filter as never,
      ),
    placeholderData: (previous) => previous,
  });
}

export function useEventDetail(eventId: string | null) {
  return useQuery({
    queryKey: queryKeys.event(eventId ?? ''),
    queryFn: () => api.get<EventDetail>(`/events/${eventId}`),
    enabled: Boolean(eventId),
  });
}

export function usePostDetail(postId: string | null) {
  return useQuery({
    queryKey: queryKeys.post(postId ?? ''),
    queryFn: () => api.get<SourcePostDetail>(`/posts/${postId}`),
    enabled: Boolean(postId),
  });
}

export function useMapMarkers(hours = 24) {
  return useQuery({
    queryKey: queryKeys.map(hours),
    queryFn: () => api.get<{ markers: MapMarker[] }>('/analytics/map', { hours }).then((r) => r.markers),
  });
}

// --- Источники ----------------------------------------------------------------

export function useSources() {
  return useQuery({
    queryKey: queryKeys.sources,
    queryFn: () =>
      api.get<{ sources: Source[]; adapters: Array<{ type: string; mode: string; configured: boolean; reason: string | null }> }>(
        '/sources',
      ),
  });
}

export function useCreateSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<Source>('/sources', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sources }),
  });
}

export function useUpdateSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Record<string, unknown>) =>
      api.patch<Source>(`/sources/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sources }),
  });
}

export function useDeleteSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/sources/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sources }),
  });
}

export function useSyncSource() {
  return useMutation({
    mutationFn: (id: string) => api.post<{ queued: boolean; message: string }>(`/sources/${id}/sync`),
  });
}

// --- Модерация и публикация ----------------------------------------------------

export function useModerationQueue(status?: string[]) {
  return useQuery({
    queryKey: queryKeys.moderation(status),
    queryFn: () =>
      api.get<{ items: ModerationQueueItem[]; counts: { pending: number; blocked: number } }>(
        '/moderation',
        status ? { status } : undefined,
      ),
  });
}

export function useSaveDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, ...body }: { eventId: string } & Record<string, unknown>) =>
      api.patch<{ draft: AiDraft; allowed: boolean; profanityReport: ProfanityReport }>(
        `/events/${eventId}/draft`,
        body,
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(variables.eventId) });
      void queryClient.invalidateQueries({ queryKey: ['moderation'] });
    },
  });
}

export function useRegenerateDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      api.post<{ draft: AiDraft }>(`/events/${eventId}/draft/regenerate`),
    onSuccess: (_data, eventId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
    },
  });
}

export function usePreview() {
  return useMutation({
    mutationFn: ({ eventId, ...body }: { eventId: string } & Record<string, unknown>) =>
      api.post<{ telegramText: string; profanityReport: ProfanityReport; allowed: boolean }>(
        `/events/${eventId}/preview`,
        body,
      ),
  });
}

export function useApprove() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) => api.post<ModerationQueueItem>(`/moderation/${eventId}/approve`),
    onSuccess: (_data, eventId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      void queryClient.invalidateQueries({ queryKey: ['moderation'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useReject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, reason }: { eventId: string; reason: string }) =>
      api.post<ModerationQueueItem>(`/moderation/${eventId}/reject`, { reason }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(variables.eventId) });
      void queryClient.invalidateQueries({ queryKey: ['moderation'] });
    },
  });
}

export function usePublish() {
  const queryClient = useQueryClient();
  return useMutation({
    // Подтверждение передаётся явным флагом: сервер не принимает
    // публикацию без него (ТЗ §13).
    mutationFn: (eventId: string) =>
      api.post<Publication>(`/moderation/${eventId}/publish`, { confirmed: true }),
    onSuccess: (_data, eventId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      void queryClient.invalidateQueries({ queryKey: ['moderation'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// --- Настройки и диагностика -----------------------------------------------------

export function useCategories() {
  return useQuery({
    queryKey: queryKeys.categories,
    queryFn: () =>
      api.get<{ categories: Array<{ slug: string; title: string; color: string; emoji: string }> }>(
        '/categories',
      ).then((r) => r.categories),
    staleTime: 10 * 60_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.get<{ settings: Record<string, unknown>; runtime: Record<string, unknown> }>('/settings'),
  });
}

export function useUpdateSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value, confirmPassword }: { key: string; value: unknown; confirmPassword?: string }) =>
      api.put<{ ok: boolean }>(`/settings/${key}`, { value, confirmPassword }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

export function useProfanityTest() {
  return useMutation({
    mutationFn: (text: string) => api.post<ProfanityReport>('/settings/profanity/test', { text }),
  });
}

export function useDiagnostics() {
  return useQuery({
    queryKey: queryKeys.diagnostics,
    queryFn: () => api.get<Record<string, never>>('/diagnostics'),
    refetchInterval: 30_000,
  });
}

export function useProcessingErrors() {
  return useQuery({
    queryKey: queryKeys.errors,
    queryFn: () => api.get<{ errors: ProcessingError[] }>('/diagnostics/errors').then((r) => r.errors),
  });
}

export function useJobs() {
  return useQuery({
    queryKey: queryKeys.jobs,
    queryFn: () =>
      api.get<{ jobs: ProcessingJob[]; counts: Record<string, number> }>('/diagnostics/jobs'),
    refetchInterval: 15_000,
  });
}

export function useAuditLog() {
  return useQuery({
    queryKey: queryKeys.audit,
    queryFn: () => api.get<{ entries: AuditLogEntry[] }>('/audit').then((r) => r.entries),
  });
}

export function useDraftHistory(eventId: string | null) {
  return useQuery({
    queryKey: queryKeys.drafts(eventId ?? ''),
    queryFn: () => api.get<{ drafts: AiDraft[] }>(`/events/${eventId}/drafts`).then((r) => r.drafts),
    enabled: Boolean(eventId),
  });
}
