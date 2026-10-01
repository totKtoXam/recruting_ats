# Матрица тем .NET-backend по уровням

✔ — ожидаем уверенно, ◐ — базовое понимание, — — не ожидаем.

| Тема | Junior | Middle | Senior |
|---|---|---|---|
| **C#**: типы значений и ссылок, boxing, `string` и `StringBuilder`, generics, делегаты и события, LINQ, отложенное выполнение, `record`, pattern matching, nullable reference types | ✔ основы | ✔ | ✔ + тонкости (defensive copies, `in`/`ref readonly`, variance) |
| **CLR и память**: стек и куча, GC (поколения, LOH, Server/Workstation), `IDisposable` и финализаторы, `Span<T>`/`Memory<T>`, `ArrayPool` | ◐ стек/куча, `using` | ✔ GC, `IDisposable` | ✔ + диагностика (dotnet-counters, dump, аллокации в горячем пути) |
| **Асинхронность**: `Task`, `async/await`, машина состояний, `ConfigureAwait`, `ValueTask`, `CancellationToken`, thread pool, deadlock при `.Result` | ◐ зачем async/await | ✔ | ✔ + thread pool starvation, `IAsyncEnumerable`, `Channel<T>` |
| **Многопоточность и коллекции**: `List`, `Dictionary` (хеш, `GetHashCode`/`Equals`), `HashSet`, сложность операций, `lock`, `SemaphoreSlim`, `Interlocked`, concurrent-коллекции | ◐ коллекции и сложность | ✔ | ✔ + гонки, lock-free, выбор примитива |
| **ASP.NET Core**: middleware pipeline и порядок, DI и lifetimes, конфигурация и Options, фильтры, model binding и валидация, аутентификация (JWT, cookie), авторизация и политики, `IHttpClientFactory`, логирование, health checks, minimal API | ◐ контроллеры, DI | ✔ | ✔ + hosting, rate limiting, observability, версионирование API |
| **EF Core и SQL**: `DbContext` и его время жизни, change tracking, `AsNoTracking`, загрузка связанных данных, N+1, `IQueryable` vs `IEnumerable`, миграции, транзакции, конкурентный доступ (row version), `ExecuteUpdate`/`ExecuteDelete`; индексы, JOIN, план выполнения, уровни изоляции | ◐ CRUD, JOIN | ✔ | ✔ + оптимизация, блокировки, секционирование, read replicas |
| **Архитектура**: SOLID, слоистая/Clean Architecture, DDD-основы, CQRS, паттерны (Repository, Unit of Work, Mediator, Strategy, Decorator), обработка ошибок | ◐ SOLID | ✔ | ✔ + границы сервисов, выбор архитектуры под задачу |
| **Распределённые системы**: REST vs gRPC, очереди (RabbitMQ, Kafka), доставка at-least-once и идемпотентность, Outbox, Saga, retries и circuit breaker (Polly), кэш (Redis), согласованность | — | ◐ | ✔ |
| **Тестирование**: unit (xUnit/NUnit), моки, интеграционные тесты (`WebApplicationFactory`, Testcontainers), пирамида тестов | ◐ unit | ✔ | ✔ + стратегия тестирования команды |
| **Инфраструктура**: Git, Docker, CI/CD, логи/метрики/трейсы (OpenTelemetry), конфигурация и секреты | ◐ Git | ✔ Docker, CI | ✔ + эксплуатация, инциденты |
| **Практика** | code review простого кода, небольшая задача | live coding средней сложности, code review | system design + разбор компромиссов |

## Ожидания по уровням

- **Junior** — пишет рабочий код по понятной задаче, знает основы C# и ООП, понимает HTTP и CRUD через EF Core, умеет читать чужой код и задавать вопросы. Растёт под наставничеством.
- **Middle** — самостоятельно ведёт фичу от задачи до продакшена, понимает, как работают async, DI, EF Core «под капотом», видит N+1 и утечки, пишет тесты, аргументирует решения на ревью.
- **Senior** — отвечает за часть системы: проектирует, выбирает технологии с учётом компромиссов, решает проблемы производительности и надёжности в продакшене, влияет на процессы и растит команду.
