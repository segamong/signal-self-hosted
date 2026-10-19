import { readSettings, render, checkDns } from './config.mjs';

try {
  const settings = readSettings();
  if (process.argv.includes('--check-dns')) await checkDns(settings);
  const origin = render(settings);
  console.log(`Конфигурация проверена и сохранена. Адрес приложения: ${origin}`);
} catch (error) {
  console.error(`Конфигурация не подготовлена: ${error.message}`);
  process.exitCode = 1;
}
