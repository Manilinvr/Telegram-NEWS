# Развёртывание базы данных в Supabase

## Почему миграции падали с «relation … does not exist»

Файлы в `packages/backend/src/db/migrations/` рассчитаны на собственный
раннер и содержат **две** секции:

```sql
-- +migrate Up
CREATE TABLE categories (...);
CREATE TABLE sources (...);
CREATE TABLE source_posts (...);
CREATE TABLE media (...);

-- +migrate Down
DROP TABLE IF EXISTS media;
DROP TABLE IF EXISTS source_posts;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS categories;
```

`-- +migrate Down` — это обычный комментарий SQL. Раннер по нему делит
файл, а SQL-редактор Supabase выполняет **всё подряд**: создаёт четыре
таблицы и тут же их удаляет.

Проверено на чистой базе: после вставки одного такого файла остаётся
**ноль** таблиц. Отсюда и все три ошибки:

| Ошибка | Причина |
|---|---|
| `function set_updated_at() does not exist` | Файл 001 не применён или его Down-секция удалила функцию |
| `relation "source_posts" does not exist` | Файл 003 удалил собственные таблицы |
| `relation "events" does not exist` | То же для файла 004 |

Предупреждение Supabase «This query includes destructive operations» было
про эти самые `DROP TABLE`.

**Вставлять эти файлы в SQL-редактор нельзя.** Для Supabase собирается
отдельный каталог.

---

## Каталог `supabase/migrations`

Собирается из тех же исходных миграций с отрезанной секцией Down:

```bash
npm run build:supabase
```

Источник правды один, поэтому две копии схемы не разойдутся. Файлы в
`supabase/migrations/` **не редактируются вручную** — правки вносятся в
`packages/backend/src/db/migrations/`, после чего каталог пересобирается.

Скрипт отказывается собирать файл, если в секции Up остались удаляющие
операции, — ровно та ошибка, ради которой он и написан.

---

## Способ 1. Один файл `supabase/setup.sql` (рекомендуется)

Самый короткий путь: **SQL Editor → New query → вставить файл целиком →
Run**. Один раз, без выбора порядка файлов.

Файл собирается командой `npm run build:supabase` и содержит, в порядке
выполнения:

1. защиту от повторного запуска — понятную ошибку вместо невнятного
   «relation already exists» на середине;
2. журнал миграций `schema_migrations`;
3. все восемь миграций подряд;
4. записи о том, что эти восемь миграций применены.

Пункт 4 существенный: без него приложение при старте считает базу пустой
и пытается создать уже существующие таблицы, падая с
`relation "users" already exists`. Контрольные суммы считаются тем же
способом, что и в раннере миграций, поэтому база, установленная этим
файлом, неотличима от поднятой командой `npm run migrate`, и
`MIGRATE_ON_STARTUP` менять не нужно.

На вопрос Supabase про Row Level Security отвечайте **Run without RLS** —
RLS включает сама установка, в конце и без политик (см. ниже).

---

## Способ 2. Интеграция Supabase с GitHub

Вы уже подключили Supabase к GitHub, поэтому достаточно отправить файлы:

1. `npm run build:supabase`
2. Закоммитить каталог `supabase/migrations/`
3. Отправить в ветку, указанную в настройках интеграции

Supabase применит миграции сам и запишет их в
`supabase_migrations.schema_migrations`. Порядок задан именами файлов
(`20260101000001_extensions.sql`, `…0002_auth.sql`, …).

**Важно для приложения.** Схемой теперь управляет Supabase, поэтому
собственный раннер при старте отключается — иначе он попытается создать
уже существующие таблицы и API не запустится:

```
MIGRATE_ON_STARTUP=false
```

Если позже захотите вернуть управление раннеру, отметьте применённые
миграции без повторного выполнения:

```bash
npm run migrate:baseline -w @nnm/backend
```

Команда ничего не выполняет, только синхронизирует учёт, и отказывается
работать на пустой базе.

