# Самопроверка Фазы1

Дата 2026-10-21. Выполнены статическое чтение руководства, просмотр перечисленных официальных источников, генерация и структурная проверка документов. Не запускались installer/apt/Docker/OAuth/AI calls/VPS/production migrations. Ни один шаблон не объявлен испытанным deployment.

## Clean VPS tabletop

| Проверяемая граница | Найденный пробел | Исправление в дизайне |
|---|---|---|
| Получение private installer без GitHub CLI/Node | Циклический bootstrap | Owner PC download/review/scp; P15 release содержит dist/deps; P01 Bash до Node |
| Root-only VPS | Нельзя весь CLI под root | Ручное создание factory, второй login/sudo; bootstrap root refusal |
| Node+nvm vs systemd | PATH интерактивного shell отсутствует | Exact private Node и absolute unit; F06/P10 |
| Приватный app repo ещё пуст | Устанавливать нечего | M0 external blocker; S05/P06 не пишут runner |
| Docker после usermod | Старая сессия не имеет group | awaiting_manual/relogin/resume S04 |
| OAuth до безопасного доступа | Секрет на ещё открытом host | S03/S04 до S08; отдельный risk gate |
| Offline tests vs quota | Установка зависела бы от модели | S07 runner_ready_offline; live только S08 explicit |
| S11 до M1 | Нельзя создать dummy DB | Level1 backup отдельно; service .backup только при M1 |
| Qwen without tool loop | API health не runtime readiness | S12 infra отдельно M3 capability; cloud-only default |
| Platform placeholder | Ложный pass | F10 fail nonzero + P13 require actual adapter |

Вывод сценария: маршрут до первого live toy существует **при M0 и owner OAuth**, иначе есть честный blocker, а не обещание несуществующего продукта.

## Failure halfway tabletop

| Точка reboot/crash | Что делает status/resume | Почему повтор безопасен |
|---|---|---|
| В bootstrap download | Проверяет staging/hash; launcher не активен | Удаление только своего partial artifact |
| В apt mutation | dpkg audit, manual repair gate | Не удаляет lock/не повторяет apt blindly |
| Во время SSH cutover | Persisted rollback timer/boot recovery, console | Новый доступ не считается verified без ack |
| После Docker create до receipt | Search installation+operation labels; inspect | Не запускает duplicate container |
| После config rename до checkpoint | Hash actual config vs desired/prior receipt | Adopt verified или drift, не overwrite |
| Во время OAuth/live | auth presence/run identity, unknown usage | Никакого автоматического повторного model call |
| DB migration до commit | App transaction rolls back; version stays previous | Версия и DDL в одной транзакции |
| DB migration после commit | Schema+user_version consistent, post-check | Не повторяет ALTER; paused if health fails |
| После current switch | Compare actual symlink/manifest/DB compatibility | Не включает старый бинарь с новой DB без проверки |
| Два resume одновременно | Atomic installation lock/process identity | Один mutator; emergency cancel отдельный channel |

Resume never unpauses factory; старые runs lost/unknown_held обрабатывает приложение. Не обещается exactly-once внешняя сеть или rollback apt. Partial recovery выдаёт exit8 и next action.

## Проверки структуры

Проект содержит15 stage contracts, 78 inventory rows и16 prompts. Каждый prompt имеет все16 обязательных разделов, свои файлы/ошибки/criteria, зависимости и ссылку CONTRACT1.0.0. Все paths/prompt names проверены автоматической проверкой генератора; Markdown links на локальные файлы разрешаются. Архив содержит только документы, production-скриптов установки нет.

## Границы и риски

Самопроверка проекта не является test proof будущего кода. Главные оставшиеся риски: несовместимость конкретных pinned binaries/CLI, фактический OAuth, host firewall/IPv6, unsafe app capability assertions, root-equivalent Docker group, writable credential/output surfaces Level1. P15 обязателен перед production-qualified release; исходные runtime PR8/9 обязательны перед unattended.
