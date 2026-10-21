import { bootCtx } from '../boot.js';
const { handle } = await bootCtx(); // createDb aplica as migrações pendentes
console.log('Migrações aplicadas.'); await handle.close();
