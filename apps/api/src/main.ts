import { createApp } from './app';

createApp()
  .then((app) => app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0'))
  .then(() => console.log(`API listening on :${process.env.PORT ?? 4000}`));
