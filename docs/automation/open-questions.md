# Неразрешённые вопросы и реальные blockers

Обычные design choices уже решены: Ubuntu24.04 amd64, Node24, единый CLI, JSON setup state, manual cutover, cloud-only supervised, no paid fallback. Их не нужно спрашивать заново. Ниже только решения/данные, которых нет в приложенном документе.

| ID | Вопрос / почему важен | Варианты | Рекомендация | Последствие / можно отложить |
|---|---|---|---|---|
| Q01 | Где reviewed factory/application release и какие capabilities реально готовы? Приватный repo и M0 не предоставлены | Уже есть repo/release; либо сначала application PR0/1 | Использовать существующий, если проходит M0 manifest+tests; иначе отдельно упаковать A1/A2/A3 и устранить F15 | Installer можно писать на fake artifacts; S05/live release qualification нельзя закончить без M0 |
| Q02 | Какие точные upstream pins успешно квалифицированы вместе? Guide не даёт Node binary checksum/Docker package set/Codex fixed version/base digest | Сохранить доступные guide pins; обновить patch внутри архитектурного major отдельным review | P15 проверить official artifacts и заморозить tested lock, Node24 major сохранить | Это release engineering blocker, не вопрос вкуса. До P15 production download запрещён; fixtures допустимы |
| Q03 | Доступен ли device login на аккаунте и принимает ли владелец model credential внутри supervised worker? | Принять только own/public fixture; либо сначала проверенный broker | Для исходного MVP supervised explicit gate; если риск неприемлем — ждать PR8/broker | Offline ready возможно без решения, live S08 blocked; API key не предлагается как скрытая замена |
| Q04 | Какой provider console/firewall и фактический SSH/network setup на VPS? | Поддерживаемый чистый Ubuntu+UFW+iptables; custom/hardened host | Новый dedicated VPS с рабочей console и проверяемым tailnet | До покупки можно отложить, перед S03 cutover нельзя. Не делать generic multi-provider provisioning |
| Q05 | Есть ли годные M1/M2 для unattended, M3 local runtime, M4 platform adapter? | Остановиться на supervised; либо application roadmap | Сначала полезный M0; advanced блокировать по capabilities до отдельных PR | Не блокирует минимальный путь; installer не разрабатывает недостающий продукт |

Пины Q02 не запрашиваются у пользователя как ручной подбор десятков версий: это задача release implementation P15. Владелец принимает конкретный проверенный diff. Модель/размер VPS для Ollama, аппаратные remote workers и новый AI provider выбираются только при запросе optional feature и измерениях; сейчас не нужны.

## Самооценка

Подтверждённые дефекты F01–F15 выводятся из текста/кода руководства (уверенность95–99%, с отдельной VM проверкой эксплуатационных последствий). Пригодность proposed orchestration/locks/gates оценивается90% до реализации. Остаточные слабые места: supply-chain trust у первого release, root-equivalent Docker control plane, доступный supervised model credential, реальные сетевые/firewall особенности и отсутствие фактических VPS испытаний. Проценты — субъективная оценка дизайна, не статистическая гарантия безопасности.
