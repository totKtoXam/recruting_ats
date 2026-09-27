// Словарь имён и признаки фамилий/отчеств для разбора ФИО из резюме в свободной форме.
// В шаблонах hh.ru и enbek.kz порядок «Фамилия Имя Отчество» задан, а в резюме,
// собранных вручную, «Рахат Бектас» и «Тлеулес Абзал» без словаря не различить.

const KAZAKH_MALE = `Абай Абзал Абылай Адиль Адлет Азамат Азат Айбек Айдар Айдос Айдын Акылбек Алан Али Алибек Алихан
Алишер Алмас Алтынбек Амир Амирбек Ануар Арлан Арман Арнур Арсен Арслан Асет Аскар Асхат Асылбек Аян Бакытжан Бакыт Батыр
Бауыржан Бахтияр Бекболат Бекзат Бекжан Бексултан Берик Болат Галым Гани Даниал Данияр Дарын Дастан Даулет Даурен Дидар
Димаш Диас Досжан Дулат Елдар Елжан Ербол Ерасыл Ержан Ерлан Ермек Ернар Ернур Ерсултан Ерхан Есен Жанат Жанбол Жандос
Жанибек Жасулан Жомарт Ислам Кайрат Кайсар Канат Касым Куат Мади Мадияр Максат Мансур Марат Медет Мейрам Мирас Мурат
Мухтар Нариман Нурбек Нурдаулет Нуржан Нурислам Нуркен Нурлан Нурлыбек Нурсултан Нуртас Олжас Омар Ораз Рамазан Расул Рахат
Ринат Руслан Рустем Сабыр Сагын Самат Санжар Саян Серик Серикбол Султан Талгат Тамерлан Темирлан Тимур Тлеулес Улан Умит
Фараби Шынгыс Ыдырыс Ильяс Ілияс Бекзод Асан Усен Зулпыхар Есполат Аян Ален Даниял Ерден Жангир Айсултан Нурбол Сункар`;

const KAZAKH_FEMALE = `Айгерим Айгуль Айдана Айжан Айнур Айсулу Айым Айша Айлин Акбота Акмарал Алия Алма Алуа Аружан Асель
Асем Аяулым Балжан Ботагоз Гаухар Гульжан Гульнара Гульназ Гульмира Дана Дария Дарига Диана Дильназ Дилнара Динара Жанар
Жанель Жания Жулдыз Зарина Зере Инкар Камила Карлыгаш Кымбат Лаура Лейла Луиза Мадина Малика Маржан Меруерт Молдир Назерке
Назгуль Назым Нургуль Нурсулу Перизат Раушан Сабина Салтанат Самал Сандугаш Сания Саяжан Симбат Тогжан Толкын Улболсын
Фариза Шолпан Эльмира Аида Ясмин Лилия Аружан Томирис Аяна Индира Асылым Гульдана Айзере Аружан Дамира Мерей`;

const RUSSIAN_MALE = `Александр Алексей Анатолий Андрей Антон Аркадий Арсений Артём Артем Артур Богдан Борис Вадим Валентин
Валерий Василий Виктор Виталий Владимир Владислав Всеволод Вячеслав Геннадий Георгий Глеб Григорий Даниил Данила Денис Дмитрий
Евгений Егор Иван Игорь Илья Кирилл Константин Лев Леонид Максим Марк Матвей Михаил Никита Николай Олег Павел Пётр Петр Роман
Семён Семен Сергей Станислав Степан Тимофей Фёдор Федор Филипп Эдуард Юрий Ярослав Рамиль Рустам Ильдар Айрат Радик Эмиль
Ренат Динар Марсель Наиль Тагир Булат Эльдар Роберт Альберт Ринат`;

const RUSSIAN_FEMALE = `Александра Алина Алла Анастасия Ангелина Анна Валентина Валерия Вера Вероника Виктория Галина Дарья
Евгения Екатерина Елена Елизавета Жанна Зоя Инна Ирина Карина Кира Кристина Ксения Лариса Лидия Любовь Людмила Маргарита
Марина Мария Милана Надежда Наталья Наталия Нина Оксана Олеся Ольга Полина Регина Светлана София Софья Таисия Тамара Татьяна
Ульяна Юлия Яна Эльвира Алёна Алена Арина Варвара Василиса Злата Ева Алсу Гузель Ляйсан Айгуль Зульфия`;

