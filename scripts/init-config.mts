import { ensureLocalFiles, configPath, envPath } from '../apps/server/src/config.ts';

await ensureLocalFiles();
console.log(`Configuration ready:\n- ${configPath}\n- ${envPath}`);
