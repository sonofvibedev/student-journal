// Защита от случайного запуска тестовых скриптов на проде.
// Любой тестовый скрипт начинает с assertTestTarget(): если ref или адрес базы совпадает с продовым,
// процесс завершается, ничего не сделав. Прод-значения в тестовые настройки не копируются.
export const PROD_REF = 'woiqekpuoddxixlrbvkp';        // journal-24dmm2: только для сравнения, не для подключения

export function assertTestTarget(ref, url = '') {
  const bad = (s) => String(s ?? '').includes(PROD_REF);
  if (!ref || bad(ref) || bad(url)) {
    console.error(`СТОП: цель теста — прод (${PROD_REF}) или не задана. Скрипт ничего не сделал.`);
    process.exit(2);
  }
  if (!/^[a-z0-9]{20}$/.test(ref)) {
    console.error('СТОП: TEST_PROJECT_REF должен быть ref проекта из 20 символов.');
    process.exit(2);
  }
  return ref;
}
