# HTTP API

Базовый путь: `/api`. Формат — JSON. Все ответы и сообщения об ошибках на
русском языке.

## Аутентификация

Сессия передаётся cookie `nnm_session` (`httpOnly`). Для изменяющих методов
обязателен заголовок `x-csrf-token` со значением из cookie `nnm_csrf`.

Ошибка имеет вид:

```json
{ "error": "КОД_ОШИБКИ", "message": "Понятное описание" }
```

| Код | Значение |
|---|---|
| `UNAUTHORIZED` | Нужен вход (401) |
| `FORBIDDEN` | Недостаточно прав (403) |
| `CSRF_FAILED` | Не пройдена проверка CSRF (403) |
| `VALIDATION_ERROR` | Некорректные данные (400) |
| `NOT_FOUND` | Объект не найден (404) |
| `PROFANITY_BLOCKED` | Заблокировано проверкой лексики (409) |
| `RATE_LIMITED` | Превышен лимит запросов (429) |
| `ACCOUNT_LOCKED` | Учётная запись заблокирована (423) |

---

## Аутентификация

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/auth/login` | Вход. Тело: `{ email, password }` |
| `POST` | `/auth/logout` | Выход |
| `GET` | `/auth/me` | Текущий пользователь |
| `POST` | `/auth/change-password` | `{ currentPassword, newPassword }` |

## Лента и события

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/feed` | Лента с фильтрами |
| `GET` | `/events/:id` | Полная карточка события |
| `GET` | `/posts/:id` | Публикация источника |
| `POST` | `/events/:id/merge` | Объединить с другим событием: `{ targetEventId }` |

### Параметры `/feed`

| Параметр | Значения | Описание |
|---|---|---|
| `period` | `1h` `24h` `7d` `30d` `all` | Пресет периода |
| `from`, `to` | ISO-8601 | Точный период (приоритетнее пресета) |
| `kind` | `all` `events` `posts` | Что показывать |
| `categories` | slug через запятую | Категории |
| `importance` | `LOW,MEDIUM,HIGH,CRITICAL` | Приоритет |
| `sources` | UUID через запятую | Источники |
| `sourceTypes` | `TELEGRAM,VK` | Платформы |
| `status` | статусы обработки | Статус |
| `moderationStatus` | статусы модерации | Статус модерации |
| `confirmationStatus` | `UNCONFIRMED,PARTIALLY_CONFIRMED,CONFIRMED` | Подтверждённость |
| `confidenceMin`, `confidenceMax` | 0..1 | Диапазон уверенности |
| `hasPhoto`, `hasVideo`, `hasTranscript`, `hasDraft`, `isPublished` | `true` `false` | Наличие признака |
| `q` | строка | Полнотекстовый поиск |
| `searchFields` | `title,rawText,facts,transcript,source` | Где искать |
| `sort` | `newest` `oldest` `importance` `confidence` `sources` | Сортировка |
| `limit`, `offset` | число | Постраничность |

Поиск охватывает заголовок события, исходные тексты публикаций,
извлечённые факты, транскрипции и названия источников.

## Черновики и модерация

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/moderation` | Очередь |
| `POST` | `/moderation/:id/claim` | Взять в работу |
| `PATCH` | `/events/:id/draft` | Сохранить правку (создаёт новую версию) |
| `POST` | `/events/:id/draft/regenerate` | Пересоздать черновик |
| `GET` | `/events/:id/drafts` | История версий |
| `POST` | `/events/:id/preview` | Предпросмотр Telegram-поста |
| `POST` | `/moderation/:id/approve` | Одобрить |
| `POST` | `/moderation/:id/reject` | Отклонить: `{ reason }` |
| `POST` | `/moderation/:id/publish` | Опубликовать: `{ confirmed: true }` |
| `GET` | `/publishing/status` | Состояние публикатора |

`PATCH /events/:id/draft` возвращает `409` с отчётом проверки, если в
тексте найдена запрещённая лексика. Правка при этом **сохраняется** —
модератор видит причину и продолжает править.

`POST /moderation/:id/publish` требует `confirmed: true`. Без явного
подтверждения запрос отклоняется.

## Источники

| Метод | Путь | Права |
|---|---|---|
| `GET` | `/sources` | любой |
| `GET` | `/sources/:id` | любой |
| `POST` | `/sources` | OWNER, ADMIN |
| `PATCH` | `/sources/:id` | OWNER, ADMIN |
| `DELETE` | `/sources/:id` | OWNER |
| `POST` | `/sources/:id/sync` | OWNER, ADMIN |

При создании источник проверяется на доступность; недоступный не
сохраняется.

## Аналитика

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/analytics/dashboard` | Всё для главного экрана одним запросом |
| `GET` | `/analytics/summary` | Сводные показатели |
| `GET` | `/analytics/timeseries` | Ряд по времени: `period` |
| `GET` | `/analytics/categories` | Распределение по категориям |
| `GET` | `/analytics/sources` | Активность источников |
| `GET` | `/analytics/map` | Точки для карты |

## Настройки и диагностика

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/categories` | Категории |
| `PUT` | `/categories/:slug` | Создать или изменить |
| `DELETE` | `/categories/:slug` | Удалить (кроме системных) |
| `GET` | `/settings` | Настройки и фактическая конфигурация |
| `PUT` | `/settings/:key` | Изменить. Критичные требуют `confirmPassword` |
| `POST` | `/settings/profanity/test` | Проверить текст фильтром |
| `GET` | `/diagnostics` | Состояние подсистем |
| `GET` | `/diagnostics/errors` | Ошибки обработки |
| `POST` | `/diagnostics/errors/:id/resolve` | Пометить ошибку разобранной |
| `POST` | `/diagnostics/errors/resolve-all` | Пометить разобранными все или повторы одной: `{ stage?, message? }` |
| `POST` | `/diagnostics/ai-check` | Живая проверка связи с моделью: один короткий запрос |
| `GET` | `/diagnostics/jobs` | Очередь задач |
| `GET` | `/audit` | Журнал действий |
| `GET` | `/health` | Проверка живости (без авторизации) |

Настройки фильтра лексики принимают только
`{ blockOnWarn, extraBlockWords, extraAllowWords }`. Поля, отключающего
проверку мата, не существует — произвольная структура отклоняется схемой.

## Живые обновления

```
GET /api/live
```

Server-Sent Events. Типы: `post.created`, `event.created`, `event.updated`,
`draft.created`, `moderation.updated`, `publication.created`,
`source.health`, `job.failed`, `stats.updated`.

Формат кадра:

```
event: event.created
data: {"type":"event.created","payload":{...},"at":"2026-04-14T14:32:00.000Z"}
```

## Медиа

```
GET /api/media/<ключ>?exp=<срок>&sig=<подпись>
```

Действует при `STORAGE_DRIVER=local`. Ссылки выдаёт backend; без
действующей подписи доступ закрыт. При `STORAGE_DRIVER=s3` фронтенд
получает presigned URL и обращается к хранилищу напрямую.
