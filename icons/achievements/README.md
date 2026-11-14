# Значки достижений 2.x

Черновик на одобрение владельца. Логика достижений пока не подключена: `achievements.js` и `badges.js` не менялись.

Превью: `docs/previews/achievements-icons.html` (открывается двойным кликом). Снимки: `docs/previews/achievements-icons-dark.png` и `-light.png`.

## Откуда берутся файлы

Все файлы собирает один скрипт, руками их не правят:

```
node tools/achievements-icons.mjs              # SVG, CSS, превью и проверка контраста (при контрасте < 3:1 падает)
node tools/test/achievements-icons-shots.mjs   # снимки превью в тёмной и светлой теме (Playwright)
```

Список достижений скрипт читает из `achievements.js`. Глифы, токены тем и предложенные значки описаны в самом скрипте.

## Один файл на code

На каждый `code` приходится один файл, а не один на семейство с вариантом тира. Причина в том, что у ступеней одной лесенки иногда совпадают и глиф, и тир (`streak_3` и `streak_5` — оба бронзовые, с одним и тем же пламенем). Различает их только номер на ярлыке, а номер зашит в файл. С отдельными файлами `<img src="…/streak_5.svg">` работает без дополнительной разметки, а один генератор держит все варианты одинаковыми.

- `<code>.svg` — CSS-переменные с запасными значениями тёмной темы.
- `light/<code>.svg` — тот же значок с запасными значениями светлой темы, для `<img>` на светлом фоне.

## Сетка и правила

- viewBox `0 0 64 64`.
- Стеклянный медальон: круг r30, полупрозрачная заливка `--ach-glass`, рамка 1 px `--ach-rim`, блик-дуга слева сверху `--ach-shine`.
- Кант тира: r27, штрих 2. Второй кант — r24.4, штрих 1.
- Глиф: нарисован на сетке 24, вставлен с масштабом 1.4, безопасная зона 15–49. Штрих `--ach-sw` равен 2 (2.8 в сетке 64), концы и стыки скруглены. Главная форма глифа залита мягким цветом `--ach-glyph-soft`.
- Ярлык с номером (у лесенок серии и домашки, у значков за место в рейтинге): плашка y 49.5–60.5 цвета тира, цифры `--ach-plate-ink`.
- Тир можно узнать без цвета:

| тир | признак |
|---|---|
| bronze | один кант |
| silver | двойной кант |
| gold | двойной кант и 8 заклёпок |
| platinum | как у золота, плюс камень сверху |
| accent | лаймовый кант с искрой справа сверху |
| anti-1…7 | рваный (пунктирный) кант, глиф кораллового цвета |

## Подключение в приложении

1. Подключить `icons/achievements/achievements-icons.css`. В нём все токены `--ach-*` для тёмной и светлой темы и состояния значка.
2. Вставлять SVG инлайн, тогда он берёт цвета из токенов:

```html
<span class="ach-icon" style="--ach-size:56px">…содержимое <code>.svg…</span>
```

   Точнее, класс ставится на сам `<svg class="ach-icon">`. Если один значок повторяется много раз, его выносят в `<symbol>` и подключают через `<use href="#a-code">`, как сделано в превью: переменные наследуются внутрь `use`. В SVG нет `id` и градиентов, поэтому копии значка не конфликтуют.
3. Модификаторы:
   - `.ach-sm` — для 24–32 px. Штрих становится толще, ярлык с номером скрывается, поэтому номер нужно вывести в подписи.
   - `.is-locked` — «закрыто». Тот же значок становится серым силуэтом.
   - `--ach-size` — размер значка.
4. В `<img>` переменные страницы не действуют. Для светлой темы бери файл из `light/`, для состояния «закрыто» — `img.ach-icon.is-locked`: оно включает фильтр grayscale.

Тема задаётся атрибутом `data-theme="light"|"dark"` на `<html>`. Если атрибута нет или он равен `system`, тема берётся из `prefers-color-scheme`. Внутри Telegram «системную» тему определяет `colorScheme`, а не медиазапрос. Если там это важно, ставь на `<html>` уже вычисленную тему.

В тёмной теме глиф следует акценту (`var(--j-lime)` и `--j-lime-rgb`). В светлой теме глиф — затемнённый лайм `#4A6B00`: при смене акцента он сам не пересчитается.

## Контраст

Скрипт считает контраст на фоне страницы и на карточке. Глиф к стеклу, кант к стеклу — не меньше 3:1. Номер на ярлыке — не меньше 4.5:1.

