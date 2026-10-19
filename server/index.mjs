import { createApp } from './app.mjs';

try {
  const service = await createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535');
  service.server.listen(port, host, () => console.log(`Сигнал запущен на ${host}:${port}`));
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await service.close();
    process.exit(0);
  });
} catch (error) {
  console.error('Не удалось запустить Сигнал:', error.message);
  process.exitCode = 1;
}
