// FX-only run: refresh rates and keep the Supabase project awake. Handy as a
// lightweight standalone job or a manual trigger.

import { runFx } from './lib/fx';

runFx()
  .then(() => console.log('[fx] done'))
  .catch((err) => {
    console.error('[fx] FAILED:', err);
    process.exit(1);
  });