## Способ 3. Supabase CLI

```bash
supabase link --project-ref <ref>
npm run build:supabase
supabase db push
```

## Способ 4. Напрямую раннером проекта

Подходит, если не пользоваться механизмом миграций Supabase:

```bash
DATABASE_URL="postgresql://postgres.<ref>:<пароль>@aws-0-<регион>.pooler.supabase.com:5432/postgres" \
DATABASE_SSL=true \
npm run migrate
```

Каталог `supabase/migrations` в этом случае не нужен.

## Способ 5. Пофайлово через SQL-редактор

Если всё же удобнее вставлять руками, берите файлы **только из
`supabase/migrations/`** и строго по возрастанию имени, по одному. В них
нет `DROP TABLE`, и предупреждения о разрушающих операциях не будет.

---

## Строка подключения

Возьмите её в Supabase: **Project Settings → Database → Connection string**.

Используйте **Session pooler** (порт 5432) или прямое подключение.
**Transaction pooler** (порт 6543) для этой системы не подходит: очередь
задач удерживает транзакции, а сам пулер отклоняет параметры
`statement_timeout` и `idle_in_transaction_session_timeout`, которые
приложение задаёт при подключении.

Если использовать transaction pooler всё же необходимо:

```
DATABASE_STATEMENT_TIMEOUT_MS=0
```

Обязательно включите SSL:

```
DATABASE_URL=postgresql://postgres.<ref>:<пароль>@aws-0-<регион>.pooler.supabase.com:5432/postgres
DATABASE_SSL=true
```

---

## Row Level Security

Supabase публикует REST API (PostgREST) над всеми таблицами схемы
`public` и выдаёт браузеру анонимный ключ. **Без явного запрета вся
приватная база — публикации, черновики, журнал аудита — читается любым,
кто взял этот ключ из исходного кода страницы.**

Миграция `008_hardening` закрывает доступ:

- включает RLS на всех таблицах;
- **не создаёт ни одной политики** — при включённом RLS это означает
  «запрещено всем», кроме владельца таблицы;
- отзывает права у ролей `anon` и `authenticated`, включая права на
  будущие таблицы.

Приложение подключается владельцем таблиц, а владелец RLS обходит, —
поэтому backend работает как обычно.

Проверено: роль, которой явно выдали `GRANT SELECT`, всё равно получает
**0 строк**, а backend читает и пишет нормально.

На обычном PostgreSQL ролей `anon` и `authenticated` нет — миграция это
проверяет и применяется одинаково локально и в Supabase.

Диалог Supabase «creates tables without enabling Row Level Security»
относился к старым файлам. С `supabase/migrations/` выбирайте
**Run without RLS**: RLS включает сама миграция `008_hardening`, а
автоматическое включение средствами Supabase создало бы политики,
открывающие доступ.

---

## После применения миграций

```bash
# Справочники и настройки по умолчанию
DATABASE_URL="…" DATABASE_SSL=true npm run seed

# Учётная запись владельца — пароль покажется ОДИН раз
DATABASE_URL="…" DATABASE_SSL=true npm run bootstrap:admin
```

## Проверка

```sql
-- Должно быть 21: 20 таблиц схемы + журнал миграций
select count(*) from pg_tables where schemaname = 'public';

-- RLS должен быть включён на всех
select count(*) filter (where rowsecurity) || ' из ' || count(*)
from pg_tables where schemaname = 'public';

-- Политик быть не должно: это и есть запрет для anon
select count(*) from pg_policies where schemaname = 'public';
```

## Что Supabase в этом проекте НЕ используется

Только как управляемый PostgreSQL. Supabase Auth, Storage и
клиентские SDK не задействованы: аутентификация своя (сессии в httpOnly-
cookie), медиа лежат в локальном хранилище или S3. Поэтому анонимный и
публичный ключи Supabase приложению не нужны — достаточно строки
подключения к базе.