Худшие значения:
- тёмная тема: анти-глиф на анти-заливке — 4.67:1;
- светлая тема: анти-глиф на анти-заливке — 3.77:1, канты 4.0–4.5:1, номер на золотом и платиновом ярлыке — 4.77:1.

Закрытые значки намеренно бледные: 2.2–3.5:1.

## code → файл

| code | название | тир | файл |
|---|---|---|---|
| clean_sheet | Чистый лист | accent | clean_sheet.svg |
| streak_3 | Разминка | bronze | streak_3.svg |
| streak_5 | Пятидневка | bronze | streak_5.svg |
| streak_10 | На волне | silver | streak_10.svg |
| streak_15 | Железная воля | silver | streak_15.svg |
| streak_20 | Несгибаемый | gold | streak_20.svg |
| streak_30 | Легенда посещаемости | platinum | streak_30.svg |
| clean_term | Чистый семестр | accent | clean_term.svg |
| recovered | Исправился | accent | recovered.svg |
| cert_1 | Справка вовремя | bronze | cert_1.svg |
| cert_3 | Справка вовремя · 3 | silver | cert_3.svg |
| cert_5 | Справка вовремя · 5 | gold | cert_5.svg |
| welcome | Добро пожаловать | accent | welcome.svg |
| first_steps | Первые шаги | accent | first_steps.svg |
| tech | Дотошный технарь | accent | tech.svg |
| notify_on | Всегда в курсе | accent | notify_on.svg |
| collector | Коллекционер | accent | collector.svg |
| hw_1 | Первая ласточка | bronze | hw_1.svg |
| hw_3 | Втянулся | bronze | hw_3.svg |
| hw_10 | Прилежный | silver | hw_10.svg |
| hw_25 | Книжный червь | gold | hw_25.svg |
| hw_50 | Машина знаний | platinum | hw_50.svg |
| anti_m2 | Мимо пары | anti-1 | anti_m2.svg |
| anti_m4 | Коридорный житель | anti-2 | anti_m4.svg |
| anti_m6 | Завсегдатай буфета | anti-3 | anti_m6.svg |
| anti_m8 | Слышал о расписании | anti-4 | anti_m8.svg |
| anti_m10 | Дальний родственник группы | anti-5 | anti_m10.svg |
| anti_m12 | Красная зона | anti-6 | anti_m12.svg |
| anti_m14 | Вызов в деканат | anti-7 | anti_m14.svg |
| game_sudoku_fast | Быстрый ум | bronze | game_sudoku_fast.svg |
| game_sudoku_speed | Скоростной решатель | silver | game_sudoku_speed.svg |
| game_sudoku_master | Гроссмейстер клеток | gold | game_sudoku_master.svg |
| game_mines_steady | Твёрдая рука | bronze | game_mines_steady.svg |
| game_mines_pro | Сапёр-профи | silver | game_mines_pro.svg |
| game_mines_perfect | Без права на ошибку | gold | game_mines_perfect.svg |
| game_flappy_25 | Набрал высоту | bronze | game_flappy_25.svg |
| game_flappy_75 | Покоритель небес | gold | game_flappy_75.svg |
| game_snake_bite | Первый перекус | bronze | game_snake_bite.svg |
| game_snake_30 | Удав | silver | game_snake_30.svg |
| game_snake_60 | Анаконда | gold | game_snake_60.svg |
| game_snake_top5 | Заклинатель змей | gold | game_snake_top5.svg |
| game_assoc_first | Догадливый | bronze | game_assoc_first.svg |
| game_assoc_flash | С полуслова | gold | game_assoc_flash.svg |
| game_assoc_week | Неделя догадок | gold | game_assoc_week.svg |
| game_assoc_top5 | Ассоциатор | gold | game_assoc_top5.svg |
| game_player | Игрок | bronze | game_player.svg |
| game_all_five | Мастер на все руки | silver | game_all_five.svg |
| game_three_top5 | Трижды в пятёрке | gold | game_three_top5.svg |
| game_five_top5 | Пятёрка в пятёрке | gold | game_five_top5.svg |
| **предложено** | | | |
| hidden | Секретное достижение | accent | hidden.svg |
| session_clean | Сессия без хвостов | gold | session_clean.svg |
| hw_week | Неделя без долгов | silver | hw_week.svg |
| light_side | Светлая сторона | accent | light_side.svg |
| schedule_week | Сверился с расписанием | bronze | schedule_week.svg |