const ENGLISH = `John James Michael David Daniel Alex Alexander Andrew Anthony Mark Paul Peter Robert Thomas William Richard
Steven Kevin Brian Jason Ryan Eric Adam Nick Nicholas Chris Christopher Matthew Joseph Emma Olivia Sophia Anna Maria Elena Julia
Kate Katherine Sarah Laura Emily Alice Victoria Natalia Irina Olga Elizabeth Jennifer Jessica Amy Lisa Michelle Oleg Sergey
Sergei Dmitry Dmitriy Andrey Andrei Alexey Aleksey Evgeny Evgeniy Yuri Yury Ivan Igor Maxim Maksim Pavel Denis Anton Artem Artyom
Kirill Nikita Roman Vladimir Timur Ruslan Rustam Marat Damir Ilya Ilia Mikhail Nikolay Nikolai Stanislav Vadim Vitaly Vitaliy
Anastasia Anastasiya Ekaterina Kateryna Tatiana Tatyana Svetlana Natasha Marina Daria Darya Ksenia Kseniya Polina Yulia Julia
Alina Karina Kristina Oksana Elizaveta Valeria Veronika Dina Amina Aliya Aigerim Aizhan Ainur Assel Asel Dana Madina Zarina
Zhanar Nurlan Nursultan Bekzhan Yerlan Yerbol Erlan Erbol Zhanibek Sanzhar Daniyar Bauyrzhan Askar Almas Kanat Serik Talgat`;

const toList = block => block.split(/\s+/).map(name => name.trim()).filter(Boolean);

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i'
};

export function transliterate(value) {
  return String(value || '')
    .toLowerCase()
    .split('')
    .map(char => (char in CYRILLIC_TO_LATIN ? CYRILLIC_TO_LATIN[char] : char))
    .join('');
}

// «Скелет» имени: латиница без вариантов транслитерации (Zhumabay/Jumabai, Rakhat/Rahat, Yuliya/Julia).
// По нему сравниваются имена из словаря, из документа и из имени файла.
export function skeleton(value) {
  // «7» — временная замена для ж: иначе правило «j → i» съедало бы Zh.
  return transliterate(value)
    .replace(/yu|iu/g, 'u')
    .replace(/ya|ia/g, 'a')
    .replace(/yo|io/g, 'o')
    .replace(/ye|ie/g, 'e')
    .replace(/zh|j/g, '7')
    .replace(/shch|sch/g, 's')
    .replace(/sh/g, 's')
    .replace(/kh/g, 'h')
    .replace(/ch/g, 'c')
    .replace(/ts|tz/g, 'c')
    .replace(/y/g, 'i')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/x/g, 'ks')
    .replace(/[^a-z7]/g, '')
    .replace(/7/g, 'j')
    .replace(/(.)\1+/g, '$1');
}

const FIRST_NAMES = new Set(
  [...toList(KAZAKH_MALE), ...toList(KAZAKH_FEMALE), ...toList(RUSSIAN_MALE), ...toList(RUSSIAN_FEMALE), ...toList(ENGLISH)].map(
    skeleton
  )
);

export function isFirstName(token) {
  const key = skeleton(token);
  return key.length >= 2 && FIRST_NAMES.has(key);
}

const SURNAME_SUFFIX =
  /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|енко|ко|ук|юк|чук|ич|ян|дзе|швили|баев|баева|беков|бекова|ханов|ханова|улы|ұлы|кызы|қызы|оглы|оглу|ov|ova|ev|eva|yev|yeva|in|ina|sky|skiy|skaya|enko|uk|yuk|chuk|yan|dze|shvili|baev|bayev|bekov|khanov|uly|kyzy|ogly)$/i;

// -улы/-кызы и -оглы встречаются и как отчество, и как фамилия: решает количество слов.
const PATRONYMIC_SUFFIX = /(ович|евич|ьевич|ич|овна|евна|ьевна|ична|инична|улы|ұлы|кызы|қызы|оглы|оглу|ovich|evich|yevich|ovna|evna|yevna|uly|kyzy|ogly)$/i;

export function looksLikeSurname(token) {
  return SURNAME_SUFFIX.test(String(token || '')) && !isFirstName(token);
}

export function looksLikePatronymic(token) {
  return PATRONYMIC_SUFFIX.test(String(token || ''));
}

// «НУРКЕН» → «Нуркен», «ANN-MARIE» → «Ann-Marie»; уже нормальный регистр не трогается.
export function titleCase(token) {
  const text = String(token || '');
  if (!text) return '';
  const isUpper = text === text.toUpperCase() && text !== text.toLowerCase();
  if (!isUpper) return text[0].toUpperCase() + text.slice(1);
  return text
    .toLowerCase()
    .split(/(-)/)
    .map(part => (part === '-' ? part : part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}